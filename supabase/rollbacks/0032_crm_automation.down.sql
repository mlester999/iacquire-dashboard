-- Rollback for 0032_crm_automation.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the portal's
-- CRM screens, webhooks, the agent tool endpoint and the scheduler first, and run it in one transaction (tests/crm-migrations.test.ts proves it
-- executes on a fully migrated local database). Roll back later CRM migrations first (highest number first).
--
-- It refuses while workflows, assignment rules, webhook subscriptions or API keys exist, and while any approval, agent run, pause or
-- notification uses a value only this migration allows.

do $$
begin
  if exists (select 1 from crm_workflows) then
    raise exception 'Rollback refused: workflows exist. Export and remove them deliberately first.';
  end if;
  if exists (select 1 from crm_assignment_rules) then
    raise exception 'Rollback refused: lead assignment rules exist. Remove them deliberately first.';
  end if;
  if exists (select 1 from crm_webhook_subscriptions) or exists (select 1 from crm_api_keys) then
    raise exception 'Rollback refused: webhook subscriptions or API keys exist. Revoke and remove them deliberately first.';
  end if;
  if exists (select 1 from approval_requests where kind in ('workflow_activation', 'workflow_action'))
     or exists (select 1 from agent_runs where purpose in ('workflow', 'crm_tool'))
     or exists (select 1 from automation_pauses where scope = 'workflows') then
    raise exception 'Rollback refused: approvals, agent runs or pauses created by workflows or agent tools exist. Resolve them deliberately first.';
  end if;
end $$;

delete from notifications where kind in ('crm_workflow_failed', 'crm_webhook_failing');
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

alter table automation_pauses drop constraint automation_pauses_scope_check;
alter table automation_pauses add constraint automation_pauses_scope_check check (scope in ('messaging', 'outbound', 'agency'));
alter table agent_runs drop constraint agent_runs_purpose_check;
alter table agent_runs add constraint agent_runs_purpose_check check (purpose in ('chat', 'lead_research', 'health_check'));
alter table approval_requests drop constraint approval_requests_kind_check;
alter table approval_requests add constraint approval_requests_kind_check check (kind in (
  'lead_import', 'outreach', 'follow_up_message', 'crm_update', 'campaign_activation',
  'knowledge_change', 'tool_action', 'config_change', 'appointment_booking', 'standing_authorization'));

drop table if exists crm_api_keys;
drop table if exists crm_webhook_deliveries;
drop table if exists crm_webhook_subscriptions;
drop table if exists crm_agent_tokens;
drop table if exists crm_assignment_history;
drop table if exists crm_assignment_members;
drop table if exists crm_assignment_rules;
drop table if exists crm_workflow_run_steps;
drop table if exists crm_workflow_runs;
alter table crm_workflows drop constraint if exists crm_workflows_published_fk;
drop table if exists crm_workflow_versions;
drop table if exists crm_workflows;

delete from schema_migrations where version = '0032_crm_automation';
