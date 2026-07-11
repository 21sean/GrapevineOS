---
name: grapevine
description: >
  Query the user's local Grapevine server for San Diego events: search what's
  on (tonight, this weekend, by vibe/category/tag), get full event details,
  traffic-aware drive ETAs, and manage the user's saved-events calendar and
  interests. Can also discover NEW events by running a verified web search
  (one-off or on a schedule the server re-runs). Use whenever the user asks
  what's happening in San Diego, wants plans, asks if they can make it to an
  event, wants an event saved, or wants the map topped up from the web.
---

# Grapevine events

Grapevine is a local-first events map (`npm run dev` in its repo). Configure:

- `GRAPEVINE_URL` — default `http://localhost:8787`
- `GRAPEVINE_AGENT_KEY` — must match `AGENT_API_KEY` in the server's `.env`

Every request needs the header `X-Agent-Key: $GRAPEVINE_AGENT_KEY`.
Calendar and interest writes act on the account named by `AGENT_USER_EMAIL`
in the server's `.env`.

## Search events

```
curl -s "$GRAPEVINE_URL/api/ext/v1/events?q=jazz&from=2026-07-10&free=true&limit=5" \
  -H "X-Agent-Key: $GRAPEVINE_AGENT_KEY"
```

Query params (all optional):

| param | meaning |
|---|---|
| `q` | free text over title/description/venue/tags |
| `category` | csv of: music, food, sports, arts, market, festival, community |
| `tags` | csv, substring-matched |
| `from`, `to` | YYYY-MM-DD (city-local), applied to each event's next occurrence |
| `free` | `true` → free events only |
| `min_rating` | 1–5 local-buzz floor |
| `exclude_promoted` | default `true` — drops paid placements |
| `near` | `"lng,lat"` or a place name (geocoded within the metro) |
| `max_km` | straight-line radius, only with `near` |
| `sort` | `time` (default), `buzz`, or `distance` |
| `limit` | up to 20 (default 8) |

Semantics: `next_start`/`next_end` are ISO 8601 and reflect the **next
occurrence** for recurring events (`recurs` explains the pattern, e.g.
"Weekly on Sat"); `when` is the same thing human-readable in city time.
`rating` is 1–5 local buzz — prefer ≥ 3.5. `promoted: true` means the source
read like a paid placement; treat it skeptically.

## Event details

```
GET /api/ext/v1/events/:id
```

Adds description, address, ticket_url, buzz rationale, and coordinates.

## Fix an event's rarity

```
curl -s -X POST "$GRAPEVINE_URL/api/ext/v1/events/:id/rarity" \
  -H "X-Agent-Key: $GRAPEVINE_AGENT_KEY" -H "Content-Type: application/json" \
  -d '{"rarity":"rare"}'
```

`rarity` is one of `rare` (one-off or annual specials: parades, fireworks,
races, big festivals), `notable` (uncommon but repeats), `common`
(weekly/regular). This drives the app's "Rare finds" filter — correct clear
mislabels only; the write applies immediately.

## Drive ETA

```
GET /api/ext/v1/eta?to=<event-id or lng,lat>&from=<lng,lat>
```

Traffic-aware; `from` defaults to the city center. Quote minutes, not km.

## Calendar (acts on the bound user's account)

```
GET    /api/ext/v1/calendar             # what's saved
POST   /api/ext/v1/calendar/:eventId    # save (syncs to Google Calendar when connected)
DELETE /api/ext/v1/calendar/:eventId    # remove
```

## Web discovery (search the web → verified events)

The server can build events from an AI web search. Every candidate is
verified against the page it came from — dates, venue, a supporting quote —
and only verified candidates can be added. The response separates `verified`
(with `confidence` and `evidence`) from `rejected` (with `reason`), plus
`pages_read` and `added`.

```
curl -s -X POST "$GRAPEVINE_URL/api/ext/v1/discovery/run" \
  -H "X-Agent-Key: $GRAPEVINE_AGENT_KEY" -H "Content-Type: application/json" \
  -d '{"query":"live jazz this month"}'
```

The city is appended to the query automatically. `dry_run` defaults to
**true** (verify and report, write nothing) — show the user what was found,
then re-run with `"dry_run": false` to commit the verified events. This is a
slow call (web search + page reads + two LLM passes); expect ~1-2 minutes.

### Scheduled searches

The server re-runs saved searches itself — prefer this over polling from
your side. `cadence_hours` is 1-336 (default 24; 168 = weekly). Saving an
existing query again just updates its cadence.

```
GET    /api/ext/v1/discovery/searches          # list, with last_run/status
POST   /api/ext/v1/discovery/searches          # {"query":"...","cadence_hours":24}
DELETE /api/ext/v1/discovery/searches/:id      # stop re-running it
```

Scheduled runs commit verified events automatically and appear in the app's
ingest history as kind "search". If you also keep your own cron job (e.g. an
OpenClaw scheduled task that reviews what discovery found each morning),
read `/api/ext/v1/events?from=...` rather than re-running discovery.

## Interests (feeds Grapevine's personal ranking)

```
curl -s -X POST "$GRAPEVINE_URL/api/ext/v1/interests" \
  -H "X-Agent-Key: $GRAPEVINE_AGENT_KEY" -H "Content-Type: application/json" \
  -d '{"addLoves":["jazz"],"addAvoids":["edm"]}'
```

Body keys: `addLoves`, `addAvoids`, `removeLoves`, `removeAvoids` — arrays
drawn ONLY from: live music, jazz, edm, comedy, theater, art, immersive,
markets, vintage, food trucks, coffee, beer, running, yoga, wellness,
outdoors, beach, water, baseball, family, fireworks, parade, nightlife,
dancing, networking, history. An open Grapevine tab picks changes up on its
next page load.

## Ground rules

- Only report events the API returned — never invent events, times, or ticket
  links.
- **Confirm with the user before** saving/removing calendar entries, changing
  interests, committing discovery results (`dry_run:false`), or scheduling /
  deleting a recurring search; report exactly what changed afterwards.
- Discovery results are machine-verified, not gospel: pass the `evidence`
  quote and `source_url` along so the user can judge, and never present a
  `rejected` candidate as a real event.
- 401 → key mismatch; 503 → the API is disabled server-side (`AGENT_API_KEY`
  or `AGENT_USER_EMAIL` unset). If the server is unreachable, say Grapevine
  isn't running (`npm run dev` in the repo) rather than guessing.

## Prefer MCP when available

The same tools (plus `discover_events`, `schedule_search`, …) are served over
Model Context Protocol at `POST $GRAPEVINE_URL/mcp` (Streamable HTTP). MCP
auth is OAuth 2.1 (browser sign-in via the server's consent page) for
interactive clients; headless runtimes send the same key as an `X-Agent-Key`
header. If your runtime speaks MCP, connect there instead of shelling out to
curl.
