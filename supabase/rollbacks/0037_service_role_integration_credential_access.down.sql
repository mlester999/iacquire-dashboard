-- Reverting this migration disables trusted server-side credential reads again.
revoke select on table public.integration_credentials from service_role;
