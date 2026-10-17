delete from role_permissions
where role = 'agency_manager'
  and permission in (
    'agency.crm.manage',
    'contacts.create', 'contacts.edit',
    'companies.create', 'companies.edit',
    'opportunities.create', 'opportunities.edit',
    'appointments.book', 'appointments.manage', 'calendars.manage',
    'website.publish'
  );
