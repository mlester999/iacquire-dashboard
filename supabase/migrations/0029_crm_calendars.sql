-- Native calendars and booking: calendars, appointment types, people's weekly hours and exceptions, and appointments that can never
-- double-book a host. GoHighLevel appointments (appointment_refs rows with provider 'ghl') are untouched; native appointments live in the
-- same table with provider 'native', so reminders, timelines and the Appointments page keep working for both.
--
-- The hard guarantee against double booking is the exclusion constraint on crm_busy_blocks: two live blocks for the same person can never
-- overlap, whichever request commits first. Availability shown to customers is computed in code from the same tables, so it can only
-- ever offer times this constraint would accept.
--
-- As elsewhere, the application role only reads (row-level security); trusted server code writes after authorizing the action.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Calendars
-- ---------------------------------------------------------------------------

create table crm_calendars (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  description text check (char_length(description) <= 500),
  -- single: one host. round_robin: one of the members, chosen fairly. collective: every member attends, so all must be free.
  assignment text not null default 'single' check (assignment in ('single', 'round_robin', 'collective')),
  -- balanced: the free member assigned least recently (a fair rotation). priority: the highest-priority free member first.
  round_robin_mode text not null default 'balanced' check (round_robin_mode in ('balanced', 'priority')),
  color text check (color ~ '^#[0-9a-f]{6}$'),
  is_default boolean not null default false,
  -- Whether the calendar has a public booking page. Each appointment type can also be hidden on its own.
  public boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, org_id)
);
create unique index crm_calendars_slug on crm_calendars (org_id, slug) where archived_at is null;
create unique index crm_calendars_one_default on crm_calendars (org_id) where is_default and archived_at is null;
create trigger crm_calendars_touch before update on crm_calendars for each row execute function app.touch_updated_at();

create table crm_calendar_members (
  org_id uuid not null,
  calendar_id uuid not null,
  user_id uuid not null,
  priority integer not null default 50 check (priority between 0 and 100),
  active boolean not null default true,
  last_assigned_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (calendar_id, user_id),
  foreign key (calendar_id, org_id) references crm_calendars (id, org_id) on delete cascade,
  foreign key (org_id, user_id) references organization_memberships (org_id, user_id) on delete cascade
);
create index crm_calendar_members_user_idx on crm_calendar_members (org_id, user_id);

-- ---------------------------------------------------------------------------
-- Appointment types (what a customer books: length, buffers, notice, location)
-- ---------------------------------------------------------------------------

create table crm_appointment_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  calendar_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  description text check (char_length(description) <= 1000),
  duration_minutes integer not null check (duration_minutes between 5 and 720),
  -- How often start times are offered. Null means every duration (a 30-minute meeting starts on the half hour).
  slot_interval_minutes integer check (slot_interval_minutes between 5 and 240),
  buffer_before_minutes integer not null default 0 check (buffer_before_minutes between 0 and 240),
  buffer_after_minutes integer not null default 0 check (buffer_after_minutes between 0 and 240),
  min_notice_minutes integer not null default 120 check (min_notice_minutes between 0 and 43200),
  max_days_ahead integer not null default 60 check (max_days_ahead between 1 and 365),
  daily_limit integer check (daily_limit between 1 and 100),
  -- 1 is one-to-one. More than 1 is a group session: several people book the same time until it is full.
  capacity integer not null default 1 check (capacity between 1 and 500),
  location_kind text not null default 'phone' check (location_kind in ('phone', 'video', 'in_person', 'custom', 'none')),
  location_detail text check (char_length(location_detail) <= 300),
  -- Video links are only generated by a connected provider that supports it; a fixed link can be entered instead.
  meeting_provider text not null default 'none' check (meeting_provider in ('none', 'google_meet', 'microsoft_teams', 'custom_link')),
  meeting_link text check (meeting_link ~ '^https://' and char_length(meeting_link) <= 500),
  -- A booking waits for a person to confirm it before it counts as confirmed (the time is still held).
  requires_confirmation boolean not null default false,
  public boolean not null default true,
  -- Extra questions on the booking form: [{ "key", "label", "type": "text"|"textarea"|"select", "required", "options" }].
  questions jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array' and pg_column_size(questions) <= 8192),
  color text check (color ~ '^#[0-9a-f]{6}$'),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, org_id),
  foreign key (calendar_id, org_id) references crm_calendars (id, org_id) on delete cascade,
  check (meeting_provider <> 'custom_link' or meeting_link is not null)
);
create unique index crm_appointment_types_slug on crm_appointment_types (calendar_id, slug) where archived_at is null;
create trigger crm_appointment_types_touch before update on crm_appointment_types for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Working hours, per person per workspace, in that person's time zone
-- ---------------------------------------------------------------------------

