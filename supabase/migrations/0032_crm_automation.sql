-- iAcquire Native CRM, automation and AI (phase 4): a native workflow engine on the transactional event outbox, lead assignment rules,
-- scoped CRM tools for a client's own AI employees, signed outbound webhooks, and scoped API keys.
--
--   * Workflows: a definition with immutable published versions. Runs are created by the event dispatcher from crm_events (one run per
--     workflow and triggering event, so a redelivered event never starts a second run), and executed one step at a time by the
--     scheduler with leases, retries, a dead-letter state and a loop limit carried from the triggering event's depth. A version that can send
--     messages runs only after an owner approved that exact version (its content hash), as retention programs already work.
--   * Lead assignment: rules with members and a strategy; assignments lock the rule row so two workers never hand the same lead out twice.
--   * Agent tools: short-lived tokens bound to one AI employee, one run and a set of scopes, stored only as hashes.
--   * Webhooks and API keys: per-workspace subscriptions with a signing secret (encrypted), delivery attempts with retries and dead letters;
--     API keys stored as hashes with explicit scopes.
--
-- As elsewhere, the application role only reads (row-level security) and trusted server code writes after authorizing the action.
-- Rollback: supabase/rollbacks/0032_crm_automation.down.sql.

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------

create table crm_workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (char_length(description) <= 500),
  folder_id uuid,
  -- draft: never published. active: the published version runs on new events. paused: nothing new starts; waiting runs hold.
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  -- The working copy the editor saves. Publishing freezes it into crm_workflow_versions.
  draft jsonb not null default '{}'::jsonb check (jsonb_typeof(draft) = 'object' and pg_column_size(draft) <= 131072),
  draft_revision integer not null default 1 check (draft_revision >= 1),
  published_version_id uuid,
  -- Runs per hour this workflow may start in this workspace; a guard against runaway triggers.
  hourly_run_limit integer not null default 500 check (hourly_run_limit between 1 and 10000),
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, org_id),
  foreign key (folder_id, org_id) references crm_folders (id, org_id) on delete set null (folder_id),
  check ((status = 'archived') = (archived_at is not null)),
  check (status not in ('active', 'paused') or published_version_id is not null)
);
create unique index crm_workflows_key on crm_workflows (org_id, key) where archived_at is null;
create trigger crm_workflows_touch before update on crm_workflows for each row execute function app.touch_updated_at();

create table crm_workflow_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workflow_id uuid not null,
  version integer not null check (version >= 1),
  -- The trigger: an event type (crm_events.type) with optional filters, or a schedule / inbound webhook.
  trigger_config jsonb not null check (jsonb_typeof(trigger_config) = 'object' and pg_column_size(trigger_config) <= 16384),
  -- The steps as a graph: [{ "key", "kind", "config", "next", "branches" }]. Only supported step kinds are accepted by the publisher.
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and pg_column_size(steps) <= 131072),
  -- What the version can do outside the CRM (send_email, send_sms, send_whatsapp, webhook, n8n, hermes), derived when published.
  effects text[] not null default '{}' check (cardinality(effects) <= 20),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- A version with message or external effects runs only once an owner approved exactly this content.
  approval_id uuid references approval_requests(id) on delete set null,
  approved_hash text check (approved_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  published_by uuid references users(id) on delete set null,
  published_at timestamptz not null default now(),
  unique (workflow_id, version),
  unique (id, org_id),
  foreign key (workflow_id, org_id) references crm_workflows (id, org_id) on delete cascade
);
create trigger crm_workflow_versions_frozen before update of version, trigger_config, steps, effects, content_hash, workflow_id, org_id
  on crm_workflow_versions for each row execute function app.block_update();
alter table crm_workflows add constraint crm_workflows_published_fk foreign key (published_version_id, org_id) references crm_workflow_versions (id, org_id);

