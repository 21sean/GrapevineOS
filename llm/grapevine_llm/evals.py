"""Deterministic checks precede subjective scoring. All artifacts stay on disk."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .client import Failure, Request, Stats, Success, generate
from .contracts import Contract, Id, Score, Text
from .settings import Settings
from .provenance import Provenance, capture

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "llm/evals/golden.jsonl"


class FieldCheck(Contract):
    path: Annotated[str, Field(min_length=1, max_length=200)]
    value_json: Annotated[str, Field(max_length=10_000)]


class GoldenCase(Contract):
    id: Id
    request: Request
    live: bool
    category: Literal["normal", "edge", "adversarial", "repair"]
    responses: Annotated[list[str], Field(min_length=1, max_length=3)]
    expected: Literal["success", "validation_exhausted"]
    checks: list[FieldCheck]
    rubric: Text | None = None
    relevant_ids: list[Id] = []
    retrieved_ids: list[Id] = []

    @model_validator(mode="after")
    def consistent(self):
        if self.id != self.request.id:
            raise ValueError("case and request IDs must match")
        if self.live and self.expected != "success":
            raise ValueError("injected invalid responses belong to replay only")
        if len(set(self.retrieved_ids)) != len(self.retrieved_ids):
            raise ValueError("retrieval IDs must be unique")
        supplied = {e.id for e in self.request.context.evidence}
        if self.retrieved_ids and set(self.retrieved_ids) != supplied:
            # The snapshot is what the model was shown. A relevant ID may be missing from
            # it: that is a retriever miss, and it is what retrieval recall measures.
            raise ValueError("retrieved IDs must be the evidence supplied to the model")
        for check in self.checks:
            json.loads(check.value_json, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        return self


class CaseResult(Contract):
    id: Id
    passed: bool
    reason: str
    output_json: str | None
    stats: Stats
    judge_score: Score | None = None
    judge_reason: str | None = None
    # Ragas ID metrics over the evidence the case supplied: a property of the snapshot.
    retrieval_precision: Score | None = None
    retrieval_recall: Score | None = None
    # The same metrics over the evidence this answer cited: a property of the output.
    citation_precision: Score | None = None
    citation_recall: Score | None = None
    # Ragas Faithfulness: the share of the answer's claims the supplied evidence supports.
    faithfulness: Score | None = None


class RetrievalSummary(Contract):
    """Macro averages over the agent cases of a live run."""

    cases: Annotated[int, Field(ge=0)]
    retrieval_precision: Score | None
    retrieval_recall: Score | None
    citation_precision: Score | None
    citation_recall: Score | None
    faithfulness: Score | None
    faithfulness_cases: Annotated[int, Field(ge=0)]


class Report(Contract):
    version: Literal["1.0.0"] = "1.0.0"
    mode: Literal["replay", "live"]
    dataset_sha256: str
    revision: str
    model: str
    seed: int
    temperature: Literal[0] = 0
    results: Annotated[list[CaseResult], Field(min_length=1)]
    passed: bool
    provenance: Provenance | None = None
    retrieval: RetrievalSummary | None = None


def load_cases(path: Path = DATA) -> list[GoldenCase]:
    cases = [GoldenCase.model_validate_json(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not cases or len({c.id for c in cases}) != len(cases):
        raise ValueError("goldens must be nonempty with unique IDs")
    return cases


def check_result(case: GoldenCase, result: Success | Failure) -> CaseResult:
    passed = isinstance(result, Success) if case.expected == "success" else isinstance(result, Failure) and result.code == case.expected
    reason = "passed" if passed else "unexpected gate outcome"
    if passed and isinstance(result, Success):
        for check in case.checks:
            value = result.output.model_dump(mode="json")
            try:
                for part in check.path.split("."):
                    value = value[int(part)] if isinstance(value, list) else value[part]
                expected = json.loads(check.value_json)
                if value != expected or type(value) is not type(expected):
                    passed, reason = False, f"field mismatch: {check.path}"
                    break
            except (KeyError, IndexError, ValueError, TypeError):
                passed, reason = False, f"missing field: {check.path}"
                break
    return CaseResult(id=case.id, passed=passed, reason=reason,
                      output_json=result.output.model_dump_json() if isinstance(result, Success) else None,
                      stats=result.stats)


def run_case(case: GoldenCase, mode: str, settings: Settings) -> CaseResult:
    responses = iter(case.responses)
    # Repeat the last response to test exhaustion without accidentally throwing StopIteration.
    transport = (lambda *_: next(responses, case.responses[-1])) if mode == "replay" else None
    return check_result(case, generate(case.request, settings, transport=transport))


def expects_faithfulness(case: GoldenCase, output: dict | None) -> bool:
    """An answer that makes claims, with evidence to check them against."""
    return bool(case.request.task == "agent" and output and output.get("kind") == "answer"
                and output.get("answer") and case.request.context.evidence)


def score_retrieval(cases: list[GoldenCase], results: list[CaseResult], settings: Settings,
                    judge=None) -> RetrievalSummary:
    """Ragas over the agent cases: the supplied snapshot, the citations, and the claims."""
    from .ragas_local import LocalRagasLLM, faithfulness
    from .retrieval_metrics import mean, score_citations, score_ids

    judge = judge or LocalRagasLLM(settings)
    scored: list[CaseResult] = []
    for case, result in zip(cases, results, strict=True):
        if case.request.task != "agent":
            continue
        scored.append(result)
        result.retrieval_precision, result.retrieval_recall = score_ids(case.retrieved_ids, case.relevant_ids)
        output = json.loads(result.output_json) if result.output_json else None
        if output is None:
            continue
        result.citation_precision, result.citation_recall = score_citations(output.get("citations") or [], case.relevant_ids)
        if expects_faithfulness(case, output):
            question = "\n".join(m.content for m in case.request.messages if m.role == "user")
            result.faithfulness = faithfulness(question, output["answer"],
                                               [e.text for e in case.request.context.evidence], judge)
    faithful = [r.faithfulness for r in scored if r.faithfulness is not None]
    return RetrievalSummary(
        cases=len(scored),
        retrieval_precision=mean([r.retrieval_precision for r in scored]),
        retrieval_recall=mean([r.retrieval_recall for r in scored]),
        citation_precision=mean([r.citation_precision for r in scored]),
        citation_recall=mean([r.citation_recall for r in scored]),
        faithfulness=mean(faithful), faithfulness_cases=len(faithful))


def run(mode: Literal["replay", "live"], settings: Settings, path: Path = DATA) -> Report:
    if mode == "live":
        from .pins import verify_runtime
        pins = verify_runtime(settings.runtime, settings.base_url, settings.num_ctx)
        if settings.model != pins.generation.name or settings.seed != pins.seed:
            raise ValueError("eval settings differ from model manifest")
    cases = [case for case in load_cases(path) if mode == "replay" or case.live]
    results = [run_case(case, mode, settings) for case in cases]
    retrieval = score_retrieval(cases, results, settings) if mode == "live" else None
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    return Report(mode=mode, dataset_sha256=hashlib.sha256(path.read_text(encoding="utf-8").encode()).hexdigest(),
                  revision=revision, model=settings.model, seed=settings.seed, results=results,
                  passed=all(result.passed for result in results),
                  provenance=capture(settings.num_ctx, settings.max_attempts), retrieval=retrieval)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["replay", "live"], default="replay")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = run(args.mode, Settings())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    print(f"{report.mode}: {sum(r.passed for r in report.results)}/{len(report.results)} passed")
    raise SystemExit(0 if report.passed else 1)


if __name__ == "__main__":
    main()
