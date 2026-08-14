# Mapbox Places API in Grapevine

Notes on the Places API (public preview, July 2026) as Grapevine uses it: what
the venue card is built from, and the two preview limits that shaped the
implementation. Mapbox states that the "API contract and response shape are
subject to change without prior notice", so treat this as a snapshot and check
[the upstream reference](https://docs.mapbox.com/api/search/places/) when
something stops lining up.

Code: [`server/src/places.ts`](../server/src/places.ts),
[`shared/hours.ts`](../shared/hours.ts),
[`web/src/components/venue/`](../web/src/components/venue/).

## What it gives us

The Details endpoint returns a Place record for a `mapbox_id`: a global set of
over 250 million POIs. Grapevine renders a projection of it under each event,
in the detail panel:

| Field on the record | Where it shows up |
|---|---|
| `name`, `primary_category`, `attributes.price_level` | venue heading and subtitle |
| `opening_hours` (OSM format) | "Open now, until 2 AM" |
| `photos[]` | photo strip (venue's own site, not a promoter's poster) |
| `attributes.accommodation_*` | accessibility list |
| `attributes.feature_*`, `attributes.service_*` | amenity badges |
| `telemetry.activity_score` | the busy-times chart |
| `score.popularity` | "Well known locally" |
| `phone`, `website` | call and venue-site buttons |
| `permanently_closed` | closure warning |

`telemetry.activity_score` is the interesting one. It is hourly busyness on a
0 to 100 scale, keyed `mon` through `sun` with 24 entries each, in local time,
and it is only present for venues with enough device activity (mostly US,
Canada, Western Europe). Grapevine lights the bars covering the event's own
hours, so the chart answers "what am I walking into at 8pm", not just "here is
a chart of a bar".

## The two preview limits

**Quota: 1,000 records per account per month.** A record counts when it is
successfully returned. This is small enough to change the design:

- Details are fetched lazily, only when a detail panel actually opens. Nothing
  in ingest or the schedulers touches the Places API.
- `server/src/places.ts` keeps a per-month counter and refuses to spend past
  `MAPBOX_PLACES_MONTHLY_CAP` (default 900, leaving headroom). The counter is
  per-process, so it is a safety rail, not an exact ledger.
- The endpoint is `/api/events/:id/venue`, keyed on an event id rather than a
  free-text venue name. An open `?venue=` proxy would let anyone spend the
  whole month's quota on arbitrary lookups.
- Every response carries the running count, so `curl`ing one venue tells you
  where you are against the cap.

**Storage: display only.** Mapbox states that data from this API "is for
temporary display and use only" and that storing it requires a separate
agreement. So the cache in `places.ts` is in-memory and deliberately does not
use the `geocode_cache` table or any other persistence. It evaporates on
restart by design. Do not "optimise" this into Postgres without an agreement
in place.

## Token scope

The Details endpoint needs the `places:read` scope, which is **not** on a
default secret token. Add it to the token used as `MAPBOX_SECRET_TOKEN`
(Mapbox account, Tokens, edit the token, tick `places:read`).

Without it the API returns 403. Grapevine reports that case as a configuration
answer rather than a failure: the endpoint returns `venue: null` with an
`unavailable` message, and the panel simply omits the venue card. Everything
else in the detail panel works exactly as before.

## How a venue is resolved

The Places API takes a `mapbox_id`, and Grapevine stores venue names. So there
are two hops:

1. Search Box `/search/searchbox/v1/forward` with the venue name, biased by the
   event's own coordinates, `types=poi`, `limit=1`. This endpoint is billed per
   request and needs no session token. It returns `properties.mapbox_id`.
2. Places `/places/v1/details/retrieve/{mapbox_id}`.

A match more than 500 m from the event's coordinates is discarded. Event
coordinates come from forward-geocoding a venue string so some slack is right,
but not enough to grab the bar across the street and present its hours as this
venue's.

Both hops are cached, and misses are cached too (briefly), so a venue with no
Places record does not re-spend the budget every time its panel opens.

## Opening hours

`opening_hours` comes back as an OSM string, for example
`Mo-Th 11:00-22:00; Fr-Sa 11:00-02:00; Su off`.

The server passes it through untouched and the client evaluates it, because
the server caches records for 12 hours and a server-computed "open now" would
be stale within minutes. The parser is `shared/hours.ts`, shared by both
runtimes the same way `shared/recurrence.ts` is.

It covers the subset real venues use: weekday ranges and lists, several spans a
day, spans running past midnight, `off`, and `24/7`. Anything more exotic
(public holidays, month ranges, `sunset`) parses to null, and the card shows
the raw string verbatim instead of guessing.

The parser is the one part of this feature that is our own logic rather than a
projection of a Mapbox response, so it has assertions:

```
npm --prefix server run hours:eval
```

## What the data is actually like

Worth knowing before wondering whether something is broken, measured against
real San Diego venues:

- **Photos are usually absent.** They default to images indexed from the POI's
  own website, and expanded access needs a sales agreement. Every venue tested
  returned zero. The photo strip is written and correct, but it will rarely
  appear.
- **Busy times are sparse.** Roughly one venue in four had `telemetry`.
  Restaurants and bars with real foot traffic have it; parks, zoos, and
  chain locations often do not.
- **Not every Search Box POI has a Places record.** Search Box returns two id
  families: UUID-backed ids that resolve, and OSM-derived ones
  (`urn:mbxpoi:mapbox-n371399`) that the Details endpoint rejects with 422.
  Petco Park is one of the latter. When the best-matching venue has no usable
  record, Grapevine shows no card rather than falling through to the next
  candidate, which would put a neighbouring taco stand's hours on the stadium.
- **Attributes are plentiful but mostly noise.** A record carries around forty
  flags. `places.ts` ranks the ones that change a going-out decision
  (`known_with_locals`, `offering_live_music`, `environment_cozy`) and drops
  the ones every venue has (`feature_restroom`, `feature_seating`).
- **Venue hours are not event hours.** The zoo's Places record says it closes
  at 6 PM while its Nighttime Zoo event runs to 9 PM. Both are shown, and the
  card is labelled as venue data, because that is what it is.

## Other endpoints

Grapevine already used Mapbox for geocoding, directions, and isochrones in
[`server/src/mapbox.ts`](../server/src/mapbox.ts). Those are unchanged, keep
their own caches (geocoding is cached permanently in `geocode_cache`, which is
allowed for the Geocoding API), and are unaffected by the Places quota.
