-- Rollback for 0133_ai_growth_partner_goals.sql. Preserve goal configuration for export or explicit migration.
do $$
begin
  if to_regclass('public.ai_growth_partner_goals') is not null
     and exists (select 1 from public.ai_growth_partner_goals) then
    raise exception 'Rollback refused: AI Growth Partner goals exist. Export or explicitly remove them first.';
  end if;
end
$$;

drop table if exists public.ai_growth_partner_goals;