create table crm_host_settings (
  org_id uuid not null,
  user_id uuid not null,
  timezone text not null check (char_length(timezone) between 1 and 64),
  accepting boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id),
  foreign key (org_id, user_id) references organization_memberships (org_id, user_id) on delete cascade
);
create trigger crm_host_settings_touch before update on crm_host_settings for each row execute function app.touch_updated_at();

create table crm_availability_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440),
  check (end_minute > start_minute),
  foreign key (org_id, user_id) references organization_memberships (org_id, user_id) on delete cascade
);
create index crm_availability_rules_user_idx on crm_availability_rules (org_id, user_id, weekday);

-- A day that differs from the weekly hours: closed all day (both minutes null), or open only in the given window. A row without a person
-- applies to everyone in the workspace (a public holiday).
create table crm_availability_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid,
  on_date date not null,
  start_minute integer check (start_minute between 0 and 1439),
  end_minute integer check (end_minute between 1 and 1440),
  reason text check (char_length(reason) <= 120),
  created_at timestamptz not null default now(),
  check ((start_minute is null) = (end_minute is null)),
  check (end_minute is null or end_minute > start_minute),
  foreign key (org_id, user_id) references organization_memberships (org_id, user_id) on delete cascade
);
create index crm_availability_overrides_idx on crm_availability_overrides (org_id, on_date);

-- ---------------------------------------------------------------------------
-- Busy blocks: the time a native appointment takes from a host, including buffers. Never overlapping for one person.
-- ---------------------------------------------------------------------------

create table crm_busy_blocks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  appointment_type_id uuid,
  -- The appointment this block belongs to (one-to-one and collective). Group sessions share one block per host and time instead.
  appointment_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity integer not null default 1 check (capacity between 1 and 500),
  booked integer not null default 1 check (booked >= 0),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  check (ends_at > starts_at),
  check (booked <= capacity),
  foreign key (appointment_type_id, org_id) references crm_appointment_types (id, org_id) on delete set null (appointment_type_id),
  constraint crm_busy_blocks_no_overlap exclude using gist (user_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (released_at is null)
);
create index crm_busy_blocks_user_idx on crm_busy_blocks (org_id, user_id, starts_at) where released_at is null;
create index crm_busy_blocks_appointment_idx on crm_busy_blocks (appointment_id) where appointment_id is not null;

-- ---------------------------------------------------------------------------
-- Native appointments share appointment_refs with GoHighLevel's
-- ---------------------------------------------------------------------------

alter table appointment_refs
  alter column ghl_appointment_id drop not null,
  alter column ghl_calendar_id drop not null,
  add column provider text not null default 'ghl' check (provider in ('ghl', 'native')),
  add column calendar_ref uuid,
  add column appointment_type_id uuid,
  add column busy_block_id uuid,
  add column location text check (char_length(location) <= 300),
  add column description text check (char_length(description) <= 2000),
  add column booked_via text check (booked_via in ('booking_page', 'staff', 'agent', 'api', 'import', 'ghl_migration', 'website')),
  add column answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 8192),
  add column cancel_reason text check (char_length(cancel_reason) <= 300),
  add column invitee_timezone text check (char_length(invitee_timezone) <= 64),
  -- sha256 of the secret in the customer's reschedule/cancel link. The secret itself is never stored.
  add column manage_token_hash text check (manage_token_hash ~ '^[0-9a-f]{64}$'),
  add column rescheduled_from uuid,
  add column created_by uuid references users(id) on delete set null,
  add column version integer not null default 1,
  -- A booking page or API retry with the same key returns the same appointment instead of booking twice.
  add column idempotency_key text check (char_length(idempotency_key) between 8 and 160),
  add column created_at timestamptz;
