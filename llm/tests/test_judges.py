import json

from grapevine_llm.client import Message, Request, Success, generate
from grapevine_llm.contracts import Context
from grapevine_llm.retrieval_metrics import score_ids
from grapevine_llm.settings import Settings


def test_ragas_metrics_and_empty_sets():
    assert score_ids(["a", "b"], ["a", "c"]) == (0.5, 0.5)
    assert score_ids([], ["a"]) == (0.0, 0.0)
    assert score_ids([], []) == (1.0, 1.0)


def test_business_rule_feedback_is_actionable():
    req = Request(id="tool", task="agent", messages=[Message(role="user", content="Get a")],
                  context=Context(event_ids=["a"], allowed_tools=["get_event"]))
    calls = []
    def send(payload, remaining):
        calls.append(payload)
        if len(calls) == 2:
            assert "tool turn requires calls and no answer or citations" in payload["messages"][-1]["content"]
        return json.dumps({"kind": "tools", "answer": "Opening" if len(calls) == 1 else "",
                           "citations": [], "tool_calls": [{"name": "get_event", "args": {"id": "a"}}]})
    assert isinstance(generate(req, Settings(), transport=send), Success)
