-- Rollback for 0036_crm_ghl_migration.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the
-- portal's CRM screens and the scheduler first, and run it in one transaction (tests/crm-migrations.test.ts proves it executes on a fully
-- migrated local database). Roll back later migrations first (highest number first).
--
-- It refuses while any GoHighLevel migration job exists: the older schema can't hold a configuration step or a fetching job, and dropping the
-- cursor would lose where a job stopped. Undo the migration steps (Settings → Imports) and remove the jobs deliberately first. The native
-- records a completed migration created are ordinary CRM records and stay.

do $$
begin
  if exists (select 1 from crm_import_jobs where source = 'ghl_api' or entity in ('custom_field', 'tag', 'pipeline') or status = 'fetching') then
    raise exception 'Rollback refused: GoHighLevel migration jobs exist. Undo and remove them deliberately first.';
  end if;
end $$;

drop index if exists crm_import_rows_ghl_id_idx;
alter table crm_import_rows drop column if exists flags;

drop index if exists crm_import_jobs_switch_idx;
drop index if exists crm_import_jobs_ghl_idx;
drop index if exists crm_import_jobs_work_idx;
create index crm_import_jobs_work_idx on crm_import_jobs (status) where status in ('validating', 'importing', 'rolling_back');

alter table crm_import_jobs drop constraint if exists crm_import_jobs_ghl_location;
alter table crm_import_jobs
  drop column if exists started_by, drop column if exists switch_id, drop column if exists fetched_at, drop column if exists fetch_not_before, drop column if exists fetch_state,
  drop column if exists fetch_cursor, drop column if exists source_location;

alter table crm_import_jobs drop constraint if exists crm_import_jobs_fetching_source;
alter table crm_import_jobs drop constraint crm_import_jobs_status_check;
alter table crm_import_jobs add constraint crm_import_jobs_status_check check (status in (
  'uploaded', 'validating', 'validated', 'importing', 'completed', 'failed', 'cancelled', 'rolling_back', 'rolled_back'));

alter table crm_import_jobs drop constraint if exists crm_import_jobs_config_source;
alter table crm_import_jobs drop constraint crm_import_jobs_entity_check;
alter table crm_import_jobs add constraint crm_import_jobs_entity_check check (entity in ('contact', 'company', 'opportunity'));

delete from schema_migrations where version = '0036_crm_ghl_migration';
