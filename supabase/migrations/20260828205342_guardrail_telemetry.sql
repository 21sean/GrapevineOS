-- Guardrail telemetry: every rail decision, not just the ones that blocked.
--
-- The rails already compute a score on every call (agent/guardrails.ts). Until
-- now that number was discarded whenever it came back under the threshold,
-- which left the one question an operator actually has unanswerable: what does
-- the score distribution on ordinary traffic look like? Without it the
-- threshold is a guess that can never be checked, and a classifier drifting
-- into false positives looks exactly like a quiet week.
--
-- So: one row per scan, blocked or not. The score, the threshold that was in
-- force when the decision was made (a later retune must not rewrite history),
-- the latency, and the text itself.
--
-- On storing the text. This holds real user chat and text fetched from pages
-- we do not control, and that is a deliberate trade: a false positive cannot
-- be labelled by someone who cannot read what was blocked, and the labelled
-- set is what makes the threshold sweep more than a shape on a chart. It is
-- bounded by GUARDRAIL_RETENTION_DAYS (default 30, swept in retention.ts),
-- deleted with the user on account deletion, and reachable only through the
-- server's secret key. GUARDRAIL_STORE_TEXT=off drops the column's contents at
-- write time for anyone who wants the distribution without the corpus.
--
-- The aggregation lives in the RPC at the bottom rather than in the server:
-- a histogram over months of scans is four numbers on the wire from Postgres
-- and megabytes of rows if the panel computes it itself.

create table public.guardrail_scans (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),

  -- Which of the three rails decided. 'input' is the user's message, 'content'
  -- is untrusted web text on its way into the model's context, 'output' is the
  -- deterministic persona scrubber on the streamed reply.
  rail text not null check (rail in ('input', 'content', 'output')),

  -- Where the scan happened: chat, chat-cli, search_web, read_page, discovery,
  -- ext-api, warmup. Free text on purpose -- a new call site should show up as
  -- an unfamiliar surface in the panel, not fail an insert.
  surface text not null default 'unknown',

  -- MALICIOUS probability, 0-1. Null for the output rail, which is regex and
  -- has no score to report -- storing a 0 there would drag every percentile
  -- down with values that were never measurements.
  score real check (score is null or (score >= 0 and score <= 1)),

  -- The threshold this decision was made against. Kept per row so a run of
  -- history stays interpretable after the threshold is retuned.
  threshold real,

  -- What actually happened to the traffic.
  blocked boolean not null default false,
  -- Observe mode (GUARDRAILS=observe): scored over threshold but let through
  -- on purpose. This is the column that makes a threshold change measurable
  -- before it is switched on.
  would_block boolean not null default false,

  ms integer not null default 0,
  chars integer not null default 0,

  -- sha256 of the normalized text, salted when GUARDRAIL_HASH_SALT is set.
  -- Groups repeats (the same scraped page, the same probe retried) without
  -- depending on the text column, which retention empties.
  text_hash text not null,
  text text,

  guard_model text,
  -- Output rail only: the pattern that tripped, so a false positive names the
  -- regex to fix instead of sending someone through the whole list.
  pattern text,
  provider text,
  thread_id text,
  user_id uuid references public.users(id) on delete cascade,

  -- Operator triage. This is the calibration set: 'correct' is a decision that
  -- deserved to go the way it went, either direction; the other two are the
  -- mistakes. Null means nobody has looked.
  label text check (label in ('correct', 'false_positive', 'false_negative')),
  labeled_at timestamptz
);

comment on table public.guardrail_scans is
  'One row per guardrail decision, blocked or not. Bounded by GUARDRAIL_RETENTION_DAYS.';
comment on column public.guardrail_scans.threshold is
  'Threshold in force at decision time -- history stays readable after a retune.';
comment on column public.guardrail_scans.would_block is
  'Observe mode: over threshold but deliberately allowed through.';
comment on column public.guardrail_scans.label is
  'Operator triage. Labelled rows are the calibration set the threshold sweep scores against.';

-- The panel reads recent-first within a window, usually filtered by rail.
create index guardrail_scans_at_idx on public.guardrail_scans (at desc);
create index guardrail_scans_rail_at_idx on public.guardrail_scans (rail, at desc);
-- Labelled rows are a small fraction of the table and are always read as a set.
create index guardrail_scans_label_idx on public.guardrail_scans (label, at desc)
  where label is not null;
-- The review queue: the highest-scoring things that were let through, which is
-- where a false negative is found if it is going to be found at all.
create index guardrail_scans_score_idx on public.guardrail_scans (score desc nulls last)
  where score is not null;

-- Same posture as every other table here: RLS on, no policies, and the API
-- roles get nothing. Only the server's secret key reads this.
alter table public.guardrail_scans enable row level security;
revoke all on table public.guardrail_scans from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Runtime knobs, so the threshold can be tuned from the panel that shows the
-- distribution. Env (GUARD_THRESHOLD / GUARDRAILS) still seeds the default and
-- still wins on a fresh database; this is where a retune is recorded.
-- ---------------------------------------------------------------------------

alter table public.app_settings
  add column if not exists guard_threshold real not null default 0.8
    check (guard_threshold > 0 and guard_threshold <= 1),
  add column if not exists guard_mode text not null default 'on'
    check (guard_mode in ('on', 'observe', 'off'));

