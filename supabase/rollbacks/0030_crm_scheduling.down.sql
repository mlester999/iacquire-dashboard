-- Rollback for 0030_crm_scheduling.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the portal's
-- booking pages, CRM screens and the scheduler first, and run it in one transaction (tests/crm-migrations.test.ts proves it executes on a
-- fully migrated local database). Roll back later CRM migrations first (highest number first).
--
-- It refuses while connected calendars hold sync state from this migration, or while two native booking requests share a slot (the older
-- one-per-slot index could not be rebuilt). Issued manage links, OAuth states and sync history are removed with their tables. Per-host
-- group-session blocks (crm_appointment_hosts.busy_block_id) are forgotten: the older code gives a place back on the first host's block only.

do $$
begin
  if exists (select 1 from crm_calendar_connections where provider_account_id is not null or available_calendars <> '[]'::jsonb) then
    raise exception 'Rollback refused: connected calendars hold account and sync details. Disconnect them deliberately first.';
  end if;
  if exists (
    select 1 from appointment_bookings where status in ('awaiting_approval', 'requested', 'booked', 'needs_manual')
    group by org_id, calendar_id, start_at having count(*) > 1
  ) then
    raise exception 'Rollback refused: several booking requests share one slot, which the older schema forbids. Let them finish first.';
  end if;
end $$;

alter table crm_appointment_hosts drop constraint if exists crm_appointment_hosts_block_fk;
alter table crm_appointment_hosts drop column if exists busy_block_id;

drop index if exists crm_external_events_remote_idx;
alter table crm_external_events
  drop column if exists remote_calendar_id, drop column if exists etag, drop column if exists content_hash, drop column if exists last_error,
  drop column if exists written_version, drop column if exists updated_at;

drop table if exists crm_calendar_sync_runs;
drop table if exists crm_calendar_oauth_states;
drop index if exists crm_calendar_connections_due_idx;
alter table crm_calendar_connections
  drop column if exists provider_account_id, drop column if exists scopes, drop column if exists available_calendars, drop column if exists conflict_calendar_ids,
  drop column if exists sync_cursors, drop column if exists next_sync_at, drop column if exists consecutive_failures, drop column if exists last_success_at,
  drop column if exists disconnected_at;

alter table crm_appointment_types drop constraint if exists crm_appointment_types_contact_detail;
alter table crm_appointment_types
  drop column if exists confirmation_message, drop column if exists allow_customer_changes, drop column if exists change_cutoff_minutes,
  drop column if exists require_email, drop column if exists require_phone;
alter table crm_calendars drop column if exists booking_intro;

drop table if exists crm_appointment_links;

drop index if exists appointment_bookings_native_slot_idx;
drop index if exists appointment_bookings_one_per_slot;
create unique index appointment_bookings_one_per_slot on appointment_bookings (org_id, calendar_id, start_at) where status in ('awaiting_approval', 'requested', 'booked', 'needs_manual');

delete from schema_migrations where version = '0030_crm_scheduling';
