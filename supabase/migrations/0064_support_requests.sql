-- iAcquire Client Portal — Support & Requests.
--
-- Extends the support tables that already exist (support_tickets, support_messages, support_attachments) instead of adding a
-- second ticketing system:
--   * support_tickets gains a request type (support | issue | feedback), the new "new" status, client-stated urgency, a feedback
--     stage, an allow-listed diagnostics document, an idempotency key and the timestamps the lifecycle needs.
--   * support_messages gains a client message id so a retried reply never duplicates.
--   * support_attachments can be staged before a request exists, can belong to one message, and has a lifecycle for cleanup.
--   * New tables: support_ticket_events (timeline), support_ticket_ops (agency-only escalation, response clock, AI summary),
--     support_ticket_links (related / duplicate / merged), support_settings (hours, targets, limits), support_notification_rules
--     (in-app / email / both / disabled per event) and support_notification_log (idempotent delivery record).
--   * New permissions: support.view_all for client roles and agency.support.queue / notes / assign / priority / resolve /
--     analytics / settings for the agency team.
--
-- Client members now read only their own requests unless they hold support.view_all (Business Owner and Manager). That rule is
-- added as RESTRICTIVE policies, so the 0060 policies that tests/rls-initplan-guard.test.ts pins are left exactly as they were.
-- Internal notes, escalation details, response clocks and AI summaries live in rows no client policy can reach.
--
-- Non-destructive: nothing is dropped except check constraints that are re-created with a superset of values. All new columns are
-- nullable or defaulted, and existing rows keep working. Rollback: supabase/rollbacks/0064_support_requests.down.sql.

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------

alter table support_tickets drop constraint support_tickets_status_check;
alter table support_tickets add constraint support_tickets_status_check
  check (status in ('new', 'open', 'in_progress', 'waiting_for_client', 'resolved', 'closed'));

alter table support_tickets drop constraint support_tickets_category_check;
alter table support_tickets add constraint support_tickets_category_check check (category in (
  'general', 'account', 'crm', 'ai_employees', 'integrations', 'website', 'billing', 'other',
  'feature_not_working', 'incorrect_information', 'performance', 'access',
  'feature_suggestion', 'improvement', 'ux_feedback', 'positive_feedback', 'general_suggestion',
  'bug', 'onboarding', 'project', 'maintenance'));

alter table support_tickets
  add column request_type text not null default 'support' check (request_type in ('support', 'issue', 'feedback')),
  add column affected_feature text check (affected_feature ~ '^[a-z_]{2,40}$'),
  add column client_urgency text check (client_urgency in ('not_urgent', 'soon', 'blocking')),
  add column feedback_stage text check (feedback_stage in ('received', 'under_review', 'planned', 'completed', 'not_planned')),
  add column diagnostics jsonb check (diagnostics is null or pg_column_size(diagnostics) <= 4096),
  add column idempotency_key text check (char_length(idempotency_key) between 8 and 80),
  add column first_responded_at timestamptz,
  add column resolved_at timestamptz,
  add column closed_at timestamptz,
  add column reopened_count integer not null default 0 check (reopened_count >= 0),
  add column last_reopened_at timestamptz,
  add column client_last_read_at timestamptz,
  add column agency_last_read_at timestamptz;

alter table support_tickets add constraint support_tickets_feedback_type_check
  check ((request_type = 'feedback') = (feedback_stage is not null));

-- A retried submission with the same key returns the request it already created.
create unique index support_tickets_idempotency_idx on support_tickets (org_id, created_by, idempotency_key) where idempotency_key is not null;
create index support_tickets_creator_idx on support_tickets (org_id, created_by, last_message_at desc);
create index support_tickets_assignee_idx on support_tickets (assigned_to, status) where assigned_to is not null;
create index support_tickets_type_idx on support_tickets (request_type, status, last_message_at desc);
create index support_tickets_org_status_idx on support_tickets (org_id, status, last_message_at desc);