create table crm_workflow_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workflow_id uuid not null,
  version_id uuid not null,
  trigger_event_id bigint references crm_events(id) on delete set null,
  -- Distinguishes manual starts, scheduled starts and test runs (dry runs perform no external effect and change no records).
  started_via text not null check (started_via in ('event', 'manual', 'schedule', 'webhook', 'test')),
  contact_id uuid,
  opportunity_id uuid,
  status text not null default 'queued' check (status in ('queued', 'running', 'waiting', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'dead')),
  current_step text check (char_length(current_step) <= 60),
  next_run_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts between 0 and 50),
  claimed_at timestamptz,
  depth integer not null default 0 check (depth between 0 and 20),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 16384),
  last_error text check (char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  cancelled_by uuid references users(id) on delete set null,
  unique (id, org_id),
  foreign key (workflow_id, org_id) references crm_workflows (id, org_id) on delete cascade,
  foreign key (version_id, org_id) references crm_workflow_versions (id, org_id) on delete cascade,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id),
  foreign key (opportunity_id, org_id) references crm_opportunities (id, org_id) on delete set null (opportunity_id)
);
-- One run per workflow and triggering event: a redelivered event never starts the workflow twice, even when a newer version was published
-- between the two deliveries.
create unique index crm_workflow_runs_event_once on crm_workflow_runs (workflow_id, trigger_event_id) where trigger_event_id is not null;
create index crm_workflow_runs_due_idx on crm_workflow_runs (next_run_at) where status in ('queued', 'waiting');
create index crm_workflow_runs_workflow_idx on crm_workflow_runs (org_id, workflow_id, created_at desc);
create index crm_workflow_runs_contact_idx on crm_workflow_runs (org_id, contact_id) where contact_id is not null;

create table crm_workflow_run_steps (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  run_id uuid not null,
  step_key text not null check (char_length(step_key) between 1 and 60),
  kind text not null check (char_length(kind) between 1 and 40),
  attempt integer not null default 1 check (attempt between 1 and 20),
  status text not null check (status in ('running', 'completed', 'skipped', 'failed', 'waiting', 'awaiting_approval', 'cancelled')),
  -- An external effect (a message, a webhook, an n8n call) carries this key, so a retry never repeats it.
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  approval_id uuid references approval_requests(id) on delete set null,
  message_id uuid,
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 8192),
  error text check (char_length(error) <= 500),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (org_id, idempotency_key),
  foreign key (run_id, org_id) references crm_workflow_runs (id, org_id) on delete cascade
);
create index crm_workflow_run_steps_run_idx on crm_workflow_run_steps (run_id, id);

-- ---------------------------------------------------------------------------
-- Lead assignment
-- ---------------------------------------------------------------------------

create table crm_assignment_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  entity text not null check (entity in ('contact', 'opportunity')),
  -- Which records the rule applies to: a Smart List filter (validated by the CRM filter compiler) evaluated at assignment time.
  conditions jsonb not null default '{"op":"and","conditions":[]}'::jsonb check (jsonb_typeof(conditions) = 'object' and pg_column_size(conditions) <= 16384),
  strategy text not null check (strategy in ('round_robin', 'weighted', 'priority', 'keep_existing_owner')),
  -- Only members who are working now (their availability hours) and accepting, when set.
  respect_working_hours boolean not null default false,
  -- When nobody is available: leave unassigned, or give it to a named person.
  fallback text not null default 'unassigned' check (fallback in ('unassigned', 'fallback_user')),
  fallback_user_id uuid,
  position integer not null default 0,
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (org_id, fallback_user_id) references organization_memberships (org_id, user_id) on delete set null (fallback_user_id),
  check (fallback <> 'fallback_user' or fallback_user_id is not null)
);
create index crm_assignment_rules_org_idx on crm_assignment_rules (org_id, entity, position) where active;
create trigger crm_assignment_rules_touch before update on crm_assignment_rules for each row execute function app.touch_updated_at();

create table crm_assignment_members (
  org_id uuid not null,
  rule_id uuid not null,
  user_id uuid not null,
  weight integer not null default 1 check (weight between 1 and 100),
  priority integer not null default 50 check (priority between 0 and 100),
  paused boolean not null default false,
  assigned_count integer not null default 0 check (assigned_count >= 0),
  last_assigned_at timestamptz,
  primary key (rule_id, user_id),
  foreign key (rule_id, org_id) references crm_assignment_rules (id, org_id) on delete cascade,
  foreign key (org_id, user_id) references organization_memberships (org_id, user_id) on delete cascade
);

