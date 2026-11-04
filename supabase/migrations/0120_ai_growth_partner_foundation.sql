-- 0120: additive foundation for one logical AI Growth Partner per organization.
--
-- Legacy agent_instances, chat_conversations, role configurations and Hermes profiles are deliberately
-- left in place. No organizations are backfilled. A later migration can bind one partner to one
-- verified runtime and one canonical conversation after the migration path is proven.

create table ai_growth_partners (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references organizations(id) on delete cascade,
  -- Optional binding to one existing tenant runtime. It is deliberately null until an authorized
  -- migration has selected and verified the tenant's unified runtime.
  runtime_agent_instance_id uuid,
  current_version integer,
  status text not null default 'setup_required'
    check (status in ('setup_required', 'provisioning', 'configured', 'paused', 'migration_required')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  constraint ai_growth_partners_runtime_same_org
    foreign key (runtime_agent_instance_id, org_id)
    references agent_instances (id, org_id) on delete restrict,
  constraint ai_growth_partners_runtime_unique unique (runtime_agent_instance_id)
);
create trigger ai_growth_partners_touch before update on ai_growth_partners
  for each row execute function app.touch_updated_at();

create table ai_growth_partner_versions (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null,
  org_id uuid not null,
  version integer not null check (version > 0),
  -- Structured facts carry their own verification state and provenance. These snapshots are not
  -- compiled into one oversized Hermes prompt; retrieval policy will be implemented separately.
  business_brain jsonb not null default '{"schemaVersion":1}'::jsonb
    check (jsonb_typeof(business_brain) = 'object' and pg_column_size(business_brain) <= 1048576),
  persona_settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(persona_settings) = 'object' and pg_column_size(persona_settings) <= 65536),
  source text not null check (source in (
    'onboarding', 'client_edit', 'agency_edit', 'knowledge_sync', 'website_suggestion', 'rollback', 'migration'
  )),
  source_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_metadata) = 'object' and pg_column_size(source_metadata) <= 16384),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (partner_id, version),
  unique (org_id, partner_id, version),
  constraint ai_growth_partner_versions_tenant_fk
    foreign key (partner_id, org_id) references ai_growth_partners (id, org_id) on delete cascade
);
create index ai_growth_partner_versions_history_idx
  on ai_growth_partner_versions (org_id, partner_id, version desc);

-- An activated version must belong to the same partner and tenant. Deferred so a future atomic
-- activation transaction may insert its snapshot and point the parent row at it together.
alter table ai_growth_partners
  add constraint ai_growth_partners_current_version_fk
  foreign key (org_id, id, current_version)
  references ai_growth_partner_versions (org_id, partner_id, version)
  on delete restrict deferrable initially deferred;

alter table ai_growth_partners enable row level security;
alter table ai_growth_partner_versions enable row level security;
revoke all on ai_growth_partners, ai_growth_partner_versions from public, anon, authenticated, iaq_site_runtime;
-- The application role reads these records through tenant-scoped RLS. All writes go through
-- audited server services using the restricted system connection, so browser-facing SQL has no
-- direct mutation privileges.
grant select on ai_growth_partner_versions to iaq_app_user;
grant select on ai_growth_partners to iaq_app_user;

create policy ai_growth_partners_select on ai_growth_partners for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('agents.use'::text))::uuid[]));
create policy ai_growth_partner_versions_select on ai_growth_partner_versions for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('agents.use'::text))::uuid[]));

-- A saved snapshot can only be replaced by a new version. Deletion remains unavailable to the
-- application role; organization cleanup can still cascade through the rows.
create function app.ai_growth_partner_version_no_update() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  raise exception 'ai_growth_partner_versions_are_immutable' using errcode = '42501';
end $$;
create trigger ai_growth_partner_versions_immutable before update on ai_growth_partner_versions
  for each row execute function app.ai_growth_partner_version_no_update();
revoke all on function app.ai_growth_partner_version_no_update() from public;

comment on table ai_growth_partners is
  'At most one logical AI Growth Partner identity per organization. Legacy employee rows are preserved until an explicit migration binds one verified runtime.';
comment on column ai_growth_partners.runtime_agent_instance_id is
  'Optional same-tenant runtime binding. Null means no unified Hermes runtime has been selected and verified.';
comment on column ai_growth_partners.current_version is
  'The active immutable configuration snapshot version; null means no partner configuration has been activated.';
comment on table ai_growth_partner_versions is
  'Immutable, tenant-scoped snapshots of AI Growth Partner settings and structured Business Brain knowledge.';
