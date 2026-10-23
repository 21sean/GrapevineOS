"""Required schema and evaluation gates. Missing evidence is a failure."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from .evals import DATA, ROOT, Report, load_cases
from .export import artifacts
from .provenance import capture

BASELINE = ROOT / "llm/evals/baseline.json"


def git_blob(ref: str, path: str) -> bytes | None:
    exists = subprocess.run(["git", "cat-file", "-e", f"{ref}:{path}"], cwd=ROOT, capture_output=True)
    if exists.returncode:
        # A missing path is allowed for the first rollout; an unknown ref is not.
        subprocess.run(["git", "rev-parse", "--verify", ref], cwd=ROOT, check=True, capture_output=True)
        return None
    return subprocess.check_output(["git", "show", f"{ref}:{path}"], cwd=ROOT)


def schemas(base_ref: str | None):
    for path, expected in artifacts().items():
        if not path.exists() or path.read_text(encoding="utf-8") != expected:
            raise ValueError(f"stale generated contract: {path.relative_to(ROOT)}")
    if base_ref:
        paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", base_ref, "--", "contracts/llm"], cwd=ROOT, text=True).splitlines()
        for name in paths:
            path = ROOT / name
            if not path.exists() or json.loads(path.read_bytes()) != json.loads(git_blob(base_ref, name)):
                raise ValueError(f"published schema is immutable; bump VERSION and preserve {name}")


def complete(report: Report):
    cases = [c for c in load_cases() if report.mode == "replay" or c.live]
    expected_ids = {c.id for c in cases}
    if len(report.results) != len(expected_ids) or {r.id for r in report.results} != expected_ids:
        raise ValueError("incomplete, duplicate, or unexpected eval cases")
    if report.dataset_sha256 != hashlib.sha256(DATA.read_text(encoding="utf-8").encode()).hexdigest():
        raise ValueError("eval artifact does not match the current golden dataset")
    if not report.passed or not all(r.passed for r in report.results):
        raise ValueError("eval contains failures")
    if report.mode == "live":
        for c, r in ((c, next(r for r in report.results if r.id == c.id)) for c in cases):
            if r.output_json is None:
                raise ValueError(f"hard failure: {c.id}")
            if c.rubric and (r.judge_score is None or r.judge_score < 0.75):
                raise ValueError(f"missing or failing judge: {c.id}")
            if c.request.task == "agent" and (r.retrieval_precision is None or r.retrieval_recall is None):
                raise ValueError(f"missing retrieval metrics: {c.id}")
        if sum(r.stats.first_pass for r in report.results) / len(report.results) < 0.95:
            raise ValueError("schema first-pass rate below 95%")


def no_regression(current: Report, baseline: Report):
    if baseline.mode != "live" or current.mode != "live" or not baseline.passed:
        raise ValueError("baseline and candidate must be successful live runs")
    by_id = {r.id: r for r in current.results}
    if len({r.id for r in baseline.results}) != len(baseline.results):
        raise ValueError("duplicate baseline cases")
    for before in baseline.results:
        after = by_id.get(before.id)
        if after is None or not after.passed:
            raise ValueError(f"missing or regressed case: {before.id}")
        for metric in ("judge_score", "retrieval_precision", "retrieval_recall"):
            old, new = getattr(before, metric), getattr(after, metric)
            if old is not None and (new is None or new < old):
                raise ValueError(f"regression: {before.id}/{metric}")
        if before.stats.first_pass and not after.stats.first_pass:
            raise ValueError(f"first-pass regression: {before.id}")


def quality(path: Path, base_ref: str | None):
    report = Report.model_validate_json(path.read_bytes())
    complete(report)
    if report.provenance is None or report.provenance != capture(report.provenance.num_ctx, report.provenance.max_attempts):
        raise ValueError("artifact does not match this source, runtime, model manifest, and dependency lock")
    if report.mode == "live":
        baseline = Report.model_validate_json(BASELINE.read_bytes())
        complete(baseline)
        no_regression(report, baseline)
        if base_ref:
            old = git_blob(base_ref, "llm/evals/baseline.json")
            if old:
                # Editing the baseline in a PR cannot hide a regression from its base.
                no_regression(report, Report.model_validate_json(old))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("gate", choices=["schemas", "quality"])
    parser.add_argument("--base-ref")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.gate == "schemas":
        schemas(args.base_ref)
    elif args.report is None:
        parser.error("quality requires --report")
    else:
        quality(args.report, args.base_ref)
    print(f"{args.gate} gate passed")


if __name__ == "__main__":
    main()
