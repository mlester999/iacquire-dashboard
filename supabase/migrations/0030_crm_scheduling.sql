-- iAcquire Native CRM, scheduling (phase 2b): what booking pages, the calendar workspace and connected calendars need on top of 0029.
--
-- What this adds:
--   * Manage links that can be issued more than once. The link a customer gets when they book is still returned once, but reminders,
--     confirmations and staff can now each issue a fresh link (stored only as a hash, with an expiry) without invalidating the others.
--   * Connected calendars (Google, Microsoft 365, CalDAV, ICS): the provider account, granted scopes, the account's calendars and which of
--     them count for conflicts, per-calendar sync cursors, failure tracking, and a sync history. OAuth sign-ins use a short-lived, single-use
--     state with a PKCE verifier held encrypted. Events written to a connected calendar remember what was written, so a sync never rewrites
--     or recreates the same event.
--   * Booking page options: an intro on the calendar, and per appointment type a confirmation message, whether customers may reschedule or
--     cancel themselves (and how close to the start), and which contact details the booking form requires.
--   * Fix: one booking request per slot applied to native appointment types too, which made a second request for a round-robin calendar's
--     other free host (or a group session's next seat) fail. Native requests are now checked against the slot's real capacity in code.
--   * Fix: a group session on a collective calendar recorded only the first host's shared busy block, so cancelling or moving a booking
--     left the other hosts' places taken. Each host's block is now recorded on crm_appointment_hosts.
--
-- As elsewhere, the application role only reads (row-level security) and trusted server code writes after authorizing the action.
-- Rollback: supabase/rollbacks/0030_crm_scheduling.down.sql.

-- ---------------------------------------------------------------------------
-- One request per slot, for GoHighLevel calendars only
-- ---------------------------------------------------------------------------

drop index if exists appointment_bookings_one_per_slot;
create unique index appointment_bookings_one_per_slot on appointment_bookings (org_id, calendar_id, start_at)
  where status in ('awaiting_approval', 'requested', 'booked', 'needs_manual') and provider = 'ghl';
create index appointment_bookings_native_slot_idx on appointment_bookings (org_id, calendar_id, start_at)
  where provider = 'native' and status in ('awaiting_approval', 'requested', 'needs_manual');

-- ---------------------------------------------------------------------------
-- Manage links issued after booking (reminders, confirmations, staff)
-- ---------------------------------------------------------------------------

create table crm_appointment_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  appointment_id uuid not null,
  -- sha256 of the secret in the link. The secret itself is never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_for text not null check (issued_for in ('confirmation', 'reminder', 'staff', 'reschedule')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at),
  foreign key (appointment_id, org_id) references appointment_refs (id, org_id) on delete cascade
);
create index crm_appointment_links_appointment_idx on crm_appointment_links (appointment_id);

-- ---------------------------------------------------------------------------
-- Booking page options
-- ---------------------------------------------------------------------------

alter table crm_calendars add column booking_intro text check (char_length(booking_intro) <= 500);

alter table crm_appointment_types
  add column confirmation_message text check (char_length(confirmation_message) <= 500),
  -- Customers may move or cancel their own booking from their link until this many minutes before it starts.
  add column allow_customer_changes boolean not null default true,
  add column change_cutoff_minutes integer not null default 0 check (change_cutoff_minutes between 0 and 10080),
  add column require_email boolean not null default true,
  add column require_phone boolean not null default false;
alter table crm_appointment_types add constraint crm_appointment_types_contact_detail check (require_email or require_phone);

-- ---------------------------------------------------------------------------
-- Connected calendars
-- ---------------------------------------------------------------------------

alter table crm_calendar_connections
  -- The provider's own id for the account (Google subject, Microsoft object id, CalDAV principal URL). Identifies a reconnect.
  add column provider_account_id text check (char_length(provider_account_id) <= 300),
  add column scopes text[] not null default '{}' check (cardinality(scopes) <= 20),
  -- The account's calendars as the provider listed them: [{ "id", "name", "primary", "canWrite", "timezone" }]. No event data.
  add column available_calendars jsonb not null default '[]'::jsonb check (jsonb_typeof(available_calendars) = 'array' and pg_column_size(available_calendars) <= 65536),
  -- Which of those calendars make the person busy. Empty with check_conflicts on means the primary calendar.
  add column conflict_calendar_ids text[] not null default '{}' check (cardinality(conflict_calendar_ids) <= 50),
  -- Incremental sync position per calendar (Google sync tokens, Microsoft delta links, CalDAV ctags, ICS ETags).
  add column sync_cursors jsonb not null default '{}'::jsonb check (jsonb_typeof(sync_cursors) = 'object' and pg_column_size(sync_cursors) <= 65536),
  add column next_sync_at timestamptz,
  add column consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  add column last_success_at timestamptz,
  add column disconnected_at timestamptz;
