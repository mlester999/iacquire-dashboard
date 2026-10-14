-- Omnichannel messaging core: contacts, conversations, messages, consent, suppression, follow-ups,
-- human escalations and ownership. GoHighLevel stays the CRM of record; these tables are the portal's
-- tenant-scoped working copy and the audit trail for who may send what to whom.
-- Safety rules that must hold even if application code has a bug are enforced here as constraints.

-- ---------------------------------------------------------------------------
-- Agency safety policy (global) and per-workspace settings
-- ---------------------------------------------------------------------------

create table messaging_policy (
  singleton boolean primary key default true check (singleton),
  max_followups_per_contact_30d integer not null default 6 check (max_followups_per_contact_30d between 0 and 30),
  max_followup_attempts integer not null default 5 check (max_followup_attempts between 0 and 10),
  min_hours_between_followups integer not null default 20 check (min_hours_between_followups >= 1),
  quiet_hours_start time not null default '21:00',
  quiet_hours_end time not null default '08:00',
  whatsapp_window_hours integer not null default 24 check (whatsapp_window_hours between 1 and 72),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into messaging_policy default values;

create table messaging_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- Off until the owner turns it on and the responsible employee passes readiness checks.
  auto_reply_enabled boolean not null default false,
  reply_business_hours_only boolean not null default false,
  business_hours jsonb not null default '{}'::jsonb check (pg_column_size(business_hours) <= 4096),
  followup_preset text not null default 'balanced' check (followup_preset in ('gentle', 'balanced', 'persistent', 'off', 'custom')),
  followup_custom jsonb check (pg_column_size(followup_custom) <= 4096),
  owner_timeout_urgent_seconds integer not null default 120 check (owner_timeout_urgent_seconds between 30 and 3600),
  owner_timeout_normal_seconds integer not null default 300 check (owner_timeout_normal_seconds between 30 and 7200),
  ai_disclosure text not null default 'I''m an AI assistant for {business}.' check (char_length(ai_disclosure) between 5 and 300),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger messaging_settings_touch before update on messaging_settings for each row execute function app.touch_updated_at();

-- A channel can be enabled only once its sender has been verified. The constraint makes "send from an
-- unverified number or domain" impossible regardless of what the interface does.
create table messaging_channels (
  org_id uuid not null references organizations(id) on delete cascade,
  channel text not null check (channel in ('sms', 'whatsapp', 'email')),
  enabled boolean not null default false,
  provider text not null default 'ghl' check (provider = 'ghl'),
  sender_identity text check (char_length(sender_identity) <= 200),
  sender_verified_at timestamptz,
  registration_status text not null default 'not_started' check (registration_status in ('not_required', 'not_started', 'pending', 'approved', 'rejected')),
  last_checked_at timestamptz,
  detail text check (char_length(detail) <= 300),
  updated_at timestamptz not null default now(),
  primary key (org_id, channel),
  check (not enabled or sender_verified_at is not null),
  check (not enabled or channel = 'email' or registration_status in ('not_required', 'approved'))
);
create trigger messaging_channels_touch before update on messaging_channels for each row execute function app.touch_updated_at();

-- Destinations the owner explicitly approved for setup test messages. Customers are never test recipients.
create table approved_test_destinations (
  org_id uuid not null references organizations(id) on delete cascade,
  channel text not null check (channel in ('sms', 'whatsapp', 'email')),
  address text not null check (char_length(address) <= 320),
  label text not null default '' check (char_length(label) <= 80),
  approved_by uuid not null references users(id) on delete cascade,
  approved_at timestamptz not null default now(),
  primary key (org_id, channel, address)
);

-- WhatsApp only allows free-form messages inside the reply window; outside it, only an approved template may be sent.
create table whatsapp_templates (
  org_id uuid not null references organizations(id) on delete cascade,
  template_id text not null check (char_length(template_id) between 1 and 120),
  name text not null check (char_length(name) between 1 and 120),
  language text not null default 'en' check (char_length(language) between 2 and 10),
  body text not null default '' check (char_length(body) <= 1024),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  checked_at timestamptz,
  primary key (org_id, template_id)
);

-- ---------------------------------------------------------------------------
-- Contacts, verified identities, merges, memory
-- ---------------------------------------------------------------------------

create table contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 200),
  email citext check (char_length(email::text) <= 320),
  phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  timezone text check (char_length(timezone) <= 64),
  lifecycle_stage text not null default 'lead_captured' check (lifecycle_stage in (
    'lead_captured', 'validated', 'qualified', 'follow_up', 'appointment', 'human_sales', 'won', 'lost', 'customer', 'retention')),
  temperature text check (temperature in ('hot', 'warm', 'cold')),
  source text not null default 'inbound_message' check (char_length(source) <= 60),
  ghl_contact_id text check (char_length(ghl_contact_id) <= 80),
  assigned_user_id uuid references users(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id)
);
create unique index contacts_ghl_unique on contacts (org_id, ghl_contact_id) where ghl_contact_id is not null and deleted_at is null;
create index contacts_org_idx on contacts (org_id, updated_at desc) where deleted_at is null;
create trigger contacts_touch before update on contacts for each row execute function app.touch_updated_at();

