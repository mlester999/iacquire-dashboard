-- Rollback for 0045_ai_workforce_experience.sql. NOT a migration: the Supabase CLI does not run this folder.
-- Review it, take a backup, stop the AI workforce screens, roll back later migrations first and run it in one
-- transaction. It refuses while employee-specific knowledge exists, because the older schema cannot hold it.
do $$
begin
  if exists (select 1 from employee_knowledge_entries) then
    raise exception 'Rollback refused: employee-specific knowledge entries exist. Export or remove them deliberately first.';
  end if;
  if exists (select 1 from knowledge_documents where agent_instance_id is not null) then
    raise exception 'Rollback refused: documents are assigned to individual employees. Return them to the shared library first.';
  end if;
end $$;

drop table if exists employee_knowledge_entries;
drop index if exists knowledge_documents_agent_idx;
alter table knowledge_documents drop constraint if exists knowledge_documents_agent_same_org;
alter table knowledge_documents
  drop column if exists agent_instance_id,
  drop column if exists risk_flags,
  drop column if exists last_used_at;
