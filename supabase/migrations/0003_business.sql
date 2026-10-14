-- iAcquire Client Portal — approvals, tasks, leads, CRM references, appointments, retention.

-- ---------------------------------------------------------------------------
-- Approval Center
-- ---------------------------------------------------------------------------

create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid references agent_instances(id) on delete set null,
  requested_by uuid references users(id) on delete set null,
  kind text not null check (kind in (
    'lead_import', 'outreach', 'follow_up_message', 'crm_update', 'campaign_activation',
    'knowledge_change', 'tool_action', 'config_change')),
  title text not null check (char_length(title) between 1 and 200),
  action jsonb not null default '{}'::jsonb check (pg_column_size(action) <= 32768),
  target_type text check (char_length(target_type) <= 60),
  target_id text check (char_length(target_id) <= 120),
  target_label text check (char_length(target_label) <= 200),
  reason text not null default '' check (char_length(reason) <= 2000),
  expected_effect text not null default '' check (char_length(expected_effect) <= 2000),
  risk text not null default 'medium' check (risk in ('low', 'medium', 'high', 'critical')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'changes_requested', 'expired', 'cancelled')),
  execution_status text not null default 'not_started'
    check (execution_status in ('not_started', 'queued', 'running', 'succeeded', 'failed', 'blocked')),
  execution_detail text check (char_length(execution_detail) <= 1000),
  expires_at timestamptz,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 1000),
  executed_at timestamptz,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An action can only start executing after an approval decision.
  check (execution_status in ('not_started', 'blocked') or status = 'approved')
);
create index approval_requests_org_idx on approval_requests (org_id, status, created_at desc);
create trigger approval_requests_touch before update on approval_requests for each row execute function app.touch_updated_at();

