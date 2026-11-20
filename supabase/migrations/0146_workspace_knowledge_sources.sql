alter table workspace_oauth_connections add column knowledge_retry_at timestamptz;

-- Read-only provider snapshots are reviewed independently of confirmed Business Brain facts.
create table workspace_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  provider text not null,
  selection jsonb not null check (jsonb_typeof(selection) = 'object'),
  title text not null check (char_length(title) between 1 and 180),
  status text not null check (status in ('current', 'unavailable', 'retry')),
  checked_at timestamptz not null default now(),
  synced_at timestamptz,
  retry_after timestamptz,
  error_code text,
  unique (org_id, provider),
  unique (id, org_id),
  foreign key (org_id, provider) references workspace_oauth_connections (org_id, provider) on delete cascade
);

create table workspace_knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  source_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  content text not null check (char_length(content) between 1 and 12000),
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  status text not null check (status in ('pending', 'approved', 'rejected', 'superseded')),
  risk_flags text[] not null default '{}',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references users(id) on delete set null,
  foreign key (source_id, org_id) references workspace_knowledge_sources (id, org_id) on delete cascade,
  check (status <> 'approved' or (cardinality(risk_flags) = 0 and reviewed_at is not null))
);

create unique index workspace_knowledge_one_pending on workspace_knowledge_versions (source_id) where status = 'pending';
create unique index workspace_knowledge_one_approved on workspace_knowledge_versions (source_id) where status = 'approved';
create index workspace_knowledge_version_order on workspace_knowledge_versions (source_id, created_at desc, id desc);

alter table workspace_knowledge_sources enable row level security;
alter table workspace_knowledge_versions enable row level security;
revoke all on workspace_knowledge_sources, workspace_knowledge_versions from public, anon, authenticated, iaq_app_user, iaq_site_runtime, service_role;

-- Only the current reviewed snapshot can be used in internal Partner context. The caller's
-- tenant permission check is inside the function because the tables also hold review drafts.
-- Keep the search path empty and qualify relation and type names.
create function app.workspace_knowledge_for_partner(p_org_id uuid, p_agent_id uuid)
returns table (provider text, title text, content text, id uuid)
language sql stable security definer set search_path = ''
as $$
  select s.provider, v.provenance->>'title', v.content, v.id
    from public.workspace_knowledge_sources s
    join public.workspace_oauth_connections c on c.org_id = s.org_id and c.provider = s.provider
    join public.workspace_knowledge_versions v on v.source_id = s.id and v.org_id = s.org_id and v.status = 'approved'
    join public.ai_growth_partners p on p.org_id = s.org_id and p.runtime_agent_instance_id = p_agent_id
   where s.org_id = p_org_id and s.status in ('current', 'retry') and c.status = 'connected'
     and c.check_id is null and (c.access_expires_at is null or c.access_expires_at > now())
     and (
       pg_catalog.current_setting('role', true) = 'none'
       or s.org_id = any ((select app.permitted_orgs('agents.use'::pg_catalog.text))::pg_catalog.uuid[])
     )
   order by s.provider;
$$;

revoke all on function app.workspace_knowledge_for_partner(uuid, uuid) from public, anon, authenticated, iaq_site_runtime, service_role;
grant execute on function app.workspace_knowledge_for_partner(uuid, uuid) to iaq_app_user;

-- A changed provider grant must obtain fresh review before a retained snapshot is used again.
create function app.invalidate_workspace_knowledge_grant()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  update public.workspace_knowledge_versions v
     set status = 'superseded'
    from public.workspace_knowledge_sources s
   where s.org_id = new.org_id and s.provider = new.provider and v.source_id = s.id and v.org_id = s.org_id
     and v.status in ('pending', 'approved');
  update public.workspace_knowledge_sources
     set status = 'unavailable', checked_at = now(), error_code = 'grant_changed', retry_after = null
   where org_id = new.org_id and provider = new.provider;
  return new;
end;
$$;

-- OAuth callbacks and disconnects explicitly advance this generation; normal token
-- refreshes do not. Triggering on this column keeps both transitions atomic.
alter table workspace_oauth_connections add column grant_revision uuid not null default gen_random_uuid();
create trigger invalidate_workspace_knowledge_grant
after update of grant_revision on workspace_oauth_connections for each row
when (old.grant_revision is distinct from new.grant_revision)
execute function app.invalidate_workspace_knowledge_grant();
