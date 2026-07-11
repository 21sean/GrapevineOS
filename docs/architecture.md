# Grapevine architecture: diagram redraw brief

This document captures everything about the AI, agent, web-discovery, MCP, and
integration layers that changed *after* the current `docs/*.png` diagrams were
drawn, so the five existing figures can be brought current and two new ones
added. It is a spec for whoever redraws them, not prose to reproduce verbatim:
each section gives the exact node labels, code tags, arrow labels, and callouts
to draw, plus a "delta vs. the current PNG" noting what to keep and what to
change.

Pair this with the live source of truth in the repo (`README.md`, and the files
listed in the Appendix). Where this doc and the code disagree, the code wins.

---

## 1. What changed since the diagrams were drawn

The diagrams were last authored across these commits:

| Diagram | Last drawn at | State |
|---|---|---|
| `email-worker.png` | `d5939b0` | still accurate |
| `interest-learning.png` | `d5939b0` / `b877f73` | still accurate |
| `guardrails.png` | `b877f73` | **minor update** |
| `how-it-works.png` | `2d9883f` | **major redraw** |
| `ask-grapevine.png` | `df55614` (PR #7, LangGraph 1.4) | **partial update** |

Everything below landed on `main` **after** those commits:

| PR | Title | Architectural impact |
|---|---|---|
| **#9** `bddf168` | CLI LLM providers for extraction + Copilot, and leave-by alerts | The "brain" is no longer only local Ollama. Chat **and** newsletter extraction can each be routed independently to a subscription-authed CLI: **Claude Code, OpenAI Codex, Gemini CLI, or GitHub Copilot CLI**. No API keys. Claude Code loops back into Grapevine's own MCP endpoint to keep tools. Also: traffic-aware "Leave by 6:38" push alerts. |
| **#10** `bc2b76b` | Date quick filters, sharing, search-aware map, empty-state reset | UX only. **No diagram impact.** |
| **#11** `b7ffb7c` | Verified web discovery, scheduled searches, Claude Desktop MCP support | A whole new **second data source**: search the open web, read pages, extract, then **verify** (deterministic gates plus a skeptical second LLM pass) before commit. Runs one-off or on a saved schedule. New **MCP tools** (`discover_events`, `schedule_search`, and friends) and **Claude Desktop / claude.ai custom connector** support (`?key=` URL auth, CORS, `MCP_PUBLIC_URL`). |

Net effect for the diagrams:

- **Two intake paths now**, not one: `newsletters → email worker` **and**
  `web search → verify`. `how-it-works` shows only the first.
- **The model is provider-abstracted.** Ollama is still the private default,
  but Ollama · Claude Code · Codex · Gemini · Copilot are interchangeable for
  chat and for extraction, chosen in Admin → Providers.
- **The interoperability surface grew and has no diagram at all.** One
  framework-free domain layer is now exposed three ways: in-app agent tools,
  external REST (`/api/ext/v1`), and an MCP server (`/mcp`). It is consumed by
  OpenClaw over REST and by Claude Code / Claude Desktop / claude.ai over MCP.
- **Guardrails now wrap both engines.** The input and output rails apply to the
  CLI-provider path too, not just the Ollama/LangGraph path.

---

## 2. Shared visual system (keep redraws on-brand)

Read off the existing PNGs; hold these constant so new and updated figures read
as one set.

**Canvas.** 3600 px wide. Height 1600 for a single linear row; roughly
1920-2000 when there is a second row, a loop-back arrow, or a legend plus
callout stack.

**Palette** (approximate, sample the existing PNGs to match exactly):

| Role | Value | Used for |
|---|---|---|
| Canvas | warm cream `#F7F3EA` | background |
| Ink | near-black `#1B1A17` | titles, body |
| Muted ink | `#6E6A62` | subtitles, secondary text, arrow labels |
| **Wine (primary accent)** | `#7B1E3C` | eyebrow label, active chip fill, step numbers (`01 · INTAKE`), loop arrows, footer left-rule |
| Wine tint | `#F1E1E6` | active-chip / highlighted-card fill (e.g. "Personal score") |
| Supabase green | `#3FCF8E` | the store node / Postgres icon |
| Success green | `#2FA36B` | terminal dots (You, Browser, Local server) |
| Alert clay | `#C0492F` on tint `#F6E2DB` | failure/blocked cards plus arrows (Blocked, Dead letter, Reply replaced) |
| Card | `#FFFFFF`, radius ~18px, hairline border `#E7E1D6`, soft shadow | every step card |
| Code tag | bg `#EFEAE0`, mono ink `#4A463E` | the monospace chip at a card's foot |

**Type.** Heading in a heavy geometric grotesk; body in its regular weight;
**monospace** for code tags and arrow labels that name identifiers. Eyebrow is
letter-spaced wine caps in the form `SECTION NAME · GRAPEVINE`.

**Grammar** (consistent across all five):
- Eyebrow → big bold title → one- or two-line muted subtitle → a row of chips
  (first chip wine-filled, rest outlined) → a thin divider → the flow.
- Flow = rounded **step cards**, each with a wine `NN · LABEL` eyebrow, bold
  title, ~2-line description, and a mono code tag naming the file/table/id.
- **Pill terminals** at the ends: wine dot = origin, green dot = destination.
- Thin dark arrows with short lowercase labels (`email`, `write`, `poll`,
  `serve`, `render`); dashed arrows for optional/untrusted/proposed paths;
  wine arrows for loop-backs.
- Optional bottom-left **"HOW TO READ"** legend box; one or two **footer
  callouts** with a wine left-rule (bold lead-in plus muted explanation).
- No emojis. Keep punctuation clean: commas, colons, and periods rather than
  long dashes.

---

## 3. Existing diagrams: deltas

### 3.1 `how-it-works.png` (major redraw)

*Current:* a clean 4-step line. `Newsletters →` **01 INTAKE** (Newsletters by
email) → **02 STORE** (One Postgres, deny-all) → **03 ENRICH** (The local
brain, Ollama) → **04 SERVE** (A live 3D map) `→ You`. Chips: Cloudflare Email
Routing · Supabase Postgres · Ollama · local model · Mapbox GL · no paid APIs.
Footer: "Free, end to end … Nothing leaves your machine by default."

*Why it's stale:* it shows one intake path and hard-codes Ollama as the brain.
Both are now more general.

**Redraw guidance, two intake lanes into a shared brain:**

- Keep the spine, but **fork the intake** into two lanes that merge at STORE /
  ENRICH:
  - **Lane A, Newsletters** (unchanged): `Newsletters → email worker →
    Postgres`. Tag `workers/email-ingest`.
  - **Lane B, Web discovery** (new): `Web search → verify → Postgres`. Tag
    `server/src/discovery.ts`. One line: "AI web search, gated by a
    verification pass." (Full detail lives in the new discovery figure, §4.1;
    here it is just a second inbound arrow.)
