-- Rollback for 0117_company_knowledge_revisions.sql. NOT a migration: the Supabase CLI does not run this folder.
-- Review it, take a backup, release the application version that still reads pending_content first, and run it in one transaction.
-- It refuses while a section holds BOTH approved text and a waiting edit, because the older schema has a single text column and one of them would be lost.
-- A waiting edit on a section with no approved text moves back into the old shape (content plus review_status = 'pending_agency_review'), so nothing waiting is dropped.
-- Revision history is dropped with its table: it is a copy of earlier text, and every approved version that is current stays in company_knowledge.
-- knowledge_documents.held_text is a copy of text that can be extracted again from the stored file, so it is dropped without ceremony.
do $$
begin
  if exists (select 1 from public.company_knowledge where pending_content is not null and content <> '') then
    raise exception 'Rollback refused: a knowledge section has approved text and a waiting edit. Approve or reject the waiting edits first.';
  end if;
end $$;

update public.company_knowledge
   set content = pending_content, risk_flags = pending_flags, review_status = 'pending_agency_review'
 where pending_content is not null and content = '';

drop table if exists public.company_knowledge_revisions;
alter table public.knowledge_documents drop constraint if exists knowledge_documents_held_text_shape;
alter table public.knowledge_documents drop column if exists held_text;
alter table public.company_knowledge drop constraint if exists company_knowledge_pending_shape;
alter table public.company_knowledge
  drop column if exists pending_content,
  drop column if exists pending_flags;
