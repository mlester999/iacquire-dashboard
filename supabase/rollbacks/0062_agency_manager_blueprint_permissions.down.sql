-- Rollback for 0062_agency_manager_blueprint_permissions.sql. Removes only the manager grants this migration
-- added; the staff and super-admin grants stay owned by 0054.
delete from role_permissions where role = 'agency_manager' and permission in ('crm.blueprints.view', 'crm.blueprints.design');
delete from schema_migrations where version = '0062_agency_manager_blueprint_permissions';

