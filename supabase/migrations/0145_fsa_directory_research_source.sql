-- Add a disabled-by-default UK open-directory provider to existing policy and usage tables.
alter table public.lead_research_source_settings
  drop constraint lead_research_source_settings_source_check,
  add constraint lead_research_source_settings_source_check
    check (source in ('openstreetmap', 'company_website', 'fsa_directory'));

alter table public.lead_research_source_usage
  drop constraint lead_research_source_usage_source_check,
  add constraint lead_research_source_usage_source_check
    check (source in ('openstreetmap', 'company_website', 'fsa_directory'));