-- Trigram search over subjects and message text is optional, as in the CRM: without the extension, search uses sequential ILIKE.
do $$
declare s text;
begin
  select n.nspname into s from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  if s is not null then
    execute format('create index support_tickets_subject_trgm on support_tickets using gin (subject %I.gin_trgm_ops)', s);
    execute format('create index support_messages_body_trgm on support_messages using gin (body %I.gin_trgm_ops)', s);
  end if;
end
$$;

-- A status can only move along the lifecycle (see src/lib/support/lifecycle.ts, which tests/support-lifecycle.test.ts keeps in step),
-- and a request's workspace, reference and type never change. Server code checks the same rules first; this is the backstop.
create or replace function app.support_ticket_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.org_id <> old.org_id or new.ref <> old.ref or new.request_type <> old.request_type then
    raise exception 'support_ticket_identity_is_immutable' using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status and not (case old.status
      when 'new' then new.status in ('open', 'in_progress', 'waiting_for_client', 'resolved', 'closed')
      when 'open' then new.status in ('in_progress', 'waiting_for_client', 'resolved', 'closed')
      when 'in_progress' then new.status in ('open', 'waiting_for_client', 'resolved', 'closed')
      when 'waiting_for_client' then new.status in ('open', 'in_progress', 'resolved', 'closed')
      when 'resolved' then new.status in ('open', 'closed')
      when 'closed' then new.status = 'open'
      else false end) then
    raise exception 'invalid_support_status_transition: % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end
$$;
-- The trigger itself is created after the backfill below, which re-labels a few rows.

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

alter table support_messages add column client_message_id uuid;
create unique index support_messages_client_id_idx on support_messages (ticket_id, client_message_id) where client_message_id is not null;

-- ---------------------------------------------------------------------------
-- Attachments: staged before a request exists, bound to a message, cleaned up when abandoned
-- ---------------------------------------------------------------------------

alter table support_attachments alter column ticket_id drop not null;
alter table support_attachments
  add column message_id uuid references support_messages(id) on delete set null,
  add column status text not null default 'attached' check (status in ('staged', 'attached', 'removed')),
  add column expires_at timestamptz;
alter table support_attachments add constraint support_attachments_bound_check check (ticket_id is not null or status <> 'attached');
create index support_attachments_staged_idx on support_attachments (expires_at) where status = 'staged';
create index support_attachments_message_idx on support_attachments (message_id) where message_id is not null;

-- ---------------------------------------------------------------------------
-- Timeline
-- ---------------------------------------------------------------------------

create table support_ticket_events (
  id uuid primary key default gen_random_uuid(),
  -- Events written in one transaction share a timestamp, so the sequence keeps the timeline in order.
  seq bigint generated always as identity,
  ticket_id uuid not null,
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in (
    'created', 'reply', 'note', 'attachment', 'status_changed', 'feedback_stage', 'assigned', 'unassigned', 'priority_changed',
    'escalated', 'de_escalated', 'reopened', 'resolved', 'closed', 'linked', 'merged', 'sla_alert', 'ai_assist')),
  visibility text not null default 'internal' check (visibility in ('client', 'internal')),
  actor_user_id uuid references users(id) on delete set null,
  actor_kind text not null default 'system' check (actor_kind in ('client', 'agency', 'system')),
  from_value text check (char_length(from_value) <= 80),
  to_value text check (char_length(to_value) <= 80),
  detail text check (char_length(detail) <= 500),
  created_at timestamptz not null default now(),
  foreign key (ticket_id, org_id) references support_tickets(id, org_id) on delete cascade
);
create index support_ticket_events_ticket_idx on support_ticket_events (ticket_id, seq);

-- ---------------------------------------------------------------------------
-- Agency-only operating data: escalation, response clock, AI summary
-- ---------------------------------------------------------------------------

