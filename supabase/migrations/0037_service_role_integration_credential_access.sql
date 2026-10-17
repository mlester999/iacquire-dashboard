-- Internal credential readers run with a transaction-local service_role after an application
-- authorization check. Some Supabase projects do not apply default table grants to objects
-- created by every migration owner, so declare the required privilege explicitly.
-- iaq_app_user remains unprivileged; browser/Data API roles are not granted this access.
grant select on table public.integration_credentials to service_role;
