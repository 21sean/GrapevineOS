# ChatGPT and Claude providers

Grapevine can run chat, extraction, enrichment, verification and buzz ratings
through **Codex CLI** or **Claude Code**, using the same structured-output gate,
evidence checks, application tools and confirmation rules as local inference.
Chat and extraction are selected independently in **Admin → Providers**.
Ollama remains the default; nothing switches or sends data remotely automatically.

## Setup

On the machine running the API, as the same operating-system user that runs it:

```sh
uv sync --locked --project llm
npm install -g @openai/codex@latest
codex login
npm install -g @anthropic-ai/claude-code@latest
claude auth login
```

Install only the provider you want. Codex's login opens the official **Sign in
with ChatGPT** flow. Over SSH, use `codex login --device-auth`. Claude uses its
official account login. Existing CLI sessions are reused; no password or token
needs to be pasted into Grapevine. For native Claude installations use
`claude update`; for npm installations repeat the install command to update.

Start Grapevine, open **Admin → Providers**, refresh, and click **Test ChatGPT
connection** or **Test Claude connection**. The test makes a small real request
and validates its output. Select the provider for chat and/or extraction.
Selections persist immediately. Switching back to Local preserves the local model.

The CLI must be installed and signed in **inside the API's execution environment**.
A Windows desktop login is not automatically available inside WSL, Docker, a
service account or a remote server. Install/sign in there, or run the API under
the account already authenticated. Do not copy authentication files into the repo.

## Models and billing

Defaults verified against official documentation on **2026-11-09**:

| Provider        | Default                                               | Override in `server/.env` |
| --------------- | ----------------------------------------------------- | ------------------------- |
| ChatGPT / Codex | `gpt-6-astra`                                         | `GRAPEVINE_CODEX_MODEL`   |
| Claude Code     | `best` (Fable where available, otherwise latest Opus) | `GRAPEVINE_CLAUDE_MODEL`  |

Any model supported by the installed CLI and account can be selected with those
overrides, without a code change. Claude aliases follow the CLI's catalog; an
explicit model ID pins a version. Access and plan limits still depend on the
account. Fable can use separately billed usage credits on some plans; print mode
does not prompt before using those credits. Set `GRAPEVINE_CLAUDE_MODEL=opus`
for the latest Opus, or `sonnet` for a lighter workload. To use API billing instead, authenticate the CLI using its documented
API-key flow (`CODEX_API_KEY`/`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). Grapevine
does not silently fall back to another account, provider, or model on failure.

These are **deployment-wide provider credentials**, not separate subscriptions
for each Grapevine visitor. Chat context and selected extraction inputs go to
the selected provider, and all users share the server account's allowance.
Secure the admin surface with `ADMIN_EMAILS` and the deployment as described in
[setup](setup.md). The provider selection page explains this before switching.

Direct browser Sign in with ChatGPT is a separate integration: OpenAI documents
an OSS/local-app plan-usage flow, while commercial website client registration
is currently restricted. Grapevine's shared server does not implement per-user
OpenAI OAuth/token storage. This integration uses the working, official Codex
login flow instead; it never borrows another application's OAuth client ID or
reads tokens from the ChatGPT desktop app.

## Behavior and troubleshooting

- **Setup needed:** run the displayed install/login command as the API user,
  then refresh. Readiness checks CLI authentication or configured API credentials, not remaining
  quota or model access; use the connection test for those.
- **Python unavailable:** `uv sync --locked --project llm`. An alternate
  interpreter can be set with `GRAPEVINE_LLM_PYTHON`.
- **CLI not found:** restart the API after changing PATH. Optionally set
  `GRAPEVINE_CODEX_BIN` or `GRAPEVINE_CLAUDE_BIN` to an executable path (no
  arguments). Windows npm shims are resolved without invoking a shell.
- **Inference failed:** update the CLI, check login and the configured model's
  availability/quota, and rerun the connection test. Private CLI stderr is not
  returned to browsers or logs.
- **Timeout:** each generation has the existing total 120-second budget,
  including repairs. Chat retains its whole-turn deadline. Disconnects cancel
  that request's worker and CLI process tree. At most four hosted workers run
  concurrently; excess work gets a retryable busy message.
- **Answer timing:** hosted answers appear after complete validation, rather
  than token by token. Tool activity and application actions still use the
  existing chat stream. Local token streaming is unchanged.

Each generation runs in a fresh temporary directory, receives its conversation
on stdin, and disables native CLI tools, project instructions, MCP configuration
and hooks. The graph alone executes validated Grapevine tool requests. Only
provider authentication and operating-system environment variables reach the CLI;
database/email/location credentials do not. Temporary files are removed on normal
completion; session persistence is disabled. Abrupt process termination may leave
temporary files for the operating system's normal temp cleanup.

Provider-facing schemas translate discriminated unions and coordinate tuples
into the CLIs' supported JSON Schema subset. The original Pydantic contract still
validates every result, including tool names, event IDs and coordinate bounds;
the immutable versioned schemas are unchanged.

Offline evaluation continues to require the local provider; it never uses CLI
credentials. For an explicit online smoke test against public fixtures:

```sh
uv run --directory llm python -m grapevine_llm.provider_smoke codex --all-tasks
uv run --directory llm python -m grapevine_llm.provider_smoke claude --all-tasks
```

These checks consume provider allowance and are separate from offline quality
scores. They verify transport and contracts, not model quality on all workloads.

## Official references

- [Codex non-interactive execution and saved authentication](https://learn.chatgpt.com/docs/non-interactive-mode)
- [OpenAI model catalog](https://developers.openai.com/api/docs/models)
- [Sign in with ChatGPT for OSS/local apps](https://developers.openai.com/siwc/token-sharing-open-source)
- [Commercial client registration](https://developers.openai.com/siwc/request-client-id)
- [Claude print mode and structured output](https://code.claude.com/docs/en/headless)
- [Claude CLI flags and authentication](https://code.claude.com/docs/en/cli-reference)
- [Claude model aliases](https://code.claude.com/docs/en/model-config)
