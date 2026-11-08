do $$
begin
  if exists (select 1 from ai_growth_partner_legacy_knowledge) then
    raise exception 'Rollback refused: AI Growth Partner legacy knowledge snapshots exist; preserve them before rollback';
  end if;
end $$;

drop policy ai_growth_partner_legacy_knowledge_select on ai_growth_partner_legacy_knowledge;
drop table ai_growth_partner_legacy_knowledge;
