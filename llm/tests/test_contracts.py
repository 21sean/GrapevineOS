import json

import pytest
from hypothesis import given, strategies as st
from jsonschema import Draft202012Validator

from grapevine_llm.contracts import Context, EventRating, validate_output
from grapevine_llm.export import artifacts


@given(st.one_of(st.text(), st.booleans(), st.none(), st.integers(max_value=0), st.integers(min_value=6)))
def test_ratings_never_coerce(value):
    with pytest.raises(ValueError):
        validate_output("rating", json.dumps({"rating": value, "rationale": "local", "promoted": False}), Context())


@pytest.mark.parametrize("raw", ['{"rating":3,"rating":4,"rationale":"x","promoted":false}', '```json\n{}\n```', '{"rating":NaN}', '{"rating":3,"rationale":"x","promoted":false,"extra":1}'])
def test_strict_json(raw):
    with pytest.raises(ValueError):
        validate_output("rating", raw, Context())


def test_exported_schema_accepts_valid_and_rejects_coercion():
    schema = EventRating.model_json_schema()
    validator = Draft202012Validator(schema)
    assert validator.is_valid({"rating": 4.5, "rationale": "local", "promoted": False})
    assert not validator.is_valid({"rating": "4.5", "rationale": "local", "promoted": False})
    assert artifacts() == artifacts()


def test_unknown_citation_and_tool_ids_fail():
    for value in [
        {"kind": "answer", "answer": "Jazz", "citations": ["invented"], "tool_calls": []},
        {"kind": "tools", "answer": "", "citations": [], "tool_calls": [{"name": "get_event", "args": {"id": "invented"}}]},
    ]:
        with pytest.raises(ValueError):
            validate_output("agent", json.dumps(value), Context(allowed_tools=["get_event"]))


def test_enrichment_must_cover_batch_exactly():
    with pytest.raises(ValueError):
        validate_output("enrichment", '{"labels":[]}', Context(candidate_count=1))


def test_the_generation_schema_holds_only_the_tools_this_request_may_call():
    from jsonschema import Draft202012Validator
    from grapevine_llm.contracts import TOOL_ARGS, request_schema
    full = len(json.dumps(request_schema("agent", list(TOOL_ARGS))))
    two = request_schema("agent", ["search_web", "get_event"])
    Draft202012Validator.check_schema(two)
    refs = [r["$ref"] for r in two["properties"]["tool_calls"]["items"]["oneOf"]]
    assert sorted(refs) == ["#/$defs/get_event_call", "#/$defs/search_web_call"]
    assert "save_calendar_call" not in two["$defs"]
    assert len(json.dumps(two)) < full / 2
    Draft202012Validator(two).validate(
        {"kind": "tools", "answer": "", "citations": [], "tool_calls": [{"name": "search_web", "args": {"query": "x"}}]})


def test_with_no_tools_enabled_the_schema_cannot_express_a_tool_call():
    from jsonschema import Draft202012Validator, ValidationError
    from grapevine_llm.contracts import request_schema
    none = request_schema("agent", [])
    Draft202012Validator.check_schema(none)
    validator = Draft202012Validator(none)
    validator.validate({"kind": "answer", "answer": "x", "citations": [], "tool_calls": []})
    try:
        validator.validate({"kind": "tools", "answer": "", "citations": [], "tool_calls": []})
    except ValidationError:
        return
    raise AssertionError("tools should not be a kind when none are enabled")


def test_narrowing_does_not_change_other_tasks_or_mutate_the_cache():
    from grapevine_llm.contracts import OUTPUTS, request_schema
    assert request_schema("rating", []) == OUTPUTS["rating"].model_json_schema()
    first = request_schema("agent", [])
    first["properties"].clear()
    assert request_schema("agent", [])["properties"]
