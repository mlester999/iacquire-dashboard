-- Rollback for 0102_onboarding_snapshot.sql. NOT a migration: review and run in one transaction.
-- Refuses when the feature has been used: a stored snapshot of a submission, a draft calendar made from onboarding answers, or a media_storage step a person has worked on.
-- Export or clear those deliberately first:
--   * snapshots are bookkeeping and can be cleared (update onboarding_responses set submitted_snapshot = null): a re-submission then compares answer edit times instead;
--   * a calendar made from onboarding answers is the client's data: archive or delete it from Calendars & Types, or export it, before rolling back;
--   * a media_storage step with a status, a note, an attachment or a history entry is kept as history: export it first.

do $$
begin
  if exists (select 1 from onboarding_responses where submitted_snapshot is not null) then
    raise exception 'Rollback refused: submitted snapshots exist. Clear them first (update onboarding_responses set submitted_snapshot = null).';
  end if;
  if exists (select 1 from crm_calendars where origin = 'onboarding') then
    raise exception 'Rollback refused: calendars drafted from onboarding answers exist. Archive or delete them first, or export them.';
  end if;
  if exists (
    select 1 from client_setup_tasks t
    where t.template_key = 'media_storage'
      and (t.status <> 'pending' or t.client_note is not null or t.blocked_reason is not null or t.completion_note is not null or t.assigned_to is not null
           or exists (select 1 from client_setup_task_attachments a where a.task_id = t.id)
           or exists (select 1 from client_setup_task_events e where e.task_id = t.id))
  ) then
    raise exception 'Rollback refused: a media storage step has been worked on. Export it first.';
  end if;
end $$;

-- The untouched copies of the step go with the template row, and the revision of the checklists that got it goes back.
update client_setup_instances i set revision = greatest(1, revision - 1)
 where i.state <> 'activated' and exists (select 1 from client_setup_tasks t where t.instance_id = i.id and t.template_key = 'media_storage');
delete from client_setup_tasks where template_key = 'media_storage';
delete from client_setup_template_tasks where key = 'media_storage';
delete from client_setup_task_events where event = 'template_expanded' and metadata ->> 'migration' = '0102';

alter table crm_calendars drop constraint crm_calendars_origin_check;
alter table crm_calendars add constraint crm_calendars_origin_check check (origin in ('manual', 'blueprint', 'ghl_import'));

alter table onboarding_responses drop column submitted_snapshot;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0102_onboarding_snapshot';
