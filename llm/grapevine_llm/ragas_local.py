"""
Ragas's LLM-judged metrics on the pinned local runtime, under the gate's rules.

Ragas ships its LLM metrics for hosted APIs through Instructor. Here they run on the
same runtime, model, seed and temperature as everything else, and every reply is
decoded against the JSON Schema of the type Ragas asked for, then validated as that
type. Nothing leaves the machine, and a reply that does not validate is retried and
then refused, never passed on half-parsed.

Faithfulness is the metric used: Ragas splits an answer into atomic statements and
checks each one against the supplied evidence, so the score is the share of claims the
evidence supports. It complements the single rubric judgment in the DeepEval pass,
which reads the answer as a whole.
"""
import asyncio
import math
import time
import typing as t

from pydantic import BaseModel, ValidationError
from ragas.llms.base import InstructorBaseRagasLLM
from ragas.metrics.collections import Faithfulness

from .client import TRANSPORTS, Transport, build_payload
from .settings import Settings

Model = t.TypeVar("Model", bound=BaseModel)


class LocalRagasLLM(InstructorBaseRagasLLM):
    """Structured generation for Ragas from the local runtime's constrained decoding."""

    def __init__(self, settings: Settings, transport: Transport | None = None) -> None:
        self._settings = settings
        self._send = transport or TRANSPORTS[settings.runtime](settings.base_url, settings.max_bytes)
        self.calls = 0

    def generate(self, prompt: str, response_model: type[Model]) -> Model:
        settings = self._settings
        deadline = time.perf_counter() + settings.timeout_seconds
        messages = [{"role": "user", "content": prompt}]
        failure: ValidationError | None = None
        for _ in range(settings.max_attempts):
            self.calls += 1
            raw = self._send(build_payload(settings, response_model.model_json_schema(), messages),
                             max(0.001, deadline - time.perf_counter()))
            try:
                return response_model.model_validate_json(raw)
            except ValidationError as exc:
                failure = exc
                # No rejected text goes back: the judged answer is untrusted input too.
                messages = [*messages, {"role": "user", "content":
                                        "Return one complete JSON object that satisfies the schema."}]
        raise ValueError("judge output did not satisfy the Ragas schema") from failure

    async def agenerate(self, prompt: str, response_model: type[Model]) -> Model:
        return await asyncio.to_thread(self.generate, prompt, response_model)


def faithfulness(question: str, answer: str, contexts: list[str], llm: InstructorBaseRagasLLM) -> float | None:
    """Share of the answer's claims the contexts support, or None when it makes no claim."""
    metric = Faithfulness(llm=llm)
    result = asyncio.run(metric.ascore(user_input=question, response=answer, retrieved_contexts=contexts))
    value = float(result.value)
    return None if math.isnan(value) else min(1.0, max(0.0, value))
