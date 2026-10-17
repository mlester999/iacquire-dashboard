do $$
begin
  if exists (select 1 from agency_user_permission_overrides where permission in ('projects.view','website.view'))
     or exists (select 1 from invitation_agency_permission_overrides where permission in ('projects.view','website.view')) then
    raise exception 'cannot rollback 0044 while Projects or Website Studio view overrides exist';
  end if;
end $$;

alter table agency_user_permission_overrides
  drop constraint agency_user_permission_overrides_permission_check;
alter table agency_user_permission_overrides
  add constraint agency_user_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'agency.workforce.view', 'agency.workforce.manage',
    'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
    'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book', 'appointments.manage',
    'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign',
    'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export',
    'crm.view', 'setup.manage', 'projects.manage', 'quotes.manage', 'website.create', 'website.publish', 'website.edit', 'website.domains', 'website.review', 'website.archive'
  ));

alter table invitation_agency_permission_overrides
  drop constraint invitation_agency_permission_overrides_permission_check;
alter table invitation_agency_permission_overrides
  add constraint invitation_agency_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'agency.workforce.view', 'agency.workforce.manage',
    'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
    'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book', 'appointments.manage',
    'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign',
    'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export',
    'crm.view', 'setup.manage', 'projects.manage', 'quotes.manage', 'website.create', 'website.publish', 'website.edit', 'website.domains', 'website.review', 'website.archive'
  ));

create or replace function app.file_permission(p_org uuid, p_bucket text, p_write boolean, p_visibility text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (p_visibility = 'client' or app.staff_assigned(p_org)) and
    case p_bucket
      when 'company-documents' then app.has_permission(p_org, case when p_write then 'knowledge.edit' else 'knowledge.view' end)
      when 'support-attachments' then
        case when app.is_agency_staff() then
          app.user_can_access_org(app.current_user_id(), p_org)
          and app.user_has_agency_permission(app.current_user_id(), case when p_write then 'agency.support.manage' else 'agency.support.view' end)
          and (p_visibility = 'client' or p_visibility = 'internal')
        else p_visibility = 'client' and app.has_permission(p_org, 'support.use') end
      when 'project-files' then case when p_write then app.staff_assigned(p_org) else app.has_permission(p_org, 'setup.view') end
      when 'project-uploads' then app.has_permission(p_org, case when p_write then 'projects.request' else 'projects.view' end) or app.staff_assigned(p_org)
      when 'portfolio-assets' then app.is_agency_admin()
      when 'brand-assets' then app.has_permission(p_org, case when p_write then 'workspace.manage_profile' else 'workspace.view' end)
      else false end,
    false)
$$;
