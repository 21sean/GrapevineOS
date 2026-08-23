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
- The endpoint is `/api/events/:id/venue`, keyed on an event id rather than a
  free-text venue name. An open `?venue=` proxy would let anyone spend the
  whole month's quota on arbitrary lookups.
- Storage is the real quota control: records are keyed by `mapbox_id` in
  Postgres and kept, so every event at that venue, every restart, and every
  server process share one fetch. Misses are stored too.
- Mapbox is the ledger. When the account quota is gone the API answers 429,
  which surfaces the same way a missing scope does: `venue: null` with an
  `unavailable` message, and the card is omitted.

**Storage: display only.** Mapbox states that data from this API "is for
temporary display and use only" and that storing it requires a separate
agreement. Grapevine stores it anyway, deliberately: `place_details` is
permanent, nothing purges it, and a stored record is always served. Only the
projected fields the card renders are kept — never the whole record — and age
decides refresh rather than expiry, so a venue is re-fetched about monthly and
never disappears from the panel in between. If you are running this against a
Mapbox account whose terms you need to honour to the letter, that is the
decision to revisit.

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

How far a candidate may sit from the event depends on how much its name proves,
because an event's coordinates are corroboration rather than truth:

| Candidate name vs the venue | Accepted within |
|---|---|
| exact, or one contains the other | 25 km (metro scale) |
| unrelated | 500 m |

Candidates are then ranked name-first, distance-second, so a nearby exact match
still beats a far one.

The wide radius exists because event coordinates are geocoded from whatever
address the newsletter printed, and that address is sometimes wrong. Every
seeded Observatory North Park show carried a downtown address, 4.6 km from the
venue named in its own title: on a flat 500 m rule the busiest venue in the
city silently had no card, and nothing said why. A name match is stronger
evidence than a coordinate here, so it wins.

The tight radius still applies to venues whose name proves nothing ("Bayard St
between Garnet Ave and Hornblend St") — those have only the coordinates going
for them, and letting them roam would put a POI across town on the card.

## Where the cache lives

Both hops are cached in Postgres, in two tables that also carry the geocoding
cache (`supabase/migrations/20260729170913_places_cache.sql`):

| Table | Key | Holds |
|---|---|---|
| `place_lookups` | `(kind, query)` | `kind='geocode'`: lng/lat for a venue string (this was `geocode_cache`). `kind='poi'`: the Search Box `mapbox_id` for a venue near an event. |
| `place_details` | `mapbox_id` | The projected record the card renders. |

Keying details by `mapbox_id` rather than by query is the point: two events at
the same bar, spelled two different ways, resolve to one id and share one
fetch. Misses are stored at both hops — a venue Search Box doesn't know, and an
id the Details endpoint rejects — and re-asked hourly, so a venue with no data
costs one lookup an hour instead of one per panel open.

Reads go through the `venue_cache(p_query)` function, which left-joins the two
tables, so an open costs a single round trip whether the venue is warm, cold,
or a remembered miss. Concurrent opens of the same cold venue are deduped in
process, so a link doing the rounds buys the record once.

Retention: hits live forever — both the resolution (venues don't move) and the
record itself. Only *misses* are purged, after 90 days, so a transient Mapbox
failure can't pin a venue as unresolvable and a POI that gains a record later
is picked up.

## Opening hours

`opening_hours` comes back as an OSM string, for example
`Mo-Th 11:00-22:00; Fr-Sa 11:00-02:00; Su off`.

The server passes it through untouched and the client evaluates it: records are
stored and re-served for weeks, so a server-computed "open now" would be stale
almost immediately. The parser is `shared/hours.ts`, shared by both runtimes
the same way `shared/recurrence.ts` is.

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
[`server/src/mapbox.ts`](../server/src/mapbox.ts). They are unaffected by the
Places quota. Geocoding shares the `place_lookups` table described above and is
still cached permanently, which is allowed for the Geocoding API; ETAs and
isochrones stay in memory on a 10-minute TTL because they are traffic-aware.
