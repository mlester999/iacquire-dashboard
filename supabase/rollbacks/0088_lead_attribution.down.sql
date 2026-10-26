-- Rollback for 0088_lead_attribution.sql. NOT a migration: review, and run in one transaction.
-- Refuses when touches or entered costs exist, so a contact's source history and a person's cost entries are never dropped by accident.

do $$
begin
  if exists (select 1 from lead_touches) or exists (select 1 from attribution_costs) or exists (select 1 from contacts where first_touch_id is not null or latest_touch_id is not null) then
    raise exception 'Rollback refused: lead touches, attribution costs or contact touch pointers exist. Export them deliberately first.';
  end if;
end $$;

drop policy if exists attribution_costs_select on attribution_costs;
drop policy if exists lead_touches_select on lead_touches;

drop table attribution_costs;
drop table lead_touches;

alter table contacts drop column latest_touch_id, drop column first_touch_id;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0088_lead_attribution';
