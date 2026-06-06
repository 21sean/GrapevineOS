-- Refinements on the initial schema:
--
-- 1. Cover the raw_emails.ingest_id FK (advisor: unindexed_foreign_keys).
-- 2. geocode_cache records misses: lng/lat go nullable so a failed geocode
--    is cached too and never re-billed against the Mapbox free tier.
-- 3. raw_emails.char_count (generated) lets the admin inbox list emails
--    without shipping whole newsletter bodies over the wire.

create index raw_emails_ingest_id_idx on public.raw_emails (ingest_id);

alter table public.geocode_cache
  alter column lng drop not null,
  alter column lat drop not null;

alter table public.raw_emails
  add column char_count integer generated always as (char_length(body_text)) stored;