-- A contact is matched only by an exact normalized identifier (E.164 phone or lower-case email), never by name.
create table contact_identities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  kind text not null check (kind in ('phone', 'email')),
  value text not null check (char_length(value) <= 320),
  verified boolean not null default false,
  verified_via text check (verified_via in ('provider_inbound', 'customer_confirmed', 'staff_confirmed', 'crm_import')),
  created_at timestamptz not null default now(),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  unique (org_id, kind, value),
  check (not verified or verified_via is not null)
);
create index contact_identities_contact_idx on contact_identities (contact_id);

create table contact_merges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kept_contact_id uuid not null,
  merged_contact_id uuid not null,
  merged_by uuid references users(id) on delete set null,
  reason text not null check (char_length(reason) between 5 and 500),
  -- What the merged record held, so the merge can be audited and, if needed, reversed by hand.
  snapshot jsonb not null check (pg_column_size(snapshot) <= 16384),
  created_at timestamptz not null default now(),
  foreign key (kept_contact_id, org_id) references contacts (id, org_id),
  foreign key (merged_contact_id, org_id) references contacts (id, org_id),
  check (kept_contact_id <> merged_contact_id)
);

-- Confirmed facts and AI-written summaries are different things and are stored apart.
create table contact_memories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  kind text not null check (kind in ('confirmed_fact', 'ai_summary')),
  content text not null check (char_length(content) between 1 and 1000),
  source_message_id uuid,
  created_by_kind text not null check (created_by_kind in ('human', 'ai', 'system')),
  created_by uuid references users(id) on delete set null,
  confirmed_by uuid references users(id) on delete set null,
  confirmed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  check (kind <> 'confirmed_fact' or (confirmed_by is not null and confirmed_at is not null))
);
create index contact_memories_idx on contact_memories (contact_id, created_at desc) where deleted_at is null;

-- Consent is an append-only history. The latest event per contact, channel and purpose is the current state.
create table contact_consent_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  channel text not null check (channel in ('sms', 'whatsapp', 'email')),
  purpose text not null check (purpose in ('service', 'marketing')),
  status text not null check (status in ('granted', 'revoked')),
  source text not null check (char_length(source) between 1 and 60),
  evidence text check (char_length(evidence) <= 500),
  recorded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade
);
create index consent_latest_idx on contact_consent_events (org_id, contact_id, channel, purpose, id desc);
create trigger consent_events_immutable before update or delete on contact_consent_events for each row execute function app.immutable_row();

-- One row per address that must not be messaged on a channel. Active while lifted_at is null.
create table suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  channel text not null check (channel in ('sms', 'whatsapp', 'email')),
  address text not null check (char_length(address) <= 320),
  reason text not null check (reason in ('opt_out', 'bounce', 'complaint', 'invalid', 'manual')),
  source text not null default 'system' check (char_length(source) <= 60),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid references users(id) on delete set null,
  unique (org_id, channel, address)
);

-- ---------------------------------------------------------------------------
-- Conversations and messages
-- ---------------------------------------------------------------------------

create table conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  channel text not null check (channel in ('sms', 'whatsapp', 'email')),
  thread_key text not null default 'main' check (char_length(thread_key) between 1 and 120),
  ghl_conversation_id text check (char_length(ghl_conversation_id) <= 80),
  status text not null default 'open' check (status in ('open', 'snoozed', 'closed')),
  subject text check (char_length(subject) <= 300),
  ai_agent_id uuid references agent_instances(id) on delete set null,
  owner_kind text not null default 'ai' check (owner_kind in ('ai', 'human', 'unassigned')),
  owner_user_id uuid references users(id) on delete set null,
  -- Bumped on every ownership change; claims compare against it so two people cannot both win.
  ownership_version integer not null default 1,
  assigned_user_id uuid references users(id) on delete set null,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  unread_count integer not null default 0 check (unread_count >= 0),
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_message_at timestamptz,
  last_message_preview text check (char_length(last_message_preview) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  unique (id, org_id),
  unique (org_id, contact_id, channel, thread_key),
  -- A human-owned conversation always names the human; nobody else ever "owns" it implicitly.
  check ((owner_kind = 'human') = (owner_user_id is not null))
);
create index conversations_inbox_idx on conversations (org_id, status, last_message_at desc);
create index conversations_owner_idx on conversations (owner_user_id) where owner_user_id is not null;
create trigger conversations_touch before update on conversations for each row execute function app.touch_updated_at();

