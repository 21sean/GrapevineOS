import json
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from grapevine_llm import pins
from grapevine_llm.client import TRITON_TOOL, Failure, Message, Request, Success, generate, triton_transport
from grapevine_llm.pins import (TRITON_PATH, TRITON_REPOSITORY, TritonManifest, manifest_path, triton_engine_args,
                                triton_manifest, triton_repository_sha256, verify_runtime, verify_triton)
from grapevine_llm.provenance import capture
from grapevine_llm.settings import Settings

PIN = triton_manifest()
RATING = json.dumps({"rating": 4, "rationale": "local", "promoted": False})


class Fake:
    """A loopback server that answers like Triton: its OpenAI frontend and its KServe endpoint."""

    def __init__(self, arguments=RATING, content=None, finish="tool_calls", version=PIN.runtime_version,
                 backend=PIN.backend, served=PIN.generation.name):
        self.requests, self.paths = [], []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, payload):
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                fake.paths.append(self.path)
                if self.path == "/v2":
                    self.reply({"name": "triton", "version": version})
                elif self.path == "/v1/models":
                    self.reply({"object": "list", "data": [{"id": served, "object": "model"}]})
                elif self.path == f"/v2/models/{PIN.generation.name}/config":
                    self.reply({"name": PIN.generation.name, "backend": backend})
                else:
                    self.send_error(404)

            def do_POST(self):
                fake.paths.append(self.path)
                fake.requests.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
                pieces = [arguments[:5], arguments[5:]] if isinstance(arguments, str) else [arguments]
                events = [{"choices": [{"delta": {"role": "assistant"}, "finish_reason": None}]}]
                if content:
                    events.append({"choices": [{"delta": {"content": content}, "finish_reason": None}]})
                events += [{"choices": [{"delta": {"tool_calls": [
                    {"index": 0, "function": {"name": TRITON_TOOL, "arguments": piece}}]}, "finish_reason": None}]}
                    for piece in pieces]
                events += [{"choices": [{"delta": {}, "finish_reason": finish}]},
                           {"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 2}}]
                data = "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n"
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(data.encode())))
                self.end_headers()
                self.wfile.write(data.encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()


def request():
    return Request(id="test", task="rating", messages=[Message(role="user", content="Rate jazz")])


def payload():
    return {"model": PIN.generation.name, "stream": False, "think": False, "format": {"type": "object"},
            "options": {"temperature": 0, "seed": 42, "num_ctx": 16384, "num_predict": 4096},
            "messages": [{"role": "user", "content": "Rate jazz"}]}


@pytest.fixture
def kserve(monkeypatch):
    """Point the pin check's KServe lookups at the same fake as the OpenAI frontend."""
    def use(fake):
        monkeypatch.setenv("GRAPEVINE_TRITON_KSERVE_URL", fake.url)
        return fake
    return use


def test_manifest_is_a_pinned_record():
    record = TritonManifest.model_validate_json(TRITON_PATH.read_text(encoding="utf-8"))
    assert (record.runtime, record.backend) == ("triton", "vllm")
    assert record.generation == record.judge
    assert "@sha256:" in record.container
    assert record.generation.quantization
    assert manifest_path("triton") == TRITON_PATH


def test_the_checked_in_repository_is_the_one_the_manifest_fingerprints():
    assert triton_repository_sha256() == PIN.repository_sha256
    engine = triton_engine_args(PIN.generation)
    # The agent schema combines `pattern` with length limits, which only this backend accepts.
    assert engine["structured_outputs_config"] == {"backend": "guidance"}
    assert engine["model"].endswith(PIN.generation.repository)


def test_triton_defaults_to_the_pinned_endpoint_and_model(monkeypatch):
    monkeypatch.delenv("GRAPEVINE_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("GRAPEVINE_LLM_MODEL", raising=False)
    monkeypatch.setenv("GRAPEVINE_LLM_RUNTIME", "triton")
    settings = Settings()
    assert (settings.base_url, settings.model) == ("http://127.0.0.1:9000", PIN.generation.name)
    with pytest.raises(ValueError):
        Settings(runtime="triton", base_url="https://example.com")


def test_transport_sends_the_schema_as_the_one_named_tool():
    with Fake() as fake:
        assert triton_transport(fake.url, 100_000)(payload(), 5) == RATING
    assert fake.paths == ["/v1/chat/completions"]
    sent = fake.requests[0]
    assert sent["tools"] == [{"type": "function", "function": {"name": TRITON_TOOL, "parameters": {"type": "object"}}}]
    assert sent["tool_choice"] == {"type": "function", "function": {"name": TRITON_TOOL}}
    assert (sent["temperature"], sent["seed"], sent["max_completion_tokens"], sent["stream"]) == (0, 42, 4096, True)
    # The frontend drops response_format and refuses fields it does not know.
    assert not {"response_format", "chat_template_kwargs", "max_tokens", "think", "options", "format"} & set(sent)


def test_transport_fails_closed_on_free_text_truncation_non_text_and_size():
    # Text beside the tool call was never constrained by the schema.
    with Fake(content="Sure, here it is:") as fake, pytest.raises(ValueError, match="unconstrained"):
        triton_transport(fake.url, 100_000)(payload(), 5)
    with Fake(finish="length") as fake, pytest.raises(ValueError, match="truncated"):
        triton_transport(fake.url, 100_000)(payload(), 5)
    with Fake(arguments={"rating": 4}) as fake, pytest.raises(ValueError, match="text"):
        triton_transport(fake.url, 100_000)(payload(), 5)
    with Fake() as fake, pytest.raises(ValueError, match="byte limit"):
        triton_transport(fake.url, 8)(payload(), 5)


def test_generate_routes_through_triton_when_selected():
    with Fake() as fake:
        result = generate(request(), Settings(runtime="triton", base_url=fake.url))
    assert isinstance(result, Success)
    assert result.output.rating == 4
    assert fake.paths == ["/v1/chat/completions"]
    # The contract and its schema lead the conversation, as on every other runtime.
    assert fake.requests[0]["messages"][0]["role"] == "system"


def test_invalid_triton_output_repairs_then_fails_with_no_partial_output():
    with Fake(arguments='{"rating": 3}') as fake:
        result = generate(request(), Settings(runtime="triton", base_url=fake.url, max_attempts=2))
    assert isinstance(result, Failure)
    assert result.code == "validation_exhausted"
    assert len(fake.requests) == 2


def test_pins_accept_the_reviewed_server(kserve):
    with Fake() as fake:
        kserve(fake)
        assert verify_triton(fake.url, 16384).generation.name == PIN.generation.name
        assert verify_runtime("triton", fake.url, 16384).runtime == "triton"
    assert f"/v2/models/{PIN.generation.name}/config" in fake.paths


@pytest.mark.parametrize("change", [{"version": "2.74.0"}, {"backend": "tensorrtllm"}, {"served": "another-model"}])
def test_pins_refuse_another_server_backend_or_model(change, kserve):
    with Fake(**change) as fake, pytest.raises(ValueError):
        verify_triton(kserve(fake).url, 16384)


def test_pins_refuse_a_context_longer_than_the_engine_was_started_with(kserve):
    with Fake() as fake, pytest.raises(ValueError, match="max model length"):
        verify_triton(kserve(fake).url, triton_engine_args(PIN.generation)["max_model_len"] + 1)


def test_pins_refuse_a_model_repository_that_was_edited(tmp_path, monkeypatch, kserve):
    edited = tmp_path / "triton"
    shutil.copytree(TRITON_REPOSITORY, edited)
    model = edited / "model_repository" / PIN.generation.name / "1" / "model.json"
    args = json.loads(model.read_text(encoding="utf-8"))
    model.write_text(json.dumps({**args, "gpu_memory_utilization": 0.95}), encoding="utf-8")
    monkeypatch.setattr(pins, "TRITON_REPOSITORY", edited)
    with Fake() as fake, pytest.raises(ValueError, match="model repository differs"):
        verify_triton(kserve(fake).url, 16384)
    # The server is never asked: a changed repository is refused before anything is trusted.
    assert fake.paths == []


def test_provenance_fingerprints_the_triton_manifest(monkeypatch):
    monkeypatch.setenv("GRAPEVINE_LLM_RUNTIME", "vllm")
    vllm = capture(16384, 3).models_sha256
    monkeypatch.setenv("GRAPEVINE_LLM_RUNTIME", "triton")
    assert capture(16384, 3).models_sha256 != vllm
