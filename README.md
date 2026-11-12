# GrapevineOS

[![Animated preview of Grapevine: explore local events, filter the list, ask for a plan, and save it to your calendar](docs/images/demo-preview.gif)](https://github.com/21sean/GrapevineOS/releases/download/v0.8.1/Grapevine-demo-v0.8.1-1080p.mp4)

**[Full demo: 60 seconds, 1080p MP4](https://github.com/21sean/GrapevineOS/releases/download/v0.8.1/Grapevine-demo-v0.8.1-1080p.mp4)**
· Real app UI with sample events and an illustrative AI response. Edited for pacing.
[Demo details](docs/demo.md).

**Local events worth going to, on a 3D map. Built with a validated local AI agent.**

[![CI](https://github.com/21sean/GrapevineOS/actions/workflows/ci.yml/badge.svg)](https://github.com/21sean/GrapevineOS/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/21sean/GrapevineOS)](https://github.com/21sean/GrapevineOS/releases/latest)
[![npm dependency audit](https://img.shields.io/github/actions/workflow/status/21sean/GrapevineOS/dependency-audit.yml?branch=main&label=npm%20audit)](docs/dependency-security.md)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-0b3b2e)](LICENSE)

[Capability checklist](#capability-checklist) · [Quick start](#quick-start) · [Architecture](#how-it-works) · [Documentation](#documentation)

Grapevine turns local newsletters and verified web discoveries into a map of
City events. Browse by date, category, and drive time, learn what is on
nearby, or ask grapevine agent to help plan your day within your connected calendar.

The engineering focus is the boundary between model output and application behavior:
local inference, strict response contracts, evidence checks, bounded tool use,
and repeatable evaluations that run before changes merge. Deepeval judges focus on answer relevance and groundedness.

![Grapevine in dark mode, looking across the Star of India and the Embarcadero toward San Diego's 3D skyline](docs/images/downtown-san-diego-3d.png)

_San Diego's waterfront in dark mode, with 3D buildings and the Star of India in view.
Extra map labels, walking paths, transit, and traffic are off. Real application capture._

**Stack:** React / TypeScript / Mapbox · Node / LangGraph · Python / Pydantic /
Instructor · Ollama or vLLM · Supabase · DeepEval / Ragas / OpenTelemetry.

## capability checklist

The evidence column links to the code, tests, or workflow that a reviewer can inspect.

| Status | Capability                                    | Implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✓      | Schema-gated responses                        | Ollama or vLLM generates against JSON Schema; strict Pydantic and Instructor validation precedes application use, with generated Zod checks at the Node boundary. [Contracts](llm/grapevine_llm/contracts.py) · [Gateway](server/src/llm/gateway.ts)                                                                                                                                                                                                                                                                                                                                                                                                    |
| ✓      | Swappable local serving runtime               | Ollama by default, vLLM through its OpenAI-compatible endpoint with its own pinned record. Serving numbers measured against MLPerf's interactive latency limits. [Runtime](server/src/llm/runtime.ts) · [Record](llm/evals/models.vllm.json) · [Numbers](llm/README.md#serving-numbers)                                                                                                                                                                                                                                                                                                                                                                 |
| ✓      | Bounded repair and typed failures             | Three attempts and one 120-second deadline by default; invalid or exhausted output returns a typed failure without partial results. [Generation boundary](llm/grapevine_llm/client.py) · [Tests](llm/tests/)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ✓      | Streaming with retraction                     | Agent answers stream through the persona filter as they generate and validate as a whole at the end. A failed answer is taken back and replaced by a fallback; tool calls and actions never stream. [Graph](server/src/agent/graph.ts) · [Tests](server/test/streaming-answer.test.ts)                                                                                                                                                                                                                                                                                                                                                                  |
| ✓      | Business-rule and evidence validation         | Validates dates, coordinates, known event IDs, supplied citation IDs, and verification excerpts. Answers can explicitly report insufficient evidence. [Validators](llm/grapevine_llm/contracts.py)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ✓      | Agent orchestration and tool contracts        | LangGraph routes input checks, recall, model calls, tools, content checks, and finalization. Tool names and arguments are validated against the allowed set. [Graph](server/src/agent/graph.ts) · [Tool registry](server/src/agent/contracts.ts)                                                                                                                                                                                                                                                                                                                                                                                                        |
| ✓      | Human confirmation for proposed actions       | Calendar, rarity, watch, and interest proposals have confirmation flows. A write gate checks each chat write against what the person typed, so text in a fetched page or event listing cannot authorize one. [Write gate](server/src/agent/write-gate.ts) · [Action contracts](server/src/agent/contracts.ts)                                                                                                                                                                                                                                                                                                                                           |
| ✓      | Retrieval-grounded answers                    | Upcoming event context and tool results supply evidence to the agent; supported answers must cite supplied IDs. [Context](server/src/agent/context.ts) · [Agent boundary](server/src/agent/graph.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ✓      | Durable conversation memory                   | Thread checkpoints and bounded running summaries preserve context across turns. [Checkpointer](server/src/checkpointer.ts) · [Recall node](server/src/agent/graph.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ✓      | Prompt and response regression evaluation     | 30 synthetic golden cases cover normal, edge, adversarial, and repair behavior; 15 also run against the pinned local model. [Dataset](llm/evals/golden.jsonl) · [Harness](llm/grapevine_llm/evals.py)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ✓      | Local LLM-as-judge evaluation                 | DeepEval scores explicit rubrics after deterministic checks; agent cases add groundedness and relevance criteria. [Quality runner](server/scripts/llm-quality.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ✓      | Retrieval precision and recall                | Ragas ID-based metrics score versioned retrieval snapshots with explicit empty-set behavior. [Metrics](llm/grapevine_llm/retrieval_metrics.py)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ✓      | Reproducible model evaluations                | Runtime and model digests, seed, dependency locks, dataset hashes, and source fingerprints accompany quality artifacts. [Model pins](llm/evals/models.json) · [Provenance](llm/grapevine_llm/provenance.py)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ✓      | CI quality and regression gates               | Requires complete cases, first-pass schema success ≥95%, required judge scores ≥0.75, and no per-case regression against the checked-in and PR-base baselines. [Gates](llm/grapevine_llm/checks.py) · [CI](.github/workflows/llm-quality.yml)                                                                                                                                                                                                                                                                                                                                                                                                           |
| ✓      | Prompt-injection defenses and red-team suites | Local input/content classification, an output persona filter, adversarial fixtures, a PyRIT multi-turn red team, and an indirect injection suite with deterministic scoring. Measured: injection ASR 0 of 108 (0.0%, 95% CI 0.0% to 3.4%), utility under attack 103 of 108 (95.4%, 95% CI 89.6% to 98.0%); red team 0 of 7 (0.0%, 95% CI 0.0% to 35.4%), a small sample. Classifier failure behavior is documented below. [Results and limits](docs/readme-review.md#measured-security-results) · [Guardrails](server/src/agent/guardrails.ts) · [Red team](server/src/evals/suites/guardrails-redteam.ts) · [Injection](server/src/evals/injection.ts) |
| ✓      | Local inference and offline evaluation        | Loopback-only model endpoints, network-denial guards, local datasets/judges, and disabled evaluator uploads. [Offline guide](llm/README.md#offline-operation-tracing-and-ci) · [Network tests](llm/tests/)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ✓      | Observability and feedback into evaluations   | Local OpenTelemetry traces record attempts, failures, model time, validation time, and repair time. A sampled review queue supports reviewed promotion into golden cases. [Telemetry](llm/grapevine_llm/telemetry.py) · [Maintenance](llm/grapevine_llm/maintenance.py)                                                                                                                                                                                                                                                                                                                                                                                 |
| ✓      | Personalized ranking                          | Event reactions update tag-affinity weights shared by the UI and server ranking surfaces. This is a deterministic scoring system. [Affinity logic](shared/affinity.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### What the checks establish

- **Schema validity and factual correctness are separate.** Citation IDs and excerpt
  checks constrain outputs; they do not prove every claim is true.
- **A streamed answer is provisional until it validates.** Agent answers appear as
  they generate, through the persona filter, and validate whole at the end. A person
  can read text that is then retracted and replaced by a fallback. Extraction,
  discovery, tool requests and actions validate before anything acts on them, so
  retraction only ever concerns words on the screen.
- **The evaluation set is a regression suite, not a general accuracy benchmark.**
  Retrieval metrics use stored snapshots, not the live database retriever. The
  starter judge uses the same model as generation; [human calibration](llm/calibration.md)
  is documented but not yet recorded.
- **Offline scope is inference and evaluation.** The live product still uses
  Supabase, Mapbox, and optional web integrations. The prompt-injection classifier
  can run in blocking, observe, or off mode and fails open if unavailable; the
  structured-output boundary fails closed for everything that can act on the world.

See the [quality guide](llm/README.md) for reproducing the gates and the
[README review](docs/readme-review.md)

## Explore the city

- **See events in context.** A pitched Mapbox map, category icons, live event
  markers, and a tour that moves between current events.
- **Find your kind of plans.** Search, dates, rare finds, category filters,
  drive-time areas, and rankings that respond to your interests and reactions.
- **Keep the details close.** Venue information, directions, calendar conflicts,
  event sharing, and calendar export sit alongside the map.
- **Ask for help.** The concierge searches the event catalog, suggests day plans,
  and proposes calendar saves, watches, and interest changes for you to confirm.

Run the agent on local Ollama or vLLM models through strict, validated output contracts.
Supabase stores events and account data, and Mapbox supplies the map and location
services. Optional integrations add newsletter delivery, Google Calendar sync,
push reminders, and tracing.

<p align="center">
  <img src="docs/images/mobile-event-list.png" width="320" alt="Mobile Grapevine event list below San Diego's illuminated 3D waterfront skyline">
  <img src="docs/images/mobile-event-details.png" width="320" alt="Mobile event detail sheet with the dark San Diego waterfront map above it">
</p>

_Browse events, then open the details. Capture settings and camera positions are
recorded in the [screenshot guide](docs/screenshots.md)._

## Quick start

Start with **Node 22.23.3** (pinned in [.nvmrc](.nvmrc)) and **Docker** running.
Local setup needs no Supabase account or model. It runs Supabase's Postgres,
Auth, REST API, and Realtime locally and adds seven fictional demo events.

### 1. Install

```bash
git clone https://github.com/21sean/GrapevineOS.git
cd GrapevineOS
npm ci
npm run setup
npm run dev
```

Open **http://localhost:5174**. The API listens on **http://localhost:8787**.
The first setup downloads container images, applies migrations, and writes
local credentials to the ignored environment files. Rerunning it preserves
your settings and refreshes demo dates without duplicating events. It refuses
to replace hosted database configuration. Use `--no-demo` to skip sample data.

### 2. Enable the features you need

- **Map:** add a public Mapbox token as `VITE_MAPBOX_TOKEN` in `web/.env.local`.
  Without it, you can browse the event list. Location services also use
  `MAPBOX_SECRET_TOKEN` in `server/.env`.
- **Chat and extraction:** install Python 3.12, uv, and a local inference runtime.
  Follow the [structured inference guide](llm/README.md), then select a model.
- **Sign-in:** configure Google/GitHub OAuth separately. Browsing demo events
  does not need an account.
- **Hosted Supabase:** run `npm run setup -- --hosted` to create missing templates,
  then follow [setup and operations](docs/setup.md#hosted-supabase).

`npm run doctor -- --browse` checks the browsing prerequisites. `npm run doctor`
also checks the map and model prerequisites. Stop local Supabase with
`npx supabase stop`; `npm run setup` starts it again without resetting data.

## How it works

Newsletter or discovery text → schema-gated extraction and verification → stored
events → map and ranking. The agent reads event context and tool results,
validates its next action or complete answer, and exposes proposals through the UI.

<details>
<summary>Explore the ingestion, agent, guardrail, and ranking diagrams</summary>

### From newsletters to the map

Newsletters become structured events, enriched with local buzz ratings and
venue coordinates, then appear on the 3D map. Local models handle extraction;
Supabase and Mapbox provide hosted storage and location services.

<p align="center">
  <img src="docs/images/how-it-works.png" width="900" alt="Grapevine overview: newsletter intake, Supabase storage, local model enrichment, and the React and Mapbox 3D map">
</p>

### Newsletter delivery

The email worker parses incoming newsletters and stores them once. Delivery
recovery keeps failed inserts available for retry.

<p align="center">
  <img src="docs/images/email-worker.png" width="900" alt="Newsletter delivery through Cloudflare Email Routing, parsing, Supabase storage, and a dead-letter recovery path">
</p>

### Ask Grapevine

The agent screens messages, recalls conversation context, calls validated
tools, and keeps durable thread memory. Actions that write arrive as proposals
for you to confirm.

<p align="center">
  <img src="docs/images/ask-grapevine.png" width="900" alt="Ask Grapevine LangGraph architecture with input and content rails, recall, agent and tool nodes, a finalize node, and durable memory">
</p>

### Guardrails

Input and fetched content pass through classifier checks (llama guard). A separate output
filter checks the validated answer before display. The
[technical guide](docs/product-guide.md#guardrails) explains the checks and
their failure behavior.

<p align="center">
  <img src="docs/images/guardrails.png" width="900" alt="Input, content, and output guardrails around the Grapevine agent, including blocked input and withheld tool results">
</p>

### Interest learning

Interests and event reactions adjust tag affinities and personal scores. The
same ranking signals feed the map, event list, weekly view, and notifications.

<p align="center">
  <img src="docs/images/interest-learning.png" width="900" alt="Interest learning feedback loop from preferences and event reactions to tag affinity, personal scores, and ranked event surfaces">
</p>

</details>

See the [product guide](docs/product-guide.md) and
[agent architecture](docs/agent-architecture.md) for the complete walkthrough.

## Documentation

| Guide                                                | Covers                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Structured inference and evals](llm/README.md)      | Strict contracts, offline model calls, quality gates, and baselines              |
| [Setup and operations](docs/setup.md)                | Accounts, configuration, deployment, auth, email delivery, and optional services |
| [Product and technical guide](docs/product-guide.md) | App tour, event ingestion, discovery, ranking, guardrails, MCP, and REST         |
| [Agent architecture](docs/agent-architecture.md)     | LangGraph state, tool contracts, streaming, and durable memory                   |
| [Mapbox Places](docs/mapbox-places.md)               | Venue lookups, scope requirements, caching, and quotas                           |
| [Changelog](docs/CHANGELOG.md)                       | Release notes and project history                                                |
| [Contributing](.github/CONTRIBUTING.md)              | Development workflow, tests, evals, and migrations                               |
| [Security](.github/SECURITY.md)                      | Trust boundaries and reporting a vulnerability                                   |

## Development

One workspace install covers the API, web app, and email worker.

```bash
npm run typecheck
npm test
npm run build
npm run lint
npm run format:check
npm run contracts:check
```

CI also requires schema/version checks, 30 deterministic golden cases, and
15 pinned local model cases with local judges, plus six whole turns through the real
graph, including a tool round and questions the concierge once deflected. See the
[structured inference guide](llm/README.md) for adding schemas, eval cases,
and reviewed baselines. Existing offline and red-team suites remain available.

| Directory               | Purpose                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `web/`                  | React UI, Mapbox rendering, filters, event details, and chat               |
| `server/`               | Express API, LangGraph agent, integrations, MCP, and evaluations           |
| `shared/`               | Domain types, recurrence, ranking signals, and time calculations           |
| `llm/`                  | Python contracts, local inference, golden cases, judges, and quality gates |
| `contracts/llm/`        | Immutable versioned JSON Schemas for cross-language validation             |
| `workers/email-ingest/` | Cloudflare newsletter intake and delivery recovery                         |
| `supabase/`             | Database migrations                                                        |
| `docs/`                 | Setup, architecture, product guide, and UI screenshots                     |

Licensed under [Apache-2.0](LICENSE).
