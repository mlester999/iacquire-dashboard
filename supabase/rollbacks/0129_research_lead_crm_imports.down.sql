do $$
begin
  if exists (select 1 from public.leads where crm_company_id is not null or crm_contact_id is not null or crm_imported_at is not null) then
    raise exception 'Rollback refused: researched leads have native CRM import links. Export and retain the import audit before rollback.';
  end if;
end $$;

drop index if exists public.leads_crm_contact_idx;
drop index if exists public.leads_crm_company_idx;
alter table public.leads
  drop constraint if exists leads_crm_contact_same_org,
  drop constraint if exists leads_crm_company_same_org,
  drop column if exists crm_imported_at,
  drop column if exists crm_imported_by,
  drop column if exists crm_contact_id,
  drop column if exists crm_company_id;
