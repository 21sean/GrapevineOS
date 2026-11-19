"""Required schema and evaluation gates. Missing evidence is a failure."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from .evals import DATA, ROOT, Report, expects_faithfulness, load_cases
from .export import artifacts
from .profiles import Gates, gates
from .provenance import capture
from .settings import Settings

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


def limits() -> Gates:
    """
    The thresholds for the runtime under test, from the reviewed profile of the model it
    pins. They were measured on that family as generator and judge, so a model without
    a reviewed profile has none, and that is a failure.
    """
    return gates(Settings().runtime)


def complete(report: Report):
    cases = [c for c in load_cases() if report.mode == "replay" or c.live]
    expected_ids = {c.id for c in cases}
    if len(report.results) != len(expected_ids) or {r.id for r in report.results} != expected_ids:
        raise ValueError("incomplete, duplicate, or unexpected eval cases")
    if report.dataset_sha256 != hashlib.sha256(DATA.read_text(encoding="utf-8").encode()).hexdigest():
        raise ValueError("eval artifact does not match the current golden dataset")
    if not report.passed or not all(r.passed for r in report.results):
        raise ValueError("eval contains failures")
    limit = limits()
    if report.mode == "live":
        for c, r in ((c, next(r for r in report.results if r.id == c.id)) for c in cases):
            if r.output_json is None:
                raise ValueError(f"hard failure: {c.id}")
            if c.rubric and (r.judge_score is None or r.judge_score < limit.judge_score_min):
                raise ValueError(f"missing or failing judge: {c.id}")
            if c.request.task == "agent" and (r.retrieval_precision is None or r.retrieval_recall is None):
                raise ValueError(f"missing retrieval metrics: {c.id}")
            if c.request.task == "agent" and (r.citation_precision is None or r.citation_recall is None):
                raise ValueError(f"missing citation metrics: {c.id}")
            if expects_faithfulness(c, json.loads(r.output_json)) and r.faithfulness is None:
                raise ValueError(f"missing faithfulness: {c.id}")
        if report.retrieval is None:
            raise ValueError("missing retrieval summary")
        if report.retrieval.faithfulness is not None and report.retrieval.faithfulness < limit.faithfulness_floor:
            raise ValueError(f"average faithfulness below {limit.faithfulness_floor}")
        if sum(r.stats.first_pass for r in report.results) / len(report.results) < limit.first_pass_rate_min:
            raise ValueError(f"schema first-pass rate below {limit.first_pass_rate_min:.0%}")


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
        # These repeat exactly when the answers do: the rubric judge's scores and the ID
        # metrics were identical across three live runs.
        for metric in ("judge_score", "retrieval_precision", "retrieval_recall",
                       "citation_precision", "citation_recall"):
            old, new = getattr(before, metric), getattr(after, metric)
            if old is not None and (new is None or new < old):
                raise ValueError(f"regression: {before.id}/{metric}")
        if before.stats.first_pass and not after.stats.first_pass:
            raise ValueError(f"first-pass regression: {before.id}")
    was = baseline.retrieval.faithfulness if baseline.retrieval else None
    now = current.retrieval.faithfulness if current.retrieval else None
    # Faithfulness is judged, and the judge does not repeat case by case, so it is held
    # on the suite average with room for flips. The profile records what that was set from.
    if was is not None and (now is None or now < was - limits().faithfulness_drop):
        raise ValueError("regression: average faithfulness")


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
