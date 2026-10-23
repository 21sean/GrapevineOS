import json

from grapevine_llm.client import Failure, Message, Request, Success, generate
from grapevine_llm.settings import Settings


def request():
    return Request(id="test", task="rating", messages=[Message(role="user", content="Rate jazz")])


def test_guided_json_repairs_and_reports_metrics():
    calls, events = [], []
    def send(payload, remaining):
        calls.append(payload)
        assert remaining > 0
        return json.dumps({"rating": "4" if len(calls) == 1 else 4, "rationale": "local", "promoted": False})
    result = generate(request(), Settings(), transport=send, observer=lambda name, attrs: events.append(name))
    assert isinstance(result, Success)
    assert result.output.rating == 4
    assert result.stats.attempts == 2
    assert not result.stats.first_pass
    assert calls[0]["format"]["additionalProperties"] is False
    assert "Repair" in calls[1]["messages"][-1]["content"]
    assert events.count("retry") == 1


def test_exhaustion_returns_no_partial_output():
    result = generate(request(), Settings(max_attempts=2), transport=lambda *_: '{"rating": 3}')
    assert isinstance(result, Failure)
    assert result.code == "validation_exhausted"
    assert result.stats.attempts == 2
    assert "output" not in result.model_dump()


def test_no_public_endpoint_or_cloud_fallback():
    req = request().model_copy(update={"base_url": "https://example.com"})
    result = generate(req, Settings(), transport=lambda *_: (_ for _ in ()).throw(AssertionError()))
    assert isinstance(result, Failure)
    assert result.code == "configuration"


def test_timeout_and_duplicate_keys_fail_closed():
    result = generate(request(), Settings(), transport=lambda *_: (_ for _ in ()).throw(TimeoutError()))
    assert result.code == "timeout"
    result = generate(request(), Settings(max_attempts=1), transport=lambda *_: '{"rating":3,"rating":4,"rationale":"x","promoted":false}')
    assert isinstance(result, Failure)


def test_eta_alias_survives_complete_wire_envelope():
    from jsonschema import Draft202012Validator
    from grapevine_llm.client import ResultEnvelope
    from grapevine_llm.contracts import Context
    req = Request(id="eta", task="agent", messages=[Message(role="user", content="Get ETA")],
                  context=Context(allowed_tools=["get_eta"]))
    raw = '{"kind":"tools","answer":"","citations":[],"tool_calls":[{"name":"get_eta","args":{"to":"-117,32","from":"-118,33"}}]}'
    result = generate(req, Settings(), transport=lambda *_: raw)
    assert isinstance(result, Success)
    wire = json.loads(result.model_dump_json())
    assert wire["output"]["tool_calls"][0]["args"]["from"] == "-118,33"
    Draft202012Validator(ResultEnvelope.model_json_schema()).validate(wire)
