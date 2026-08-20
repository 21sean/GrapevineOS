-- Venue records become permanent storage.
--
-- The previous migration treated place_details as a TTL cache and deleted
-- anything older than a week, on the reading that Places data is licensed for
-- temporary display. That is now a deliberate call the other way: records are
-- kept, always served, and only refreshed with age (server/src/places.ts).
-- Losing them nightly meant re-buying the same venue out of a 1,000-record
-- monthly preview quota, and a venue card that vanished for no visible reason.
--
-- Cached *misses* still expire (90 days, unchanged) — a venue Mapbox has
-- nothing for today may have something next year, and remembering "nothing"
-- forever would pin it as blank permanently.

select cron.unschedule('purge-stale-place-details');
