-- Tenant-scoped AI workforce event triggers.
--
-- A trigger maps one reviewed CRM event type to one reviewed, read-only capability. It is disabled
-- by default and is additionally gated by the operator's WORKFORCE_TRIGGERS_ENABLED switch. The
-- scheduler tick creates durable jobs for new events; the worker executes them. Nothing is
-- activated by creating a row.

create table if not exists ai_work_triggers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null,
  created_by uuid references users(id) on delete set null,
  capability text not null check (capability ~ '^[a-z][a-z0-9_]{2,39}$'),
  event_type text not null check (event_type ~ '^[a-z_]+\.[a-z_]+$' and char_length(event_type) <= 60),
  enabled boolean not null default false,
  last_event_id bigint not null default 0 check (last_event_id >= 0),
  last_job_id uuid references ai_work_jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_instance_id, capability, event_type),
  constraint ai_work_triggers_agent_same_org foreign key (agent_instance_id, org_id)
    references agent_instances (id, org_id) on delete cascade
);
create index if not exists ai_work_triggers_enabled_idx on ai_work_triggers (event_type) where enabled;
create index if not exists ai_work_triggers_org_idx on ai_work_triggers (org_id, created_at desc);
drop trigger if exists ai_work_triggers_touch on ai_work_triggers;
create trigger ai_work_triggers_touch before update on ai_work_triggers
  for each row execute function app.touch_updated_at();

alter table ai_work_triggers enable row level security;
revoke all on ai_work_triggers from public, anon, authenticated;
grant select on ai_work_triggers to iaq_app_user;

drop policy if exists ai_work_triggers_select on ai_work_triggers;
do $$
begin
  if to_regprocedure('app.permitted_orgs(text)') is null then
    execute $p$create policy ai_work_triggers_select on ai_work_triggers for select to iaq_app_user
      using (app.has_permission(org_id, 'agents.configure'::text))$p$;
  else
    execute $p$create policy ai_work_triggers_select on ai_work_triggers for select to iaq_app_user
      using (org_id = ANY ((SELECT app.permitted_orgs('agents.configure'::text))::uuid[]))$p$;
  end if;
end $$;
