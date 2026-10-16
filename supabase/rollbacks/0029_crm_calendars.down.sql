-- Rollback for 0029_crm_calendars.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the portal's
-- booking pages, CRM screens and the scheduler first, and run it in one transaction (tests/crm-migrations.test.ts proves it executes on a
-- fully migrated local database). Roll back later CRM migrations first (highest number first).
--
-- It refuses to run while native calendars, appointment types or native appointments exist, because the older schema cannot hold them.
-- GoHighLevel appointment rows are kept. The btree_gist extension is left installed (other objects may use it; it is harmless).

do $$
begin
  if exists (select 1 from appointment_refs where provider = 'native') then
    raise exception 'Rollback refused: native appointments exist. Export or cancel them deliberately first.';
  end if;
  if exists (select 1 from appointment_bookings where provider = 'native') then
    raise exception 'Rollback refused: booking requests for native calendars exist. Let them finish or cancel them first.';
  end if;
  if exists (select 1 from crm_calendars) or exists (select 1 from crm_calendar_connections) then
    raise exception 'Rollback refused: native calendars or connected calendars exist. Remove them deliberately first.';
  end if;
end $$;

alter table appointment_bookings drop constraint if exists appointment_bookings_booked_shape;
alter table appointment_bookings drop column if exists provider;
alter table appointment_bookings add check (status <> 'booked' or (ghl_appointment_id is not null and booked_at is not null));
drop table if exists crm_external_events;
drop table if exists crm_external_busy;
drop table if exists crm_calendar_connections;
drop table if exists crm_appointment_hosts;
alter table crm_busy_blocks drop constraint if exists crm_busy_blocks_appointment_fk;

drop index if exists appointment_refs_manage_token;
drop index if exists appointment_refs_idempotency;
alter table appointment_refs drop constraint if exists appointment_refs_origin_check;
alter table appointment_refs add constraint appointment_refs_origin_check check (origin in ('sync', 'webhook', 'portal_ai', 'portal_staff'));
drop index if exists appointment_refs_native_idx;
drop index if exists appointment_refs_host_idx;
alter table appointment_refs
  drop constraint if exists appointment_refs_ghl_shape,
  drop constraint if exists appointment_refs_native_shape,
  drop constraint if exists appointment_refs_calendar_fk,
  drop constraint if exists appointment_refs_type_fk,
  drop constraint if exists appointment_refs_block_fk,
  drop constraint if exists appointment_refs_rescheduled_fk;
alter table appointment_refs
  drop column if exists provider, drop column if exists calendar_ref, drop column if exists appointment_type_id, drop column if exists busy_block_id,
  drop column if exists location, drop column if exists description, drop column if exists booked_via, drop column if exists answers,
  drop column if exists cancel_reason, drop column if exists invitee_timezone, drop column if exists manage_token_hash, drop column if exists rescheduled_from,
  drop column if exists created_by, drop column if exists version, drop column if exists idempotency_key, drop column if exists created_at;
alter table appointment_refs alter column ghl_appointment_id set not null, alter column ghl_calendar_id set not null;

drop table if exists crm_busy_blocks;
drop table if exists crm_availability_overrides;
drop table if exists crm_availability_rules;
drop table if exists crm_host_settings;
drop table if exists crm_appointment_types;
drop table if exists crm_calendar_members;
drop table if exists crm_calendars;

-- Notification kinds as 0027 left them. Notifications about native bookings and calendar sync refer to things that no longer exist.
delete from notifications where kind in ('crm_booking_new', 'crm_calendar_sync');
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
  'crm_import_finished', 'crm_assigned', 'crm_support_access', 'crm_task_due'));

delete from schema_migrations where version = '0029_crm_calendars';
