-- Commercial operations: agency financial bookkeeping, fair-use thresholds, inactivity review and offboarding.
--
-- Nothing here changes what a customer is charged. It records what the agency spends and sets aside (kept apart from revenue, fees, tax
-- and profit), measures what each workspace actually uses against thresholds the agency sets only once it has measured real provider
-- costs, notices an account that has gone quiet (and never deletes one), and runs a client's departure as an audited, reversible-until-
-- the-end process that always leaves the client able to take their data and their domains with them.
-- As elsewhere, the application role is read-only; trusted server code performs every write after authorizing it.

-- ---------------------------------------------------------------------------
-- Agency finance
-- ---------------------------------------------------------------------------

alter table agency_billing_settings
  -- The planning reserve set aside from each setup payment. Not a customer charge. Editable because it is a recommendation.
  add column setup_reserve_usd integer not null default 200 check (setup_reserve_usd between 0 and 1499),
  -- Null means "not configured": the report then says tax has not been provided for, instead of assuming a rate.
  add column tax_set_aside_bps integer check (tax_set_aside_bps between 0 and 5000);

create table agency_finance_entries (
  id uuid primary key default gen_random_uuid(),
  -- Set for a cost that belongs to one client (so client profitability is honest); null for overhead and agency-wide entries.
  org_id uuid references organizations(id) on delete set null,
  kind text not null check (kind in ('direct_cost', 'overhead', 'tax_set_aside', 'reserve_set_aside', 'reserve_used')),
  category text not null check (char_length(category) between 1 and 60),
  description text not null check (char_length(description) between 1 and 300),
  amount_micros bigint not null check (amount_micros > 0),
  -- The day the money belongs to for reporting; entries are never edited, only voided with a reason.
  period_on date not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references users(id) on delete set null,
  void_reason text check (char_length(void_reason) <= 300),
  check (org_id is null or kind = 'direct_cost'),
  check ((voided_at is null and void_reason is null) or (voided_at is not null and void_reason is not null))
);
create index agency_finance_entries_period_idx on agency_finance_entries (period_on, kind);
create index agency_finance_entries_org_idx on agency_finance_entries (org_id, period_on);
create trigger agency_finance_no_delete before delete on agency_finance_entries for each row execute function app.immutable_row();

-- ---------------------------------------------------------------------------
-- Fair use
-- ---------------------------------------------------------------------------

-- A threshold for one measured resource. org_id null is the platform default; a row for an organization overrides it.
-- No numbers are shipped: a threshold with no value is "unset", which the interface reports honestly as "not limited yet".
create table fair_use_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  metric text not null check (metric in ('storage_bytes', 'site_bandwidth_bytes_30d', 'site_requests_30d', 'ai_runs_30d', 'research_calls_30d', 'stored_messages')),
  warn_value bigint check (warn_value >= 0),
  limit_value bigint check (limit_value >= 0),
  -- report_only never stops anything. block_new refuses only NEW storage, and never deletes or takes anything offline.
  enforcement text not null default 'report_only' check (enforcement in ('report_only', 'block_new')),
  note text check (char_length(note) <= 500),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (warn_value is null or limit_value is null or warn_value <= limit_value),
  check (enforcement = 'report_only' or metric = 'storage_bytes')
);
create unique index fair_use_policies_unique on fair_use_policies (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), metric);

-- The latest measurement for each workspace and resource, with where it stands against the threshold in force.
create table fair_use_status (
  org_id uuid not null references organizations(id) on delete cascade,
  metric text not null check (metric in ('storage_bytes', 'site_bandwidth_bytes_30d', 'site_requests_30d', 'ai_runs_30d', 'research_calls_30d', 'stored_messages')),
  value bigint not null check (value >= 0),
  state text not null check (state in ('unset', 'ok', 'warning', 'over')),
  warn_value bigint,
  limit_value bigint,
  measured_at timestamptz not null default now(),
  -- The state the owner was last told about, so each change is announced once.
  notified_state text check (notified_state in ('ok', 'warning', 'over')),
  primary key (org_id, metric)
);

-- ---------------------------------------------------------------------------
-- Inactivity review
-- ---------------------------------------------------------------------------

create table account_activity_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'reactivated', 'offboarding', 'dismissed')),
  last_activity_at timestamptz not null,
  inactive_days integer not null check (inactive_days >= 0),
  notices_sent integer not null default 0 check (notices_sent between 0 and 5),
  last_notice_at timestamptz,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references users(id) on delete set null,
  closed_note text check (char_length(closed_note) <= 300),
  check ((status = 'open') = (closed_at is null))
);
create unique index account_activity_reviews_one_open on account_activity_reviews (org_id) where status = 'open';

-- ---------------------------------------------------------------------------
-- Offboarding
-- ---------------------------------------------------------------------------

