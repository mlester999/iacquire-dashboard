-- Tenant-scoped, disabled-by-default policies and an append-oriented usage ledger for approved
-- lead-research sources. This migration does not activate a source or contact a provider.

alter table public.ai_work_jobs
  add constraint ai_work_jobs_id_org_unique unique (id, org_id);

alter table public.lead_research_requests
  add constraint lead_research_requests_id_org_unique unique (id, org_id);

create table public.lead_research_source_settings (
  org_id uuid not null references public.organizations(id) on delete cascade,
  source text not null check (source in ('openstreetmap', 'company_website')),
  enabled boolean not null default false,
  source_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_config) = 'object' and pg_column_size(source_config) <= 16384),
  provider_fee_usd_per_request numeric(12, 6) not null default 0
    check (provider_fee_usd_per_request between 0 and 1000000),
  per_job_request_cap integer not null default 0 check (per_job_request_cap between 0 and 10000),
  per_day_request_cap integer not null default 0 check (per_day_request_cap between 0 and 100000),
  per_job_spend_cap_usd numeric(12, 6) not null default 0
    check (per_job_spend_cap_usd between 0 and 1000000),
  per_day_spend_cap_usd numeric(12, 6) not null default 0
    check (per_day_spend_cap_usd between 0 and 1000000),
  approved_by uuid references public.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, source),
  check ((enabled = false) or (approved_by is not null and approved_at is not null)),
  check (per_job_spend_cap_usd >= provider_fee_usd_per_request),
  check (per_day_spend_cap_usd >= provider_fee_usd_per_request)
);

create trigger lead_research_source_settings_touch
  before update on public.lead_research_source_settings
  for each row execute function app.touch_updated_at();

create table public.lead_research_source_usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  work_job_id uuid not null,
  research_request_id uuid not null,
  source text not null check (source in ('openstreetmap', 'company_website')),
  sequence integer not null check (sequence > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'responded', 'transport_failed')),
  request_url text not null check (char_length(request_url) between 1 and 1000),
  http_status integer check (http_status between 100 and 599),
  provider_fee_usd numeric(12, 6) not null check (provider_fee_usd between 0 and 1000000),
  infrastructure_cost_usd numeric(12, 6)
    check (infrastructure_cost_usd is null or infrastructure_cost_usd between 0 and 1000000),
  policy_snapshot jsonb not null check (jsonb_typeof(policy_snapshot) = 'object' and pg_column_size(policy_snapshot) <= 16384),
  result_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result_metadata) = 'object' and pg_column_size(result_metadata) <= 4096),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint lead_research_source_usage_request_status_check
    check ((status = 'reserved') = (completed_at is null)),
  constraint lead_research_source_usage_job_tenant_fk
    foreign key (work_job_id, org_id) references public.ai_work_jobs (id, org_id) on delete cascade,
  constraint lead_research_source_usage_request_tenant_fk
    foreign key (research_request_id, org_id) references public.lead_research_requests (id, org_id) on delete cascade,
  constraint lead_research_source_usage_policy_tenant_fk
    foreign key (org_id, source) references public.lead_research_source_settings (org_id, source) on delete restrict,
  constraint lead_research_source_usage_sequence_unique
    unique (org_id, work_job_id, source, sequence)
);

create index lead_research_source_usage_daily_idx
  on public.lead_research_source_usage (org_id, source, created_at desc);
create index lead_research_source_usage_job_idx
  on public.lead_research_source_usage (org_id, work_job_id, source, sequence);

alter table public.lead_research_source_settings enable row level security;
alter table public.lead_research_source_usage enable row level security;
revoke all on public.lead_research_source_settings, public.lead_research_source_usage from public, anon, authenticated, iaq_site_runtime;
grant select on public.lead_research_source_settings, public.lead_research_source_usage to iaq_app_user;

create policy lead_research_source_settings_select on public.lead_research_source_settings
  for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('leads.research'::text))::uuid[]));
create policy lead_research_source_usage_select on public.lead_research_source_usage
  for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('leads.research'::text))::uuid[]));

comment on table public.lead_research_source_settings is
  'Tenant-scoped, owner-approved source configuration. All sources are disabled and have zero request budgets until explicitly configured.';
comment on table public.lead_research_source_usage is
  'Persistent per-request source budget ledger. Reserved attempts count toward caps before network access begins.';