create table approval_events (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references approval_requests(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  actor_kind text not null default 'user' check (actor_kind in ('user', 'agent', 'system')),
  event text not null check (event in (
    'created', 'approved', 'rejected', 'changes_requested', 'expired', 'cancelled',
    'execution_queued', 'execution_started', 'execution_succeeded', 'execution_failed', 'execution_blocked')),
  note text check (char_length(note) <= 1000),
  created_at timestamptz not null default now()
);
create index approval_events_approval_idx on approval_events (approval_id, created_at);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text check (char_length(description) <= 2000),
  category text not null default 'general' check (category in ('general', 'follow_up', 'retention', 'sales', 'setup')),
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  assigned_user_id uuid references users(id) on delete set null,
  related_type text check (char_length(related_type) <= 60),
  related_id text check (char_length(related_id) <= 120),
  source text not null default 'user' check (source in ('user', 'agent', 'system')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index tasks_org_idx on tasks (org_id, status, due_at);

-- ---------------------------------------------------------------------------
-- Lead generation (research staging; research is never consent)
-- ---------------------------------------------------------------------------

create table lead_targeting_profiles (
  org_id uuid primary key references organizations(id) on delete cascade,
  criteria jsonb not null default '{}'::jsonb check (pg_column_size(criteria) <= 16384),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table lead_research_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  requested_by uuid references users(id) on delete set null,
  prompt text not null check (char_length(prompt) between 3 and 1000),
  campaign_type text not null default 'business' check (campaign_type in ('business', 'influencer')),
  criteria jsonb not null default '{}'::jsonb check (pg_column_size(criteria) <= 16384),
  status text not null default 'waiting_for_agent'
    check (status in ('waiting_for_agent', 'queued', 'running', 'completed', 'failed', 'cancelled')),
  agent_run_id uuid references agent_runs(id) on delete set null,
  result_count integer not null default 0,
  failure_reason text check (char_length(failure_reason) <= 500),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index lead_research_org_idx on lead_research_requests (org_id, created_at desc);

create table leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  research_request_id uuid references lead_research_requests(id) on delete set null,
  business_name text not null check (char_length(business_name) between 1 and 200),
  website text check (char_length(website) <= 300),
  domain text check (char_length(domain) <= 253),
  industry text check (char_length(industry) <= 120),
  location text check (char_length(location) <= 200),
  source_platform text not null default 'research' check (char_length(source_platform) <= 60),
  evidence jsonb not null default '[]'::jsonb check (pg_column_size(evidence) <= 32768),
  score integer check (score between 0 and 100),
  score_breakdown jsonb not null default '{}'::jsonb,
  qualification_summary text check (char_length(qualification_summary) <= 2000),
  buying_signals text[] not null default '{}',
  duplicate_status text not null default 'not_checked'
    check (duplicate_status in ('not_checked', 'no_match', 'possible_duplicate', 'duplicate')),
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  crm_sync_status text not null default 'not_synced'
    check (crm_sync_status in ('not_synced', 'awaiting_approval', 'blocked', 'synced', 'failed')),
  ghl_contact_id text,
  -- Research does not establish interest, consent, or permission to contact.
  consent_status text not null default 'unknown' check (consent_status in ('unknown')),
  outreach_status text not null default 'blocked' check (outreach_status in ('blocked')),
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index leads_org_idx on leads (org_id, review_status, created_at desc);
create index leads_domain_idx on leads (org_id, domain);

-- ---------------------------------------------------------------------------
-- CRM references (read-through cache of the tenant's mapped GHL location only)
-- ---------------------------------------------------------------------------

create table crm_pipelines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  ghl_pipeline_id text not null,
  name text not null,
  stages jsonb not null default '[]'::jsonb,
  synced_at timestamptz not null default now(),
  unique (org_id, ghl_pipeline_id)
);

create table crm_opportunities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  ghl_opportunity_id text not null,
  ghl_pipeline_id text,
  stage_id text,
  stage_name text,
  name text not null,
  status text not null check (status in ('open', 'won', 'lost', 'abandoned')),
  monetary_value numeric(14, 2),
  contact_label text,
  assigned_to text,
  source text,
  remote_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (org_id, ghl_opportunity_id)
);
create index crm_opportunities_org_idx on crm_opportunities (org_id, status);

create table appointment_refs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  ghl_appointment_id text not null,
  ghl_calendar_id text not null,
  title text not null default 'Appointment',
  status text not null check (status in ('new', 'confirmed', 'cancelled', 'showed', 'noshow', 'invalid')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text,
  meeting_type text,
  meeting_link text check (meeting_link ~ '^https://'),
  contact_label text,
  remote_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (org_id, ghl_appointment_id)
);
create index appointment_refs_org_idx on appointment_refs (org_id, start_at);

create table record_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  record_type text not null check (record_type in ('opportunity', 'lead', 'retention_account', 'appointment')),
  record_id text not null check (char_length(record_id) <= 120),
  body text not null check (char_length(body) between 1 and 4000),
  author_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index record_notes_record_idx on record_notes (org_id, record_type, record_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Customer retention (structures ready; no live automations implied)
-- ---------------------------------------------------------------------------

create table retention_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  customer_name text not null check (char_length(customer_name) between 1 and 200),
  status text not null default 'active' check (status in ('onboarding', 'active', 'at_risk', 'churned')),
  health text not null default 'unknown' check (health in ('unknown', 'healthy', 'watch', 'at_risk')),
  onboarding_progress integer check (onboarding_progress between 0 and 100),
  renewal_date date,
  last_contact_at timestamptz,
  open_issues integer not null default 0 check (open_issues >= 0),
  repeat_opportunity text check (char_length(repeat_opportunity) <= 500),
  source text not null default 'manual' check (source in ('manual', 'crm')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index retention_accounts_org_idx on retention_accounts (org_id, status);
create trigger retention_accounts_touch before update on retention_accounts for each row execute function app.touch_updated_at();

create table customer_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  account_id uuid references retention_accounts(id) on delete cascade,
  rating integer check (rating between 1 and 5),
  comment text check (char_length(comment) <= 2000),
  received_at timestamptz not null default now(),
  created_by uuid references users(id) on delete set null
);

create table service_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  account_id uuid not null references retention_accounts(id) on delete cascade,
  event text not null check (char_length(event) between 1 and 500),
  occurred_at timestamptz not null default now(),
  created_by uuid references users(id) on delete set null
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table approval_requests enable row level security;
alter table approval_events enable row level security;
alter table tasks enable row level security;
alter table lead_targeting_profiles enable row level security;
alter table lead_research_requests enable row level security;
alter table leads enable row level security;
alter table crm_pipelines enable row level security;
alter table crm_opportunities enable row level security;
alter table appointment_refs enable row level security;
alter table record_notes enable row level security;
alter table retention_accounts enable row level security;
alter table customer_feedback enable row level security;
alter table service_history enable row level security;

-- Approval decisions are executed by the server's approval service, which performs an atomic
-- compare-and-set. Users may read; writes go through that service only.
grant select on approval_requests to iaq_app_user;
create policy approvals_select on approval_requests for select to iaq_app_user
  using (app.has_permission(org_id, 'approvals.view'));

grant select on approval_events to iaq_app_user;
create policy approval_events_select on approval_events for select to iaq_app_user
  using (app.has_permission(org_id, 'approvals.view'));

grant select, insert on tasks to iaq_app_user;
grant update (status, completed_at, assigned_user_id, due_at) on tasks to iaq_app_user;
create policy tasks_select on tasks for select to iaq_app_user
  using (app.can_access_org(org_id));
create policy tasks_insert on tasks for insert to iaq_app_user
  with check (app.has_permission(org_id, 'tasks.manage') and source = 'user' and created_by = app.current_user_id());
create policy tasks_update on tasks for update to iaq_app_user
  using (app.has_permission(org_id, 'tasks.manage'))
  with check (app.has_permission(org_id, 'tasks.manage'));

grant select, insert, update on lead_targeting_profiles to iaq_app_user;
create policy targeting_select on lead_targeting_profiles for select to iaq_app_user
  using (app.has_permission(org_id, 'leads.view'));
create policy targeting_insert on lead_targeting_profiles for insert to iaq_app_user
  with check (app.has_permission(org_id, 'leads.research'));
create policy targeting_update on lead_targeting_profiles for update to iaq_app_user
  using (app.has_permission(org_id, 'leads.research'))
  with check (app.has_permission(org_id, 'leads.research'));

grant select on lead_research_requests to iaq_app_user;
create policy research_select on lead_research_requests for select to iaq_app_user
  using (app.has_permission(org_id, 'leads.view'));

grant select on leads to iaq_app_user;
create policy leads_select on leads for select to iaq_app_user
  using (app.has_permission(org_id, 'leads.view'));

grant select on crm_pipelines to iaq_app_user;
create policy crm_pipelines_select on crm_pipelines for select to iaq_app_user
  using (app.has_permission(org_id, 'sales.view'));

grant select on crm_opportunities to iaq_app_user;
create policy crm_opportunities_select on crm_opportunities for select to iaq_app_user
  using (app.has_permission(org_id, 'sales.view'));

grant select on appointment_refs to iaq_app_user;
create policy appointment_refs_select on appointment_refs for select to iaq_app_user
  using (app.has_permission(org_id, 'appointments.view'));

grant select, insert on record_notes to iaq_app_user;
create policy record_notes_select on record_notes for select to iaq_app_user
  using (app.can_access_org(org_id));
create policy record_notes_insert on record_notes for insert to iaq_app_user
  with check (app.has_permission(org_id, 'notes.write') and author_id = app.current_user_id());

grant select, insert, update on retention_accounts to iaq_app_user;
create policy retention_select on retention_accounts for select to iaq_app_user
  using (app.has_permission(org_id, 'retention.view'));
create policy retention_insert on retention_accounts for insert to iaq_app_user
  with check (app.has_permission(org_id, 'retention.edit') and created_by = app.current_user_id());
create policy retention_update on retention_accounts for update to iaq_app_user
  using (app.has_permission(org_id, 'retention.edit'))
  with check (app.has_permission(org_id, 'retention.edit'));

grant select, insert on customer_feedback to iaq_app_user;
create policy feedback_select on customer_feedback for select to iaq_app_user
  using (app.has_permission(org_id, 'retention.view'));
create policy feedback_insert on customer_feedback for insert to iaq_app_user
  with check (app.has_permission(org_id, 'retention.edit') and created_by = app.current_user_id());

grant select, insert on service_history to iaq_app_user;
create policy service_history_select on service_history for select to iaq_app_user
  using (app.has_permission(org_id, 'retention.view'));
create policy service_history_insert on service_history for insert to iaq_app_user
  with check (app.has_permission(org_id, 'retention.edit') and created_by = app.current_user_id());
