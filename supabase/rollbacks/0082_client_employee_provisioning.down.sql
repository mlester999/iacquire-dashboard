drop index if exists public.agent_provisioning_retry_queue;
alter table public.agent_provisioning_jobs
  drop column if exists result_reference,
  drop column if exists lease_expires_at,
  drop column if exists lease_token,
  drop column if exists next_retry_at,
  drop column if exists attempt_count;
drop index if exists public.agent_provisioning_one_open_per_employee;
