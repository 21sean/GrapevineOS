-- Grapevine initial schema: migrates the server/data/*.json stores and the
-- RAW_EMAILS Cloudflare KV namespace into Postgres.
--
-- Access model: every read/write goes through the Express server (or the
-- email worker) using the secret API key. RLS is enabled on every table with
-- NO policies, and anon/authenticated grants are revoked — deny-all for the
-- Data API. If the web app ever reads Supabase directly, add explicit
-- policies + grants then.

create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------

create type public.event_category as enum
  ('music', 'food', 'sports', 'arts', 'market', 'festival', 'community');

create type public.event_rarity as enum ('common', 'notable', 'rare');

create type public.event_source_kind as enum ('seed', 'newsletter', 'manual');

create type public.ingest_kind as enum ('email', 'manual');

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- sources — newsletter/inbox registry. Ingestion auto-registers unknown
-- slugs (active = false) so events.source_id always resolves.
-- ---------------------------------------------------------------------------

create table public.sources (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text not null,
  address text not null default '',
  kind text not null default '',
  note text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- events — the map's catalog. Text ids preserved from the JSON store
-- (slug + content hash, minted by the server). dedupe_key carries the
-- title+local-date dedupe rule; the unique index turns "read all and
-- compare" into a single upsert.
-- ---------------------------------------------------------------------------

create table public.events (
  id text primary key,
  title text not null,
  description text not null default '',
  category public.event_category not null,
  tags text[] not null default '{}',
  venue text not null,
  address text,
  lng double precision not null check (lng between -180 and 180),
  lat double precision not null check (lat between -90 and 90),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at >= starts_at),
  price text not null default '',
  is_free boolean not null default false,
  ticket_url text,
  ticket_provider text,
  source_id text not null references public.sources (id),
  source_kind public.event_source_kind not null default 'manual',
  rating numeric(2, 1) not null default 3.0 check (rating between 0 and 5),
  rating_rationale text,
  promoted boolean not null default false,
  rarity public.event_rarity not null default 'common',
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index events_dedupe_key_key on public.events (dedupe_key);
create index events_starts_at_idx on public.events (starts_at);
create index events_source_id_idx on public.events (source_id);

create trigger events_set_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- users — app-managed Google sign-in (not Supabase Auth). prefs is a
-- client-shaped blob (filters/interests/pinnedIds) and stays jsonb.
-- ---------------------------------------------------------------------------

create table public.users (
  id uuid primary key default gen_random_uuid(),
  google_id text not null unique,
  email text not null,
  name text not null default '',
  picture text not null default '',
  prefs jsonb not null default '{}'::jsonb,
  feed_token text unique,
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);

-- OAuth tokens from the incremental Google Calendar consent, split out of
-- the user row so profile reads never haul credentials.
create table public.user_google_tokens (
  user_id uuid primary key references public.users (id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text not null default '',
  updated_at timestamptz not null default now()
);

create trigger user_google_tokens_set_updated_at
  before update on public.user_google_tokens
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- sessions — sha256 cookie-token hashes; raw tokens are never stored.
-- ---------------------------------------------------------------------------

create table public.sessions (
  token_hash text primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index sessions_user_id_idx on public.sessions (user_id);
create index sessions_expires_at_idx on public.sessions (expires_at);

-- ---------------------------------------------------------------------------
-- calendar_entries — a user's saved events ("My Calendar"). google_event_id
-- is set once pushed to Google Calendar; the ICS feed serves the same rows.
-- ---------------------------------------------------------------------------

create table public.calendar_entries (
  user_id uuid not null references public.users (id) on delete cascade,
  event_id text not null references public.events (id) on delete cascade,
  google_event_id text,
  added_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

create index calendar_entries_event_id_idx on public.calendar_entries (event_id);

-- ---------------------------------------------------------------------------
-- ingests — pipeline log. events is a snapshot of what landed, intentionally
-- denormalized so history survives event edits/deletes.
-- ---------------------------------------------------------------------------

create table public.ingests (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  source text not null,
  kind public.ingest_kind not null,
  subject text,
  extracted integer not null default 0,
  added integer not null default 0,
  events jsonb not null default '[]'::jsonb
);

create index ingests_received_at_idx on public.ingests (received_at desc);

-- ---------------------------------------------------------------------------
-- raw_emails — replaces the RAW_EMAILS KV namespace. The email worker
-- inserts a row per inbound newsletter; the server polls unprocessed rows
-- (partial index) and stamps processed_at / error. email_key mirrors the
-- old "<receivedAt>_<source>" KV key so redelivery stays idempotent.
-- ---------------------------------------------------------------------------

create table public.raw_emails (
  id uuid primary key default gen_random_uuid(),
  email_key text not null unique,
  source text not null,
  to_addr text not null default '',
  from_addr text not null default '',
  subject text not null default '',
  body_text text not null default '',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  ingest_id uuid references public.ingests (id) on delete set null,
  error text
);

create index raw_emails_unprocessed_idx on public.raw_emails (received_at)
  where processed_at is null;
create index raw_emails_received_at_idx on public.raw_emails (received_at desc);

-- ---------------------------------------------------------------------------
-- app_settings — singleton config row (city, map center, tz, model).
-- ---------------------------------------------------------------------------

create table public.app_settings (
  id smallint primary key default 1 check (id = 1),
  city text not null,
  center_lng double precision not null check (center_lng between -180 and 180),
  center_lat double precision not null check (center_lat between -90 and 90),
  tz text not null,
  model text not null default '',
  ollama_url text not null default '',
  updated_at timestamptz not null default now()
);

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- geocode_cache — permanent Mapbox geocode results (venues don't move),
-- keyed by the normalized query string. Replaces geocache.json.
-- ---------------------------------------------------------------------------

create table public.geocode_cache (
  query text primary key,
  lng double precision not null,
  lat double precision not null,
  name text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- security: deny-all posture. RLS on everything, no policies, and the Data
-- API roles lose their default grants entirely.
-- ---------------------------------------------------------------------------

alter table public.sources enable row level security;
alter table public.events enable row level security;
alter table public.users enable row level security;
alter table public.user_google_tokens enable row level security;
alter table public.sessions enable row level security;
alter table public.calendar_entries enable row level security;
alter table public.ingests enable row level security;
alter table public.raw_emails enable row level security;
alter table public.app_settings enable row level security;
alter table public.geocode_cache enable row level security;

revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- ---------------------------------------------------------------------------
-- housekeeping: keep the free tier flat. Sessions die after their TTL and
-- raw email bodies keep the same 30-day retention KV had.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'purge-expired-sessions',
  '17 3 * * *',
  $$delete from public.sessions where expires_at < now()$$
);

select cron.schedule(
  'purge-old-raw-emails',
  '23 3 * * *',
  $$delete from public.raw_emails where received_at < now() - interval '30 days'$$
);
