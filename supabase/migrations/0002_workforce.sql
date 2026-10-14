-- iAcquire Client Portal — AI workforce, onboarding, knowledge, chat, runs, integrations.

-- ---------------------------------------------------------------------------
-- Onboarding and company knowledge
-- ---------------------------------------------------------------------------

create table onboarding_responses (
  org_id uuid primary key references organizations(id) on delete cascade,
  current_step integer not null default 1 check (current_step between 1 and 5),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) <= 65536),
  completed_at timestamptz,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger onboarding_touch before update on onboarding_responses for each row execute function app.touch_updated_at();

create table company_knowledge (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  section text not null check (section in (
    'business_description', 'products_services', 'faq', 'approved_pricing', 'business_hours',
    'policies', 'customer_service', 'brand_voice', 'escalation')),
  content text not null default '' check (char_length(content) <= 12000),
  version integer not null default 1,
  -- Content that looks like an attempt to override AI policy is held for agency review and is
  -- not given to AI employees until cleared.
  risk_flags text[] not null default '{}',
  review_status text not null default 'approved' check (review_status in ('approved', 'pending_agency_review')),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  -- When this content was last included in an applied AI employee configuration.
  applied_at timestamptz,
  unique (org_id, section)
);

create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  filename text not null check (char_length(filename) between 1 and 200),
  mime_type text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text not null unique,
  status text not null default 'uploaded' check (status in ('uploaded', 'ready', 'rejected', 'deleted')),
  extracted_text text check (char_length(extracted_text) <= 200000),
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (org_id, sha256)
);
create index knowledge_documents_org_idx on knowledge_documents (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- AI workforce
-- ---------------------------------------------------------------------------

create table agent_roles (
  key text primary key check (key ~ '^[a-z_]{3,40}$'),
  name text not null,
  short_name text not null,
  tagline text not null,
  description text not null,
  capabilities jsonb not null default '[]'::jsonb,
  default_tools jsonb not null default '[]'::jsonb,
  accent text not null check (accent ~ '^#[0-9a-fA-F]{6}$'),
  sort_order integer not null
);

-- One instance per tenant per role. Hermes connection details are set by the agency only.
create table agent_instances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  role_key text not null references agent_roles(key),
  display_name text not null check (char_length(display_name) between 1 and 60),
  enabled boolean not null default true,
  status text not null default 'setup_required'
    check (status in ('setup_required', 'provisioning', 'online', 'busy', 'offline', 'error', 'disabled')),
  hermes_base_url text check (hermes_base_url ~ '^https?://[^\s]+$'),
  hermes_profile text check (hermes_profile ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  credential_id uuid,
  active_config_version_id uuid,
  last_health_check_at timestamptz,
  last_health_ok boolean,
  last_health_detail text check (char_length(last_health_detail) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, role_key)
);
-- A Hermes profile can only ever back one tenant employee: no shared memory between tenants.
create unique index agent_instances_profile_unique on agent_instances (hermes_base_url, hermes_profile)
  where hermes_profile is not null;
create trigger agent_instances_touch before update on agent_instances for each row execute function app.touch_updated_at();

-- Client tenants may never be routed to the agency's internal Hermes profiles.
create or replace function app.guard_agent_profile() returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  if new.hermes_profile is null then
    return new;
  end if;
  select kind into v_kind from organizations where id = new.org_id;
  if v_kind = 'client' and (
       new.hermes_profile = 'default'
       or new.hermes_profile like 'iacquire-%'
       or new.hermes_profile in ('iacquire-operations-manager', 'iacquire-lead-hunter',
            'iacquire-appointment-setter', 'iacquire-sales-assistant', 'iacquire-crm-manager',
            'iacquire-analyst')) then
    raise exception 'reserved_hermes_profile' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger agent_instances_guard before insert or update on agent_instances
  for each row execute function app.guard_agent_profile();

create table agent_config_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null references agent_instances(id) on delete cascade,
  version integer not null check (version > 0),
  settings jsonb not null,
  summary text not null,
  compiled_instructions text not null,
  policy_version text not null,
  risk_flags text[] not null default '{}',
  source text not null check (source in ('onboarding', 'client_edit', 'change_request', 'rollback', 'agency')),
  change_request text check (char_length(change_request) <= 1000),
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'pending_agency_review', 'applied', 'superseded', 'rejected')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  applied_at timestamptz,
  unique (agent_instance_id, version)
);
create index agent_config_versions_agent_idx on agent_config_versions (agent_instance_id, version desc);

alter table agent_instances
  add constraint agent_instances_active_config_fk
  foreign key (active_config_version_id) references agent_config_versions(id) on delete set null;

