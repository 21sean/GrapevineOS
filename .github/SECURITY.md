# Security

Grapevine is built to run on one person's machine, on free tiers, with a
local model. The defaults reflect that: a laptop clone is open and convenient,
a deployed one has to be closed on purpose. This page says where the lines
are, which settings move them, and how to report a problem.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository
([Security > Report a vulnerability](https://github.com/21sean/GrapevineOS/security/advisories/new)).
Describe what you found, how to reproduce it, and what it lets an attacker do.
This is a small project maintained in spare time, so expect an acknowledgement
within a week and a fix as soon as one is ready; please hold public details
until then.

## The trust boundary

- The browser talks to the Express API and uses Supabase only for sign-in.
  Every table has row level security enabled with no policies and the Data
  API roles have no grants, so the posture is deny-all: only the server and
  the email worker, each holding the secret key, touch data.
- The server verifies each request's Supabase JWT locally against the
  project's JWKS. The Google Calendar refresh token lives in Supabase Vault
  and is only readable through security-definer RPCs granted to the service
  role.
- Secrets live in `server/.env` and the worker's wrangler secrets, never in
  the browser bundle. The server refuses to start when a secret is still at
  the example value shipped in `server/.env.example`, and compares shared
  keys (`INGEST_SHARED_KEY`, `AGENT_API_KEY`) in constant time.

## The admin surface

Admin (settings, model pulls, ingest, discovery, monitoring, and the routes
behind them) is gated by one policy in `server/src/admin-gate.ts`:

| Situation                                   | Admin is                                         |
| ------------------------------------------- | ------------------------------------------------ |
| `NODE_ENV` unset, `ADMIN_EMAILS` unset      | open to anyone who can reach the port (a laptop) |
| `ADMIN_EMAILS` set                          | open to those signed-in accounts only            |
| `NODE_ENV=production`, `ADMIN_EMAILS` unset | closed to everyone                               |

Set `NODE_ENV=production` and `ADMIN_EMAILS` on anything reachable from
outside your machine. `/api/me` reports `isAdmin` so the client can hide what
it cannot use.

## The guardrails fail in different directions on purpose

- The input and content rails run a local classifier (Llama Prompt Guard 2)
  and fail **open**: a missing model download or a classifier error logs once
  and chat keeps working without screening. Availability wins over a stuck
  chat on a laptop. `GET /api/agent/capabilities` reports `rails.classifier`
  as `ready` or `failing-open` so the state is never silent, and every rail
  decision is recorded in `guardrail_scans` (Admin → Monitoring).
- The output persona rail is deterministic and fails **closed**: it is always
  on, even with `GUARDRAILS=off`, and holds back the last 64 characters of
  the stream so a leak split across chunks cannot pass.
- `GUARDRAIL_STORE_TEXT=off` keeps scanned text out of the database and
  leaves a salted hash (`GUARDRAIL_HASH_SALT`). Langfuse export masks emails,
  phone numbers and addresses unless `LANGFUSE_MASK=off`.

## Agent surfaces

- `POST /mcp` is OAuth 2.1 with Supabase Auth as the authorization server;
  each connected client acts as the account that signed in. `MCP_PUBLIC_URL`
  is the resource identifier clients validate, so it has to be right behind a
  tunnel or proxy.
- `MCP_OPEN=1` removes authentication from `/mcp` entirely and makes every
  write act on `AGENT_USER_EMAIL`. It exists for local tinkering. Never set
  it on a host anyone else can reach.
- `/api/ext/v1/*` and headless MCP calls accept `AGENT_API_KEY` in an
  `X-Agent-Key` header. Unset, the external API answers 503. Treat the key
  like a password: it can write to the calendar and the interests of
  `AGENT_USER_EMAIL`.
- Every tool that writes, on every surface, proposes first: the graph emits a
  confirm card, and the MCP and REST forms of `apply_interests` require
  `confirmed: true`. Web discovery defaults to a dry run.
- The agent's `read_page` and web discovery fetch untrusted pages through an
  SSRF guard (no private or link-local addresses, no redirects off the public
  internet) and the content rail screens what comes back before the model
  sees it. Links from event data are sanitised so a `javascript:` or `data:`
  URL never reaches an `href`.
- Model-backed endpoints are rate limited per client and single-flighted, so
  one browser cannot queue up unbounded generations.

## The optional Langfuse stack

`docker/observability/langfuse/docker-compose.override.yml` sets
`LANGFUSE_CODE_EVAL_DISPATCHER=insecure-local`, which runs Langfuse's three
TypeScript code evaluators inside the worker process with no sandbox. That is
acceptable only because the stack binds to localhost for one user and the
only code it runs is Langfuse's own templates. Remove those two environment
lines before exposing Langfuse to anyone who can define evaluators.

## Supply chain

Dependencies are pinned in one lockfile and watched by Dependabot. The
guardrail classifier is downloaded from Hugging Face on first run into
`server/.cache` (`GUARD_MODEL` names the exact repository). The email worker's
Supabase secret is a wrangler secret, not a file; rotate it from the Supabase
dashboard if it ever lands anywhere else.
