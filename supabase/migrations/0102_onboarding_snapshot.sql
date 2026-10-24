-- Phase 7 (milestone M3): onboarding completion.
--
--   * onboarding_responses.submitted_snapshot: the business facts (name, industry, website, area, time zone, description, services, ideal customers, brand colour) as the
--     answers last stood for them, and the moment up to which answer edits are known to be reflected in the live workspace. A re-submission writes only the facts whose
--     answers changed since, so a later edit in Settings > Business profile is not undone by an unrelated change of answers. Bookkeeping only: no contact detail, no secret.
--   * crm_calendars.origin accepts 'onboarding': a DRAFT calendar made from the booking answers of the questionnaire. A draft takes no bookings (0054: no booking page, never the
--     default); it goes live only when someone assigns hosts and activates it after the existing checks.
--   * One optional Setup Center step, media_storage, showing where a client's social media pictures and videos may be kept. It is not required, completes nothing and connects
--     nothing; the text on the client's screen is read from the existing storage policy each time.
--
-- Additive. The application role already holds table-level select, insert and update on onboarding_responses (0002), so the new column follows the same row-level rules.
-- Nothing here contacts a provider, charges anyone or enables anything.

-- ---------------------------------------------------------------------------
-- The snapshot of the last submission
-- ---------------------------------------------------------------------------

alter table onboarding_responses
  add column submitted_snapshot jsonb check (submitted_snapshot is null or (jsonb_typeof(submitted_snapshot) = 'object' and pg_column_size(submitted_snapshot) <= 16384));

-- ---------------------------------------------------------------------------
-- A draft calendar can say it came from the onboarding answers
-- ---------------------------------------------------------------------------

-- The constraint was written inline on the column (0054), so its name is not known here: it is found by what it allows and replaced.
do $$
declare
  existing text;
begin
  select c.conname into existing from pg_constraint c
   where c.conrelid = 'crm_calendars'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%ghl_import%';
  if existing is null then
    raise exception 'The check on crm_calendars.origin was not found; cannot allow the onboarding origin';
  end if;
  execute format('alter table crm_calendars drop constraint %I', existing);
end $$;
alter table crm_calendars add constraint crm_calendars_origin_check check (origin in ('manual', 'blueprint', 'ghl_import', 'onboarding'));

-- ---------------------------------------------------------------------------
-- The optional media storage step of the default checklist
-- ---------------------------------------------------------------------------

insert into client_setup_template_tasks
  (template_id, key, title, client_title, description, completion_notice, section, completion_mode, check_key, service,
   required, requires_evidence, requires_client_response, client_action, depends_on, sort_order)
select t.id, 'media_storage', 'Media storage for social posts reviewed', 'Where your post pictures and videos are kept',
       'Pictures and videos for your social media posts are kept in iAcquire storage while you are on the managed maintenance plan. Without the plan, media is meant to be kept in your own Google Drive or OneDrive; connecting those is not available yet, so text and link posts work today. This optional step shows what applies to your workspace.',
       null, 'agency', 'manual', null, null,
       false, false, false, null, '{}'::text[], 108
from client_setup_templates t
where t.is_default
on conflict (template_id, key) do nothing;

-- Checklists that are not activated yet get the step too (activated ones keep their history exactly as it was), as 0013 and 0056 did for the steps they added.
insert into client_setup_tasks
  (org_id, instance_id, template_key, title, client_title, description, completion_notice, section, completion_mode, check_key, service,
   required, requires_evidence, requires_client_response, client_action, sort_order, service_excluded, crm_provider)
select i.org_id, i.id, tt.key, tt.title, tt.client_title, tt.description, tt.completion_notice, tt.section, tt.completion_mode, tt.check_key, tt.service,
       tt.required, tt.requires_evidence, tt.requires_client_response, tt.client_action, tt.sort_order, false, tt.crm_provider
from client_setup_instances i join client_setup_template_tasks tt on tt.template_id = i.template_id
where i.state <> 'activated' and tt.key = 'media_storage'
  and not exists (select 1 from client_setup_tasks x where x.instance_id = i.id and x.template_key = tt.key);

insert into client_setup_task_events (org_id, instance_id, actor_kind, event, visibility, metadata)
select i.org_id, i.id, 'system', 'template_expanded', 'internal', '{"migration":"0102","existing_history_preserved":true}'::jsonb
from client_setup_instances i where i.state <> 'activated';
update client_setup_instances set revision = revision + 1 where state <> 'activated';
