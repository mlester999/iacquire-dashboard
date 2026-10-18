-- Rollback for 0056_crm_setup_native.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the
-- portal's Setup Center and CRM setup guide first, and run it in one transaction (tests/crm-migrations.test.ts proves it executes on a fully
-- migrated local database). Roll back later migrations first (highest number first).
--
-- It refuses while any client has CRM setup guide progress, or while the native sender steps hold anything beyond their untouched initial
-- state (progress, notes, evidence or a recorded check): the older schema has nowhere to keep them. After it runs, every step is applicable
-- by purchased service only again, which means native CRM clients see the GoHighLevel location step once more.

do $$
begin
  if exists (select 1 from crm_setup_guides) then
    raise exception 'Rollback refused: clients have CRM setup guide progress. Export what you need and remove it deliberately first.';
  end if;
  if exists (
    select 1 from client_setup_tasks t
    where t.template_key in ('sms_sender', 'whatsapp_sender')
      and (t.status <> 'pending' or t.client_note is not null or t.completed_at is not null
           or exists (select 1 from client_setup_task_attachments a where a.task_id = t.id)
           or exists (select 1 from client_setup_task_events e where e.task_id = t.id and e.event <> 'task_created'))
  ) or exists (select 1 from client_setup_checks c where c.check_key in ('sms_sender', 'whatsapp_sender') and c.status in ('verified', 'failed', 'attested')) then
    raise exception 'Rollback refused: the SMS or WhatsApp sender setup steps have progress or recorded checks. Resolve and remove them deliberately first.';
  end if;
end $$;

drop table if exists crm_setup_guides;

drop trigger if exists crm_workspaces_setup_scope on crm_workspaces;
drop trigger if exists crm_capability_providers_setup_scope on crm_capability_providers;
drop function if exists app.setup_follow_crm_provider();

delete from client_setup_checks where check_key in ('sms_sender', 'whatsapp_sender');
delete from client_setup_tasks where template_key in ('sms_sender', 'whatsapp_sender');
delete from client_setup_template_tasks where key in ('sms_sender', 'whatsapp_sender');

-- The wording 0008 and 0013 left.
update client_setup_template_tasks set
  title = 'CRM snapshot installed',
  description = 'We install our proven CRM template: pipeline stages, forms and message templates built for client acquisition.'
where key = 'crm_snapshot';
update client_setup_template_tasks set
  title = 'Google Calendar connected and appointment availability checked',
  client_title = 'Google Calendar connected',
  description = 'We connect your calendar so your AI Appointment Setter only offers times that are really free.',
  client_action = '{"type":"external","label":"Connect Google Calendar","instructions":"Approve access to the Google calendar we should use when we send you the authorization link, then let us know it is done."}'::jsonb
where key = 'calendar';
update client_setup_tasks set
  title = 'CRM snapshot installed',
  description = 'We install our proven CRM template: pipeline stages, forms and message templates built for client acquisition.'
where template_key = 'crm_snapshot' and title = 'CRM Blueprint applied';
update client_setup_tasks set
  title = 'Google Calendar connected and appointment availability checked',
  client_title = 'Google Calendar connected',
  description = 'We connect your calendar so your AI Appointment Setter only offers times that are really free.',
  client_action = case when status = 'waiting_for_client' then client_action
    else '{"type":"external","label":"Connect Google Calendar","instructions":"Approve access to the Google calendar we should use when we send you the authorization link, then let us know it is done."}'::jsonb end
where template_key = 'calendar' and title = 'Calendar connected and appointment availability checked';

-- Every step applies by purchased service only again.
update client_setup_tasks t
   set service_excluded = (t.service is not null and not (t.service = any(i.services)))
  from client_setup_instances i
 where i.id = t.instance_id and t.service_excluded is distinct from (t.service is not null and not (t.service = any(i.services)));

alter table client_setup_tasks drop column if exists crm_provider;
alter table client_setup_template_tasks drop column if exists crm_provider;
drop function if exists app.refresh_setup_applicability(uuid);
drop function if exists app.setup_crm_owner(uuid, text);
drop function if exists app.setup_crm_uses(uuid, text);

update client_setup_instances set revision = revision + 1 where state <> 'activated';

delete from schema_migrations where version = '0056_crm_setup_native';
