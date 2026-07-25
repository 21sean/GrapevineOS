# Features & Logic Audit

An audit of redundant features, duplicated/disorganized code, and logic errors
across the server, workers, and web client. Every finding below was verified
against the code at the referenced location; line numbers are as of this
audit's commit.

Severity legend: **HIGH** = user-visible wrong behavior or data loss,
**MED** = incorrect behavior in edge cases or drift-prone duplication,
**LOW** = hygiene, dead code, minor inconsistency.

---

## 1. Correctness: data pipeline (ingest → dedupe → enrich)

### 1.1 HIGH — `addEvents` never updates on conflict, contradicting its own contract
`server/src/store.ts:30-39, 247-252`

The dedupe comment promises that re-ingesting a recurring event "updates the
one series row," and the docstring says duplicates key on "title + start
date." The implementation does neither:

```ts
.upsert(batch.map(eventToRow), { onConflict: "dedupe_key", ignoreDuplicates: true })
```

`ignoreDuplicates: true` compiles to `ON CONFLICT DO NOTHING` — on a key
collision the incoming row is silently discarded. A newsletter that re-sends
an event with a corrected time, venue, or price never updates the stale row.
This also silently defeats `discovery.ts`'s `applyFixes` ("corrected"
verdicts) and inbox reprocessing whenever the corrected event hashes to an
existing `dedupe_key`. Either switch to a real update or fix the comments to
say "first write wins."

### 1.2 HIGH — Dedupe key derives the day from the raw ISO offset, not the city-local day
`server/src/store.ts:38`, also `slugId` in `server/src/ingest.ts`

```ts
return rule ? `${title}|${rule}` : `${title}|${e.start.slice(0, 10)}`;
```

The extraction prompt allows any ISO offset, so the same instant can arrive
as `2026-07-11T23:00:00-07:00` from a newsletter (day slice `2026-07-11`) and
`2026-07-12T06:00:00Z` from web discovery (day slice `2026-07-12`) — two
different keys, the same event on the map twice. Conversely, two genuinely
different same-title events on the same day (a 6pm and a 9pm showing)
collapse to one key, and the in-batch `seen` filter (`store.ts:223-229`)
drops the second outright. The day should be computed in `settings.tz`
(a `dayInTz` helper already exists in `agent/context.ts`).

### 1.3 HIGH — Transient geocode failure permanently drops events
`server/src/mapbox.ts:112-113`, `server/src/ingest.ts:121-127`, `server/src/inbox.ts:43-65`

`geocode` returns `null` on any non-OK response (429/5xx included), and
`extractEvents` responds with `if (!hit) continue;` — the event is dropped.
`processEmail` then stamps the row `processed_at` with `error: null` as long
as extraction didn't throw, and retry logic only revisits rows where
`processed_at IS NULL`. A Mapbox rate-limit mid-ingest loses those events
forever while reporting success. Partial extraction is treated as full
success; geocode failures should either fail the row or queue the affected
events for retry.

### 1.4 MED — The email worker's "idempotency key" is wall-clock time
`workers/email-ingest/src/index.ts:41-43, 93-95`

```ts
receivedAt: new Date().toISOString(),  // generated at processing time
const key = `${payload.receivedAt}_${to.split("@")[0]}`;
```

The comment claims "the unique email_key makes worker retries/redeliveries
idempotent," but `receivedAt` is minted fresh on every invocation, so a
Cloudflare redelivery of the same message gets a new key → a second
`raw_emails` row → a second full LLM extraction pass. The key needs a stable
input (Message-ID header or a hash of the raw body).

### 1.5 MED — Discovery "corroboration" counts duplicate candidates, not distinct pages
`server/src/discovery.ts:285-292, 330`

The verification gate lowers the required verifier confidence from 0.7 to 0.5
for events "found via 2+ pages," but the count is over all extracted
candidates: if one page (or one model response) emits the same event twice,
it counts as corroborated from a single source. The count is also built
before `hardReject`, so rejected candidates still inflate the corroboration
of a same-key survivor. Count `new Set(pageUrls)` per key instead.

---

## 2. Correctness: time, recurrence, and calendar

