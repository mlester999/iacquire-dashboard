-- iAcquire Client Portal — foundation: roles, identity, tenants, memberships, permissions.
--
-- Access model
--   * Tables are owned by the migration role (the "system" role used by trusted server code).
--   * User-scoped requests run inside a transaction that executes
--       select set_config('app.user_id', <uuid>, true); set local role iaq_app_user;
--     so every query is subject to the row-level security policies below.
--   * iaq_app_user never receives grants on credential, session, token or outbox tables.

-- gen_random_uuid() is built into PostgreSQL 13+, so pgcrypto is not required.
create extension if not exists citext;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'iaq_app_user') then
    create role iaq_app_user nologin;
  end if;
end
$$;

-- The connecting role must be able to SET ROLE to iaq_app_user (required on Supabase/managed Postgres).
grant iaq_app_user to current_user;

create schema if not exists app;
grant usage on schema app to iaq_app_user;
grant usage on schema public to iaq_app_user;

create or replace function app.current_user_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  full_name text not null default '' check (char_length(full_name) <= 120),
  email_verified_at timestamptz,
  platform_role text not null default 'none'
    check (platform_role in ('none', 'agency_staff', 'agency_super_admin')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  timezone text not null default 'UTC' check (char_length(timezone) <= 64),
  preferences jsonb not null default '{}'::jsonb,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger users_touch before update on users for each row execute function app.touch_updated_at();

-- Password hashes live apart from the profile row and are never granted to iaq_app_user.
create table auth_credentials (
  user_id uuid primary key references users(id) on delete cascade,
  password_hash text not null,
  password_updated_at timestamptz not null default now(),
  failed_attempts integer not null default 0,
  locked_until timestamptz
);

create table auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_hash text,
  user_agent text check (char_length(user_agent) <= 300)
);
create index auth_sessions_user_idx on auth_sessions (user_id) where revoked_at is null;

-- Single-use tokens: email verification, password reset. Only SHA-256 digests are stored.
create table auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('verify_email', 'reset_password')),
  token_hash text not null unique,
  email citext not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index auth_tokens_user_idx on auth_tokens (user_id, purpose);

create table rate_limit_buckets (
  bucket_key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket_key, window_start)
);

create table email_outbox (
  id uuid primary key default gen_random_uuid(),
  to_email citext not null,
  template text not null,
  subject text not null,
  body_text text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'captured')),
  provider text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  kind text not null default 'client' check (kind in ('agency', 'client')),
  status text not null default 'onboarding'
    check (status in ('invited', 'onboarding', 'active', 'suspended', 'archived')),
  industry text check (char_length(industry) <= 120),
  website text check (char_length(website) <= 300),
  region text check (char_length(region) <= 200),
  timezone text not null default 'UTC' check (char_length(timezone) <= 64),
  is_demo boolean not null default false,
  onboarding_completed_at timestamptz,
  suspended_reason text check (char_length(suspended_reason) <= 500),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organizations_touch before update on organizations for each row execute function app.touch_updated_at();

-- Only one agency organization may exist.
create unique index organizations_single_agency on organizations ((kind)) where kind = 'agency';