-- Every automatic assignment, in order: which rule, which person, and why. Manual assignments stay in the contact timeline as before.
create table crm_assignment_history (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  rule_id uuid,
  entity text not null check (entity in ('contact', 'opportunity')),
  entity_id uuid not null,
  user_id uuid references users(id) on delete set null,
  outcome text not null check (outcome in ('assigned', 'kept_owner', 'fallback', 'unassigned')),
  reason text check (char_length(reason) <= 300),
  event_id bigint references crm_events(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (rule_id, org_id) references crm_assignment_rules (id, org_id) on delete set null (rule_id)
);
create unique index crm_assignment_history_once on crm_assignment_history (org_id, entity, entity_id, event_id) where event_id is not null;
create index crm_assignment_history_entity_idx on crm_assignment_history (org_id, entity, entity_id, created_at desc);
create trigger crm_assignment_history_immutable before update on crm_assignment_history for each row execute function app.immutable_row();

-- ---------------------------------------------------------------------------
-- CRM tools for a client's own AI employees
-- ---------------------------------------------------------------------------

create table crm_agent_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null references agent_instances(id) on delete cascade,
  run_id uuid references agent_runs(id) on delete cascade,
  -- sha256 of the bearer secret. The secret is handed to the run once and never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null check (cardinality(scopes) between 1 and 30),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  use_count integer not null default 0 check (use_count >= 0),
  created_at timestamptz not null default now(),
  check (expires_at > created_at and expires_at <= created_at + interval '24 hours')
);
create index crm_agent_tokens_agent_idx on crm_agent_tokens (org_id, agent_instance_id, expires_at desc);

-- ---------------------------------------------------------------------------
-- Outbound webhooks and API keys
-- ---------------------------------------------------------------------------

create table crm_webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  url text not null check (url ~ '^https://' and char_length(url) <= 500),
  event_types text[] not null check (cardinality(event_types) between 1 and 50),
  -- AES-GCM ciphertext of the signing secret. The application role cannot read it; it is shown once when created.
  secret_ciphertext text not null check (char_length(secret_ciphertext) <= 2000),
  secret_hint text not null check (char_length(secret_hint) between 4 and 12),
  active boolean not null default true,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  disabled_reason text check (char_length(disabled_reason) <= 300),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id)
);
create trigger crm_webhook_subscriptions_touch before update on crm_webhook_subscriptions for each row execute function app.touch_updated_at();

create table crm_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  subscription_id uuid not null,
  event_id bigint not null references crm_events(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'delivering', 'delivered', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  response_status integer check (response_status between 100 and 599),
  last_error text check (char_length(last_error) <= 300),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (subscription_id, event_id),
  foreign key (subscription_id, org_id) references crm_webhook_subscriptions (id, org_id) on delete cascade
);
create index crm_webhook_deliveries_due_idx on crm_webhook_deliveries (next_attempt_at) where status in ('pending', 'failed');

create table crm_api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- sha256 of the key. The key itself is shown once when created.
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix text not null check (key_prefix ~ '^iaq_[a-z0-9]{6}$'),
  scopes text[] not null check (cardinality(scopes) between 1 and 30),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);