update appointment_refs set created_at = synced_at where created_at is null;
alter table appointment_refs alter column created_at set default now(), alter column created_at set not null;
alter table appointment_refs
  add constraint appointment_refs_ghl_shape check (provider = 'native' or (ghl_appointment_id is not null and ghl_calendar_id is not null)),
  add constraint appointment_refs_native_shape check (provider = 'ghl' or (calendar_ref is not null and appointment_type_id is not null and ghl_appointment_id is null)),
  add constraint appointment_refs_calendar_fk foreign key (calendar_ref, org_id) references crm_calendars (id, org_id),
  add constraint appointment_refs_type_fk foreign key (appointment_type_id, org_id) references crm_appointment_types (id, org_id),
  add constraint appointment_refs_block_fk foreign key (busy_block_id, org_id) references crm_busy_blocks (id, org_id) on delete set null (busy_block_id),
  add constraint appointment_refs_rescheduled_fk foreign key (rescheduled_from, org_id) references appointment_refs (id, org_id) on delete set null (rescheduled_from);
create unique index appointment_refs_manage_token on appointment_refs (manage_token_hash) where manage_token_hash is not null;
create unique index appointment_refs_idempotency on appointment_refs (org_id, idempotency_key) where idempotency_key is not null;
-- Native bookings also come from public booking pages and the API.
alter table appointment_refs drop constraint appointment_refs_origin_check;
alter table appointment_refs add constraint appointment_refs_origin_check check (origin in ('sync', 'webhook', 'portal_ai', 'portal_staff', 'booking_page', 'api'));
create index appointment_refs_native_idx on appointment_refs (org_id, calendar_ref, start_at) where provider = 'native';
create index appointment_refs_host_idx on appointment_refs (org_id, assigned_user_id, start_at) where assigned_user_id is not null;

-- Booking requests made by the Appointment Setter or a person (with their approval flow) can target a native appointment type. For those,
-- calendar_id holds the native appointment type's id and the result is a native appointment rather than a GoHighLevel one.
alter table appointment_bookings add column provider text not null default 'ghl' check (provider in ('ghl', 'native'));
do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'appointment_bookings'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%ghl_appointment_id IS NOT NULL%';
  if c is not null then execute format('alter table appointment_bookings drop constraint %I', c); end if;
end $$;
alter table appointment_bookings add constraint appointment_bookings_booked_shape check (
  status <> 'booked' or (booked_at is not null and (ghl_appointment_id is not null or (provider = 'native' and appointment_id is not null))));

alter table crm_busy_blocks add constraint crm_busy_blocks_appointment_fk foreign key (appointment_id, org_id) references appointment_refs (id, org_id) on delete cascade;

-- Collective appointments have more than one host.
create table crm_appointment_hosts (
  org_id uuid not null,
  appointment_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  primary key (appointment_id, user_id),
  foreign key (appointment_id, org_id) references appointment_refs (id, org_id) on delete cascade
);
create index crm_appointment_hosts_user_idx on crm_appointment_hosts (org_id, user_id);

-- ---------------------------------------------------------------------------
-- External calendars (Google, Microsoft 365, iCloud/CalDAV, ICS feeds)
-- ---------------------------------------------------------------------------

create table crm_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid not null,
  provider text not null check (provider in ('google', 'microsoft', 'caldav', 'ics')),
  account_label text not null check (char_length(account_label) between 1 and 200),
  status text not null default 'connected' check (status in ('connected', 'needs_reauth', 'error', 'disconnected')),
  -- AES-GCM ciphertext (APP_ENCRYPTION_KEY) of the provider tokens, CalDAV password or private feed URL. The application role cannot read it.
  credentials text check (char_length(credentials) <= 20000),
  token_expires_at timestamptz,
  -- Which of the person's calendars new appointments are written to (Google: "primary"). Null: busy times are read but nothing is written.
  external_calendar_id text check (char_length(external_calendar_id) <= 300),
  check_conflicts boolean not null default true,
  write_events boolean not null default false,
  sync_cursor text check (char_length(sync_cursor) <= 4000),
  last_synced_at timestamptz,
  last_error text check (char_length(last_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, user_id, provider, account_label),
  foreign key (org_id, user_id) references organization_memberships (org_id, user_id) on delete cascade,
  check (provider <> 'ics' or write_events = false)
);
create trigger crm_calendar_connections_touch before update on crm_calendar_connections for each row execute function app.touch_updated_at();

