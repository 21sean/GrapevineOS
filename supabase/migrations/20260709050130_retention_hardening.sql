-- Retention hardening (free-tier resilience): the two tables that grow
-- without bound get pg_cron purges, same pattern as raw_emails/push_sends.
--
--  * ingests is a pipeline log with denormalized jsonb event snapshots;
--    useful history, but 180 days is plenty.
--  * geocode_cache hits are kept forever on purpose (venues don't move);
--    cached MISSES (lng is null) are re-billed once if retried, so expiring
--    them after 90 days lets transient Mapbox failures heal instead of
--    pinning a venue as "unmappable" forever.

select cron.schedule(
  'purge-old-ingests',
  '29 3 * * *',
  $$delete from public.ingests where received_at < now() - interval '180 days'$$
);

select cron.schedule(
  'purge-stale-geocode-misses',
  '35 3 * * *',
  $$delete from public.geocode_cache where lng is null and created_at < now() - interval '90 days'$$
);
