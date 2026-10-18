-- AI workforce experience: employee-specific knowledge, safe retrieval readiness and test-run evidence.
--
-- Renumbered from 0041 after the hosted migration history was inspected: the hosted project already has
-- 0041_crm_action_permissions through 0044_agency_module_view_overrides, so this workforce-owned migration is
-- placed after them to avoid overwriting another migration's version. The local branch's 0041/0042 never applied
-- to the hosted project.
--
-- Existing company knowledge stays organization-wide. This migration adds knowledge that belongs to one employee
-- (text notes and uploaded documents) without creating a second employee registry or a second chat backend.
--
-- Hosted/local compatibility:
--   * The local chain applies 0050_rls_initplan after all earlier schemas, including this one. These policies use the
--     statement-level helper when it already exists and otherwise use the per-row helper; 0050 rewrites the SELECT
--     policy in a fresh install. Both paths are fail-closed and permission-checked.
--   * This file is idempotent for objects it owns, so it can be re-run safely after an interrupted deploy.
--
-- Security notes:
--   * employee_knowledge_entries is readable with knowledge.view and writable with knowledge.edit.
--   * A document's agent_instance_id is protected by a composite (id, org_id) foreign key, so a document can never be
--     attached to another tenant's employee even if a caller forges the identifier.
--   * Extracted text that trips a prompt-injection pattern is never stored as usable text (extracted_text is null,
--     applied_at is null) and risk_flags records why. The knowledge UI must show it as held, never as ready.
--   * last_used_at is written only after a real Hermes run has been accepted, so "used in a conversation" is evidence,
--     not an inference from saving a row.

create table if not exists employee_knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null,
  title text not null check (char_length(title) between 1 and 160),
  content text not null check (char_length(content) between 1 and 40000),
  status text not null default 'approved'
    check (status in ('approved', 'pending_agency_review', 'rejected', 'archived')),
  version integer not null default 1 check (version > 0),
  risk_flags text[] not null default '{}',
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set only after a provider run accepted the instructions that included this entry.
  last_used_at timestamptz
);
create index if not exists employee_knowledge_agent_idx on employee_knowledge_entries (agent_instance_id, updated_at desc);
create index if not exists employee_knowledge_org_idx on employee_knowledge_entries (org_id, updated_at desc);
-- One live entry per title per employee. Archived titles can be reused.
create unique index if not exists employee_knowledge_title_unique
  on employee_knowledge_entries (agent_instance_id, lower(title))
  where status <> 'archived';
drop trigger if exists employee_knowledge_touch on employee_knowledge_entries;
create trigger employee_knowledge_touch before update on employee_knowledge_entries
  for each row execute function app.touch_updated_at();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employee_knowledge_agent_same_org') then
    alter table employee_knowledge_entries
      add constraint employee_knowledge_agent_same_org
      foreign key (agent_instance_id, org_id) references agent_instances (id, org_id) on delete cascade;
  end if;
end $$;

alter table employee_knowledge_entries enable row level security;
grant select, insert, update on employee_knowledge_entries to iaq_app_user;

drop policy if exists employee_knowledge_select on employee_knowledge_entries;
drop policy if exists employee_knowledge_insert on employee_knowledge_entries;
drop policy if exists employee_knowledge_update on employee_knowledge_entries;
do $$
begin
  if to_regprocedure('app.permitted_orgs(text)') is null then
    -- Hosted schema: the per-row helper is the only verified statement available. This is still permission-checked
    -- and row-level-security enforced; it is simply not the statement-level optimization used on the local branch.
    execute $p$create policy employee_knowledge_select on employee_knowledge_entries for select to iaq_app_user
      using (app.has_permission(org_id, 'knowledge.view'::text))$p$;
    execute $p$create policy employee_knowledge_insert on employee_knowledge_entries for insert to iaq_app_user
      with check (app.has_permission(org_id, 'knowledge.edit'::text) and created_by = app.current_user_id())$p$;
    execute $p$create policy employee_knowledge_update on employee_knowledge_entries for update to iaq_app_user
      using (app.has_permission(org_id, 'knowledge.edit'::text))
      with check (app.has_permission(org_id, 'knowledge.edit'::text))$p$;
  else
    -- The statement-level helper is already present in schemas that have applied 0050.
    execute $p$create policy employee_knowledge_select on employee_knowledge_entries for select to iaq_app_user
      using (org_id = ANY ((SELECT app.permitted_orgs('knowledge.view'::text))::uuid[]))$p$;
    execute $p$create policy employee_knowledge_insert on employee_knowledge_entries for insert to iaq_app_user
      with check (org_id = ANY ((SELECT app.permitted_orgs('knowledge.edit'::text))::uuid[])
                  and created_by = app.current_user_id())$p$;
    execute $p$create policy employee_knowledge_update on employee_knowledge_entries for update to iaq_app_user
      using (org_id = ANY ((SELECT app.permitted_orgs('knowledge.edit'::text))::uuid[]))
      with check (org_id = ANY ((SELECT app.permitted_orgs('knowledge.edit'::text))::uuid[]))$p$;
  end if;
end $$;

-- Documents can be shared with every employee (agent_instance_id is null, the existing behaviour) or assigned to one
-- employee. risk_flags explains why extracted text was withheld; last_used_at is written only after a provider accepts
-- the run that included the document.
alter table knowledge_documents add column if not exists agent_instance_id uuid;
alter table knowledge_documents add column if not exists risk_flags text[] not null default '{}';
alter table knowledge_documents add column if not exists last_used_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'knowledge_documents_agent_same_org') then
    alter table knowledge_documents
      add constraint knowledge_documents_agent_same_org
      foreign key (agent_instance_id, org_id) references agent_instances (id, org_id) on delete cascade;
  end if;
end $$;
create index if not exists knowledge_documents_agent_idx
  on knowledge_documents (agent_instance_id, created_at desc)
  where agent_instance_id is not null;
