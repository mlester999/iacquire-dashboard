-- Owner-approved local preparation artifacts. Runtime and scheduler discovery never read this table.
create table ai_growth_partner_migration_preparations (
  org_id uuid not null,
  plan_id uuid not null,
  partner_id uuid not null,
  candidate_runtime_id uuid not null unique default gen_random_uuid(),
  brain_version integer not null,
  previous_brain_version integer,
  replacement_schedules jsonb not null check (
    jsonb_typeof(replacement_schedules) = 'array' and pg_column_size(replacement_schedules) <= 131072
  ),
  prepared_by uuid references users(id) on delete set null,
  prepared_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  primary key (org_id, plan_id),
  foreign key (org_id, plan_id) references ai_growth_partner_migration_plans (org_id, id) on delete cascade,
  foreign key (org_id, partner_id, brain_version) references ai_growth_partner_versions (org_id, partner_id, version),
  foreign key (org_id, partner_id, previous_brain_version) references ai_growth_partner_versions (org_id, partner_id, version)
);

alter table ai_growth_partner_migration_preparations enable row level security;
revoke all on ai_growth_partner_migration_preparations from public, anon, authenticated, iaq_app_user, iaq_site_runtime;

comment on table ai_growth_partner_migration_preparations is
  'Review-bound local runtime and disabled schedule artifacts. They are never a runnable workforce runtime or schedule.';
