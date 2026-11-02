-- Rollback for 0118_audit_logs_purge_detach.sql. NOT a migration: review, and run in one transaction.
-- Restores the original rule of 0004: every update and delete on audit_logs is refused, with no exception. After this, deleting a client's employees during a purge is refused again
-- whenever an audit row still names one of them (the deletion then stops with nothing deleted, as before 0118). Nothing in the audit trail itself is changed or removed by this rollback.
-- Safe to run when 0118 was never applied: it only writes the same function body.

create or replace function app.audit_logs_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only' using errcode = 'insufficient_privilege';
end
$$;