create table support_ticket_ops (
  ticket_id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  escalated_at timestamptz,
  escalated_by uuid references users(id) on delete set null,
  escalation_reason text check (char_length(escalation_reason) <= 500),
  -- The moment the team's next response is due, or null when no target applies (none configured, waiting on the client, finished).
  response_due_at timestamptz,
  response_kind text check (response_kind in ('first', 'follow_up')),
  response_started_at timestamptz,
  ai_summary text check (char_length(ai_summary) <= 4000),
  ai_summary_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (ticket_id, org_id) references support_tickets(id, org_id) on delete cascade
);
create index support_ticket_ops_due_idx on support_ticket_ops (response_due_at) where response_due_at is not null;
create index support_ticket_ops_escalated_idx on support_ticket_ops (escalated_at) where escalated_at is not null;
create trigger support_ticket_ops_touch before update on support_ticket_ops for each row execute function app.touch_updated_at();

-- Related, duplicate and merged requests. Both ends must belong to the same workspace (composite foreign keys).
create table support_ticket_links (
  ticket_id uuid not null,
  related_ticket_id uuid not null,
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('related', 'duplicate_of', 'merged_into')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (ticket_id, related_ticket_id, kind),
  check (ticket_id <> related_ticket_id),
  foreign key (ticket_id, org_id) references support_tickets(id, org_id) on delete cascade,
  foreign key (related_ticket_id, org_id) references support_tickets(id, org_id) on delete cascade
);
create index support_ticket_links_related_idx on support_ticket_links (related_ticket_id);

-- ---------------------------------------------------------------------------
-- Settings and notification rules (agency-wide)
-- ---------------------------------------------------------------------------

create table support_settings (
  id boolean primary key default true check (id),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  business_hours jsonb not null default '{"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]]}'::jsonb,
  holidays jsonb not null default '[]'::jsonb check (jsonb_typeof(holidays) = 'array'),
  -- Response targets are tracked, and shown to clients, only when the Super Admin turns them on.
  targets_enabled boolean not null default false,
  show_targets_to_clients boolean not null default false,
  business_hours_only boolean not null default true,
  first_response_minutes jsonb not null default '{}'::jsonb,
  follow_up_minutes jsonb not null default '{}'::jsonb,
  approaching_percent integer not null default 80 check (approaching_percent between 50 and 95),
  -- Raise an escalation notice to managers when a target has been missed by this many support minutes (null = off).
  overdue_escalation_minutes integer check (overdue_escalation_minutes is null or overdue_escalation_minutes between 1 and 43200),
  reopen_window_days integer not null default 14 check (reopen_window_days between 0 and 365),
  auto_close_resolved_days integer check (auto_close_resolved_days is null or auto_close_resolved_days between 1 and 90),
  max_attachment_mb integer not null default 10 check (max_attachment_mb between 1 and 10),
  max_attachments_per_message integer not null default 5 check (max_attachments_per_message between 1 and 10),
  staged_upload_ttl_hours integer not null default 24 check (staged_upload_ttl_hours between 1 and 168),
  -- Delete the files of a closed request after this many days (null = keep them with the request).
  attachment_retention_days integer check (attachment_retention_days is null or attachment_retention_days between 30 and 3650),
  default_priority jsonb not null default '{"support":"normal","issue":"normal","feedback":"low"}'::jsonb,
  ai_assist_enabled boolean not null default true,
  revision integer not null default 1,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into support_settings default values;

create table support_notification_rules (
  event_kind text primary key check (event_kind in (
    'request_submitted', 'assigned', 'agency_reply', 'client_reply', 'status_changed', 'priority_escalated',
    'response_approaching', 'response_overdue', 'resolved', 'reopened', 'closed')),
  mode text not null default 'in_app' check (mode in ('in_app', 'email', 'both', 'disabled')),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into support_notification_rules (event_kind, mode) values
  ('request_submitted', 'in_app'), ('assigned', 'in_app'), ('agency_reply', 'both'), ('client_reply', 'in_app'),
  ('status_changed', 'in_app'), ('priority_escalated', 'in_app'), ('response_approaching', 'in_app'),
  ('response_overdue', 'both'), ('resolved', 'both'), ('reopened', 'in_app'), ('closed', 'in_app');

-- One row per (event, person, channel). The unique key is what makes delivery idempotent: the same event can be handled twice
-- (a retried request, an overlapping scheduler run) and each person still hears about it once.
create table support_notification_log (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null,
  org_id uuid not null references organizations(id) on delete cascade,
  event_kind text not null check (event_kind in (
    'request_submitted', 'assigned', 'agency_reply', 'client_reply', 'status_changed', 'priority_escalated',
    'response_approaching', 'response_overdue', 'resolved', 'reopened', 'closed')),
  event_key text not null check (char_length(event_key) between 3 and 200),
  recipient_user_id uuid not null references users(id) on delete cascade,
  channel text not null check (channel in ('in_app', 'email')),
  -- in_app: delivered. email: queued -> sent (accepted by the provider; this is not a delivery receipt) or failed; captured in
  -- development; skipped with the reason in `detail`.
  status text not null check (status in ('delivered', 'queued', 'captured', 'sent', 'failed', 'skipped')),
  detail text check (char_length(detail) <= 300),
  attempts integer not null default 1 check (attempts >= 1),
  -- Set while a worker is sending the email, so two overlapping runs never send it twice.
  claimed_at timestamptz,
  -- What an email says, kept only while it is queued or has failed (so it can be retried); cleared once the provider accepts it.
  subject text check (char_length(subject) <= 200),
  body_text text check (char_length(body_text) <= 2000),
  notification_id uuid references notifications(id) on delete set null,
  email_outbox_id uuid references email_outbox(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_key, recipient_user_id, channel),
  foreign key (ticket_id, org_id) references support_tickets(id, org_id) on delete cascade
);
create index support_notification_log_ticket_idx on support_notification_log (ticket_id, created_at desc);
create index support_notification_log_failed_idx on support_notification_log (updated_at) where status = 'failed';

-- ---------------------------------------------------------------------------
-- Notification kinds
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
  'crm_workflow_failed', 'crm_webhook_failing',
  'crm_blueprint_applied',
  'support_assigned', 'support_status', 'support_escalated', 'support_sla'));

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

