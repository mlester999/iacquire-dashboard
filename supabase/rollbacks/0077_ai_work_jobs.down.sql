-- Rollback for 0077_ai_work_jobs.sql. NOT a migration: stop workforce workers first, review and run in one transaction.
-- Preserve completed work and research evidence; refuse if jobs, event history, job links or research metadata exist.

do $$
begin
  if exists (select 1 from ai_work_jobs)
     or exists (select 1 from ai_work_events)
     or exists (select 1 from lead_research_requests where work_job_id is not null)
     or exists (select 1 from chat_messages where work_job_id is not null)
     or exists (select 1 from leads where duplicate_matches <> '[]'::jsonb or public_contact <> '{}'::jsonb) then
    raise exception 'Rollback refused: workforce jobs, evidence, linked work or research metadata exist. Export them deliberately first.';
  end if;
end $$;

drop index if exists lead_research_work_job_unique;
drop index if exists chat_messages_work_job_idx;
alter table lead_research_requests drop constraint if exists lead_research_work_job_fk;
alter table chat_messages drop constraint if exists chat_messages_work_job_fk;

drop policy if exists ai_work_events_select on ai_work_events;
drop policy if exists ai_work_jobs_select on ai_work_jobs;
drop trigger if exists ai_work_jobs_touch on ai_work_jobs;
drop table ai_work_events;
drop table ai_work_jobs;

alter table leads
  drop column if exists public_contact,
  drop column if exists duplicate_matches;
alter table chat_messages drop column if exists work_job_id;
alter table lead_research_requests drop column if exists work_job_id;
