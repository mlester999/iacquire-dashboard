-- Automation Studio foundation (phase 1 and the safe parts of phase 2).
--
-- Automation Studio is the optional "Managed Maintenance + Automation Studio" plan. It is built on the native CRM workflow engine
-- (0032), not beside it, so this migration only adds what the engine lacked to sell, meter and pause premium workflows safely:
--
--   * maintenance_subscriptions gains the lifecycle states a recurring plan needs beyond "requested / active / cancelled": past_due
--     (a payment failed; a disclosed grace period) and expired (the grace period ended, or the plan lapsed). Only an agency member
--     records a payment as verified or failed: nothing here talks to a payment provider.
--   * crm_workflows.origin says where a workflow was created. Workflows built before this migration, and everything built in the CRM
--     workflow screens, stay "crm" and are never touched by the plan's lifecycle. Workflows built in Automation Studio are "studio".
--   * crm_workflow_versions.premium_features is the premium capabilities a published version uses (derived when published and frozen with
--     the version, like its effects). The engine consults it before starting or advancing a run.
--   * automation_studio_usage holds monthly counters per workspace (runs, steps, failures, builder messages, employee invocations...),
--     and automation_studio_limits the per-workspace overrides of the fair-use limits. Counters are upserted in the same transaction as
--     the work they count; limits are never "unlimited" unless an agency member sets a number.
--
-- Additive only: no column is dropped, no row is rewritten, and every existing workflow and subscription behaves as before.
-- Rollback: supabase/rollbacks/0069_automation_studio_foundation.down.sql.

-- ---------------------------------------------------------------------------
-- Maintenance plan lifecycle
-- ---------------------------------------------------------------------------

alter table maintenance_subscriptions drop constraint if exists maintenance_subscriptions_status_check;
alter table maintenance_subscriptions add constraint maintenance_subscriptions_status_check
  check (status in ('requested', 'active', 'past_due', 'cancel_requested', 'cancelled', 'declined', 'expired'));

alter table maintenance_subscriptions
  add column if not exists past_due_since timestamptz,
  add column if not exists grace_ends_at timestamptz,
  add column if not exists expired_at timestamptz,
  add column if not exists last_payment_verified_at timestamptz,
  add column if not exists last_payment_verified_by uuid references users(id) on delete set null,
  add column if not exists paid_through_on date;

-- A plan that went past due or expired was activated first.
alter table maintenance_subscriptions add constraint maintenance_subscriptions_lifecycle_check
  check (status not in ('past_due', 'expired') or activated_at is not null);
alter table maintenance_subscriptions add constraint maintenance_subscriptions_grace_check
  check (status <> 'past_due' or (past_due_since is not null and grace_ends_at is not null));

-- One open plan per workspace; past due is still open (it is the same plan, waiting on a payment).
drop index if exists maintenance_one_open_plan;
create unique index maintenance_one_open_plan on maintenance_subscriptions (org_id) where status in ('requested', 'active', 'past_due', 'cancel_requested');

-- ---------------------------------------------------------------------------
-- Workflows: where they were built, and which premium capabilities a version uses
-- ---------------------------------------------------------------------------

alter table crm_workflows add column if not exists origin text not null default 'crm' check (origin in ('crm', 'studio'));
-- Set when the plan lapsed and this workflow was paused because of it (and only then): the workflow stays off until a person validates
-- and turns it on again. A workflow a person paused themselves never carries this.
alter table crm_workflows add column if not exists entitlement_paused_at timestamptz;
alter table crm_workflows add constraint crm_workflows_entitlement_pause_check
  check (entitlement_paused_at is null or status = 'paused');

alter table crm_workflow_versions add column if not exists premium_features text[] not null default '{}' check (cardinality(premium_features) <= 20);
-- The premium features of a version are part of what was published: frozen with it (recreated to include the new column).
drop trigger if exists crm_workflow_versions_frozen on crm_workflow_versions;
create trigger crm_workflow_versions_frozen before update of version, trigger_config, steps, effects, premium_features, content_hash, workflow_id, org_id
  on crm_workflow_versions for each row execute function app.block_update();

create index crm_workflow_versions_premium_idx on crm_workflow_versions (org_id) where cardinality(premium_features) > 0;
create index crm_workflows_studio_idx on crm_workflows (org_id, status) where origin = 'studio';
-- Unfinished runs per workspace: the concurrency limit counts them whenever a run would start.
create index crm_workflow_runs_live_idx on crm_workflow_runs (org_id) where status in ('queued', 'running', 'waiting', 'awaiting_approval');

-- ---------------------------------------------------------------------------
-- Usage counters and fair-use limits
-- ---------------------------------------------------------------------------

create table automation_studio_usage (
  org_id uuid not null references organizations(id) on delete cascade,
  -- First day of the calendar month, UTC.
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  metric text not null check (metric in (
    'runs_started', 'runs_refused', 'steps_executed', 'step_failures', 'step_retries', 'test_runs',
    'builder_messages', 'builder_input_tokens', 'builder_output_tokens', 'employee_invocations', 'integration_calls')),
  quantity bigint not null default 0 check (quantity >= 0),
  -- What the counted work cost iAcquire, where it could be measured or estimated (micro-dollars). Never charged to the client by itself.
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, period_month, metric)
);

create table automation_studio_limits (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- Null means "the platform default" (src/lib/automation-studio/plan.ts), never "unlimited".
  monthly_runs integer check (monthly_runs >= 0),
  monthly_steps integer check (monthly_steps >= 0),
  monthly_builder_messages integer check (monthly_builder_messages >= 0),
  monthly_employee_invocations integer check (monthly_employee_invocations >= 0),
  monthly_integration_calls integer check (monthly_integration_calls >= 0),
  max_active_workflows integer check (max_active_workflows >= 0),
  max_live_runs integer check (max_live_runs >= 0),
  warn_at_percent integer not null default 80 check (warn_at_percent between 1 and 100),
  hard_stop boolean not null default true,
  note text check (char_length(note) <= 1000),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table automation_studio_usage enable row level security;
alter table automation_studio_limits enable row level security;
revoke all on automation_studio_usage, automation_studio_limits from public, anon, authenticated, iaq_site_runtime;
grant select on automation_studio_usage, automation_studio_limits to iaq_app_user;

create policy automation_studio_usage_select on automation_studio_usage for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('workflows.view'))::uuid[]));
create policy automation_studio_limits_select on automation_studio_limits for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('workflows.view'))::uuid[]));
