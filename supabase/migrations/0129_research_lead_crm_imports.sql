-- Keep the native CRM records created from a reviewed lead linked back to their research source.
-- The links are tenant-safe and let retries reuse the existing company/contact.

alter table public.leads
  add column crm_company_id uuid,
  add column crm_contact_id uuid,
  add column crm_imported_by uuid references public.users(id) on delete set null,
  add column crm_imported_at timestamptz;

alter table public.leads
  add constraint leads_crm_company_same_org
    foreign key (crm_company_id, org_id)
    references public.crm_companies (id, org_id)
    on delete set null (crm_company_id),
  add constraint leads_crm_contact_same_org
    foreign key (crm_contact_id, org_id)
    references public.contacts (id, org_id)
    on delete set null (crm_contact_id);

create index leads_crm_company_idx on public.leads (org_id, crm_company_id) where crm_company_id is not null;
create index leads_crm_contact_idx on public.leads (org_id, crm_contact_id) where crm_contact_id is not null;

comment on column public.leads.crm_company_id is
  'Same-tenant native CRM company created or reused after this researched business was approved for import.';
comment on column public.leads.crm_contact_id is
  'Same-tenant native CRM contact created or reused only when the source supplied a public contact identity.';
