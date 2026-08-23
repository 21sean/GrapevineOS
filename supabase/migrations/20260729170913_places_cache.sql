-- Mapbox lookups all move into one place, and the Places venue cache joins
-- them in Postgres.
--
-- Before: geocode answers lived in geocode_cache while Places records were
-- memory-only, so every restart re-bought the same venue records and two
-- server processes never shared one. Both are the same shape of thing -- a
-- Mapbox answer keyed by what we asked -- so they share a table now:
--
--   place_lookups   text query -> what Mapbox resolved it to.
--                   kind='geocode' keeps lng/lat (this is geocode_cache,
--                   carried over row for row); kind='poi' keeps the Search
--                   Box mapbox_id for a venue near an event.
--   place_details   mapbox_id -> the projected Place record the venue card
--                   renders. Keyed by mapbox_id rather than by query, so
--                   every event at the same bar shares one record and one
--                   fetch, however many ways its name was written.
--
-- A null resolution (no such place / no POI) is stored too: a miss that isn't
-- remembered is a miss that gets re-billed on every panel open.
--
-- Places data is licensed for temporary display, so place_details is a TTL
-- cache and not storage: the server re-fetches a record older than 12 hours
-- and a nightly job deletes anything older than a week.

create table public.place_lookups (
  kind text not null check (kind in ('geocode', 'poi')),
  query text not null,
  lng double precision,
  lat double precision,
  name text not null default '',
  mapbox_id text,
  created_at timestamptz not null default now(),
  primary key (kind, query)
);

insert into public.place_lookups (kind, query, lng, lat, name, created_at)
select 'geocode', query, lng, lat, name, created_at
from public.geocode_cache;

drop table public.geocode_cache;

create table public.place_details (
  mapbox_id text primary key,
  -- The projected VenueDetails (server/src/places.ts), not the raw record:
  -- only the fields the card renders. null means Mapbox has no record for
  -- this id, which is worth remembering as much as a hit is.
  details jsonb,
  fetched_at timestamptz not null default now()
);

-- Same deny-all posture as the rest of the schema: RLS on, no policies, no
-- Data API grants. Only the server's secret key reads these.
alter table public.place_lookups enable row level security;
alter table public.place_details enable row level security;

revoke all on table public.place_lookups from anon, authenticated;
revoke all on table public.place_details from anon, authenticated;

-- One round trip for the whole cold-path question: is this venue resolved,
-- and do we already hold a fresh record for it? Zero rows means the venue was
-- never resolved; a row with a null mapbox_id is a remembered "no such POI";
-- a null details_at means the id is known but the record is not cached.
create function public.venue_cache(p_query text)
returns table (
  mapbox_id text,
  resolved_at timestamptz,
  details jsonb,
  details_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select l.mapbox_id, l.created_at, d.details, d.fetched_at
  from public.place_lookups l
  left join public.place_details d on d.mapbox_id = l.mapbox_id
  where l.kind = 'poi' and l.query = p_query;
$$;

-- Housekeeping. Resolution hits are kept forever on purpose (venues don't
-- move); misses expire so a transient Mapbox failure can't pin a venue as
-- unresolvable. Details expire because the licence says they should.
select cron.unschedule('purge-stale-geocode-misses');

select cron.schedule(
  'purge-stale-place-misses',
  '35 3 * * *',
  $$delete from public.place_lookups
    where lng is null and mapbox_id is null
      and created_at < now() - interval '90 days'$$
);

select cron.schedule(
  'purge-stale-place-details',
  '41 3 * * *',
  $$delete from public.place_details where fetched_at < now() - interval '7 days'$$
);
