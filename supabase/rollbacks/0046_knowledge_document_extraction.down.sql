-- Rollback for 0046_knowledge_document_extraction.sql. NOT a migration: the Supabase CLI does not run this folder.
-- It must run after 0045's schema has been rolled forward in the same deployment; this rollback is ordered last.
-- It refuses while documents are mid-processing or in a state the older schema cannot represent.
do $$
begin
  if exists (select 1 from knowledge_documents where status in ('processing', 'failed', 'unsupported')) then
    raise exception 'Rollback refused: documents are processing, failed or unsupported. Resolve or remove them deliberately first.';
  end if;
end $$;

alter table knowledge_documents drop constraint if exists knowledge_documents_status_check;
alter table knowledge_documents add constraint knowledge_documents_status_check
  check (status in ('uploaded', 'ready', 'rejected', 'deleted'));
alter table knowledge_documents
  drop column if exists processing_detail,
  drop column if exists extraction_method,
  drop column if exists processed_at;
