-- iAcquire Native CRM, foundation (phase 1).
--
-- What this adds:
--   * A CRM workspace per client with a provider mode (native, GoHighLevel, or a controlled hybrid with an explicit owner per capability).
--     New clients default to native. Existing clients that already have a GoHighLevel location are set to GoHighLevel, so nothing about
--     them changes (including the protected Aster Homes location and the agency's own location, which are never written to).
--   * Granular CRM permissions, an Appointment Setter client role, and per-member permission overrides for delegable CRM permissions.
--   * The contact record grows in place (the existing contacts table stays the single contact record): names, address, preferences,
--     lead status, score, archive, and a generated search column.
--   * Companies, tags, folders, typed custom fields, Smart Lists, an activity timeline, a transactional event outbox, agency support
--     access sessions, external ID mappings, and import/export jobs.
--
-- As in the messaging and appointment modules, the application role can read (under RLS) and trusted server code performs every write
-- after authorizing it. Every tenant table carries org_id, has RLS, and uses same-tenant composite foreign keys.
-- Rollback: supabase/rollbacks/0027_native_crm.down.sql.

-- ---------------------------------------------------------------------------
-- Extensions. Trigram search is optional: if it cannot be created, search falls back to sequential ILIKE.
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    create extension if not exists pg_trgm;
  exception when others then
    raise notice 'pg_trgm unavailable (%); contact search will not use a trigram index', sqlerrm;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- Appointment Setter role
-- ---------------------------------------------------------------------------

alter table organization_memberships drop constraint organization_memberships_role_check;
alter table organization_memberships add constraint organization_memberships_role_check
  check (role in ('owner', 'admin', 'member', 'sales_rep', 'support', 'viewer', 'appointment_setter'));
alter table invitations drop constraint invitations_role_check;
alter table invitations add constraint invitations_role_check
  check (role in ('owner', 'admin', 'member', 'sales_rep', 'support', 'viewer', 'appointment_setter'));
alter table role_permissions drop constraint role_permissions_role_check;
alter table role_permissions add constraint role_permissions_role_check
  check (role in ('owner', 'admin', 'member', 'sales_rep', 'support', 'viewer', 'appointment_setter', 'agency_staff', 'agency_super_admin'));

-- Generated from src/lib/permissions.ts. tests/workforce-config.test.ts fails if the two differ.
-- The Appointment Setter works conversations and books appointments, like a sales representative without the sales pipeline controls.
insert into role_permissions (role, permission) values
  ('appointment_setter', 'workspace.view'), ('appointment_setter', 'team.view'), ('appointment_setter', 'agents.use'),
  ('appointment_setter', 'knowledge.view'), ('appointment_setter', 'leads.view'), ('appointment_setter', 'appointments.view'),
  ('appointment_setter', 'appointments.book'), ('appointment_setter', 'sales.view'), ('appointment_setter', 'notes.write'),
  ('appointment_setter', 'tasks.manage'), ('appointment_setter', 'retention.view'), ('appointment_setter', 'analytics.view'),
  ('appointment_setter', 'approvals.view'), ('appointment_setter', 'support.use'), ('appointment_setter', 'setup.view'),
  ('appointment_setter', 'projects.view'), ('appointment_setter', 'inbox.view'), ('appointment_setter', 'inbox.reply'),
  ('appointment_setter', 'inbox.notes'), ('appointment_setter', 'inbox.resume_ai'), ('appointment_setter', 'escalations.respond'),
  ('appointment_setter', 'contacts.view'), ('appointment_setter', 'contacts.edit'), ('appointment_setter', 'staff.availability'),
  ('appointment_setter', 'website.view')
on conflict do nothing;

-- New CRM permissions. Agency staff are deliberately absent: they reach a client's CRM only through an audited support session.
insert into role_permissions (role, permission) values
  ('owner', 'crm.view'), ('admin', 'crm.view'), ('member', 'crm.view'), ('sales_rep', 'crm.view'), ('support', 'crm.view'), ('viewer', 'crm.view'), ('appointment_setter', 'crm.view'),
  ('owner', 'contacts.assign'), ('admin', 'contacts.assign'),
  ('owner', 'contacts.delete'), ('admin', 'contacts.delete'),
  ('owner', 'contacts.import'), ('admin', 'contacts.import'),
  ('owner', 'contacts.export'), ('admin', 'contacts.export'),
  ('owner', 'contacts.bulk'), ('admin', 'contacts.bulk'),
  ('owner', 'companies.view'), ('admin', 'companies.view'), ('member', 'companies.view'), ('sales_rep', 'companies.view'), ('support', 'companies.view'), ('viewer', 'companies.view'), ('appointment_setter', 'companies.view'),
  ('owner', 'companies.edit'), ('admin', 'companies.edit'), ('member', 'companies.edit'), ('sales_rep', 'companies.edit'), ('support', 'companies.edit'), ('appointment_setter', 'companies.edit'),
  ('owner', 'tags.manage'), ('admin', 'tags.manage'),
  ('owner', 'fields.manage'), ('admin', 'fields.manage'),
  ('owner', 'smartlists.share'), ('admin', 'smartlists.share'),
  ('owner', 'pipelines.manage'), ('admin', 'pipelines.manage'),
  ('owner', 'opportunities.edit'), ('admin', 'opportunities.edit'), ('member', 'opportunities.edit'), ('sales_rep', 'opportunities.edit'), ('appointment_setter', 'opportunities.edit'),
  ('owner', 'opportunities.reopen'), ('admin', 'opportunities.reopen'),
  ('owner', 'opportunities.delete'), ('admin', 'opportunities.delete'),
  ('owner', 'calendars.manage'), ('admin', 'calendars.manage'),
  ('owner', 'calendars.connect'), ('admin', 'calendars.connect'), ('member', 'calendars.connect'), ('sales_rep', 'calendars.connect'), ('support', 'calendars.connect'), ('appointment_setter', 'calendars.connect'),
  ('owner', 'workflows.view'), ('admin', 'workflows.view'),
  ('owner', 'workflows.manage'), ('admin', 'workflows.manage'),
  ('owner', 'templates.manage'), ('admin', 'templates.manage'),
  ('owner', 'campaigns.manage'), ('admin', 'campaigns.manage'),
  ('owner', 'campaigns.send'),
  ('owner', 'forms.manage'), ('admin', 'forms.manage'),
  ('owner', 'reviews.manage'), ('admin', 'reviews.manage'),
  ('owner', 'calls.view'), ('admin', 'calls.view'), ('member', 'calls.view'), ('sales_rep', 'calls.view'), ('support', 'calls.view'), ('appointment_setter', 'calls.view'),
  ('owner', 'crm.provider.manage'),
  ('owner', 'crm.api.manage'), ('admin', 'crm.api.manage'),
  ('owner', 'crm.permissions.manage'), ('admin', 'crm.permissions.manage')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Per-member permission overrides. Only delegable CRM permissions can be granted or withdrawn per person; protected permissions
-- (billing, exports of the whole workspace, provider switching, offboarding, publishing, autonomous AI) always follow the role.
-- ---------------------------------------------------------------------------

create table member_permission_overrides (
  org_id uuid not null,
  user_id uuid not null,
  permission text not null check (permission in (
    'contacts.view', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
    'companies.view', 'companies.edit', 'tags.manage', 'fields.manage', 'smartlists.share',
    'sales.view', 'pipelines.manage', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete',
    'appointments.view', 'appointments.book', 'appointments.manage', 'calendars.manage', 'calendars.connect',
    'tasks.manage', 'notes.write', 'inbox.view_all', 'inbox.assign',
    'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export')),
  effect text not null check (effect in ('grant', 'revoke')),
  reason text not null default '' check (char_length(reason) <= 300),
  granted_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id, permission),
  foreign key (org_id, user_id) references organization_memberships (org_id, user_id) on delete cascade
);

