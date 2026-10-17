-- A permission that has been saved on a member or invitation must not be silently discarded.
do $$
begin
  if exists (select 1 from agency_user_permission_overrides where permission in ('agency.workforce.view','agency.workforce.manage'))
     or exists (select 1 from invitation_agency_permission_overrides where permission in ('agency.workforce.view','agency.workforce.manage')) then
    raise exception 'cannot rollback 0040 while agency workforce permission overrides exist';
  end if;
end
$$;

delete from role_permissions where permission in ('agency.workforce.view','agency.workforce.manage');

alter table agency_user_permission_overrides
  drop constraint agency_user_permission_overrides_permission_check;
alter table agency_user_permission_overrides
  add constraint agency_user_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'contacts.view', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete',
    'contacts.import', 'contacts.export', 'contacts.bulk', 'companies.view', 'companies.edit',
    'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view',
    'appointments.book', 'appointments.manage', 'calendars.manage', 'calendars.connect',
    'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign', 'workflows.view',
    'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage',
    'calls.view', 'analytics.export', 'crm.view', 'setup.manage',
    'projects.manage', 'quotes.manage', 'website.publish'
  ));

alter table invitation_agency_permission_overrides
  drop constraint invitation_agency_permission_overrides_permission_check;
alter table invitation_agency_permission_overrides
  add constraint invitation_agency_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'contacts.view', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete',
    'contacts.import', 'contacts.export', 'contacts.bulk', 'companies.view', 'companies.edit',
    'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view',
    'appointments.book', 'appointments.manage', 'calendars.manage', 'calendars.connect',
    'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign', 'workflows.view',
    'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage',
    'calls.view', 'analytics.export', 'crm.view', 'setup.manage',
    'projects.manage', 'quotes.manage', 'website.publish'
  ));
