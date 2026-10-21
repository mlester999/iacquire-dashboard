-- Rollback for 0071_automation_studio_plan_lookup.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, and
-- run it in one transaction. Deploy code that no longer calls app.automation_studio_plan() first (the portal shell does), or every portal page fails.
-- It holds no data, so nothing needs exporting.

drop function if exists app.automation_studio_plan(uuid);