create table conversation_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  author_kind text not null check (author_kind in ('contact', 'ai', 'human', 'system')),
  author_user_id uuid references users(id) on delete set null,
  agent_id uuid references agent_instances(id) on delete set null,
  body text not null default '' check (char_length(body) <= 5000),
  attachments jsonb not null default '[]'::jsonb check (pg_column_size(attachments) <= 8192),
  -- Delivery states mirror real provider events. "delivered" is set only by a delivery event,
  -- never because a send request returned successfully.
  status text not null check (status in ('received', 'note', 'draft', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'blocked')),
  status_detail text check (char_length(status_detail) <= 300),
  blocked_reason text check (char_length(blocked_reason) <= 60),
  scope text check (scope in ('reply', 'followup', 'human')),
  template_id text check (char_length(template_id) <= 120),
  provider text check (char_length(provider) <= 40),
  provider_message_id text check (char_length(provider_message_id) <= 160),
  dedupe_key text check (char_length(dedupe_key) <= 200),
  approval_id uuid references approval_requests(id) on delete set null,
  followup_step_id uuid,
  reservation_id uuid references usage_reservations(id) on delete set null,
  send_after timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  created_at timestamptz not null default now(),
  queued_at timestamptz,
  claimed_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete cascade,
  unique (org_id, dedupe_key),
  check (direction <> 'inbound' or (status = 'received' and author_kind = 'contact')),
  check (direction <> 'internal' or (status = 'note' and author_kind in ('human', 'ai', 'system'))),
  check (direction <> 'outbound' or status in ('draft', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'blocked'))
);
create unique index conversation_messages_provider_idx on conversation_messages (provider, provider_message_id) where provider_message_id is not null;
create index conversation_messages_thread_idx on conversation_messages (conversation_id, created_at);
create index conversation_messages_queue_idx on conversation_messages (send_after) where status = 'queued';

create table message_delivery_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  message_id uuid not null references conversation_messages(id) on delete cascade,
  provider text not null check (char_length(provider) <= 40),
  provider_event_id text not null check (char_length(provider_event_id) <= 200),
  status text not null check (status in ('sent', 'delivered', 'read', 'failed', 'undelivered')),
  detail text check (char_length(detail) <= 300),
  occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);
create index message_delivery_events_message_idx on message_delivery_events (message_id, occurred_at);

-- Provider webhook replay ledger: each provider-supplied webhook id is processed at most once.
create table webhook_receipts (
  provider text not null check (char_length(provider) <= 40),
  external_id text not null check (char_length(external_id) <= 200),
  kind text not null default '' check (char_length(kind) <= 80),
  org_id uuid references organizations(id) on delete cascade,
  outcome text not null default 'received' check (outcome in ('received', 'processed', 'ignored', 'rejected')),
  detail text check (char_length(detail) <= 300),
  received_at timestamptz not null default now(),
  primary key (provider, external_id)
);
create index webhook_receipts_received_idx on webhook_receipts (received_at);

-- ---------------------------------------------------------------------------
-- Follow-ups: one active plan per contact, so the allowance is shared by every channel
-- ---------------------------------------------------------------------------

create table follow_up_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  conversation_id uuid not null,
  agent_id uuid references agent_instances(id) on delete set null,
  preset text not null check (preset in ('gentle', 'balanced', 'persistent', 'custom')),
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  cancel_reason text check (char_length(cancel_reason) <= 120),
  max_attempts integer not null check (max_attempts between 1 and 10),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete cascade,
  unique (id, org_id),
  check ((status = 'active') = (closed_at is null))
);
create unique index follow_up_one_active_per_contact on follow_up_plans (org_id, contact_id) where status = 'active';