create index crm_calendar_connections_due_idx on crm_calendar_connections (next_sync_at) where status = 'connected';

-- A sign-in in progress with Google or Microsoft: single use, ten minutes, bound to the person who started it.
create table crm_calendar_oauth_states (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid not null,
  provider text not null check (provider in ('google', 'microsoft')),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  -- AES-GCM ciphertext (APP_ENCRYPTION_KEY) of the PKCE code verifier.
  code_verifier text not null check (char_length(code_verifier) between 20 and 2000),
  return_path text check (return_path ~ '^/[A-Za-z0-9/_?=&.-]*$' and char_length(return_path) <= 300),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '30 minutes'),
  foreign key (org_id, user_id) references organization_memberships (org_id, user_id) on delete cascade
);

-- What a sync did, kept short and without event contents.
create table crm_calendar_sync_runs (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  connection_id uuid not null,
  kind text not null check (kind in ('busy', 'write', 'connect', 'disconnect')),
  status text not null check (status in ('ok', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 4096),
  error text check (char_length(error) <= 300),
  foreign key (connection_id, org_id) references crm_calendar_connections (id, org_id) on delete cascade
);
create index crm_calendar_sync_runs_connection_idx on crm_calendar_sync_runs (connection_id, started_at desc);
create trigger crm_calendar_sync_runs_immutable before update on crm_calendar_sync_runs for each row
  when (old.finished_at is not null) execute function app.immutable_row();

-- Events written to a connected calendar: which calendar, the provider's version, and a hash of what was written, so an unchanged
-- appointment is never rewritten and a sync can tell our own events from the person's other commitments. written_version is the
-- appointment_refs.version the last write was built from: a change that commits while a write is in flight leaves the two different, so
-- the next pass writes again (clock times can't tell, because a transaction's timestamps are taken when it starts, not when it commits).
alter table crm_external_events
  add column remote_calendar_id text check (char_length(remote_calendar_id) <= 300),
  add column etag text check (char_length(etag) <= 300),
  add column content_hash text check (content_hash ~ '^[0-9a-f]{64}$'),
  add column last_error text check (char_length(last_error) <= 300),
  add column written_version integer,
  add column updated_at timestamptz not null default now();
create index crm_external_events_remote_idx on crm_external_events (connection_id, external_event_id);

-- ---------------------------------------------------------------------------
-- Group sessions on collective calendars hold one shared block per host
-- ---------------------------------------------------------------------------

-- A collective booking of a group type joins (or starts) one shared busy block for EACH host. appointment_refs.busy_block_id can name only
-- one of them, so each host's block is recorded on that host's row, and cancelling or moving gives a place back on every one of them.
alter table crm_appointment_hosts
  add column busy_block_id uuid,
  add constraint crm_appointment_hosts_block_fk foreign key (busy_block_id, org_id) references crm_busy_blocks (id, org_id) on delete set null (busy_block_id);
-- Live bookings made before this column existed: each host's shared block is the one of the same type and start as the recorded block.
update crm_appointment_hosts h set busy_block_id = b.id
from appointment_refs a, crm_busy_blocks rec, crm_busy_blocks b
where a.id = h.appointment_id and a.org_id = h.org_id and a.status in ('new', 'confirmed') and a.busy_block_id is not null
  and rec.id = a.busy_block_id and rec.org_id = a.org_id
  and b.org_id = h.org_id and b.user_id = h.user_id and b.appointment_type_id = rec.appointment_type_id and b.starts_at = rec.starts_at
  and b.appointment_id is null and b.released_at is null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table crm_appointment_links enable row level security;
alter table crm_calendar_oauth_states enable row level security;
alter table crm_calendar_sync_runs enable row level security;
-- Link hashes and OAuth states are secrets in all but name: trusted server code only.
revoke all on crm_appointment_links, crm_calendar_oauth_states, crm_calendar_sync_runs from public, anon, authenticated, iaq_site_runtime;
grant select on crm_calendar_sync_runs to iaq_app_user;
create policy crm_calendar_sync_runs_select on crm_calendar_sync_runs for select to iaq_app_user using (
  app.has_permission(org_id, 'calendars.manage')
  or exists (select 1 from crm_calendar_connections c where c.id = connection_id and c.org_id = crm_calendar_sync_runs.org_id and c.user_id = app.current_user_id()));

-- The new connection columns are readable like the others (never the credentials).
grant select (provider_account_id, scopes, available_calendars, conflict_calendar_ids, next_sync_at, consecutive_failures, last_success_at, disconnected_at)
  on crm_calendar_connections to iaq_app_user;
