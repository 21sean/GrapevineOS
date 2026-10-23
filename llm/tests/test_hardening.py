import json
from datetime import date

import pytest
from hypothesis import given, strategies as st
from pydantic import TypeAdapter

from grapevine_llm.client import Failure, Stats
from grapevine_llm.contracts import Day, GetEta
from grapevine_llm.checks import quality, BASELINE
from grapevine_llm.evals import Report
from grapevine_llm.maintenance import update_baseline, promote
from grapevine_llm.metrics import summarize
from grapevine_llm.provenance import capture


@given(st.dates(min_value=date(1000, 1, 1)))
def test_calendar_dates_accept_real_days(day):
    assert TypeAdapter(Day).validate_python(day.isoformat()) == day.isoformat()


@pytest.mark.parametrize("day", ["2025-02-29", "2026-04-31", "0000-01-01", "2026-13-01"])
def test_calendar_dates_reject_impossible_days(day):
    with pytest.raises(ValueError):
        TypeAdapter(Day).validate_python(day)


@given(st.floats(min_value=180.001, max_value=10000))
def test_coordinates_reject_out_of_range_text(lng):
    with pytest.raises(ValueError):
        GetEta(to=f"{lng},45")


def test_stale_provenance_cannot_be_promoted_or_pass_ci(tmp_path):
    report = Report.model_validate_json(BASELINE.read_bytes())
    report.provenance = capture(16384, 3)
    report.provenance.source_sha256 = "0" * 64
    path = tmp_path / "stale.json"
    path.write_text(report.model_dump_json(), encoding="utf-8")
    with pytest.raises(ValueError, match="artifact"):
        quality(path, None)
    with pytest.raises(ValueError, match="current source"):
        update_baseline(path)


def test_metadata_queue_is_not_a_golden_case(tmp_path):
    path = tmp_path / "candidate.json"
    path.write_text('{"id":"private","reviewed":false}', encoding="utf-8")
    with pytest.raises(ValueError):
        promote(path)


def test_local_metrics_count_failures_and_repair(tmp_path):
    stats = Stats(attempts=2, validation_failures=2, first_pass=False,
                  validation_ms=1.0, total_ms=12.0, repair_ms=6.0, model_ms=10.0, gating_ms=2.0)
    result = Failure(ok=False, id="example", code="validation_exhausted", message="Rejected", stats=stats)
    path = tmp_path / "traces.jsonl"
    path.write_text(json.dumps({"events": [{"name": "failure", "attributes": result.stats.model_dump()}]}), encoding="utf-8")
    metrics = summarize(path)
    assert metrics["hard_failure_rate"] == 1
    assert metrics["retry_rate"] == 1
    assert metrics["first_pass_rate"] == 0
    assert metrics["mean_gating_ms"] == 2
