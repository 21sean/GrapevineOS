-- Supabase Auth migration: sign-in moves from the hand-rolled Google OAuth
-- flow in the Express server to Supabase Auth (GoTrue) with Google + GitHub
-- via the PKCE authorization-code flow.
--
--  * public.users becomes a profile table keyed by auth.users.id (existing
--    ids are preserved by seeding auth.users/auth.identities from the old
--    rows, so every FK — calendar_entries, event_reactions, chat_threads,
--    push_subscriptions — survives untouched).
--  * Sessions are GoTrue's problem now: public.sessions and its pg_cron
--    purge job are gone.
--  * The Google Calendar refresh token moves into Supabase Vault (encrypted
--    at rest, never in a plaintext column). Access is only through
--    security-definer RPCs granted to service_role — the deny-all posture
--    for anon/authenticated is unchanged.

-- ---------------------------------------------------------------------------
-- 1. seed auth.users / auth.identities from the legacy app-managed users,
--    preserving ids. GoTrue matches on (provider, provider_id), so the next
--    Google sign-in lands on the same user row and every FK keeps working.
--    The all-important string columns default to '' (not null) because
--    GoTrue's Go scanner rejects nulls there on manually inserted rows.
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token,
  reauthentication_token, is_sso_user, is_anonymous
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
  lower(u.email), '', now(),
  jsonb_build_object('provider', 'google', 'providers', jsonb_build_array('google')),
  jsonb_build_object(
    'sub', u.google_id, 'email', u.email, 'email_verified', true,
    'name', u.name, 'full_name', u.name,
    'avatar_url', u.picture, 'picture', u.picture
  ),
  u.created_at, now(), u.last_login_at,
  '', '', '', '', '', '', '', '', false, false
from public.users u
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, provider, provider_id, identity_data,
  last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(), u.id, 'google', u.google_id,
  jsonb_build_object(
    'sub', u.google_id, 'email', u.email, 'email_verified', true,
    'name', u.name, 'full_name', u.name,
    'avatar_url', u.picture, 'picture', u.picture
  ),
  u.last_login_at, u.created_at, now()
from public.users u
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. public.users becomes a profile table: identity lives in auth.identities,
--    so google_id goes away and id now references auth.users.
-- ---------------------------------------------------------------------------

alter table public.users drop column google_id;
alter table public.users alter column id drop default;
alter table public.users
  add constraint users_id_fkey
  foreign key (id) references auth.users (id) on delete cascade;

comment on table public.users is
  'App profile per auth.users row (synced by trigger). prefs is the client-shaped blob.';

-- ---------------------------------------------------------------------------
-- 3. keep the profile in step with auth.users. Fires on signup and on the
--    fields GoTrue refreshes at sign-in, so name/avatar/email stay current
--    and last_login_at tracks last_sign_in_at.
-- ---------------------------------------------------------------------------

create or replace function public.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, name, picture, last_login_at)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'name',
             new.raw_user_meta_data ->> 'full_name',
             new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url',
             new.raw_user_meta_data ->> 'picture', ''),
    coalesce(new.last_sign_in_at, now())
  )
  on conflict (id) do update set
    email = excluded.email,
    -- never blank out a profile with a provider that sends less metadata
    name = case when excluded.name = '' then public.users.name else excluded.name end,
    picture = case when excluded.picture = '' then public.users.picture else excluded.picture end,
    last_login_at = greatest(public.users.last_login_at, excluded.last_login_at);
  return new;
end;
$$;

revoke execute on function public.handle_auth_user_change() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_change();

create trigger on_auth_user_updated
  after update of email, raw_user_meta_data, last_sign_in_at on auth.users
  for each row execute function public.handle_auth_user_change();

-- ---------------------------------------------------------------------------
-- 4. Google Calendar refresh tokens move to Vault. The table keeps only
--    non-secret metadata plus the vault.secrets id; the token itself is
--    encrypted (libsodium AEAD) and readable only through the RPCs below.
-- ---------------------------------------------------------------------------

create table public.user_google_calendar (
  user_id uuid primary key references public.users (id) on delete cascade,
  secret_id uuid not null, -- vault.secrets row holding the refresh token
  scope text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.user_google_calendar enable row level security;

create trigger user_google_calendar_set_updated_at
  before update on public.user_google_calendar
  for each row execute function public.set_updated_at();

-- deleting the row (or cascading a user delete) scrubs the secret too
create or replace function public.delete_google_calendar_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return old;
end;
$$;

revoke execute on function public.delete_google_calendar_secret() from public, anon, authenticated;

create trigger user_google_calendar_delete_secret
  after delete on public.user_google_calendar
  for each row execute function public.delete_google_calendar_secret();

-- ---------- service-role-only RPCs (the server's token API) ----------

create or replace function public.google_calendar_set(
  p_user_id uuid,
  p_refresh_token text,
  p_scope text default ''
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  if p_refresh_token is null or p_refresh_token = '' then
    raise exception 'refresh token required';
  end if;
  select secret_id into v_secret
    from public.user_google_calendar where user_id = p_user_id;
  if v_secret is null then
    v_secret := vault.create_secret(
      p_refresh_token,
      'google_calendar_refresh:' || p_user_id::text,
      'Google Calendar OAuth refresh token'
    );
    insert into public.user_google_calendar (user_id, secret_id, scope)
    values (p_user_id, v_secret, p_scope);
  else
    perform vault.update_secret(v_secret, p_refresh_token);
    update public.user_google_calendar
      set scope = p_scope where user_id = p_user_id;
  end if;
end;
$$;

create or replace function public.google_calendar_get(p_user_id uuid)
returns table (refresh_token text, scope text)
language sql
security definer
set search_path = ''
as $$
  select ds.decrypted_secret, gc.scope
  from public.user_google_calendar gc
  join vault.decrypted_secrets ds on ds.id = gc.secret_id
  where gc.user_id = p_user_id;
$$;

create or replace function public.google_calendar_clear(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.user_google_calendar where user_id = p_user_id;
$$;

revoke all on function public.google_calendar_set(uuid, text, text) from public, anon, authenticated;
revoke all on function public.google_calendar_get(uuid) from public, anon, authenticated;
revoke all on function public.google_calendar_clear(uuid) from public, anon, authenticated;

grant execute on function public.google_calendar_set(uuid, text, text) to service_role;
grant execute on function public.google_calendar_get(uuid) to service_role;
grant execute on function public.google_calendar_clear(uuid) to service_role;

-- migrate the existing plaintext grant into Vault, then drop the old table.
-- (access tokens are short-lived and deliberately not preserved — the server
-- mints a fresh one from the refresh token on demand.)
select public.google_calendar_set(t.user_id, t.refresh_token, t.scope)
from public.user_google_tokens t
where t.refresh_token <> '';

drop table public.user_google_tokens;

-- ---------------------------------------------------------------------------
-- 5. sessions are GoTrue's now — drop the app table and its purge job.
-- ---------------------------------------------------------------------------

drop table public.sessions;

select cron.unschedule('purge-expired-sessions');
