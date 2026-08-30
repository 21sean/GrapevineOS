# Grapevine *Agentic Local-Events Platform*

A live 3D map of the San Diego events locals actually go to. Free local
newsletters are the data source, a local LLM is the parser and critic, and the
map only surfaces what has real buzz. Everything runs locally and on free
tiers, so nothing leaves your machine by default.

Setup, deployment, and operations live in [docs/setup.md](docs/setup.md).

## Highlights

- **Newsletter-to-map pipeline.** Local newsletters arrive by email, a
  Cloudflare Email Worker lands them in Postgres, and a local Ollama model
  extracts typed events, rates their "local buzz" 1 to 5, and flags
  pay-to-play placements before they are geocoded onto the map.
- **Verified web discovery.** The server can also build events from an AI
  web search - keyless search, page reads, LLM extraction - but nothing
  reaches the map without passing a verification gate: deterministic checks
  plus a skeptical second LLM pass that must confirm each candidate against
  its source page (with a supporting quote) or reject it with a reason.
  Searches can run once or on a saved schedule.
- **A guarded concierge agent.** "Ask Grapevine" (hit ⌘K) is a LangGraph
  agent with typed graph state, Zod-validated tools, streaming token output,
  and human-in-the-loop confirmation for anything that writes.
- **Defense-in-depth guardrails.** Meta's Llama Prompt Guard 2 classifier
  screens user messages and all fetched web content for prompt injection,
  and a deterministic output rail makes model-identity leaks impossible
  rather than merely improbable.
- **Agent interoperability.** The same tools are exposed three ways: inside
  the app, over an authenticated external REST API, and as an MCP server
  that Claude Code, Claude Desktop, or any MCP client can drive directly.
- **Venue intelligence on the event panel.** Mapbox Places (public preview)
  fills in what the listing never tells you: whether the place is open right
  now, whether the door is step-free, whether it is known with locals, and
  an hourly busyness chart with the event's own hours lit up, so the answer
  is "what am I walking into at 8pm" rather than a generic POI card. Lookups
  are lazy and cached in Postgres by venue id, so a bar shared by five events
  is fetched once and the preview quota lasts. See
  [docs/mapbox-places.md](docs/mapbox-places.md).
- **Free end to end.** No paid APIs anywhere in the loop: free email
  routing, free workers, free-tier Postgres, cached geocoding, and
  keyless web search.

## How it works

Newsletters come in by email, land in Postgres, get enriched by a local model,
and surface on a 3D map. No paid APIs, no inbound tunnel, nothing leaves your
machine by default.

<p align="center">
  <img src="docs/images/how-it-works.png" width="900" alt="How Grapevine works, end to end: free local newsletters are emailed to a catch-all Cloudflare address; a Cloudflare Email Worker writes each one as an idempotent row to a deny-all Supabase Postgres database; the local Express server polls unprocessed rows, and a local Ollama model types the events, rates their buzz 1 to 5, and flags promos while Mapbox geocodes each venue (cached); the enriched events are written back to Postgres and served over HTTPS to a React and Mapbox GL client that renders a pitched 3D night map with a carousel, filters, and the Ask Grapevine concierge.">
</p>

### The data-source playbook (no paid APIs)

1. **Cloudflare Email Routing is free and unlimited.** Enable catch-all on
   your domain and every address at it just works, with no per-address setup.
2. **Subscribe to each newsletter with its own address**
   (`sdtoday@yourdomain.com`, `axios-sandiego@yourdomain.com`, and so on).
   The `To:` header becomes the source tag, which gives you attribution and
   dedup for free, at the inbox layer.
3. **The richest sources are pure event digests**: SDtoday (6AM City), Axios
   San Diego, San Diego Reader, Voice of San Diego's Culture Report, PACIFIC,
   Parks & Rec newsletters, and neighborhood association blasts. They are
   written to be skimmed, so they parse cleanly.
4. **A local Ollama model does the rest**: extraction into typed JSON, venue
   geocoding (Mapbox, cached), a jaded-local 1 to 5 buzz rating, and a
   `promoted` flag for pay-to-play placements. Nothing leaves your machine.