-- An owner always has every owner permission; overrides apply to the other roles only.
create or replace function app.guard_permission_override() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from organization_memberships m where m.org_id = new.org_id and m.user_id = new.user_id and m.role = 'owner') then
    raise exception 'permission_override_owner' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger member_permission_overrides_guard before insert or update on member_permission_overrides
  for each row execute function app.guard_permission_override();

-- The role grants, then a per-person override (if any) decides for that membership. Agency access is unchanged and unaffected by overrides.
create or replace function app.has_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select
    coalesce(
      (select o.effect = 'grant'
       from member_permission_overrides o
       where o.org_id = p_org and o.user_id = app.current_user_id() and o.permission = p_permission and app.org_role(p_org) is not null),
      exists (select 1 from role_permissions rp where rp.permission = p_permission and rp.role = app.org_role(p_org))
    )
    or (app.staff_assigned(p_org) and exists (
      select 1 from role_permissions rp
      where rp.permission = p_permission
        and rp.role = case when app.is_agency_admin() then 'agency_super_admin' else 'agency_staff' end))
$$;
revoke all on function app.has_permission(uuid, text) from public;
grant execute on function app.has_permission(uuid, text) to iaq_app_user;

alter table member_permission_overrides enable row level security;
revoke all on member_permission_overrides from public, anon, authenticated;
grant select on member_permission_overrides to iaq_app_user;
create policy permission_overrides_select on member_permission_overrides for select to iaq_app_user
  using (user_id = app.current_user_id() or app.has_permission(org_id, 'team.view'));

