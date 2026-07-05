-- Web discovery: the server searches the open web for local events on a
-- schedule, reads the source pages, extracts candidates with the LLM, and
-- only keeps ones a verification pass could confirm against the page text.

-- New provenance values. Adding enum values is transaction-safe on PG 12+ as
-- long as nothing in this migration *uses* them (nothing here does).
alter type public.ingest_kind add value if not exists 'search';
alter type public.event_source_kind add value if not exists 'search';

-- Where a web-discovered event was verified from. Nullable: newsletter and
-- seed events never have one.
alter table public.events
  add column if not exists source_url text;

-- ---------------------------------------------------------------------------
-- discovery_searches — saved web searches the scheduler re-runs. cadence is
-- hours between runs; last_status is a short human summary ("5 candidates,
-- 3 verified, 2 new" or "error: …") for the admin UI.
-- ---------------------------------------------------------------------------

create table public.discovery_searches (
  id uuid primary key default gen_random_uuid(),
  query text not null check (length(btrim(query)) between 3 and 200),
  -- One saved row per distinct query (case/whitespace-insensitive); a plain
  -- generated column so PostgREST upserts can target it via ON CONFLICT.
  query_key text generated always as (lower(btrim(query))) stored unique,
  cadence_hours integer not null default 24 check (cadence_hours between 1 and 336),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_status text not null default ''
);

alter table public.discovery_searches enable row level security;
