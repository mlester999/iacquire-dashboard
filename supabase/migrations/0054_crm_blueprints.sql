-- iAcquire CRM Blueprints (Snapshots): reusable CRM configuration packages that the agency builds once and applies to client workspaces.
--
-- What this adds:
--   * An agency library (no org_id, read only by trusted server code, no grants to the application role at all): Blueprints with a working
--     draft and frozen published versions, library folders, GoHighLevel template sub-accounts used as read-only import sources, and the
--     import history with its compatibility reports. GoHighLevel IDs live only in the import record, never in a Blueprint.
--   * Per client: every application of a Blueprint (what was planned and done, item by item, with the record as it was before each change so
--     it can be rolled back), and a link from each Blueprint asset to the workspace record it became, so applying again never duplicates
--     anything and an update can tell an untouched record from one the client customized.
--   * Draft calendars: a calendar created from a Blueprint takes no bookings (no booking page, never the default, skipped by every booking
--     path) until its hosts, working hours, time zones, appointment types, provider connections and a real open time are verified in that
--     workspace and someone activates it. Every existing calendar stays active.
--
-- The native definitions a Blueprint fills (configuration values, forms, message templates, workflows, report definitions) already exist
-- (0031 to 0033). As elsewhere in the CRM, the application role only reads its own workspace's rows (row-level security) and trusted server
-- code writes after authorizing the action. Rollback: supabase/rollbacks/0054_crm_blueprints.down.sql.

-- ---------------------------------------------------------------------------
-- Permissions. Generated from src/lib/permissions.ts (tests/workforce-config.test.ts compares the two).
-- Anyone on the agency team can browse the library and design drafts; publishing a version and applying one to a client are for super
-- admins. No row-level security policy uses the crm.blueprints.* keys: the library has no grants to the application role.
-- ---------------------------------------------------------------------------

insert into role_permissions (role, permission) values
  ('agency_staff', 'crm.blueprints.view'), ('agency_manager', 'crm.blueprints.view'), ('agency_super_admin', 'crm.blueprints.view'),
  ('agency_staff', 'crm.blueprints.design'), ('agency_manager', 'crm.blueprints.design'), ('agency_super_admin', 'crm.blueprints.design'),
  ('agency_super_admin', 'crm.blueprints.publish'),
  ('agency_super_admin', 'crm.blueprints.apply')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Agency library
-- ---------------------------------------------------------------------------

create table crm_blueprint_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  position integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index crm_blueprint_folders_name on crm_blueprint_folders (lower(name));

create table crm_blueprints (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 1000),
  industry text not null check (industry in (
    'real_estate', 'restaurants', 'home_services', 'consulting', 'healthcare_wellness', 'automotive', 'beauty_salons',
    'professional_services', 'education_coaching', 'general_services', 'other')),
  folder_id uuid references crm_blueprint_folders(id) on delete set null,
  -- Where it came from, shown on every card: built natively, an iAcquire starter, converted from GoHighLevel, or an imported package file.
  source_kind text not null check (source_kind in ('native', 'starter', 'ghl_import', 'file_import')),
  source_label text check (char_length(source_label) <= 200),
  -- The client workspace it was captured from, if any. Named source_org_id because the Blueprint does not belong to that client.
  source_org_id uuid references organizations(id) on delete set null,
  starter_key text check (starter_key ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  -- draft: never published. published: at least one published version (the working draft may have unpublished edits). archived: retired.
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  featured boolean not null default false,
  -- The working copy. Publishing freezes it into crm_blueprint_versions; applying always uses a published version.
  draft_package jsonb not null check (jsonb_typeof(draft_package) = 'object' and pg_column_size(draft_package) <= 1500000),
  -- Bumped on every save, so two people editing the same draft can't overwrite each other unknowingly.
  draft_revision integer not null default 1 check (draft_revision >= 1),
  draft_updated_by uuid references users(id) on delete set null,
  draft_updated_at timestamptz not null default now(),
  current_version integer check (current_version >= 1),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check ((status = 'archived') = (archived_at is not null)),
  check (status <> 'published' or current_version is not null),
  check (source_kind <> 'starter' or starter_key is not null)
);
create unique index crm_blueprints_starter on crm_blueprints (starter_key) where starter_key is not null;
create index crm_blueprints_library_idx on crm_blueprints (status, industry, updated_at desc);
create trigger crm_blueprints_touch before update on crm_blueprints for each row execute function app.touch_updated_at();

