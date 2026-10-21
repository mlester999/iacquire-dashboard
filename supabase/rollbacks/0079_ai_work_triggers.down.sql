-- Rollback for 0079_ai_work_triggers.sql. NOT a migration: stop the workforce scheduler first,
-- review and run in one transaction. Refuse if trigger configuration exists.

do $$
begin
  if exists (select 1 from ai_work_triggers) then
    raise exception 'Rollback refused: workforce trigger configuration exists. Export or remove it deliberately first.';
  end if;
end $$;

drop policy if exists ai_work_triggers_select on ai_work_triggers;
drop trigger if exists ai_work_triggers_touch on ai_work_triggers;
drop table ai_work_triggers;
