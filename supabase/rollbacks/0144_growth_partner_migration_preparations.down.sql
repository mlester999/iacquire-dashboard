-- Stop the app before rollback. Preserve local preparation and withdrawal evidence.
lock table ai_growth_partner_migration_preparations in access exclusive mode;
do $$
begin
  if exists (select 1 from ai_growth_partner_migration_preparations) then
    raise exception 'Rollback refused: Growth Partner migration preparation history exists. Preserve the records and use a forward fix.';
  end if;
end $$;
drop table ai_growth_partner_migration_preparations;
