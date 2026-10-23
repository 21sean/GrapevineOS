import socket

import pytest

from grapevine_llm.checks import BASELINE, complete, no_regression, schemas
from grapevine_llm.evals import Report


def baseline():
    return Report.model_validate_json(BASELINE.read_bytes())


def test_required_gate_rejects_missing_cases_and_judges():
    report = baseline()
    complete(report)
    report.results.pop()
    with pytest.raises(ValueError, match="incomplete"):
        complete(report)
    report = baseline()
    next(r for r in report.results if r.id == "grounded-jazz").judge_score = None
    with pytest.raises(ValueError, match="judge"):
        complete(report)


def test_baseline_edit_cannot_hide_regressions():
    previous, report = baseline(), baseline()
    next(r for r in report.results if r.id == "grounded-jazz").judge_score = 0.75
    with pytest.raises(ValueError, match="regression"):
        no_regression(report, previous)
    report = baseline()
    report.results[0].stats.first_pass = False
    with pytest.raises(ValueError, match="first-pass"):
        no_regression(report, previous)


def test_runtime_forbids_remote_network_before_connect():
    with pytest.raises(PermissionError, match="loopback"):
        socket.getaddrinfo("example.com", 443)
    with socket.socket() as sock:
        with pytest.raises(PermissionError, match="loopback"):
            sock.connect(("8.8.8.8", 443))


def test_current_exports_match():
    schemas(None)