-- ---------------------------------------------------------------------------
-- CRM workspace and provider ownership
-- ---------------------------------------------------------------------------

create table crm_workspaces (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- native: iAcquire is the record of truth for every capability. ghl: GoHighLevel is (read-only caches, as before).
  -- hybrid: each capability names exactly one owner in crm_capability_providers, so two systems never both act on the same record.
  mode text not null default 'native' check (mode in ('native', 'ghl', 'hybrid')),
  default_currency text not null default 'USD' check (default_currency ~ '^[A-Z]{3}$'),
  -- Used only to complete local phone numbers typed without a country code (for example "63" for the Philippines). Never guessed.
  default_calling_code text check (default_calling_code ~ '^[0-9]{1,3}$'),
  -- While a provider switch is cutting over, automations that could act twice stay paused.
  switching boolean not null default false,
  blueprint_key text check (char_length(blueprint_key) <= 80),
  initialized_at timestamptz,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger crm_workspaces_touch before update on crm_workspaces for each row execute function app.touch_updated_at();

create table crm_capability_providers (
  org_id uuid not null references crm_workspaces(org_id) on delete cascade,
  capability text not null check (capability in (
    'contacts', 'companies', 'tags', 'custom_fields', 'pipelines', 'opportunities', 'calendars', 'appointments', 'conversations', 'workflows', 'reporting')),
  provider text not null check (provider in ('native', 'ghl')),
  -- How the non-owning side may learn about records: none, or a one-time import into native.
  sync_policy text not null default 'none' check (sync_policy in ('none', 'import_only')),
  owner_since timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  primary key (org_id, capability)
);

-- Every new client workspace starts on iAcquire Native CRM. GoHighLevel is optional and connected deliberately.
create or replace function app.crm_workspace_for_new_client() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.kind = 'client' then
    insert into crm_workspaces (org_id, mode) values (new.id, 'native') on conflict (org_id) do nothing;
  end if;
  return new;
end
$$;
create trigger organizations_crm_workspace after insert on organizations for each row execute function app.crm_workspace_for_new_client();

-- Existing clients: those already mapped to a GoHighLevel location keep GoHighLevel; the rest get the native CRM.
insert into crm_workspaces (org_id, mode, initialized_at)
select o.id,
       case when exists (select 1 from ghl_location_mappings g where g.org_id = o.id) then 'ghl' else 'native' end,
       null
from organizations o
where o.kind = 'client'
on conflict (org_id) do nothing;

-- ---------------------------------------------------------------------------
-- Folders (organization only; they never change who can see a record)
-- ---------------------------------------------------------------------------

create table crm_folders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('smart_list', 'tag', 'template', 'workflow', 'form', 'calendar', 'report', 'campaign')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  position integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, kind, name),
  unique (id, org_id)
);

-- ---------------------------------------------------------------------------
-- Contacts: the existing record grows in place
-- ---------------------------------------------------------------------------

