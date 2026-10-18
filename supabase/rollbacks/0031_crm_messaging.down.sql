-- Rollback for 0031_crm_messaging.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the portal's
-- inbox, webhooks and the scheduler first, and run it in one transaction (tests/crm-migrations.test.ts proves it executes on a fully migrated
-- local database). Roll back later CRM migrations first (highest number first).
--
-- It refuses while any channel uses a native provider, while native credentials or WhatsApp templates exist, or while native message
-- templates exist, because the older schema can only describe GoHighLevel channels.

do $$
begin
  if exists (select 1 from messaging_channels where provider <> 'ghl') then
    raise exception 'Rollback refused: channels send through Resend, Twilio or Meta. Switch them back to GoHighLevel or disable them deliberately first.';
  end if;
  if exists (select 1 from integration_credentials where provider in ('resend', 'twilio', 'meta_whatsapp'))
     or exists (select 1 from credential_references where provider in ('resend', 'twilio', 'meta_whatsapp'))
     or exists (select 1 from integration_connections where provider in ('resend', 'twilio', 'meta_whatsapp'))
     or exists (select 1 from integration_status where provider in ('resend', 'twilio', 'meta_whatsapp')) then
    raise exception 'Rollback refused: credentials or connections for Resend, Twilio or Meta exist. Revoke and remove them deliberately first.';
  end if;
  if exists (select 1 from whatsapp_templates where provider <> 'ghl') then
    raise exception 'Rollback refused: WhatsApp templates synced from Meta exist. Remove them deliberately first.';
  end if;
  if exists (select 1 from crm_message_templates) then
    raise exception 'Rollback refused: message templates or canned replies exist. Export and remove them deliberately first.';
  end if;
end $$;

drop table if exists crm_message_template_versions;
drop table if exists crm_message_templates;

alter table integration_status drop constraint integration_status_provider_check;
alter table integration_status add constraint integration_status_provider_check
  check (provider in ('hermes', 'ghl', 'ghl_calendar', 'n8n', 'slack', 'email', 'llm', 'database'));
alter table integration_connections drop constraint integration_connections_provider_check;
alter table integration_connections add constraint integration_connections_provider_check
  check (provider in ('supabase', 'hermes', 'ghl', 'n8n', 'llm', 'google_calendar', 'email', 'domain', 'external'));
alter table credential_references drop constraint credential_references_provider_check;
alter table credential_references add constraint credential_references_provider_check
  check (provider in ('hermes', 'ghl', 'n8n', 'llm', 'email', 'google_calendar', 'domain', 'external'));
alter table integration_credentials drop constraint integration_credentials_provider_check;
alter table integration_credentials add constraint integration_credentials_provider_check
  check (provider in ('hermes', 'ghl', 'n8n', 'slack', 'email', 'llm'));

alter table whatsapp_templates
  drop column if exists provider, drop column if exists category, drop column if exists variables, drop column if exists components, drop column if exists rejection_reason;

alter table message_delivery_events drop column if exists raw_status;
drop index if exists conversation_messages_thread_ref_idx;
alter table conversation_messages drop column if exists provider_thread_ref, drop column if exists segments_actual;

drop index if exists messaging_channels_inbound_idx;
drop index if exists messaging_channels_sender_idx;
alter table messaging_channels drop constraint if exists messaging_channels_native_ready;
alter table messaging_channels drop constraint if exists messaging_channels_provider_channel;
alter table messaging_channels
  drop column if exists provider_sender_id, drop column if exists provider_account_id, drop column if exists credential_id,
  drop column if exists inbound_address, drop column if exists capability_test, drop column if exists capability_tested_at;
alter table messaging_channels drop constraint messaging_channels_provider_check;
alter table messaging_channels add constraint messaging_channels_provider_check check (provider = 'ghl');

delete from schema_migrations where version = '0031_crm_messaging';
