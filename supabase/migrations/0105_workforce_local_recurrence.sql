-- Optional local-time recurrence rules for workforce schedules.
-- Existing schedules keep a NULL rule and retain their interval-based behavior.
alter table ai_work_schedules
  add column if not exists recurrence_rule jsonb
  check (recurrence_rule is null or pg_column_size(recurrence_rule) <= 1024);

comment on column ai_work_schedules.recurrence_rule is
  'Optional daily or selected-weekday recurrence in the schedule IANA timezone; NULL preserves the legacy fixed-interval cadence.';