-- Everyone who works in a workspace can open and follow their own requests (support.use). Business Owners and Managers also see
-- the whole workspace's requests.
insert into role_permissions (role, permission) values
  ('owner', 'support.view_all'), ('admin', 'support.view_all'),
  ('agency_staff', 'agency.support.queue'), ('agency_manager', 'agency.support.queue'), ('agency_super_admin', 'agency.support.queue'),
  ('agency_staff', 'agency.support.notes'), ('agency_manager', 'agency.support.notes'), ('agency_super_admin', 'agency.support.notes'),
  ('agency_staff', 'agency.support.resolve'), ('agency_manager', 'agency.support.resolve'), ('agency_super_admin', 'agency.support.resolve'),
  ('agency_manager', 'agency.support.assign'), ('agency_super_admin', 'agency.support.assign'),
  ('agency_manager', 'agency.support.priority'), ('agency_super_admin', 'agency.support.priority'),
  ('agency_manager', 'agency.support.analytics'), ('agency_super_admin', 'agency.support.analytics'),
  ('agency_super_admin', 'agency.support.settings')
on conflict do nothing;

alter table agency_user_permission_overrides
  drop constraint agency_user_permission_overrides_permission_check;
alter table agency_user_permission_overrides
  add constraint agency_user_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'agency.support.queue', 'agency.support.notes', 'agency.support.assign', 'agency.support.priority', 'agency.support.resolve', 'agency.support.analytics',
    'agency.workforce.view', 'agency.workforce.manage',
    'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
    'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book', 'appointments.manage',
    'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign',
    'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export',
    'crm.view', 'setup.manage', 'projects.view', 'projects.manage', 'quotes.manage',
    'website.view', 'website.create', 'website.publish', 'website.edit', 'website.domains', 'website.review', 'website.archive'
  ));

alter table invitation_agency_permission_overrides
  drop constraint invitation_agency_permission_overrides_permission_check;
