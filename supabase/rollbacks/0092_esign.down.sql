-- Rollback for 0092_esign.sql. NOT a migration: stop the scheduler's esignSync job first, review, and run in one transaction BEFORE 0091's rollback (the tables below hang off proposals).
-- Refuses when the signing service has been used (a connection, a signature request or a request's history exists), so a client's connection, a signing that is out with a
-- customer or the record of a signature is never dropped by accident. Signed copies and certificates are files in proposal-documents; they are listed by the requests, so a
-- deliberate removal means exporting the requests and the files first and then clearing them (the history is append-only: disable its trigger for the session that clears it).
-- Disconnecting first is not enough: a disconnected connection is still history. The proposal-documents bucket and the notification kinds belong to 0090 and 0091 and are left as they are.

do $$
begin
  if exists (select 1 from esign_connections) or exists (select 1 from signature_requests) or exists (select 1 from signature_events) then
    raise exception 'Rollback refused: signing service connections or signature requests exist. Export them (and their signed copies) deliberately first.';
  end if;
end $$;

drop policy if exists signature_events_select on signature_events;
drop policy if exists signature_requests_select on signature_requests;
drop policy if exists esign_connections_select on esign_connections;

alter table proposal_decisions drop constraint if exists proposal_decisions_signature_method_check;
alter table proposal_decisions drop constraint if exists proposal_decisions_signature_request_fkey;

drop table signature_events;
drop table signature_requests;
drop table esign_connections;

drop function app.signature_events_append_only();
drop function app.signature_requests_guard();

delete from role_permissions where permission = 'proposals.connect';

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0092_esign';
