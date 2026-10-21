-- Rollback for 0072_automation_connections.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, and run it in one
-- transaction. Roll back later migrations first (highest number first), and deploy code that no longer reads these tables first.
--
-- It refuses while any connection or call record exists: a connection holds a workspace's encrypted credential, and the call log is the record of what
-- was sent outside. Revoke the connections and export the call log deliberately first (revoking erases the ciphertext; the rows stay as a record).

do $$
begin
  if exists (select 1 from automation_connections) or exists (select 1 from automation_connection_calls) then
    raise exception 'Rollback refused: automation connections or their call log exist. Revoke and export them first.';
  end if;
end $$;

drop policy if exists automation_connection_calls_select on automation_connection_calls;
drop policy if exists automation_connections_select on automation_connections;
drop table automation_connection_calls;
drop table automation_connections;
