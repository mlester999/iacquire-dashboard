-- Gate automatic writes on a separately verified client-only runtime. The mixed
-- agency Hermes container must never satisfy this attestation by accident.
alter table public.hermes_gateways
  add column provisioner_isolation_verified_at timestamptz;

-- A profile's saved host configuration must track the currently applied portal version.
alter table public.agent_instances
  add column hermes_profile_config_version_id uuid
    references public.agent_config_versions(id) on delete set null;

-- Provisioning jobs carry only hashes and references; never profile keys or prompt content.
alter table public.agent_provisioning_jobs
  drop constraint agent_provisioning_jobs_kind_check;

alter table public.agent_provisioning_jobs
  add constraint agent_provisioning_jobs_kind_check
    check (kind in ('provision', 'sync', 'reconnect', 'deprovision')),
  add column config_version_id uuid
    references public.agent_config_versions(id) on delete set null,
  add column source_job_id uuid
    references public.agent_provisioning_jobs(id) on delete set null,
  add column manifest_soul_sha256 text
    check (manifest_soul_sha256 is null or manifest_soul_sha256 ~ '^[0-9a-f]{64}$'),
  add column manifest_policy_config_sha256 text
    check (manifest_policy_config_sha256 is null or manifest_policy_config_sha256 ~ '^[0-9a-f]{64}$'),
  add column manifest_challenge_sha256 text
    check (manifest_challenge_sha256 is null or manifest_challenge_sha256 ~ '^[0-9a-f]{64}$');

create index agent_provisioning_source_job_idx
  on public.agent_provisioning_jobs (source_job_id)
  where source_job_id is not null;
