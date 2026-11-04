import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from grapevine_llm.client import Failure, Message, Request, Success, generate, one_system_message, vllm_transport
from grapevine_llm.pins import VLLM_PATH, VllmManifest, manifest_path, verify_vllm, vllm_manifest
from grapevine_llm.provenance import capture
from grapevine_llm.settings import Settings

PIN = vllm_manifest()
RATING = json.dumps({"rating": 4, "rationale": "local", "promoted": False})


class Fake:
    """A loopback server that answers like vLLM and records what it was sent."""

    def __init__(self, content=RATING, finish="stop", version=PIN.runtime_version, root=f"/models/{PIN.generation.repository}", max_len=65536):
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
                if self.path == "/version":
                    self.reply({"version": version})
                elif self.path == "/v1/models":
                    self.reply({"data": [{"id": PIN.generation.name, "root": root, "max_model_len": max_len}]})
                else:
                    self.send_error(404)

            def do_POST(self):
                fake.paths.append(self.path)
                fake.requests.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
                pieces = [content[:5], content[5:]] if isinstance(content, str) else [content]
                events = [{"choices": [{"delta": {"role": "assistant"}, "finish_reason": None}]}]
                events += [{"choices": [{"delta": {"content": piece}, "finish_reason": None}]} for piece in pieces]
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


def test_manifest_is_a_pinned_record():
    pins = VllmManifest.model_validate_json(VLLM_PATH.read_text(encoding="utf-8"))
    assert pins.runtime == "vllm"
    assert pins.generation == pins.judge
    assert manifest_path("vllm") == VLLM_PATH
    assert manifest_path("ollama").name == "models.json"


def test_ollama_stays_the_default(monkeypatch):
    monkeypatch.delenv("GRAPEVINE_LLM_RUNTIME", raising=False)
    monkeypatch.delenv("GRAPEVINE_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("GRAPEVINE_LLM_MODEL", raising=False)
    settings = Settings()
    assert (settings.runtime, settings.base_url, settings.model) == ("ollama", "http://127.0.0.1:11434", "qwen3.8:27b")


def test_vllm_defaults_and_explicit_values(monkeypatch):
    monkeypatch.delenv("GRAPEVINE_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("GRAPEVINE_LLM_MODEL", raising=False)
    monkeypatch.setenv("GRAPEVINE_LLM_RUNTIME", "vllm")
    settings = Settings()
    assert (settings.base_url, settings.model) == ("http://127.0.0.1:8000", PIN.generation.name)
    assert Settings(base_url="http://localhost:9000", model="other").base_url == "http://localhost:9000"


def test_unknown_runtime_and_public_endpoint_are_rejected():
    with pytest.raises(ValueError):
        Settings(runtime="openai")
    with pytest.raises(ValueError):
        Settings(runtime="vllm", base_url="https://example.com")


def test_transport_sends_constrained_decoding_with_thinking_off():
    with Fake() as fake:
        assert vllm_transport(fake.url, 100_000)(payload(), 5) == RATING
    assert fake.paths == ["/v1/chat/completions"]
    sent = fake.requests[0]
    assert sent["response_format"]["type"] == "json_schema"
    assert sent["response_format"]["json_schema"]["schema"] == {"type": "object"}
    assert sent["response_format"]["json_schema"]["strict"] is True
    assert sent["chat_template_kwargs"] == {"enable_thinking": False}
    assert (sent["temperature"], sent["seed"], sent["max_tokens"], sent["stream"]) == (0, 42, 4096, True)


def test_transport_fails_closed_on_truncation_non_text_and_size():
    with Fake(finish="length") as fake, pytest.raises(ValueError, match="truncated"):
        vllm_transport(fake.url, 100_000)(payload(), 5)
    with Fake(content=7) as fake, pytest.raises(ValueError, match="text"):
        vllm_transport(fake.url, 100_000)(payload(), 5)
    with Fake() as fake, pytest.raises(ValueError, match="byte limit"):
        vllm_transport(fake.url, 8)(payload(), 5)


def test_system_messages_merge_in_order_at_the_front():
    merged = one_system_message([
        {"role": "system", "content": "contract"},
        {"role": "system", "content": "rules"},
        {"role": "user", "content": "question"},
        {"role": "system", "content": "summary"},
        {"role": "assistant", "content": "answer"},
    ])
    assert merged == [
        {"role": "system", "content": "contract\n\nrules\n\nsummary"},
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": "answer"},
    ]
    assert one_system_message([{"role": "user", "content": "question"}]) == [{"role": "user", "content": "question"}]


def test_generate_routes_through_vllm_when_selected():
    with Fake() as fake:
        result = generate(request(), Settings(runtime="vllm", base_url=fake.url))
    assert isinstance(result, Success)
    assert result.output.rating == 4
    assert fake.paths == ["/v1/chat/completions"]


def test_invalid_vllm_output_repairs_then_fails_with_no_partial_output():
    with Fake(content='{"rating": 3}') as fake:
        result = generate(request(), Settings(runtime="vllm", base_url=fake.url, max_attempts=2))
    assert isinstance(result, Failure)
    assert result.code == "validation_exhausted"
    assert len(fake.requests) == 2


def test_pins_accept_the_reviewed_runtime():
    with Fake() as fake:
        assert verify_vllm(fake.url, 16384).generation.name == PIN.generation.name


@pytest.mark.parametrize("change", [{"version": "0.32.0"}, {"root": "/models/Other/Repo"}, {"max_len": 4096}])
def test_pins_refuse_a_changed_runtime_model_or_short_context(change):
    with Fake(**change) as fake, pytest.raises(ValueError):
        verify_vllm(fake.url, 16384)


def test_provenance_fingerprints_the_active_manifest(monkeypatch):
    monkeypatch.delenv("GRAPEVINE_LLM_RUNTIME", raising=False)
    ollama = capture(16384, 3).models_sha256
    monkeypatch.setenv("GRAPEVINE_LLM_RUNTIME", "vllm")
    assert capture(16384, 3).models_sha256 != ollama