create table agent_provisioning_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null references agent_instances(id) on delete cascade,
  kind text not null check (kind in ('provision', 'reconnect', 'deprovision')),
  status text not null default 'requested'
    check (status in ('requested', 'in_progress', 'awaiting_health_check', 'succeeded', 'failed', 'cancelled')),
  detail text check (char_length(detail) <= 1000),
  requested_by uuid references users(id) on delete set null,
  handled_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index provisioning_jobs_open_idx on agent_provisioning_jobs (status, created_at)
  where status in ('requested', 'in_progress', 'awaiting_health_check');
create trigger provisioning_jobs_touch before update on agent_provisioning_jobs for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------

create table chat_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null references agent_instances(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  title text not null default 'New conversation' check (char_length(title) between 1 and 120),
  hermes_session_id text not null unique,
  last_message_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index chat_conversations_list_idx on chat_conversations (org_id, agent_instance_id, user_id, last_message_at desc)
  where deleted_at is null;

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'notice')),
  content text not null default '' check (char_length(content) <= 64000),
  status text not null default 'complete' check (status in ('streaming', 'complete', 'failed', 'cancelled', 'superseded')),
  run_id uuid,
  error_code text,
  client_message_id text check (char_length(client_message_id) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, client_message_id)
);
create index chat_messages_conversation_idx on chat_messages (conversation_id, created_at);
create trigger chat_messages_touch before update on chat_messages for each row execute function app.touch_updated_at();

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null references agent_instances(id) on delete cascade,
  conversation_id uuid references chat_conversations(id) on delete set null,
  assistant_message_id uuid references chat_messages(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  purpose text not null default 'chat' check (purpose in ('chat', 'lead_research', 'health_check')),
  hermes_run_id text,
  idempotency_key text not null unique,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'timeout')),
  config_version_id uuid references agent_config_versions(id) on delete set null,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  error_code text,
  error_message text check (char_length(error_message) <= 500),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index agent_runs_org_idx on agent_runs (org_id, started_at desc);
create index agent_runs_agent_idx on agent_runs (agent_instance_id, started_at desc);

alter table chat_messages
  add constraint chat_messages_run_fk foreign key (run_id) references agent_runs(id) on delete set null;

create table tool_executions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  tool_name text not null check (char_length(tool_name) <= 120),
  label text not null check (char_length(label) <= 120),
  status text not null default 'started' check (status in ('started', 'completed', 'failed')),
  duration_ms integer,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index tool_executions_run_idx on tool_executions (run_id, started_at);

-- ---------------------------------------------------------------------------
-- Integrations (credentials are encrypted at rest and never granted to iaq_app_user)
-- ---------------------------------------------------------------------------

create table integration_credentials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  provider text not null check (provider in ('hermes', 'ghl', 'n8n', 'slack', 'email', 'llm')),
  label text not null check (char_length(label) <= 120),
  ciphertext text not null,
  key_version integer not null default 1,
  fingerprint text not null,
  scopes text[] not null default '{}',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table agent_instances
  add constraint agent_instances_credential_fk
  foreign key (credential_id) references integration_credentials(id) on delete set null;

create table integration_status (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  provider text not null check (provider in ('hermes', 'ghl', 'ghl_calendar', 'n8n', 'slack', 'email', 'llm', 'database')),
  status text not null default 'not_configured'
    check (status in ('not_configured', 'pending', 'connected', 'degraded', 'error', 'disabled')),
  detail text check (char_length(detail) <= 500),
  last_checked_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index integration_status_unique on integration_status (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), provider);

create table ghl_location_mappings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references organizations(id) on delete cascade,
  location_id text not null unique check (location_id ~ '^[A-Za-z0-9]{10,40}$'),
  location_name text check (char_length(location_name) <= 120),
  pipeline_id text check (pipeline_id ~ '^[A-Za-z0-9]{10,40}$'),
  calendar_ids text[] not null default '{}',
  credential_id uuid references integration_credentials(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'connected', 'error', 'disabled')),
  verified_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Aster Homes is a protected, unrelated location and may never be mapped into this portal.
  check (location_id <> 'u69CVh0ZlAofUmRoj1zF')
);

-- The agency's own GHL location can only belong to the agency organization.
create or replace function app.guard_ghl_location() returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  select kind into v_kind from organizations where id = new.org_id;
  if new.location_id = 'SQvVnld5MBHdMQ1qnSfw' and v_kind is distinct from 'agency' then
    raise exception 'agency_location_not_assignable' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger ghl_location_guard before insert or update on ghl_location_mappings
  for each row execute function app.guard_ghl_location();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table onboarding_responses enable row level security;
