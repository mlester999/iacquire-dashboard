-- Stop the app before rollback. Preserve every staged plan and owner decision.
lock table ai_growth_partner_migration_plans in access exclusive mode;
do $$
begin
  if exists (select 1 from ai_growth_partner_migration_plans) then
    raise exception 'Rollback refused: Growth Partner migration review history exists. Preserve the records and use a forward fix.';
  end if;
end $$;
drop table ai_growth_partner_migration_plans;
