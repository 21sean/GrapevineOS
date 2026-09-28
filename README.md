# Grapevine _Agentic Local-Events Platform_

[![ci](https://github.com/21sean/GrapevineOS/actions/workflows/ci.yml/badge.svg)](https://github.com/21sean/GrapevineOS/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-0b3b2e)](LICENSE)

A 3D map of San Diego events, built from free local newsletters and ranked by
how much locals talk about them. A local LLM parses the newsletters and rates
each event; a LangGraph agent answers questions about the map, plans days,
and sets up saved searches. It runs on a laptop and on free tiers, and by
default no data leaves the machine.

Setup, deployment and operations are in [docs/setup.md](docs/setup.md). The
agent's design is in [docs/agent-architecture.md](docs/agent-architecture.md).

## Quick start

You need a Supabase project, Ollama with one model, and a Mapbox account.
Everything else is optional.

1. **Accounts.** Create a free [Supabase](https://supabase.com) project and
   note its project URL, secret key and publishable key (Settings → API).
   Create a [Mapbox](https://account.mapbox.com) account with a public token
   (`pk.`) and a secret token (`sk.`).
2. **A model.** Install [Ollama](https://ollama.com) and pull a model that
   supports tool calls: `ollama pull qwen3:8b`. Without a GPU, skip this and
   pick a subscription CLI (Claude Code, Codex, Gemini or Copilot) under
   Admin → Providers once the app is running; each signs in with an account
   you already have.
3. **Clone and install.** One install covers the server, the web app and the
   worker.

   ```bash
   git clone https://github.com/21sean/GrapevineOS && cd GrapevineOS
   npm install
   ```

4. **Env files.**

   ```bash
   cp server/.env.example server/.env      # SUPABASE_URL, SUPABASE_SECRET_KEY, MAPBOX_SECRET_TOKEN
   cp web/.env.example web/.env.local      # VITE_MAPBOX_TOKEN, VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY
   ```

5. **Schema.** With the [Supabase CLI](https://supabase.com/docs/guides/local-development)
   signed in: `supabase link --project-ref <ref>`, then `supabase db push`.
6. **Check and run.**

   ```bash
   npm run doctor     # lists anything missing and how to fix it
   npm run dev        # api -> http://localhost:8787, web -> http://localhost:5174
   ```

7. **Add events.** A fresh database is empty. Paste a newsletter into
   Admin → Ingest or run a search in Admin → Discover, then press ⌘K and ask
   what's on tonight.

Optional pieces:

| Adds                                            | Needs                                                                         | Where                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Newsletters that arrive by themselves           | a Cloudflare zone with Email Routing and the worker deployed                  | [setup: the email worker](docs/setup.md#the-email-worker)                           |
| Sign-in, per-account history, calendar, watches | Google or GitHub enabled on the Supabase project                              | [setup: auth](docs/setup.md#auth-supabase-auth-google--github)                      |
| Google Calendar sync                            | an OAuth client with the Calendar API enabled                                 | [setup: auth](docs/setup.md#auth-supabase-auth-google--github)                      |
| Traces in Langfuse                              | Docker: `docker compose --profile observability up -d`, keys in `server/.env` | [setup: the optional stack](docs/setup.md#the-optional-stack)                       |
| More reliable web search                        | Docker: `docker compose --profile search up -d`, `SEARXNG_URL`                | [setup: the optional stack](docs/setup.md#the-optional-stack)                       |
| Claude Desktop or claude.ai as a client         | public HTTPS (a tunnel) and `MCP_PUBLIC_URL`                                  | [setup: MCP](docs/setup.md#mcp-for-claude-desktop--claudeai-custom-connector-oauth) |
| The prompt-injection classifier                 | nothing; about 280 MB downloads on the first chat, `GUARDRAILS=off` skips it  | [Guardrails](#guardrails)                                                           |
| Venue cards on the event panel                  | the `places:read` scope on the secret token                                   | [docs/mapbox-places.md](docs/mapbox-places.md)                                      |
| Push reminders and the Sunday digest            | nothing; VAPID keys are generated on first use                                | [App tour](#app-tour)                                                               |

## What it does

- **Newsletters to map.** Newsletters arrive by email, a Cloudflare Email
  Worker stores them in Postgres, and a local Ollama model extracts typed
  events, rates their local buzz from 1 to 5, and flags paid placements
  before they are geocoded.
- **Verified web discovery.** The server can also find events on the web,
  but a candidate only reaches the map after deterministic checks and a
  second LLM pass that confirms it against its source page with a quote.
  Searches run once or on a schedule.
- **A concierge agent.** "Ask Grapevine" (⌘K) is a LangGraph agent with
  typed state, Zod-validated tools, streamed output, per-thread memory in
  Postgres, and a confirmation card for anything that writes.
- **Guardrails in the graph.** Llama Prompt Guard 2 screens user messages
  and fetched web content as graph nodes, so a blocked turn shows up in a
  trace as a routing decision. A deterministic output filter stops the model
  from naming the vendor behind it.
- **One tool contract.** Each tool is declared once and used by the graph,
  the MCP server, the REST API and the generated OpenClaw skill file. CI
  fails if the generated copy is out of date.
- **Tests that need no GPU.** Unit tests cover graph routing, the
  checkpointer, the streaming bridge, the output filter and the contracts.
  Five offline eval suites run in CI; the model suites and a PyRIT red team
  run nightly on a GPU runner.
- **Venue details.** Mapbox Places (public preview) adds opening hours,
  step-free access, and an hourly busyness chart with the event's hours
  highlighted. Lookups are lazy and cached in Postgres by venue, so a bar
  shared by five events costs one lookup. See
  [docs/mapbox-places.md](docs/mapbox-places.md).
- **No paid APIs.** Email routing, workers, Postgres, geocoding (cached) and
  web search all run on free tiers or keyless.

## How it works

<p align="center">
  <img src="docs/images/how-it-works.png" width="900" alt="How Grapevine works, end to end: free local newsletters are emailed to a catch-all Cloudflare address; a Cloudflare Email Worker writes each one as an idempotent row to a deny-all Supabase Postgres database; the local Express server polls unprocessed rows, and a local Ollama model types the events, rates their buzz 1 to 5, and flags promos while Mapbox geocodes each venue (cached); the enriched events are written back to Postgres and served over HTTPS to a React and Mapbox GL client that renders a pitched 3D night map with a carousel, filters, and the Ask Grapevine concierge.">
</p>

### Sources

1. **Cloudflare Email Routing is free.** Turn on catch-all for your domain
   and every address at it delivers, with no per-address setup.
2. **Subscribe to each newsletter with its own address**
   (`sdtoday@yourdomain.com`, `axios-sandiego@yourdomain.com`, and so on).
   The `To:` header becomes the source tag, which gives attribution and
   deduplication at the inbox.
3. **Event digests parse best**: SDtoday (6AM City), Axios San Diego, San
   Diego Reader, Voice of San Diego's Culture Report, PACIFIC, Parks & Rec
   newsletters, and neighborhood association emails.
4. **The local model does the rest**: extraction into typed JSON, venue
   geocoding (Mapbox, cached), a 1 to 5 buzz rating, and a `promoted` flag
   for paid placements.

Each newsletter lands as one idempotent Postgres row. The server listens on
Supabase Realtime and extracts on arrival; the subscription is an outbound
websocket, so it works from a laptop behind NAT. If an insert fails, the
worker saves the raw email to KV and an hourly cron retries it until it
lands.

<p align="center">
  <img src="docs/images/email-worker.png" width="900" alt="Email ingestion pipeline: newsletters sent to a catch-all address hit Cloudflare Email Routing, then a Cloudflare Email Worker parses each message (the To: line becomes the source tag) and writes one idempotent row to the Supabase raw_emails table, which the local server polls for unprocessed rows. If the insert fails the worker dead-letters the raw email to a Cloudflare KV store with a 30-day TTL; an optional push mode can POST straight to the API for instant processing.">
</p>

You can also paste a newsletter into **Admin → Ingest**, preview what the
model extracted, and choose which events to keep.

### Web discovery

**Admin → Discover** (also the `discover_events` MCP tool and
`POST /api/ext/v1/discovery/run`) adds events from the open web:

1. **Search** via SearXNG or the keyless DuckDuckGo fallback (the city is
   appended to the query), then **read** the top pages through the same
   Readability and SSRF-guard pipeline the agent uses.
2. **Extract** candidates one page at a time, so each candidate is tied to
   one URL.
3. **Verify** before writing anything:
   - deterministic checks: dates parse, are not in the past or implausibly
     far out, and the title appears in the page text;
   - a second LLM pass re-reads the page and must **confirm** the event
     (date, venue, and a supporting quote), **correct** a detail, or mark it
     **unsupported**;
   - candidates found on two or more independent pages need confidence 0.5;
     everything else needs `DISCOVERY_MIN_CONFIDENCE` (default 0.7).
4. **Commit**: verified events are saved with `sourceKind: "search"` and the
   `sourceUrl` they were checked against. Rejected candidates are reported
   with a reason and never written. Every run is logged in ingest history.

Saved searches re-run every 1 hour to 2 weeks. Set them up in Admin →
Discover, over MCP (`schedule_search`), through the REST API, or as a
personal **watch** from the chat ("keep an eye out for jazz nights"). Watches
are capped at five per account and managed under Account → Watches.

## Ask Grapevine

Press **⌘K** (or the "Ask Grapevine" button in the top bar) and ask things
like _"what's good tonight?"_, _"plan my Saturday"_, _"can I make the
farmers market by 9?"_ or _"I hate EDM"_. By default it runs on the same
Ollama model as ingestion; pick a model that supports tool calls, such as
`qwen3`, in Admin → Models.

- **Grounded in the event list.** Answers draw on a digest of current
  events, and event listings only come from that digest.
- **Drives the map.** Recommended events are highlighted and the camera fits
  them, even when current filters would hide them.
- **Tools**: event search, traffic-aware ETAs, day plans with a
  save-to-calendar card, watches, and interest changes. Calendar saves,
  watches and interest changes are always proposed as cards you confirm,
  with Undo.
- **Transparent.** A popover next to the composer shows which provider is
  answering, which tools it has, whether the guardrails are on, and the MCP
  endpoint (`GET /api/agent/capabilities` returns the same thing).

**Admin → Providers** can hand chat, newsletter extraction, or both to a
subscription CLI instead: Claude Code (`claude -p`), OpenAI Codex, Gemini
CLI, or GitHub Copilot CLI. Each uses the account it is signed in with, so
the server holds no API keys. Claude Code also connects back to Grapevine's
MCP endpoint for live event search and ETAs. Account → Claude has the
connector URL and two prompts for running a routine from your own Claude
account.

### Agent architecture

The agent is a LangGraph `StateGraph` with the guardrails as nodes.
`ChatOllama` is the default model; Admin → Providers can swap in a
subscription CLI wrapped as a LangChain chat model without changing the
graph. [docs/agent-architecture.md](docs/agent-architecture.md) has the full
walkthrough and the steps for adding a tool.

<p align="center">
  <img src="docs/images/ask-grapevine.png" width="900" alt="The Ask Grapevine agent as a LangGraph state graph with its guardrails as nodes: a user message (Cmd-K) enters the input rail (Llama Prompt Guard 2), which ends a blocked turn before it touches memory; a clean turn passes recall, which folds turns beyond the 24-message window into a running summary, then the agent node, the chat model with the toolbox bound (ChatOllama by default, or CliChatModel wrapping Claude Code, Codex, Gemini or Copilot) and a system prompt rebuilt each turn; tool calls run in the tools node and their results pass the content rail before the agent reads them, while the typed toolRounds counter is under six, after which a finalize node answers with no tools; every model call streams through the deterministic persona rail inside invokeModel; state (messages, toolRounds, summary) is checkpointed by the durable SupabaseSaver in Postgres keyed by thread id, so threads survive restarts; and the same executors serve the MCP server and the REST API through one contract table.">
</p>

- **Typed graph state** (LangGraph `StateSchema`, Zod 4): the transcript
  plus a `toolRounds` counter that the tools node increments and each user
  turn resets. After six tool rounds a `finalize` node answers without
  tools, so a looping model stops.
- **Guardrails as nodes.** The input rail classifies the user's turn and
  ends a blocked one before it is stored. The content rail scans every tool
  result before the model reads it, which covers new tools automatically.
  The output filter wraps every model call. The classifier rails fail open
  and log it; the output filter fails closed.
- **Retries only where safe.** Model nodes retry connection failures, which
  happen before the first token, and give up on stalled generations after an
  idle timeout. The tools node never retries, since a rerun would repeat UI
  actions.
- **Durable memory.** A Supabase-backed LangGraph checkpointer (over
  PostgREST, keyed by `thread_id`) stores each thread, so the browser only
  sends the new message and threads survive restarts. The user's turn only
  enters the checkpointer after the input rail passes it. A `recall` node
  folds turns beyond the history window into a running summary.
- **One graph for every provider.** The subscription CLIs run as a LangChain
  chat model inside the same graph and get the same guardrails, memory and
  traces as Ollama.
- **Tools from one contract table**, in two kinds: data tools run on the
  server; UI tools emit action frames that the browser renders as map pins
  and confirmation cards. Every write is proposed first, on every surface.
- **Keyless web search**: a self-hosted SearXNG instance when configured,
  otherwise DuckDuckGo. Pages are read with Mozilla's Readability behind an
  SSRF guard. Web facts are shown as citation links.
- **Streaming bridge.** `graph.stream()` is translated into an NDJSON
  protocol (token deltas, tool status, actions, guardrail verdicts, usage).
  The frame types live in `shared/types.ts`, so an unhandled frame is a
  compile error.
- **Failure handling.** Ollama being down or having no model shows a notice
  instead of a 500. A 120s deadline and client-disconnect abort stop a
  closed tab from keeping the GPU busy. On SIGTERM the server stops its
  loops, tells open chat tabs to retry, and exits within a time limit.
- **Observability.** Langfuse (v5 SDK over OTEL), with a self-hosted v4
  stack under `docker/observability/langfuse`
  (`docker compose --profile observability up -d`; UI on localhost:3000).
  Chat turns become traces grouped by thread, guardrail nodes appear as
  spans, and guardrail decisions and conversation-eval verdicts are recorded
  as scores. Emails and phone numbers are scrubbed from exported text.
  Without keys nothing is initialized or sent.
- **Conversation grading.** A background job grades idle chat threads
  (helpfulness, groundedness, persona) on the local judge model, one thread
  per tick so chat keeps priority on the GPU. Results appear in
  Admin → Monitoring and in Langfuse.

### Guardrails

Local open-weights models are easy to talk out of character; ours once
answered _"I am Qwen, a large language model developed by Alibaba..."_ after
a few tries. Grapevine wraps the model in small, fast checks that run
in-process on CPU.

[![classifier: Llama Prompt Guard 2 (86M)](https://img.shields.io/badge/classifier-Llama_Prompt_Guard_2_·_86M-7b1e3c)](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
[![runtime: Transformers.js (ONNX)](https://img.shields.io/badge/runtime-Transformers.js_·_ONNX-1f2937)](https://github.com/huggingface/transformers.js)
&nbsp;![local · no paid APIs](https://img.shields.io/badge/local-no_paid_APIs-0b3b2e)

<p align="center">
  <img src="docs/images/guardrails.png" width="900" alt="Guardrails, defense in depth: a user message passes an input rail (Llama Prompt Guard 2, 86M ONNX) that blocks on malicious ≥ 0.80 before either engine runs; benign messages enter the engine, a LangGraph agent on Ollama or a CLI provider (Claude Code, Codex, Gemini, Copilot), with the same rails bracketing both paths; a content rail re-checks the agent's search_web and read_page text and withholds indirect-injection hits (web discovery has its own verify gate); a deterministic output persona guard, keyed to the active model or CLI provider, replaces identity leaks before the reply reaches the browser. Every rail fails safe.">
</p>

| Layer                | Catches                                                                                                             | Engine                                                                                         | Latency         | On failure                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------- |
| **Input rail**       | Jailbreaks and prompt injection in the user's message, blocked before the graph so they never enter thread history  | [Llama Prompt Guard 2](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M) (86M, ONNX) | ~15 to 90 ms    | **open**: a failed download logs once and chat works |
| **Content rail**     | Injection hidden in fetched pages and search snippets, before it reaches the model                                  | same classifier                                                                                | ~15 ms / window | **open**                                             |
| **Output filter**    | The model naming its vendor (_"I am Qwen..."_) or disclosing its system prompt, replaced with an in-character reply | deterministic regex with a streaming hold-back                                                 | ~0              | **closed**: always on, even with the classifier off  |
| **Prompt hardening** | Keeps the model in character under social pressure                                                                  | pinned system prompt                                                                           | n/a             | n/a                                                  |

- **Tool results are screened too.** A web page or event listing that tells
  the model to "ignore your instructions" is caught as content, not only as
  a user message.
- **The output filter is deterministic** because the failure that matters
  most, the model naming its vendor, should never get through. It holds back
  64 characters of the stream so a leak split across chunks is still
  caught, and it is keyed to the active model or CLI provider.
- **Every decision is recorded** in `guardrail_scans` and shown in
  Admin → Monitoring. The measured scores are bimodal with a gap in the
  middle, which is why the 0.8 threshold stays where it is: more test
  coverage helps more than tuning it.

A red-team smoke test, including the persona break above, ships with the
repo (the first run downloads the classifier):

```bash
npm run guardrails:eval -w server
```

## Interest learning

Each reaction to an event ("going", "went", "not for me") reweights that
event's tags, so ranking learns from behavior using the events' own tags,
not only the 26-topic interest picker. The score feeds every list, and what
those lists show shapes the next reaction.

<p align="center">
  <img src="docs/images/interest-learning.png" width="900" alt="Interest-learning feedback loop: a user's picks and one-tap reactions feed taste signals; reactions reweight open-vocabulary tag affinities; a per-event personal score (buzz backbone plus loves match, tag affinity, and this-event reaction, with avoids excluded) ranks every surface (map, list, your week, and the Sunday push), and what those surfaces show shapes the next tap. Ask Grapevine can propose interest changes for the user to confirm.">
</p>

- **Reactions are typed.** "Going" is intent (+3 on the event), "went" is
  the strongest taste signal (1.5x on its tags), and "not for me" both sinks
  the event (-8) and counts against its tags (-1.5x).
- **Learned weights are capped** at +/-3, the same as explicit loves, so
  reactions adjust the buzz rating rather than replace it.
- **Ranking is client-side and immediate.** Reactions are stored per
  account in Postgres (deny-all RLS) and mirrored into the server-side
  scorer that writes the Sunday push.
- **The event panel shows why.** "Why it's ranked here" lists the parts of
  the score that moved the event (loves, avoids, rarity, timing, reactions,
  learned taste), computed by the same function that ranks the list.

## Agent interoperability (MCP and REST)

The executors behind the in-app agent are also available to external
assistants, from the contract table in `server/src/agent/contracts.ts`:

- **MCP server**: [FastMCP 4](https://github.com/punkpeye/fastmcp) over
  Streamable HTTP at `POST /mcp`, stateless, so it survives server restarts.
  Tool arguments are validated with Zod. Claude Code, Claude Desktop or any
  MCP client can search events, get details and ETAs, save to the calendar,
  change interests, run verified web discovery (`discover_events`), and
  manage scheduled searches. Auth is **OAuth 2.1 with Supabase Auth as the
  authorization server**: the endpoint serves RFC 9728 protected-resource
  metadata, answers unauthenticated calls with a `WWW-Authenticate`
  challenge, supports dynamic client registration and the PKCE code flow
  through the app's `/oauth/consent` page, and verifies every access token
  as a Supabase JWT against the project JWKS. To add a **Claude Desktop or
  claude.ai custom connector**, expose the server over HTTPS (a tunnel and
  `MCP_PUBLIC_URL`), paste `https://your-host/mcp` under Settings →
  Connectors, sign in and approve. Each client acts as the account it signed
  in with; scripts can send `AGENT_API_KEY` as an `X-Agent-Key` header.
  Snippets are in **Admin → Providers** and **Account → Claude**.
- **REST API** at `/api/ext/v1/*`, authenticated with an `X-Agent-Key`
  header: event search and detail, ETAs, calendar read and write, interests,
  and web discovery (run now or scheduled). The [OpenClaw](https://openclaw.ai)
  skill describing it is generated from the contracts into
  `server/openclaw/skills/grapevine/SKILL.md`; install it by copying that
  folder into `~/.openclaw/skills/`.

Writes need confirmation on every surface: `update_interests` proposes,
`apply_interests` refuses without `confirmed: true`, and discovery is a dry
run unless told otherwise.

## Testing

- **`npm test`** runs the unit tests for the server, the web app and the
  worker with no model and no database: graph routing and the tool budget,
  the checkpointer against an in-memory PostgREST fake, the NDJSON bridge
  with a faked graph (including a client disconnect mid-answer), the output
  filter across chunk boundaries, the tool contracts, the ranking, and the
  frame reducer.
- **CI** runs typecheck, lint, prettier, the tests, the contract check and
  the five offline eval suites on every push, and uploads the eval report.
  The model suites, classifier fixtures and PyRIT red team run nightly on a
  self-hosted GPU runner once the `GPU_RUNNER` repository variable is set.
- **`npm run doctor`** reports what a fresh clone is missing. The server
  answers `/healthz`, `/readyz` and `/version` so a supervisor can tell
  starting from broken.

## App tour

- **Map**: Mapbox Standard style, pitched 3D, with lighting that follows the
  local time. Live events pulse gold; markers are colored by category.
  Traffic and basemap layers toggle from the map layers control.
- **Live tour**: flies between the top live events (or today's upcoming
  ones when nothing is live), 9s per stop, with pause, step and click
  through.
- **Feed and filters**: live only, rare finds (parades, races, one-offs),
  hide promoted (on by default), minimum buzz, category pills, date chips,
  and a near-me drive-time filter. Sorted by a personal score built from
  buzz, interests, timing and reactions, minus a penalty for promotions.
- **Interests**: "more like this" boosts matching events; "less of this"
  sinks them to the bottom.
- **Event detail**: buzz stars with the model's rationale ("Re-check buzz"
  runs it again), why the event is ranked where it is, tags you can tap to
  search, traffic-aware drive time, directions, conflicts with your
  calendar, and the ticket link when advance tickets are needed.
- **Ask Grapevine**: the ⌘K chat that searches, pins the map, plans days,
  sets watches and learns your taste.
- **Leave-by alerts**: mark "going" (or save to calendar) with notifications
  on and Grapevine sends _"Leave by 6:38"_ at the right minute, using drive
  time from your last coarse position plus a parking buffer. Reminders and
  the Sunday digest use the same Web Push channel.
- **Account → Watches and Claude**: your scheduled searches (cadence, last
  run, pause, delete) and the MCP connector URL with two routine prompts.
- **Admin → Models**: Ollama health, the active model, and a catalog of
  open-weights models grouped by lab (models.dev metadata and logos) with
  download progress.
- **Admin → Providers**: choose who answers chat and who runs extraction,
  plus MCP snippets for Claude.
- **Admin → Ingest**: paste a newsletter, preview the extracted events, and
  approve which ones to keep.
- **Admin → Discover**: search the web for events, review what verification
  confirmed (with quotes) or rejected (with reasons), approve, and save
  searches to re-run on a schedule.
- **Admin → Sources**: the per-source inbox addresses.
- **Admin → Monitoring**: guardrail scans (score distribution and a review
  queue), eval suites and their history, graded conversations, and summary
  counters.

## Layout

```
web/       Vite + React 19 + TS + Tailwind v4 + shadcn/ui (dark only)
           src/components/chat (composer, cards, capabilities), admin/
           (tabs; monitoring/ by section), account/, calendar/, map/
           src/lib/chatReducer.ts (the frame reducer), score.ts · test/
server/    Express 5 + tsx · supabase-js data layer (src/store.ts)
           LangGraph agent (src/agent/: graph, contracts, tools, NDJSON
           bridge, CLI model, guardrails) · durable checkpointer
           (src/checkpointer.ts) · MCP server (src/mcp.ts)
           routes/ (one router per surface) · lifecycle, health, logging
           eval runner and suites (src/evals/, scripts/evals.ts) · test/
           openclaw/ (generated skill for the external agent API)
shared/    logic both tiers need: types and the frame protocol,
           recurrence, opening hours, tag affinity, timezone day math
workers/   email-ingest Cloudflare Email Worker → Supabase raw_emails
supabase/  tracked SQL migrations
docker/    vendored Langfuse stack and SearXNG settings
scripts/   doctor.mjs
docs/      setup.md, agent-architecture.md, mapbox-places.md, images/
.github/   ci.yml (every push), nightly.yml (model suites), dependabot,
           contributing, security, code of conduct, issue forms, PR template
.agents/   the Mapbox and Supabase agent skills the code uses
```

[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) covers the workspace
scripts, the eval tiers and the migration rule;
[.github/SECURITY.md](.github/SECURITY.md) describes the trust boundaries and
how to report a problem; the [code of conduct](.github/CODE_OF_CONDUCT.md)
applies to all project spaces; [docs/CHANGELOG.md](docs/CHANGELOG.md) is
generated from the commit history. Licensed under Apache-2.0.
