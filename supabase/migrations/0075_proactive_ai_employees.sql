-- Proactive AI employee reports and business-hours schedules.
--
-- A report is the durable record behind a proactive card. It is written only after a reviewed
-- capability actually ran and recorded its findings. Delivery is tracked per recipient so severity
-- thresholds, quiet hours and daily digests can be applied without a second notification system.
--
-- Client roles never write these tables. They can read a workspace report only with activity.view,
-- and a delivery only for themselves. Every write is server-side after an explicit authorization
-- check in src/server/workforce/reports.ts.

create table if not exists ai_work_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid,
  job_id uuid references ai_work_jobs(id) on delete set null,
  capability text check (capability is null or capability ~ '^[a-z][a-z0-9_]{2,39}$'),
  kind text not null check (kind in ('alert', 'recommendation', 'completion', 'blocker', 'approval_request', 'daily_briefing', 'weekly_summary')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  title text not null check (char_length(title) between 1 and 200),
  summary text not null check (char_length(summary) between 1 and 2000),
  sections jsonb not null default '[]'::jsonb check (pg_column_size(sections) <= 32768),
  findings jsonb not null default '[]'::jsonb check (pg_column_size(findings) <= 32768),
  evidence jsonb not null default '[]'::jsonb check (pg_column_size(evidence) <= 16384),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) <= 32768),
  actions jsonb not null default '[]'::jsonb check (pg_column_size(actions) <= 16384),
  /** Unique per job or per briefing slot. A retry can never create a second report for the same work. */
  dedupe_key text not null unique check (char_length(dedupe_key) between 8 and 240),
  /** Deduplication for the human alert. A repeated condition on the same local day is not announced twice. */
  alert_key text not null check (char_length(alert_key) between 8 and 240),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  acknowledged_by uuid references users(id) on delete set null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_work_reports_agent_same_org foreign key (agent_instance_id, org_id)
    references agent_instances (id, org_id) on delete cascade
);
create index if not exists ai_work_reports_org_idx on ai_work_reports (org_id, created_at desc);
create index if not exists ai_work_reports_agent_idx on ai_work_reports (agent_instance_id, created_at desc) where agent_instance_id is not null;
create index if not exists ai_work_reports_open_idx on ai_work_reports (org_id, status, created_at desc) where status = 'open';
drop trigger if exists ai_work_reports_touch on ai_work_reports;
create trigger ai_work_reports_touch before update on ai_work_reports
  for each row execute function app.touch_updated_at();

create table if not exists ai_work_report_deliveries (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references ai_work_reports(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'held', 'digest', 'suppressed')),
  reason text check (reason is null or char_length(reason) <= 120),
  notification_id uuid references notifications(id) on delete set null,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_id, user_id)
);
create index if not exists ai_work_report_deliveries_user_idx on ai_work_report_deliveries (user_id, created_at desc);
create index if not exists ai_work_report_deliveries_held_idx on ai_work_report_deliveries (status, created_at) where status = 'held';
drop trigger if exists ai_work_report_deliveries_touch on ai_work_report_deliveries;
create trigger ai_work_report_deliveries_touch before update on ai_work_report_deliveries
  for each row execute function app.touch_updated_at();

alter table ai_work_reports enable row level security;
alter table ai_work_report_deliveries enable row level security;
revoke all on ai_work_reports from public, anon, authenticated;
revoke all on ai_work_report_deliveries from public, anon, authenticated;
grant select on ai_work_reports to iaq_app_user;
grant select on ai_work_report_deliveries to iaq_app_user;

drop policy if exists ai_work_reports_select on ai_work_reports;
do $$
begin
  if to_regprocedure('app.permitted_orgs(text)') is null then
    execute $p$create policy ai_work_reports_select on ai_work_reports for select to iaq_app_user
      using (app.has_permission(org_id, 'activity.view'::text))$p$;
  else
    execute $p$create policy ai_work_reports_select on ai_work_reports for select to iaq_app_user
      using (org_id = ANY ((SELECT app.permitted_orgs('activity.view'::text))::uuid[]))$p$;
  end if;
end $$;

drop policy if exists ai_work_report_deliveries_select on ai_work_report_deliveries;
do $$
begin
  if to_regprocedure('app.permitted_orgs(text)') is null then
    execute $p$create policy ai_work_report_deliveries_select on ai_work_report_deliveries for select to iaq_app_user
      using (user_id = app.current_user_id() and app.has_permission(org_id, 'activity.view'::text))$p$;
  else
    execute $p$create policy ai_work_report_deliveries_select on ai_work_report_deliveries for select to iaq_app_user
      using (user_id = app.current_user_id() and org_id = ANY ((SELECT app.permitted_orgs('activity.view'::text))::uuid[]))$p$;
  end if;
end $$;

-- Business-hours controls for a monitoring schedule. An empty object means "any time"; the
-- scheduler evaluates the JSON in the schedule's own time zone and never assumes the server zone.
alter table ai_work_schedules add column if not exists business_hours jsonb not null default '{}'::jsonb
  check (pg_column_size(business_hours) <= 4096);
alter table ai_work_schedules add column if not exists last_skipped_reason text
  check (last_skipped_reason is null or char_length(last_skipped_reason) <= 120);
alter table ai_work_schedules add column if not exists last_skipped_at timestamptz;
-- A schedule may carry the exact approved assignment it will run. Lead research is the only
-- provider-backed capability accepted today; the payload is validated again when the schedule fires.
alter table ai_work_schedules add column if not exists payload jsonb not null default '{}'::jsonb
  check (pg_column_size(payload) <= 8192);

comment on table ai_work_reports is 'Verified proactive AI employee reports. Written only by reviewed capabilities after they complete.';
comment on table ai_work_report_deliveries is 'Per-recipient proactive notification policy outcome: delivered, held for quiet hours, digest, or suppressed with a reason.';
comment on column ai_work_schedules.business_hours is 'Local business-hour windows as {"mon":[["09:00","17:00"]]}; empty means any time.';