-- Busy times read from connected calendars. Only the times are kept (no titles, attendees or descriptions).
create table crm_external_busy (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  connection_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  external_ref text not null check (external_ref ~ '^[0-9a-f]{64}$'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  synced_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (connection_id, external_ref),
  foreign key (connection_id, org_id) references crm_calendar_connections (id, org_id) on delete cascade
);
create index crm_external_busy_user_idx on crm_external_busy (org_id, user_id, starts_at);

-- Events this workspace wrote to a connected calendar, so a reschedule or cancellation updates the same event.
create table crm_external_events (
  org_id uuid not null,
  appointment_id uuid not null,
  connection_id uuid not null,
  external_event_id text not null check (char_length(external_event_id) between 1 and 500),
  meeting_link text check (meeting_link ~ '^https://' and char_length(meeting_link) <= 500),
  synced_at timestamptz not null default now(),
  primary key (appointment_id, connection_id),
  foreign key (appointment_id, org_id) references appointment_refs (id, org_id) on delete cascade,
  foreign key (connection_id, org_id) references crm_calendar_connections (id, org_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Row-level security: read-only for the application role
-- ---------------------------------------------------------------------------

alter table crm_calendars enable row level security;
alter table crm_calendar_members enable row level security;
alter table crm_appointment_types enable row level security;
alter table crm_host_settings enable row level security;
alter table crm_availability_rules enable row level security;
alter table crm_availability_overrides enable row level security;
alter table crm_busy_blocks enable row level security;
alter table crm_appointment_hosts enable row level security;
alter table crm_calendar_connections enable row level security;
alter table crm_external_busy enable row level security;
alter table crm_external_events enable row level security;
revoke all on crm_calendars, crm_calendar_members, crm_appointment_types, crm_host_settings, crm_availability_rules, crm_availability_overrides,
  crm_busy_blocks, crm_appointment_hosts, crm_calendar_connections, crm_external_busy, crm_external_events from public, anon, authenticated;
grant select on crm_calendars, crm_calendar_members, crm_appointment_types, crm_host_settings, crm_availability_rules, crm_availability_overrides,
  crm_busy_blocks, crm_appointment_hosts, crm_external_busy, crm_external_events to iaq_app_user;
-- Never the credentials column.
grant select (id, org_id, user_id, provider, account_label, status, token_expires_at, external_calendar_id, check_conflicts, write_events, last_synced_at, last_error, created_at, updated_at)
  on crm_calendar_connections to iaq_app_user;

create policy crm_calendars_select on crm_calendars for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy crm_calendar_members_select on crm_calendar_members for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy crm_appointment_types_select on crm_appointment_types for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy crm_host_settings_select on crm_host_settings for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy crm_availability_rules_select on crm_availability_rules for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy crm_availability_overrides_select on crm_availability_overrides for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy crm_busy_blocks_select on crm_busy_blocks for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy crm_appointment_hosts_select on crm_appointment_hosts for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy crm_calendar_connections_select on crm_calendar_connections for select to iaq_app_user using (
  user_id = app.current_user_id() or app.has_permission(org_id, 'calendars.manage'));
create policy crm_external_busy_select on crm_external_busy for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));
create policy crm_external_events_select on crm_external_events for select to iaq_app_user using (app.has_permission(org_id, 'appointments.view'));

-- ---------------------------------------------------------------------------
-- Notification kinds used by native booking
-- ---------------------------------------------------------------------------

-- The full list from 0027, plus the booking kinds below. Every earlier kind must stay, or existing notifications would break the check.
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
  'crm_booking_new', 'crm_calendar_sync'));
