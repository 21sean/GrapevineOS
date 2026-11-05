# Changelog

Release notes and earlier development history, newest first. Tagged releases
are listed on [GitHub](https://github.com/21sean/GrapevineOS/releases).

## Unreleased

- Redraw the agent and guardrail diagrams with the contract gate and write gate and without
  the hosted CLI path, and rewrite the guides to match: chat and extraction generate only
  on the local runtime, and the model nodes have an idle timeout but no retry policy.
- Fix over-deflection caused by the prompt work below. It lowered utility under attack in the
  injection suite from 94.4% to 69.4%, because ordinary event questions got "I'm Grapevine" in
  place of an answer, one of them with nothing injected. The attack success rate was 0 of 108
  before and after, so the hardening did not lower it. A tool result had become the last thing
  the model read, the full event JSON had left the prompt to fix the overflow, and the identity
  line was an easy way out. The person's question now comes last after a tool result, and that
  line applies only to what the person typed.
  Utility under attack is back to 95.4%, level with where it started, and the live gate now
  fails if the concierge deflects these questions again.
- Measured results, with limits in `docs/readme-review.md` and `llm/README.md`: indirect
  injection ASR 0 of 108 (0.0%, 95% CI 0.0% to 3.4%), utility under attack 103 of 108 (95.4%, 95% CI 89.6% to 98.0%);
  multi-turn red team 0 of 7 (0.0%, 95% CI 0.0% to 35.4%), a small sample; warm no-tool turns on Ollama at p99 model
  TTFT 337 ms and visible TTFT 703 ms on a 10575 token prompt, measured against MLPerf's
  interactive latency limits: model TTFT and TPOT inside them, visible TTFT outside.
- Fix tool use on Ollama. Instructor sent an empty assistant turn as an empty list and
  Ollama answered 400, so since v0.7.0 every chat turn that used a tool failed on its
  second generation. The live quality gate now runs a whole tool round and blocks merges.
- Fit the prompt to the context on a real catalog. It ran about 39,600 tokens against a
  16,384 context on a 120-event catalog, and the runtime silently dropped 79% of it. The
  model now reads the digest and calls `get_event` for details, and a budget drops the
  oldest conversation first.
- Stream agent answers through the persona filter as they generate, validate the whole
  answer at the end, and retract it with a fallback if it fails. Tool calls, extraction,
  discovery and every other action still validate before anything acts on them.
- Add a write gate: a chat tool call that writes is checked against what the person
  typed, and a call that fails the check becomes a confirmation card. `set_rarity` is now
  always a card, and confirming it is an admin write.
- Label tool results as data in the transcript, tell the model who can ask it for things,
  answer in character when the gate rejects every attempt, and catch refusals that
  describe what they withhold.
- Run the PyRIT red team for the first time: fix its result mapping, a crash on a gate
  failure, a case budget that failed long runs, an undetermined verdict that counted as a
  pass, and a scorer that did not ask about role abandonment. Add a model tag so the
  attacker, judge and agent share one runner, `REDTEAM_CONCURRENCY`, saved transcripts, and
  `npm run redteam:report` with Wilson intervals.
- Add an indirect prompt injection suite scored the way AgentDojo scores it: whether the
  target tool call happened, and whether the person's task still got done. No LLM judge,
  no real data.
- Record time to first token and time per output token per generation, with cached prompt
  tokens, in the spans, the usage frame and Langfuse. Add `npm run bench:ttft`.
- Keep the gate worker warm, reuse one HTTP client, generate against a schema holding only
  the enabled tools, order the prompt by how often each part changes, keep the model loaded
  for 30 minutes, and send a smaller batch so a new question re-evaluates less.
- Stop rerunning `model-quality` on the push to main. Strict PR checks already tested the
  merged tree, and the rerun only collided with other work on the GPU.
- Add vLLM 0.33.0 as a runtime option beside Ollama, selected with
  `GRAPEVINE_LLM_RUNTIME=vllm`. Ollama stays the default, and its manifest and
  baseline are unchanged.
- Generate through vLLM's OpenAI-compatible endpoint with JSON Schema constrained
  decoding and the same contract gates. Chat, health, capabilities, the judge, and
  `npm run doctor` follow the active runtime.
- Pin the runtime, repository, revision, and weight hash in `llm/evals/models.vllm.json`.
- Record serving numbers measured against MLPerf's interactive latency limits in
  `llm/README.md`.

## v0.7.0: structured output gates and offline evals (2026-10-23)

- Validate extraction, discovery, summaries, agent answers, and tool requests
  with strict versioned Pydantic contracts before downstream processing.
- Generate with Ollama's JSON Schema constraint, repair with bounded validation
  feedback, and fail closed with typed errors. Hosted CLI generation is disabled;
  agent text is released only after complete-answer validation.
- Export immutable language-independent JSON Schemas and generated TypeScript
  validators. Add property tests and a real Node/Python worker integration test.
- Keep OpenTelemetry, local judges, and reviewed feedback on the local machine.
  Record first-pass, retry, hard-failure, model, and gating latency metrics.
- Require schema and quality CI checks: 30 replay cases, 15 pinned live cases,
  deterministic checks before local DeepEval judges, and Ragas retrieval snapshots.
- Fingerprint eval artifacts and reject regressions against both committed and
  PR-base baselines. Document offline setup, sample promotion, and human calibration.

## v0.6.0: smoother maps and a clearer interface (2026-09-30)

- Render ordinary event annotations in the Mapbox canvas and reserve detailed
  HTML markers for inspection. Share matching pin sprites and skip unchanged
  source updates while preserving 3D buildings and their display distance.
- Reuse event timing calculations and concurrent venue ETA requests, bound the
  ETA cache, and skip unnecessary rendering of offscreen event cards.
- Keep navigation and reaction controls accessible on narrow screens. Position
  the event tour beside the desktop rail, keep expanded filters scrollable,
  and improve mobile detail readability.
- Restore the mobile dock and tour after cancelled gestures. Add keyboard
  resizing for the event list, tour, and detail panels, plus larger map-layer
  touch targets.
- Handle account and calendar refresh failures, and provide clearer loading
  recovery instructions.
- Restrict monitoring RPCs to the service role, validate fetched addresses
  against private network targets, and tighten calendar and discovery input
  validation.
- Refresh compatible dependencies, including Mapbox GL 3.32.0, update GitHub
  Actions, and include the production build in CI.
- Reorganize the README around real UI screenshots, a quick start, and linked
  documentation. Add a close 3D view of downtown San Diego and community concert
  screenshots for the phone layout.

Validation: 130 tests, 67 offline evaluation cases, type checks, production
build, formatting, and contract checks passed. Desktop and mobile browser
checks found no console errors. The dependency audit reports no vulnerabilities.

Upgrading from v0.5.0: review the tracked migration history and apply pending
Supabase migrations, including `20260928234500_lock_down_monitor_rpcs.sql`.
Follow the [setup guide](setup.md) and the
[migration workflow](../.github/CONTRIBUTING.md#database-migrations) before applying
changes to an existing database. A fresh clone needs the full schema applied.

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
