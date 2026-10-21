-- Rollback for 0070_automation_studio_conversations.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, and
-- run it in one transaction. Roll back later migrations first (highest number first).
--
-- It refuses while any message or change exists: they are the workflows' conversation and edit history. Export or remove them deliberately first.

do $$
begin
  if exists (select 1 from automation_studio_messages) or exists (select 1 from automation_studio_changes) then
    raise exception 'Rollback refused: Automation Studio conversations or change history exist. Export them first.';
  end if;
end $$;

drop policy if exists automation_studio_messages_select on automation_studio_messages;
drop policy if exists automation_studio_changes_select on automation_studio_changes;
drop table automation_studio_changes;
drop table automation_studio_messages;
