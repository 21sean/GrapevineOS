# Changelog

Cut from the commit history. Dates are commit dates; there are no version
tags yet, so entries are grouped by the day or week the work landed. Newest
first.

## 2026-09-02 to 2026-09-03: the reference cut

- Workspaces, unit tests and CI: one install, one lockfile, one TypeScript;
  vitest suites for the graph routing, the checkpointer, the NDJSON bridge,
  the persona guard, the contracts and the web reducer; GitHub Actions run
  typecheck, lint, prettier, the tests, the contract check and the offline
  evals on every push, the model suites nightly.
- The chat shows what it can do: `GET /api/agent/capabilities` and a popover
  in the composer name the provider, the toolbox and the rails; people can set
  up to five "watches" (scheduled searches they own) from a proposal card or
  the account dialog; a Claude hand-off card gives the connector URL and two
  routine prompts.
- A resilient service: startup loops that drain on SIGTERM, `/healthz`,
  `/readyz` and `/version`, pino logging with request ids, an error handler
  that classifies status, an LLM policy in `budget.ts`, the output rail moved
  inside the graph, the reseed path deleted, settings cached.
- One tool contract: `server/src/agent/contracts.ts` feeds the graph, the
  MCP server, the REST API and the generated OpenClaw skill file;
  `update_interests` proposes on every surface and `apply_interests` needs
  `confirmed: true`.
- Publishable: Apache-2.0 license and third-party notices, the admin gate,
  secrets validation, rate limits, placeholders in `wrangler.toml`, the
  `.agents` folder trimmed to what the code uses.
- The Langfuse seeding suite landed under `server/scripts/langfuse`, the
  migrations folder reconciled with the applied history.

## 2026-09-01

- Self-hosted Langfuse populated with real Grapevine data: dashboards,
  evaluators, datasets, experiments, annotation queues, alerts.
- One graph for every provider: the subscription CLIs run as a LangChain chat
  model inside the LangGraph; conversation memory moved to a durable
  Supabase-backed checkpointer with a recall node; idle conversations judge
  themselves on the local model.
- Evals and Guardrails merged into one Admin > Monitoring tab with a
  `conversation_evals` table and per-thread judge.

## 2026-08

- The multi-turn red team handed to PyRIT (29 Aug).
- Every guardrail decision recorded in `guardrail_scans`, with a calibration
  suite that measures whether the threshold is worth tuning (29 Aug).
- Real tooltips in Ask Grapevine; the migrations directory reconciled.
- Basemap lighting pinned to local time and "live now" made to agree with the
  map; schema.org markup read during discovery and near-duplicates stopped at
  the door; push extraction on arrival with real budgets per provider; venue
  lookups persisted in Postgres; the MCP server rebuilt on FastMCP 4 (2 Aug
  merge).

## 2026-07-22 to 2026-07-29

- Mapbox Places venue intelligence on the event panel: open now, step-free,
  busy times.
- The email worker's logic extracted into a testable library with a 33-case
  suite and hardened ingest.
- PWA manifest, headers and robots.txt; standalone privacy and terms pages.

## 2026-07-13 to 2026-07-18

- Apple Maps style calendar annotation for booked events.
- Generic image detection for scraped event images; retention refined with
  separate windows for one-off and recurring events; discovery rejection
  scoring; a periodic retention sweep.
- The Claude model and reasoning-effort picker with per-turn usage.

## 2026-07-12

- `discover_events` tool: the agent adds web-found events to the catalog.
- Basemap layer toggles, per-category Show/Only/Hide, conflict warnings, a
  near-me drive-time filter, rare-find alerts, venue and source muting.
- The god components split and the filter wiring shared; correctness fixes
  for badges, caches and effects; one scoring implementation for the digest
  and the client; guardrail parity and one contract across the three tool
  surfaces; ICS exports with a VTIMEZONE; the pipeline stopped losing and
  duplicating events; one recurrence engine with DST-correct expansion; one
  source of truth for domain types, the provider registry and LLM JSON
  parsing.

## 2026-07-11

- Untrusted URLs guarded against SSRF and `javascript:` XSS.
- OAuth 2.1 for the MCP server with Supabase Auth as the authorization server
  and a consent page.
- Event-driven inbox processing over Supabase Realtime.
- Verified web discovery, scheduled searches and Claude Desktop MCP support.
- Date quick filters, event sharing, a search-aware map and an empty-state
  reset.
- CLI LLM providers for extraction plus GitHub Copilot; leave-by departure
  alerts.

## 2026-07-05 to 2026-07-10

- LangGraph 1.4 `StateSchema`, `Overwrite` reset and node policies; the
  ask-grapevine diagram redesigned for the reworked graph.
- Sign-in migrated to Supabase Auth (Google and GitHub) with Vault-backed
  Calendar tokens.
- Web push reminders and the Sunday digest; event images; the reactions
  schema and the interest-learning loop.
- Per-user Ask Grapevine history; Grapevine tools over MCP and an OpenClaw
  skill; Ask Grapevine routed to subscription CLIs.
- The in-app Google Calendar popup (month, agenda, edit, invite).
- Guardrail rails: Llama Prompt Guard 2 and the persona output rail.
- Ask Grapevine: the LangGraph concierge with keyless web search.
- Recurring events; the data layer migrated from JSON files to Supabase
  Postgres; the San Diego farmers markets.
- The designed diagrams (how it works, ask grapevine, email worker, interest
  learning, guardrails) and the README reorganised for a public audience.

## 2026-07-02 to 2026-07-04

- Calendar sync (Google and Apple/ICS) and the admin inbox over KV.
- Basemap lighting synced to the time of day; the mobile dock; resizable
  carousel and filter rail; dark map controls.
- The account dialog with activity and ingest history; ingest history
  recorded server-side; the map rendered first with admin lazy-loaded.

## 2026-05-30 to 2026-06-28

- The web app built up: Vite, React, Tailwind and shadcn/ui; the 3D Mapbox
  map; event cards and detail with live travel ETA; top bar and filter rail;
  the carousel; interests onboarding; the admin sheet with models, sources
  and ingest tabs; the app shell wired together.
- The server built up: Express and TypeScript; domain types and a JSON-file
  store; the Ollama client for extraction and buzz scoring; Mapbox geocoding
  and travel-time helpers; the inbound newsletter ingest pipeline; the event
  catalog with filtering and ranking; Google OAuth login; seeds.
- The Cloudflare email-ingest worker.
- The monorepo initialised (30 May).
