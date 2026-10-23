import json

import pytest

from grapevine_llm.evals import load_cases, run, run_case
from grapevine_llm.settings import Settings


def test_all_replay_cases_pass_without_network(monkeypatch):
    import socket
    monkeypatch.setattr(socket.socket, "connect", lambda *_: pytest.fail("network attempted"))
    report = run("replay", Settings())
    assert report.passed and len(report.results) >= 30
    assert next(r for r in report.results if r.id == "repair-number").stats.attempts == 2
    assert next(r for r in report.results if r.id == "extra-field").output_json is None


def test_empty_and_duplicate_goldens_are_errors(tmp_path):
    path = tmp_path / "golden.jsonl"
    path.write_text("")
    with pytest.raises(ValueError):
        load_cases(path)
    case = load_cases()[0].model_dump_json()
    path.write_text(case + "\n" + case)
    with pytest.raises(ValueError):
        load_cases(path)


def test_schema_valid_but_wrong_answer_fails():
    case = load_cases()[0]
    case.responses = [json.dumps({"rating": 2, "rationale": "wrong", "promoted": False})]
    result = run_case(case, "replay", Settings())
    assert not result.passed and result.reason == "field mismatch: rating"