- **Generalize step 03 "The local brain."** Retitle toward "The brain" and show
  it is provider-selectable: primary **Ollama · local (default, private)** with
  an alternate chip cluster **Claude Code · Codex · Gemini · Copilot (CLI, no
  API keys)**. Keep Mapbox geocoding in this step. Tag stays `server/` but add
  `providers.ts · llm.ts`.
- **Chips row:** add a **Web discovery** chip and a **CLI providers** chip.
  Keep **no paid APIs** (still true: CLIs are subscription-authed, web search
  is keyless).
- **Footer:** soften "Nothing leaves your machine" to **"Private by
  default"**: Ollama plus email plus Postgres keep everything local, while web
  discovery (reads the open web) and cloud CLI providers are explicit opt-ins.
  Keep "No paid APIs anywhere in the loop."
- Terminal stays `→ You`. Optionally add a small side-tag off SERVE pointing to
  the new integrations figure ("also exposed to external agents; see
  interoperability").

### 3.2 `ask-grapevine.png` (partial update)

*Current (already redrawn for LangGraph 1.4):* AGENT NODE (ChatOllama, tools
bound, system prompt rebuilt each turn) ⇄ TOOLS NODE (Data tools:
`search_events · get_event · get_eta · search_web · read_page`; UI tools:
`show_on_map · propose_calendar · update_interests`), with GRAPH STATE
(`toolRounds · Overwrite(0)`), CHECKPOINTER (`MemorySaver`), FINALIZE NODE
(`MAX_TOOL_ROUNDS = 6`), routing `no tool_calls · reply` and `toolRounds ≥ 6`.

**The graph itself is still exactly right, so keep it.** Verified against
`server/src/agent/graph.ts`: nodes `agent · tools · finalize`, edges
`START→agent`, `agent→{tools,END}`, `tools→{agent,finalize}`, `finalize→END`,
`MAX_TOOL_ROUNDS = 6`, `Overwrite(0)` per turn via `turnInput`.

**Two accuracy fixes plus one addition:**

1. **The engine is provider-abstracted.** The AGENT NODE currently reads
   "ChatOllama." Chat can instead run on a CLI provider. Suggested: relabel the
   model chip to **"engine: Ollama (default) · or CLI provider"** and keep the
   agent-node body describing the Ollama/LangGraph path (the tool-using one).
2. **The UI-tools list is incomplete.** The real set is `show_on_map ·
   set_filters · propose_calendar · save_calendar · set_rarity ·
   update_interests`. Data tools list is correct as drawn.
3. **Add a small branch for CLI-provider chat** (from PR #9): either a sidebar
   card or a second mini-lane, since it bypasses the graph:
   - **CLI provider path:** one-shot per turn, **no LangGraph, no UI tools**,
     digest-grounded, in-memory transcript (no checkpointer). Tag
     `providers.ts` · `MAX_EXCHANGES = 8`.
   - **Claude Code is special:** it connects *back* to Grapevine's own `/mcp`
     endpoint (`--mcp-config` → `--allowedTools mcp__grapevine`), regaining
     `search_events · get_event · get_eta · save/unsave_event`, but **still no
     live map pinning.** Codex / Gemini / Copilot stay digest-only.
   - Both CLI and Ollama paths still pass the **input plus output guardrails**
     (see §3.3).

   If you would rather keep this figure purely about the LangGraph loop, put the
   provider fork in `how-it-works` (§3.1) or a dedicated Providers panel (§4.3)
   instead; but the "ChatOllama"-only labeling must change here regardless.

### 3.3 `guardrails.png` (minor update)

*Current:* INPUT RAIL (Prompt Guard 2, `malicious ≥ 0.80` → Blocked) → LANGGRAPH
AGENT (system prompt + agent + tools) → OUTPUT RAIL (Persona guard → Reply
replaced on identity leak), with a CONTENT RAIL re-scanning fetched tool text.
All fail-safe. This is still **structurally correct**, verified against
`server/src/agent/guardrails.ts`.

**Updates:**

- **The rails wrap both engines, not just the LangGraph agent.** In
  `agent/index.ts` the input rail (`scanText`) runs *before* the engine branch,
  and the output persona guard runs on the CLI answer too (`personaGuard({
  modelName: provider })`). Redraw the center box as **"engine: LangGraph agent
  (Ollama) · or CLI provider"** so the rails visibly bracket either engine.
- **Scope the content rail precisely.** The content rail (same 86M classifier)
  guards the **in-app agent's** web tools only: `search_web` snippets and
  `read_page` text in `agent/tools.ts`. **Web discovery does *not* use this
  rail**; it has its own separate verification gate (§4.1). If the figure could
  read as "all web text everywhere flows through Prompt Guard," add a one-line
  clarifier or leave discovery out of this figure entirely.
- Numbers to keep: input `~15-90 ms`, content `~15 ms/window`, output `~0 ms ·
  always on`, threshold `0.80`, model **Llama Prompt Guard 2 · 86M · ONNX /
  Transformers.js · CPU**. Input/content **fail open**; output **fails closed**
  (regex, always on even if the classifier is disabled). All correct.

### 3.4 `email-worker.png` (still accurate, one optional note)

Verified against the pipeline; PR #11 did not touch email. Catch-all routing →
PostalMime worker → one idempotent `raw_emails` row → local server polls;
dead-letter to KV (`ttl 30d`) on insert failure; optional `INGEST_URL` push
mode. **No redraw needed.** *Optional:* a small footnote that this is now **one
of two intake paths** (the other being web discovery), if you want the set to
cross-reference cleanly.

### 3.5 `interest-learning.png` (still accurate, one optional note)

The feedback loop is unchanged: taste signals (interests + one-tap reactions) →
open-vocabulary tag affinity → per-event personal score → ranked surfaces (map ·
list · your week · push) → loops back. Weights/caps as drawn. **No redraw
needed.** *Optional tweaks if convenient:*
- The "Ask Grapevine · Ollama" chip could read **"Ask Grapevine · Ollama or
  CLI"** for consistency with the provider abstraction.
- **External agents can now write interests too** (`update_interests` over MCP,
  `POST /api/ext/v1/interests` over REST), so the "Ask Grapevine proposes"
  dashed input could gain a sibling "external agents" input. Minor.

---

## 4. New diagrams to add

### 4.1 Web discovery: *"Search the web, but verify"* (highest priority)

The flagship new subsystem (PR #11), and completely undrawn. Source of truth:
`server/src/discovery.ts`. The core guarantee: the model does **not** get to
put events on the map by asserting them; every candidate is checked against the
page it came from.

- **Eyebrow / title / subtitle:** `WEB DISCOVERY · GRAPEVINE` / **"Search the
  web, but verify"** / "Newsletters are the spine, but they miss things.
  Discovery tops the map up from the open web without trusting the model's first
  draft: extract per page, then gate every candidate before it is written."
- **Chips:** Keyless search (SearXNG / DuckDuckGo) · Readability + SSRF guard ·
  Two-pass LLM · Dry-run by default · Scheduled.
- **Flow (a pipeline that narrows left-to-right)**, with a reject lane peeling
  off downward (clay), mirroring how `guardrails` drops Blocked/withheld:

  1. **01 · SEARCH**: "Query, scoped to the city." `webSearch` via SearXNG or
     the keyless DuckDuckGo fallback. Tag `MAX_RESULTS = 8`.
  2. **02 · READ**: "Read the top pages." Same Readability + SSRF-guard reader
     the agent uses, sequential. Tag `MAX_PAGES = 4 · 12k chars`.
  3. **03 · EXTRACT**: "One page at a time." LLM extraction **per page** so
     every candidate is attributable to exactly one URL (`sourceKind: "search"`,
     `sourceUrl`). Tag `ingest.extractEvents`.
  4. **04 · GATE (deterministic)**: "Cheap checks first, no tokens spent on
     fabrications." Reject if: unparseable date · in the past · `> 400 days`
     out · no venue · **title not literally on the page**. Tag `hardReject`.
  5. **05 · VERIFY (skeptical LLM)**: "A second model re-reads the page and must
     **confirm** (with a supporting quote), **correct** a detail from the page,
     or call it **unsupported**." One call per page. Tag
     `DISCOVERY_MIN_CONFIDENCE = 0.7` (corroborated by 2+ pages → `0.5`).
     **Fails closed:** verifier error = reject, not pass.
  6. **06 · COMMIT**: "Only verified candidates are written," deduped against
     the whole catalog; logged to ingest history as kind `search`; images
     enriched. Tag `store.addEvents`. **Dry-run is the default** for
     external/MCP callers: verify and report, write nothing.
- **Reject lane (clay, peeling down):** a "Rejected: reported with a reason,
  never written" card fed by both the deterministic gate and the LLM verifier
  (reasons like "title not found on the source page," "source page does not
  support this event," "confidence 0.42 below 0.70").
- **Second row / inset, the scheduler:** "Saved searches re-run themselves."
  `discovery_searches` table plus in-process loop, cadence **1 h to 2 w**
  (`cadence_hours` 1-336), `DISCOVERY_TICK_SECONDS = 300`,
  `DISCOVERY_SCHEDULE=0` disables, non-overlapping ticks stamp
  `last_run/status`. Draw as a loop arrow from COMMIT back to SEARCH labeled
  "on a schedule."
- **Terminals:** origin pill `Query` (from Admin → Discover, MCP
  `discover_events`, or `POST /api/ext/v1/discovery/run`); destination the map
  (green).
- **Footer callout:** "Verified, not gospel. Every kept event carries the
  `source_url` and an `evidence` quote; the map only shows what a second,
  skeptical pass could still support."

### 4.2 Agent interoperability: *"One core, three surfaces"* (high priority)

The MCP, OpenClaw, and integrations story, also undrawn. This is where MCP,
Claude Desktop connectors, and the OpenClaw skill belong. Source of truth:
`server/src/mcp.ts`, `server/src/agent/index.ts` (`/api/ext/v1/*`),
`server/src/agent/context.ts` (shared executors), `openclaw/skills/grapevine/`.

- **Eyebrow / title / subtitle:** `INTEROPERABILITY · GRAPEVINE` / **"One core,
  three surfaces"** / "The same framework-free domain layer powers the in-app
  agent, an external REST API, and an MCP server. Write once; every assistant
  drives the same tools."
- **Center, the shared core:** one wine-tinted hub card **"Domain executors
  (`agent/context.ts`)"**: `searchEvents · getEvent · getEta · calendar ·
  interests · rarity · runDiscovery`. Everything fans out from here.
- **Three surface cards around it:**
  1. **In-app agent**: LangGraph tools (Zod-validated), the ⌘K chat. Consumer:
     the web client. Tag `agent/tools.ts`.
  2. **External REST**: `/api/ext/v1/*`, `X-Agent-Key` header, writes bind to
     `AGENT_USER_EMAIL`. Endpoints: events, event detail, rarity, eta, calendar
     (GET/POST/DELETE), discovery (run + searches), interests. Tag
     `/api/ext/v1`.
  3. **MCP server**: Streamable HTTP `POST /mcp`, **stateless**, 12 tools
     (`search_events · get_event · get_eta · list_saved_events · save_event ·
     unsave_event · set_event_rarity · discover_events · list_scheduled_searches
     · schedule_search · unschedule_search · update_interests`). Auth: **OAuth
     2.1** with Supabase Auth as the authorization server. RFC 9728
     protected-resource metadata at `/.well-known/oauth-protected-resource`,
     401 + `WWW-Authenticate` challenge, PKCE code flow with dynamic client
     registration, access tokens verified against the project JWKS. Fallbacks:
     `AGENT_API_KEY` as `X-Agent-Key` (headless), per-boot internal key (CLI
     loopback), `MCP_OPEN=1` (no auth, dev). Tag `mcp.ts`.
- **Consumers (outer ring, pill nodes):**
  - **OpenClaw** → External REST (the installable skill at
    `openclaw/skills/grapevine/SKILL.md`; curl over `X-Agent-Key`). It is told
    to **prefer MCP when available.**
  - **Claude Code** → MCP (both as an external client and, in provider mode,
    looping back into this same `/mcp`).
  - **Claude Desktop / claude.ai custom connectors** → MCP over OAuth: paste
    `https://your-host/mcp`, the browser consent flow (`/oauth/consent` in
    the web app) does the rest; needs HTTPS plus `MCP_PUBLIC_URL`
    (tunnel/reverse proxy); the endpoint answers CORS preflights;
    `GET`/`DELETE` → 405.
- **Callout:** "OAuth callers act as themselves: calendar and interest writes
  bind to the signed-in account. Key-authed and open-mode callers bind to the
  one account named by `AGENT_USER_EMAIL`; a caller can never name someone
  else's." Optionally a second: "Dry-run by default: discovery over MCP/REST
  reports before it writes."

### 4.3 Providers: *"Bring your own brain"* (optional; can fold into §3.1)

If you want a clean standalone for PR #9 rather than cramming it into
`how-it-works`. Source of truth: `server/src/providers.ts`, `llm.ts`,
`web/src/components/admin/ProvidersTab.tsx`.

- **Title / subtitle:** **"Bring your own brain"** / "Two jobs, chat and
  newsletter extraction, each routed independently to a local model or a
  subscription CLI. No API keys anywhere."
- **Two role selectors** (`chatProvider`, `extractProvider`, both default
  `ollama`) each pointing at the same five engines:
  - **Ollama**: local, private default (chat = the full LangGraph agent).
  - **Claude Code** (`claude -p`, Anthropic / claude.ai): *plus MCP loopback
    for tools in chat.*
  - **Codex CLI** (`codex exec`, OpenAI / ChatGPT).
  - **Gemini CLI** (`gemini`, Google OAuth free tier).
  - **Copilot CLI** (`copilot -p`, GitHub Copilot).
- **The trade-off (the whole point):** local = private but needs a GPU; CLI =
  no GPU and no API keys, but text leaves the machine and (except Claude Code)
  chat is **digest-only, no UI tools**. Auth is detected from each CLI's
  credential files/env, never a paid model call.
- **Extraction routing** (`llm.generateJSON`): an explicit Ollama model tag
  forces local; otherwise route by `extractProvider`. Feeds newsletter
  extraction, buzz rating, **and** the discovery verifier.

---

## Appendix: source of truth

| Concern | File(s) | Key facts for labels |
|---|---|---|
| Web discovery | `server/src/discovery.ts` | `MAX_RESULTS 8`, `MAX_PAGES 4`, `PAGE_CHARS 12000`, `MAX_DAYS_OUT 400`, `DISCOVERY_MIN_CONFIDENCE 0.7` (drops to 0.5 if corroborated), verdicts `confirmed/corrected/unsupported`, fails closed, dry-run default, scheduler `DISCOVERY_TICK_SECONDS 300` / `DISCOVERY_SCHEDULE=0` / cadence 1-336 h |
| CLI providers | `server/src/providers.ts`, `llm.ts` | ids `claude · codex · gemini · copilot`; subscription-authed; `cliSupportsTools` = claude only; MCP loopback via `--mcp-config`/`--allowedTools mcp__grapevine`; `MAX_EXCHANGES 8`; `CLI_TIMEOUT_MS 110000` |
| Provider settings | `server/src/types.ts`, `store.ts`, `web/.../admin/ProvidersTab.tsx` | `chatProvider` and `extractProvider`, independent, both default `ollama` |
| MCP server | `server/src/mcp.ts`, `index.ts` (`/api/mcp/info`) | Streamable HTTP `POST /mcp`, stateless, 12 tools, OAuth 2.1 (Supabase AS, RFC 9728 metadata + 401 challenge, JWKS-verified Bearer, per-user writes), fallbacks `X-Agent-Key`/internal loopback key/`MCP_OPEN=1`, CORS, 405 on GET/DELETE, `MCP_PUBLIC_URL` |
| External REST | `server/src/agent/index.ts` | `/api/ext/v1/*`, `X-Agent-Key`, endpoints: events, events/:id, events/:id/rarity, eta, calendar (GET/POST/DELETE), discovery/run, discovery/searches (GET/POST/DELETE), interests |
| Shared executors | `server/src/agent/context.ts` | `searchEvents · getEvent · getEta · setEventRarity · vetTopics …`, one layer behind agent + REST + MCP |
| Agent graph | `server/src/agent/graph.ts` | nodes `agent · tools · finalize`; `MAX_TOOL_ROUNDS 6`; Zod 4 StateSchema; `toolRounds` + `Overwrite(0)`; `MemorySaver` per `thread_id`; retry connection-only + 45s idle on model nodes, none on tools |
| Agent tools | `server/src/agent/tools.ts` | data: `search_events · get_event · get_eta · search_web · read_page`; UI: `show_on_map · set_filters · propose_calendar · save_calendar · set_rarity · update_interests` |
| Guardrails | `server/src/agent/guardrails.ts`, `agent/index.ts`, `agent/tools.ts` | Prompt Guard 2 · 86M · ONNX; threshold `0.80`; input rail before engine branch (covers CLI); content rail on `search_web`/`read_page` only; output persona rail always-on, keyed to model/provider; `HOLDBACK 64` |
| OpenClaw skill | `openclaw/skills/grapevine/SKILL.md` | REST usage, `GRAPEVINE_URL`/`GRAPEVINE_AGENT_KEY`, ground rules (confirm before writes, dry-run discovery), "prefer MCP when available" |
| Leave-by alerts (PR #9) | `server/src/push.ts` | traffic-aware "Leave by H:MM" on going/saved events; shares the Web Push pipe with reminders + Sunday digest (relevant only if a push figure is ever drawn) |
