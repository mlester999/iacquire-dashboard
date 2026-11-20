-- Tenant-owned OAuth lifecycle for metadata-only, opt-in workspace connections.
-- Deployment without provider app registrations leaves both connection starts unavailable.
create table workspace_oauth_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('notion', 'airtable')),
  status text not null check (status in ('connected', 'needs_reauth', 'error', 'disconnected')),
  credentials text check (credentials is null or credentials like 'v1.%'),
  access_expires_at timestamptz,
  last_checked_at timestamptz,
  last_verified_at timestamptz,
  has_shared_resources boolean,
  check_id uuid,
  check_started_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (org_id, provider),
  check ((check_id is null) = (check_started_at is null)),
  check (status <> 'connected' or (credentials is not null and last_verified_at is not null)),
  check (status <> 'disconnected' or (credentials is null and access_expires_at is null))
);

create table workspace_oauth_states (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid not null,
  provider text not null check (provider in ('notion', 'airtable')),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  session_hash text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  code_verifier text check (code_verifier is null or code_verifier like 'v1.%'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  unique (org_id, provider),
  foreign key (org_id, user_id) references organization_memberships (org_id, user_id) on delete cascade,
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  check ((provider = 'airtable') = (code_verifier is not null))
);

alter table workspace_oauth_connections enable row level security;
alter table workspace_oauth_states enable row level security;
revoke all on workspace_oauth_connections, workspace_oauth_states from public, anon, authenticated, iaq_app_user, iaq_site_runtime, service_role;
