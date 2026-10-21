-- Rollback for 0078_ai_work_schedules.sql. NOT a migration: stop the workforce scheduler first,
-- review and run in one transaction. Refuse if schedule configuration exists.

do $$
begin
  if exists (select 1 from ai_work_schedules) then
    raise exception 'Rollback refused: workforce schedule configuration exists. Export or remove it deliberately first.';
  end if;
end $$;

drop policy if exists ai_work_schedules_select on ai_work_schedules;
drop trigger if exists ai_work_schedules_touch on ai_work_schedules;
drop table ai_work_schedules;
