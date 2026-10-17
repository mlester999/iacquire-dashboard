-- Durable, agency-shared Hermes setup drafts and per-administrator navigation.
-- Draft/history JSON contains configuration only; secret material remains in Vault.

alter table hermes_gateways add column updated_by uuid references users(id) on delete set null;

create table hermes_gateway_configuration_history (
  id uuid primary key default gen_random_uuid(),
  gateway_id uuid not null references hermes_gateways(id) on delete cascade,
  revision integer not null check (revision > 0),
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  changed_by uuid references users(id) on delete set null,
  changed_at timestamptz not null default now(),
  unique (gateway_id, revision),
  check (not (configuration ?| array['secret','accessClientId','accessClientSecret']))
);
create index hermes_gateway_configuration_history_recent
  on hermes_gateway_configuration_history(gateway_id, changed_at desc);

-- Start an honest history at the schema migration point without inferring old editors.
insert into hermes_gateway_configuration_history(gateway_id,revision,configuration,changed_by,changed_at)
select id,revision,jsonb_build_object(
  'label',label,'environment',environment,'baseUrl',base_url,'gatewayType',gateway_type,
  'reportedGatewayId',reported_gateway_id,'declaredVersion',declared_version,
  'accessConfigured',access_credential_id is not null
),updated_by,updated_at
from hermes_gateways;

create table hermes_gateway_setup_drafts (
  organization_id uuid not null references organizations(id) on delete cascade,
  gateway_id uuid references hermes_gateways(id) on delete cascade,
  revision integer not null default 1 check (revision > 0),
  base_gateway_revision integer check (base_gateway_revision is null or base_gateway_revision > 0),
  draft_config jsonb not null check (jsonb_typeof(draft_config) = 'object'),
  modified_by uuid not null references users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  check (not (draft_config ?| array['secret','accessClientId','accessClientSecret']))
);
create unique index hermes_gateway_setup_drafts_new_gateway
  on hermes_gateway_setup_drafts(organization_id) where gateway_id is null;
create unique index hermes_gateway_setup_drafts_existing_gateway
  on hermes_gateway_setup_drafts(organization_id, gateway_id) where gateway_id is not null;

create table hermes_gateway_setup_draft_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  gateway_id uuid references hermes_gateways(id) on delete cascade,
  revision integer not null check (revision > 0),
  draft_config jsonb not null check (jsonb_typeof(draft_config) = 'object'),
  changed_by uuid references users(id) on delete set null,
  changed_at timestamptz not null default now(),
  check (not (draft_config ?| array['secret','accessClientId','accessClientSecret']))
);
create unique index hermes_gateway_setup_draft_history_new_gateway
  on hermes_gateway_setup_draft_history(organization_id, revision) where gateway_id is null;
create unique index hermes_gateway_setup_draft_history_existing_gateway
  on hermes_gateway_setup_draft_history(organization_id, gateway_id, revision) where gateway_id is not null;

create table hermes_gateway_setup_progress (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  gateway_id uuid references hermes_gateways(id) on delete cascade,
  step_index smallint not null default 0 check (step_index between 0 and 5),
  updated_at timestamptz not null default now()
);
create unique index hermes_gateway_setup_progress_new_gateway
  on hermes_gateway_setup_progress(organization_id, user_id) where gateway_id is null;
create unique index hermes_gateway_setup_progress_existing_gateway
  on hermes_gateway_setup_progress(organization_id, user_id, gateway_id) where gateway_id is not null;

alter table hermes_gateway_configuration_history enable row level security;
alter table hermes_gateway_setup_drafts enable row level security;
alter table hermes_gateway_setup_draft_history enable row level security;
alter table hermes_gateway_setup_progress enable row level security;
revoke all on hermes_gateway_configuration_history, hermes_gateway_setup_drafts,
  hermes_gateway_setup_draft_history, hermes_gateway_setup_progress
  from public, anon, authenticated, iaq_app_user;
