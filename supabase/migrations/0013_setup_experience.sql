-- More detailed master checklist, separate optional funnel/custom website scope, and private files.
-- Existing task IDs/history are preserved. New milestones are added to unfinished setups only.
alter table client_setup_template_tasks drop constraint client_setup_template_tasks_service_check;
alter table client_setup_template_tasks add constraint client_setup_template_tasks_service_check check (service in ('crm','ai_workforce','automations','website','funnel','email','calendar'));
alter table client_setup_tasks drop constraint client_setup_tasks_service_check;
alter table client_setup_tasks add constraint client_setup_tasks_service_check check (service in ('crm','ai_workforce','automations','website','funnel','email','calendar'));
alter table client_setup_instances alter column services set default '{crm,ai_workforce,automations,email,calendar}';
alter table client_setup_task_events drop constraint client_setup_task_events_event_check;
alter table client_setup_task_events add constraint client_setup_task_events_event_check check (event in (
 'task_created','status_changed','reopened','note','details_changed','assigned','dependencies_changed','attachment_added','attachment_removed','visibility_changed','reordered','client_requested','client_responded','verified','attested','check_run','ready_for_review','sent_back','activated','services_changed','instance_created','template_expanded'
));

alter table client_setup_task_attachments add column storage_bucket text;
alter table client_setup_task_attachments add column storage_key text;
alter table client_setup_task_attachments drop constraint client_setup_task_attachments_url_check;
alter table client_setup_task_attachments add constraint client_setup_attachment_source check (
  (storage_bucket is null and storage_key is null and url ~ '^https://[^[:space:]]+$' and char_length(url) <= 500)
  or (storage_bucket = 'project-files' and storage_key like org_id::text || '/%' and url = '/api/setup/attachments/' || id::text)
);
grant select (storage_bucket, storage_key) on client_setup_task_attachments to iaq_app_user;

-- Keep original keys for consumers and existing history, refine scope-specific wording.
update client_setup_template_tasks set title = 'Custom website developed', client_title = 'Your custom website is built', description = 'We design and build the custom website included in your package.' where key = 'website_built';
update client_setup_template_tasks set title = 'Custom website publication and domain verified', client_title = 'Your website is published', depends_on = '{website_review}' where key = 'website_published';

insert into client_setup_template_tasks
 (template_id,key,title,client_title,description,section,completion_mode,check_key,service,required,requires_evidence,requires_client_response,client_action,depends_on,sort_order)