alter table contacts
  add column first_name text check (char_length(first_name) <= 100),
  add column last_name text check (char_length(last_name) <= 100),
  add column address_line1 text check (char_length(address_line1) <= 200),
  add column address_line2 text check (char_length(address_line2) <= 200),
  add column city text check (char_length(city) <= 100),
  add column region text check (char_length(region) <= 100),
  add column postal_code text check (char_length(postal_code) <= 20),
  add column country text check (country ~ '^[A-Z]{2}$'),
  add column preferred_language text check (preferred_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  add column preferred_channel text check (preferred_channel in ('email', 'sms', 'whatsapp', 'phone')),
  add column lead_status text not null default 'new' check (lead_status in ('new', 'open', 'contacted', 'qualified', 'unqualified', 'customer', 'inactive')),
  add column lead_score integer check (lead_score between 0 and 100),
  add column created_by uuid references users(id) on delete set null,
  -- How the record first arrived. Never rewritten, so attribution is not invented later.
  add column created_via text not null default 'inbound_message' check (created_via in (
    'inbound_message', 'manual', 'import', 'website_form', 'form', 'booking', 'api', 'agent', 'workflow', 'ghl_migration', 'call')),
  add column archived_at timestamptz,
  add column archived_by uuid references users(id) on delete set null,
  add column last_activity_at timestamptz,
  -- Optimistic concurrency: an edit names the version it started from, so two people cannot silently overwrite each other.
  add column version integer not null default 1,
  add column search_text text generated always as (
    lower(coalesce(display_name, '') || ' ' || coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' ||
          coalesce(email::text, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(city, ''))
  ) stored;
-- Grounded backfill only: the one earlier source value that says how a record arrived. Everything else stays "inbound_message".
update contacts set created_via = 'website_form' where source = 'website_form';
create index contacts_directory_idx on contacts (org_id, created_at desc) where deleted_at is null;
create index contacts_owner_idx on contacts (org_id, assigned_user_id) where deleted_at is null;
create index contacts_status_idx on contacts (org_id, lead_status) where deleted_at is null;

do $$
declare s text;
begin
  select n.nspname into s from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  if s is not null then
    execute format('create index contacts_search_trgm on contacts using gin (search_text %I.gin_trgm_ops) where deleted_at is null', s);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------

create table crm_companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  domain citext check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and char_length(domain::text) <= 253),
  website text check (char_length(website) <= 300 and website ~ '^https?://'),
  industry text check (char_length(industry) <= 120),
  phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  email citext check (char_length(email::text) <= 320),
  address_line1 text check (char_length(address_line1) <= 200),
  address_line2 text check (char_length(address_line2) <= 200),
  city text check (char_length(city) <= 100),
  region text check (char_length(region) <= 100),
  postal_code text check (char_length(postal_code) <= 20),
  country text check (country ~ '^[A-Z]{2}$'),
  description text check (char_length(description) <= 2000),
  owner_user_id uuid references users(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_via text not null default 'manual' check (created_via in ('manual', 'import', 'form', 'api', 'agent', 'workflow', 'ghl_migration')),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_text text generated always as (lower(name || ' ' || coalesce(domain::text, '') || ' ' || coalesce(city, '') || ' ' || coalesce(industry, ''))) stored,
  unique (id, org_id)
);
create unique index crm_companies_domain_unique on crm_companies (org_id, domain) where domain is not null and deleted_at is null;
create index crm_companies_org_idx on crm_companies (org_id, name) where deleted_at is null;
create trigger crm_companies_touch before update on crm_companies for each row execute function app.touch_updated_at();

create table crm_contact_companies (
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  company_id uuid not null,
  title text check (char_length(title) <= 120),
  is_primary boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (contact_id, company_id),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  foreign key (company_id, org_id) references crm_companies (id, org_id) on delete cascade
);
create unique index crm_contact_companies_primary on crm_contact_companies (contact_id) where is_primary;
create index crm_contact_companies_company_idx on crm_contact_companies (org_id, company_id);

-- ---------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------

create table crm_tags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name citext not null check (char_length(btrim(name::text)) between 1 and 60),
  color text not null default '#64748b' check (color ~ '^#[0-9a-f]{6}$'),
  description text check (char_length(description) <= 300),
  folder_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name),
  unique (id, org_id),
  foreign key (folder_id, org_id) references crm_folders (id, org_id) on delete set null (folder_id)
);
create trigger crm_tags_touch before update on crm_tags for each row execute function app.touch_updated_at();

create table crm_contact_tags (
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  tag_id uuid not null,
  source text not null default 'manual' check (source in ('manual', 'bulk', 'import', 'workflow', 'form', 'agent', 'api', 'merge', 'blueprint', 'ghl_migration', 'booking')),
  added_by uuid references users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (contact_id, tag_id),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  foreign key (tag_id, org_id) references crm_tags (id, org_id) on delete cascade
);
create index crm_contact_tags_tag_idx on crm_contact_tags (org_id, tag_id);

