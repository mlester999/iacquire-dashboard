-- Rollback for 0028_crm_sales.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the portal's CRM
-- screens and the scheduler first, and run it in one transaction (tests/crm-migrations.test.ts proves it executes on a fully migrated local database).
-- Roll back later CRM migrations first (highest number first).
--
-- It refuses to run while native pipelines, deals or CRM tasks exist, because the older schema cannot hold them. GoHighLevel cache rows are kept.

do $$
begin
  if exists (select 1 from crm_pipelines where provider = 'native') or exists (select 1 from crm_opportunities where provider = 'native') then
    raise exception 'Rollback refused: native pipelines or opportunities exist. Export them (CRM → Imports & exports) and remove them deliberately first.';
  end if;
  if exists (select 1 from tasks where status = 'in_progress' or category in ('crm', 'appointment') or source = 'workflow' or priority <> 'normal'
             or contact_id is not null or company_id is not null or opportunity_id is not null or appointment_id is not null)
     or exists (select 1 from crm_task_comments) then
    raise exception 'Rollback refused: CRM tasks or task comments exist that the older tasks table cannot hold. Complete or remove them first.';
  end if;
end $$;

-- Opportunities and their history
drop policy if exists crm_opportunities_select on crm_opportunities;
create policy crm_opportunities_select on crm_opportunities for select to iaq_app_user using (app.has_permission(org_id, 'sales.view'));
alter table crm_activities drop constraint if exists crm_activities_opportunity_id_org_id_fkey;
drop table if exists crm_opportunity_tags;
drop table if exists crm_opportunity_history;
drop trigger if exists crm_opportunities_touch on crm_opportunities;
drop index if exists crm_opportunities_board_idx;
drop index if exists crm_opportunities_contact_idx;
drop index if exists crm_opportunities_owner_idx;
alter table crm_opportunities
  drop constraint if exists crm_opportunities_ghl_id,
  drop constraint if exists crm_opportunities_native_shape,
  drop constraint if exists crm_opportunities_native_closed,
  drop constraint if exists crm_opportunities_native_status,
  drop constraint if exists crm_opportunities_value,
  drop constraint if exists crm_opportunities_name_len;

-- Tasks (their opportunity foreign key must go before the opportunity key it points at).
drop table if exists crm_task_comments;
drop policy if exists tasks_select on tasks;
create policy tasks_select on tasks for select to iaq_app_user using (app.can_access_org(org_id));
drop trigger if exists tasks_touch on tasks;
drop index if exists tasks_contact_idx;
drop index if exists tasks_opportunity_idx;
drop index if exists tasks_assignee_idx;
drop index if exists tasks_reminder_idx;
alter table tasks drop constraint if exists tasks_done_shape;
alter table tasks drop column if exists priority, drop column if exists contact_id, drop column if exists company_id, drop column if exists opportunity_id,
  drop column if exists appointment_id, drop column if exists remind_at, drop column if exists reminded_at, drop column if exists completed_by, drop column if exists updated_at;
alter table tasks drop constraint if exists tasks_status_check;
alter table tasks add constraint tasks_status_check check (status in ('open', 'done', 'cancelled'));
alter table tasks drop constraint if exists tasks_category_check;
alter table tasks add constraint tasks_category_check check (category in ('general', 'follow_up', 'retention', 'sales', 'setup'));
alter table tasks drop constraint if exists tasks_source_check;
alter table tasks add constraint tasks_source_check check (source in ('user', 'agent', 'system'));
alter table tasks drop constraint if exists tasks_id_org;

alter table crm_opportunities drop column if exists provider, drop column if exists pipeline_ref, drop column if exists stage_ref, drop column if exists contact_id,
  drop column if exists company_id, drop column if exists currency, drop column if exists expected_close_date, drop column if exists lost_reason,
  drop column if exists assigned_user_id, drop column if exists description, drop column if exists probability, drop column if exists created_by,
  drop column if exists created_via, drop column if exists closed_at, drop column if exists stage_entered_at, drop column if exists archived_at,
  drop column if exists version, drop column if exists created_at, drop column if exists updated_at;
alter table crm_opportunities drop constraint if exists crm_opportunities_id_org;
alter table crm_opportunities alter column ghl_opportunity_id set not null;

-- Stages and pipelines
drop table if exists crm_pipeline_stages;
drop trigger if exists crm_pipelines_touch on crm_pipelines;
drop index if exists crm_pipelines_one_default;
drop index if exists crm_pipelines_native_name;
alter table crm_pipelines drop constraint if exists crm_pipelines_ghl_id, drop constraint if exists crm_pipelines_name_len, drop constraint if exists crm_pipelines_id_org;
alter table crm_pipelines drop column if exists provider, drop column if exists description, drop column if exists position, drop column if exists is_default,
  drop column if exists archived_at, drop column if exists created_by, drop column if exists created_at, drop column if exists updated_at;
alter table crm_pipelines alter column ghl_pipeline_id set not null;

delete from schema_migrations where version = '0028_crm_sales';
