-- Rollback for 0033_crm_growth.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the portal's
-- CRM screens, public form and review pages, voice webhooks and the scheduler first, and run it in one transaction (tests/crm-migrations.test.ts
-- proves it executes on a fully migrated local database). Roll back later CRM migrations first (highest number first).
--
-- It refuses while forms, submissions, campaigns, review requests, call records, voice connections, report definitions or configuration values
-- exist, or while customer feedback refers to contacts or review requests, because the older schema cannot hold them.

do $$
begin
  if exists (select 1 from crm_forms) or exists (select 1 from crm_form_submissions) then
    raise exception 'Rollback refused: native forms or their submissions exist. Export and remove them deliberately first.';
  end if;
  if exists (select 1 from crm_campaigns) then
    raise exception 'Rollback refused: campaigns exist. Remove them deliberately first.';
  end if;
  if exists (select 1 from crm_review_requests) or exists (select 1 from crm_review_destinations)
     or exists (select 1 from customer_feedback where contact_id is not null or review_request_id is not null or source <> 'manual') then
    raise exception 'Rollback refused: review requests, review destinations or linked customer feedback exist. Export and remove them deliberately first.';
  end if;
  if exists (select 1 from crm_call_records) or exists (select 1 from crm_voice_connections)
     or exists (select 1 from integration_credentials where provider in ('vapi', 'retell'))
     or exists (select 1 from credential_references where provider in ('vapi', 'retell')) then
    raise exception 'Rollback refused: call records or voice connections exist. Export and remove them deliberately first.';
  end if;
  if exists (select 1 from crm_report_definitions) or exists (select 1 from crm_custom_values) then
    raise exception 'Rollback refused: saved reports or configuration values exist. Remove them deliberately first.';
  end if;
end $$;

drop table if exists crm_report_definitions;

alter table credential_references drop constraint credential_references_provider_check;
alter table credential_references add constraint credential_references_provider_check
  check (provider in ('hermes', 'ghl', 'n8n', 'llm', 'email', 'google_calendar', 'domain', 'external', 'resend', 'twilio', 'meta_whatsapp'));
alter table integration_credentials drop constraint integration_credentials_provider_check;
alter table integration_credentials add constraint integration_credentials_provider_check
  check (provider in ('hermes', 'ghl', 'n8n', 'slack', 'email', 'llm', 'resend', 'twilio', 'meta_whatsapp'));
drop table if exists crm_voice_connections;
drop table if exists crm_call_records;

alter table customer_feedback drop constraint if exists customer_feedback_request_fk;
alter table customer_feedback drop constraint if exists customer_feedback_contact_fk;
alter table customer_feedback drop constraint if exists customer_feedback_id_org;
alter table customer_feedback
  drop column if exists contact_id, drop column if exists review_request_id, drop column if exists source,
  drop column if exists follow_up_status, drop column if exists escalated_task_id;
drop table if exists crm_review_requests;
drop table if exists crm_review_destinations;

drop table if exists crm_campaign_recipients;
drop table if exists crm_campaigns;

drop function if exists app.submit_crm_form(text, text, text, jsonb, jsonb, text, boolean, text, text, text, uuid);
drop table if exists crm_form_submissions;
alter table crm_forms drop constraint if exists crm_forms_published_fk;
drop table if exists crm_form_versions;
drop table if exists crm_forms;
drop table if exists crm_custom_values;

delete from schema_migrations where version = '0033_crm_growth';