create table company_profiles (
  org_id uuid primary key references organizations(id) on delete cascade,
  description text not null default '' check (char_length(description) <= 4000),
  services text not null default '' check (char_length(services) <= 4000),
  ideal_customers text not null default '' check (char_length(ideal_customers) <= 4000),
  operating_area text not null default '' check (char_length(operating_area) <= 1000),
  goals text[] not null default '{}',
  goals_other text not null default '' check (char_length(goals_other) <= 500),
  brand_color text check (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  -- Company-wide AI defaults (tone, reply length, language, rules); employees inherit these.
  ai_preferences jsonb not null default '{}'::jsonb check (pg_column_size(ai_preferences) <= 16384),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger company_profiles_touch before update on company_profiles for each row execute function app.touch_updated_at();

create table organization_memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  invited_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_user_idx on organization_memberships (user_id) where status = 'active';
create trigger memberships_touch before update on organization_memberships for each row execute function app.touch_updated_at();

-- Agency staff are assigned to specific client tenants. Super admins see every tenant.
create table staff_assignments (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  assigned_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  email citext not null,
  role text check (role in ('owner', 'admin', 'member')),
  platform_role text check (platform_role in ('agency_staff', 'agency_super_admin')),
  token_hash text not null unique,
  invited_by uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  -- Either a tenant invitation (org + role) or an agency staff invitation (platform role), never both.
  check ((org_id is not null and role is not null and platform_role is null)
      or (org_id is null and role is null and platform_role is not null))
);
create index invitations_org_idx on invitations (org_id) where accepted_at is null and revoked_at is null;

-- Public "Get started" requests. Never provisions anything by itself.
create table access_requests (
  id uuid primary key default gen_random_uuid(),
  company_name text not null check (char_length(company_name) between 1 and 120),
  contact_name text not null check (char_length(contact_name) between 1 and 120),
  email citext not null,
  website text check (char_length(website) <= 300),
  message text check (char_length(message) <= 2000),
  status text not null default 'new' check (status in ('new', 'contacted', 'approved', 'declined')),
  reviewed_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Roles and permissions
-- ---------------------------------------------------------------------------

create table role_permissions (
  role text not null check (role in ('owner', 'admin', 'member', 'agency_staff', 'agency_super_admin')),
  permission text not null,
  primary key (role, permission)
);

create table org_features (
  org_id uuid not null references organizations(id) on delete cascade,
  feature text not null check (feature ~ '^[a-z_.]{2,64}$'),
  enabled boolean not null default true,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, feature)
);

-- ---------------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER so policies can consult membership
-- tables without recursive RLS evaluation). Each pins search_path.
-- ---------------------------------------------------------------------------

create or replace function app.platform_role() returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select u.platform_role from users u where u.id = app.current_user_id() and u.status = 'active'
$$;

create or replace function app.is_agency_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(app.platform_role() = 'agency_super_admin', false)
$$;

create or replace function app.is_agency_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(app.platform_role() in ('agency_staff', 'agency_super_admin'), false)
$$;

-- The caller's role inside a tenant. Suspended or archived tenants grant nothing to client users.
create or replace function app.org_role(p_org uuid) returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select m.role
  from organization_memberships m
  join organizations o on o.id = m.org_id
  join users u on u.id = m.user_id
  where m.org_id = p_org
    and m.user_id = app.current_user_id()
    and m.status = 'active'
    and u.status = 'active'
    and o.status not in ('suspended', 'archived')
$$;

create or replace function app.staff_assigned(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.is_agency_admin()
      or (app.is_agency_staff()
          and exists (select 1 from staff_assignments s
                      where s.org_id = p_org and s.user_id = app.current_user_id()))
$$;

create or replace function app.can_access_org(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.org_role(p_org) is not null or app.staff_assigned(p_org)
$$;

create or replace function app.has_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from role_permissions rp
    where rp.permission = p_permission
      and (
        rp.role = app.org_role(p_org)
        or (app.staff_assigned(p_org)
            and rp.role = case when app.is_agency_admin() then 'agency_super_admin' else 'agency_staff' end)
      )
  )
$$;

create or replace function app.shares_org_with(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from organization_memberships mine
    join organization_memberships theirs on theirs.org_id = mine.org_id
    where mine.user_id = app.current_user_id() and mine.status = 'active'
      and theirs.user_id = p_user
  )
  or exists (
    select 1 from organization_memberships theirs
    where theirs.user_id = p_user and app.staff_assigned(theirs.org_id)
  )
$$;

revoke all on function app.platform_role(), app.is_agency_admin(), app.is_agency_staff(),
  app.org_role(uuid), app.staff_assigned(uuid), app.can_access_org(uuid),
  app.has_permission(uuid, text), app.shares_org_with(uuid) from public;
grant execute on function app.current_user_id(), app.platform_role(), app.is_agency_admin(),
  app.is_agency_staff(), app.org_role(uuid), app.staff_assigned(uuid), app.can_access_org(uuid),
  app.has_permission(uuid, text), app.shares_org_with(uuid) to iaq_app_user;

-- ---------------------------------------------------------------------------
-- Row-level security: identity and tenancy
-- ---------------------------------------------------------------------------

alter table users enable row level security;
alter table organizations enable row level security;
alter table company_profiles enable row level security;
alter table organization_memberships enable row level security;
alter table staff_assignments enable row level security;
alter table role_permissions enable row level security;
alter table org_features enable row level security;
alter table auth_credentials enable row level security;
alter table auth_sessions enable row level security;
alter table auth_tokens enable row level security;
alter table invitations enable row level security;
alter table access_requests enable row level security;
alter table email_outbox enable row level security;
alter table rate_limit_buckets enable row level security;

grant select on users to iaq_app_user;
grant update (full_name, timezone, preferences) on users to iaq_app_user;
create policy users_select on users for select to iaq_app_user
  using (id = app.current_user_id() or app.shares_org_with(id) or app.is_agency_admin());
create policy users_update_self on users for update to iaq_app_user
  using (id = app.current_user_id()) with check (id = app.current_user_id());

grant select on organizations to iaq_app_user;
grant update (name, industry, website, region, timezone) on organizations to iaq_app_user;
create policy organizations_select on organizations for select to iaq_app_user
  using (app.can_access_org(id));
create policy organizations_update on organizations for update to iaq_app_user
  using (app.has_permission(id, 'workspace.manage_profile'))
  with check (app.has_permission(id, 'workspace.manage_profile'));

grant select, insert, update on company_profiles to iaq_app_user;
create policy company_profiles_select on company_profiles for select to iaq_app_user
  using (app.can_access_org(org_id));
create policy company_profiles_insert on company_profiles for insert to iaq_app_user
  with check (app.has_permission(org_id, 'workspace.manage_profile'));
create policy company_profiles_update on company_profiles for update to iaq_app_user
  using (app.has_permission(org_id, 'workspace.manage_profile'))
  with check (app.has_permission(org_id, 'workspace.manage_profile'));

grant select on organization_memberships to iaq_app_user;
create policy memberships_select on organization_memberships for select to iaq_app_user
  using (user_id = app.current_user_id() or app.can_access_org(org_id));

grant select on staff_assignments to iaq_app_user;
create policy staff_assignments_select on staff_assignments for select to iaq_app_user
  using (app.is_agency_admin() or user_id = app.current_user_id());

grant select on role_permissions to iaq_app_user;
create policy role_permissions_select on role_permissions for select to iaq_app_user using (true);

grant select on org_features to iaq_app_user;
create policy org_features_select on org_features for select to iaq_app_user
  using (app.can_access_org(org_id));

-- auth_credentials, auth_sessions, auth_tokens, invitations, access_requests, email_outbox and
-- rate_limit_buckets intentionally have no grants or policies for iaq_app_user.
