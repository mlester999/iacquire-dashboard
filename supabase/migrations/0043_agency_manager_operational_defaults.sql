-- Managers receive day-to-day client CRM and calendar operations by default.
-- Delete, bulk, export, provider, and owner-only permissions remain separate.
-- Website publishing remains gated by approval of the exact draft by the client owner.
insert into role_permissions(role, permission) values
  ('agency_manager', 'agency.crm.manage'),
  ('agency_manager', 'contacts.create'),
  ('agency_manager', 'contacts.edit'),
  ('agency_manager', 'companies.create'),
  ('agency_manager', 'companies.edit'),
  ('agency_manager', 'opportunities.create'),
  ('agency_manager', 'opportunities.edit'),
  ('agency_manager', 'appointments.book'),
  ('agency_manager', 'appointments.manage'),
  ('agency_manager', 'calendars.manage'),
  ('agency_manager', 'website.publish')
on conflict do nothing;
