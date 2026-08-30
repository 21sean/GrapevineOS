-- Durable LangGraph checkpoints for Ask Grapevine threads.
--
-- Replaces the in-memory MemorySaver: conversation state now survives server
-- restarts, and the reseed-from-chat_messages dance becomes a fallback for
-- threads that predate this table. Checkpoints are opaque serialized blobs
-- (JsonPlusSerializer output, base64) — chat_messages stays the human-readable
-- record; these rows are runtime state, bounded by per-thread pruning in the
-- saver plus a retention sweep.
--
-- No FK to chat_threads: checkpoints are written during a turn, before the
-- thread row exists (and anonymous threads never get one).

create table if not exists public.chat_checkpoints (
  thread_id     text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  parent_id     text,
  -- serde type tag ("json") + the serialized checkpoint / metadata payloads
  type          text not null,
  checkpoint    text not null,
  metadata      text not null,
  at            timestamptz not null default now(),
  primary key (thread_id, checkpoint_ns, checkpoint_id)
);

create index if not exists chat_checkpoints_thread_at
  on public.chat_checkpoints (thread_id, checkpoint_ns, at desc);
create index if not exists chat_checkpoints_at
  on public.chat_checkpoints (at);

create table if not exists public.chat_checkpoint_writes (
  thread_id     text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  task_id       text not null,
  idx           int  not null,
  channel       text not null,
  type          text not null,
  value         text not null,
  at            timestamptz not null default now(),
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

create index if not exists chat_checkpoint_writes_at
  on public.chat_checkpoint_writes (at);

-- Server-key-only posture, same as the rest of the schema: RLS on, no
-- policies, anon/authenticated revoked.
alter table public.chat_checkpoints enable row level security;
alter table public.chat_checkpoint_writes enable row level security;
revoke all on public.chat_checkpoints from anon, authenticated;
revoke all on public.chat_checkpoint_writes from anon, authenticated;
