-- iAcquire Native CRM, communications (phase 3): native transports next to GoHighLevel, chosen per workspace and channel.
--
--   * Email through Resend, SMS through Twilio, WhatsApp through Meta's WhatsApp Business Cloud API. GoHighLevel stays available for every
--     channel, and every existing channel keeps provider 'ghl' (the default), so nothing changes for current tenants.
--   * A native channel can only be enabled once a credential is stored, a sender is named and an authenticated capability test passed.
--   * Email threading (Message-ID), actual SMS segment counts and the provider's own status wording are kept with each message and event.
--   * WhatsApp templates remember which provider they belong to, their category, variables and why Meta rejected them.
--   * Native message templates and canned replies: versioned, with an approval of an exact version, and folders.
--
-- As elsewhere, the application role only reads (row-level security) and trusted server code writes after authorizing the action.
-- Rollback: supabase/rollbacks/0031_crm_messaging.down.sql.

-- ---------------------------------------------------------------------------
-- Channels: one provider per workspace and channel
-- ---------------------------------------------------------------------------

alter table messaging_channels drop constraint messaging_channels_provider_check;
alter table messaging_channels add constraint messaging_channels_provider_check check (provider in ('ghl', 'resend', 'twilio', 'meta_whatsapp'));
alter table messaging_channels add constraint messaging_channels_provider_channel check (
  provider = 'ghl' or (channel = 'email' and provider = 'resend') or (channel = 'sms' and provider = 'twilio') or (channel = 'whatsapp' and provider = 'meta_whatsapp'));
alter table messaging_channels
  -- Twilio Messaging Service SID or number, Meta phone_number_id, Resend domain id: how a provider webhook finds its workspace.
  add column provider_sender_id text check (char_length(provider_sender_id) between 1 and 200),
  -- Meta WhatsApp Business Account id (templates live there), Twilio account SID: the account the sender belongs to.
  add column provider_account_id text check (char_length(provider_account_id) between 1 and 200),
  add column credential_id uuid references integration_credentials(id) on delete set null,
  -- The address customers email to reach this workspace, when inbound email is routed to iAcquire.
  add column inbound_address citext check (char_length(inbound_address::text) <= 320),
  -- The last authenticated capability test: what was checked and what the provider said (no secrets).
  add column capability_test jsonb not null default '{}'::jsonb check (jsonb_typeof(capability_test) = 'object' and pg_column_size(capability_test) <= 4096),
  add column capability_tested_at timestamptz;
-- A native channel is enabled only with a stored credential, a named sender and a passed capability test: the latest one recorded, so a
-- pass followed by a failed re-test does not count.
alter table messaging_channels add constraint messaging_channels_native_ready check (
  provider = 'ghl' or not enabled or (credential_id is not null and provider_sender_id is not null and capability_tested_at is not null
    and capability_test @> '{"ok": true}'::jsonb));
create unique index messaging_channels_sender_idx on messaging_channels (provider, provider_sender_id) where provider_sender_id is not null;
create unique index messaging_channels_inbound_idx on messaging_channels (inbound_address) where inbound_address is not null;

-- ---------------------------------------------------------------------------
-- Messages and delivery events
-- ---------------------------------------------------------------------------

alter table conversation_messages
  -- Email Message-ID of this message (outbound) or of the email it answers (inbound), for In-Reply-To and References.
  add column provider_thread_ref text check (char_length(provider_thread_ref) <= 998),
  -- What the provider reported it actually billed or split the message into (Twilio NumSegments), when it says so.
  add column segments_actual integer check (segments_actual between 1 and 50);
create index conversation_messages_thread_ref_idx on conversation_messages (org_id, provider_thread_ref) where provider_thread_ref is not null;

-- The provider's own status word (Resend "delivery_delayed", Twilio "undelivered", Meta "failed"), next to the normalized status.
alter table message_delivery_events add column raw_status text check (char_length(raw_status) <= 60);

-- ---------------------------------------------------------------------------
-- WhatsApp templates
-- ---------------------------------------------------------------------------

alter table whatsapp_templates
  add column provider text not null default 'ghl' check (provider in ('ghl', 'meta_whatsapp')),
  add column category text check (category in ('marketing', 'utility', 'authentication')),
  -- Positional parameters ({{1}}, {{2}} …) with a label each, and the template's components as Meta returned them.
  add column variables jsonb not null default '[]'::jsonb check (jsonb_typeof(variables) = 'array' and pg_column_size(variables) <= 4096),
  add column components jsonb not null default '[]'::jsonb check (jsonb_typeof(components) = 'array' and pg_column_size(components) <= 16384),
  add column rejection_reason text check (char_length(rejection_reason) <= 300);

