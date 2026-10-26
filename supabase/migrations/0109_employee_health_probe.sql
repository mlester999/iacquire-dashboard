-- Scheduled health probe for AI employees: what a probe found, kept as a short record the screens, the Super Admin and the alerts read.
--
-- The probe itself is src/server/workforce/health-probe.ts. It reuses the authenticated, non-destructive health check (capabilities, identity, toolsets and the complete tool
-- inventory, read twice) and spends no model tokens and sends no customer message. This migration only adds the memory it needs:
--   * on agent_instances: how many probes failed IN A ROW, when the employee was last seen healthy, when the last probe failed and ran, who started it, and when the agency was last
--     alerted about the current outage (so one outage is one alert, not one per probe).
--   * agent_health_probes: one row per probe attempt (the outcome, the status it left the employee in, how long it took and how many tries), trimmed by the retention job.
-- The server is the only writer. The signed-in role reads the probe log of the workspaces it may use AI employees in, and nothing else.

alter table agent_instances
  add column if not exists health_consecutive_failures integer not null default 0 check (health_consecutive_failures >= 0),
  add column if not exists last_healthy_at timestamptz,
  add column if not exists last_health_failure_at timestamptz,
  add column if not exists last_probe_at timestamptz,
  add column if not exists last_probe_source text check (last_probe_source is null or last_probe_source in ('scheduled', 'manual')),
  add column if not exists health_alerted_at timestamptz;

comment on column agent_instances.health_consecutive_failures is 'Failed health probes in a row since the employee was last healthy; a passing check resets it to zero.';
comment on column agent_instances.health_alerted_at is 'When the agency was told the employee became unavailable; cleared when it recovers, so one outage raises one alert.';

create table if not exists agent_health_probes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null,
  source text not null check (source in ('scheduled', 'manual')),
  ok boolean not null,
  status text not null check (status in ('setup_required', 'provisioning', 'online', 'busy', 'offline', 'error', 'disabled')),
  detail text check (detail is null or char_length(detail) <= 500),
  attempts integer not null default 1 check (attempts between 1 and 5),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  probed_at timestamptz not null default now(),
  constraint agent_health_probes_agent_same_org foreign key (agent_instance_id, org_id)
    references agent_instances (id, org_id) on delete cascade
);
create index if not exists agent_health_probes_agent_idx on agent_health_probes (agent_instance_id, probed_at desc);
create index if not exists agent_health_probes_age_idx on agent_health_probes (probed_at);

alter table agent_health_probes enable row level security;
revoke all on agent_health_probes from public, anon, authenticated;
grant select on agent_health_probes to iaq_app_user;

drop policy if exists agent_health_probes_select on agent_health_probes;
create policy agent_health_probes_select on agent_health_probes for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('agents.use'::text))::uuid[]));
