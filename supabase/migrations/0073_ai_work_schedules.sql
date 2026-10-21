-- Tenant-scoped AI workforce schedules.
--
-- A schedule is a reviewed, read-only capability plus a cadence. It is disabled by default and is
-- additionally gated by the operator's WORKFORCE_SCHEDULES_ENABLED switch, so creating a row never
-- starts autonomous work by itself. The scheduler tick only creates durable jobs; the workforce
-- worker executes them. Every row is tenant- and employee-scoped.

create table if not exists ai_work_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null,
  created_by uuid references users(id) on delete set null,
  capability text not null check (capability ~ '^[a-z][a-z0-9_]{2,39}$'),
  cadence text not null default 'daily' check (cadence in ('hourly', 'daily', 'weekly')),
  interval_minutes integer not null default 1440 check (interval_minutes between 60 and 10080),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  enabled boolean not null default false,
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_job_id uuid references ai_work_jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_instance_id, capability),
  constraint ai_work_schedules_agent_same_org foreign key (agent_instance_id, org_id)
    references agent_instances (id, org_id) on delete cascade
);
create index if not exists ai_work_schedules_due_idx on ai_work_schedules (next_run_at) where enabled;
create index if not exists ai_work_schedules_org_idx on ai_work_schedules (org_id, created_at desc);
drop trigger if exists ai_work_schedules_touch on ai_work_schedules;
create trigger ai_work_schedules_touch before update on ai_work_schedules
  for each row execute function app.touch_updated_at();

alter table ai_work_schedules enable row level security;
revoke all on ai_work_schedules from public, anon, authenticated;
grant select on ai_work_schedules to iaq_app_user;

drop policy if exists ai_work_schedules_select on ai_work_schedules;
do $$
begin
  if to_regprocedure('app.permitted_orgs(text)') is null then
    execute $p$create policy ai_work_schedules_select on ai_work_schedules for select to iaq_app_user
      using (app.has_permission(org_id, 'agents.configure'::text))$p$;
  else
    execute $p$create policy ai_work_schedules_select on ai_work_schedules for select to iaq_app_user
      using (org_id = ANY ((SELECT app.permitted_orgs('agents.configure'::text))::uuid[]))$p$;
  end if;
end $$;
