-- Rollback for 0048_aqi_cost_controls.sql. NOT a migration.
-- Refuses while a live or estimated AQi charge is recorded; export the usage ledger first.
do $$
begin
  if exists (select 1 from aqi_usage_events where cost_micros is not null or reserved_cost_micros is not null) then
    raise exception 'Rollback refused: AQi cost/reservation data exists. Export the usage ledger deliberately first.';
  end if;
end $$;

drop table if exists aqi_model_prices;
drop table if exists aqi_budgets;
drop index if exists aqi_usage_budget_idx;
drop index if exists aqi_usage_user_budget_idx;
alter table aqi_usage_events
  drop column if exists status,
  drop column if exists reserved_cost_micros,
  drop column if exists cost_micros,
  drop column if exists cost_estimated,
  drop column if exists config_version_id,
  drop column if exists page_route;
alter table aqi_usage_events drop constraint if exists aqi_usage_events_kind_check;
alter table aqi_usage_events add constraint aqi_usage_events_kind_check
  check (kind in ('message', 'feedback', 'config_publish'));
