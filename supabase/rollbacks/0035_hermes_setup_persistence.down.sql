-- Rollback for 0035_hermes_setup_persistence.sql. Review and back up before running.
-- Never discard saved setup or administrator change history.
do $$
begin
  if exists (select 1 from hermes_gateway_configuration_history)
     or exists (select 1 from hermes_gateway_setup_drafts)
     or exists (select 1 from hermes_gateway_setup_draft_history)
     or exists (select 1 from hermes_gateway_setup_progress)
     or exists (select 1 from hermes_gateways where updated_by is not null) then
    raise exception 'Rollback refused: Hermes setup history or progress exists. Export and deliberately preserve those records before removing this feature.';
  end if;
end $$;

drop table if exists hermes_gateway_setup_progress;
drop table if exists hermes_gateway_setup_draft_history;
drop table if exists hermes_gateway_setup_drafts;
drop table if exists hermes_gateway_configuration_history;
alter table hermes_gateways drop column if exists updated_by;
