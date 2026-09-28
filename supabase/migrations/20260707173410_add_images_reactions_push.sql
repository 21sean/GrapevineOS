-- Event images, per-user reactions, and Web Push.
--
--  * events.image_url / image_color: og:image scraped from the ticket/source
--    page at ingest, plus a dominant-color fallback so cards have something
--    to paint before (or without) the image.
--  * event_reactions: the real user feedback loop, "going" / "went, great" /
--    "not for me". Feeds the personal score and teaches tag affinities beyond
--    the fixed interest vocabulary. One reaction per (user, event).
--  * push_subscriptions / push_sends / push_keys: Web Push reminders for
--    saved events and the Sunday "your week" digest. push_sends is the
--    idempotency ledger; push_keys holds the server-minted VAPID pair so no
--    manual env setup is needed.
--
-- Same deny-all posture as the rest of the schema: RLS on, no policies,
-- no anon/authenticated grants; only the server's secret key gets through.

-- ---------------------------------------------------------------------------
-- events: scraped artwork
-- ---------------------------------------------------------------------------

alter table public.events
  add column image_url text,
  add column image_color text check (image_color ~ '^#[0-9a-f]{6}$');

-- ---------------------------------------------------------------------------
-- event_reactions: per-user feedback
-- ---------------------------------------------------------------------------

create type public.event_reaction as enum ('going', 'went', 'not_for_me');

create table public.event_reactions (
  user_id uuid not null references public.users (id) on delete cascade,
  event_id text not null references public.events (id) on delete cascade,
  reaction public.event_reaction not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

create index event_reactions_event_idx on public.event_reactions (event_id);

create trigger event_reactions_set_updated_at
  before update on public.event_reactions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Web Push
-- ---------------------------------------------------------------------------

-- One row per browser the user enabled notifications in.
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  reminders boolean not null default true,
  weekly_digest boolean not null default true,
  created_at timestamptz not null default now()
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Idempotency ledger: 'reminder|<user>|<event>|<occurrence>' or
-- 'digest|<user>|<iso-week>'. Insert-once wins the race across ticks.
create table public.push_sends (
  key text primary key,
  sent_at timestamptz not null default now()
);

-- Server-minted VAPID pair (generated on first use, then stable; browsers
-- bind subscriptions to the public key).
create table public.push_keys (
  id smallint primary key default 1 check (id = 1),
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- security + housekeeping
-- ---------------------------------------------------------------------------

alter table public.event_reactions enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_sends enable row level security;
alter table public.push_keys enable row level security;

revoke all on table public.event_reactions from anon, authenticated;
revoke all on table public.push_subscriptions from anon, authenticated;
revoke all on table public.push_sends from anon, authenticated;
revoke all on table public.push_keys from anon, authenticated;

select cron.schedule(
  'purge-old-push-sends',
  '29 3 * * *',
  $$delete from public.push_sends where sent_at < now() - interval '60 days'$$
);
