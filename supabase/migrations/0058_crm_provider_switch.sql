-- iAcquire Native CRM, Phase 6 (package B): switching a workspace's CRM provider, capability by capability.
--
-- A provider switch moves the ownership of some CRM capabilities (contacts, pipelines, conversations ...) between GoHighLevel and iAcquire's
-- own CRM, with a preview, a backup, a dry run, a cutover, a verification and a way back (src/server/crm/provider-switch.ts,
-- docs/crm-provider-switching.md). This migration adds where a switch is recorded and where its backup is kept:
--
--   * crm_provider_switches: one row per switch. It keeps counts only (record counts per capability, what was paused, how verification
--     came out, what a rollback kept) and the ownership snapshot before and after (mode, switching, each capability's owner). Never a name,
--     an email address or a record's contents. At most one switch per workspace is in progress at a time.
--   * crm_provider_switch_backups: the workspace's full data export (the offboarding export builder, src/server/offboarding/export.ts),
--     taken right before the switch. It holds customer data, so it is read only by trusted server code: row-level security is on, there
--     is no policy, and no application role has any grant. The switch row points at it by id.
--   * crm_import_jobs.switch_id (0036) gets its foreign key: the GoHighLevel import jobs a switch starts belong to it.
--
-- Ownership itself stays where it was defined in 0027 (crm_workspaces.mode and switching, crm_capability_providers); the switch service is
-- the only code that writes them after a workspace is created. The Setup Center re-scopes itself on those writes (0037 triggers).
-- Rollback: supabase/rollbacks/0039_crm_provider_switch.down.sql.

-- ---------------------------------------------------------------------------
-- Backups
-- ---------------------------------------------------------------------------

create table crm_provider_switch_backups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  filename text not null check (char_length(filename) between 1 and 200),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 268435456),
  -- The ZIP the offboarding export builder made (readable JSON per table, the README and the manifest).
  bytes bytea not null,
  -- Rows per table in the archive (the manifest's counts). Table names and numbers only.
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 16384),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id)
);
create index crm_provider_switch_backups_org_idx on crm_provider_switch_backups (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Switches
-- ---------------------------------------------------------------------------

create table crm_provider_switches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references crm_workspaces(org_id) on delete cascade,
  -- Where the chosen capabilities move: native (from GoHighLevel, with an import of the records the migration supports) or ghl (ownership
  -- only: iAcquire stops acting on them; nothing is deleted here and nothing is written to GoHighLevel).
  direction text not null check (direction in ('native', 'ghl')),
  capabilities text[] not null check (cardinality(capabilities) between 1 and 11 and capabilities <@ array[
    'contacts', 'companies', 'tags', 'custom_fields', 'pipelines', 'opportunities', 'calendars', 'appointments', 'conversations', 'workflows', 'reporting']::text[]),
  -- backed_up: chosen, previewed and backed up. dry_run: the GoHighLevel steps are being read and checked (nothing is written yet).
  -- cutting_over: switching is on, the owners moved, the imports run in order. verifying: the imports finished and the check found something
  -- a person must look at. completed: switching is off and the new owners stand. rolling_back / rolled_back: the imports are undone and the
  -- owners before the switch restored. cancelled: stopped before the cutover (nothing about ownership changed).
  status text not null default 'backed_up' check (status in ('backed_up', 'dry_run', 'cutting_over', 'verifying', 'completed', 'rolling_back', 'rolled_back', 'cancelled')),
  -- The workspace's ownership before the switch and as the cutover set it: {"mode", "switching", "rows": [{"capability", "provider",
  -- "syncPolicy", "ownerSince"}]}. Rollback restores `before` exactly.
  before_snapshot jsonb not null check (jsonb_typeof(before_snapshot) = 'object' and pg_column_size(before_snapshot) <= 8192),
  after_snapshot jsonb check (after_snapshot is null or (jsonb_typeof(after_snapshot) = 'object' and pg_column_size(after_snapshot) <= 8192)),
  -- Counts only: native and GoHighLevel records per capability, dependencies, what pauses, what can't come across (as counts).
  preview jsonb not null default '{}'::jsonb check (jsonb_typeof(preview) = 'object' and pg_column_size(preview) <= 16384),
  -- Counts only: per step, source vs destination, mapped, skipped, failed, needs review, and the sample checks passed / failed.
  verification jsonb check (verification is null or (jsonb_typeof(verification) = 'object' and pg_column_size(verification) <= 16384)),
  -- Counts only: per step, records undone and records kept (changed since the import, now needing review).
  rollback_report jsonb check (rollback_report is null or (jsonb_typeof(rollback_report) = 'object' and pg_column_size(rollback_report) <= 16384)),
  backup_id uuid,
  backup_bytes bigint check (backup_bytes is null or backup_bytes > 0),
  error text check (char_length(error) <= 500),
  -- The owner (or iAcquire super admin) completed despite verification issues, having seen them.
  acknowledged_issues boolean not null default false,
  created_by uuid references users(id) on delete set null,
  cutover_by uuid references users(id) on delete set null,
  read_rest_by uuid references users(id) on delete set null,
  completed_by uuid references users(id) on delete set null,
  rolled_back_by uuid references users(id) on delete set null,
  -- The orchestrator's lease (the browser's progress polling and the scheduler may both advance a switch; only one at a time does).
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  dry_run_at timestamptz,
  cutover_at timestamptz,
  verified_at timestamptz,
  completed_at timestamptz,
  rollback_started_at timestamptz,
  rolled_back_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (backup_id, org_id) references crm_provider_switch_backups (id, org_id),
  check (status <> 'backed_up' or backup_id is not null),
  check (status not in ('cutting_over', 'verifying', 'completed', 'rolling_back', 'rolled_back') or (cutover_at is not null and after_snapshot is not null))
);
create trigger crm_provider_switches_touch before update on crm_provider_switches for each row execute function app.touch_updated_at();
-- One switch in progress per workspace: two at once could each think they own the cutover.
create unique index crm_provider_switches_one_active on crm_provider_switches (org_id) where status in ('backed_up', 'dry_run', 'cutting_over', 'verifying', 'rolling_back');
create index crm_provider_switches_org_idx on crm_provider_switches (org_id, created_at desc);
-- The scheduler's pass over switches that have work to move forward.
create index crm_provider_switches_work_idx on crm_provider_switches (status) where status in ('dry_run', 'cutting_over', 'rolling_back');

-- The import jobs a switch started (0036 added the column without a target, waiting for this table). A deleted switch leaves its jobs.
alter table crm_import_jobs add constraint crm_import_jobs_switch_fk foreign key (switch_id) references crm_provider_switches(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

-- Everyone in the workspace may see that a switch happened and how it is going (counts only); every write goes through trusted server code.
alter table crm_provider_switches enable row level security;
revoke all on crm_provider_switches from public, anon, authenticated, iaq_site_runtime;
grant select on crm_provider_switches to iaq_app_user;
create policy crm_provider_switches_select on crm_provider_switches for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));

-- The backup holds the workspace's customer data: trusted server code only (the owner downloads it through an authorized route).
alter table crm_provider_switch_backups enable row level security;
revoke all on crm_provider_switch_backups from public, anon, authenticated, iaq_site_runtime, iaq_app_user;