The inbox is the pipeline. Each newsletter lands as one idempotent Postgres
row, and the server hears about it over Supabase Realtime and extracts on
arrival. That subscription is an outbound websocket, so it works from a laptop
behind NAT with nothing exposed to the internet. If an insert ever fails, the
worker dead-letters the raw email to KV and retries it on an hourly cron until
it lands, so an outage costs latency rather than the email:

<p align="center">
  <img src="docs/images/email-worker.png" width="900" alt="Email ingestion pipeline: newsletters sent to a catch-all address hit Cloudflare Email Routing, then a Cloudflare Email Worker parses each message (the To: line becomes the source tag) and writes one idempotent row to the Supabase raw_emails table, which the local server polls for unprocessed rows. If the insert fails the worker dead-letters the raw email to a Cloudflare KV store with a 30-day TTL; an optional push mode can POST straight to the API for instant processing.">
</p>

You can also paste any newsletter into **Admin -> Ingest** at any time. Same
pipeline, manual entry.

### Web discovery (search -> verify -> map)

Newsletters are the spine, but they miss things. **Admin -> Discover** (and the
`discover_events` MCP tool, and `POST /api/ext/v1/discovery/run`) tops the map
up from the open web without trusting the model's first draft:

1. **Search** the query (city appended automatically) via SearXNG or the
   keyless DuckDuckGo fallback, then **read** the top result pages through the
   same Readability + SSRF-guard pipeline the agent uses.
2. **Extract** candidates one page at a time, so every candidate stays
   attributable to exactly one URL.
3. **Verify** before anything is written:
   - deterministic gates - parseable dates, not in the past, not absurdly far
     out, and the title must literally appear in the page text (a cheap
     hallucination check);
   - a second, skeptical LLM pass re-reads the page and must **confirm** the
     event (date, venue, plus a supporting quote), **correct** a detail from
     the page, or call it **unsupported**;
   - candidates corroborated by two or more independent pages clear a lower
     confidence bar; everything else needs `DISCOVERY_MIN_CONFIDENCE`
     (default 0.7).
4. **Commit**: verified events land with `sourceKind: "search"` and the
   `sourceUrl` they were verified against; rejected candidates are reported
   with their reason but never written. Every run is logged in ingest history.

Saved searches re-run on a cadence (1 hour to 2 weeks) via a scheduler in the
server - set them up in Admin -> Discover, over MCP (`schedule_search`), or
via the external REST API.

## Ask Grapevine (the agent)

Hit **⌘K** (or the "Ask Grapevine" pill in the top bar) and talk to the map:
*"what's good tonight?"*, *"plan my Saturday"*, *"can I make it to the farmers
market by 9?"*, *"I hate EDM"*. The concierge runs on the same local Ollama
model as ingestion (pick a tools-capable one like `qwen3` in Admin -> Models):

- **Grounded**: every answer draws on a digest of the live event set, so it
  can't invent events.
- **Drives the map**: recommended events pulse wine-colored and the camera
  fits them, even ones your current filters would hide.
- **Tools**: structured event search, traffic-aware ETAs, day-planning with a
  one-tap save-to-calendar card, and interest tuning. Calendar saves and
  interest changes are always proposed as cards you confirm (with Undo); the
  agent never mutates anything silently.
- **Guarded**: a local classifier screens every message and all web content
  for prompt injection, and a deterministic persona rail stops the model from
  ever breaking character or leaking which LLM powers it (see below).

No GPU, or just prefer a frontier model? **Admin -> Providers** can hand
either job - chat, newsletter extraction, or both - to a subscription-authed
CLI instead: Claude Code (`claude -p`), OpenAI Codex, Gemini CLI, or GitHub
Copilot CLI. Each signs in with the account you already have (Claude.ai,
ChatGPT, Google, GitHub), so no API keys ever touch the server; Claude Code
even connects back to Grapevine's own MCP endpoint for live event search and
ETAs mid-chat.

### Agent architecture (LangGraph + LangChain)

The concierge is a LangGraph `StateGraph`. `ChatOllama` drives it by default,
and Admin -> Providers can swap a subscription CLI in for chat without touching
the graph.

