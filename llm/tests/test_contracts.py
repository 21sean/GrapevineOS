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
