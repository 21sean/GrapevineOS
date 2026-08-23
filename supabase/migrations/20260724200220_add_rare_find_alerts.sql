-- Rare-find alerts: an opt-in push the moment ingest lands a rare event that
-- matches the user's loves ("More like this" interests).
--
-- Unlike the other push toggles this one defaults OFF — it is a new alert
-- type existing subscribers never asked for, so nobody starts getting it
-- until they flip the switch in Account -> Notifications.

alter table public.push_subscriptions
  add column rare_finds boolean not null default false;
