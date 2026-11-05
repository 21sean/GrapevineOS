"""Timing and answer extraction, at the point the tokens arrive."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

from hypothesis import given, strategies as st

from grapevine_llm.client import Message, Request, Stats, Success, generate
from grapevine_llm.metrics import percentiles, summarize
from grapevine_llm.settings import Settings
from grapevine_llm.streaming import AnswerStream, GenerationLog


def stream_all(raw: str, cuts: list[int]) -> str:
    stream = AnswerStream()
    out, start = [], 0
    for cut in sorted(cut % (len(raw) + 1) for cut in cuts):
        out.append(stream.feed(raw[start:cut]))
        start = max(start, cut)
    out.append(stream.feed(raw[start:]))
    return "".join(out)


@given(st.text(max_size=200), st.lists(st.integers(min_value=0, max_value=1000), max_size=30),
       st.booleans())
def test_answer_survives_any_chunking_and_any_escaping(answer, cuts, ascii_only):
    raw = json.dumps({"kind": "answer", "answer": answer, "citations": ["answer"], "tool_calls": []},
                     ensure_ascii=ascii_only)
    # A surrogate cannot come back whole from a lone half; those never reach the
    # person because a model emits valid text and the gate rejects the rest.
    if any(0xD800 <= ord(c) <= 0xDFFF for c in answer):
        return
    assert stream_all(raw, cuts) == answer


def test_nothing_but_the_answer_field_is_shown():
    raw = json.dumps({"kind": "tools", "answer": "", "citations": [],
                      "tool_calls": [{"name": "search_web", "args": {"answer": "not this", "query": "x"}}]})
    assert stream_all(raw, [3, 11]) == ""


def test_a_decoy_key_inside_a_nested_object_is_not_the_answer():
    raw = '{"kind":"tools","tool_calls":[{"name":"x","args":{"answer":"leak"}}],"answer":"real"}'
    assert stream_all(raw, [20]) == "real"


def test_surrogate_pair_split_across_chunks_decodes_once():
    raw = '{"answer":"\\ud83c\\udfb7 jazz"}'
    assert stream_all(raw, [18, 21, 25]) == "\U0001f3b7 jazz"


def test_generation_log_reports_first_token_tpot_and_runtime_counts():
    log = GenerationLog()
    log.mark_sent()
    log.reasoning("hmm")
    log.token("a")
    log.token("b")
    log.token("c")
    log.final = {"eval_count": 3, "prompt_eval_count": 40, "prompt_eval_cached_count": 30,
                 "eval_duration": 2_000_000, "load_duration": 1_000_000, "prompt_eval_duration": 5_000_000}
    stats = log.stats()
    assert stats["first_token_ms"] >= stats["first_reasoning_ms"] >= 0
    assert stats["tpot_ms"] >= 0
    assert (stats["prompt_tokens"], stats["output_tokens"]) == (40, 3)
    assert stats["cached_prompt_tokens"] == 30
    assert (stats["load_ms"], stats["prompt_eval_ms"], stats["eval_ms"]) == (1.0, 5.0, 2.0)


def test_nothing_generated_is_null_rather_than_zero():
    stats = GenerationLog().stats()
    assert stats["first_token_ms"] is None
    assert stats["tpot_ms"] is None
    assert stats["output_tokens"] is None


def test_replay_transport_leaves_timing_empty():
    req = Request(id="r", task="rating", messages=[Message(role="user", content="x")])
    result = generate(req, Settings(), transport=lambda *_: json.dumps({"rating": 4, "rationale": "x", "promoted": False}))
    assert isinstance(result, Success)
    assert result.stats.first_token_ms is None


class FakeRuntime(BaseHTTPRequestHandler):
    lines: list[dict] = []
    seen: list[dict] = []

    def do_POST(self):
        FakeRuntime.seen.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
        self.send_response(200)
        self.end_headers()
        for line in FakeRuntime.lines:
            self.wfile.write((json.dumps(line) + "\n").encode())
            self.wfile.flush()

    def log_message(self, *_):
        pass


def fake_runtime(lines: list[dict]) -> tuple[str, HTTPServer]:
    FakeRuntime.lines, FakeRuntime.seen = lines, []
    server = HTTPServer(("127.0.0.1", 0), FakeRuntime)
    Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_port}", server


def test_the_real_transport_times_a_stream_and_records_it():
    body = json.dumps({"rating": 4, "rationale": "Local", "promoted": False})
    lines = [{"message": {"content": body[i:i + 8]}, "done": False} for i in range(0, len(body), 8)]
    lines.append({"message": {"content": ""}, "done": True, "done_reason": "stop", "eval_count": 9,
                  "prompt_eval_count": 12, "prompt_eval_duration": 3_000_000, "eval_duration": 4_000_000,
                  "load_duration": 1_000_000})
    base, server = fake_runtime(lines)
    try:
        req = Request(id="r", task="rating", messages=[Message(role="user", content="x")], base_url=base)
        result = generate(req, Settings())
    finally:
        server.shutdown()
    assert isinstance(result, Success)
    assert FakeRuntime.seen[0]["stream"] is True
    assert result.stats.first_token_ms is not None and result.stats.first_token_ms <= result.stats.model_ms
    assert (result.stats.prompt_tokens, result.stats.output_tokens) == (12, 9)
    assert result.stats.prompt_eval_ms == 3.0


def test_a_truncated_stream_is_still_rejected():
    base, server = fake_runtime([{"message": {"content": '{"rating": 4'}, "done": False},
                                 {"message": {"content": ""}, "done": True, "done_reason": "length"}])
    try:
        req = Request(id="r", task="rating", messages=[Message(role="user", content="x")], base_url=base)
        result = generate(req, Settings(max_attempts=1))
    finally:
        server.shutdown()
    assert not result.ok


def test_percentiles_are_observed_values():
    assert percentiles([]) is None
    summary = percentiles([float(v) for v in range(1, 101)])
    assert (summary["p50"], summary["p95"], summary["p99"], summary["n"]) == (50.0, 95.0, 99.0, 100)


def test_metrics_summarize_ttft_from_generation_events(tmp_path):
    stats = Stats(attempts=1, validation_failures=0, first_pass=True, validation_ms=1.0, total_ms=2.0, repair_ms=0.0)
    path = tmp_path / "traces.jsonl"
    path.write_text(json.dumps({"events": [
        {"name": "generation", "attributes": {"first_token_ms": 120.0, "tpot_ms": 15.0}},
        {"name": "success", "attributes": stats.model_dump(exclude_none=True)},
    ]}), encoding="utf-8")
    metrics = summarize(path)
    assert metrics["model_ttft_ms"]["p99"] == 120.0
    assert metrics["model_tpot_ms"]["p50"] == 15.0


def agent_request(base: str, **extra) -> Request:
    from grapevine_llm.contracts import Context
    return Request(id="a", task="agent", base_url=base, messages=[Message(role="user", content="x")],
                   context=Context(evidence=[{"id": "jazz", "text": "Jazz at six"}], require_citations=True),
                   stream_answer=True, **extra)


def lines_for(body: str, size: int = 7) -> list[dict]:
    lines = [{"message": {"content": body[i:i + size]}, "done": False} for i in range(0, len(body), size)]
    lines.append({"message": {"content": ""}, "done": True, "done_reason": "stop", "eval_count": 20,
                  "prompt_eval_count": 12})
    return lines


def test_answer_text_arrives_as_frames_and_the_result_still_validates():
    body = json.dumps({"kind": "answer", "answer": "Jazz at \"six\".", "citations": ["jazz"], "tool_calls": []})
    base, server = fake_runtime(lines_for(body))
    frames = []
    try:
        result = generate(agent_request(base), Settings(), on_frame=frames.append)
    finally:
        server.shutdown()
    assert isinstance(result, Success)
    assert "".join(f.delta for f in frames) == 'Jazz at "six".'
    assert all(f.id == "a" and f.reset is None for f in frames)
    assert result.stats.first_answer_ms >= result.stats.first_token_ms


def test_a_failed_attempt_is_taken_back_before_the_repair():
    bad = json.dumps({"kind": "answer", "answer": "Invented.", "citations": ["nope"], "tool_calls": []})
    base, server = fake_runtime(lines_for(bad))
    frames = []
    try:
        result = generate(agent_request(base), Settings(max_attempts=2), on_frame=frames.append)
    finally:
        server.shutdown()
    assert not result.ok
    assert result.code == "validation_exhausted"
    resets = [i for i, f in enumerate(frames) if f.reset]
    assert len(resets) == 2
    assert frames[-1].reset is True


def test_only_the_agent_answer_can_stream():
    body = json.dumps({"rating": 4, "rationale": "Local", "promoted": False})
    base, server = fake_runtime(lines_for(body))
    frames = []
    try:
        req = Request(id="r", task="rating", messages=[Message(role="user", content="x")], base_url=base,
                      stream_answer=True)
        result = generate(req, Settings(), on_frame=frames.append)
    finally:
        server.shutdown()
    assert result.ok
    assert frames == []


def test_a_tool_turn_shows_nothing():
    from grapevine_llm.contracts import Context
    body = json.dumps({"kind": "tools", "answer": "", "citations": [],
                       "tool_calls": [{"name": "search_web", "args": {"query": "jazz"}}]})
    base, server = fake_runtime(lines_for(body))
    frames = []
    try:
        req = Request(id="t", task="agent", base_url=base, messages=[Message(role="user", content="x")],
                      context=Context(allowed_tools=["search_web"]), stream_answer=True)
        result = generate(req, Settings(), on_frame=frames.append)
    finally:
        server.shutdown()
    assert result.ok and result.output.tool_calls
    assert frames == []
