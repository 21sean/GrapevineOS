-- Ask Grapevine chat history, bound to signed-in users.
--
-- Threads keep the client-minted LangGraph thread id (unguessable UUID-ish
-- text) as their primary key so resuming a conversation and reading its
-- history share one identifier. Access control lives in the server: every
-- read/write checks the session user owns the thread, and a threadId that
-- belongs to someone else is re-minted before it ever reaches the agent.
-- Same deny-all posture as the rest of the schema: RLS on, no policies,
-- no anon/authenticated grants; only the server's secret key gets through.

create table public.chat_threads (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  user_id uuid not null references public.users (id) on delete cascade,
  title text not null default '',
  provider text not null default 'ollama',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index chat_threads_user_idx on public.chat_threads (user_id, updated_at desc);

create trigger chat_threads_set_updated_at
  before update on public.chat_threads
  for each row execute function public.set_updated_at();

create table public.chat_messages (
  id bigint generated always as identity primary key,
  thread_id text not null references public.chat_threads (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index chat_messages_thread_idx on public.chat_messages (thread_id, id);

alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;

revoke all on table public.chat_threads from anon, authenticated;
revoke all on table public.chat_messages from anon, authenticated;
