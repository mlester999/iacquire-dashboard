-- Retention: approved programs of customer messages (welcome, check-ins, service follow-ups, feedback requests, re-engagement).
--
-- Every program is off until the owner approves its exact wording. A message goes out only through the same rule chain as any other
-- customer message (consent, opt-outs, quiet hours, pauses, human takeover, credits) plus its own frequency limit that counts every
-- channel and every program together for one customer. Only customers who become eligible AFTER a program is approved are enrolled,
-- so switching one on never messages the existing customer base at once. As elsewhere, the application role is read-only.

-- ---------------------------------------------------------------------------
-- What a message is for, its own frequency limit, and customer-since
-- ---------------------------------------------------------------------------

alter table messaging_policy
  add column max_retention_per_contact_30d integer not null default 4 check (max_retention_per_contact_30d between 0 and 30),
  add column min_hours_between_retention integer not null default 72 check (min_hours_between_retention >= 1);

alter table conversation_messages drop constraint conversation_messages_scope_check;
alter table conversation_messages add constraint conversation_messages_scope_check check (scope in ('reply', 'followup', 'human', 'reminder', 'retention'));
-- service: about something the customer already has or asked for. marketing: anything promotional, which needs explicit marketing consent.
alter table conversation_messages add column purpose text not null default 'service' check (purpose in ('service', 'marketing'));

alter table contacts
  add column customer_since timestamptz,
  -- A person's own choice to keep one customer out of all automated retention messages (for example during a dispute).
  add column retention_paused boolean not null default false;
update contacts set customer_since = coalesce(updated_at, now()) where lifecycle_stage in ('customer', 'retention') and customer_since is null;

-- The moment a contact first becomes a customer is recorded whichever way it happens (a person, an import, a sync).
create or replace function app.stamp_customer_since() returns trigger language plpgsql as $$
begin
  if new.lifecycle_stage in ('customer', 'retention') and new.customer_since is null then
    new.customer_since := now();
  end if;
  return new;
end $$;
create trigger contacts_customer_since before insert or update of lifecycle_stage on contacts for each row execute function app.stamp_customer_since();

-- ---------------------------------------------------------------------------
-- Programs
-- ---------------------------------------------------------------------------

create table retention_programs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('welcome', 'onboarding_checkin', 'service_followup', 'feedback_request', 'reengagement')),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 600),
  -- customer_created: when a contact becomes a customer. appointment_showed: after an appointment the calendar marks as attended.
  -- inactive: a customer who has not been in touch for a while.
  trigger text not null check (trigger in ('customer_created', 'appointment_showed', 'inactive')),
  purpose text not null default 'service' check (purpose in ('service', 'marketing')),
  -- [{ "key": "checkin_3", "delayDays": 3, "body": "Hi {name}, ..." }, ...]
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 4 and pg_column_size(steps) <= 8000),
  business_hours_only boolean not null default true,
  inactive_days integer check (inactive_days between 30 and 730),
  enabled boolean not null default false,
  -- The approval covers exactly this wording. Editing the steps changes the hash, which withdraws the approval until the owner gives it again.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  approved_hash text check (approved_hash ~ '^[0-9a-f]{64}$'),
  approval_id uuid references approval_requests(id) on delete set null,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind),
  unique (id, org_id),
  check (kind <> 'reengagement' or purpose = 'marketing'),
  check (trigger <> 'inactive' or inactive_days is not null)
);
create trigger retention_programs_touch before update on retention_programs for each row execute function app.touch_updated_at();

create table retention_enrollments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  program_id uuid not null,
  contact_id uuid not null,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  cancel_reason text check (char_length(cancel_reason) <= 120),
  -- What caused this enrollment (the appointment, the customer-since moment), so the same cause never enrols twice.
  trigger_ref text not null check (char_length(trigger_ref) between 1 and 120),
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  foreign key (program_id, org_id) references retention_programs (id, org_id) on delete cascade,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  unique (program_id, contact_id, trigger_ref),
  unique (id, org_id),
  check ((status = 'active') = (closed_at is null))
);
create index retention_enrollments_contact_idx on retention_enrollments (org_id, contact_id, status);

create table retention_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  enrollment_id uuid not null,
  step_key text not null check (char_length(step_key) between 1 and 40),
  due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'queued', 'sent', 'skipped', 'blocked', 'cancelled')),
  reason text check (char_length(reason) <= 200),
  message_id uuid references conversation_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (enrollment_id, org_id) references retention_enrollments (id, org_id) on delete cascade,
  unique (enrollment_id, step_key)
);
create index retention_steps_due_idx on retention_steps (due_at) where status = 'scheduled';
create trigger retention_steps_touch before update on retention_steps for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table retention_programs enable row level security;
alter table retention_enrollments enable row level security;
alter table retention_steps enable row level security;
revoke all on retention_programs, retention_enrollments, retention_steps from public, anon, authenticated;
grant select on retention_programs, retention_enrollments, retention_steps to iaq_app_user;
create policy retention_programs_select on retention_programs for select to iaq_app_user using (app.has_permission(org_id, 'retention.view'));
create policy retention_enrollments_select on retention_enrollments for select to iaq_app_user using (app.has_permission(org_id, 'retention.view'));
create policy retention_steps_select on retention_steps for select to iaq_app_user using (app.has_permission(org_id, 'retention.view'));

-- The activation of a program is the owner's decision; editing the wording is the owner's or a manager's.
insert into role_permissions (role, permission) values ('owner', 'retention.activate');

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
  'retention_attention'));