-- A published version never changes: what a client was given stays readable exactly as it was.
create table crm_blueprint_versions (
  id uuid primary key default gen_random_uuid(),
  blueprint_id uuid not null references crm_blueprints(id) on delete restrict,
  version integer not null check (version >= 1),
  schema_version integer not null check (schema_version >= 1),
  package jsonb not null check (jsonb_typeof(package) = 'object' and pg_column_size(package) <= 1500000),
  -- sha256 of the canonical package content. Exports carry it; imports and applications check it.
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  change_summary text not null default '' check (char_length(change_summary) <= 2000),
  changes jsonb not null default '[]'::jsonb check (jsonb_typeof(changes) = 'array' and pg_column_size(changes) <= 131072),
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 4096),
  published_by uuid references users(id) on delete set null,
  published_at timestamptz not null default now(),
  unique (blueprint_id, version),
  unique (id, blueprint_id)
);
create trigger crm_blueprint_versions_frozen before update on crm_blueprint_versions for each row execute function app.block_update();

-- A GoHighLevel sub-account the agency keeps for building snapshots (the snapshot is installed there), connected read-only with a private
-- integration token stored as an agency credential, so its configuration can be imported. It is never a client's location and never one of
-- the protected locations (Aster Homes, and the agency's own location, which is not a tenant).
create table crm_blueprint_ghl_sources (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 120),
  location_id text not null unique check (location_id ~ '^[A-Za-z0-9]{10,40}$' and location_id not in ('u69CVh0ZlAofUmRoj1zF', 'SQvVnld5MBHdMQ1qnSfw')),
  credential_id uuid references integration_credentials(id) on delete set null,
  scopes text[] not null default '{}' check (cardinality(scopes) <= 30),
  status text not null default 'credentials_saved' check (status in ('credentials_saved', 'connected', 'permission_limited', 'error', 'disconnected')),
  location_name text check (char_length(location_name) <= 200),
  timezone text check (char_length(timezone) <= 64),
  verified_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger crm_blueprint_ghl_sources_touch before update on crm_blueprint_ghl_sources for each row execute function app.touch_updated_at();

-- A template sub-account must not also be a client's own location (importing from it is agency work, not access to a client's account), and
-- its token must be an agency GoHighLevel credential, never one that belongs to a client workspace.
create or replace function app.guard_blueprint_ghl_source() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from ghl_location_mappings g where g.location_id = new.location_id) then
    raise exception 'blueprint_source_is_client_location' using errcode = 'check_violation';
  end if;
  if new.credential_id is not null and not exists (
    select 1 from integration_credentials c where c.id = new.credential_id and c.provider = 'ghl' and c.org_id is null and c.revoked_at is null
  ) then
    raise exception 'blueprint_source_credential_invalid' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger crm_blueprint_ghl_sources_guard before insert or update of location_id, credential_id on crm_blueprint_ghl_sources
  for each row execute function app.guard_blueprint_ghl_source();

-- And the other way round: a location already kept as a Blueprint source can't then be mapped to a client.
create or replace function app.guard_location_not_blueprint_source() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from crm_blueprint_ghl_sources s where s.location_id = new.location_id) then
    raise exception 'location_is_blueprint_source' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger ghl_location_mappings_not_blueprint_source before insert or update of location_id on ghl_location_mappings
  for each row execute function app.guard_location_not_blueprint_source();

-- Every import, kept as history: what was read, how each item converted, and the proposed package. Nothing is ever written to the source.
create table crm_blueprint_imports (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('ghl_client', 'ghl_agency_source', 'package_file')),
  source_org_id uuid references organizations(id) on delete set null,
  ghl_source_id uuid references crm_blueprint_ghl_sources(id) on delete set null,
  source_label text not null check (char_length(btrim(source_label)) between 1 and 200),
  status text not null default 'previewed' check (status in ('previewed', 'saved', 'discarded', 'failed')),
  report jsonb not null default '{}'::jsonb check (jsonb_typeof(report) = 'object' and pg_column_size(report) <= 1500000),
  package jsonb check (package is null or (jsonb_typeof(package) = 'object' and pg_column_size(package) <= 1500000)),
  -- Which source item became which logical ID ({ "tag.vip": { "kind": "tag", "externalId": "…" } }). Provenance only, never applied.
  source_refs jsonb not null default '{}'::jsonb check (jsonb_typeof(source_refs) = 'object' and pg_column_size(source_refs) <= 262144),
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 4096),
  error text check (char_length(error) <= 500),
  blueprint_id uuid references crm_blueprints(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  saved_at timestamptz,
  check ((status = 'saved') = (saved_at is not null)),
  check (status <> 'saved' or blueprint_id is not null),
  check (source_kind <> 'ghl_client' or source_org_id is not null),
  check (source_kind <> 'ghl_agency_source' or ghl_source_id is not null or status in ('failed', 'discarded'))
);
create index crm_blueprint_imports_idx on crm_blueprint_imports (created_at desc);

