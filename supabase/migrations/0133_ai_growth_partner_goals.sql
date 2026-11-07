-- 0133: persistent, tenant-scoped numeric goals for the unified AI Growth Partner.
-- Goal rows are edited only through audited server actions; the application SQL role may read them under RLS.
create table ai_growth_partner_goals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  partner_id uuid not null,
  metric_key text not null check (metric_key in ('leads_created', 'leads_approved', 'appointments_booked', 'deals_won')),
  cadence text not null check (cadence in ('weekly', 'monthly')),
  target_value integer not null check (target_value between 1 and 100000),
  enabled boolean not null default true,
  revision integer not null default 1 check (revision > 0),
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_growth_partner_goals_partner_tenant_fk
    foreign key (partner_id, org_id) references ai_growth_partners (id, org_id) on delete cascade,
  constraint ai_growth_partner_goals_unique unique (org_id, partner_id, metric_key, cadence)
);

create index ai_growth_partner_goals_active_idx
  on ai_growth_partner_goals (org_id, partner_id, metric_key, cadence)
  where enabled;

create trigger ai_growth_partner_goals_touch before update on ai_growth_partner_goals
  for each row execute function app.touch_updated_at();

alter table ai_growth_partner_goals enable row level security;
revoke all on ai_growth_partner_goals from public, anon, authenticated, iaq_site_runtime;
grant select on ai_growth_partner_goals to iaq_app_user;
create policy ai_growth_partner_goals_select on ai_growth_partner_goals for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('agents.use'::text))::uuid[]));

comment on table ai_growth_partner_goals is
  'Owner-managed numeric Growth Partner targets. Progress is calculated from the same tenant records and definitions used by measured performance reports; targets never imply guaranteed results.';
comment on column ai_growth_partner_goals.metric_key is
  'A bounded KPI key with a matching measured definition in the Performance Snapshot; only these four metrics can be targeted.';