alter table invitation_agency_permission_overrides
  add constraint invitation_agency_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'agency.support.queue', 'agency.support.notes', 'agency.support.assign', 'agency.support.priority', 'agency.support.resolve', 'agency.support.analytics',
    'agency.workforce.view', 'agency.workforce.manage',
    'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
    'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book', 'appointments.manage',
    'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign',
    'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export',
    'crm.view', 'setup.manage', 'projects.view', 'projects.manage', 'quotes.manage',
    'website.view', 'website.create', 'website.publish', 'website.edit', 'website.domains', 'website.review', 'website.archive'
  ));

-- ---------------------------------------------------------------------------
-- Backfill (grounded in what the existing rows already say)
-- ---------------------------------------------------------------------------

alter table support_tickets disable trigger support_tickets_touch;
update support_tickets set request_type = 'issue' where category = 'bug';
update support_tickets t set first_responded_at = m.first_reply
  from (select ticket_id, min(created_at) as first_reply from support_messages where author_kind = 'agency' and not internal group by ticket_id) m
  where m.ticket_id = t.id;
update support_tickets set resolved_at = updated_at where status = 'resolved';
update support_tickets set resolved_at = updated_at, closed_at = updated_at where status = 'closed';
alter table support_tickets enable trigger support_tickets_touch;
insert into support_ticket_events (ticket_id, org_id, kind, visibility, actor_user_id, actor_kind, created_at)
  select id, org_id, 'created', 'client', created_by, 'client', created_at from support_tickets;
create trigger support_tickets_guard before update on support_tickets for each row execute function app.support_ticket_guard();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table support_ticket_events enable row level security;
alter table support_ticket_ops enable row level security;
alter table support_ticket_links enable row level security;
alter table support_settings enable row level security;
alter table support_notification_rules enable row level security;
alter table support_notification_log enable row level security;
revoke all on support_ticket_events, support_ticket_ops, support_ticket_links, support_settings, support_notification_rules, support_notification_log
  from public, anon, authenticated;
grant select on support_ticket_events, support_ticket_ops, support_ticket_links, support_settings, support_notification_rules, support_notification_log
  to iaq_app_user;

-- Who may read a request: agency staff for their clients, the person who opened it, and Business Owners / Managers for the
-- workspace. Restrictive, so it narrows what the existing (0060) permissive policies allow rather than replacing them.
create policy support_tickets_member_scope on support_tickets as restrictive for select to iaq_app_user
  using (
    app.staff_assigned(org_id)
    or created_by = (select app.current_user_id())
    or org_id = any ((select app.permitted_orgs('support.view_all'))::uuid[])
  );
create policy support_messages_ticket_scope on support_messages as restrictive for select to iaq_app_user
  using (exists (select 1 from support_tickets t where t.id = ticket_id));
create policy support_attachments_ticket_scope on support_attachments as restrictive for select to iaq_app_user
  using ((ticket_id is null and created_by = (select app.current_user_id()))
    or exists (select 1 from support_tickets t where t.id = ticket_id));

-- Clients see only the timeline events written for them; the team sees all of them.
create policy support_ticket_events_select on support_ticket_events for select to iaq_app_user
  using (
    (visibility = 'client' and org_id = any ((select app.permitted_orgs('support.use'))::uuid[]))
    or org_id = any ((select app.permitted_orgs('agency.support.view'))::uuid[])
  );
create policy support_ticket_events_ticket_scope on support_ticket_events as restrictive for select to iaq_app_user
  using (exists (select 1 from support_tickets t where t.id = ticket_id));

create policy support_ticket_ops_select on support_ticket_ops for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('agency.support.view'))::uuid[]));
create policy support_ticket_links_select on support_ticket_links for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('agency.support.view'))::uuid[]));

-- Global configuration: the agency reads it, server code writes it after checking agency.support.settings.
create policy support_settings_select on support_settings for select to iaq_app_user
  using (app.has_agency_permission('agency.support.view'));
create policy support_notification_rules_select on support_notification_rules for select to iaq_app_user
  using (app.has_agency_permission('agency.support.view'));
create policy support_notification_log_select on support_notification_log for select to iaq_app_user
  using (recipient_user_id = (select app.current_user_id()) or org_id = any ((select app.permitted_orgs('agency.support.settings'))::uuid[]));
