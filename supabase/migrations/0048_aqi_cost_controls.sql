-- AQi cost controls. Applied to hosted Supabase on 2026-10-18; these tables add the budget and
-- pricing state needed to enforce spend before a provider request starts.
create table if not exists aqi_budgets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  enabled boolean not null default false,
  monthly_org_micros bigint not null default 0 check (monthly_org_micros >= 0),
  monthly_user_micros bigint not null default 0 check (monthly_user_micros >= 0),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index if not exists aqi_budgets_global_unique on aqi_budgets ((1)) where org_id is null;
create unique index if not exists aqi_budgets_org_unique on aqi_budgets (org_id) where org_id is not null;

create table if not exists aqi_model_prices (
  model text primary key,
  input_micros_per_million bigint not null check (input_micros_per_million >= 0),
  output_micros_per_million bigint not null check (output_micros_per_million >= 0),
  enabled boolean not null default true,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table aqi_usage_events drop constraint if exists aqi_usage_events_kind_check;
alter table aqi_usage_events add constraint aqi_usage_events_kind_check
  check (kind in ('message', 'feedback', 'config_publish', 'reservation', 'rate_limit'));
alter table aqi_usage_events add column if not exists status text not null default 'recorded'
  check (status in ('reserved', 'recorded', 'released', 'failed'));
alter table aqi_usage_events add column if not exists reserved_cost_micros bigint
  check (reserved_cost_micros is null or reserved_cost_micros >= 0);
alter table aqi_usage_events add column if not exists cost_micros bigint
  check (cost_micros is null or cost_micros >= 0);
alter table aqi_usage_events add column if not exists cost_estimated boolean not null default false;
alter table aqi_usage_events add column if not exists config_version_id uuid references aqi_config_versions(id) on delete set null;
alter table aqi_usage_events add column if not exists page_route text;
create index if not exists aqi_usage_budget_idx on aqi_usage_events (org_id, created_at) where status in ('reserved','recorded','failed');
create index if not exists aqi_usage_user_budget_idx on aqi_usage_events (user_id, created_at) where status in ('reserved','recorded','failed');

alter table aqi_budgets enable row level security;
alter table aqi_model_prices enable row level security;

insert into aqi_budgets (org_id, enabled, monthly_org_micros, monthly_user_micros)
values (null, false, 0, 0)
on conflict do nothing;