create table crm_company_tags (
  org_id uuid not null references organizations(id) on delete cascade,
  company_id uuid not null,
  tag_id uuid not null,
  added_by uuid references users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (company_id, tag_id),
  foreign key (company_id, org_id) references crm_companies (id, org_id) on delete cascade,
  foreign key (tag_id, org_id) references crm_tags (id, org_id) on delete cascade
);
create index crm_company_tags_tag_idx on crm_company_tags (org_id, tag_id);

-- ---------------------------------------------------------------------------
-- Custom fields: definitions and typed values. A trigger checks every value against its definition.
-- ---------------------------------------------------------------------------

create table crm_custom_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  entity text not null check (entity in ('contact', 'company', 'opportunity')),
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  type text not null check (type in ('text', 'textarea', 'number', 'currency', 'date', 'datetime', 'boolean', 'select', 'multiselect', 'email', 'phone', 'url')),
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 100 and pg_column_size(options) <= 16384),
  required boolean not null default false,
  help_text text check (char_length(help_text) <= 200),
  group_name text check (char_length(group_name) <= 60),
  position integer not null default 0,
  archived_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, entity, key),
  unique (id, org_id),
  check (type not in ('select', 'multiselect') or jsonb_array_length(options) > 0)
);
create trigger crm_custom_fields_touch before update on crm_custom_fields for each row execute function app.touch_updated_at();

create table crm_field_values (
  org_id uuid not null references organizations(id) on delete cascade,
  field_id uuid not null,
  entity text not null check (entity in ('contact', 'company', 'opportunity')),
  entity_id uuid not null,
  value_text text check (char_length(value_text) <= 5000),
  value_number numeric(20, 6),
  value_date date,
  value_ts timestamptz,
  value_bool boolean,
  value_list text[] check (cardinality(value_list) <= 100),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (field_id, entity_id),
  foreign key (field_id, org_id) references crm_custom_fields (id, org_id) on delete cascade,
  check (num_nonnulls(value_text, value_number, value_date, value_ts, value_bool, value_list) = 1)
);
create index crm_field_values_entity_idx on crm_field_values (org_id, entity, entity_id);

create or replace function app.crm_field_value_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
declare f record; ok boolean;
begin
  select entity, type into f from crm_custom_fields where id = new.field_id and org_id = new.org_id;
  if f is null or f.entity <> new.entity then
    raise exception 'crm_field_value_field_mismatch' using errcode = 'check_violation';
  end if;
  ok := case f.type
    when 'number' then new.value_number is not null
    when 'currency' then new.value_number is not null
    when 'date' then new.value_date is not null
    when 'datetime' then new.value_ts is not null
    when 'boolean' then new.value_bool is not null
    when 'multiselect' then new.value_list is not null
    else new.value_text is not null
  end;
  if not ok then
    raise exception 'crm_field_value_type_mismatch' using errcode = 'check_violation';
  end if;
  -- The record must belong to the same tenant as the field.
  if new.entity = 'contact' and not exists (select 1 from contacts where id = new.entity_id and org_id = new.org_id) then
    raise exception 'crm_field_value_record_mismatch' using errcode = 'check_violation';
  elsif new.entity = 'company' and not exists (select 1 from crm_companies where id = new.entity_id and org_id = new.org_id) then
    raise exception 'crm_field_value_record_mismatch' using errcode = 'check_violation';
  elsif new.entity = 'opportunity' and not exists (select 1 from crm_opportunities where id = new.entity_id and org_id = new.org_id) then
    raise exception 'crm_field_value_record_mismatch' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger crm_field_values_guard before insert or update on crm_field_values for each row execute function app.crm_field_value_guard();

-- ---------------------------------------------------------------------------
-- Smart Lists: saved, dynamic filters. The filter is a validated expression evaluated at read time, never a stored copy of contacts.
-- ---------------------------------------------------------------------------

create table crm_smart_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  entity text not null default 'contact' check (entity in ('contact', 'company', 'opportunity')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (char_length(description) <= 300),
  folder_id uuid,
  filter jsonb not null default '{"op":"and","conditions":[]}'::jsonb check (jsonb_typeof(filter) = 'object' and pg_column_size(filter) <= 16384),
  columns text[] not null default '{}' check (cardinality(columns) <= 30),
  sort jsonb not null default '{}'::jsonb check (jsonb_typeof(sort) = 'object'),
  visibility text not null default 'private' check (visibility in ('private', 'team')),
  owner_user_id uuid not null references users(id) on delete cascade,
  is_default boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (folder_id, org_id) references crm_folders (id, org_id) on delete set null (folder_id),
  check (not is_default or visibility = 'team')
);
create unique index crm_smart_lists_one_default on crm_smart_lists (org_id, entity) where is_default and archived_at is null;
create index crm_smart_lists_org_idx on crm_smart_lists (org_id, entity) where archived_at is null;
create trigger crm_smart_lists_touch before update on crm_smart_lists for each row execute function app.touch_updated_at();

