-- iAcquire Native CRM, growth and operations (phase 5): native forms and lead capture, consent-gated campaigns, review requests and customer
-- feedback, call activity from voice providers, saved report definitions, and workspace configuration values.
--
--   * Forms: a definition with immutable published versions (questions, conditional logic, field mapping, consent wording, hidden attribution
--     fields, what a submission does). Submissions keep the exact version and consent wording answered. Website Studio and hosted form pages
--     both submit here; the public website runtime submits through one SECURITY DEFINER function, as it already does for its built-in form.
--   * Campaigns: a segment (Smart List) and an approved message template version, sent only to recipients who pass consent and suppression at
--     send time, with an estimate from published rates, an owner approval and a rate limit. Recipients are recorded one by one.
--   * Reviews: approved review destinations, review requests per customer, and feedback intake. Everyone who is asked gets the same public
--     review link: feedback never gates who may leave a public review.
--   * Calls: call records from the voice provider's own events (Vapi, Retell), matched to contacts by exact phone number.
--   * Reports: saved report definitions computed from native data only. Configuration values: workspace values used in templates.
--
-- As elsewhere, the application role only reads (row-level security) and trusted server code writes after authorizing the action.
-- Rollback: supabase/rollbacks/0033_crm_growth.down.sql.

-- ---------------------------------------------------------------------------
-- Configuration values
-- ---------------------------------------------------------------------------

create table crm_custom_values (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  type text not null default 'text' check (type in ('text', 'url', 'phone', 'email', 'number', 'color')),
  value text not null default '' check (char_length(value) <= 2000),
  group_name text check (char_length(group_name) <= 60),
  -- This business must fill it in before templates that use it can be sent.
  required boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key),
  unique (id, org_id)
);
create trigger crm_custom_values_touch before update on crm_custom_values for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Forms
-- ---------------------------------------------------------------------------

create table crm_forms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  kind text not null default 'form' check (kind in ('form', 'survey')),
  purpose text not null default 'contact' check (purpose in ('contact', 'consultation', 'qualification', 'quote', 'appointment_request', 'newsletter', 'inquiry', 'survey')),
  folder_id uuid,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  draft jsonb not null default '{}'::jsonb check (jsonb_typeof(draft) = 'object' and pg_column_size(draft) <= 131072),
  draft_revision integer not null default 1 check (draft_revision >= 1),
  published_version_id uuid,
  -- A hosted form page at /f/<org>/<key> (in addition to Website Studio).
  hosted boolean not null default false,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, org_id),
  foreign key (folder_id, org_id) references crm_folders (id, org_id) on delete set null (folder_id),
  check ((status = 'archived') = (archived_at is not null)),
  check (status <> 'published' or published_version_id is not null)
);
create unique index crm_forms_key on crm_forms (org_id, key) where archived_at is null;
create trigger crm_forms_touch before update on crm_forms for each row execute function app.touch_updated_at();

create table crm_form_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  form_id uuid not null,
  version integer not null check (version >= 1),
  -- Questions with types, validation, options, conditional visibility and where each answer is saved; hidden attribution fields.
  fields jsonb not null check (jsonb_typeof(fields) = 'array' and pg_column_size(fields) <= 131072),
  -- What a submission does: tags, opportunity (pipeline/stage/name template), assignment rule, notification, redirect or thank-you text.
  actions jsonb not null default '{}'::jsonb check (jsonb_typeof(actions) = 'object' and pg_column_size(actions) <= 16384),
  -- The exact consent wording shown, stored per version so every submission records what the person agreed to.
  consent jsonb not null default '{}'::jsonb check (jsonb_typeof(consent) = 'object' and pg_column_size(consent) <= 8192),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 8192),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  published_by uuid references users(id) on delete set null,
  published_at timestamptz not null default now(),
  unique (form_id, version),
  unique (id, org_id),
  foreign key (form_id, org_id) references crm_forms (id, org_id) on delete cascade
);
create trigger crm_form_versions_frozen before update on crm_form_versions for each row execute function app.block_update();
alter table crm_forms add constraint crm_forms_published_fk foreign key (published_version_id, org_id) references crm_form_versions (id, org_id);

