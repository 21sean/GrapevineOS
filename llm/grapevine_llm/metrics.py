"""Summarize bounded local trace files without reading sampled prompt text."""
import argparse
import json
import math
from pathlib import Path

from .client import Stats


def percentiles(values: list[float]) -> dict | None:
    """Nearest rank, so every number quoted was really observed."""
    if not values:
        return None
    ordered = sorted(values)
    def at(p: int) -> float:
        return ordered[max(0, min(len(ordered) - 1, math.ceil(p / 100 * len(ordered)) - 1))]
    return {"n": len(ordered), "p50": at(50), "p95": at(95), "p99": at(99)}


def summarize(path: Path) -> dict:
    calls = first = retry = failures = 0
    validation = gating = repair = 0.0
    ttft: list[float] = []
    tpot: list[float] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        span = json.loads(line)
        for event in span.get("events", []):
            if event["name"] == "generation":
                attrs = event["attributes"]
                if "first_token_ms" in attrs:
                    ttft.append(attrs["first_token_ms"])
                if "tpot_ms" in attrs:
                    tpot.append(attrs["tpot_ms"])
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
            "mean_repair_ms": repair / calls if calls else None,
            "model_ttft_ms": percentiles(ttft), "model_tpot_ms": percentiles(tpot)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    print(json.dumps(summarize(parser.parse_args().path), indent=2))
