-- Rollback for 0039_crm_provider_switch.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the
-- portal's CRM screens and the scheduler first, and run it in one transaction (tests/crm-migrations.test.ts proves it executes on a fully
-- migrated local database). Roll back later migrations first (highest number first).
--
-- It refuses while any provider switch is recorded: dropping the table would lose the ownership snapshot a rollback of that switch needs,
-- and the backups taken before each switch. Download the backups you want to keep, finish or roll back any switch in progress, and remove the
-- rows deliberately first. Workspace ownership (crm_workspaces.mode, crm_capability_providers) is left exactly as it is.

do $$
begin
  if exists (select 1 from crm_provider_switches) or exists (select 1 from crm_provider_switch_backups) then
    raise exception 'Rollback refused: CRM provider switches or their backups are recorded. Download the backups you need and remove them deliberately first.';
  end if;
end $$;

alter table crm_import_jobs drop constraint if exists crm_import_jobs_switch_fk;

drop table if exists crm_provider_switches;
drop table if exists crm_provider_switch_backups;

delete from schema_migrations where version = '0039_crm_provider_switch';
