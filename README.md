# Grapevine

**Local events worth going to, on a 3D map.**

[![CI](https://github.com/21sean/GrapevineOS/actions/workflows/ci.yml/badge.svg)](https://github.com/21sean/GrapevineOS/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/21sean/GrapevineOS)](https://github.com/21sean/GrapevineOS/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-0b3b2e)](LICENSE)

[Screenshots](#screenshots) · [Quick start](#quick-start) · [Diagrams](#how-it-works) · [Documentation](#documentation) · [Releases](https://github.com/21sean/GrapevineOS/releases)

Grapevine turns local newsletters and verified web discoveries into a map of
San Diego events. Browse by date, category, and drive time, learn what is on
nearby, or ask the concierge to help plan your day.

![Grapevine showing downtown San Diego high rises in 3D, with a concert event list](docs/images/downtown-san-diego-3d.png)

_Downtown San Diego, zoomed in to show the high rises. Captured from the running app with 3D buildings enabled._

## Explore the city

- **See events in context.** A pitched Mapbox map, category icons, live event
  markers, and a tour that moves between current events.
- **Find your kind of plans.** Search, dates, rare finds, category filters,
  drive-time areas, and rankings that respond to your interests and reactions.
- **Keep the details close.** Venue information, directions, calendar conflicts,
  event sharing, and calendar export sit alongside the map.
- **Ask for help.** The concierge searches the event catalog, suggests day plans,
  and proposes calendar saves, watches, and interest changes for you to confirm.

Run the agent with local Ollama models or a supported subscription CLI.
Supabase stores events and account data, and Mapbox supplies the map and location
services. Optional integrations add newsletter delivery, Google Calendar sync,
push reminders, and tracing.

## Screenshots

Real UI captures featuring community concerts. The phone layout keeps the map
visible while you browse, then opens a scrollable sheet for an event's details.

<p align="center">
  <img src="docs/images/mobile-event-list.png" width="320" alt="Mobile event list showing free community concerts with a downtown San Diego 3D map">
  <img src="docs/images/mobile-event-details.png" width="320" alt="Concerts on the Green event details with rating, tags, reactions, and driving directions">
</p>

_Browse community concerts, then open an event for ratings, reactions, and directions._

## Quick start

You need **Node 22.23.3** (pinned in [.nvmrc](.nvmrc)), a **Supabase project**,
a **Mapbox account**, and an **Ollama model or supported subscription CLI**.
See [setup and operations](docs/setup.md) for supported Node versions and the
full configuration walkthrough.

### 1. Install

```bash
git clone https://github.com/21sean/GrapevineOS.git
cd GrapevineOS
npm install --workspaces --include-workspace-root
```

### 2. Configure

Copy the templates and fill in your credentials:

```bash
cp server/.env.example server/.env
cp web/.env.example web/.env.local
```

| File             | Required configuration                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| `server/.env`    | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `MAPBOX_SECRET_TOKEN`              |
| `web/.env.local` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_MAPBOX_TOKEN` |

On Windows, use `Copy-Item` in place of `cp` if needed. Keep secret keys in the
server environment. The browser uses publishable and public tokens.

Link your Supabase project and apply the migrations with its CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

For a local model, install Ollama and run `ollama pull qwen3:8b`.
Alternatively, choose Claude Code, Codex, Gemini, or Copilot in
**Admin → Providers** after startup. Each CLI uses its existing sign-in.

### 3. Run and add events

```bash
npm run doctor
npm run dev
```

Open **http://localhost:5174**. The API listens on **http://localhost:8787**.
A fresh database starts empty. Paste a newsletter into **Admin → Ingest**, or
use **Admin → Discover** to review and add verified events.

Press **Ctrl K** on Windows and Linux, or **⌘K** on macOS, to open Ask Grapevine.

## How it works

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

Input and fetched content pass through classifier checks. A separate output
filter runs on the streamed response. The
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

See the [product guide](docs/product-guide.md) and
[agent architecture](docs/agent-architecture.md) for the complete walkthrough.

## Documentation

| Guide                                                | Covers                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
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

CI also runs five offline evaluation suites. Model evaluations and the red team
run on the optional GPU workflow. See [contributing](.github/CONTRIBUTING.md)
for the full validation commands.

| Directory               | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `web/`                  | React UI, Mapbox rendering, filters, event details, and chat     |
| `server/`               | Express API, LangGraph agent, integrations, MCP, and evaluations |
| `shared/`               | Domain types, recurrence, ranking signals, and time calculations |
| `workers/email-ingest/` | Cloudflare newsletter intake and delivery recovery               |
| `supabase/`             | Database migrations                                              |
| `docs/`                 | Setup, architecture, product guide, and UI screenshots           |

Licensed under [Apache-2.0](LICENSE). See the
[third-party notices](docs/THIRD_PARTY_NOTICES.md) and
[code of conduct](.github/CODE_OF_CONDUCT.md).
