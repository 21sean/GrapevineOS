-- conversation_monitor is security definer and was left executable by the
-- default PUBLIC grant, so anyone holding the publishable key could call it
-- through PostgREST and read thread titles, providers and eval scores. Lock it
-- to the server's role, the same as every other definer function here.
revoke execute on function public.conversation_monitor(int) from public, anon, authenticated;
grant execute on function public.conversation_monitor(int) to service_role;

-- guardrail_stats had PUBLIC revoked but never an explicit grant, leaving the
-- server's access to Supabase's default privileges. Say it outright.
grant execute on function public.guardrail_stats(int, int) to service_role;

-- Foreign keys and filters without an index: user deletes cascade through
-- these, event retention nulls day_plan_items.event_id, and the monitoring
-- RPC joins scans to threads.
create index if not exists guardrail_scans_thread_id_idx
  on public.guardrail_scans (thread_id) where thread_id is not null;
create index if not exists guardrail_scans_user_id_idx
  on public.guardrail_scans (user_id) where user_id is not null;
create index if not exists trip_expenses_user_id_idx on public.trip_expenses (user_id);
create index if not exists day_plan_items_event_id_idx
  on public.day_plan_items (event_id) where event_id is not null;
