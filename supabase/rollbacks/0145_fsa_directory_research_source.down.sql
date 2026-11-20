do $$
begin
  lock table public.lead_research_source_settings, public.lead_research_source_usage in access exclusive mode;
  if exists (select 1 from public.lead_research_source_settings where source = 'fsa_directory')
    or exists (select 1 from public.lead_research_source_usage where source = 'fsa_directory') then
    raise exception 'Rollback refused: FSA directory approval or usage records exist.';
  end if;
  alter table public.lead_research_source_settings
    drop constraint lead_research_source_settings_source_check,
    add constraint lead_research_source_settings_source_check
      check (source in ('openstreetmap', 'company_website'));
  alter table public.lead_research_source_usage
    drop constraint lead_research_source_usage_source_check,
    add constraint lead_research_source_usage_source_check
      check (source in ('openstreetmap', 'company_website'));
end $$;
