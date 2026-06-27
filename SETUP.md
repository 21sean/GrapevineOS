# Grapevine setup and operations

Setup, deployment, and infrastructure notes. For what Grapevine is and how it
is built, see the [README](README.md).

## Quick start

```bash
npm install          # root (concurrently)
npm --prefix web install
npm --prefix server install

npm run dev          # api  -> http://localhost:8787
                     # web  -> http://localhost:5173
```

Requirements:

- **Node 22+**
- **[Ollama](https://ollama.com)** running locally with at least one chat
  model (`ollama pull qwen3:8b` works fine; pick it in Admin → Models)
- **Supabase**: copy `server/.env.example` to `server/.env` and set
  `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from your project's dashboard
  (Settings → API). For sign-in, also set `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_PUBLISHABLE_KEY` in `web/.env.local` and enable the
  Google/GitHub providers (see **Auth** below)
- **Mapbox**: a scoped public token (`pk.`, styles/tiles/fonts only) as
  `VITE_MAPBOX_TOKEN` in `web/.env.local`, and a secret token (`sk.`) as
  `MAPBOX_SECRET_TOKEN` in `server/.env`

## The email worker

The worker (`workers/email-ingest`) inserts each parsed email into the
`raw_emails` table; the local server polls unprocessed rows. No tunnel,
nothing to redeploy when your laptop's address changes, and it catches up on
anything that arrived while the machine was asleep. If the Supabase insert
ever fails, the worker dead-letters the raw email to the `RAW_EMAILS` KV
namespace (30-day TTL) so nothing is lost.

<p align="center">
  <img src="docs/email-worker.png" width="900" alt="Email ingestion pipeline: newsletters sent to a catch-all address hit Cloudflare Email Routing, then a Cloudflare Email Worker parses each message (the To: line becomes the source tag) and writes one idempotent row to the Supabase raw_emails table, which the local server polls for unprocessed rows. If the insert fails the worker dead-letters the raw email to a Cloudflare KV store with a 30-day TTL; an optional push mode can POST straight to the API for instant processing.">
</p>

**Point the catch-all at the worker** (Cloudflare dashboard, your zone):

> Email → Email Routing → Routing rules → **Catch-all** → Edit →
> Action **Send to Worker** → `grapevine-email-ingest` → Save. Make sure the
> catch-all rule is **enabled**.

**To deploy the worker (and after code changes):**

```bash
cd workers/email-ingest
export CLOUDFLARE_API_TOKEN=...    # "Edit Cloudflare Workers" token
export CLOUDFLARE_ACCOUNT_ID=...   # dashboard → Workers & Pages
npx wrangler secret put SUPABASE_SECRET_KEY   # once, same key as server/.env
npm run deploy
```

The poller config lives in `server/.env` (`INBOX_POLL_SECONDS`, default 60;
`INBOX_POLL=0` to pause it). Each tick is one indexed Postgres query, and
processed state lives on the row itself.

### Is it free?

Yes, end to end. **Email Routing** is free and unlimited. The **Workers free
plan** (100k requests/day) covers Email Workers. The **Supabase free tier**
(500 MB database, 5 GB egress) is orders of magnitude above this workload:
tens of newsletters a day, purged after 30 days. One caveat: free-tier
projects pause after about 7 days with no traffic; the poller's queries count
as traffic whenever the server is running, and the dashboard restores a
paused project in one click.

## The data store (Supabase)

All app data lives in a Supabase Postgres project (free tier): `events`,
`sources`, `users` (profiles for `auth.users`), `user_google_calendar`
(Vault-backed), `calendar_entries`, `event_reactions`, `chat_threads`,
`chat_messages`, `push_subscriptions`, `ingests`, `raw_emails`,
`app_settings`, `geocode_cache`.

- **Schema** is tracked in `supabase/migrations/`.
- **Access model**: RLS is enabled on every table with no policies and the
  Data API roles have no grants, so the posture is deny-all. Only the server
  and the email worker (secret key) can touch data; the browser talks to the
  Express API and uses Supabase solely for auth.
- **Secrets**: the Google Calendar refresh token lives in Supabase Vault,
  not a plaintext column; service-role-only RPCs are the read/write path.
- **Connections**: everything uses supabase-js/PostgREST over HTTPS. No raw
  Postgres connections, nothing to pool, free-tier friendly.
- **Housekeeping**: nightly pg_cron purges keep storage flat: raw emails
  (30d), push-send dedupe keys (60d), ingest logs (180d), and stale
  geocode *misses* (90d, so transient failures heal; hits live forever).
- **Types**: `server/src/db-types.ts` is generated. Regenerate after schema
  changes with
  `npx supabase gen types typescript --project-id <your-project-id>`.

## Auth (Supabase Auth: Google + GitHub)

Sign-in is **Supabase Auth** with the PKCE authorization-code flow,
industry-standard OAuth 2.1, run entirely by supabase-js in the browser.
The Express API never sees a password or provider secret for sign-in; it
verifies each request's `Authorization: Bearer` JWT **locally** against the
project's JWKS (asymmetric ES256 signing keys), so there's no auth-server
round trip per request.

- **Providers**: Google and GitHub today; Apple slots in later with one more
  button once a Services ID + signing key exist.
- **Identity model**: `auth.users` is the source of truth;
  `public.users` is a profile row (same uuid) kept in sync by a DB trigger,
  so every FK (`calendar_entries`, `event_reactions`, `chat_threads`,
  `push_subscriptions`) hangs off a stable id. Accounts with the same
  verified email are linked to one user automatically.
- **Google Calendar sync** is an incremental consent: a signed-in user
  clicks Connect, supabase-js re-runs the Google flow with the
  `calendar.events` scope + offline access, and the returned refresh token
  is handed to the server which stores it in **Supabase Vault** (encrypted
  at rest, libsodium AEAD). It is only readable through
  `security definer` RPCs granted to `service_role`; access tokens are
  minted on demand and cached in memory only.
- **Session state** lives with GoTrue (the old `sessions` table and its
  cron purge are gone).

One-time dashboard setup (Authentication → Sign In / Providers):

1. **Google**: create an OAuth client (Web) in Google Cloud Console with
   redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`, paste
   its client id/secret into the Google provider, and enable it. Enable the
   Google Calendar API on the same project; put the same id/secret in
   `server/.env` for token refresh.
2. **GitHub**: create an OAuth App (Settings → Developer settings) with the
   same callback URL, paste id/secret into the GitHub provider, enable it.
3. **URLs** (Authentication → URL Configuration): site URL
   `http://localhost:5174`, and add your production origin to the redirect
   allow-list when you deploy.

## Mapbox usage and free tier

- The browser uses a **scoped public token** (`pk.`, styles/tiles/fonts
  only) in `web/.env.local`.
- The **secret token** (`sk.`) never leaves `server/.env`; it powers
  geocoding and traffic-aware ETAs through `/api/geocode` and `/api/eta`.
- **Caching keeps you far under the free tier** (100k geocodes + 100k
  directions/mo): geocodes persist to the `geocode_cache` table forever
  (venues don't move; misses are cached too, so a bad venue string is billed
  once); ETAs cache for 10 minutes (traffic-aware); the browser additionally
  memoizes per session. Map rendering bills by monthly active user, not per
  tile.
- Consider adding URL restrictions to the pk token (Mapbox dashboard →
  Tokens) once you have a production domain.

## Running the production build locally

The API has no build step (tsx runs TypeScript directly); only the web app
compiles. Build it, start the API, then serve the bundle with Vite's preview
server:

```bash
npm run build                             # tsc -b && vite build → web/dist
npm --prefix server run start             # api -> http://localhost:8787
npm --prefix web run preview -- --port 5174   # web -> http://localhost:5174
```

Preview inherits the dev proxy, so `/api` is forwarded to the API
automatically. The `--port 5174` flag matters: `http://localhost:5174` is the
origin on the Supabase Auth redirect allow-list, so sign-in breaks on
preview's default port (4173). Stop the dev server first, since it holds the
same port.
