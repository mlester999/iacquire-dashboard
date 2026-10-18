-- Agency managers view and design CRM Blueprints, exactly as the permission matrix in src/lib/permissions.ts
-- states. The original Blueprint migration was written before that matrix row included agency_manager, so a
-- database that already applied it never received the grant. This records it once; it is idempotent.
insert into role_permissions (role, permission) values
  ('agency_manager', 'crm.blueprints.view'),
  ('agency_manager', 'crm.blueprints.design')
on conflict do nothing;
