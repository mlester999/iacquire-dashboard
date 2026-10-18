-- iAcquire Native CRM, Phase 6 (package A): moving a client's live GoHighLevel records into the native CRM through the import pipeline.
--
-- A GoHighLevel migration is a set of ordinary import jobs (source 'ghl_api'), one per kind of record, run in order: custom fields, tags,
-- pipelines and stages, companies (GoHighLevel "businesses"), contacts, then opportunities. Each job reads the client's own mapped location
-- with GET requests only, stages every record as an import row, then goes through the same dry run, import and undo as a CSV import.
-- crm_external_ids (0027) maps every GoHighLevel id to the native record it became, so running a step again never creates a duplicate.
--
-- What this adds:
--   * Job kinds for the configuration steps (custom_field, tag, pipeline). They exist only for GoHighLevel jobs; a CSV import is still a
--     contact or company file.
--   * A 'fetching' status: the job is still reading pages from GoHighLevel. The page cursor has its own column (never `options`), and the
--     job records the requests it made, every rate-limit answer (429 + Retry-After), and when it may ask again (fetch_not_before), so a
--     throttled job resumes from its cursor instead of hammering the API.
--   * The location a job read from (never a protected location), and the provider switch it belongs to, if any (switch_id; the switch table
--     arrives with provider switching, so there is no foreign key yet).
--   * Who started the real import (started_by), so the import is written and audited as the person who authorized it.
--   * Machine-readable notes per staged row (flags), so the gap report can count what came across differently (an owner who isn't a member,
--     a custom field value with no matching field, an abandoned deal recorded as lost, a do-not-disturb contact) without parsing messages.
--
-- No new table and no new permission: the job and row tables keep their row-level security and grants from 0027. The GoHighLevel cache rows
-- (crm_pipelines / crm_opportunities with provider 'ghl') are never touched by any of this. Rollback: supabase/rollbacks/0036_crm_ghl_migration.down.sql.

-- ---------------------------------------------------------------------------
-- Job kinds and statuses
-- ---------------------------------------------------------------------------

alter table crm_import_jobs drop constraint crm_import_jobs_entity_check;
alter table crm_import_jobs add constraint crm_import_jobs_entity_check check (entity in ('contact', 'company', 'opportunity', 'custom_field', 'tag', 'pipeline'));
-- Configuration steps only exist as GoHighLevel migration steps.
alter table crm_import_jobs add constraint crm_import_jobs_config_source check (source = 'ghl_api' or entity in ('contact', 'company', 'opportunity'));

alter table crm_import_jobs drop constraint crm_import_jobs_status_check;
alter table crm_import_jobs add constraint crm_import_jobs_status_check check (status in (
  'uploaded', 'fetching', 'validating', 'validated', 'importing', 'completed', 'failed', 'cancelled', 'rolling_back', 'rolled_back'));
alter table crm_import_jobs add constraint crm_import_jobs_fetching_source check (status <> 'fetching' or source = 'ghl_api');

-- ---------------------------------------------------------------------------
-- Where a GoHighLevel job reads from, and how far it got
-- ---------------------------------------------------------------------------

alter table crm_import_jobs
  -- The client's own mapped location at the time the job was created. A job never reads from any other location, and never from Aster Homes
  -- or iAcquire's own agency location.
  add column source_location text check (source_location ~ '^[A-Za-z0-9]{10,40}$' and source_location not in ('u69CVh0ZlAofUmRoj1zF', 'SQvVnld5MBHdMQ1qnSfw')),
  -- The next page to read (GoHighLevel's startAfterId/startAfter, or skip), null once every page is staged.
  add column fetch_cursor jsonb check (fetch_cursor is null or (jsonb_typeof(fetch_cursor) = 'object' and pg_column_size(fetch_cursor) <= 4096)),
  -- Requests made, pages read, rate-limit answers, the total GoHighLevel reported, and the location's users (id → email) for owner mapping.
  add column fetch_state jsonb not null default '{}'::jsonb check (jsonb_typeof(fetch_state) = 'object' and pg_column_size(fetch_state) <= 65536),
  -- After a 429 (or when the burst budget is used up) the job waits until this time before asking GoHighLevel again.
  add column fetch_not_before timestamptz,
  add column fetched_at timestamptz,
  add column switch_id uuid,
  -- Who started the real import after the dry run (the owner, for a migration step). The worker writes the import as this person, so the
  -- audit trail, created_by columns and the completion notice name who authorized it, not who ran the dry run.
  add column started_by uuid references users(id) on delete set null;
alter table crm_import_jobs add constraint crm_import_jobs_ghl_location check ((source = 'ghl_api') = (source_location is not null));

drop index if exists crm_import_jobs_work_idx;
create index crm_import_jobs_work_idx on crm_import_jobs (status) where status in ('fetching', 'validating', 'importing', 'rolling_back');
-- The latest job per step, for the migration panel and the comparison.
create index crm_import_jobs_ghl_idx on crm_import_jobs (org_id, entity, created_at desc) where source = 'ghl_api';
create index crm_import_jobs_switch_idx on crm_import_jobs (org_id, switch_id) where switch_id is not null;

-- ---------------------------------------------------------------------------
-- Staged rows
-- ---------------------------------------------------------------------------

alter table crm_import_rows add column flags text[] not null default '{}' check (cardinality(flags) <= 20);
-- A page read twice (a resumed cursor) never stages the same GoHighLevel record twice; the dry run of a later step looks records up here.
create index crm_import_rows_ghl_id_idx on crm_import_rows (job_id, (data->>'ghl_id')) where data ? 'ghl_id';
