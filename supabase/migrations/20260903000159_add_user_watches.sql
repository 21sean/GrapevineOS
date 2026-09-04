-- Watches: a signed-in user can schedule a web-discovery search of their own
-- ("keep an eye out for jazz shows"). Rows with a null user_id are the
-- operator's, saved from Admin, Discover. Deleting the account deletes its
-- watches; the scheduler runs both kinds the same way, and verified finds
-- land on the shared map either way.
alter table public.discovery_searches
  add column if not exists user_id uuid references public.users(id) on delete cascade;

create index if not exists discovery_searches_user_id
  on public.discovery_searches (user_id);
