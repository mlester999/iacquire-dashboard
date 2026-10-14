-- Supabase foundation.
--
--   1. Maps Supabase Auth users to portal profiles (users.auth_user_id).
--   2. Lets row-level-security helpers resolve the caller from a Supabase JWT (auth.uid()) as well as
--      from the server-set app.user_id setting. The server keeps using app.user_id; Realtime and
--      Storage policies, which run inside Supabase services, use the JWT.
--   3. Closes the Supabase Data API surface. The portal talks to Postgres from the server with the
--      iaq_app_user / owner roles; no table, sequence or function in "public" should be reachable by
--      the anon or authenticated roles that PostgREST uses.
--   4. Adds the ledger used by the account-migration script.
--
-- Additive and idempotent where possible; it deletes nothing.
-- Rollback/data-preserving restore procedure: docs/supabase-setup.md

-- ---------------------------------------------------------------------------
-- 1. Profile mapping
-- ---------------------------------------------------------------------------

alter table users add column if not exists auth_user_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_auth_user_id_key') then
    alter table users add constraint users_auth_user_id_key unique (auth_user_id);
  end if;
end
$$;
comment on column users.auth_user_id is
  'Supabase Auth user (auth.users.id) that signs in as this profile. Null while an account still uses the built-in auth.';

-- ---------------------------------------------------------------------------
-- 2. Caller resolution
-- ---------------------------------------------------------------------------

-- auth.uid() exists on Supabase; on a plain Postgres without the auth schema this returns null.
create or replace function app.auth_uid() returns uuid
language plpgsql stable
as $$
begin
  if to_regprocedure('auth.uid()') is null then
    return null;
  end if;
  return auth.uid();
end
$$;

-- Profile of the Supabase user in the current JWT. Security definer so policies evaluated as the
-- "authenticated" role can resolve themselves without being granted access to the users table.
create or replace function app.profile_id_for_auth_user() returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select u.id from users u where u.auth_user_id = app.auth_uid() and u.status = 'active'
$$;
revoke all on function app.profile_id_for_auth_user() from public;
grant execute on function app.profile_id_for_auth_user() to iaq_app_user;

create or replace function app.current_user_id() returns uuid
language sql stable
as $$
  select coalesce(nullif(current_setting('app.user_id', true), '')::uuid, app.profile_id_for_auth_user())
$$;

-- ---------------------------------------------------------------------------
-- 3. Data API lockdown
-- ---------------------------------------------------------------------------

-- schema_migrations is bookkeeping. RLS with no policy denies everything to non-owners.
-- The Supabase CLI uses its own history schema and does not create this app runner table.
create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now());
alter table schema_migrations enable row level security;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
      execute format('revoke usage on schema public from %I', r);
    end if;
  end loop;
end
$$;

-- Helper functions in the app schema are executable only by roles that need them.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema app from anon';
    execute 'revoke usage on schema app from anon';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Auth account migration ledger
-- ---------------------------------------------------------------------------

create table auth_account_migrations (
  user_id uuid primary key references users (id) on delete cascade,
  auth_user_id uuid,
  status text not null default 'pending'
    check (status in ('pending', 'created', 'linked', 'failed', 'skipped')),
  password_reset_required boolean not null default true,
  notice_sent_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  attempted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table auth_account_migrations enable row level security;
-- No grants and no policies for iaq_app_user, anon or authenticated: only the owner role reads this.
revoke all on auth_account_migrations from public;
