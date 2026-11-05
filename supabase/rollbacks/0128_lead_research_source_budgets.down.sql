-- Keep source provenance and budget history until it has been explicitly exported and retained.
do $$
begin
  if exists (select 1 from public.lead_research_source_usage) then
    raise exception 'Rollback refused: lead research source usage exists. Export and retain the ledger before removing it.';
  end if;
  if exists (select 1 from public.lead_research_source_settings where enabled) then
    raise exception 'Rollback refused: a lead research source is enabled. Disable it before rollback.';
  end if;
end $$;

drop policy if exists lead_research_source_usage_select on public.lead_research_source_usage;
drop policy if exists lead_research_source_settings_select on public.lead_research_source_settings;
drop index if exists public.lead_research_source_usage_job_idx;
drop index if exists public.lead_research_source_usage_daily_idx;
drop trigger if exists lead_research_source_settings_touch on public.lead_research_source_settings;
drop table if exists public.lead_research_source_usage;
drop table if exists public.lead_research_source_settings;
alter table public.lead_research_requests drop constraint if exists lead_research_requests_id_org_unique;
alter table public.ai_work_jobs drop constraint if exists ai_work_jobs_id_org_unique;
