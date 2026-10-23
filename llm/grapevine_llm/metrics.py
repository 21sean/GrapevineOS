"""Summarize bounded local trace files without reading sampled prompt text."""
import argparse
import json
from pathlib import Path

from .client import Stats


def summarize(path: Path) -> dict:
    calls = first = retry = failures = 0
    validation = gating = repair = 0.0
    for line in path.read_text(encoding="utf-8").splitlines():
        span = json.loads(line)
        for event in span.get("events", []):
            if event["name"] not in ("success", "failure"):
                continue
            attrs = event["attributes"]
            stats = Stats.model_validate({name: attrs[name] for name in Stats.model_fields if name in attrs})
            calls += 1
            first += stats.first_pass
            retry += stats.attempts > 1
            failures += event["name"] == "failure"
            validation += stats.validation_ms
            gating += stats.gating_ms
            repair += stats.repair_ms
    return {"calls": calls, "first_pass_rate": first / calls if calls else None,
            "retry_rate": retry / calls if calls else None,
            "hard_failure_rate": failures / calls if calls else None,
            "mean_validation_ms": validation / calls if calls else None,
            "mean_gating_ms": gating / calls if calls else None,
            "mean_repair_ms": repair / calls if calls else None}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    print(json.dumps(summarize(parser.parse_args().path), indent=2))