create index crm_api_keys_org_idx on crm_api_keys (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Approvals, agent runs, pauses, notifications
-- ---------------------------------------------------------------------------

alter table approval_requests drop constraint approval_requests_kind_check;
alter table approval_requests add constraint approval_requests_kind_check check (kind in (
  'lead_import', 'outreach', 'follow_up_message', 'crm_update', 'campaign_activation',
  'knowledge_change', 'tool_action', 'config_change', 'appointment_booking', 'standing_authorization',
  'workflow_activation', 'workflow_action'));

alter table agent_runs drop constraint agent_runs_purpose_check;
alter table agent_runs add constraint agent_runs_purpose_check check (purpose in ('chat', 'lead_research', 'health_check', 'workflow', 'crm_tool'));

-- A workspace-wide switch for workflows, next to the existing messaging and outbound pauses.
alter table automation_pauses drop constraint automation_pauses_scope_check;
alter table automation_pauses add constraint automation_pauses_scope_check check (scope in ('messaging', 'outbound', 'agency', 'workflows'));

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table crm_workflows enable row level security;
alter table crm_workflow_versions enable row level security;
alter table crm_workflow_runs enable row level security;
alter table crm_workflow_run_steps enable row level security;
alter table crm_assignment_rules enable row level security;
alter table crm_assignment_members enable row level security;
alter table crm_assignment_history enable row level security;
alter table crm_agent_tokens enable row level security;
alter table crm_webhook_subscriptions enable row level security;
alter table crm_webhook_deliveries enable row level security;
alter table crm_api_keys enable row level security;
revoke all on crm_workflows, crm_workflow_versions, crm_workflow_runs, crm_workflow_run_steps, crm_assignment_rules, crm_assignment_members,
  crm_assignment_history, crm_agent_tokens, crm_webhook_subscriptions, crm_webhook_deliveries, crm_api_keys
  from public, anon, authenticated, iaq_site_runtime;
grant select on crm_workflows, crm_workflow_versions, crm_workflow_runs, crm_workflow_run_steps, crm_assignment_rules, crm_assignment_members,
  crm_assignment_history, crm_webhook_deliveries to iaq_app_user;
-- Secrets: subscriptions are read through trusted code (the ciphertext is never granted); tokens and key hashes never.
grant select (id, org_id, name, url, event_types, secret_hint, active, consecutive_failures, disabled_reason, created_by, created_at, updated_at)
  on crm_webhook_subscriptions to iaq_app_user;
grant select (id, org_id, name, key_prefix, scopes, created_by, created_at, expires_at, revoked_at, last_used_at) on crm_api_keys to iaq_app_user;

create policy crm_workflows_select on crm_workflows for select to iaq_app_user using (app.has_permission(org_id, 'workflows.view'));
create policy crm_workflow_versions_select on crm_workflow_versions for select to iaq_app_user using (app.has_permission(org_id, 'workflows.view'));
create policy crm_workflow_runs_select on crm_workflow_runs for select to iaq_app_user using (app.has_permission(org_id, 'workflows.view'));
create policy crm_workflow_run_steps_select on crm_workflow_run_steps for select to iaq_app_user using (app.has_permission(org_id, 'workflows.view'));
create policy crm_assignment_rules_select on crm_assignment_rules for select to iaq_app_user using (app.has_permission(org_id, 'contacts.assign'));
create policy crm_assignment_members_select on crm_assignment_members for select to iaq_app_user using (app.has_permission(org_id, 'contacts.assign'));
create policy crm_assignment_history_select on crm_assignment_history for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view'));
create policy crm_webhook_subscriptions_select on crm_webhook_subscriptions for select to iaq_app_user using (app.has_permission(org_id, 'crm.api.manage'));
create policy crm_webhook_deliveries_select on crm_webhook_deliveries for select to iaq_app_user using (app.has_permission(org_id, 'crm.api.manage'));
create policy crm_api_keys_select on crm_api_keys for select to iaq_app_user using (app.has_permission(org_id, 'crm.api.manage'));

-- ---------------------------------------------------------------------------
-- Notification kinds: the full list from 0029, plus automation ones. Every earlier kind must stay.
-- ---------------------------------------------------------------------------

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'agent_task_completed', 'lead_awaiting_approval', 'booking_confirmed', 'workflow_failure',
  'knowledge_update_ready', 'support_reply', 'support_ticket_created', 'integration_disconnected',
  'usage_limit_approaching', 'approval_requested', 'approval_decided', 'agent_status', 'system',
  'setup_milestone', 'setup_action_required', 'setup_issue', 'setup_ready',
  'project_submitted', 'project_update', 'project_quote', 'project_decision', 'project_message',
  'maintenance_update',
  'billing_payment_received', 'billing_payment_failed', 'billing_low_balance', 'billing_credits_exhausted',
  'billing_budget_warning', 'billing_reconciliation',
  'escalation_action_required', 'escalation_fyi', 'escalation_claimed', 'escalation_unclaimed',
  'message_blocked', 'message_failed',
  'website_published', 'website_publish_failed', 'domain_verified', 'domain_renewal_due', 'domain_issue',
  'incident_opened', 'incident_recovered', 'integration_reconnect_required', 'account_inactivity_notice',
  'booking_cancelled', 'booking_rescheduled', 'booking_conflict', 'booking_needs_action',
  'retention_attention',
  'fair_use_notice', 'offboarding_update',
  'crm_import_finished', 'crm_assigned', 'crm_support_access', 'crm_task_due',
  'crm_booking_new', 'crm_calendar_sync',
  'crm_workflow_failed', 'crm_webhook_failing'));
