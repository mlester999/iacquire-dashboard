-- 0117_company_knowledge_revisions.sql — a held knowledge edit never replaces approved text, and every saved version of a section is kept.
--
-- Before this, a flagged edit to a knowledge section overwrote `content` and only flipped review_status, so the approved text silently left every employee's prompt, and a
-- rejection wiped the section. A held employee note or flagged document had no way to be released at all. After this:
--   * company_knowledge.content is ALWAYS the approved text. A flagged edit waits in pending_content (with pending_flags) until the agency decides; approving promotes it,
--     rejecting drops it and the old text stays. Rows held by the old code (review_status = 'pending_agency_review') are left as they are and handled by the application.
--   * company_knowledge_revisions keeps one row per saved version (who, when, what text, whether it was approved, held, rejected or replaced) so a person can see and restore history.
--   * knowledge_documents.held_text is a quarantine for the text of a flagged document. It is never read for a prompt (the prompt reads extracted_text only), and the
--     two are never both set: a document's text is either released or held.
--
-- Prerequisites: 0002_workforce (company_knowledge, knowledge_documents), 0045_ai_workforce_experience (employee notes, document risk flags), 0046 (document statuses) and
-- 0060_rls_initplan (app.permitted_orgs, used by the policies). Additive: nothing is dropped or rewritten, so the previous release keeps working against the new schema
-- (it ignores the new columns and table).
--
-- Rollback: supabase/rollbacks/0117_company_knowledge_revisions.down.sql (refuses while a section has both approved text and a waiting edit).

alter table public.company_knowledge add column if not exists pending_content text;
alter table public.company_knowledge add column if not exists pending_flags text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'company_knowledge_pending_shape' and conrelid = 'public.company_knowledge'::regclass) then
    alter table public.company_knowledge add constraint company_knowledge_pending_shape check (
      (pending_content is null and cardinality(pending_flags) = 0)
      or (pending_content is not null and char_length(pending_content) <= 12000)
    );
  end if;
end $$;

comment on column public.company_knowledge.pending_content is
  'An edit held for agency review. Never read for a prompt; content stays the approved text until the agency approves this.';

alter table public.knowledge_documents add column if not exists held_text text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'knowledge_documents_held_text_shape' and conrelid = 'public.knowledge_documents'::regclass) then
    alter table public.knowledge_documents add constraint knowledge_documents_held_text_shape check (
      held_text is null or (char_length(held_text) <= 200000 and extracted_text is null)
    );
  end if;
end $$;

comment on column public.knowledge_documents.held_text is
  'The extracted text of a document held for review (a quarantine). Never read for a prompt; never set together with extracted_text.';

create table if not exists public.company_knowledge_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  section text not null check (char_length(section) between 1 and 64),
  -- The version this text had (or would have had) in company_knowledge. Unique per section, so a replay can never write the same version twice.
  version integer not null check (version > 0),
  content text not null check (char_length(content) <= 12000),
  -- approved: the text that became (or still is) the section. held: waiting for the agency. rejected: the agency declined it. superseded: a newer edit replaced it while it waited.
  review_status text not null default 'approved' check (review_status in ('approved', 'held', 'rejected', 'superseded')),
  risk_flags text[] not null default '{}',
  -- baseline: the text that was already there when history began (written the first time a section is edited after this migration).
  source text not null check (source in ('client', 'onboarding', 'agency', 'restore', 'baseline')),
  actor_user_id uuid references public.users(id) on delete set null,
  restored_from_version integer check (restored_from_version is null or restored_from_version > 0),
  decided_by uuid references public.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, section, version)
);
create index if not exists company_knowledge_revisions_section_idx on public.company_knowledge_revisions (org_id, section, version desc);

alter table public.company_knowledge_revisions enable row level security;
-- A person can read their workspace's history and add a revision of their own. They can never change or remove one: the decision columns are written by the server only.
grant select, insert on public.company_knowledge_revisions to iaq_app_user;

drop policy if exists company_knowledge_revisions_select on public.company_knowledge_revisions;
drop policy if exists company_knowledge_revisions_insert on public.company_knowledge_revisions;
create policy company_knowledge_revisions_select on public.company_knowledge_revisions for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('knowledge.view'::text))::uuid[]));
create policy company_knowledge_revisions_insert on public.company_knowledge_revisions for insert to iaq_app_user
  with check (org_id = ANY ((SELECT app.permitted_orgs('knowledge.edit'::text))::uuid[])
              and (actor_user_id is null or actor_user_id = app.current_user_id())
              and review_status in ('approved', 'held'));

comment on table public.company_knowledge_revisions is
  'Every saved version of a knowledge section, including edits that were held and what happened to them. Server code decides statuses; people can only read and add.';