-- ---------------------------------------------------------------------------
-- Credentials for the new providers
-- ---------------------------------------------------------------------------

alter table integration_credentials drop constraint integration_credentials_provider_check;
alter table integration_credentials add constraint integration_credentials_provider_check
  check (provider in ('hermes', 'ghl', 'n8n', 'slack', 'email', 'llm', 'resend', 'twilio', 'meta_whatsapp'));
alter table credential_references drop constraint credential_references_provider_check;
alter table credential_references add constraint credential_references_provider_check
  check (provider in ('hermes', 'ghl', 'n8n', 'llm', 'email', 'google_calendar', 'domain', 'external', 'resend', 'twilio', 'meta_whatsapp'));
alter table integration_connections drop constraint integration_connections_provider_check;
alter table integration_connections add constraint integration_connections_provider_check
  check (provider in ('supabase', 'hermes', 'ghl', 'n8n', 'llm', 'google_calendar', 'email', 'domain', 'external', 'resend', 'twilio', 'meta_whatsapp'));
alter table integration_status drop constraint integration_status_provider_check;
alter table integration_status add constraint integration_status_provider_check
  check (provider in ('hermes', 'ghl', 'ghl_calendar', 'n8n', 'slack', 'email', 'llm', 'database', 'resend', 'twilio', 'meta_whatsapp'));

-- ---------------------------------------------------------------------------
-- Native message templates and canned replies
-- ---------------------------------------------------------------------------

create table crm_message_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null default 'template' check (kind in ('template', 'canned_reply')),
  key text not null check (key ~ '^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  channel text check (channel in ('email', 'sms', 'whatsapp')),
  -- Service messages answer something the person asked for; marketing messages need marketing consent and an opt-out.
  purpose text not null default 'service' check (purpose in ('service', 'marketing')),
  category text check (char_length(category) <= 40),
  folder_id uuid,
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  current_version integer not null default 1 check (current_version >= 1),
  -- The exact version a person approved for automated use. Editing makes a new version, which needs approving again.
  approved_version integer check (approved_version >= 1),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  -- A WhatsApp template is sent by its Meta-approved name; this links the definition to that approved template.
  whatsapp_template_id text check (char_length(whatsapp_template_id) <= 120),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, org_id),
  foreign key (folder_id, org_id) references crm_folders (id, org_id) on delete set null (folder_id),
  check ((status = 'archived') = (archived_at is not null)),
  check ((status = 'approved') = (approved_version is not null and approved_at is not null)),
  check (approved_version is null or approved_version <= current_version),
  check (kind = 'canned_reply' or channel is not null)
);
create unique index crm_message_templates_key on crm_message_templates (org_id, key) where archived_at is null;
create index crm_message_templates_org_idx on crm_message_templates (org_id, kind, channel) where archived_at is null;
create trigger crm_message_templates_touch before update on crm_message_templates for each row execute function app.touch_updated_at();

create table crm_message_template_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  template_id uuid not null,
  version integer not null check (version >= 1),
  subject text check (char_length(subject) <= 200),
  body text not null check (char_length(body) <= 5000),
  -- sha256 of channel, subject and body: what an approval and a workflow send are bound to.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  tokens text[] not null default '{}' check (cardinality(tokens) <= 40),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (template_id, version),
  foreign key (template_id, org_id) references crm_message_templates (id, org_id) on delete cascade
);
create trigger crm_message_template_versions_frozen before update on crm_message_template_versions for each row execute function app.block_update();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table crm_message_templates enable row level security;
alter table crm_message_template_versions enable row level security;
revoke all on crm_message_templates, crm_message_template_versions from public, anon, authenticated, iaq_site_runtime;
grant select on crm_message_templates, crm_message_template_versions to iaq_app_user;
create policy crm_message_templates_select on crm_message_templates for select to iaq_app_user using (app.has_permission(org_id, 'inbox.view') or app.has_permission(org_id, 'templates.manage'));
create policy crm_message_template_versions_select on crm_message_template_versions for select to iaq_app_user using (app.has_permission(org_id, 'inbox.view') or app.has_permission(org_id, 'templates.manage'));
