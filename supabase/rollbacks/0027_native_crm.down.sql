-- Rollback for 0027_native_crm.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the portal's CRM
-- screens and the scheduler first, roll back 0028 and any later CRM migration first, and run it in one transaction
-- (tests/crm-migrations.test.ts proves it executes on a fully migrated local database).
--
-- It refuses to run while Native CRM data exists that the older schema cannot hold. The activity timeline, event outbox, support-session log
-- and export log ARE dropped by this script; export them first if you need them. The pg_trgm extension is left installed (it is harmless).

do $$
begin
  if exists (select 1 from organization_memberships where role = 'appointment_setter')
     or exists (select 1 from invitations where role = 'appointment_setter' and accepted_at is null and revoked_at is null) then
    raise exception 'Rollback refused: people hold (or are invited to) the Appointment Setter role. Change their role first.';
  end if;
  if exists (select 1 from crm_companies) or exists (select 1 from crm_tags) or exists (select 1 from crm_custom_fields) or exists (select 1 from crm_smart_lists)
     or exists (select 1 from crm_import_jobs) or exists (select 1 from crm_folders) or exists (select 1 from member_permission_overrides)
     or exists (select 1 from record_notes where record_type in ('contact', 'company')) then
    raise exception 'Rollback refused: Native CRM data exists (companies, tags, custom fields, saved lists, imports, folders, permission overrides or contact notes). Export it and remove it deliberately first.';
  end if;
  if exists (select 1 from contacts where first_name is not null or last_name is not null or address_line1 is not null or address_line2 is not null or city is not null
             or region is not null or postal_code is not null or country is not null or preferred_language is not null or preferred_channel is not null
             or lead_status <> 'new' or lead_score is not null or archived_at is not null) then
    raise exception 'Rollback refused: contacts hold Native CRM details (names, address, preferences, status, score or archive). Export them first.';
  end if;
end $$;

drop table if exists crm_export_jobs;
drop table if exists crm_import_rows;
drop table if exists crm_import_jobs;
drop table if exists crm_external_ids;
drop table if exists crm_support_sessions;
drop table if exists crm_events;
drop table if exists crm_activities;
drop table if exists crm_view_preferences;
drop table if exists crm_smart_lists;
drop table if exists crm_field_values;
drop table if exists crm_custom_fields;
drop table if exists crm_company_tags;
drop table if exists crm_contact_tags;
drop table if exists crm_tags;
drop table if exists crm_contact_companies;
drop table if exists crm_companies;
drop table if exists crm_folders;
drop table if exists crm_capability_providers;
drop table if exists crm_workspaces;
drop table if exists member_permission_overrides;
drop trigger if exists organizations_crm_workspace on organizations;
drop function if exists app.crm_workspace_for_new_client();
drop function if exists app.crm_field_value_guard();
drop function if exists app.guard_permission_override();

-- The permission check returns to its 0001 definition (no per-person overrides).
create or replace function app.has_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from role_permissions rp
    where rp.permission = p_permission
      and (
        rp.role = app.org_role(p_org)
        or (app.staff_assigned(p_org)
            and rp.role = case when app.is_agency_admin() then 'agency_super_admin' else 'agency_staff' end)
      )
  )
$$;
revoke all on function app.has_permission(uuid, text) from public;
grant execute on function app.has_permission(uuid, text) to iaq_app_user;

-- Notes
drop policy if exists record_notes_select on record_notes;
create policy record_notes_select on record_notes for select to iaq_app_user using (app.can_access_org(org_id));
alter table record_notes drop column if exists pinned, drop column if exists updated_at, drop column if exists deleted_at;
alter table record_notes drop constraint if exists record_notes_record_type_check;
alter table record_notes add constraint record_notes_record_type_check check (record_type in ('opportunity', 'lead', 'retention_account', 'appointment'));

-- Contacts
drop index if exists contacts_search_trgm;
drop index if exists contacts_directory_idx;
drop index if exists contacts_owner_idx;
drop index if exists contacts_status_idx;
alter table contacts drop column if exists search_text, drop column if exists first_name, drop column if exists last_name, drop column if exists address_line1,
  drop column if exists address_line2, drop column if exists city, drop column if exists region, drop column if exists postal_code, drop column if exists country,
  drop column if exists preferred_language, drop column if exists preferred_channel, drop column if exists lead_status, drop column if exists lead_score,
  drop column if exists created_by, drop column if exists created_via, drop column if exists archived_at, drop column if exists archived_by,
  drop column if exists last_activity_at, drop column if exists version;

-- Roles and permissions
delete from role_permissions where role = 'appointment_setter' or permission in (
  'crm.view', 'contacts.assign', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk', 'companies.view', 'companies.edit', 'tags.manage',
  'fields.manage', 'smartlists.share', 'pipelines.manage', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'calendars.manage',
  'calendars.connect', 'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'campaigns.send', 'forms.manage', 'reviews.manage',
  'calls.view', 'crm.provider.manage', 'crm.api.manage', 'crm.permissions.manage');
alter table organization_memberships drop constraint organization_memberships_role_check;
alter table organization_memberships add constraint organization_memberships_role_check check (role in ('owner', 'admin', 'member', 'sales_rep', 'support', 'viewer'));
alter table invitations drop constraint invitations_role_check;
alter table invitations add constraint invitations_role_check check (role in ('owner', 'admin', 'member', 'sales_rep', 'support', 'viewer'));
alter table role_permissions drop constraint role_permissions_role_check;
alter table role_permissions add constraint role_permissions_role_check
  check (role in ('owner', 'admin', 'member', 'sales_rep', 'support', 'viewer', 'agency_staff', 'agency_super_admin'));

-- Notification kinds (back to the 0025 list)
delete from notifications where kind in ('crm_import_finished', 'crm_assigned', 'crm_support_access', 'crm_task_due');
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

delete from schema_migrations where version = '0027_native_crm';
