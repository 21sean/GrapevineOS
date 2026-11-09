"""Headless subscription CLIs. No shell, project context, or native agent tools.

Only the transport changes: client.py still owns schema, evidence, tool allowlist,
repair and deadline validation. CLI diagnostics never return raw stderr or tokens.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor


class CliError(Exception):
    """A bounded, safe message that may cross the gate boundary."""


def failure_message(provider: str, diagnostics: str) -> str:
    text = diagnostics.lower()
    if any(word in text for word in ("rate_limit", "rate limit", "quota", "usage limit", "429", "insufficient credits")):
        return f"{provider} usage limit reached; wait for the limit to reset or check the account's billing"
    if any(word in text for word in ("unauthorized", "authentication", "not logged in", "401", "token expired")):
        login = "codex login" if provider == "codex" else "claude auth login"
        return f"{provider} sign-in needs attention; run {login} as the API server user"
    if any(word in text for word in ("invalid_json_schema", "invalid schema", "unknown option", "unexpected argument")):
        return f"{provider} rejected the structured-output configuration; update the CLI and check provider compatibility"
    if any(word in text for word in ("model_not_found", "model not found", "does not have access", "not supported")):
        return f"{provider} cannot access the selected model; check GRAPEVINE_{provider.upper()}_MODEL and account access"
    return f"{provider} could not complete inference; retry or check sign-in, model access and quota in Admin → Providers"


def provider_schema(schema: dict) -> dict:
    """Project the canonical schema into the providers' structured-output subset.

    Discriminated tool unions have distinct name enums, so anyOf preserves their
    meaning. Tuple position bounds stay enforced by the canonical validator.
    Defaults in our output contracts are nullable; requiring those fields is safe.
    Never change the versioned contract or relax the post-generation validator.
    """
    def visit(value):
        if isinstance(value, list):
            return [visit(item) for item in value]
        if not isinstance(value, dict):
            return value
        node = {("anyOf" if key == "oneOf" else key): visit(item)
                for key, item in value.items() if key not in ("discriminator", "default", "title")}
        if "const" in node:
            node["enum"] = [node.pop("const")]
        if "prefixItems" in node:
            node["items"] = {"anyOf": node.pop("prefixItems")}
        if node.get("type") == "object":
            node["required"] = list(node.get("properties", {}))
            node["additionalProperties"] = False
        # Tool-free turns still need an items type accepted by strict schemas.
        if node.get("type") == "array" and node.get("items") == {}:
            node["items"] = {"type": "string"}
        return node
    return visit(schema)


def command(provider: str) -> list[str]:
    if provider not in ("codex", "claude"):
        raise CliError("Unsupported CLI provider")
    override = os.environ.get(f"GRAPEVINE_{provider.upper()}_BIN")
    executable = override or shutil.which(provider) or shutil.which(provider + ".exe")
    if not executable:
        raise CliError(f"Install {provider} on the API server, then refresh Providers")
    path = Path(executable)
    # npm's Windows launchers require cmd.exe. Resolve their JS entrypoint instead,
    # so prompts and JSON schemas never become shell code.
    if path.suffix.lower() in (".cmd", ".bat", ".ps1"):
        package = "@openai/codex/bin/codex.js" if provider == "codex" else "@anthropic-ai/claude-code/cli.js"
        entry = path.parent / "node_modules" / package
        node = shutil.which("node")
        if node and entry.is_file():
            return [node, str(entry)]
        raise CliError(f"Install the native {provider} CLI or set GRAPEVINE_{provider.upper()}_BIN")
    return [str(path)]


def environment(provider: str) -> dict[str, str]:
    # Do not pass database, email, Mapbox, telemetry or other application secrets.
    names = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
             "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
             "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY",
             "HTTP_PROXY", "NO_PROXY"}
    names |= ({"CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"} if provider == "codex" else
              {"CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
               "CLAUDE_CODE_GIT_BASH_PATH"})
    env = {key: value for key, value in os.environ.items() if key.upper() in names}
    env.update({"NO_COLOR": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"})
    return env


def run(provider: str, args: list[str], prompt: str, cwd: str, timeout: float,
        max_bytes: int = 1_000_000) -> tuple[int, str]:
    """Drain pipes concurrently with a shared byte cap, and reap on every exit."""
    try:
        child = subprocess.Popen([*command(provider), *args], cwd=cwd, env=environment(provider),
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, creationflags=(
                                     subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0))
    except OSError as exc:
        raise CliError(f"Cannot start {provider}; check its installation on the API server") from exc
    output = bytearray()
    diagnostics = bytearray()
    size = 0
    overflow = threading.Event()
    lock = threading.Lock()

    def terminate():
        if child.poll() is not None:
            return
        if os.name == "nt":
            # npm launchers can have a native child which inherits the pipes.
            killer = Path(os.environ.get("SYSTEMROOT", "C:/Windows")) / "System32/taskkill.exe"
            try:
                subprocess.run([str(killer), "/PID", str(child.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=5, creationflags=subprocess.CREATE_NO_WINDOW)
            except (OSError, subprocess.TimeoutExpired):
                child.kill()
        else:
            # npm's Codex launcher forwards SIGTERM to its native child. SIGKILL
            # would leave that child holding stdout/stderr open.
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()

    def drain(pipe, keep):
        nonlocal size
        while chunk := pipe.read(4096):
            with lock:
                size += len(chunk)
                if size > max_bytes:
                    overflow.set()
                    terminate()
                    return
                if keep:
                    output.extend(chunk)
                else:
                    diagnostics.extend(chunk)

    def write():
        try:
            child.stdin.write(prompt.encode("utf-8"))
            child.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    threads = [threading.Thread(target=drain, args=(child.stdout, True)),
               threading.Thread(target=drain, args=(child.stderr, False)),
               threading.Thread(target=write)]
    for thread in threads:
        thread.start()
    try:
        child.wait(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError("CLI deadline exceeded") from exc
    finally:
        if child.poll() is None:
            terminate()
        child.wait()
        for thread in threads:
            thread.join()
        child.stdout.close()
        child.stderr.close()
    if overflow.is_set():
        raise CliError(f"{provider} response exceeded the output limit")
    if child.returncode and args and args[0] in ("exec", "-p"):
        raise CliError(failure_message(provider, (output + diagnostics).decode("utf-8", errors="replace")))
    return child.returncode, output.decode("utf-8")


def status(provider: str) -> dict:
    result = {"id": provider, "ready": False, "version": None, "message": ""}
    try:
        with tempfile.TemporaryDirectory(prefix="grapevine-check-") as cwd:
            code, version = run(provider, ["--version"], "", cwd, 10, 32_000)
            if code:
                raise CliError(f"Update {provider} to the latest release")
            result["version"] = version.strip()[:80]
            help_args = ["exec", "--help"] if provider == "codex" else ["--help"]
            code, help_text = run(provider, help_args, "", cwd, 10, 100_000)
            required = ["--ignore-user-config", "--output-schema", "--ephemeral"] if provider == "codex" else ["--json-schema", "--strict-mcp-config", "--no-session-persistence"]
            if code or any(flag not in help_text for flag in required):
                raise CliError(f"Update {provider} to the latest release; this installation lacks required isolation or structured-output flags")
            if provider == "codex" and os.environ.get("CODEX_API_KEY"):
                result.update(ready=True, message="API key configured; test the connection to verify access")
                return result
            args = ["login", "status"] if provider == "codex" else ["auth", "status"]
            code, _ = run(provider, args, "", cwd, 10, 32_000)
            result["ready"] = code == 0
            login = "codex login" if provider == "codex" else "claude auth login"
            result["message"] = "Signed in on the API server" if code == 0 else f"Run {login} as the API server user"
    except CliError as error:
        result["message"] = str(error)
    except TimeoutError:
        result["message"] = f"{provider} status check timed out; check the installation and refresh"
    return result


def cli_transport(provider: str, max_bytes: int, log):
    def call(payload: dict, remaining: float) -> str:
        if os.environ.get("GRAPEVINE_LLM_OFFLINE") == "1":
            raise CliError("Hosted inference is disabled in offline evaluations")
        with tempfile.TemporaryDirectory(prefix="grapevine-inference-") as cwd:
            schema = Path(cwd) / "schema.json"
            output_schema = provider_schema(payload["format"])
            schema.write_text(json.dumps(output_schema), encoding="utf-8")
            prompt = "Return only the requested JSON. Do not use native tools.\n" + json.dumps(payload["messages"], ensure_ascii=False)
            if provider == "codex":
                output = Path(cwd) / "answer.json"
                args = ["exec", "--json", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                        "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never",
                        "-c", 'approval_policy="never"', "-c", "features.shell_tool=false",
                        "-c", 'web_search="disabled"', "-c", "features.apps=false",
                        "-c", "project_doc_max_bytes=0", "-c", "features.hooks=false",
                        "-c", "features.multi_agent=false", "-c", "features.skill_search=false",
                        "-c", "features.skip_host_skill_discovery=true",
                        "--output-schema", str(schema), "--output-last-message", str(output),
                        "--model", payload["model"], "-"]
            else:
                args = ["-p", "--output-format", "json", "--json-schema", json.dumps(output_schema),
                        "--model", payload["model"], "--tools", "", "--strict-mcp-config",
                        "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
                        "--settings", '{"disableAllHooks":true}', "--no-session-persistence",
                        "--permission-mode", "dontAsk", "--max-turns", "3"]
            generation = log()
            generation.mark_sent()
            code, stdout = run(provider, args, prompt, cwd, remaining, max_bytes)
            if code:
                raise CliError(failure_message(provider, stdout))
            if provider == "codex":
                if not output.is_file() or output.stat().st_size > max_bytes:
                    raise CliError("Codex returned no bounded structured response")
                for line in stdout.splitlines():
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(event, dict) and event.get("type") == "turn.completed":
                        usage = event.get("usage") or {}
                        generation.final = {"prompt_eval_count": usage.get("input_tokens"),
                                            "prompt_eval_cached_count": usage.get("cached_input_tokens"),
                                            "eval_count": usage.get("output_tokens")}
                return output.read_text(encoding="utf-8")
            def unique_pairs(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise CliError("Claude returned duplicate JSON properties")
                    result[key] = value
                return result
            result = json.loads(stdout, object_pairs_hook=unique_pairs)
            if result.get("is_error") or result.get("subtype") != "success":
                raise CliError("Claude could not complete inference; check model access and quota")
            if not isinstance(result.get("structured_output"), dict):
                raise CliError("Claude returned no structured response; update Claude Code and retry")
            usage = result.get("usage") or {}
            generation.final = {"prompt_eval_count": sum(usage.get(key, 0) for key in
                                ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")),
                                "prompt_eval_cached_count": usage.get("cache_read_input_tokens"),
                                "eval_count": usage.get("output_tokens")}
            return json.dumps(result["structured_output"])
    return call


if __name__ == "__main__":
    with ThreadPoolExecutor(max_workers=2) as pool:
        print(json.dumps(list(pool.map(status, ["codex", "claude"]))))