create table crm_form_submissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  form_id uuid not null,
  version_id uuid not null,
  source text not null check (source in ('website', 'hosted', 'api', 'import')),
  website_id uuid references websites(id) on delete set null,
  host text check (char_length(host) <= 253),
  page_slug text check (char_length(page_slug) <= 200),
  -- Answers by question key, after validation against the version.
  answers jsonb not null check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 32768),
  -- Hidden attribution values that were actually present (UTM, referrer, landing page). Never inferred.
  attribution jsonb not null default '{}'::jsonb check (jsonb_typeof(attribution) = 'object' and pg_column_size(attribution) <= 4096),
  consent_text text check (char_length(consent_text) <= 600),
  marketing_opt_in boolean not null default false,
  marketing_text text check (char_length(marketing_text) <= 600),
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  dedupe_key text not null check (char_length(dedupe_key) between 8 and 200),
  status text not null default 'received' check (status in ('received', 'processed', 'failed', 'spam')),
  -- A person on the team decided it isn't spam: processing honours that and never sets it aside as spam again by itself.
  spam_cleared boolean not null default false,
  attempts integer not null default 0 check (attempts between 0 and 10),
  error text check (char_length(error) <= 500),
  contact_id uuid,
  opportunity_id uuid,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (org_id, dedupe_key),
  unique (id, org_id),
  foreign key (form_id, org_id) references crm_forms (id, org_id) on delete cascade,
  foreign key (version_id, org_id) references crm_form_versions (id, org_id) on delete cascade,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id),
  foreign key (opportunity_id, org_id) references crm_opportunities (id, org_id) on delete set null (opportunity_id)
);
create index crm_form_submissions_queue_idx on crm_form_submissions (created_at) where status = 'received';
create index crm_form_submissions_form_idx on crm_form_submissions (org_id, form_id, created_at desc);

-- The public website runtime submits a native form through this function only: it resolves the live site from the host, finds the published
-- form by key in that site's workspace, and stores the submission for the scheduler to process. It never reads anything back.
-- p_version_id is the version the runtime checked the answers against: it is stored when it is a version of that form (so a republish
-- between loading the page and storing the answers can't pair them with other questions), and anything else is refused.
create or replace function app.submit_crm_form(
  p_host text, p_form_key text, p_page text, p_answers jsonb, p_attribution jsonb, p_consent_text text, p_marketing boolean,
  p_marketing_text text, p_ip_hash text, p_dedupe text, p_version_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_site record; v_form record; v_id uuid; v_version uuid;
begin
  -- The same live-site resolution the built-in site form uses.
  select s.org_id, s.website_id into v_site from app.site_by_host(p_host) s limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_site');
  end if;
  select f.id, f.published_version_id into v_form from crm_forms f
  where f.org_id = v_site.org_id and f.key = p_form_key and f.status = 'published' and f.archived_at is null;
  if v_form.id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_form');
  end if;
  v_version := v_form.published_version_id;
  if p_version_id is not null then
    select v.id into v_version from crm_form_versions v where v.id = p_version_id and v.form_id = v_form.id and v.org_id = v_site.org_id;
    if v_version is null then
      return jsonb_build_object('ok', false, 'reason', 'unknown_version');
    end if;
  end if;
  insert into crm_form_submissions (org_id, form_id, version_id, source, website_id, host, page_slug, answers, attribution, consent_text, marketing_opt_in, marketing_text, ip_hash, dedupe_key)
  values (v_site.org_id, v_form.id, v_version, 'website', v_site.website_id, lower(p_host), left(p_page, 200), p_answers, coalesce(p_attribution, '{}'::jsonb),
          left(p_consent_text, 600), coalesce(p_marketing, false), left(p_marketing_text, 600), p_ip_hash, p_dedupe)
  on conflict (org_id, dedupe_key) do nothing
  returning id into v_id;
  return jsonb_build_object('ok', true, 'duplicate', v_id is null);
end
$$;
revoke all on function app.submit_crm_form(text, text, text, jsonb, jsonb, text, boolean, text, text, text, uuid) from public;
grant execute on function app.submit_crm_form(text, text, text, jsonb, jsonb, text, boolean, text, text, text, uuid) to iaq_site_runtime;

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------

create table crm_campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  channel text not null check (channel in ('email', 'sms', 'whatsapp')),
  -- The audience is a Smart List evaluated when sending starts; only people who pass consent and suppression then are recipients.
  smart_list_id uuid,
  template_id uuid,
  template_version integer check (template_version >= 1),
  status text not null default 'draft' check (status in ('draft', 'awaiting_approval', 'scheduled', 'sending', 'paused', 'completed', 'cancelled')),
  scheduled_at timestamptz,
  -- Messages per minute this campaign may queue; the provider's own limits still apply.
  rate_per_minute integer not null default 30 check (rate_per_minute between 1 and 600),
  estimate jsonb not null default '{}'::jsonb check (jsonb_typeof(estimate) = 'object' and pg_column_size(estimate) <= 4096),
  approval_id uuid references approval_requests(id) on delete set null,
  approved_hash text check (approved_hash ~ '^[0-9a-f]{64}$'),
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 4096),
  folder_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_by uuid references users(id) on delete set null,
  unique (id, org_id),
  foreign key (smart_list_id, org_id) references crm_smart_lists (id, org_id) on delete set null (smart_list_id),
  foreign key (template_id, org_id) references crm_message_templates (id, org_id) on delete set null (template_id),
  foreign key (folder_id, org_id) references crm_folders (id, org_id) on delete set null (folder_id),
  check (status in ('draft', 'cancelled') or (smart_list_id is not null and template_id is not null and template_version is not null)),
  check (status not in ('scheduled', 'sending', 'completed') or approved_hash is not null)
);
create index crm_campaigns_due_idx on crm_campaigns (scheduled_at) where status in ('scheduled', 'sending');
create trigger crm_campaigns_touch before update on crm_campaigns for each row execute function app.touch_updated_at();

