-- Appointments: a portal-side event ledger, booking policy, portal-initiated bookings and customer reminders.
--
-- This does NOT replace or touch the n8n Appointment Event Processor and its separate durable ledger. It records what the portal
-- itself learns (GoHighLevel appointment webhooks and calendar syncs) in order, so duplicates, late events and races resolve to one
-- consistent appointment, and it is the only place the portal itself books from. GoHighLevel stays the calendar of record.
-- As elsewhere, the application role is read-only; trusted server code performs every write after authorizing it.

-- ---------------------------------------------------------------------------
-- Appointment rows learn who they are for and how they changed
-- ---------------------------------------------------------------------------

alter table appointment_refs
  add column contact_id uuid,
  add column ghl_contact_id text check (char_length(ghl_contact_id) <= 80),
  add column assigned_ghl_user_id text check (char_length(assigned_ghl_user_id) <= 80),
  add column assigned_user_id uuid references users(id) on delete set null,
  add column origin text not null default 'sync' check (origin in ('sync', 'webhook', 'portal_ai', 'portal_staff')),
  add column cancelled_at timestamptz,
  add column late_cancellation boolean not null default false,
  add column reschedule_count integer not null default 0 check (reschedule_count >= 0),
  add column previous_start_at timestamptz,
  -- Overlaps another live appointment on the same calendar. Recorded for a person to resolve; the provider's calendar stays the truth.
  add column conflict boolean not null default false,
  -- The provider timestamp the current state reflects. An event older than this can never overwrite it.
  add column last_event_at timestamptz,
  add column deleted_remote boolean not null default false;
alter table appointment_refs add foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id);
create index appointment_refs_contact_idx on appointment_refs (org_id, contact_id) where contact_id is not null;
create index appointment_refs_calendar_idx on appointment_refs (org_id, ghl_calendar_id, start_at);
alter table appointment_refs add constraint appointment_refs_id_org_unique unique (id, org_id);

-- ---------------------------------------------------------------------------
-- Booking policy
-- ---------------------------------------------------------------------------