create table crm_view_preferences (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  smart_list_id uuid not null,
  pinned boolean not null default false,
  last_used_at timestamptz,
  primary key (user_id, smart_list_id),
  foreign key (smart_list_id, org_id) references crm_smart_lists (id, org_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Notes on contacts and companies (the existing notes table, extended)
-- ---------------------------------------------------------------------------

alter table record_notes drop constraint record_notes_record_type_check;
alter table record_notes add constraint record_notes_record_type_check
  check (record_type in ('opportunity', 'lead', 'retention_account', 'appointment', 'contact', 'company'));
alter table record_notes
  add column pinned boolean not null default false,
  add column updated_at timestamptz,
  add column deleted_at timestamptz;

-- Contact and company notes follow the record's own permission; other notes keep their earlier rule.
drop policy record_notes_select on record_notes;
create policy record_notes_select on record_notes for select to iaq_app_user using (
  deleted_at is null and case record_type
    when 'contact' then app.has_permission(org_id, 'contacts.view')
    when 'company' then app.has_permission(org_id, 'companies.view')
    else app.can_access_org(org_id)
  end);

-- ---------------------------------------------------------------------------
-- Activity timeline: append-only record of things that actually happened. Nothing is ever back-filled or invented.
-- ---------------------------------------------------------------------------

create table crm_activities (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid,
  company_id uuid,
  opportunity_id uuid,
  kind text not null check (kind ~ '^[a-z_]+\.[a-z_]+$' and char_length(kind) <= 60),
  summary text not null check (char_length(summary) between 1 and 300),
  actor_kind text not null check (actor_kind in ('user', 'agency', 'agent', 'system', 'api', 'contact')),
  actor_user_id uuid references users(id) on delete set null,
  agent_id uuid references agent_instances(id) on delete set null,
  ref_type text check (char_length(ref_type) <= 40),
  ref_id text check (char_length(ref_id) <= 120),
  metadata jsonb not null default '{}'::jsonb check (pg_column_size(metadata) <= 4096),
  occurred_at timestamptz not null default now(),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  foreign key (company_id, org_id) references crm_companies (id, org_id) on delete cascade
);
create index crm_activities_contact_idx on crm_activities (org_id, contact_id, occurred_at desc) where contact_id is not null;
create index crm_activities_company_idx on crm_activities (org_id, company_id, occurred_at desc) where company_id is not null;
create index crm_activities_opportunity_idx on crm_activities (org_id, opportunity_id, occurred_at desc) where opportunity_id is not null;
create index crm_activities_org_idx on crm_activities (org_id, occurred_at desc);
create trigger crm_activities_immutable before update on crm_activities for each row execute function app.immutable_row();

-- ---------------------------------------------------------------------------
-- Transactional event outbox. A change and its event commit together; the scheduler dispatches events to workflows and webhooks.
-- The dedupe key makes retries (a double click, a redelivered webhook) produce one event. depth counts how many automated steps
-- led here, so a workflow that triggers itself stops instead of looping.
-- ---------------------------------------------------------------------------

create table crm_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  type text not null check (type ~ '^[a-z_]+\.[a-z_]+$' and char_length(type) <= 60),
  entity_type text not null check (char_length(entity_type) <= 40),
  entity_id uuid,
  contact_id uuid,
  payload jsonb not null default '{}'::jsonb check (pg_column_size(payload) <= 16384),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 300),
  actor_kind text not null check (actor_kind in ('user', 'agency', 'agent', 'system', 'api', 'contact', 'workflow')),
  actor_id text check (char_length(actor_id) <= 120),
  causation_event_id bigint references crm_events(id) on delete set null,
  depth integer not null default 0 check (depth between 0 and 20),
  occurred_at timestamptz not null default now(),
  dispatched_at timestamptz,
  dispatch_attempts integer not null default 0 check (dispatch_attempts >= 0),
  dispatch_claimed_at timestamptz,
  dispatch_error text check (char_length(dispatch_error) <= 300),
  unique (org_id, dedupe_key)
);
create index crm_events_pending_idx on crm_events (id) where dispatched_at is null;
create index crm_events_org_idx on crm_events (org_id, occurred_at desc);
create index crm_events_contact_idx on crm_events (org_id, contact_id, occurred_at desc) where contact_id is not null;