create table crm_campaign_recipients (
  org_id uuid not null,
  campaign_id uuid not null,
  contact_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'excluded', 'queued', 'sent', 'delivered', 'failed', 'bounced', 'unsubscribed')),
  -- Why someone was left out: no marketing consent, suppressed, no address, quiet hours exhausted, duplicate…
  reason text check (char_length(reason) <= 120),
  message_id uuid,
  queued_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (campaign_id, contact_id),
  foreign key (campaign_id, org_id) references crm_campaigns (id, org_id) on delete cascade,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade
);
create index crm_campaign_recipients_status_idx on crm_campaign_recipients (campaign_id, status);

-- ---------------------------------------------------------------------------
-- Reviews and feedback
-- ---------------------------------------------------------------------------

-- Where customers are sent to leave a public review. Approved by the business; links are https only.
create table crm_review_destinations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  platform text not null check (platform in ('google', 'facebook', 'yelp', 'tripadvisor', 'trustpilot', 'other')),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  url text not null check (url ~ '^https://' and char_length(url) <= 500),
  active boolean not null default true,
  position integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id)
);

create table crm_review_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  channel text not null check (channel in ('email', 'sms', 'whatsapp')),
  template_id uuid,
  -- sha256 of the token in the customer's link (/r/<token>). The token itself is never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'queued', 'sent', 'opened', 'feedback_received', 'review_link_clicked', 'failed', 'cancelled')),
  message_id uuid,
  appointment_id uuid,
  opportunity_id uuid,
  requested_by uuid references users(id) on delete set null,
  requested_via text not null default 'manual' check (requested_via in ('manual', 'workflow', 'api')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  expires_at timestamptz not null,
  unique (id, org_id),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  foreign key (template_id, org_id) references crm_message_templates (id, org_id) on delete set null (template_id)
);
create index crm_review_requests_org_idx on crm_review_requests (org_id, created_at desc);
create index crm_review_requests_contact_idx on crm_review_requests (org_id, contact_id, created_at desc);

-- Private feedback a customer chose to send the business. Kept separate from public reviews (which live on the review platforms).
alter table customer_feedback
  add column contact_id uuid,
  add column review_request_id uuid,
  add column source text not null default 'manual' check (source in ('manual', 'review_request', 'survey', 'import')),
  add column follow_up_status text not null default 'new' check (follow_up_status in ('new', 'acknowledged', 'escalated', 'resolved')),
  add column escalated_task_id uuid;
alter table customer_feedback add constraint customer_feedback_id_org unique (id, org_id);
alter table customer_feedback add constraint customer_feedback_contact_fk foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id);
alter table customer_feedback add constraint customer_feedback_request_fk foreign key (review_request_id, org_id) references crm_review_requests (id, org_id) on delete set null (review_request_id);

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------

create table crm_call_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('vapi', 'retell', 'manual')),
  provider_call_id text check (char_length(provider_call_id) between 1 and 200),
  direction text not null check (direction in ('inbound', 'outbound')),
  status text not null check (status in ('ringing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'voicemail', 'cancelled')),
  from_number text check (from_number ~ '^\+[1-9][0-9]{6,14}$'),
  to_number text check (to_number ~ '^\+[1-9][0-9]{6,14}$'),
  contact_id uuid,
  owner_user_id uuid references users(id) on delete set null,
  agent_instance_id uuid references agent_instances(id) on delete set null,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds between 0 and 86400),
  disposition text check (char_length(disposition) <= 60),
  summary text check (char_length(summary) <= 4000),
  notes text check (char_length(notes) <= 4000),
  -- References only, and only where the call was lawfully recorded and the workspace keeps recordings (see recording_consent).
  recording_ref text check (char_length(recording_ref) <= 500),
  transcript_ref text check (char_length(transcript_ref) <= 500),
  recording_consent text not null default 'unknown' check (recording_consent in ('unknown', 'announced', 'granted', 'not_recorded')),
  appointment_id uuid,
  opportunity_id uuid,
  follow_up_task_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id),
  foreign key (opportunity_id, org_id) references crm_opportunities (id, org_id) on delete set null (opportunity_id),
  check (ended_at is null or started_at is null or ended_at >= started_at)
);
create unique index crm_call_records_provider_idx on crm_call_records (provider, provider_call_id) where provider_call_id is not null;
create index crm_call_records_org_idx on crm_call_records (org_id, started_at desc);
create index crm_call_records_contact_idx on crm_call_records (org_id, contact_id, started_at desc) where contact_id is not null;
create trigger crm_call_records_touch before update on crm_call_records for each row execute function app.touch_updated_at();

