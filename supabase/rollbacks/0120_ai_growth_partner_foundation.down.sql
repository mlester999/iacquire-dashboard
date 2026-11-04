-- Rollback for 0120_ai_growth_partner_foundation.sql. This is only safe before any partner versions
-- are used by application code or runtime provisioning. It refuses to erase configured state.
do $$
begin
  if exists (select 1 from public.ai_growth_partner_versions) then
    raise exception 'Rollback refused: AI Growth Partner configuration versions exist. Export or migrate them first.';
  end if;
  if exists (
    select 1 from public.ai_growth_partners
    where runtime_agent_instance_id is not null or current_version is not null or status <> 'setup_required'
  ) then
    raise exception 'Rollback refused: an AI Growth Partner is bound, active, paused or provisioning.';
  end if;
end $$;

drop trigger if exists ai_growth_partner_versions_immutable on public.ai_growth_partner_versions;
drop function if exists app.ai_growth_partner_version_no_update();
-- Break the deferred active-version reference before dropping either side of this two-way relationship.
alter table if exists public.ai_growth_partners
  drop constraint if exists ai_growth_partners_current_version_fk;
drop table if exists public.ai_growth_partner_versions;
drop table if exists public.ai_growth_partners;