### 2.1 HIGH — ICS export shifts recurring events to the wrong weekday
`server/src/ics.ts:22-25, 51-59`; contrast `server/src/gcal.ts:86-90`

`vevent` emits `DTSTART` as a UTC instant (`...Z`) while shipping the
normalized `RRULE` (e.g. `FREQ=WEEKLY;BYDAY=SA`) unchanged. `BYDAY` was
normalized from the event's *local* weekday, but a Z-suffixed `DTSTART`
makes calendar clients expand `BYDAY` against UTC weekdays. A Saturday
19:30 PDT event is Sunday 02:30 UTC, so the exported series lands on the
wrong local day for every future occurrence. Every evening event in a
negative-UTC-offset zone is affected. The Google path is correct because
`gcalBody` sends `{ dateTime, timeZone }`; ICS should emit
`DTSTART;TZID=<tz>` with a `VTIMEZONE` block to match.

### 2.2 MED — Fixed 24-hour day stepping mis-times reminders across DST
`server/src/recurrence.ts:95, 175-197`; consumed by `server/src/push.ts:212-214, 268-283`

Occurrences advance by exact `DAY_MS` multiples, so after a DST transition
the computed wall-clock start shifts by ±1h. The recurrence comment accepts
this for display, but the push scheduler consumes the same shifted instant:
"45 minutes before start" reminders and leave-by departure alerts fire up to
an hour off for the first occurrences after each transition.

### 2.3 MED — `BYMONTHDAY` is parsed, validated, stored — and never used
`server/src/recurrence.ts:90, 130-143, 204-216`; same in `web/src/lib/recurrence.ts`

Monthly/yearly expansion just steps months from the anchor and preserves the
anchor's day-of-month. `FREQ=MONTHLY;BYMONTHDAY=15` anchored on the 3rd
expands to the 3rd of every month. `normalizeRRule` happily persists such
rules, so the agent/LLM path can create rules the engine silently misreads.

### 2.4 MED — Monthly recurrence overflows short months
`server/src/recurrence.ts:208-215`; same in `web/src/lib/recurrence.ts:154-161`

`d.setMonth(d.getMonth() + n)` rolls Jan 31 + 1 month to Mar 2/3 and
Apr 31 to May 1 — phantom occurrences on garbage dates for every short
month in a "monthly on the 31st" series.