comment on column public.app_settings.guard_mode is
  'on = block, observe = score and record but never block, off = rails disabled (the persona rail stays on regardless).';

-- ---------------------------------------------------------------------------
-- guardrail_stats: everything the dashboard draws, in one round trip.
--
-- Two equal-length windows -- the recent one and the one immediately before it
-- -- so drift is a comparison the caller can make (PSI, in guardrails/stats.ts)
-- rather than a number it has to remember from last week. Buckets are dense:
-- an empty bucket is a fact about the distribution and has to be plotted.
-- ---------------------------------------------------------------------------

create or replace function public.guardrail_stats(
  p_window_days int default 7,
  p_buckets int default 20
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with args as (
  select
    greatest(1, least(365, coalesce(p_window_days, 7)))::int as win,
    greatest(4, least(100, coalesce(p_buckets, 20)))::int as nbuckets
),
spans as (
  select
    win,
    nbuckets,
    now() - make_interval(days => win) as recent_from,
    now() - make_interval(days => win * 2) as base_from
  from args
),
scoped as (
  select
    s.rail,
    s.score,
    s.blocked,
    s.would_block,
    s.ms,
    s.at,
    case when s.at >= sp.recent_from then 'recent' else 'baseline' end as win_name,
    -- Scores land in [0,1]; the top bucket is closed so 1.0 has a home.
    least(sp.nbuckets - 1, floor(s.score * sp.nbuckets)::int) as bucket
  from public.guardrail_scans s
  cross join spans sp
  where s.at >= sp.base_from
),
-- Per rail/window totals. Counted over every row, including the output rail's
-- score-less ones, because "how many decisions" is not the same question as
-- "what did the scores look like".
totals as (
  select
    rail,
    win_name,
    count(*)::int as n,
    count(*) filter (where blocked)::int as blocked,
    count(*) filter (where would_block and not blocked)::int as would_block,
    count(score)::int as scored,
    round(avg(ms)::numeric, 1)::float8 as mean_ms,
    percentile_cont(0.5) within group (order by score)::float8 as p50,
    percentile_cont(0.9) within group (order by score)::float8 as p90,
    percentile_cont(0.95) within group (order by score)::float8 as p95,
    percentile_cont(0.99) within group (order by score)::float8 as p99,
    max(score)::float8 as max_score
  from scoped
  group by rail, win_name
),
-- Dense buckets: every rail x window x bucket that could exist, left-joined to
-- what was actually observed.
grid as (
  select r.rail, w.win_name, b.bucket
  from (select distinct rail from scoped) r
  cross join (values ('recent'), ('baseline')) as w(win_name)
  cross join spans sp
  cross join lateral generate_series(0, sp.nbuckets - 1) as b(bucket)
),
counted as (
  select
    g.rail,
    g.win_name,
    g.bucket,
    count(s.score)::int as n,
    count(s.score) filter (where s.blocked)::int as blocked
  from grid g
  left join scoped s
    on s.rail = g.rail and s.win_name = g.win_name and s.bucket = g.bucket
  group by g.rail, g.win_name, g.bucket
),
hists as (
  select
    rail,
    win_name,
    jsonb_agg(jsonb_build_array(n, blocked) order by bucket) as hist
  from counted
  group by rail, win_name
),
windows as (
  select
    t.rail,
    t.win_name,
    jsonb_build_object(
      'n', t.n,
      'blocked', t.blocked,
      'wouldBlock', t.would_block,
      'scored', t.scored,
      'meanMs', t.mean_ms,
      'p50', t.p50,
      'p90', t.p90,
      'p95', t.p95,
      'p99', t.p99,
      'max', t.max_score,
      -- [count, blockedCount] per bucket, low score to high.
      'hist', coalesce(h.hist, '[]'::jsonb)
    ) as payload
  from totals t
  left join hists h on h.rail = t.rail and h.win_name = t.win_name
),
rails as (
  select
    rail,
    jsonb_object_agg(win_name, payload) as windows
  from windows
  group by rail
),
-- One point per rail per day over the recent window: block rate and p95 are
-- the two lines that move first when something drifts.
daily as (
  select jsonb_agg(d order by d->>'day', d->>'rail') as series
  from (
    select jsonb_build_object(
      'day', to_char(date_trunc('day', s.at), 'YYYY-MM-DD'),
      'rail', s.rail,
      'n', count(*)::int,
      'blocked', count(*) filter (where s.blocked)::int,
      'p95', percentile_cont(0.95) within group (order by s.score)::float8
    ) as d
    from scoped s
    where s.win_name = 'recent'
    group by date_trunc('day', s.at), s.rail
  ) x
)
select jsonb_build_object(
  'windowDays', (select win from spans),
  'buckets', (select nbuckets from spans),
  'total', (select count(*)::int from public.guardrail_scans),
  'oldest', (select min(at) from public.guardrail_scans),
  'rails', coalesce((select jsonb_object_agg(rail, windows) from rails), '{}'::jsonb),
  'daily', coalesce((select series from daily), '[]'::jsonb)
);
$$;

comment on function public.guardrail_stats(int, int) is
  'Histogram + percentiles + block rate per rail, for the recent window and the one before it.';

revoke execute on function public.guardrail_stats(int, int) from public, anon, authenticated;
