-- Per-person token accounting for chat: one row per user per UTC day.
--
-- A chat turn is the most expensive request the server takes, because it holds
-- the local GPU for as long as it generates. The request-rate limit in
-- rate-limit.ts stops a burst; it does not stop one account from spending the
-- whole card on long turns all day. A daily token budget does, and it has to
-- outlive a server restart to mean anything, so the count lives here rather
-- than in the process (server/src/quota.ts reads and writes it).
--
-- What is counted is the work the GPU actually did for the account: prompt
-- tokens it had to evaluate (the ones not read from the prefix cache) plus
-- output tokens. A day is the unit because that is the unit the budget resets
-- on; nothing here needs a finer grain, and one small row per person per day
-- stays cheap to keep.
--
-- Signed-out visitors are not in this table. They have no account to hang a
-- row on, so their smaller budget is counted in memory, per address.

create table public.llm_usage (
  user_id uuid not null references public.users(id) on delete cascade,
  day date not null,
  tokens bigint not null default 0 check (tokens >= 0),
  turns integer not null default 0 check (turns >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Reachable only through the server's secret key: no policies, by design.
alter table public.llm_usage enable row level security;

-- Add one turn's tokens and return the day's new total. One statement, so two
-- turns finishing together cannot both read the old total and lose a write.
create or replace function public.record_llm_usage(
  p_user_id uuid,
  p_day date,
  p_tokens bigint
)
returns bigint
language sql
set search_path = public
as $$
  insert into public.llm_usage (user_id, day, tokens, turns)
  values (p_user_id, p_day, greatest(0, coalesce(p_tokens, 0)), 1)
  on conflict (user_id, day) do update
    set tokens = public.llm_usage.tokens + excluded.tokens,
        turns = public.llm_usage.turns + 1,
        updated_at = now()
  returning tokens;
$$;

revoke execute on function public.record_llm_usage(uuid, date, bigint) from public, anon, authenticated;
grant execute on function public.record_llm_usage(uuid, date, bigint) to service_role;
