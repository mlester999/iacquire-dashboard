-- A retry or two concurrent onboarding submissions must share one live provisioning request.
-- Review and resolve any pre-existing duplicate open jobs before applying this migration.
create unique index agent_provisioning_one_open_per_employee
  on public.agent_provisioning_jobs (agent_instance_id)
  where status in ('requested', 'in_progress', 'awaiting_health_check');

alter table public.agent_provisioning_jobs
  add column attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  add column next_retry_at timestamptz,
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column result_reference text check (char_length(result_reference) <= 300);

create index agent_provisioning_retry_queue
  on public.agent_provisioning_jobs (next_retry_at, created_at)
  where status in ('requested', 'failed');
