import json
import os
import socket

import pytest

from grapevine_llm.client import Message, Request, generate
from grapevine_llm.settings import Settings, local_endpoint
from grapevine_llm.telemetry import scrub


@pytest.mark.parametrize("url", ["https://api.openai.com", "http://localhost.evil.test", "http://192.168.1.2", "http://127.0.0.1@evil.test", "http://127.0.0.1/?redirect=x"])
def test_external_endpoints_rejected(url):
    with pytest.raises(ValueError):
        local_endpoint(url)


def test_complete_fake_call_and_trace_with_network_denied(monkeypatch):
    def deny(*_args, **_kwargs):
        raise AssertionError("unexpected network access")
    monkeypatch.setattr(socket.socket, "connect", deny)
    req = Request(id="offline", task="rating", messages=[Message(role="user", content="test")])
    result = generate(req, Settings(), transport=lambda *_: json.dumps({"rating": 4, "rationale": "Local", "promoted": False}))
    assert result.ok
    assert os.environ["RAGAS_DO_NOT_TRACK"] == "true"
    assert "a@example.com" not in scrub("a@example.com bearer secret-value")
    assert "secret-value" not in scrub("a@example.com bearer secret-value")
