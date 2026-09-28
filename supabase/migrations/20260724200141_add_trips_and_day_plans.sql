-- Trips, trip expenses, and day plans.
--
-- Two features share these tables:
--
--  * "Plan my day": a saved, editable itinerary for one calendar date. It
--    works with no trip at all (the default mode: plan a Tuesday at home) and
--    inside a trip, where the trip's dates and destination ground what the
--    agent proposes.
--  * The trip's money tab: expenses filed against a trip, with a per-trip
--    budget and a by-category breakdown.
--
-- Same access model as the rest of the schema: RLS on, no policies, no
-- anon/authenticated grants. Every read/write goes through the Express server
-- with the secret key, which scopes each query by the session user's id.

create type public.trip_expense_category as enum
  ('flights', 'lodging', 'food', 'activities', 'transport', 'shopping', 'other');

-- What a slot in a planned day *is*, so the UI can icon it and the agent can
-- reason about shape ("you have no food between 12 and 7").
create type public.day_plan_item_kind as enum
  ('event', 'food', 'activity', 'travel', 'lodging', 'rest', 'note');

-- trips: a named date range, optionally anchored to a destination. Dates are
-- plain dates (not instants): a trip runs "Apr 18 - Apr 26" wherever you are.
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  destination text not null default '',
  lng double precision check (lng between -180 and 180),
  lat double precision check (lat between -90 and 90),
  starts_on date not null,
  ends_on date not null,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  budget_cents bigint check (budget_cents >= 0),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_dates_ordered check (ends_on >= starts_on),
  constraint trips_dates_bounded check (ends_on - starts_on <= 365)
);

create index trips_user_idx on public.trips (user_id, starts_on desc);

create trigger trips_updated_at
  before update on public.trips
  for each row execute function public.set_updated_at();

-- trip_expenses: what the trip cost. user_id is denormalized from the trip
-- so every query can filter on the session user without a join.
create table public.trip_expenses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  category public.trip_expense_category not null default 'other',
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  spent_on date not null,
  paid_by text not null default '',
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index trip_expenses_trip_idx on public.trip_expenses (trip_id, spent_on desc);

create trigger trip_expenses_updated_at
  before update on public.trip_expenses
  for each row execute function public.set_updated_at();

-- day_plans: one planned date. trip_id null is the default (at-home) mode;
-- the same user/date can hold one plan per trip plus one untripped plan, so
-- the unique index treats nulls as a value ("nulls not distinct").
create table public.day_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  trip_id uuid references public.trips (id) on delete cascade,
  plan_date date not null,
  title text not null default '',
  summary text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index day_plans_user_date_idx
  on public.day_plans (user_id, plan_date, trip_id) nulls not distinct;

create trigger day_plans_updated_at
  before update on public.day_plans
  for each row execute function public.set_updated_at();

-- day_plan_items: the ordered slots inside a planned day. event_id links a
-- slot to a catalog event when the plan came from the map; the link is
-- nulled (not cascaded away) if retention later prunes that event, so the
-- itinerary keeps its shape.
create table public.day_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.day_plans (id) on delete cascade,
  position integer not null default 0,
  kind public.day_plan_item_kind not null default 'activity',
  title text not null check (length(title) between 1 and 200),
  starts_at timestamptz,
  ends_at timestamptz,
  event_id text references public.events (id) on delete set null,
  venue text not null default '',
  address text not null default '',
  lng double precision check (lng between -180 and 180),
  lat double precision check (lat between -90 and 90),
  note text not null default '',
  google_event_id text,
  created_at timestamptz not null default now(),
  constraint day_plan_items_times_ordered
    check (ends_at is null or starts_at is null or ends_at >= starts_at)
);

create index day_plan_items_plan_idx on public.day_plan_items (plan_id, position);

-- deny-all posture (unchanged): RLS on, no policies, no Data API grants.
alter table public.trips enable row level security;
alter table public.trip_expenses enable row level security;
alter table public.day_plans enable row level security;
alter table public.day_plan_items enable row level security;

revoke all on table public.trips from anon, authenticated;
revoke all on table public.trip_expenses from anon, authenticated;
revoke all on table public.day_plans from anon, authenticated;
revoke all on table public.day_plan_items from anon, authenticated;
