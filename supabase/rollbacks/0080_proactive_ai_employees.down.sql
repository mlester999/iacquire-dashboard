-- Rollback for 0080_proactive_ai_employees.sql. NOT a migration: stop the workforce scheduler first,
-- review and run in one transaction. Refuse if reports or schedules would be discarded.

do $$
begin
  if exists (select 1 from ai_work_reports)
     or exists (select 1 from ai_work_report_deliveries)
     or exists (select 1 from ai_work_schedules) then
    raise exception 'Rollback refused: proactive reports, delivery history or schedule rows exist. Export or remove them deliberately first.';
  end if;
end $$;

drop policy if exists ai_work_report_deliveries_select on ai_work_report_deliveries;
drop policy if exists ai_work_reports_select on ai_work_reports;
drop trigger if exists ai_work_report_deliveries_touch on ai_work_report_deliveries;
drop trigger if exists ai_work_reports_touch on ai_work_reports;
drop table ai_work_report_deliveries;
drop table ai_work_reports;

alter table ai_work_schedules
  drop column if exists last_skipped_at,
  drop column if exists last_skipped_reason,
  drop column if exists business_hours,
  drop column if exists payload;
