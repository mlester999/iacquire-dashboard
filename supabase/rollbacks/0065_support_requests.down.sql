-- Rollback for 0065_support_requests.
--
-- Run only after the application that depends on it is rolled back (the earlier release neither reads nor writes any of this).
-- What is lost on purpose: the request timeline (support_ticket_events), response clocks / escalation flags / AI summaries
-- (support_ticket_ops), request links, the support settings and notification rules, and the notification delivery log. Requests, their
-- messages and their attached files are kept.
-- What is converted so the earlier constraints hold again:
--   * status "new" becomes "open";
--   * categories added by 0065 become "general", and the request type, feedback stage, urgency, diagnostics and idempotency key are dropped
--     (feedback becomes an ordinary request in the earlier model);
--   * files that were staged but never sent, or already removed, are deleted from the support file list (their stored bytes are
--     marked deleted in private_files; the storage objects are cleaned up by the earlier release's file handling or by hand);
--   * support notifications of the four kinds 0065 added are deleted (the earlier constraint cannot hold them);
--   * per-person overrides of the new agency.support.* permissions are deleted, as are the new role_permissions rows.
-- The migration can be applied again afterwards.

-- Policies, trigger and function ---------------------------------------------------------------------------------------------------------
drop policy if exists support_tickets_member_scope on support_tickets;
drop policy if exists support_messages_ticket_scope on support_messages;
drop policy if exists support_attachments_ticket_scope on support_attachments;
drop trigger if exists support_tickets_guard on support_tickets;
drop function if exists app.support_ticket_guard();

-- New tables (their policies go with them) --------------------------------------------------------------------------------------------------
drop table if exists support_notification_log;
drop table if exists support_notification_rules;
drop table if exists support_settings;
drop table if exists support_ticket_links;
drop table if exists support_ticket_ops;
drop table if exists support_ticket_events;

-- Attachments -----------------------------------------------------------------------------------------------------------------------------
update private_files set status = 'deleted'
  where id in (select private_file_id from support_attachments where status <> 'attached' or ticket_id is null);
delete from support_attachments where status <> 'attached' or ticket_id is null;
drop index if exists support_attachments_staged_idx;
drop index if exists support_attachments_message_idx;
alter table support_attachments drop constraint if exists support_attachments_bound_check;
alter table support_attachments drop column if exists message_id, drop column if exists status, drop column if exists expires_at;
alter table support_attachments alter column ticket_id set not null;

-- Messages --------------------------------------------------------------------------------------------------------------------------------
drop index if exists support_messages_client_id_idx;
drop index if exists support_messages_body_trgm;
alter table support_messages drop column if exists client_message_id;

-- Tickets ---------------------------------------------------------------------------------------------------------------------------------
alter table support_tickets disable trigger support_tickets_touch;
update support_tickets set status = 'open' where status = 'new';
update support_tickets set category = 'general'
  where category not in ('general', 'ai_employees', 'integrations', 'billing', 'account', 'bug', 'onboarding', 'project', 'maintenance');
alter table support_tickets enable trigger support_tickets_touch;

drop index if exists support_tickets_idempotency_idx;
drop index if exists support_tickets_creator_idx;
drop index if exists support_tickets_assignee_idx;
drop index if exists support_tickets_type_idx;
drop index if exists support_tickets_org_status_idx;
drop index if exists support_tickets_subject_trgm;
alter table support_tickets drop constraint if exists support_tickets_feedback_type_check;
alter table support_tickets
  drop column if exists request_type, drop column if exists affected_feature, drop column if exists client_urgency, drop column if exists feedback_stage,
  drop column if exists diagnostics, drop column if exists idempotency_key, drop column if exists first_responded_at, drop column if exists resolved_at,
  drop column if exists closed_at, drop column if exists reopened_count, drop column if exists last_reopened_at, drop column if exists client_last_read_at,
  drop column if exists agency_last_read_at;

alter table support_tickets drop constraint support_tickets_status_check;
alter table support_tickets add constraint support_tickets_status_check
  check (status in ('open', 'in_progress', 'waiting_for_client', 'resolved', 'closed'));
alter table support_tickets drop constraint support_tickets_category_check;
alter table support_tickets add constraint support_tickets_category_check check (category in (
  'general', 'ai_employees', 'integrations', 'billing', 'account', 'bug', 'onboarding', 'project', 'maintenance'));

-- Notification kinds ----------------------------------------------------------------------------------------------------------------------
delete from notifications where kind in ('support_assigned', 'support_status', 'support_escalated', 'support_sla');
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
  'crm_blueprint_applied'));

-- Permissions -----------------------------------------------------------------------------------------------------------------------------
delete from agency_user_permission_overrides where permission in (
  'agency.support.queue', 'agency.support.notes', 'agency.support.assign', 'agency.support.priority', 'agency.support.resolve', 'agency.support.analytics');
delete from invitation_agency_permission_overrides where permission in (
  'agency.support.queue', 'agency.support.notes', 'agency.support.assign', 'agency.support.priority', 'agency.support.resolve', 'agency.support.analytics');
delete from role_permissions where permission in (
  'support.view_all', 'agency.support.queue', 'agency.support.notes', 'agency.support.assign', 'agency.support.priority', 'agency.support.resolve',
  'agency.support.analytics', 'agency.support.settings');

alter table agency_user_permission_overrides
  drop constraint agency_user_permission_overrides_permission_check;
alter table agency_user_permission_overrides
  add constraint agency_user_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
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
    'agency.workforce.view', 'agency.workforce.manage',
    'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
    'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book', 'appointments.manage',
    'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign',
    'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export',
    'crm.view', 'setup.manage', 'projects.view', 'projects.manage', 'quotes.manage',
    'website.view', 'website.create', 'website.publish', 'website.edit', 'website.domains', 'website.review', 'website.archive'
  ));
