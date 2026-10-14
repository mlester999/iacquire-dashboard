-- Operations: scheduled-job heartbeats, incidents with a real detect-to-recovery lifecycle, and notification email delivery tracking.
--
-- Incidents are opened only from recorded evidence (a probe or a failed job) and are closed only by a later healthy probe,
-- or by a person who says so; the two outcomes are stored separately so a manual close is never presented as a verified recovery.
-- As elsewhere, the application role is read-only; trusted server code performs every write after authorizing it.

-- ---------------------------------------------------------------------------
-- Scheduled job heartbeats (platform-wide, agency-readable)
-- ---------------------------------------------------------------------------

create table worker_job_runs (
  job_name text primary key check (job_name ~ '^[a-zA-Z][a-zA-Z0-9_]{1,60}$'),
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  runs_total bigint not null default 0,
  last_duration_ms integer check (last_duration_ms >= 0),
  -- A short, sanitized error class and message. Never a stack trace, URL with credentials or customer content.
  last_error text check (char_length(last_error) <= 300),
  last_result jsonb check (last_result is null or pg_column_size(last_result) <= 4000)
);

-- ---------------------------------------------------------------------------
-- Incidents
-- ---------------------------------------------------------------------------

create table incidents (
  id uuid primary key default gen_random_uuid(),
  -- Null means platform-wide (for example the scheduler stopped). Tenant incidents carry the affected organization.
  org_id uuid references organizations(id) on delete cascade,
  source text not null check (source in (
    'database', 'scheduler', 'ghl', 'hermes', 'n8n', 'appointment_processor', 'website', 'domain', 'messaging', 'payments', 'queue', 'credits', 'email', 'integration', 'automation')),
  subject text not null default '' check (char_length(subject) <= 120),
  dedupe_key text not null check (char_length(dedupe_key) between 3 and 200),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  title text not null check (char_length(title) between 1 and 200),
  detail text check (char_length(detail) <= 600),
  evidence jsonb not null default '{}' check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 4000),
  -- What the platform is holding back while this persists. Only protections the code genuinely enforces are listed.
  safe_actions text[] not null default '{}',
  recovery_guidance text check (char_length(recovery_guidance) <= 600),
  -- Tenant incidents are visible to the client's owner and managers when this is true. Platform incidents never are.
  client_visible boolean not null default false,
  detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1 check (occurrences >= 1),
  acknowledged_by uuid references users(id) on delete set null,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references users(id) on delete set null,
  -- verified_recovery: a later healthy check confirmed it. manual: a person closed it; nothing confirmed recovery.
  resolution text check (resolution in ('verified_recovery', 'manual')),
  recovery_evidence text check (char_length(recovery_evidence) <= 400),
  created_at timestamptz not null default now(),
  check ((status = 'resolved') = (resolved_at is not null)),
  check ((status = 'resolved') = (resolution is not null)),
  check (org_id is not null or not client_visible)
);
-- One open incident per condition; a repeat of the same fault updates it instead of creating another.
create unique index incidents_one_open on incidents (dedupe_key) where status <> 'resolved';
create index incidents_org_idx on incidents (org_id, status, detected_at desc);
create index incidents_status_idx on incidents (status, severity, detected_at desc);

create table incident_events (
  id uuid primary key default gen_random_uuid(),
  -- Events written in one transaction share a timestamp, so the sequence is what keeps the timeline in order.
  seq bigint generated always as identity,
  incident_id uuid not null references incidents(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  kind text not null check (kind in ('detected', 'recurred', 'escalated', 'acknowledged', 'note', 'action', 'notified', 'recovered', 'resolved_manually')),
  detail text check (char_length(detail) <= 600),
  actor_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index incident_events_incident_idx on incident_events (incident_id, seq);

-- ---------------------------------------------------------------------------
-- Notification email delivery
-- ---------------------------------------------------------------------------

create table notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  channel text not null check (channel in ('email')),
  status text not null check (status in ('queued', 'sent', 'failed', 'skipped')),
  skip_reason text check (char_length(skip_reason) <= 200),
  email_outbox_id uuid references email_outbox(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (notification_id, channel)
);
create index notification_deliveries_user_idx on notification_deliveries (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table worker_job_runs enable row level security;
alter table incidents enable row level security;
alter table incident_events enable row level security;
alter table notification_deliveries enable row level security;
revoke all on worker_job_runs, incidents, incident_events, notification_deliveries from public, anon, authenticated;
grant select on worker_job_runs, incidents, incident_events, notification_deliveries to iaq_app_user;

create policy worker_job_runs_select on worker_job_runs for select to iaq_app_user using (app.is_agency_staff());

-- Agency staff see everything. A client sees only its own incidents that were marked client-visible.
create policy incidents_select on incidents for select to iaq_app_user using (
  app.is_agency_staff() or (org_id is not null and client_visible and app.has_permission(org_id, 'incidents.view')));
create policy incident_events_select on incident_events for select to iaq_app_user using (
  app.is_agency_staff() or exists (select 1 from incidents i where i.id = incident_id and i.org_id is not null and i.client_visible and app.has_permission(i.org_id, 'incidents.view')));
create policy notification_deliveries_select on notification_deliveries for select to iaq_app_user using (user_id = app.current_user_id());

insert into role_permissions (role, permission) values
  ('owner', 'incidents.view'), ('admin', 'incidents.view'), ('agency_staff', 'incidents.view'), ('agency_super_admin', 'incidents.view'),
  ('agency_staff', 'incidents.manage'), ('agency_super_admin', 'incidents.manage');
