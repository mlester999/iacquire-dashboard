-- Additive: legacy integration_credentials ciphertext stays intact for explicit migration.
-- New credentials are references to managed Supabase Vault, never app-owned ciphertext.
create table credential_references (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  provider text not null check (provider in ('hermes','ghl','n8n','email','google_calendar','domain','external')),
  store text not null check (store in ('supabase_vault','test_memory')),
  vault_secret_id uuid not null unique,
  label text not null check (char_length(label) between 1 and 120),
  fingerprint text not null,
  scopes text[] not null default '{}',
  version integer not null default 1 check (version > 0),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz
);
alter table credential_references enable row level security;
revoke all on credential_references from public;
alter table integration_credentials add column credential_reference_id uuid references credential_references(id);

create table integration_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  provider text not null check (provider in ('supabase','hermes','ghl','n8n','google_calendar','email','domain','external')),
  label text not null check (char_length(label) between 1 and 120),
  environment text not null default 'development' check (environment in ('development','staging','production')),
  config jsonb not null default '{}' check (jsonb_typeof(config) = 'object'),
  credential_id uuid references integration_credentials(id),
  status text not null default 'not_configured' check (status in ('not_configured','credentials_saved','testing','connected','permission_limited','needs_attention','disconnected','error')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  capabilities jsonb not null default '{}' check (jsonb_typeof(capabilities) = 'object'),
  revision integer not null default 1,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (provider <> 'ghl' or org_id is not null)
);
create unique index integration_connections_scope_provider on integration_connections (coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid),provider);
create index integration_connections_org on integration_connections(org_id);
create trigger integration_connections_touch before update on integration_connections for each row execute function app.touch_updated_at();

create table integration_connection_checks (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references integration_connections(id) on delete cascade,
  connection_revision integer not null,
  status text not null check (status in ('connected','permission_limited','needs_attention','error')),
  detail text not null check (char_length(detail) <= 500),
  capabilities jsonb not null default '{}' check (jsonb_typeof(capabilities) = 'object'),
  verification_mode text not null check (verification_mode in ('live_read_only','mock')),
  checked_by uuid references users(id),
  checked_at timestamptz not null default now()
);
create index integration_checks_latest on integration_connection_checks(connection_id,checked_at desc);
alter table integration_connections enable row level security;
alter table integration_connection_checks enable row level security;
grant select on integration_connections,integration_connection_checks to iaq_app_user;
create policy integration_connections_agency_select on integration_connections for select to iaq_app_user using (
  app.is_agency_admin() or (org_id is not null and app.is_agency_staff() and app.can_access_org(org_id))
);
create policy integration_checks_agency_select on integration_connection_checks for select to iaq_app_user using (
  exists (select 1 from integration_connections c where c.id=connection_id)
);

-- Both sides of a credential relationship must have the exact same tenant and provider.
create function app.guard_integration_credential_scope() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_org uuid; v_provider text;
begin
  if new.credential_id is not null then
    select org_id,provider into v_org,v_provider from integration_credentials where id=new.credential_id;
    if v_org is distinct from new.org_id or v_provider is distinct from new.provider then
      raise exception 'integration_credential_scope_mismatch' using errcode='check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger integration_credential_scope before insert or update on integration_connections for each row execute function app.guard_integration_credential_scope();

create table automation_template_mappings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  global_connection_id uuid not null references integration_connections(id),
  workflow_id text not null check(workflow_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  template_key text not null default 'agency-approved' check(char_length(template_key) between 1 and 80),
  status text not null default 'unverified' check(status in('unverified','verified','needs_attention')),
  last_verified_at timestamptz,
  last_error text check(char_length(last_error)<=500),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique(org_id,workflow_id),
  unique(global_connection_id,workflow_id)
);
alter table automation_template_mappings enable row level security;
grant select on automation_template_mappings to iaq_app_user;
create policy automation_mappings_agency_select on automation_template_mappings for select to iaq_app_user using(app.is_agency_staff() and app.can_access_org(org_id));
create function app.guard_global_automation_mapping() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from integration_connections where id=new.global_connection_id and org_id is null and provider='n8n') then
    raise exception 'automation_requires_agency_n8n_connection' using errcode='check_violation';
  end if;
  return new;
end $$;
create trigger automation_global_scope before insert or update on automation_template_mappings for each row execute function app.guard_global_automation_mapping();

-- Installing/enabling Vault is an explicit development-project setup step, not an automatic
-- external infrastructure operation. If available, close its secret surfaces to browser roles.
do $$ declare r text; begin
  if exists (select 1 from pg_namespace where nspname='vault') then
    foreach r in array array['anon','authenticated','iaq_app_user'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        -- Hosted Supabase: vault objects are owned by supabase_admin, so object-level revokes may be
        -- refused for the migration role. Revoking schema usage is what closes the surface.
        begin
          execute format('revoke all on all tables in schema vault from %I',r);
          execute format('revoke all on all functions in schema vault from %I',r);
        exception when insufficient_privilege then
          raise notice 'vault object revokes skipped for %: insufficient privilege', r;
        end;
        execute format('revoke usage on schema vault from %I',r);
      end if;
    end loop;
  end if;
end $$;
