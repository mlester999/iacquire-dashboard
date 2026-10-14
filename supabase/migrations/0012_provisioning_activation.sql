-- Preparation jobs never activate external resources. Existing setup tables are reused.
create table provisioning_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  operation text not null check (operation in ('prepare_ai_configuration', 'prepare_automation_configuration', 'manual_ghl_mapping', 'manual_hermes_profiles', 'verify_integrations')),
  status text not null default 'queued' check (status in ('queued', 'running', 'awaiting_admin', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  last_error text check (char_length(last_error) <= 500),
  next_retry_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  external_resource_ids jsonb not null default '{}'::jsonb check (pg_column_size(external_resource_ids) <= 16384),
  prepared_configuration jsonb not null default '{}'::jsonb check (pg_column_size(prepared_configuration) <= 32768),
  requested_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, operation, idempotency_key),
  unique (id, org_id),
  check ((status = 'running') = (lease_token is not null and lease_expires_at is not null))
);
create index provisioning_jobs_queue_idx on provisioning_jobs (org_id, status, next_retry_at, created_at);
create trigger provisioning_jobs_touch before update on provisioning_jobs for each row execute function app.touch_updated_at();
create table provisioning_job_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  status text not null check (status in ('running', 'succeeded', 'failed', 'awaiting_admin', 'interrupted')),
  error_summary text check (char_length(error_summary) <= 500),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (job_id, org_id) references provisioning_jobs(id, org_id) on delete cascade,
  unique (job_id, attempt_number),
  check ((status = 'running') = (finished_at is null))
);
create index provisioning_job_attempts_history_idx on provisioning_job_attempts (org_id, job_id, attempt_number);
create table activation_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  setup_instance_id uuid not null,
  reviewed_by uuid not null references users(id),
  decision text not null check (decision in ('approved', 'blocked')),
  setup_revision bigint not null,
  readiness_snapshot jsonb not null check (pg_column_size(readiness_snapshot) <= 32768),
  note text not null default '' check (char_length(note) <= 2000),
  -- Records portal approval only. External live activation is a separate authorized operation.
  external_activation_authorized boolean not null default false check (external_activation_authorized = false),
  created_at timestamptz not null default now(),
  foreign key (setup_instance_id, org_id) references client_setup_instances(id, org_id)
);
create index activation_reviews_org_idx on activation_reviews (org_id, created_at desc);
create trigger activation_reviews_no_update before update on activation_reviews for each row execute function app.setup_events_no_update();

alter table provisioning_jobs enable row level security;
alter table provisioning_job_attempts enable row level security;
alter table activation_reviews enable row level security;
revoke all on provisioning_jobs, provisioning_job_attempts, activation_reviews from public, anon, authenticated;
-- Internal configuration, job errors and review evidence are never client-readable.
grant select on provisioning_jobs, provisioning_job_attempts, activation_reviews to iaq_app_user;
create policy provisioning_jobs_agency_select on provisioning_jobs for select to iaq_app_user using (app.staff_assigned(org_id));
create policy provisioning_attempts_agency_select on provisioning_job_attempts for select to iaq_app_user using (app.staff_assigned(org_id));
create policy activation_reviews_agency_select on activation_reviews for select to iaq_app_user using (app.staff_assigned(org_id));

-- Retain all historical evidence; withdraw technical completion that was only an attestation.
insert into client_setup_task_events (org_id, instance_id, actor_kind, event, reason, visibility, metadata)
select i.org_id, i.id, 'system', 'sent_back',
 'Agency approval withdrawn until required provider checks pass; prior approval details are retained here.', 'internal',
 jsonb_build_object('previous_state', i.state, 'previous_activated_at', i.activated_at,
  'previous_activated_by', i.activated_by, 'previous_activation_note', i.activation_note)
from client_setup_instances i where i.state in ('activated','ready_for_review') and exists (
 select 1 from client_setup_tasks t where t.instance_id = i.id and t.completion_mode = 'verified'
  and t.status = 'completed' and t.completion_source = 'attestation');
update client_setup_instances i set state = 'in_setup', activated_at = null, activated_by = null,
 activation_note = null, ready_for_review_at = null, ready_for_review_by = null, revision = revision + 1
where i.state in ('activated','ready_for_review') and exists (
 select 1 from client_setup_tasks t where t.instance_id = i.id and t.completion_mode = 'verified'
  and t.status = 'completed' and t.completion_source = 'attestation');
insert into client_setup_task_events (org_id, instance_id, task_id, actor_kind, event, from_status, to_status, reason, visibility)
select org_id, instance_id, id, 'system', 'reopened', 'completed', 'ready_for_review',
 'Technical completion now requires a provider check. The original attestation and history are retained.', 'internal'
from client_setup_tasks where completion_mode = 'verified' and status = 'completed' and completion_source = 'attestation';
update client_setup_tasks set status = 'ready_for_review', completed_at = null, completed_by = null,
 completion_source = null, completion_note = null, verified_at = null, verified_detail = null
where completion_mode = 'verified' and status = 'completed' and completion_source = 'attestation';
alter table client_setup_tasks add constraint technical_completion_requires_connector
 check (status <> 'completed' or completion_mode <> 'verified' or completion_source = 'connector');
-- Existing final-health aggregate results from the old attestation semantics need a fresh test.
update client_setup_checks set status = 'unverified', source = null,
 detail = 'Run final verification under the current technical readiness rules.' where check_key = 'final_health';