create table offboarding_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- requested: asked for, nothing changed yet (still fully cancellable). shutdown: access closed and automation stopped; data kept.
  -- retention: the agreed retention period is running. deleted: personal and content data purged; financial and audit records kept.
  status text not null default 'requested' check (status in ('requested', 'shutdown', 'retention', 'deleted', 'cancelled')),
  requested_by uuid references users(id) on delete set null,
  requested_by_kind text not null check (requested_by_kind in ('client', 'agency')),
  reason text check (char_length(reason) <= 500),
  requested_at timestamptz not null default now(),
  -- The agreed retention before deletion. A default for the agency to confirm with its own legal advice; never shorter than 30 days.
  retention_days integer not null default 90 check (retention_days between 30 and 730),
  -- What happens to the live website at shutdown. The client's domains are never held back either way.
  website_plan text not null default 'keep_until_deletion' check (website_plan in ('keep_until_deletion', 'unpublish_now')),
  credit_balance_micros bigint check (credit_balance_micros >= 0),
  billing_closed_at timestamptz,
  billing_closed_by uuid references users(id) on delete set null,
  billing_note text check (char_length(billing_note) <= 500),
  export_downloaded_at timestamptz,
  export_downloaded_by uuid references users(id) on delete set null,
  shutdown_at timestamptz,
  shutdown_by uuid references users(id) on delete set null,
  delete_after timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references users(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references users(id) on delete set null,
  cancel_note text check (char_length(cancel_note) <= 300),
  updated_at timestamptz not null default now(),
  check (status <> 'shutdown' or shutdown_at is not null),
  check (status <> 'retention' or delete_after is not null),
  check (status <> 'deleted' or deleted_at is not null),
  check (status <> 'cancelled' or cancelled_at is not null)
);
create unique index offboarding_one_active on offboarding_requests (org_id) where status in ('requested', 'shutdown', 'retention');
create trigger offboarding_requests_touch before update on offboarding_requests for each row execute function app.touch_updated_at();

create table offboarding_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  request_id uuid not null references offboarding_requests(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('requested', 'export_downloaded', 'shutdown_step', 'shutdown', 'billing_closed', 'retention_started', 'reminder', 'deletion_planned', 'deleted', 'cancelled', 'note')),
  detail text check (char_length(detail) <= 600),
  actor_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index offboarding_events_request_idx on offboarding_events (request_id, seq);
create trigger offboarding_events_immutable before update or delete on offboarding_events for each row execute function app.immutable_row();

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table agency_finance_entries enable row level security;
alter table fair_use_policies enable row level security;
alter table fair_use_status enable row level security;
alter table account_activity_reviews enable row level security;
alter table offboarding_requests enable row level security;
alter table offboarding_events enable row level security;
revoke all on agency_finance_entries, fair_use_policies, fair_use_status, account_activity_reviews, offboarding_requests, offboarding_events from public, anon, authenticated;
grant select on agency_finance_entries, fair_use_policies, fair_use_status, account_activity_reviews, offboarding_requests, offboarding_events to iaq_app_user;

-- Agency money. Super admins see everything; assigned staff see only entries attributed to their own clients.
create policy agency_finance_entries_select on agency_finance_entries for select to iaq_app_user using (
  app.is_agency_admin() or (org_id is not null and app.is_agency_staff() and app.staff_assigned(org_id)));
-- Clients read the limits that apply to them and where they stand: honest reporting is part of the offer.
create policy fair_use_policies_select on fair_use_policies for select to iaq_app_user using (
  app.is_agency_staff() or (org_id is not null and app.has_permission(org_id, 'usage.view')));
create policy fair_use_status_select on fair_use_status for select to iaq_app_user using (app.has_permission(org_id, 'usage.view') or app.is_agency_staff());
create policy account_activity_reviews_select on account_activity_reviews for select to iaq_app_user using (app.is_agency_staff() and (app.is_agency_admin() or app.staff_assigned(org_id)));
create policy offboarding_requests_select on offboarding_requests for select to iaq_app_user using (
  app.has_permission(org_id, 'offboarding.view') or (app.is_agency_staff() and (app.is_agency_admin() or app.staff_assigned(org_id))));
create policy offboarding_events_select on offboarding_events for select to iaq_app_user using (
  app.has_permission(org_id, 'offboarding.view') or (app.is_agency_staff() and (app.is_agency_admin() or app.staff_assigned(org_id))));

insert into role_permissions (role, permission) values
  ('owner', 'offboarding.view'), ('agency_staff', 'offboarding.view'), ('agency_super_admin', 'offboarding.view'),
  ('owner', 'offboarding.request'),
  ('agency_super_admin', 'offboarding.manage'),
  ('owner', 'data.export'), ('agency_super_admin', 'data.export'),
  ('agency_super_admin', 'finance.manage');

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
  'fair_use_notice', 'offboarding_update'));

-- ---------------------------------------------------------------------------
-- Personal-data tables that are append-only, except when a departed client's data is purged
-- ---------------------------------------------------------------------------

-- Consent and ownership history are append-only so nobody can quietly rewrite who agreed to what. A client who leaves is entitled to have the
-- personal data of their customers removed, so these two (and only these) allow a DELETE inside a transaction that has explicitly declared
-- a purge. Updates stay forbidden, and the setting can only be raised by trusted server code.
create or replace function app.immutable_row_purgeable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('iaq.purge', true) = 'on' then
    return old;
  end if;
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;
drop trigger consent_events_immutable on contact_consent_events;
create trigger consent_events_immutable before update or delete on contact_consent_events for each row execute function app.immutable_row_purgeable();
drop trigger ownership_events_immutable on conversation_ownership_events;
create trigger ownership_events_immutable before update or delete on conversation_ownership_events for each row execute function app.immutable_row_purgeable();
