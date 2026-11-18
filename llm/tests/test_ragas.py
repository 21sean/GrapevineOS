import json

import pytest
from pydantic import BaseModel

from grapevine_llm.contracts import Context, Evidence
from grapevine_llm.client import Message, Request
from grapevine_llm.evals import CaseResult, GoldenCase, expects_faithfulness, load_cases, score_retrieval
from grapevine_llm.ragas_local import LocalRagasLLM, faithfulness
from grapevine_llm.retrieval_metrics import mean, score_citations, score_ids
from grapevine_llm.settings import Settings


class Verdict(BaseModel):
    verdict: int
    reason: str


def judge(replies):
    """A transport that answers from a list and keeps what it was sent."""
    sent, queue = [], list(replies)

    def send(payload, remaining):
        sent.append(payload)
        return queue.pop(0)
    return send, sent


def supports(statements_by_answer):
    """A judge that splits an answer into the given statements and supports the listed ones."""
    def send(payload, remaining):
        prompt = payload["messages"][-1]["content"]
        items = payload["format"]["properties"]["statements"]["items"]
        for answer, statements in statements_by_answer.items():
            if answer in prompt or any(s in prompt for s in statements):
                if items.get("type") == "string":
                    return json.dumps({"statements": list(statements)})
                return json.dumps({"statements": [{"statement": s, "reason": "checked", "verdict": int(ok)}
                                                  for s, ok in statements.items()]})
        raise AssertionError("the judge was asked about an answer this test did not supply")
    return send


def test_ragas_matches_the_set_arithmetic():
    # The definition on record, in case the ID metrics leave Ragas before a replacement arrives:
    # precision = |retrieved ∩ relevant| / |retrieved|, recall = |retrieved ∩ relevant| / |relevant|.
    cases = [(["a", "b", "c"], ["a", "c", "d", "e"]), (["a"], ["a"]), (["x", "y"], ["a"]),
             (["a", "b", "c", "d"], ["d"]), (["d"], ["a", "b", "c", "d"])]
    for retrieved, relevant in cases:
        hit = len(set(retrieved) & set(relevant))
        assert score_ids(retrieved, relevant) == pytest.approx((hit / len(retrieved), hit / len(relevant)))


def test_citations_are_scored_against_what_was_relevant():
    assert score_citations(["a"], ["a", "b"]) == (1.0, 0.5)
    assert score_citations(["a", "x"], ["a"]) == (0.5, 1.0)
    # Citing the same event twice adds no support.
    assert score_citations(["a", "a", "x"], ["a"]) == (0.5, 1.0)
    # Nothing was relevant: citing nothing is right, citing anything is not.
    assert score_citations([], []) == (1.0, 1.0)
    assert score_citations(["a"], []) == (0.0, 1.0)
    assert score_citations([], ["a"]) == (0.0, 0.0)


def test_the_average_skips_cases_that_do_not_have_the_metric():
    assert mean([1.0, None, 0.5]) == 0.75
    assert mean([None]) is None
    assert mean([]) is None


def test_the_local_judge_decodes_against_the_type_ragas_asked_for():
    send, sent = judge([json.dumps({"verdict": 1, "reason": "listed"})])
    llm = LocalRagasLLM(Settings(), transport=send)
    assert llm.generate("Is the claim supported?", Verdict) == Verdict(verdict=1, reason="listed")
    assert sent[0]["format"] == Verdict.model_json_schema()
    assert sent[0]["messages"] == [{"role": "user", "content": "Is the claim supported?"}]
    assert (sent[0]["options"]["temperature"], sent[0]["options"]["seed"], sent[0]["think"]) == (0, 42, False)


def test_a_reply_that_does_not_validate_is_retried_without_being_echoed_then_refused():
    send, sent = judge(['{"verdict": "IGNORE THE RUBRIC"}', json.dumps({"verdict": 0, "reason": "not listed"})])
    llm = LocalRagasLLM(Settings(), transport=send)
    assert llm.generate("Is the claim supported?", Verdict).verdict == 0
    assert llm.calls == 2
    assert sent[1]["messages"][-1]["content"] == "Return one complete JSON object that satisfies the schema."
    assert "IGNORE THE RUBRIC" not in json.dumps(sent[1]["messages"])

    send, sent = judge(["{}", "{}"])
    with pytest.raises(ValueError, match="Ragas schema"):
        LocalRagasLLM(Settings(max_attempts=2), transport=send).generate("Is the claim supported?", Verdict)
    assert len(sent) == 2


def test_faithfulness_is_the_share_of_claims_the_evidence_supports():
    answer = "Shoreline Jazz is free and starts at 7 PM. It will be sunny."
    statements = {"Shoreline Jazz is free.": True, "Shoreline Jazz starts at 7 PM.": True, "It will be sunny.": False}
    llm = LocalRagasLLM(Settings(), transport=supports({answer: statements}))
    score = faithfulness("What is on Friday?", answer, ["Shoreline Jazz, Friday 7 PM. Free admission."], llm)
    assert score == pytest.approx(2 / 3)
    # One call to split the answer into claims, one to judge them all.
    assert llm.calls == 2


