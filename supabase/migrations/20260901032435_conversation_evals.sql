-- ---------------------------------------------------------------------------
-- Conversation-level evals: one row per judged Ask Grapevine thread.
--
-- The eval harness grades fixtures; the guardrail table grades single texts.
-- Neither answers "was that whole conversation any good", which is the row
-- unit an operator actually reviews. Scores come from DeepEval metrics run by
-- the local Ollama judge over the persisted transcript; several rows per
-- thread are allowed (a re-judge after a model change is a new measurement,
-- not an edit), and the dashboard reads only the latest.
-- ---------------------------------------------------------------------------

create table public.conversation_evals (
  id bigint generated always as identity primary key,
  thread_id text not null
    references public.chat_threads (id) on delete cascade,
  at timestamptz not null default now(),
  -- The judge that produced the scores (e.g. "qwen3:8b"), because a score
  -- with no instrument attached cannot be compared with anything later.
  model text not null,
  -- Mean of the metric scores below, 0..1.
  overall real not null check (overall >= 0 and overall <= 1),
  verdict text not null check (verdict in ('pass', 'borderline', 'fail')),
  -- [{ "metric": "helpfulness", "score": 0.9, "reason": "..." }]
  scores jsonb not null default '[]'::jsonb,
  -- Judge wall time, because a graded metric on local GPU has a real cost.
  ms integer not null default 0
);

create index conversation_evals_thread_idx
  on public.conversation_evals (thread_id, at desc);

-- Same posture as guardrail_scans: RLS on, no policies, server key only.
alter table public.conversation_evals enable row level security;
revoke all on table public.conversation_evals from anon, authenticated;

-- ---------------------------------------------------------------------------
-- conversation_monitor: the conversations table on the monitoring panel, in
-- one round trip. Latest threads, each with its turn count, its guardrail
-- decisions (matched on guardrail_scans.thread_id), and its newest eval.
-- Aggregated here rather than in Node for the same reason guardrail_stats is.
-- ---------------------------------------------------------------------------

create or replace function public.conversation_monitor(p_limit int default 25)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with args as (
  select greatest(1, least(100, coalesce(p_limit, 25)))::int as lim
),
threads as (
  select t.id, t.title, t.provider, t.updated_at
  from public.chat_threads t
  order by t.updated_at desc
  limit (select lim from args)
),
msgs as (
  select m.thread_id, count(*)::int as turns
  from public.chat_messages m
  where m.thread_id in (select id from threads)
  group by m.thread_id
),
rails as (
  select
    s.thread_id,
    count(*)::int as scans,
    count(*) filter (where s.blocked)::int as blocked,
    count(*) filter (where s.would_block and not s.blocked)::int as would_block,
    max(s.score)::float8 as max_score
  from public.guardrail_scans s
  where s.thread_id in (select id from threads)
  group by s.thread_id
),
latest as (
  select distinct on (e.thread_id)
    e.thread_id, e.at, e.model, e.overall, e.verdict, e.scores, e.ms
  from public.conversation_evals e
  where e.thread_id in (select id from threads)
  order by e.thread_id, e.at desc
)
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'id', t.id,
      'title', t.title,
      'provider', t.provider,
      'updatedAt', t.updated_at,
      'turns', coalesce(m.turns, 0),
      'rails', jsonb_build_object(
        'scans', coalesce(r.scans, 0),
        'blocked', coalesce(r.blocked, 0),
        'wouldBlock', coalesce(r.would_block, 0),
        'maxScore', r.max_score
      ),
      'eval', case when l.thread_id is null then null else jsonb_build_object(
        'threadId', l.thread_id,
        'at', l.at,
        'model', l.model,
        'overall', l.overall,
        'verdict', l.verdict,
        'scores', l.scores,
        'ms', l.ms
      ) end
    )
    order by t.updated_at desc
  ),
  '[]'::jsonb
)
from threads t
left join msgs m on m.thread_id = t.id
left join rails r on r.thread_id = t.id
left join latest l on l.thread_id = t.id
$$;
