-- Health probes establish operational history and outage state; do not erase either during rollback.
do $$
begin
  if exists (select 1 from public.agent_health_probes) then
    raise exception 'retain employee health-probe history before rolling back 0109';
  end if;

  if exists (
    select 1 from public.agent_instances
    where health_consecutive_failures <> 0
       or last_healthy_at is not null
       or last_health_failure_at is not null
       or last_probe_at is not null
       or last_probe_source is not null
       or health_alerted_at is not null
  ) then
    raise exception 'retain employee health-probe state before rolling back 0109';
  end if;
end $$;

drop table public.agent_health_probes;

alter table public.agent_instances
  drop column health_alerted_at,
  drop column last_probe_source,
  drop column last_probe_at,
  drop column last_health_failure_at,
  drop column last_healthy_at,
  drop column health_consecutive_failures;
