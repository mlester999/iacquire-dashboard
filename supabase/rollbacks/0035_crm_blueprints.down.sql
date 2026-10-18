-- Rollback for 0035_crm_blueprints.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the portal's
-- CRM screens and the agency Blueprint library first, and run it in one transaction (tests/crm-migrations.test.ts proves it executes on a fully
-- migrated local database). Roll back later migrations first (highest number first).
--
-- It refuses while the agency library holds anything, while any Blueprint application exists, and while a client has a draft calendar that
-- is not archived or a calendar filed in a folder: the older schema cannot hold them, and without the status column a draft calendar would
-- start taking bookings.

do $$
begin
  if exists (select 1 from crm_blueprints) or exists (select 1 from crm_blueprint_versions) or exists (select 1 from crm_blueprint_folders)
     or exists (select 1 from crm_blueprint_imports) or exists (select 1 from crm_blueprint_ghl_sources) then
    raise exception 'Rollback refused: the agency Blueprint library is not empty. Export what you need and remove it deliberately first.';
  end if;
  if exists (select 1 from crm_blueprint_applications) or exists (select 1 from crm_blueprint_links) then
    raise exception 'Rollback refused: Blueprints have been applied to client workspaces. Roll those applications back and remove them deliberately first.';
  end if;
  if exists (select 1 from crm_calendars where status = 'draft' and archived_at is null) or exists (select 1 from crm_calendars where folder_id is not null) then
    raise exception 'Rollback refused: draft calendars exist (or calendars are filed in folders). Activate or archive the drafts, and unfile the calendars, first.';
  end if;
end $$;

drop table if exists crm_blueprint_links;
drop table if exists crm_blueprint_application_items;
drop table if exists crm_blueprint_applications;

alter table crm_calendars drop constraint if exists crm_calendars_draft_hidden;
alter table crm_calendars drop constraint if exists crm_calendars_folder_fk;
alter table crm_calendars
  drop column if exists status, drop column if exists verified_at, drop column if exists verification, drop column if exists folder_id,
  drop column if exists timezone, drop column if exists hours_template, drop column if exists origin;

drop table if exists crm_blueprint_imports;
drop trigger if exists ghl_location_mappings_not_blueprint_source on ghl_location_mappings;
drop function if exists app.guard_location_not_blueprint_source();
drop trigger if exists crm_blueprint_ghl_sources_guard on crm_blueprint_ghl_sources;
drop table if exists crm_blueprint_ghl_sources;
drop function if exists app.guard_blueprint_ghl_source();
drop table if exists crm_blueprint_versions;
drop table if exists crm_blueprints;
drop table if exists crm_blueprint_folders;

delete from role_permissions where permission in ('crm.blueprints.view', 'crm.blueprints.design', 'crm.blueprints.publish', 'crm.blueprints.apply');

-- Notification kinds as 0032 left them.
delete from notifications where kind = 'crm_blueprint_applied';
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

delete from schema_migrations where version = '0035_crm_blueprints';