-- A workspace's voice provider connection: which assistant/agent ids belong to it, so a provider webhook finds its tenant.
create table crm_voice_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('vapi', 'retell')),
  -- The provider's assistant/agent id(s) or phone number id(s) that identify this workspace's calls.
  external_ids text[] not null check (cardinality(external_ids) between 1 and 20),
  credential_id uuid references integration_credentials(id) on delete set null,
  store_recordings boolean not null default false,
  status text not null default 'credentials_saved' check (status in ('credentials_saved', 'connected', 'error', 'disconnected')),
  last_event_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider)
);
create trigger crm_voice_connections_touch before update on crm_voice_connections for each row execute function app.touch_updated_at();

alter table integration_credentials drop constraint integration_credentials_provider_check;
alter table integration_credentials add constraint integration_credentials_provider_check
  check (provider in ('hermes', 'ghl', 'n8n', 'slack', 'email', 'llm', 'resend', 'twilio', 'meta_whatsapp', 'vapi', 'retell'));
alter table credential_references drop constraint credential_references_provider_check;
alter table credential_references add constraint credential_references_provider_check
  check (provider in ('hermes', 'ghl', 'n8n', 'llm', 'email', 'google_calendar', 'domain', 'external', 'resend', 'twilio', 'meta_whatsapp', 'vapi', 'retell'));

-- ---------------------------------------------------------------------------
-- Report definitions
-- ---------------------------------------------------------------------------

create table crm_report_definitions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (char_length(description) <= 300),
  folder_id uuid,
  -- Which built-in report and its saved filters (date range, team member, source, pipeline, campaign, channel).
  report text not null check (char_length(report) between 1 and 60),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 16384),
  visibility text not null default 'team' check (visibility in ('private', 'team')),
  owner_user_id uuid references users(id) on delete set null,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, org_id),
  foreign key (folder_id, org_id) references crm_folders (id, org_id) on delete set null (folder_id)
);
create unique index crm_report_definitions_key on crm_report_definitions (org_id, key) where archived_at is null;
create trigger crm_report_definitions_touch before update on crm_report_definitions for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table crm_custom_values enable row level security;
alter table crm_forms enable row level security;
alter table crm_form_versions enable row level security;
alter table crm_form_submissions enable row level security;
alter table crm_campaigns enable row level security;
alter table crm_campaign_recipients enable row level security;
alter table crm_review_destinations enable row level security;
alter table crm_review_requests enable row level security;
alter table crm_call_records enable row level security;
alter table crm_voice_connections enable row level security;
alter table crm_report_definitions enable row level security;
revoke all on crm_custom_values, crm_forms, crm_form_versions, crm_form_submissions, crm_campaigns, crm_campaign_recipients, crm_review_destinations,
  crm_review_requests, crm_call_records, crm_voice_connections, crm_report_definitions from public, anon, authenticated, iaq_site_runtime;
grant select on crm_custom_values, crm_forms, crm_form_versions, crm_form_submissions, crm_campaigns, crm_campaign_recipients, crm_review_destinations,
  crm_call_records, crm_voice_connections, crm_report_definitions to iaq_app_user;
-- Review request token hashes are never readable by the application role.
grant select (id, org_id, contact_id, channel, template_id, status, message_id, appointment_id, opportunity_id, requested_by, requested_via, created_at, sent_at, opened_at, clicked_at, expires_at)
  on crm_review_requests to iaq_app_user;

create policy crm_custom_values_select on crm_custom_values for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_forms_select on crm_forms for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_form_versions_select on crm_form_versions for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_form_submissions_select on crm_form_submissions for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view'));
create policy crm_campaigns_select on crm_campaigns for select to iaq_app_user using (app.has_permission(org_id, 'campaigns.manage'));
create policy crm_campaign_recipients_select on crm_campaign_recipients for select to iaq_app_user using (app.has_permission(org_id, 'campaigns.manage'));
create policy crm_review_destinations_select on crm_review_destinations for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_review_requests_select on crm_review_requests for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view'));
create policy crm_call_records_select on crm_call_records for select to iaq_app_user using (app.has_permission(org_id, 'calls.view'));
create policy crm_voice_connections_select on crm_voice_connections for select to iaq_app_user using (app.has_permission(org_id, 'calls.view'));
create policy crm_report_definitions_select on crm_report_definitions for select to iaq_app_user using (
  app.has_permission(org_id, 'analytics.view') and (visibility = 'team' or owner_user_id = app.current_user_id()));
