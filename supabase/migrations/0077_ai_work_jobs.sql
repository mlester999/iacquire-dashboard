-- Shared AI employee work foundation.
--
-- A work job is a durable record of business work an AI employee is authorized to perform. It is
-- deliberately separate from agent_runs: a run is one Hermes invocation (or one refused attempt),
-- while a job can span several runs, approvals and recovery attempts. The job owns its real stage,
-- progress counters, evidence events and terminal state; the UI reads only persisted rows.
--
-- Design rules:
--   * The server is the only writer. The client role gets SELECT under RLS and no write grant.
--   * Every row carries org_id; the composite foreign keys make a cross-tenant agent impossible.
--   * Status values match the product contract: queued, running, waiting_for_approval, blocked,
--     failed, cancelled, completed. Employee availability (online/busy/offline) is not stored here.
--   * Events are append-only and ordered by their identity. A stage label is stored next to the
--     event that produced it so progress can never be inferred from a client-side timer.
--   * Lease columns let a crashed worker's job be reclaimed without duplicating external effects;
--     idempotency_key is unique so a duplicated request cannot create a second job.

create table if not exists ai_work_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null,
  requested_by uuid references users(id) on delete set null,
  capability text not null check (capability ~ '^[a-z][a-z0-9_]{2,39}$'),
  title text not null check (char_length(title) between 1 and 200),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_for_approval', 'blocked', 'failed', 'cancelled', 'completed')),
  stage text check (stage is null or stage ~ '^[a-z][a-z0-9_]{2,39}$'),
  progress jsonb not null default '{}'::jsonb check (pg_column_size(progress) <= 16384),
  input jsonb not null default '{}'::jsonb check (pg_column_size(input) <= 32768),
  result jsonb not null default '{}'::jsonb check (pg_column_size(result) <= 32768),
  result_summary text check (char_length(result_summary) <= 1000),
  result_count integer not null default 0 check (result_count >= 0),
  failure_code text check (char_length(failure_code) <= 80),
  failure_message text check (char_length(failure_message) <= 1000),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 2 check (max_attempts between 1 and 10),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  conversation_id uuid,
  lease_owner text check (char_length(lease_owner) <= 100),
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint ai_work_jobs_agent_same_org foreign key (agent_instance_id, org_id)
    references agent_instances (id, org_id) on delete cascade
);
create index if not exists ai_work_jobs_claim_idx on ai_work_jobs (status, created_at) where status = 'queued';
create index if not exists ai_work_jobs_running_idx on ai_work_jobs (lease_expires_at) where status = 'running';
create index if not exists ai_work_jobs_org_idx on ai_work_jobs (org_id, created_at desc);
create index if not exists ai_work_jobs_agent_idx on ai_work_jobs (agent_instance_id, created_at desc);
create index if not exists ai_work_jobs_conversation_idx on ai_work_jobs (conversation_id) where conversation_id is not null;
drop trigger if exists ai_work_jobs_touch on ai_work_jobs;
create trigger ai_work_jobs_touch before update on ai_work_jobs
  for each row execute function app.touch_updated_at();

create table if not exists ai_work_events (
  id bigserial primary key,
  job_id uuid not null references ai_work_jobs(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('stage', 'progress', 'notice', 'evidence', 'error', 'approval')),
  stage text check (stage is null or stage ~ '^[a-z][a-z0-9_]{2,39}$'),
  message text not null check (char_length(message) between 1 and 500),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) <= 16384),
  created_at timestamptz not null default now()
);
create index if not exists ai_work_events_job_idx on ai_work_events (job_id, id);
create index if not exists ai_work_events_org_idx on ai_work_events (org_id, created_at desc);

-- Link existing records to the shared job layer without duplicating either table.
alter table lead_research_requests add column if not exists work_job_id uuid;
alter table chat_messages add column if not exists work_job_id uuid;
alter table leads add column if not exists duplicate_matches jsonb not null default '[]'::jsonb
  check (pg_column_size(duplicate_matches) <= 16384);
-- Only publicly available business contact information that a source actually states. The
-- research contract never accepts guessed emails, phones or personal profiles.
alter table leads add column if not exists public_contact jsonb not null default '{}'::jsonb
  check (pg_column_size(public_contact) <= 4096);
create unique index if not exists lead_research_work_job_unique
  on lead_research_requests (work_job_id) where work_job_id is not null;
create index if not exists chat_messages_work_job_idx
  on chat_messages (work_job_id) where work_job_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lead_research_work_job_fk') then
    alter table lead_research_requests
      add constraint lead_research_work_job_fk foreign key (work_job_id)
      references ai_work_jobs (id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_work_job_fk') then
    alter table chat_messages
      add constraint chat_messages_work_job_fk foreign key (work_job_id)
      references ai_work_jobs (id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_work_jobs_conversation_fk') then
    alter table ai_work_jobs
      add constraint ai_work_jobs_conversation_fk foreign key (conversation_id)
      references chat_conversations (id) on delete set null;
  end if;
end $$;

alter table ai_work_jobs enable row level security;
alter table ai_work_events enable row level security;

-- Server-only writes: the application reads as the signed-in user, but enqueue/claim/heartbeat/
-- finish all run through withSystem after an explicit server-side authorization check.
revoke all on ai_work_jobs from public, anon, authenticated;
revoke all on ai_work_events from public, anon, authenticated;
grant select on ai_work_jobs to iaq_app_user;
grant select on ai_work_events to iaq_app_user;

drop policy if exists ai_work_jobs_select on ai_work_jobs;
drop policy if exists ai_work_events_select on ai_work_events;
-- A regular member can read their own work and ordinary research jobs. A workspace-wide proactive
-- review can contain approval titles and contact names, so it is visible only to the person who
-- requested it or to someone with the Activity permission. The server also checks this in code;
-- this policy is the database-level defence.
do $$
begin
  if to_regprocedure('app.permitted_orgs(text)') is null then
    execute $p$create policy ai_work_jobs_select on ai_work_jobs for select to iaq_app_user
      using (
        app.has_permission(org_id, 'agents.use'::text)
        and (capability <> 'proactive_review' or requested_by = app.current_user_id() or app.has_permission(org_id, 'activity.view'::text))
      )$p$;
    execute $p$create policy ai_work_events_select on ai_work_events for select to iaq_app_user
      using (
        app.has_permission(org_id, 'agents.use'::text)
        and exists (
          select 1 from ai_work_jobs j
           where j.id = job_id and j.org_id = org_id
             and (j.capability <> 'proactive_review' or j.requested_by = app.current_user_id() or app.has_permission(j.org_id, 'activity.view'::text))
        )
      )$p$;
  else
    execute $p$create policy ai_work_jobs_select on ai_work_jobs for select to iaq_app_user
      using (
        org_id = ANY ((SELECT app.permitted_orgs('agents.use'::text))::uuid[])
        and (capability <> 'proactive_review' or requested_by = app.current_user_id() or app.has_permission(org_id, 'activity.view'::text))
      )$p$;
    execute $p$create policy ai_work_events_select on ai_work_events for select to iaq_app_user
      using (
        org_id = ANY ((SELECT app.permitted_orgs('agents.use'::text))::uuid[])
        and exists (
          select 1 from ai_work_jobs j
           where j.id = job_id and j.org_id = org_id
             and (j.capability <> 'proactive_review' or j.requested_by = app.current_user_id() or app.has_permission(j.org_id, 'activity.view'::text))
        )
      )$p$;
  end if;
end $$;
