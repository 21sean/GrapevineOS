-- Traffic-aware "leave by" departure alerts.
--
--  * push_subscriptions.leave_by: per-browser opt-in for the alert, on by
--    default like the other toggles (nothing fires until the browser has a
--    push subscription at all).
--  * users.last_lng / last_lat / last_pos_at: the last coarse position the
--    browser reported (the server snaps it to a ~110 m grid before writing),
--    used as the origin for the Mapbox drive-time. A stale position falls
--    back to the city center.

alter table public.push_subscriptions
  add column leave_by boolean not null default true;

alter table public.users
  add column last_lng double precision,
  add column last_lat double precision,
  add column last_pos_at timestamptz;
