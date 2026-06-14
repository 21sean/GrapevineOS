---
name: grapevine
description: >
  Query the user's local Grapevine server for San Diego events: search what's
  on (tonight, this weekend, by vibe/category/tag), get full event details,
  traffic-aware drive ETAs, and manage the user's saved-events calendar and
  interests. Use whenever the user asks what's happening in San Diego, wants
  plans, asks if they can make it to an event, or wants an event saved.
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
- **Confirm with the user before** saving/removing calendar entries or
  changing interests; report exactly what changed afterwards.
- 401 → key mismatch; 503 → the API is disabled server-side (`AGENT_API_KEY`
  or `AGENT_USER_EMAIL` unset). If the server is unreachable, say Grapevine
  isn't running (`npm run dev` in the repo) rather than guessing.