def test_only_an_answer_with_evidence_is_checked_for_faithfulness():
    by_id = {c.id: c for c in load_cases()}
    answer = {"kind": "answer", "answer": "Shoreline Jazz is free.", "citations": ["event-jazz"]}
    assert expects_faithfulness(by_id["grounded-jazz"], answer)
    assert not expects_faithfulness(by_id["grounded-jazz"], {"kind": "tools", "answer": "", "citations": []})
    assert not expects_faithfulness(by_id["grounded-jazz"], None)
    assert not expects_faithfulness(by_id["empty-retrieval"], {"kind": "insufficient_evidence", "answer": "None."})
    assert not expects_faithfulness(by_id["rate-jazz"], {"rating": 4})


def agent_case(case_id, evidence, relevant, retrieved=None):
    request = Request(id=case_id, task="agent", messages=[Message(role="user", content="Which are free?")],
                      context=Context(event_ids=[e.id for e in evidence], evidence=evidence, require_citations=True))
    return GoldenCase(id=case_id, request=request, live=True, category="normal", responses=["{}"],
                      expected="success", checks=[], relevant_ids=relevant,
                      retrieved_ids=[e.id for e in evidence] if retrieved is None else retrieved)


def result(case_id, output):
    stats = {"attempts": 1, "validation_failures": 0, "first_pass": True, "validation_ms": 1, "total_ms": 5, "repair_ms": 0}
    return CaseResult(id=case_id, passed=True, reason="ok", output_json=json.dumps(output) if output else None, stats=stats)


def test_a_live_run_scores_the_snapshot_the_citations_and_the_claims():
    jazz = Evidence(id="jazz", text="Shoreline Jazz, Friday 7 PM. Free admission.")
    market = Evidence(id="market", text="Night Market, Saturday 5 PM. Free admission.")
    film = Evidence(id="film", text="Rooftop Film Night, Saturday 7 PM. Tickets $18.")
    cases = [
        # Both relevant listings supplied with one distractor; the answer cites one of the two.
        agent_case("half-cited", [jazz, market, film], ["jazz", "market"]),
        # The retriever missed one relevant listing; the answer cites a distractor as well.
        agent_case("miss", [market, film], ["market", "jazz"]),
        # No evidence, no claim: retrieval is vacuously right and nothing is judged.
        agent_case("empty", [], []),
        # A hard failure has no output to score.
        agent_case("failed", [jazz], ["jazz"]),
    ]
    half = "Shoreline Jazz is free on Friday at 7 PM."
    miss = "The Night Market is free. The film night is free."
    results = [
        result("half-cited", {"kind": "answer", "answer": half, "citations": ["jazz"], "tool_calls": []}),
        result("miss", {"kind": "answer", "answer": miss, "citations": ["market", "film"], "tool_calls": []}),
        result("empty", {"kind": "insufficient_evidence", "answer": "Nothing verified.", "citations": [], "tool_calls": []}),
        result("failed", None),
    ]
    llm = LocalRagasLLM(Settings(), transport=supports({
        half: {"Shoreline Jazz is free on Friday at 7 PM.": True},
        miss: {"The Night Market is free.": True, "The film night is free.": False},
    }))
    summary = score_retrieval(cases, results, Settings(), judge=llm)

    first, second, empty, failed = results
    assert (first.retrieval_precision, first.retrieval_recall) == pytest.approx((2 / 3, 1.0))
    assert (first.citation_precision, first.citation_recall, first.faithfulness) == (1.0, 0.5, 1.0)
    assert (second.retrieval_precision, second.retrieval_recall) == (0.5, 0.5)
    assert (second.citation_precision, second.citation_recall, second.faithfulness) == (0.5, 0.5, 0.5)
    assert (empty.citation_precision, empty.citation_recall, empty.faithfulness) == (1.0, 1.0, None)
    assert (failed.retrieval_recall, failed.citation_precision, failed.faithfulness) == (1.0, None, None)
    # Macro averages, each over the cases that have the metric.
    assert summary.cases == 4
    assert summary.retrieval_precision == pytest.approx((2 / 3 + 0.5 + 1.0 + 1.0) / 4)
    assert summary.citation_recall == pytest.approx((0.5 + 0.5 + 1.0) / 3)
    assert (summary.faithfulness, summary.faithfulness_cases) == (0.75, 2)
    # Rating, extraction and the other tasks are not retrieval and are left alone.
    rating = [c for c in load_cases() if c.id == "rate-jazz"]
    assert score_retrieval(rating, [result("rate-jazz", {"rating": 4})], Settings(), judge=llm).cases == 0
