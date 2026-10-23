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
    retrieval_precision: Score | None = None
    retrieval_recall: Score | None = None


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


def run(mode: Literal["replay", "live"], settings: Settings, path: Path = DATA) -> Report:
    cases = [case for case in load_cases(path) if mode == "replay" or case.live]
    results = [run_case(case, mode, settings) for case in cases]
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    return Report(mode=mode, dataset_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                  revision=revision, model=settings.model, seed=settings.seed, results=results,
                  passed=all(result.passed for result in results))


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
