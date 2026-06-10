-- Adds optional recurrence to events: an RFC 5545 RRULE string (e.g.
-- 'FREQ=WEEKLY;BYDAY=SA') that turns a single anchor occurrence
-- (starts_at/ends_at) into a repeating series. NULL = one-off, so the column is
-- purely additive and every existing row keeps its meaning. The check keeps the
-- stored value a canonical, FREQ-first rule (matching the server's normalizer)
-- so it doubles as a stable dedupe series key.
--
-- No index: the app reads the full events set and filters/expands recurrence
-- client-side, so there is no server query that selects on this column.
alter table public.events
  add column recurrence text
    check (recurrence is null or recurrence ~ '^FREQ=');
