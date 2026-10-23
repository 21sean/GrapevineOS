"""Explicit, reviewable baseline updates and promotion of sanitized feedback cases."""
import argparse
from pathlib import Path

from .checks import BASELINE, complete
from .evals import DATA, GoldenCase, Report, load_cases, run_case
from .provenance import capture
from .settings import Settings


def update_baseline(path: Path):
    report = Report.model_validate_json(path.read_bytes())
    complete(report)
    if report.mode != "live" or report.provenance is None:
        raise ValueError("a completed live run with provenance is required")
    if report.provenance != capture(report.provenance.num_ctx, report.provenance.max_attempts):
        raise ValueError("run was not produced by the current source and environment")
    BASELINE.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")


def promote(path: Path):
    case = GoldenCase.model_validate_json(path.read_bytes())
    if case.id in {c.id for c in load_cases()}:
        raise ValueError("case ID already exists")
    if not run_case(case, "replay", Settings()).passed:
        raise ValueError("candidate does not satisfy its expected outcome")
    with DATA.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(case.model_dump_json() + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["baseline", "promote"])
    parser.add_argument("path", type=Path)
    parser.add_argument("--reviewed", action="store_true", help="confirm the candidate contains no private data and its rubric is reviewed")
    args = parser.parse_args()
    if not args.reviewed:
        parser.error("review the artifact/candidate, then pass --reviewed")
    (update_baseline if args.action == "baseline" else promote)(args.path)


if __name__ == "__main__":
    main()
