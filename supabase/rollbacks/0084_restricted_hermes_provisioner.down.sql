do $$
begin
  if exists (select 1 from public.agent_provisioning_jobs where kind = 'sync') then
    raise exception 'archive or resolve Hermes sync jobs before rolling back 0084';
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