create table appointment_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- Must be one of the calendars mapped to this workspace; verified in code every time it is used.
  default_calendar_id text check (char_length(default_calendar_id) <= 80),
  slot_minutes integer not null default 30 check (slot_minutes between 5 and 480),
  min_notice_minutes integer not null default 120 check (min_notice_minutes between 0 and 20160),
  max_days_ahead integer not null default 30 check (max_days_ahead between 1 and 31),
  -- Cancelling closer to the start than this counts as a late cancellation. Null means no policy.
  late_cancel_hours integer check (late_cancel_hours between 0 and 168),
  -- Off by default: the Appointment Setter proposes a booking and a person confirms it. The owner may let it book on its own.
  ai_booking_enabled boolean not null default false,
  reminders_enabled boolean not null default false,
  reminder_offsets_minutes integer[] not null default '{1440,120}' check (cardinality(reminder_offsets_minutes) <= 3 and 0 < all (reminder_offsets_minutes) and 20160 >= all (reminder_offsets_minutes)),
  -- The owner's standing approval for template reminders; checked for an approval-required employee every time one is sent.
  reminders_approval_id uuid references approval_requests(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger appointment_settings_touch before update on appointment_settings for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The event ledger
-- ---------------------------------------------------------------------------

create table appointment_events (
  id uuid primary key default gen_random_uuid(),
  -- Events recorded in one transaction share a timestamp; the sequence keeps the ledger in order.
  seq bigint generated always as identity,
  org_id uuid not null references organizations(id) on delete cascade,
  source text not null check (source in ('webhook', 'sync', 'portal')),
  provider_event_id text not null check (char_length(provider_event_id) <= 200),
  -- Identifies the logical event, so a redelivery with a different delivery id is still recognised as the same event.
  dedupe_key text not null check (char_length(dedupe_key) <= 400),
  kind text not null check (kind in ('create', 'update', 'delete')),
  ghl_appointment_id text not null check (char_length(ghl_appointment_id) <= 80),
  ghl_calendar_id text check (char_length(ghl_calendar_id) <= 80),
  ghl_contact_id text check (char_length(ghl_contact_id) <= 80),
  appointment_id uuid references appointment_refs(id) on delete set null,
  -- The provider's own clock (dateUpdated). This, not arrival time, orders events.
  event_time timestamptz not null,
  appointment_status text check (char_length(appointment_status) <= 30),
  start_at timestamptz,
  end_at timestamptz,
  -- applied: changed the appointment. stale: older than what we already know, kept for the record. conflict: applied, but it overlaps another
  -- live appointment. ignored: not for us or nothing to do. failed: could not be processed.
  outcome text not null check (outcome in ('applied', 'stale', 'conflict', 'ignored', 'failed')),
  detail text check (char_length(detail) <= 300),
  received_at timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create index appointment_events_appt_idx on appointment_events (org_id, ghl_appointment_id, event_time desc);
create index appointment_events_org_idx on appointment_events (org_id, seq desc);

-- ---------------------------------------------------------------------------
-- Portal-initiated bookings (by the Appointment Setter, or by a person)
-- ---------------------------------------------------------------------------

create table appointment_bookings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  conversation_id uuid,
  calendar_id text not null check (char_length(calendar_id) <= 80),
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null check (char_length(timezone) <= 64),
  title text not null check (char_length(title) between 1 and 200),
  assigned_ghl_user_id text check (char_length(assigned_ghl_user_id) <= 80),
  assigned_user_id uuid references users(id) on delete set null,
  requested_by_kind text not null check (requested_by_kind in ('ai', 'staff')),
  requested_by_user uuid references users(id) on delete set null,
  agent_id uuid references agent_instances(id) on delete set null,
  -- requested: waiting for the provider write. awaiting_approval: a person must confirm first. booked: the provider confirmed it.
  -- needs_manual: provider writes are off or failed, so a person books it by hand. failed/cancelled are final.
  status text not null check (status in ('awaiting_approval', 'requested', 'booked', 'needs_manual', 'failed', 'cancelled')),
  approval_id uuid references approval_requests(id) on delete set null,
  ghl_appointment_id text check (char_length(ghl_appointment_id) <= 80),
  appointment_id uuid references appointment_refs(id) on delete set null,
  -- When the provider last confirmed this exact time was free. A booking is only ever sent after a fresh check.
  availability_checked_at timestamptz,
  -- Set while one worker is sending this booking, so two cannot send it at once.
  claimed_at timestamptz,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  failure_reason text check (char_length(failure_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  booked_at timestamptz,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  unique (org_id, idempotency_key),
  unique (id, org_id),
  check (end_at > start_at),
  check (status <> 'booked' or (ghl_appointment_id is not null and booked_at is not null))
);
-- The hard stop against two people (or the AI and a person) taking the same slot. Overlaps of different lengths are caught in code,
-- inside a transaction that holds a per-calendar lock.
create unique index appointment_bookings_one_per_slot on appointment_bookings (org_id, calendar_id, start_at) where status in ('awaiting_approval', 'requested', 'booked', 'needs_manual');
create index appointment_bookings_org_idx on appointment_bookings (org_id, status, start_at);
create trigger appointment_bookings_touch before update on appointment_bookings for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Reminders
-- ---------------------------------------------------------------------------

create table appointment_reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  appointment_id uuid not null,
  offset_minutes integer not null check (offset_minutes between 1 and 20160),
  due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'queued', 'sent', 'skipped', 'blocked', 'cancelled')),
  reason text check (char_length(reason) <= 200),
  message_id uuid references conversation_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (appointment_id, org_id) references appointment_refs (id, org_id) on delete cascade,
  unique (appointment_id, offset_minutes)
);
create index appointment_reminders_due_idx on appointment_reminders (due_at) where status = 'scheduled';
create trigger appointment_reminders_touch before update on appointment_reminders for each row execute function app.touch_updated_at();

-- A reminder is its own kind of message: not a reply, not a sales follow-up, and not counted against the follow-up allowance.
alter table conversation_messages drop constraint conversation_messages_scope_check;
alter table conversation_messages add constraint conversation_messages_scope_check check (scope in ('reply', 'followup', 'human', 'reminder'));

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table appointment_settings enable row level security;
alter table appointment_events enable row level security;
alter table appointment_bookings enable row level security;
alter table appointment_reminders enable row level security;
revoke all on appointment_settings, appointment_events, appointment_bookings, appointment_reminders from public, anon, authenticated;
grant select on appointment_settings, appointment_events, appointment_bookings, appointment_reminders to iaq_app_user;
create policy appointment_settings_select on appointment_settings for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy appointment_events_select on appointment_events for select to iaq_app_user using (app.has_permission(org_id, 'appointments.manage'));
create policy appointment_bookings_select on appointment_bookings for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy appointment_reminders_select on appointment_reminders for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));

insert into role_permissions (role, permission) values
  ('owner', 'appointments.manage'), ('admin', 'appointments.manage'),
  ('owner', 'appointments.book'), ('admin', 'appointments.book'), ('member', 'appointments.book'), ('sales_rep', 'appointments.book'), ('support', 'appointments.book');

-- ---------------------------------------------------------------------------
-- Notifications about appointments
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
  'booking_cancelled', 'booking_rescheduled', 'booking_conflict', 'booking_needs_action'));

-- ---------------------------------------------------------------------------
-- Approvals: a booking a person must confirm, and a standing authorization for routine automated messages
-- ---------------------------------------------------------------------------

alter table approval_requests drop constraint approval_requests_kind_check;
alter table approval_requests add constraint approval_requests_kind_check check (kind in (
  'lead_import', 'outreach', 'follow_up_message', 'crm_update', 'campaign_activation',
  'knowledge_change', 'tool_action', 'config_change', 'appointment_booking', 'standing_authorization'));
