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
  model (`ollama pull qwen3:8b` works fine; pick it in Admin → Models).
  No GPU? Chat and/or newsletter extraction can instead run through a
  subscription-authed CLI — Claude Code (`claude -p`), OpenAI Codex, Gemini
  CLI, or GitHub Copilot CLI — picked per role in **Admin → Providers**; each
  logs in with its own account, no API keys
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

Processing is event-driven: the worker pings `/api/ingest/inbound` after each
insert (set `INGEST_URL`/`INGEST_KEY` in the worker to your tunnel or deploy
URL) and the server extracts the new row right away, so the local model isn't
woken on a timer. A backlog pass runs once at startup. Where the worker can't
reach the server, set `INBOX_POLL_SECONDS` in `server/.env` to also poll on a
timer. Processed state lives on the row itself.

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
`discovery_searches`, `app_settings`, `geocode_cache`.

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
  server-side geocoding (during ingest) and traffic-aware ETAs through
  `/api/eta`.
- **Caching keeps you far under the free tier** (100k geocodes + 100k
  directions/mo): geocodes persist to the `geocode_cache` table forever
  (venues don't move; misses are cached too, so a bad venue string is billed
  once); ETAs cache for 10 minutes (traffic-aware); the browser additionally
  memoizes per session. Map rendering bills by monthly active user, not per
  tile. Leave-by departure alerts reuse the same cached `/api/eta` path and
  only price events starting within the next three hours.
- Consider adding URL restrictions to the pk token (Mapbox dashboard →
  Tokens) once you have a production domain.

## Web discovery (scheduled searches)

Web discovery (Admin → Discover; `discover_events` over MCP;
`/api/ext/v1/discovery/*` over REST) needs no keys: search uses SearXNG when
`SEARXNG_URL` is set and falls back to keyless DuckDuckGo scraping, and both
extraction and verification run through the provider picked in
**Admin → Providers** (local Ollama by default). Tuning lives in `server/.env`:

- `DISCOVERY_MIN_CONFIDENCE` (default `0.7`) — verifier confidence a
  candidate needs before it can be added; candidates corroborated by 2+
  independent pages clear `0.5`.
- `DISCOVERY_TICK_SECONDS` (default `300`) — how often the scheduler checks
  whether a saved search is due. Each check is one cheap query; runs
  themselves are serialized and never overlap.
- `DISCOVERY_SCHEDULE=0` — disable the scheduler entirely (one-off runs from
  the admin UI / MCP / REST still work).

A run reads at most a handful of pages and makes one extraction plus one
verification LLM call per readable page, so a daily cadence is light even on
a laptop GPU.

## MCP for Claude Desktop / claude.ai (custom connector, OAuth)

The MCP endpoint speaks real OAuth 2.1, with Supabase Auth as the
authorization server — the same accounts that sign in on the web app. Adding
the connector is: paste the `/mcp` URL, a browser window opens, sign in with
Google/GitHub, approve. No key ever appears in the dialog or the URL. Under
the hood: the server answers unauthenticated requests with `401` +
`WWW-Authenticate: resource_metadata` (RFC 9728), Claude discovers Supabase's
authorization server from it (RFC 8414), registers itself via dynamic client
registration (RFC 7591), and runs the PKCE authorization-code flow through
the app's `/oauth/consent` page.

One-time Supabase dashboard setup (plus the URL config from the auth section
above):

1. **Authentication → OAuth Server**: enable the OAuth 2.1 server (beta),
   set **Authorization Path** to `/oauth/consent`, and enable **dynamic
   client registration** (that's what lets connectors register themselves —
   without it you'd pre-register each client by hand).
2. **Authentication → URL Configuration**: the Site URL must be the origin
   that serves the web app (`http://localhost:5174` in dev, your production
   origin when deployed) — the consent page lives at Site URL +
   `/oauth/consent`. Add `<origin>/oauth/consent` to the redirect allow-list
   so mid-consent sign-in can land back there.

Then expose the endpoint (connectors dial in from Anthropic's side, so it
needs public HTTPS):

1. Expose the API server: `cloudflared tunnel --url http://localhost:8787`
   (or ngrok, or a reverse proxy on a deployed box).
2. Set `MCP_PUBLIC_URL=https://<your-tunnel-host>` in `server/.env` so
   Admin → Providers advertises the right endpoint, and restart.
3. In Claude Desktop or claude.ai: Settings → Connectors → **Add custom
   connector** → URL `https://<your-tunnel-host>/mcp`. Sign in and approve
   when the browser window opens.

Claude Code on the same machine skips the tunnel:
`claude mcp add --transport http grapevine http://localhost:8787/mcp`, then
`/mcp` inside Claude Code to run the same sign-in.

Once connected, Claude can search events, get details and ETAs, save to the
calendar, tune interests, fix rarities, run verified web discovery, and
manage scheduled searches. Writes act on the account that signed in.
Headless scripts (no browser) can still send `AGENT_API_KEY` as an
`X-Agent-Key` header; those writes act on `AGENT_USER_EMAIL`. `MCP_OPEN=1`
drops auth entirely for local tinkering.

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
