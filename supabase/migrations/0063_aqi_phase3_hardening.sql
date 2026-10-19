-- AQi Phase 3 hardening.
--
-- 1. Knowledge version history: the current entries table only increments a version number. This
--    table stores the actual prior content, so a Super Admin can inspect and restore it. Existing
--    earlier versions cannot be reconstructed; the first edit after this migration captures the
--    content that was live at that moment.
-- 2. The seeded "Adding your first contact" walkthrough moves to a new published version whose
--    completion requires a CRM-confirmed contact. It never changes the archived v1 definition.

-- ---------------------------------------------------------------------------
-- Knowledge version history (management only)
-- ---------------------------------------------------------------------------
create table if not exists aqi_knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  knowledge_entry_id uuid not null references aqi_knowledge_entries(id) on delete cascade,
  version integer not null check (version > 0),
  title text not null check (char_length(title) between 1 and 160),
  category text not null check (char_length(category) between 1 and 60),
  body text not null check (char_length(body) between 1 and 12000),
  route_prefix text check (route_prefix is null or route_prefix ~ '^/[a-z0-9/_-]*$'),
  roles text[] not null default '{}',
  status text not null check (status in ('draft', 'published', 'archived')),
  source text not null default 'iAcquire approved documentation' check (char_length(source) <= 200),
  change_note text check (change_note is null or char_length(change_note) <= 300),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (knowledge_entry_id, version)
);
create index if not exists aqi_knowledge_versions_entry_idx
  on aqi_knowledge_versions (knowledge_entry_id, version desc);

alter table aqi_knowledge_versions enable row level security;
-- No iaq_app_user grant: history is read only through Super-Admin-checked server code.

-- ---------------------------------------------------------------------------
-- Upgrade the seeded contact walkthrough to authoritative business completion
-- ---------------------------------------------------------------------------
do $$
declare
  v_tutorial_id uuid;
  published_version aqi_tutorial_versions%rowtype;
  upgraded jsonb;
  new_version_id uuid;
begin
  select id into v_tutorial_id from aqi_tutorials where slug = 'create-contact';
  if v_tutorial_id is null then return; end if;

  select * into published_version
    from aqi_tutorial_versions
   where tutorial_id = v_tutorial_id and status = 'published'
   order by version desc limit 1;
  if published_version.id is null then return; end if;
  if published_version.version <> 1 or published_version.notes is distinct from 'Starter library' then return; end if;
  if published_version.definition->>'title' is distinct from 'Adding your first contact' then return; end if;
  if published_version.definition->'completion'->>'kind' is distinct from 'route' then return; end if;

  upgraded := jsonb_set(
    published_version.definition,
    '{completion}',
    '{"kind":"contact_created","pattern":"/crm/contacts/:id"}'::jsonb,
    true
  );

  update aqi_tutorial_versions set status = 'archived' where id = published_version.id;
  insert into aqi_tutorial_versions (tutorial_id, version, status, definition, notes, published_at)
  values (v_tutorial_id, 2, 'published', upgraded, 'Completion requires CRM confirmation', now())
  returning id into new_version_id;

  update aqi_tutorials
     set published_version_id = new_version_id,
         updated_at = now()
   where id = v_tutorial_id;

  update aqi_tutorial_progress
     set status = 'unavailable', unavailable_reason = 'version_changed', updated_at = now()
   where tutorial_id = v_tutorial_id and tutorial_version <> 2 and status in ('in_progress', 'paused');
end
$$;
