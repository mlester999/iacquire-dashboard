-- Recurrence rules change future fire times; do not erase them during rollback.
do $$
begin
  if exists (select 1 from public.ai_work_schedules where recurrence_rule is not null) then
    raise exception 'convert or remove recurrence rules before rolling back 0105';
  end if;
end $$;

alter table ai_work_schedules drop column if exists recurrence_rule;