-- ---------------------------------------------------------------------------
-- Draft calendars
-- ---------------------------------------------------------------------------

alter table crm_calendars
  add column status text not null default 'active' check (status in ('draft', 'active')),
  add column verified_at timestamptz,
  -- The checks run when it was activated: hosts, working hours, time zones, appointment types, provider connections, an open time.
  add column verification jsonb not null default '{}'::jsonb check (jsonb_typeof(verification) = 'object' and pg_column_size(verification) <= 8192),
  add column folder_id uuid,
  -- The time zone and weekly hours a Blueprint suggests ([{ "weekday": 0-6, "startMinute": 0-1439, "endMinute": 1-1440 }], Sunday = 0).
  -- They are only ever copied to a host who has no weekly hours yet, when someone assigns that host and chooses to use them.
  add column timezone text check (char_length(timezone) between 1 and 64),
  add column hours_template jsonb not null default '[]'::jsonb check (jsonb_typeof(hours_template) = 'array' and pg_column_size(hours_template) <= 8192),
  add column origin text not null default 'manual' check (origin in ('manual', 'blueprint', 'ghl_import'));
-- A draft takes no bookings: no public booking page, and never the calendar the booking flow falls back to.
alter table crm_calendars add constraint crm_calendars_draft_hidden check (status = 'active' or (not public and not is_default));
alter table crm_calendars add constraint crm_calendars_folder_fk foreign key (folder_id, org_id) references crm_folders (id, org_id) on delete set null (folder_id);

-- ---------------------------------------------------------------------------
-- Applying Blueprints to a workspace
-- ---------------------------------------------------------------------------

create table crm_blueprint_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  blueprint_id uuid not null references crm_blueprints(id) on delete restrict,
  version_id uuid not null,
  version integer not null check (version >= 1),
  -- The name when it was applied, so the client sees what was applied without reading the agency library.
  blueprint_name text not null check (char_length(btrim(blueprint_name)) between 1 and 80),
  mode text not null check (mode in ('initial', 'update')),
  strategy text not null check (strategy in ('add_missing', 'update_compatible')),
  sections text[] not null default '{}' check (cardinality(sections) <= 20),
  status text not null check (status in ('applied', 'partially_applied', 'failed', 'rolled_back', 'partially_rolled_back')),
  -- The digest of the plan that was previewed and confirmed. Applying refuses when the workspace changed since the preview.
  plan_digest text not null check (plan_digest ~ '^[0-9a-f]{64}$'),
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 16384),
  -- What still has to be connected, mapped or approved in this workspace (the Setup Checklist).
  requirements text[] not null default '{}' check (cardinality(requirements) <= 30),
  -- The same confirmation submitted twice returns the first application instead of applying again.
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  requested_by uuid references users(id) on delete set null,
  requested_via text not null default 'agency' check (requested_via in ('agency', 'onboarding')),
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  rolled_back_at timestamptz,
  rolled_back_by uuid references users(id) on delete set null,
  unique (org_id, idempotency_key),
  unique (id, org_id),
  foreign key (version_id, blueprint_id) references crm_blueprint_versions (id, blueprint_id) on delete restrict,
  check ((status in ('rolled_back', 'partially_rolled_back')) = (rolled_back_at is not null))
);
create index crm_blueprint_applications_org_idx on crm_blueprint_applications (org_id, created_at desc);
create index crm_blueprint_applications_blueprint_idx on crm_blueprint_applications (blueprint_id, created_at desc);

