-- 0068_aqi_operations.sql
-- Super Admin AQi: AI Platform Operations Copilot.
--
-- Adds the persistent state the operations copilot needs and nothing the Client assistant depends on:
--   * aqi_conversations.surface        separates investigations from the Client assistant's history.
--   * aqi_ops_actions                  propose -> confirm -> execute -> verify lifecycle for the few
--                                      write actions AQi may perform, with idempotency and a stored preview.
--   * aqi_ops_briefing_settings        explicit, per-administrator opt-in for scheduled briefings.
--   * aqi_ops_briefings                generated briefings, de-duplicated by key.
--   * three indexes                    audit_logs (action, created_at), appointment_reminders (org, updated) and
--                                      crm_webhook_deliveries (org, created) so security scans and per-client traces are bounded.
--
-- Client AQi code paths do not reference any of this, so the Client assistant keeps working if this
-- migration has not been applied yet. Rows in the new tables are reachable only through server code
-- that has already authorised a Super Admin: RLS is enabled with no policy for the app role.
-- Non-destructive: one additive column with a default, three new tables and their indexes, three indexes on existing tables.
-- Rollback: supabase/rollbacks/0068_aqi_operations.down.sql. Not applied to any hosted project.

alter table aqi_conversations
  add column if not exists surface text not null default 'assistant'
    check (surface in ('assistant', 'operations'));

create index if not exists aqi_conversations_surface_idx
  on aqi_conversations (user_id, surface, last_message_at desc);

comment on column aqi_conversations.surface is
  'assistant = the Client/agency-staff AQi assistant; operations = a Super Admin AQi Operations investigation.';

-- ---------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------

create table if not exists aqi_ops_actions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references aqi_conversations(id) on delete set null,
  message_id uuid references aqi_messages(id) on delete set null,
  requested_by uuid not null references users(id) on delete cascade,
  tool_id text not null check (tool_id ~ '^[a-z_]+(\.[a-z_]+)+$'),
  org_id uuid references organizations(id) on delete set null,
  scope_type text not null check (scope_type in ('platform', 'tenant', 'employee', 'workflow', 'ticket', 'incident')),
  scope_id text check (scope_id is null or char_length(scope_id) <= 80),
  risk text not null check (risk in ('low', 'medium', 'high', 'critical')),
  approval text not null check (approval in ('confirm', 'confirm_with_reason', 'typed_confirmation')),
  status text not null default 'proposed'
    check (status in ('proposed', 'executing', 'succeeded', 'verification_failed', 'failed', 'cancelled', 'expired')),
  args jsonb not null default '{}'::jsonb check (pg_column_size(args) <= 8192),
  preview jsonb not null default '{}'::jsonb check (pg_column_size(preview) <= 16384),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 120),
  reason text check (reason is null or char_length(reason) <= 500),
  confirmed_at timestamptz,
  confirmed_by uuid references users(id) on delete set null,
  executed_at timestamptz,
  finished_at timestamptz,
  result jsonb not null default '{}'::jsonb check (pg_column_size(result) <= 16384),
  verified boolean,
  verification jsonb not null default '{}'::jsonb check (pg_column_size(verification) <= 8192),
  error_code text check (error_code is null or char_length(error_code) <= 60),
  error_message text check (error_message is null or char_length(error_message) <= 500),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A proposal is only ever confirmed once, and success without a verification result is impossible.
  check (status <> 'succeeded' or verified is true),
  check (status <> 'verification_failed' or verified is false)
);
create unique index if not exists aqi_ops_actions_idempotency_idx on aqi_ops_actions (requested_by, idempotency_key);
create index if not exists aqi_ops_actions_user_idx on aqi_ops_actions (requested_by, created_at desc);
create index if not exists aqi_ops_actions_org_idx on aqi_ops_actions (org_id, created_at desc) where org_id is not null;
create index if not exists aqi_ops_actions_open_idx on aqi_ops_actions (status, expires_at) where status in ('proposed', 'executing');
create trigger aqi_ops_actions_touch before update on aqi_ops_actions for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Briefings (explicit administrative configuration; nothing is generated for someone who has not opted in)
-- ---------------------------------------------------------------------------

create table if not exists aqi_ops_briefing_settings (
  user_id uuid primary key references users(id) on delete cascade,
  daily_enabled boolean not null default false,
  weekly_enabled boolean not null default false,
  critical_alerts_enabled boolean not null default false,
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  daily_hour smallint not null default 8 check (daily_hour between 0 and 23),
  weekly_day smallint not null default 1 check (weekly_day between 0 and 6),
  quiet_start smallint check (quiet_start is null or quiet_start between 0 and 23),
  quiet_end smallint check (quiet_end is null or quiet_end between 0 and 23),
  last_daily_for date,
  last_weekly_for date,
  updated_at timestamptz not null default now(),
  check ((quiet_start is null) = (quiet_end is null))
);
create trigger aqi_ops_briefing_settings_touch before update on aqi_ops_briefing_settings for each row execute function app.touch_updated_at();

create table if not exists aqi_ops_briefings (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('daily', 'weekly', 'critical', 'on_demand')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  dedupe_key text not null check (char_length(dedupe_key) between 8 and 160),
  title text not null check (char_length(title) between 1 and 200),
  summary text not null default '' check (char_length(summary) <= 2000),
  sections jsonb not null default '[]'::jsonb check (pg_column_size(sections) <= 65536),
  sources jsonb not null default '[]'::jsonb check (pg_column_size(sources) <= 8192),
  status text not null default 'generated' check (status in ('generated', 'delivered', 'suppressed')),
  suppressed_reason text check (suppressed_reason is null or char_length(suppressed_reason) <= 200),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);
create unique index if not exists aqi_ops_briefings_dedupe_idx on aqi_ops_briefings (dedupe_key);
create index if not exists aqi_ops_briefings_recipient_idx on aqi_ops_briefings (recipient_user_id, created_at desc);

alter table aqi_ops_actions enable row level security;
alter table aqi_ops_briefing_settings enable row level security;
alter table aqi_ops_briefings enable row level security;
revoke all on aqi_ops_actions, aqi_ops_briefing_settings, aqi_ops_briefings from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Telemetry and security scans
-- ---------------------------------------------------------------------------

-- Action-scoped, time-windowed scans (failed sign-ins this week, AQi tool latency) had no supporting index.
create index if not exists audit_logs_action_created_idx on audit_logs (action, created_at desc);

-- Per-client delivery traces filter these two tables by workspace and recent time; neither had an index that serves that.
create index if not exists appointment_reminders_org_updated_idx on appointment_reminders (org_id, updated_at desc);
create index if not exists crm_webhook_deliveries_org_created_idx on crm_webhook_deliveries (org_id, created_at desc);
