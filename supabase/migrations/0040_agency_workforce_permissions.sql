-- Separate assigned-client AI workforce visibility from configuration and approval actions.
-- Managers receive view/manage by default; Staff receive view, and the Super Admin may
-- customize either action per person through the existing agency team permission editor.

alter table agency_user_permission_overrides
  drop constraint agency_user_permission_overrides_permission_check;
alter table agency_user_permission_overrides
  add constraint agency_user_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'agency.workforce.view', 'agency.workforce.manage',
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
    'agency.workforce.view', 'agency.workforce.manage',
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

insert into role_permissions(role, permission) values
  ('agency_staff', 'agency.workforce.view'),
  ('agency_manager', 'agency.workforce.view'),
  ('agency_super_admin', 'agency.workforce.view'),
  ('agency_manager', 'agency.workforce.manage'),
  ('agency_super_admin', 'agency.workforce.manage')
on conflict do nothing;
