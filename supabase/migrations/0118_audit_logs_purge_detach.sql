-- 0118_audit_logs_purge_detach.sql — lets the purge of a departed client's data delete the client's employees even though the audit trail is append-only.
--
-- The problem. Offboarding's permanent deletion (src/server/offboarding/service.ts, executeDeletion) deletes every row a client owns except the records it must keep, and the audit
-- trail is one of those. audit_logs.agent_instance_id is a foreign key to agent_instances declared ON DELETE SET NULL, and setting a column to null is an UPDATE. The append-only rule
-- on audit_logs (0004, app.audit_logs_append_only) refuses every update and delete, so the first time a client's employee was deleted the database refused: "audit_logs is
-- append-only", and the whole deletion stopped at agent_instances with nothing deleted. Every provisioned client has audit rows that name its employees (each provisioning attempt and
-- each containment writes one), so no provisioned client could ever have been deleted.
--
-- The change. The rule stays exactly as strict, with ONE exception. While a purge has declared itself (the same per-transaction switch the invoice, proposal and signing tables already
-- honour: set_config('iaq.purge', 'on', true), which only offboarding sets), an audit row may lose its pointer to an employee that is being deleted:
--   * only the column agent_instance_id changes, and only from a value to null (every other column, compared as a whole row, must be identical);
--   * no other update and no delete is allowed, with or without the switch.
-- The audit row itself, its actor, action, target, result and metadata are retained exactly as they were.
--
-- Prerequisite: 0004_support_ops (the function and the trigger that already exist). Nothing else changes: the trigger is not recreated, the function is replaced in place.
-- Rollback: supabase/rollbacks/0118_audit_logs_purge_detach.down.sql restores the unconditional rule.

create or replace function app.audit_logs_append_only() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and current_setting('iaq.purge', true) = 'on'
     and old.agent_instance_id is not null
     and new.agent_instance_id is null
     and (to_jsonb(new) - 'agent_instance_id') = (to_jsonb(old) - 'agent_instance_id') then
    return new;
  end if;
  raise exception 'audit_logs is append-only' using errcode = 'insufficient_privilege';
end
$$;