alter table company_knowledge enable row level security;
alter table knowledge_documents enable row level security;
alter table agent_roles enable row level security;
alter table agent_instances enable row level security;
alter table agent_config_versions enable row level security;
alter table agent_provisioning_jobs enable row level security;
alter table chat_conversations enable row level security;
alter table chat_messages enable row level security;
alter table agent_runs enable row level security;
alter table tool_executions enable row level security;
alter table integration_credentials enable row level security;
alter table integration_status enable row level security;
alter table ghl_location_mappings enable row level security;

grant select, insert, update on onboarding_responses to iaq_app_user;
create policy onboarding_select on onboarding_responses for select to iaq_app_user
  using (app.can_access_org(org_id));
create policy onboarding_insert on onboarding_responses for insert to iaq_app_user
  with check (app.has_permission(org_id, 'workspace.manage_profile'));
create policy onboarding_update on onboarding_responses for update to iaq_app_user
  using (app.has_permission(org_id, 'workspace.manage_profile'))
  with check (app.has_permission(org_id, 'workspace.manage_profile'));

grant select, insert, update on company_knowledge to iaq_app_user;
create policy knowledge_select on company_knowledge for select to iaq_app_user
  using (app.has_permission(org_id, 'knowledge.view'));
create policy knowledge_insert on company_knowledge for insert to iaq_app_user
  with check (app.has_permission(org_id, 'knowledge.edit'));
create policy knowledge_update on company_knowledge for update to iaq_app_user
  using (app.has_permission(org_id, 'knowledge.edit'))
  with check (app.has_permission(org_id, 'knowledge.edit'));

grant select on knowledge_documents to iaq_app_user;
create policy knowledge_documents_select on knowledge_documents for select to iaq_app_user
  using (app.has_permission(org_id, 'knowledge.view') and status <> 'deleted');

grant select on agent_roles to iaq_app_user;
create policy agent_roles_select on agent_roles for select to iaq_app_user using (true);

grant select on agent_instances to iaq_app_user;
create policy agent_instances_select on agent_instances for select to iaq_app_user
  using (app.can_access_org(org_id));

grant select on agent_config_versions to iaq_app_user;
create policy agent_config_versions_select on agent_config_versions for select to iaq_app_user
  using (app.can_access_org(org_id));

grant select on agent_provisioning_jobs to iaq_app_user;
create policy provisioning_select on agent_provisioning_jobs for select to iaq_app_user
  using (app.can_access_org(org_id));

-- Conversations are private to the person who started them.
grant select, insert on chat_conversations to iaq_app_user;
grant update (title, deleted_at) on chat_conversations to iaq_app_user;
create policy conversations_select on chat_conversations for select to iaq_app_user
  using (user_id = app.current_user_id() and app.has_permission(org_id, 'agents.use'));
create policy conversations_insert on chat_conversations for insert to iaq_app_user
  with check (user_id = app.current_user_id() and app.has_permission(org_id, 'agents.use'));
create policy conversations_update on chat_conversations for update to iaq_app_user
  using (user_id = app.current_user_id() and app.has_permission(org_id, 'agents.use'))
  with check (user_id = app.current_user_id() and app.has_permission(org_id, 'agents.use'));

grant select, insert on chat_messages to iaq_app_user;
create policy messages_select on chat_messages for select to iaq_app_user
  using (exists (select 1 from chat_conversations c where c.id = conversation_id and c.org_id = chat_messages.org_id));
create policy messages_insert on chat_messages for insert to iaq_app_user
  with check (role = 'user'
    and exists (select 1 from chat_conversations c
                where c.id = conversation_id and c.org_id = chat_messages.org_id and c.deleted_at is null));

grant select on agent_runs to iaq_app_user;
create policy agent_runs_select on agent_runs for select to iaq_app_user
  using ((user_id = app.current_user_id() and app.can_access_org(org_id))
      or app.has_permission(org_id, 'activity.view'));

grant select on tool_executions to iaq_app_user;
create policy tool_executions_select on tool_executions for select to iaq_app_user
  using (exists (select 1 from agent_runs r where r.id = run_id));

grant select on integration_status to iaq_app_user;
create policy integration_status_select on integration_status for select to iaq_app_user
  using ((org_id is not null and app.has_permission(org_id, 'integrations.view')) or app.is_agency_staff());

grant select (id, org_id, location_name, status, verified_at, created_at) on ghl_location_mappings to iaq_app_user;
create policy ghl_mappings_select on ghl_location_mappings for select to iaq_app_user
  using (app.has_permission(org_id, 'integrations.view'));

-- integration_credentials: no grants for iaq_app_user.
