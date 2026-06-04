# Grapevine

**A live 3D map of the San Diego events locals actually go to.**

Ticketing sites are flooded with promoted, overpriced junk. Grapevine flips the
model: free local newsletters are the data source, a local LLM is the parser and
critic, and the map only surfaces what has real buzz - the parades, 5Ks, block
parties, and free shows that never make it onto Eventbrite's front page.

## Quick start

```bash
npm install          # root (concurrently)
npm --prefix web install
npm --prefix server install

npm run dev          # api  -> http://localhost:8787
                     # web  -> http://localhost:5173
```

Requirements: Node 22+, [Ollama](https://ollama.com) running locally with at
least one chat model (`ollama pull qwen3:8b` works fine - pick it in
Admin -> Models), and the Supabase secret key in `server/.env` as
`SUPABASE_SECRET_KEY` (see **Supabase** below).

## Running the production build locally

The API has no build step (tsx runs TypeScript directly); only the web app
compiles. Build it, start the API, then serve the bundle with Vite's preview
server:

```bash
npm run build                             # tsc -b && vite build -> web/dist
npm --prefix server run start             # api -> http://localhost:8787
npm --prefix web run preview -- --port 5174   # web -> http://localhost:5174
```

Preview inherits the dev proxy, so `/api` and `/auth` are forwarded to the API
automatically. The `--port 5174` flag matters: the Google OAuth client is
registered for `http://localhost:5174`, so sign-in breaks on preview's default
port (4173). Stop the dev server first - it holds the same port.

## How it works

```
newsletters ──> Cloudflare Email Routing (catch-all @sean.ventures)
                     │  each source gets its own address: sdtoday@, axios-sandiego@…
                     ▼
              Email Worker (workers/email-ingest)
                     │  parse -> INSERT into Supabase raw_emails
                     │  (KV dead-letter only if the insert fails)
                     ▼
              Supabase Postgres  (free tier, RLS deny-all)
                     ▲
                     │  server polls unprocessed rows - no tunnel, no inbound URL
   ┌──────────  Express API (server/) ─────────────┐
   │  inbox poll: raw_emails where processed_at    │
   │    is null -> extract -> stamp the row          │
   │  Ollama: extract events as strict JSON        │
   │  Ollama: 1-5 "local buzz" rating + promo flag │
   │  Mapbox (sk token): geocode (bbox-locked), ETA│
   │  store: supabase-js -> events, users, sessions,│
   │    calendar_entries, ingests, geocode_cache…  │
   └──────────────────┬────────────────────────────┘
                      ▼
        React + shadcn/ui + Mapbox GL (web/)
        3D night map · live pulse markers · carousel tour
        filters · interests · admin panel
```

### The data-source playbook (no paid APIs)

1. **Cloudflare Email Routing is free and unlimited.** Enable catch-all on your
   domain and every address at it just works - no per-address setup.
2. **Subscribe to each newsletter with its own address**
   (`sdtoday@sean.ventures`, `axios-sandiego@sean.ventures`…). The `To:` header
   becomes the source tag - attribution and dedup for free, at the inbox layer.
3. **The richest sources are pure event digests**: SDtoday (6AM City), Axios
   San Diego, San Diego Reader, Voice of San Diego's Culture Report, PACIFIC,
   Parks & Rec newsletters, neighborhood association blasts (Little Italy
   Association). They're written to be skimmed, so they parse cleanly.
4. **A local Ollama model does the rest**: extraction into typed JSON, venue
   geocoding (Mapbox, cached), a jaded-local 1-5 buzz rating, and a
   `promoted` flag for pay-to-play placements. Nothing leaves your machine.

You can also paste any newsletter into **Admin -> Ingest** at any time - same
pipeline, manual entry.

## Supabase (the data store)

All app data lives in a Supabase Postgres project (`hgkjlyggzrziylwazadc`,
free tier): `events`, `sources`, `users`, `user_google_tokens`, `sessions`,
`calendar_entries`, `ingests`, `raw_emails`, `app_settings`, `geocode_cache`.

- **Schema** is tracked in `supabase/migrations/` and already applied to the
  live project (migration history matches the files).
- **Access model**: RLS is enabled on every table with no policies and the
  Data API roles have no grants - deny-all. Only the server and the email
  worker (secret key) can touch data; the browser talks to the Express API.
- **Connections**: everything uses supabase-js/PostgREST over HTTPS - no raw
  Postgres connections, nothing to pool, free-tier friendly.
- **Housekeeping**: pg_cron purges expired sessions and 30-day-old raw emails
  nightly, so storage stays flat.
- **Types**: `server/src/db-types.ts` is generated - regenerate after schema
  changes with
  `npx supabase gen types typescript --project-id hgkjlyggzrziylwazadc`.
- **Setup**: copy the secret API key (dashboard -> Settings -> API) into
  `server/.env` as `SUPABASE_SECRET_KEY`. The legacy JSON stores under
  `server/data/` were migrated with `npm --prefix server run seed:supabase`
  (idempotent; safe to re-run) and are no longer read.

## Deploying the email worker

The worker inserts each parsed email into the `raw_emails` table; the local
server polls unprocessed rows. No tunnel, nothing to redeploy when your
laptop's address changes, and it catches up on anything that arrived while
the machine was asleep. If the Supabase insert ever fails, the worker
dead-letters the raw email to the `RAW_EMAILS` KV namespace (30-day TTL) so
nothing is lost.

**Point the catch-all at the worker** (dashboard, zone `sean.ventures`):

> Email -> Email Routing -> Routing rules -> **Catch-all** -> Edit ->
> Action **Send to Worker** -> `grapevine-email-ingest` -> Save. Make sure the
> catch-all rule is **enabled**.

**To deploy the worker (and after code changes):**

```bash
cd workers/email-ingest
export CLOUDFLARE_API_TOKEN=...   # "Edit Cloudflare Workers" token
export CLOUDFLARE_ACCOUNT_ID=97e28655beae5913f3adbe7cbea20514
npx wrangler secret put SUPABASE_SECRET_KEY   # once - same key as server/.env
npm run deploy
```

The poller config lives in `server/.env` (`INBOX_POLL_SECONDS`, default 60;
`INBOX_POLL=0` to pause it). Each tick is one indexed Postgres query - there
is no KV read budget to manage anymore, and processed state lives on the row
itself (`server/data/kv-processed.json` is gone).

### Alternative: push mode (tunnel / deployed API)

If you'd rather the worker POST straight to the API instead of polling, set
`INGEST_URL` in `wrangler.toml` `[vars]` to a reachable URL and
`npx wrangler secret put INGEST_KEY` (= `INGEST_SHARED_KEY` in `server/.env`),
then redeploy. For a local server, expose it with
`cloudflared tunnel --url http://localhost:8787` - but the quick-tunnel URL
changes on every restart, so you'd edit `wrangler.toml` and redeploy each time.
That fragility is exactly why pull mode is the default. The worker writes the
raw_emails row either way (dedupe makes double-processing harmless), so you
can run both at once.

### Is it free?

Yes, end to end. **Email Routing** is free and unlimited. The **Workers free
plan** (100k requests/day) covers Email Workers. The **Supabase free tier**
(500 MB database, 5 GB egress) is orders of magnitude above this workload -
tens of newsletters a day, purged after 30 days. One caveat: free-tier
projects pause after ~7 days with no traffic; the poller's queries count as
traffic whenever the server is running, and the dashboard restores a paused
project in one click.

## Mapbox usage & free tier

- The browser uses a **scoped public token** (`pk.`, styles/tiles/fonts only) -
  created via the tokens API, lives in `web/.env.local`.
- The **secret token** (`sk.`) never leaves `server/.env`; it powers geocoding
  and traffic-aware ETAs through `/api/geocode` and `/api/eta`.
- **Caching keeps you far under the free tier** (100k geocodes + 100k
  directions/mo): geocodes persist to the `geocode_cache` table forever
  (venues don't move - misses are cached too, so a bad venue string is billed
  once); ETAs cache for 10 minutes (traffic-aware); the browser additionally
  memoizes per session. Map rendering bills by monthly active user, not per
  tile.
- Consider adding URL restrictions to the pk token (Mapbox dashboard ->
  Tokens) once you have a production domain.


## App tour

- **Map** - Mapbox Standard style, night preset, pitched 3D. Live events pulse
  lantern-gold. Traffic layer toggles from the top bar. Markers are colored by
  category.
- **Carousel ("live tour")** - auto-flies between the top live events (falls
  back to today's upcoming when nothing is live), 9s per stop. Pause, step, or
  click through to details.
- **Feed & filters** - live-only, rare finds (parades/races/one-offs),
  hide-promoted (on by default), minimum buzz, category pills. Sorted by a
  personal score: buzz × interests × liveness − promo penalty.
- **Interests** - pillbox picker; "more like this" boosts, "less of this"
  hides matching events entirely (pick *yoga* there and yoga is gone).
- **Event detail** - buzz stars with the model's blunt rationale ("Re-check
  buzz" re-runs it), traffic-aware drive time, directions link, and the
  ticket-provider link when advance tickets are needed.
- **Admin -> Models** - Ollama health, active-model switcher (embedding models
  hidden), and a pull catalog of open-weights models grouped by lab with
  models.dev metadata and logos, streaming download progress.
- **Admin -> Ingest** - paste a newsletter, preview extracted events
  (geocoded + rated), approve which ones land on the map.
- **Admin -> Sources** - the per-source inbox addresses with copy buttons.

## Layout

```
web/       Vite + React 19 + TS + Tailwind v4 + shadcn/ui (dark-only)
server/    Express 5 + tsx · supabase-js data layer (src/store.ts)
workers/   email-ingest Cloudflare Email Worker -> Supabase raw_emails
supabase/  tracked SQL migrations (applied to the live project)
.agents/   installed Mapbox agent skills
```

## Roadmap ideas

- Reddit sentiment enrichment for buzz ratings (thread search -> model summary)
- Dedup embeddings via the already-installed `bge-m3` Ollama model
- Multi-city: everything reads from the `app_settings` row (`city`, `center`, `tz`)
- Serve map data straight from PostgREST (add anon SELECT policies on
  `events`/`sources`/`app_settings`) if the API ever moves off localhost