<p align="center">
  <img src="docs/images/ask-grapevine.png" width="900" alt="The Ask Grapevine agent as a LangGraph state machine: a user message (Cmd-K) enters the agent node, the chat engine with tools bound (Ollama by default) and a system prompt rebuilt each turn; if the model emits tool_calls they run in the tools node (data tools like search_events and read_page run server-side, UI tools show_on_map, set_filters, propose_calendar, save_calendar, set_rarity, and update_interests emit confirm cards) and results return to the agent while the typed toolRounds counter is under six; if the model emits no tool_calls the reply streams to the browser; once the budget is spent a finalize node answers with no tools so the loop can never spin forever. Graph state is a Zod 4 StateSchema (messages plus a toolRounds ReducedValue an Overwrite zeroes each turn) checkpointed by an ephemeral MemorySaver keyed by thread id; model nodes retry connection failures (safe before the first token) and idle-out stalled generations at 45s, while the tools node never retries so UI frames stream exactly once. Beyond the loop: chat can route to a subscription CLI (Claude Code, Codex, Gemini, or Copilot), one-shot and digest-grounded with no API keys; Claude Code hooks back into Grapevine's own /mcp endpoint to keep event search, ETAs, and calendar saves; and external agents drive the same core over REST (the installable OpenClaw skill) and MCP (Claude Code and Claude Desktop).">
</p>

- **Typed graph state** (LangGraph `StateSchema`, plain Zod 4): the transcript
  plus a `toolRounds` counter channel the tools node increments; each user turn
  resets it with an `Overwrite`, so routing reads typed state instead of
  re-scanning history. A `finalize` node answers without tools once the
  six-round budget is spent, so a looping model can't spin forever.
