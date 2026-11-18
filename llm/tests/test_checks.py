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


def test_live_gate_requires_the_ragas_scores():
    report = baseline()
    next(r for r in report.results if r.id == "grounded-distractors").citation_precision = None
    with pytest.raises(ValueError, match="citation"):
        complete(report)
    report = baseline()
    next(r for r in report.results if r.id == "grounded-two-events").faithfulness = None
    with pytest.raises(ValueError, match="missing faithfulness"):
        complete(report)
    report = baseline()
    report.retrieval = None
    with pytest.raises(ValueError, match="retrieval summary"):
        complete(report)
    report = baseline()
    report.retrieval.faithfulness = 0.7
    with pytest.raises(ValueError, match="average faithfulness"):
        complete(report)


def test_citations_are_held_case_by_case_and_faithfulness_on_the_average():
    previous, report = baseline(), baseline()
    # The model starts citing a listing that does not answer the question.
    next(r for r in report.results if r.id == "grounded-two-events").citation_precision = 0.5
    with pytest.raises(ValueError, match="grounded-two-events/citation_precision"):
        no_regression(report, previous)
    # One judged case flipping is noise, measured: it must not fail the gate.
    report = baseline()
    case = next(r for r in report.results if r.id == "grounded-two-events")
    case.faithfulness = 0.5
    report.retrieval.faithfulness = previous.retrieval.faithfulness - 0.1
    no_regression(report, previous)
    # The average falling by more than two flips is not.
    report.retrieval.faithfulness = previous.retrieval.faithfulness - 0.2
    with pytest.raises(ValueError, match="average faithfulness"):
        no_regression(report, previous)
    # A baseline from before these scores existed asks for none of them.
    older = baseline()
    older.retrieval = None
    for r in older.results:
        r.citation_precision = r.citation_recall = r.faithfulness = None
    no_regression(baseline(), older)


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