-- One row per Blueprint asset in an application. asset_type is the package format's asset kind (folder, tag, customField, customValue,
-- pipeline, stage, smartList, calendar, appointmentType, form, messageTemplate, workflow, report, ...); src/lib/crm/blueprints owns the list.
create table crm_blueprint_application_items (
  org_id uuid not null references organizations(id) on delete cascade,
  application_id uuid not null,
  asset_id text not null check (char_length(asset_id) between 1 and 96),
  asset_type text not null check (asset_type ~ '^[a-z][A-Za-z]{1,39}$'),
  section text not null check (char_length(section) between 1 and 40),
  name text not null check (char_length(name) between 1 and 200),
  action text not null check (action in ('create', 'update', 'link', 'unchanged', 'skip', 'conflict', 'blocked')),
  outcome text not null check (outcome in ('applied', 'skipped', 'failed', 'rolled_back', 'kept')),
  native_id uuid,
  -- The record exactly as it was before an update, so a rollback can restore it (and only if nobody changed it since).
  before jsonb check (before is null or (jsonb_typeof(before) = 'object' and pg_column_size(before) <= 65536)),
  -- sha256 of the record's projection right after the write. A rollback only touches a record that still matches it.
  after_hash text check (after_hash ~ '^[0-9a-f]{64}$'),
  message text check (char_length(message) <= 500),
  position integer not null check (position >= 0),
  primary key (application_id, asset_id),
  foreign key (application_id, org_id) references crm_blueprint_applications (id, org_id) on delete cascade
);
create index crm_blueprint_application_items_native_idx on crm_blueprint_application_items (org_id, native_id) where native_id is not null;

-- Which workspace record each Blueprint asset became. asset_hash is the Blueprint asset as applied; native_hash is the record as written.
-- If the record no longer matches native_hash, the client customized it, and an update never overwrites that without a decision.
create table crm_blueprint_links (
  org_id uuid not null references organizations(id) on delete cascade,
  blueprint_id uuid not null references crm_blueprints(id) on delete restrict,
  asset_id text not null check (char_length(asset_id) between 1 and 96),
  asset_type text not null check (asset_type ~ '^[a-z][A-Za-z]{1,39}$'),
  native_id uuid not null,
  applied_version integer not null check (applied_version >= 1),
  asset_hash text not null check (asset_hash ~ '^[0-9a-f]{64}$'),
  native_hash text not null check (native_hash ~ '^[0-9a-f]{64}$'),
  application_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, blueprint_id, asset_id),
  unique (org_id, blueprint_id, asset_type, native_id),
  foreign key (application_id, org_id) references crm_blueprint_applications (id, org_id) on delete cascade
);
create index crm_blueprint_links_native_idx on crm_blueprint_links (org_id, native_id);
create trigger crm_blueprint_links_touch before update on crm_blueprint_links for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

-- The library is agency-only and served by trusted server code: row-level security on, no policies, and no grants to any application role.
alter table crm_blueprint_folders enable row level security;
alter table crm_blueprints enable row level security;
alter table crm_blueprint_versions enable row level security;
alter table crm_blueprint_ghl_sources enable row level security;
alter table crm_blueprint_imports enable row level security;
revoke all on crm_blueprint_folders, crm_blueprints, crm_blueprint_versions, crm_blueprint_ghl_sources, crm_blueprint_imports
  from public, anon, authenticated, iaq_site_runtime, iaq_app_user;

-- Tenant tables: the client reads what was applied to its own workspace; writes go through trusted server code.
alter table crm_blueprint_applications enable row level security;
alter table crm_blueprint_application_items enable row level security;
alter table crm_blueprint_links enable row level security;
revoke all on crm_blueprint_applications, crm_blueprint_application_items, crm_blueprint_links from public, anon, authenticated, iaq_site_runtime;
grant select on crm_blueprint_applications, crm_blueprint_links to iaq_app_user;
-- An item's `before` is a whole record as it was before an update (a workflow's draft, a rule's people), which the record's own table may
-- not let every CRM member read; it and `after_hash` are read only by trusted code (rollback, the offboarding export). Members read the rest.
grant select (org_id, application_id, asset_id, asset_type, section, name, action, outcome, native_id, message, position)
  on crm_blueprint_application_items to iaq_app_user;

create policy crm_blueprint_applications_select on crm_blueprint_applications for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_blueprint_application_items_select on crm_blueprint_application_items for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_blueprint_links_select on crm_blueprint_links for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));

-- ---------------------------------------------------------------------------
-- Notification kinds: the full list from 0032, plus the Blueprint one. Every earlier kind must stay.
-- ---------------------------------------------------------------------------

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