- **Node policies only where retries are safe**: the model nodes retry
  connection failures (they happen before the first streamed token, so a retry
  can't duplicate output) and fail fast on stalled generations via an idle
  timeout that healthy token streams keep refreshing. The tools node never
  retries; re-running it would re-emit UI action frames.
- **Conversation memory is a LangGraph checkpointer** (`MemorySaver`, keyed by
  `thread_id`): the browser sends only the new message and the graph replays
  the rest. Threads are ephemeral; calendars and interests persist in Postgres.
- **Zod-validated tools** in two kinds: data tools execute server-side; UI
  tools emit action frames the browser renders as map pins and confirm-cards.
  Human-in-the-loop for anything that writes.
- **Keyless web search**: prefers a self-hosted SearXNG instance when
  configured, otherwise scrapes DuckDuckGo in-process; page reads are distilled
  with Mozilla's Readability behind an SSRF guard. Web facts render as citation
  links; events stay digest-only so the agent can't invent listings.
- **Streaming bridge**: `graph.stream()` is translated frame-by-frame into an
  NDJSON protocol the client renders (token deltas, tool status, actions). The
  UI doesn't know or care what engine is behind it.
- **Graceful degradation**: Ollama-down and no-model become friendly notices,
  not 500s; a 120s deadline and client-disconnect abort keep a closed tab from
  leaving the GPU generating.
- **One domain layer**, framework-free, powers the graph tools, the external
  REST API, and the MCP server alike.
- **Observability**: optional LangSmith tracing and Langfuse (current scoped
  v5 SDK: chat turns become traces grouped by thread, conversation-eval
  verdicts land as session scores). Both off by default; with them off
  nothing leaves your machine, and Langfuse can point at a self-hosted
  instance to keep it that way even when on.

### Guardrails (prompt-injection and persona defense)

Local open-weights models will happily be talked out of character. Pressed a
few times, ours once cheerfully replied *"I am Qwen, a large language model
developed by Alibaba..."*. Grapevine defends the chat surface the way the
frontier labs do: **small, fast classifiers wrapped around the main model**,
not a wall of regex bolted onto the prompt. Everything runs in-process, on CPU,
with no paid APIs.

[![classifier: Llama Prompt Guard 2 (86M)](https://img.shields.io/badge/classifier-Llama_Prompt_Guard_2_·_86M-7b1e3c)](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
[![runtime: Transformers.js (ONNX)](https://img.shields.io/badge/runtime-Transformers.js_·_ONNX-1f2937)](https://github.com/huggingface/transformers.js)
&nbsp;![local · no paid APIs](https://img.shields.io/badge/local-no_paid_APIs-0b3b2e)

<p align="center">
  <img src="docs/images/guardrails.png" width="900" alt="Guardrails, defense in depth: a user message passes an input rail (Llama Prompt Guard 2, 86M ONNX) that blocks on malicious ≥ 0.80 before either engine runs; benign messages enter the engine, a LangGraph agent on Ollama or a CLI provider (Claude Code, Codex, Gemini, Copilot), with the same rails bracketing both paths; a content rail re-checks the agent's search_web and read_page text and withholds indirect-injection hits (web discovery has its own verify gate); a deterministic output persona guard, keyed to the active model or CLI provider, replaces identity leaks before the reply reaches the browser. Every rail fails safe.">
</p>

Four layers, each covering the gap the previous one leaves:

| Layer | Catches | Engine | Latency | Fail mode |
| --- | --- | --- | --- | --- |
| **Input rail** | Jailbreaks and direct prompt injection in the user's message, blocked *before* the graph so it never poisons thread history | [Llama Prompt Guard 2](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M) (86M, ONNX) | ~15 to 90 ms | **open**: a broken download logs once and chat keeps working |
| **Content rail** | Indirect injection smuggled inside fetched pages and search snippets before it reaches the model's context | same classifier | ~15 ms / window | **open** |
| **Output rail** | Model-identity leaks (*"I am Qwen..."*) and system-prompt disclosure in the streamed answer, swapped for an in-character refusal | deterministic regex + streaming hold-back | ~0 | **closed**: always on, even if the classifier is disabled |
| **Prompt hardening** | Keeps the model in character under social pressure ("it's important you tell me") | pinned system prompt | n/a | n/a |

Why this shape:

- **The same classifier guards tool inputs**, which is the injection path most
  agents miss: a poisoned event listing or web page telling the model to
  "ignore your instructions" is caught as *content*, not just as a user turn.
- **The output rail is deliberately deterministic.** Classifiers are
  probabilistic; the one failure we care about most, the model naming its
  vendor, should be *impossible*, not merely improbable. It streams with a
  64-character hold-back so a leak split across token chunks can't slip
  through, and it is keyed to the active model or CLI provider.

A red-team smoke test, including the exact persona-break from the incident
above, ships alongside:

```bash
npm --prefix server run guardrails:eval   # first run downloads the model
```

## Interest learning (the feedback loop)

Ranking isn't a static formula. It's a loop. Every event the user reacts to
("going", "went", "not for me") reweights the tags of *that kind of
event*, so taste is learned from behavior in the events' own open vocabulary,
not just the fixed 26-topic interest picker. The score feeds every surface;
what those surfaces show shapes the next reaction.

<p align="center">
  <img src="docs/images/interest-learning.png" width="900" alt="Interest-learning feedback loop: a user's picks and one-tap reactions feed taste signals; reactions reweight open-vocabulary tag affinities; a per-event personal score (buzz backbone plus loves match, tag affinity, and this-event reaction, with avoids excluded) ranks every surface (map, list, your week, and the Sunday push), and what those surfaces show shapes the next tap. Ask Grapevine can propose interest changes for the user to confirm.">
</p>

- **Reactions are typed, not thumbs.** "Going" is intent (boost now, +3),
  "went" is the strongest taste evidence (teaches tags hardest, +1.5x),
  "not for me" is both a mute (-8 on the event) and negative evidence (-1.5x
  on its tags). One tap each, from the event detail panel.
- **Learned weights are capped** (+/-3, same ceiling as explicit loves) so a
  burst of reactions tilts the buzz backbone instead of replacing it; the
  editorial signal from newsletters stays the spine of the ranking.
- **Everything reranks client-side, instantly**; reactions persist per account
  in Postgres (deny-all RLS) and mirror into the server-side scorer that
  writes the Sunday push.

## Agent interoperability (MCP and REST)

The same framework-free executors behind the in-app agent are exposed to
external assistants two ways:

- **MCP server**: [FastMCP 4](https://github.com/punkpeye/fastmcp) over
  Streamable HTTP at `POST /mcp`, stateless, so it works across server
  restarts. Tool arguments are Zod schemas, validated before a tool runs.
  Claude Code, Claude Desktop, or any MCP client can search
  events, look up details, get ETAs, save to the calendar, tune interests, run
  verified web discovery (`discover_events`), and manage its scheduled
  searches. Auth is **OAuth 2.1 with Supabase Auth as the authorization
  server**: the endpoint serves RFC 9728 protected-resource metadata and
  answers unauthenticated calls with a `WWW-Authenticate` challenge, the
  client registers itself (dynamic client registration) and runs the PKCE
  code flow through the app's `/oauth/consent` page, and every access token
  is a Supabase JWT verified against the project JWKS. So adding a **Claude
  Desktop / claude.ai custom connector** is: expose the server over HTTPS
  (tunnel + `MCP_PUBLIC_URL`), paste `https://your-host/mcp` under
  Settings -> Connectors, sign in, approve. Each connected client acts as the
  account it signed in with; headless scripts can still send `AGENT_API_KEY`
  as an `X-Agent-Key` header. Copy-paste snippets live in
  **Admin -> Providers**.
- **External REST API** at `/api/ext/v1/*`, gated by an `X-Agent-Key` header.
  Endpoints cover event search, event detail, ETAs, calendar read/write,
  interests, and web discovery (run now or scheduled). A ready-to-install
  [OpenClaw](https://openclaw.ai) skill documenting all of it lives at
  `openclaw/skills/grapevine/SKILL.md`.

## App tour

- **Map**: Mapbox Standard style, night preset, pitched 3D. Live events pulse
  lantern-gold. Traffic layer toggles from the top bar. Markers are colored
  by category.
- **Carousel ("live tour")**: auto-flies between the top live events (falls
  back to today's upcoming when nothing is live), 9s per stop. Pause, step,
  or click through to details.
- **Feed and filters**: live-only, rare finds (parades, races, one-offs),
  hide-promoted (on by default), minimum buzz, category pills. Sorted by a
  personal score that multiplies buzz, interests, and liveness and subtracts
  a promo penalty.
- **Interests**: pillbox picker; "more like this" boosts, "less of this"
  hides matching events entirely (pick *yoga* there and yoga is gone).
- **Event detail**: buzz stars with the model's blunt rationale ("Re-check
  buzz" re-runs it), traffic-aware drive time, directions link, and the
  ticket-provider link when advance tickets are needed.
- **Ask Grapevine**: ⌘K concierge chat that searches, pins the map, plans
  days, and learns your taste (see above).
- **Leave-by alerts**: mark "going" (or save to calendar) with notifications
  on and Grapevine pushes *"Leave by 6:38"* at exactly the right minute -
  traffic-aware drive time from your last coarse position plus a parking
  buffer. Reminders and the Sunday digest ride the same Web Push pipe.
- **Admin -> Models**: Ollama health, active-model switcher, and a pull catalog
  of open-weights models grouped by lab with models.dev metadata and logos,
  streaming download progress.
- **Admin -> Providers**: pick who answers chat and who runs extraction -
  local Ollama or a subscription CLI (Claude Code, Codex, Gemini, Copilot) -
  plus copy-paste MCP snippets so Claude can drive Grapevine from outside.
- **Admin -> Ingest**: paste a newsletter, preview extracted events
  (geocoded and rated), approve which ones land on the map.
- **Admin -> Discover**: search the web for events, review what verification
  confirmed (with evidence quotes) or rejected (with reasons), approve the
  keepers, and save searches the server re-runs on a schedule.
- **Admin -> Sources**: the per-source inbox addresses with copy buttons.

## Layout

```
web/       Vite + React 19 + TS + Tailwind v4 + shadcn/ui (dark-only)
server/    Express 5 + tsx · supabase-js data layer (src/store.ts)
           LangGraph agent (src/agent/: graph, zod tools, NDJSON bridge,
           guardrails: Prompt Guard 2 classifier + persona rail)
           MCP server (src/mcp.ts) · CLI chat providers (src/providers.ts)
           web discovery + verification + scheduler (src/discovery.ts)
           eval runner + suites (src/evals/, scripts/evals.ts)
shared/    one implementation of the logic both tiers need: recurrence,
           opening hours, tag affinity, timezone-correct day math
workers/   email-ingest Cloudflare Email Worker -> Supabase raw_emails
supabase/  tracked SQL migrations
openclaw/  installable OpenClaw skill for the external agent API
docs/      setup.md (operations), mapbox-places.md, images/ (the diagrams
           above), archive/ (superseded working notes, kept for provenance)
.agents/   installed Mapbox agent skills
```