### 2.5 LOW — Other confirmed time bugs
- `web/src/lib/time.ts:101-107` — `dayLabel` derives "tomorrow" by adding a
  literal 86,400,000 ms; on 25-hour fall-back days a Monday event never
  labels "Tomorrow" (the file's other helpers correctly use the noon-anchor
  trick; only `dayLabel` doesn't).
- `server/src/recurrence.ts:185-202` (and the web copy) — weekly rules with
  `INTERVAL>1` and multiple `BYDAY`s attribute next-week deltas to the
  current interval week, emitting an occurrence in a skipped week.
- Weekly anchors whose weekday isn't in `BYDAY` are dropped by the app's
  expansion but kept (per RFC 5545) by ICS/Google exports — in-app "next
  occurrence" and the exported calendar disagree by one instance.

---

## 3. Correctness: agent surfaces (in-app / REST / MCP)

The README claims "the same tools are exposed three ways." That is true only
of the underlying executors (`agent/context.ts`, `calendar.ts`,
`discovery.ts`). There is **no shared tool registry**: each surface
hand-rolls its own tool list, schema format (Zod vs ad-hoc parsing vs
hand-written JSON Schema), tool set, and — critically — guardrail and
confirmation coverage. The drift is already observable:

### 3.1 HIGH — Discovery feeds untrusted web text to the LLM with no injection scan
`server/src/discovery.ts:242, 251`; contrast `server/src/agent/tools.ts:100-152`

The in-app `search_web`/`read_page` tools run every snippet and page through
`scanText` (Prompt Guard) and withhold malicious content. `discovery.ts`
calls the raw `webSearch`/`readPage` and pipes page text straight into LLM
extraction — `scanText` appears nowhere in the file. This is the app's
largest untrusted-web-to-LLM funnel, reachable from MCP
(`discover_events`), the external REST API, and the internal API, and it
skips the rail the README advertises as covering "all fetched web content."

### 3.2 HIGH — `update_interests` loses its confirmation step (and changes casing) off-app
`server/src/agent/tools.ts:347-382` vs `server/src/mcp.ts:356-381` and `server/src/agent/index.ts:649-689`

In-app, the tool only *proposes* (`proposeInterests` → user confirms) and
takes snake_case args with a required `reason`. The MCP and REST versions
take camelCase args, no reason, and write `updateUserPrefs` immediately.
Same story for calendar saves (`propose_calendar`/`save_calendar` split
in-app; unconditional writes on MCP `save_event` and REST
`POST /calendar/:eventId` — the only "confirmation" is advisory prose in
`openclaw/skills/grapevine/SKILL.md`). The human-in-the-loop guarantee
exists on one of three surfaces.

### 3.3 HIGH — `dry_run` has opposite defaults and different names per surface
`server/src/index.ts:348` vs `server/src/agent/index.ts:610` and `server/src/mcp.ts:308`

```ts
// internal:  omitted flag → COMMITS
runDiscovery({ query, commit: !req.body?.dryRun })
// external REST + MCP:  omitted flag → DRY RUN
runDiscovery({ query, commit: req.body?.dry_run === false })
```

Each default is individually documented, but a caller sending `dry_run` to
the internal route (or `dryRun` to the external ones) has the flag silently
ignored and gets the *opposite* of what it asked for — the internal route
would commit a request that said `{ dry_run: true }`.

### 3.4 MED — Duplicated tool schemas already diverging
- MCP hardcodes the category enum (`mcp.ts:76`) instead of deriving from
  `CATEGORIES` (`types.ts:193`) the way the Zod schema does (`tools.ts:55`)
  — any category edit silently desyncs MCP.
- `get_eta` takes `to: [lng, lat]` in-app but `"lng,lat"` string on MCP/REST.
- `unschedule_search` deletes by query on MCP but only by id on REST; the
  web API alone has `PATCH /api/discovery/searches/:id`, so external agents
  can create schedules they cannot pause.

### 3.5 LOW — Output rail can't undo side effects
`server/src/agent/graph.ts:185-224`, `server/src/agent/index.ts:286-317`

Tool writes (calendar, rarity) commit during the run; the persona output
rail only replaces the streamed *text* on a trip. The streaming scan itself
is correctly ordered (64-char lookahead + tail re-check) — the gap is that a
tripped turn's DB writes stand.

---

## 4. Redundant / duplicated code (the "two of everything" list)

These are the main sources of drift. Each pair has already diverged or
carries a "keep in sync" comment in lieu of sharing code.

| # | Duplication | Locations | Status |
|---|---|---|---|
| 4.1 | **Entire recurrence engine** (~180 lines: parser, expansion, summary) | `server/src/recurrence.ts` ↔ `web/src/lib/recurrence.ts` | Hand-synced ("keep in sync" comments); bugs 2.2–2.4 exist twice |
| 4.2 | **Domain types** (`CityEvent`, `Settings`, `Source`, unions) | `server/src/types.ts` ↔ `web/src/lib/types.ts` ↔ `server/src/db-types.ts` | Already drifted: `LlmProviderId` vs `ChatProviderId`, `ChatMessage` vs `ChatMessageRec`, `REACTIONS` vs `REACTION_META` |
| 4.3 | **Buzz-rating prompt** | `server/src/ingest.ts` extraction fields ↔ `RATING_SYSTEM`/`rateEvent` (`ingest.ts:164-195`) | Same "jaded local" rubric twice; one caps rationale at 160 chars vs prompt's 140 |
| 4.4 | **JSON-salvage parsing** | `server/src/ollama.ts:116-126` ↔ `server/src/providers.ts:394-411` | Ollama path lacks the brace-span fallback, so identical model output parses via CLI providers but fails via Ollama |
| 4.5 | **Ingest glue** (extract → add → log → enrich) | `inbox.ts:43-65`, `index.ts:276-317`, `discovery.ts:367-379` | Four copies with per-path quirks (manual paste stores `sourceKind:"newsletter"` but logs `kind:"manual"`) |
| 4.6 | **Provider id registry** | `types.ts:72-80` ↔ `providers.ts:25,41` ↔ `store.ts:42-46` (`coerceProvider` hardcodes the list) | Adding a provider requires three edits, no compile-time link |
| 4.7 | **Discovery API + cadence clamp** | `index.ts:337-411` ↔ `agent/index.ts:606-647` ↔ `mcp.ts` — clamp copied 3× verbatim | Inconsistent capability sets (see 3.4) |
| 4.8 | **Calendar body builders** | `gcal.ts:74-91` ↔ `ics.ts:47-62` | Already diverged: Google description includes "via Grapevine (source)", ICS omits it |
| 4.9 | **Interest-merge + bound-user resolution** | `agent/index.ts:664-680, 470-484` ↔ `mcp.ts:366-378, 228-235` | Verbatim copies |
| 4.10 | **Relative-time formatters** | `AccountDialog.tsx:800-814` (`timeAgo`) ↔ `AgentChat.tsx:379-391` (`threadAge`) | Same ladder, cosmetic label differences; belongs in `lib/time.ts` |
| 4.11 | **Filter toggle controls** | `FilterRail.tsx:116-154, 361-398` ↔ `MobileDock.tsx:214-293` | Live/rare/free/promoted/farmers wired twice, incl. two copies of the farmers tri-state machine |
| 4.12 | **`interestTerms` + day helpers** | `score.ts:13-15` re-inlined in `AccountDialog.tsx:185-188`; `parseDay`/`toDay` in `DateFilters.tsx:28-32` duplicate `time.ts` idioms | Byte-for-byte re-implementations next to the exported originals |
| 4.13 | **Scoring affinity** | `server/src/digest.ts:26` (`tagAffinity`) ↔ `web/src/lib/derived.ts` (`selectTagAffinity`) | Another "mirrors X, keep in sync" pair |

---

## 5. Web client logic errors

### 5.1 HIGH — Account stats disagree with the actual map
`web/src/components/AccountDialog.tsx:183-199`

The "on your map" stat re-derives visibility inline with `matchesFilters`,
which ignores `hiddenIds` — hidden events are counted as "on your map." The
real definition of visible is `selectVisible` (`derived.ts:93`). The
adjacent `boosted`/`hidden` stats likewise re-derive by raw loves/avoids
membership instead of `scoreEvent`, so the numbers can disagree with the
ranking they summarize.

### 5.2 HIGH — Carousel "live" badge is the only tz-unaware `isLive` call
`web/src/components/CarouselOverlay.tsx:53`

```ts
const live = useGrapevine((s) => (event ? isLive(event, s.now) : false))
```

Every other call site passes `s.settings?.tz ?? "UTC"`. For recurring events
with the browser in a different zone than the city, the tour selects an
event as live (tz-aware) while the card labels it "Up next" (tz-unaware).

### 5.3 MED — Filter-count badge counts the wrong set
`web/src/lib/score.ts:79-86`, rendered at `FilterRail.tsx:166-170` and `MobileDock.tsx:287-291`

The badge sits on the collapsed "Filters" disclosure (buzz + categories) but
counts `freeOnly` and the date window — which live *outside* the disclosure
— while omitting `liveOnly`, `rareOnly`, `farmers`, and `hidePromoted`. The
number matches neither "filters in this section" nor "all active filters."

### 5.4 MED/LOW — Smaller confirmed issues
- `AgentChat.tsx:719-755` — `CalendarCard.saveAll` loops `calendarAdd`
  sequentially; a mid-loop failure skips `setCalendar`, desyncing local
  state from server-side adds that already succeeded.
- `InterestsDialog.tsx:26-31` — the open-sync effect depends on the whole
  `interests` object, so any external prefs change while the dialog is open
  clobbers unsaved edits; should seed on `[open]` only.
- `hooks/useEta.ts:11, 34-36` — session-permanent ETA cache with no TTL,
  presented as live traffic-aware drive times.
- `AgentChat.tsx:664` — module-global `refreshedOnce` means only the first
  unknown event chip per page load triggers a catalog refresh; later chips
  (e.g. from `loadThread` on old transcripts) degrade to plain text.
- `admin/ProviderLogo.tsx:19` — the only raw `fetch` bypassing the `api.ts`
  wrapper (no auth header if the route ever becomes gated).
- `store.updateEvent` (`store.ts:255-292`) skips the `ends_at >= starts_at`
  clamp that `eventToRow` applies, so a future caller patching times can
  trip the DB check constraint.

---

## 6. Dead / vestigial code and dependency hygiene

- **`server/data/*.json` is a dead store.** No runtime code reads it — only
  the one-time `scripts/seed-supabase.ts`. `settings.json` is already in the
  pre-Supabase schema (missing `chatProvider`/`extractProvider`). Move under
  `scripts/seed-data/` or delete post-seed so it isn't mistaken for live
  state.
- **Unused web dependencies:** `date-fns`, `shadcn` (a CLI, not a library —
  shouldn't be a runtime dep), and `@fontsource-variable/geist` are declared
  in `web/package.json` but imported nowhere.
- **`GET /api/geocode`** (`index.ts:178-186`) has no client caller; the
  function it wraps is used internally, but the HTTP route is dead.
- **`digest.ts:48, 94`** — `scoreFor` penalizes `promoted` events that line
  94 has already filtered out; dead branch.
- **`store.updateDiscoverySearch`** accepts a `query` patch no route ever
  sends.
- **Worker inconsistencies:** `workers/email-ingest` POSTs the full email
  body to `/api/ingest/inbound`, which ignores the body entirely (it only
  kicks the processor); `wrangler.toml` still documents the retired polling
  model; `INBOX_POLL` + `INBOX_POLL_SECONDS` form a confusing double flag.
- **`openclaw/`** contains a single Markdown skill doc — an external API
  contract in prose that already drifted (documents no `PATCH` route,
  presents the confirmation policy as enforced when it isn't).

---

## 7. Organization

- **God components:** `AccountDialog.tsx` (903 lines) mixes identity, stats,
  pinned events, Google/Apple calendar sync, the entire Web Push
  subscribe/permission flow, taste summary, and inbox history — the push
  block is a ready-made `usePush` hook, the inbox block a standalone
  component. `AgentChat.tsx` (888 lines) mixes the ⌘K shell, thread history,
  a hand-rolled markdown renderer, and two proposal cards that own their own
  API calls.
- **Inconsistent code-splitting:** `App.tsx` lazy-loads `AdminSheet`,
  `CalendarDialog`, and `WeekDigest`, but `AccountDialog` — the largest
  dialog — is statically imported in `TopBar`, shipping in the main chunk.
- **Inconsistent error contract:** `GET/PUT /api/settings` and
  `GET /api/sources` (`index.ts:106-130`) skip the try/catch → JSON-502
  pattern every sibling data route uses, so DB failures there return
  Express's HTML 500 to a client expecting structured JSON.
- **Redundant guards:** `TopBar` renders `AccountDialog` only when signed
  in, and `AccountDialog` also early-returns on `!user`.

---

## Suggested priority order

1. **Data integrity:** fix the dedupe key to use the city-local day (1.2),
   decide update-vs-ignore on conflict and make the code match the comment
   (1.1), stop marking emails processed when geocoding dropped events (1.3),
   and derive the worker `email_key` from a stable message id (1.4).
2. **Guardrail/confirmation parity:** run discovery page text through
   `scanText` (3.1); unify the three tool surfaces behind one registry so
   confirmation semantics, schemas, and defaults can't diverge (3.2–3.4).
3. **Calendar correctness:** emit `DTSTART;TZID` + `VTIMEZONE` in ICS (2.1);
   fix DST stepping before it mis-fires reminders (2.2).
4. **De-duplicate the hand-synced pairs** (§4) — the recurrence engine and
   the domain types first, since both already carry known bugs in two
   copies. A shared package (or a `shared/` source folder both tsconfigs
   include) removes the whole class.
5. **Web client consistency:** compute account stats from `selectVisible`
   (5.1), pass tz to the carousel's `isLive` (5.2), rationalize the filter
   badge (5.3), then split the two god components (§7).