-- ---------------------------------------------------------------------------
-- Agency support access: an agency person opens a time-limited, audited session on one client's CRM. Read-only by default.
-- The client's owner and managers can see every session.
-- ---------------------------------------------------------------------------

create table crm_support_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  mode text not null check (mode in ('read', 'write')),
  reason text not null check (char_length(btrim(reason)) between 5 and 500),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  check (expires_at > started_at and expires_at <= started_at + interval '4 hours')
);
create index crm_support_sessions_active_idx on crm_support_sessions (org_id, user_id, expires_at desc) where ended_at is null;

-- ---------------------------------------------------------------------------
-- External IDs: one native record per external record per provider, so imports and migrations never create duplicates.
-- ---------------------------------------------------------------------------

create table crm_external_ids (
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('ghl', 'csv', 'google', 'microsoft', 'caldav', 'ics', 'api')),
  entity text not null check (entity in ('contact', 'company', 'opportunity', 'pipeline', 'stage', 'appointment', 'calendar', 'tag', 'custom_field', 'conversation', 'message', 'note', 'task')),
  external_id text not null check (char_length(external_id) between 1 and 200),
  native_id uuid not null,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (org_id, provider, entity, external_id),
  unique (org_id, provider, entity, native_id)
);

-- ---------------------------------------------------------------------------
-- Imports and exports
-- ---------------------------------------------------------------------------

create table crm_import_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  entity text not null check (entity in ('contact', 'company', 'opportunity')),
  source text not null default 'csv' check (source in ('csv', 'ghl_api')),
  file_name text check (char_length(file_name) <= 200),
  status text not null default 'uploaded' check (status in (
    'uploaded', 'validated', 'queued', 'importing', 'completed', 'failed', 'cancelled', 'rolling_back', 'rolled_back')),
  headers text[] not null default '{}' check (cardinality(headers) <= 200),
  mapping jsonb not null default '{}'::jsonb check (jsonb_typeof(mapping) = 'object' and pg_column_size(mapping) <= 16384),
  -- duplicates: what to do when a row matches an existing record by exact email or phone (never by name).
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object' and pg_column_size(options) <= 4096),
  total_rows integer not null default 0 check (total_rows >= 0),
  summary jsonb not null default '{}'::jsonb check (pg_column_size(summary) <= 8192),
  error text check (char_length(error) <= 500),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  started_at timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  rolled_back_at timestamptz,
  rolled_back_by uuid references users(id) on delete set null,
  unique (id, org_id)
);
create index crm_import_jobs_org_idx on crm_import_jobs (org_id, created_at desc);
create index crm_import_jobs_work_idx on crm_import_jobs (status) where status in ('queued', 'importing', 'rolling_back');

create table crm_import_rows (
  org_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null,
  row_number integer not null check (row_number >= 1),
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 16384),
  status text not null default 'pending' check (status in (
    'pending', 'valid', 'invalid', 'duplicate', 'created', 'updated', 'skipped', 'needs_review', 'failed', 'rolled_back')),
  errors jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array' and pg_column_size(errors) <= 4096),
  planned_action text check (planned_action in ('create', 'update', 'skip', 'review')),
  match_id uuid,
  entity_id uuid,
  -- What the import changed, so a rollback can undo exactly that and nothing else.
  result jsonb not null default '{}'::jsonb check (pg_column_size(result) <= 16384),
  processed_at timestamptz,
  primary key (job_id, row_number),
  foreign key (job_id, org_id) references crm_import_jobs (id, org_id) on delete cascade
);
create index crm_import_rows_status_idx on crm_import_rows (job_id, status);