create table follow_up_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  plan_id uuid not null,
  contact_id uuid not null,
  step_number integer not null check (step_number between 1 and 10),
  channel text not null check (channel in ('sms', 'whatsapp', 'email')),
  due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'queued', 'sent', 'skipped', 'cancelled', 'blocked')),
  reason text check (char_length(reason) <= 200),
  message_id uuid references conversation_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (plan_id, org_id) references follow_up_plans (id, org_id) on delete cascade,
  unique (plan_id, step_number)
);
create index follow_up_steps_due_idx on follow_up_steps (due_at) where status = 'scheduled';
create trigger follow_up_steps_touch before update on follow_up_steps for each row execute function app.touch_updated_at();
alter table conversation_messages add constraint conversation_messages_followup_fk foreign key (followup_step_id) references follow_up_steps(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Human escalations and ownership history
-- ---------------------------------------------------------------------------

create table human_escalations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null,
  contact_id uuid not null,
  category text not null check (category in ('ready_to_close', 'human_requested', 'phone_consultation', 'complaint', 'refund_concern',
    'sensitive_negotiation', 'frustrated_customer', 'unanswered_question', 'unsafe_or_uncertain')),
  urgency text not null check (urgency in ('urgent', 'normal')),
  summary text not null check (char_length(summary) between 1 and 600),
  status text not null default 'awaiting_owner' check (status in ('awaiting_owner', 'open', 'claimed', 'resolved', 'cancelled')),
  owner_user_id uuid references users(id) on delete set null,
  owner_response text not null default 'pending' check (owner_response in ('pending', 'accepted', 'declined', 'away', 'busy', 'timed_out', 'not_applicable')),
  owner_deadline_at timestamptz,
  opened_to_staff_at timestamptz,
  claimed_by uuid references users(id) on delete set null,
  claimed_at timestamptz,
  resolved_by uuid references users(id) on delete set null,
  resolved_at timestamptz,
  resolution text check (char_length(resolution) <= 500),
  source_message_id uuid references conversation_messages(id) on delete set null,
  ai_agent_id uuid references agent_instances(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete cascade,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  unique (id, org_id),
  check (status <> 'claimed' or (claimed_by is not null and claimed_at is not null)),
  check (status <> 'resolved' or resolved_at is not null)
);
-- At most one unresolved escalation per conversation, so repeated detections cannot spam or fork ownership.
create unique index human_escalations_one_open on human_escalations (conversation_id) where status in ('awaiting_owner', 'open', 'claimed');
create index human_escalations_queue_idx on human_escalations (org_id, status, created_at);
create index human_escalations_deadline_idx on human_escalations (owner_deadline_at) where status = 'awaiting_owner';
create trigger human_escalations_touch before update on human_escalations for each row execute function app.touch_updated_at();

create table escalation_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  escalation_id uuid not null references human_escalations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('action_required', 'fyi')),
  notified_at timestamptz not null default now(),
  email_status text not null default 'skipped' check (email_status in ('queued', 'sent', 'skipped', 'failed')),
  -- SMS and WhatsApp staff alerts are opt-in and billed; until a provider path is verified they stay "not_sent".
  optional_alert_status text not null default 'not_requested' check (optional_alert_status in ('not_requested', 'not_sent', 'sent', 'failed')),
  responded_at timestamptz,
  response text check (response in ('accepted', 'declined', 'claimed', 'seen')),
  unique (escalation_id, user_id, kind)
);
create index escalation_recipients_user_idx on escalation_recipients (user_id, notified_at desc);

create table conversation_ownership_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null,
  from_kind text not null check (from_kind in ('ai', 'human', 'unassigned')),
  from_user_id uuid references users(id) on delete set null,
  to_kind text not null check (to_kind in ('ai', 'human', 'unassigned')),
  to_user_id uuid references users(id) on delete set null,
  actor_kind text not null check (actor_kind in ('user', 'ai', 'system', 'agency')),
  actor_user_id uuid references users(id) on delete set null,
  reason text check (char_length(reason) <= 300),
  escalation_id uuid references human_escalations(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete cascade
);
create index ownership_events_conversation_idx on conversation_ownership_events (conversation_id, id);
create trigger ownership_events_immutable before update or delete on conversation_ownership_events for each row execute function app.immutable_row();

-- ---------------------------------------------------------------------------
-- Row level security. People see only conversations they are allowed to work.
-- ---------------------------------------------------------------------------

