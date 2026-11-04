-- Refuse to discard source-linked signals. Export or retain them before rolling back this migration.
do $$
begin
  if exists (
    select 1 from public.leads
     where signal_records <> '[]'::jsonb
        or qualification_state is not null
        or coalesce(cardinality(qualification_reasons), 0) > 0
        or recommended_next_action is not null
  ) then
    raise exception 'Rollback refused: lead signal or qualification data exists. Export or retain it before removing the new columns.';
  end if;
end $$;

drop index if exists public.leads_org_qualification_created_idx;

alter table public.leads
  drop column if exists recommended_next_action,
  drop column if exists qualification_reasons,
  drop column if exists qualification_state,
  drop column if exists signal_records;