select t.id,v.key,v.title,v.client_title,v.description,v.section,v.completion_mode,v.check_key,v.service,true,v.requires_evidence,v.requires_response,v.action::jsonb,v.dependencies,v.position
from client_setup_templates t cross join (values
 ('organization_created','Client organization created','Your private workspace is ready','Your company has its own private workspace and authorized team access.','agency','verified','onboarding',null,false,false,null,'{company_info}'::text[],15),
 ('crm_tags','Tags and custom fields prepared','Your customer records are tailored','We prepare the labels and information fields your team needs. A separate check verifies the finished CRM.','agency','manual',null,'crm',true,false,null,'{crm_snapshot}'::text[],35),
 ('lead_forms','Forms and lead capture prepared','Your lead capture forms are prepared','We prepare the forms that collect enquiries for your business. A separate check verifies the connected system.','agency','manual',null,'crm',true,false,null,'{crm_snapshot}'::text[],38),
 ('ai_configuration','AI employee configuration drafts prepared','Your AI employee instructions are prepared','We prepare each included employee around your business knowledge, tone and approved responsibilities.','agency','manual',null,'ai_workforce',true,false,null,'{company_info}'::text[],43),
 ('ai_profiles','Dedicated AI employee profiles provisioned','Your private AI employees are prepared','We prepare separate employee identities for your company. They become ready only after successful connection and safety checks.','agency','manual',null,'ai_workforce',true,false,null,'{ai_configuration}'::text[],47),
 ('automation_preparation','Client automation configuration prepared','Your automation plan is prepared','We prepare approved automation settings for your business. Live activation needs separate approval.','agency','manual',null,'automations',true,false,null,'{company_info}'::text[],55),
 ('business_hours','Business hours and booking preferences received',null,'Share your opening hours, timezone and the times you want to accept appointments.','client','manual',null,'calendar',false,true,'{"type":"provide_info","label":"Provide your business hours","instructions":"Share your opening days, hours, timezone, appointment length and booking preferences. Do not share account passwords."}','{company_info}'::text[],57),
 ('website_review','Custom website reviewed by client','Review your custom website','Review your preview and approve it or tell us what you would like changed.','client','manual',null,'website',false,true,'{"type":"review_and_approve","label":"Review your website","instructions":"Open the preview link, review your pages and send an approval or change request."}','{website_built}'::text[],75),
 ('funnel_built','Standard lead-generation funnel developed','Your lead-generation funnel is built','We prepare the standard lead-generation funnel included in your package. It is a separate deliverable from a custom website.','agency','manual',null,'funnel',true,false,null,'{company_info}'::text[],81),
 ('funnel_review','Lead-generation funnel reviewed by client','Review your lead-generation funnel','Review your funnel preview, enquiry form and thank-you page.','client','manual',null,'funnel',false,true,'{"type":"review_and_approve","label":"Review your funnel","instructions":"Open the funnel preview, then approve it or share the changes you need."}','{funnel_built}'::text[],82),
 ('funnel_published','Lead-generation funnel publication verified','Your funnel is published','After your approval, publication and the connected address need an independent check.','agency','verified','website_live','funnel',false,false,null,'{funnel_review}'::text[],83),
 ('booking_test','Calendar booking configuration tested','Your booking settings are tested','We test booking availability, timezone and appointment settings before your system is approved.','agency','verified','calendar','calendar',false,false,null,'{calendar,business_hours}'::text[],105),
 ('knowledge_review','Company knowledge reviewed',null,'We review your approved business information so your AI employees have accurate reference material.','agency','manual',null,'ai_workforce',true,false,null,'{company_info}'::text[],107)
) v(key,title,client_title,description,section,completion_mode,check_key,service,requires_evidence,requires_response,action,dependencies,position)
where t.is_default;

update client_setup_template_tasks set depends_on = '{crm_snapshot,crm_tags,lead_forms}' where key = 'crm_assets';
update client_setup_template_tasks set depends_on = '{ai_profiles}' where key = 'ai_employees';
update client_setup_template_tasks set depends_on = '{crm_assets,automation_preparation}' where key = 'workflows';
update client_setup_template_tasks set depends_on = '{ghl_subaccount,crm_assets,ai_employees,workflows,website_published,funnel_published,email_domain,calendar,booking_test,knowledge_review}' where key = 'integration_tests';

insert into client_setup_tasks
 (org_id,instance_id,template_key,title,client_title,description,completion_notice,section,completion_mode,check_key,service,required,requires_evidence,requires_client_response,client_action,sort_order,service_excluded)
select i.org_id,i.id,tt.key,tt.title,tt.client_title,tt.description,tt.completion_notice,tt.section,tt.completion_mode,tt.check_key,tt.service,tt.required,tt.requires_evidence,tt.requires_client_response,tt.client_action,tt.sort_order,
 tt.service is not null and not (tt.service = any(i.services))
from client_setup_instances i join client_setup_template_tasks tt on tt.template_id = i.template_id
where i.state <> 'activated' and not exists(select 1 from client_setup_tasks task where task.instance_id=i.id and task.template_key=tt.key);

insert into client_setup_task_dependencies (org_id,task_id,depends_on_task_id)
select task.org_id,task.id,dependency.id from client_setup_tasks task
join client_setup_instances i on i.id=task.instance_id and i.state <> 'activated'
join client_setup_template_tasks tt on tt.template_id=i.template_id and tt.key=task.template_key
cross join lateral unnest(tt.depends_on) d(key)
join client_setup_tasks dependency on dependency.instance_id=i.id and dependency.template_key=d.key
where task.status <> 'completed' on conflict do nothing;

insert into client_setup_task_events (org_id,instance_id,actor_kind,event,visibility,metadata)
select i.org_id,i.id,'system','template_expanded','internal','{"migration":"0013","existing_history_preserved":true}'::jsonb
from client_setup_instances i where i.state <> 'activated';
update client_setup_instances set revision=revision+1 where state <> 'activated';

-- Rollback is additive: preserve history/files; remove new template tasks only before any use.
-- Never drop persisted task rows or private document objects to roll back an application release.
