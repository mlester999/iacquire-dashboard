do $$
begin
  if exists (select 1 from public.agent_provisioning_jobs where kind = 'sync') then
    raise exception 'archive or resolve Hermes sync jobs before rolling back 0084';
  end if;

  if exists (
    select 1 from public.agent_provisioning_jobs
     where status in ('requested', 'in_progress', 'awaiting_health_check')
  ) then
    raise exception 'finish or cancel active Hermes provisioning jobs before rolling back 0084';
  end if;

  if exists (
    select 1 from public.agent_provisioning_jobs
     where config_version_id is not null
        or source_job_id is not null
        or manifest_soul_sha256 is not null
        or manifest_policy_config_sha256 is not null
        or manifest_challenge_sha256 is not null
  ) then
    raise exception 'archive versioned Hermes provisioning evidence before rolling back 0084';
  end if;

  if exists (select 1 from public.agent_instances where hermes_profile_config_version_id is not null) then
    raise exception 'clear versioned Hermes profile mappings before rolling back 0084';
  end if;

  if exists (select 1 from public.hermes_gateways where provisioner_isolation_verified_at is not null) then
    raise exception 'remove client-runtime isolation attestations before rolling back 0084';
  end if;
end $$;

drop index if exists public.agent_provisioning_source_job_idx;

alter table public.agent_provisioning_jobs
  drop column manifest_challenge_sha256,
  drop column manifest_policy_config_sha256,
  drop column manifest_soul_sha256,
  drop column source_job_id,
  drop column config_version_id,
  drop constraint agent_provisioning_jobs_kind_check;

alter table public.agent_provisioning_jobs
  add constraint agent_provisioning_jobs_kind_check
    check (kind in ('provision', 'reconnect', 'deprovision'));

alter table public.agent_instances
  drop column hermes_profile_config_version_id;

alter table public.hermes_gateways
  drop column provisioner_isolation_verified_at;
