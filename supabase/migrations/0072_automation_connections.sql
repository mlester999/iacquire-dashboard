-- Automation Studio: tenant-scoped connections to outside systems (a Slack incoming webhook, an HTTP API), and what a workflow step needs to use one.
--
--   * automation_connections holds one connection of one workspace. The secret it carries (a Slack webhook address, an API token, a header value)
--     is stored only as AES-GCM ciphertext (the application role cannot read the column) and is shown once, when it is created or rotated.
--     What the interface and the AI builder see is its name, kind, non-secret settings (the host and methods an HTTP connection may use), its status
--     and the last four characters of the secret.
--   * A connection is checked by sending a test with the owner's explicit confirmation; until then it is "unverified" and a workflow can't be
--     published with it. Rotating a secret makes the connection unverified again. Revoking one erases its ciphertext for good.
--   * automation_connection_calls is the call log: one row per outside call a step made, with what is safe to keep (host, path without its query,
--     method, status, size, duration, outcome) and never a header, a body or a secret. It also lets the engine limit how many calls a workspace
--     (or one connection) has in flight and per minute.
--
-- Written by trusted server code only. People with "See automations" may read their own workspace's rows (never the ciphertext column).
-- Rollback: supabase/rollbacks/0072_automation_connections.down.sql.

create table automation_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('http', 'slack_webhook')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- Non-secret settings, checked by the server for each kind: an HTTP connection's host, path prefix, allowed methods and how it signs requests.
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 4096),
  -- AES-GCM ciphertext of the secret (null for an HTTP connection that needs none, and after a revocation).
  secret_ciphertext text check (secret_ciphertext is null or char_length(secret_ciphertext) <= 4000),
  secret_hint text check (secret_hint is null or char_length(secret_hint) between 1 and 12),
  secret_version integer not null default 1 check (secret_version >= 1),
  status text not null default 'unverified' check (status in ('unverified', 'active', 'needs_attention', 'revoked')),
  status_detail text check (char_length(status_detail) <= 300),
  verified_at timestamptz,
  verified_by uuid references users(id) on delete set null,
  last_used_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  rotated_at timestamptz,
  rotated_by uuid references users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references users(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  check ((status = 'revoked') = (revoked_at is not null)),
  -- A Slack connection is its secret address; only a revoked one has none.
  check (kind <> 'slack_webhook' or status = 'revoked' or secret_ciphertext is not null),
  check (status <> 'revoked' or secret_ciphertext is null)
);
create unique index automation_connections_live_name on automation_connections (org_id, lower(name)) where status <> 'revoked';
create index automation_connections_org on automation_connections (org_id, kind) where status <> 'revoked';
create trigger automation_connections_touch before update on automation_connections for each row execute function app.touch_updated_at();

create table automation_connection_calls (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  connection_id uuid not null,
  workflow_id uuid,
  run_id uuid,
  -- 'step' (a workflow), 'test' (a person's confirmed test)
  origin text not null check (origin in ('step', 'test')),
  method text not null check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'SLACK')),
  host text not null check (char_length(host) <= 253),
  -- The path only: never the query string, which can carry a secret.
  path text not null check (char_length(path) <= 300),
  -- sent: answered 2xx; rejected: answered with an error; blocked: refused here before anything left; failed: no answer (a connection error, a timeout).
  outcome text not null check (outcome in ('sent', 'rejected', 'blocked', 'failed')),
  http_status integer check (http_status between 100 and 599),
  response_bytes integer check (response_bytes >= 0),
  duration_ms integer check (duration_ms >= 0),
  -- In words, with secrets removed.
  detail text check (char_length(detail) <= 300),
  created_at timestamptz not null default now(),
  foreign key (connection_id, org_id) references automation_connections (id, org_id) on delete cascade
);
create index automation_connection_calls_recent on automation_connection_calls (connection_id, created_at desc);
create index automation_connection_calls_org_recent on automation_connection_calls (org_id, created_at desc);

alter table automation_connections enable row level security;
alter table automation_connection_calls enable row level security;
revoke all on automation_connections, automation_connection_calls from public, anon, authenticated, iaq_site_runtime;
-- Everything but the ciphertext.
grant select (id, org_id, kind, name, settings, secret_hint, secret_version, status, status_detail, verified_at, verified_by, last_used_at, consecutive_failures,
              rotated_at, rotated_by, revoked_at, revoked_by, created_by, created_at, updated_at)
  on automation_connections to iaq_app_user;
grant select on automation_connection_calls to iaq_app_user;

create policy automation_connections_select on automation_connections for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('workflows.view'))::uuid[]));
create policy automation_connection_calls_select on automation_connection_calls for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('workflows.view'))::uuid[]));