create table crm_export_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  entity text not null check (entity in ('contact', 'company', 'opportunity')),
  smart_list_id uuid,
  filter jsonb not null default '{}'::jsonb check (pg_column_size(filter) <= 16384),
  columns text[] not null default '{}' check (cardinality(columns) <= 60),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  row_count integer not null default 0,
  requested_by uuid references users(id) on delete set null,
  requested_by_kind text not null default 'user' check (requested_by_kind in ('user', 'agency', 'api')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error text check (char_length(error) <= 300)
);
create index crm_export_jobs_org_idx on crm_export_jobs (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security. Reads are scoped by permission; writes happen in trusted server code after authorization.
-- ---------------------------------------------------------------------------

alter table crm_workspaces enable row level security;
alter table crm_capability_providers enable row level security;
alter table crm_folders enable row level security;
alter table crm_companies enable row level security;
alter table crm_contact_companies enable row level security;
alter table crm_tags enable row level security;
alter table crm_contact_tags enable row level security;
alter table crm_company_tags enable row level security;
alter table crm_custom_fields enable row level security;
alter table crm_field_values enable row level security;
alter table crm_smart_lists enable row level security;
alter table crm_view_preferences enable row level security;
alter table crm_activities enable row level security;
alter table crm_events enable row level security;
alter table crm_support_sessions enable row level security;
alter table crm_external_ids enable row level security;
alter table crm_import_jobs enable row level security;
alter table crm_import_rows enable row level security;
alter table crm_export_jobs enable row level security;

revoke all on crm_workspaces, crm_capability_providers, crm_folders, crm_companies, crm_contact_companies, crm_tags, crm_contact_tags,
  crm_company_tags, crm_custom_fields, crm_field_values, crm_smart_lists, crm_view_preferences, crm_activities, crm_events,
  crm_support_sessions, crm_external_ids, crm_import_jobs, crm_import_rows, crm_export_jobs from public, anon, authenticated;

grant select on crm_workspaces, crm_capability_providers, crm_folders, crm_companies, crm_contact_companies, crm_tags, crm_contact_tags,
  crm_company_tags, crm_custom_fields, crm_field_values, crm_smart_lists, crm_view_preferences, crm_activities, crm_events,
  crm_support_sessions, crm_external_ids, crm_import_jobs, crm_import_rows, crm_export_jobs to iaq_app_user;

create policy crm_workspaces_select on crm_workspaces for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_capability_providers_select on crm_capability_providers for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_folders_select on crm_folders for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_companies_select on crm_companies for select to iaq_app_user using (app.has_permission(org_id, 'companies.view') and deleted_at is null);
create policy crm_contact_companies_select on crm_contact_companies for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view'));
create policy crm_tags_select on crm_tags for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_contact_tags_select on crm_contact_tags for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view'));
create policy crm_company_tags_select on crm_company_tags for select to iaq_app_user using (app.has_permission(org_id, 'companies.view'));
create policy crm_custom_fields_select on crm_custom_fields for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
create policy crm_field_values_select on crm_field_values for select to iaq_app_user using (
  case entity
    when 'contact' then app.has_permission(org_id, 'contacts.view')
    when 'company' then app.has_permission(org_id, 'companies.view')
    else app.has_permission(org_id, 'sales.view')
  end);
create policy crm_smart_lists_select on crm_smart_lists for select to iaq_app_user using (
  app.has_permission(org_id, 'crm.view') and (visibility = 'team' or owner_user_id = app.current_user_id()));
create policy crm_view_preferences_select on crm_view_preferences for select to iaq_app_user using (
  user_id = app.current_user_id() and app.has_permission(org_id, 'crm.view'));
create policy crm_activities_select on crm_activities for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view'));
create policy crm_events_select on crm_events for select to iaq_app_user using (app.has_permission(org_id, 'workflows.view'));
create policy crm_support_sessions_select on crm_support_sessions for select to iaq_app_user using (
  user_id = app.current_user_id() or app.has_permission(org_id, 'activity.view'));
create policy crm_external_ids_select on crm_external_ids for select to iaq_app_user using (app.has_permission(org_id, 'contacts.import'));
create policy crm_import_jobs_select on crm_import_jobs for select to iaq_app_user using (app.has_permission(org_id, 'contacts.import'));
create policy crm_import_rows_select on crm_import_rows for select to iaq_app_user using (app.has_permission(org_id, 'contacts.import'));
create policy crm_export_jobs_select on crm_export_jobs for select to iaq_app_user using (
  app.has_permission(org_id, 'contacts.export') or requested_by = app.current_user_id());

-- ---------------------------------------------------------------------------
-- Notification kinds used by the CRM
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
  'crm_import_finished', 'crm_assigned', 'crm_support_access', 'crm_task_due'));
