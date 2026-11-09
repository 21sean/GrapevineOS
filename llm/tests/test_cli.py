import json
import sys

import pytest

from grapevine_llm import cli
from grapevine_llm.client import Failure, Message, Request, generate
from grapevine_llm.contracts import Context
from grapevine_llm.settings import Settings
from grapevine_llm.streaming import GenerationLog


@pytest.mark.parametrize("provider", ["codex", "claude"])
def test_cli_runs_without_shell_and_keeps_prompts_off_argv(monkeypatch, provider):
    captured = []
    expected = {"summary": "hello"}

    def run(name, args, prompt, cwd, timeout, max_bytes):
        captured.append((name, args, prompt, cwd))
        if name == "codex":
            from pathlib import Path
            Path(args[args.index("--output-last-message") + 1]).write_text(json.dumps(expected))
            return 0, "ignored diagnostics"
        return 0, json.dumps({"subtype": "success", "structured_output": expected})

    monkeypatch.setattr(cli, "run", run)
    payload = {"model": "test", "format": {"type": "object"},
               "messages": [{"role": "user", "content": 'private $(secret) `command` "quoted"'}]}
    result = cli.cli_transport(provider, 10_000, GenerationLog)(payload, 10)
    assert json.loads(result) == expected
    _, args, prompt, cwd = captured[0]
    assert "private" not in " ".join(args)
    assert "private" in prompt
    assert "grapevine-inference-" in cwd
    if provider == "codex":
        assert "--ignore-user-config" in args
        assert "features.shell_tool=false" in args
        assert "features.hooks=false" in args
        assert "features.multi_agent=false" in args
        assert "read-only" in args
    else:
        assert args[args.index("--tools") + 1] == ""
        assert "--strict-mcp-config" in args
        assert "--no-session-persistence" in args


def test_cli_environment_does_not_receive_app_secrets(monkeypatch):
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "private")
    monkeypatch.setenv("CLAUDECODE", "nested-session")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic")
    monkeypatch.setenv("CODEX_API_KEY", "openai")
    for provider in ("claude", "codex"):
        env = cli.environment(provider)
        assert "SUPABASE_SERVICE_ROLE_KEY" not in env
        assert "CLAUDECODE" not in env
    assert "ANTHROPIC_API_KEY" not in cli.environment("codex")
    assert "CODEX_API_KEY" not in cli.environment("claude")


@pytest.mark.parametrize("reply", [{"subtype": "success"}, {"is_error": True},
                                   {"subtype": "error_max_turns", "structured_output": {}}])
def test_claude_missing_or_failed_output_is_not_accepted(monkeypatch, reply):
    monkeypatch.setattr(cli, "run", lambda *_: (0, json.dumps(reply)))
    with pytest.raises(cli.CliError):
        cli.cli_transport("claude", 10_000, GenerationLog)(
            {"format": {}, "messages": [], "model": "opus"}, 10)


def test_hosted_output_still_checks_tool_permissions_and_evidence():
    req = Request(id="test", task="agent", messages=[Message(role="user", content="hello")],
                  context=Context(allowed_tools=[], require_citations=True))
    bad = '{"kind":"answer","answer":"invented","citations":["unknown"],"tool_calls":[]}'
    result = generate(req, Settings(provider="claude", max_attempts=1), transport=lambda *_: bad)
    assert isinstance(result, Failure)
    assert result.code == "validation_exhausted"


def test_transport_error_is_sanitized_and_not_retried(monkeypatch):
    calls = []

    def run(*args):
        calls.append(args)
        return 1, "secret token and private content"

    monkeypatch.setattr(cli, "run", run)
    req = Request(id="test", task="summary", messages=[Message(role="user", content="hi")])
    result = generate(req, Settings(provider="claude"))
    assert result.code == "transport"
    assert "secret" not in result.message
    assert len(calls) == 1


def test_process_output_limit_and_timeout(monkeypatch, tmp_path):
    monkeypatch.setattr(cli, "command", lambda _: [sys.executable])
    with pytest.raises(cli.CliError, match="limit"):
        cli.run("codex", ["-c", "print('x' * 100000)"], "", str(tmp_path), 5, 1024)
    with pytest.raises(TimeoutError):
        cli.run("codex", ["-c", "import time; time.sleep(10)"], "", str(tmp_path), 0.05)


def test_non_hosted_still_rejects_remote_endpoint():
    with pytest.raises(ValueError):
        Settings(base_url="https://example.com")


def test_offline_evaluations_never_spawn_a_cli(monkeypatch):
    monkeypatch.setenv("GRAPEVINE_LLM_OFFLINE", "1")
    monkeypatch.setattr(cli, "run", lambda *_: pytest.fail("must not start a CLI"))
    with pytest.raises(cli.CliError, match="offline"):
        cli.cli_transport("claude", 10_000, GenerationLog)({}, 10)
    from grapevine_llm.evals import run
    with pytest.raises(ValueError, match="local provider"):
        run("live", Settings(provider="claude"))


def test_provider_schema_supports_all_graph_tools_without_changing_contract():
    from grapevine_llm.contracts import TOOL_ARGS, request_schema, validate_output
    from jsonschema import Draft202012Validator
    original = request_schema("agent", list(TOOL_ARGS))
    before = json.dumps(original)
    projected = cli.provider_schema(original)
    Draft202012Validator.check_schema(projected)
    assert json.dumps(original) == before
    assert '"oneOf"' not in json.dumps(projected)
    assert '"discriminator"' not in json.dumps(projected)
    output = {"kind": "tools", "answer": "", "citations": [], "tool_calls": [
        {"name": "get_eta", "args": {"to": [0, 100], "from": None, "to_event_id": None}}]}
    # The projection allows a coordinate tuple; the authoritative gate still
    # rejects latitude outside [-90, 90], before any tool can run.
    Draft202012Validator(projected).validate(output)
    with pytest.raises(ValueError):
        validate_output("agent", json.dumps(output), Context(allowed_tools=["get_eta"]))


def test_claude_duplicate_fields_cannot_disappear_during_envelope_parsing(monkeypatch):
    monkeypatch.setattr(cli, "run", lambda *_: (0,
        '{"subtype":"success","structured_output":{"summary":"a","summary":"b"}}'))
    with pytest.raises(cli.CliError, match="duplicate"):
        cli.cli_transport("claude", 10_000, GenerationLog)(
            {"format": {}, "messages": [], "model": "best"}, 10)


@pytest.mark.parametrize(("diagnostic", "expected"), [
    ("private token: secret; HTTP 429 rate_limit_exceeded", "usage limit"),
    ("private token: secret; authentication failed", "codex login"),
    ("private token: secret; invalid_json_schema", "structured-output"),
    ("private token: secret; model_not_found", "selected model"),
])
def test_errors_are_actionable_without_echoing_provider_diagnostics(diagnostic, expected):
    message = cli.failure_message("codex", diagnostic)
    assert expected in message
    assert "secret" not in message