create or replace function app.can_view_conversation(p_org uuid, p_owner uuid, p_assigned uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.has_permission(p_org, 'inbox.view')
     and (app.has_permission(p_org, 'inbox.view_all') or p_owner = app.current_user_id() or p_assigned = app.current_user_id())
$$;
revoke all on function app.can_view_conversation(uuid, uuid, uuid) from public;
grant execute on function app.can_view_conversation(uuid, uuid, uuid) to iaq_app_user;

alter table messaging_policy enable row level security;
alter table messaging_settings enable row level security;
alter table messaging_channels enable row level security;
alter table approved_test_destinations enable row level security;
alter table whatsapp_templates enable row level security;
alter table contacts enable row level security;
alter table contact_identities enable row level security;
alter table contact_merges enable row level security;
alter table contact_memories enable row level security;
alter table contact_consent_events enable row level security;
alter table suppressions enable row level security;
alter table conversations enable row level security;
alter table conversation_messages enable row level security;
alter table message_delivery_events enable row level security;
alter table webhook_receipts enable row level security;
alter table follow_up_plans enable row level security;
alter table follow_up_steps enable row level security;
alter table human_escalations enable row level security;
alter table escalation_recipients enable row level security;
alter table conversation_ownership_events enable row level security;
revoke all on webhook_receipts from public, anon, authenticated;
revoke all on messaging_policy, messaging_settings, messaging_channels, approved_test_destinations, whatsapp_templates, contacts, contact_identities,
  contact_merges, contact_memories, contact_consent_events, suppressions, conversations, conversation_messages, message_delivery_events,
  follow_up_plans, follow_up_steps, human_escalations, escalation_recipients, conversation_ownership_events from public, anon, authenticated;

-- Everything below is read-only for the application role; trusted server code performs every write after authorizing it.
grant select on messaging_policy, messaging_settings, messaging_channels, approved_test_destinations, whatsapp_templates, contacts, contact_identities,
  contact_merges, contact_memories, contact_consent_events, suppressions, conversations, conversation_messages, message_delivery_events,
  follow_up_plans, follow_up_steps, human_escalations, escalation_recipients, conversation_ownership_events to iaq_app_user;

create policy messaging_policy_select on messaging_policy for select to iaq_app_user using (true);
create policy messaging_settings_select on messaging_settings for select to iaq_app_user using (app.has_permission(org_id, 'inbox.view'));
create policy messaging_channels_select on messaging_channels for select to iaq_app_user using (app.has_permission(org_id, 'inbox.view'));
create policy whatsapp_templates_select on whatsapp_templates for select to iaq_app_user using (app.has_permission(org_id, 'inbox.view'));
create policy test_destinations_select on approved_test_destinations for select to iaq_app_user using (app.has_permission(org_id, 'messaging.configure'));
create policy contacts_select on contacts for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view') and deleted_at is null);
create policy contact_identities_select on contact_identities for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view'));
create policy contact_merges_select on contact_merges for select to iaq_app_user using (app.has_permission(org_id, 'contacts.merge'));
create policy contact_memories_select on contact_memories for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view') and deleted_at is null);
create policy consent_events_select on contact_consent_events for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view'));
create policy suppressions_select on suppressions for select to iaq_app_user using (app.has_permission(org_id, 'consent.manage') or app.has_permission(org_id, 'inbox.view_all'));
create policy conversations_select on conversations for select to iaq_app_user using (app.can_view_conversation(org_id, owner_user_id, assigned_user_id));
create policy conversation_messages_select on conversation_messages for select to iaq_app_user using (
  exists (select 1 from conversations c where c.id = conversation_id and c.org_id = conversation_messages.org_id));
create policy delivery_events_select on message_delivery_events for select to iaq_app_user using (
  exists (select 1 from conversation_messages m where m.id = message_id and m.org_id = message_delivery_events.org_id));
create policy follow_up_plans_select on follow_up_plans for select to iaq_app_user using (app.has_permission(org_id, 'inbox.view_all'));
create policy follow_up_steps_select on follow_up_steps for select to iaq_app_user using (app.has_permission(org_id, 'inbox.view_all'));
create policy escalations_select on human_escalations for select to iaq_app_user using (
  app.has_permission(org_id, 'inbox.view_all')
  or exists (select 1 from escalation_recipients r where r.escalation_id = human_escalations.id and r.user_id = app.current_user_id()));
create policy escalation_recipients_select on escalation_recipients for select to iaq_app_user using (
  user_id = app.current_user_id() or app.has_permission(org_id, 'inbox.view_all'));
create policy ownership_events_select on conversation_ownership_events for select to iaq_app_user using (
  exists (select 1 from conversations c where c.id = conversation_id and c.org_id = conversation_ownership_events.org_id));
