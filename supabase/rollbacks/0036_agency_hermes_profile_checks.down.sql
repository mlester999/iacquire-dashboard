-- Preserve recorded profile verification evidence. Export and review it before a deliberate rollback.
do $$
begin
  if exists (select 1 from agency_hermes_profile_checks) then
    raise exception 'Rollback refused: Hermes profile verification evidence exists. Export and deliberately preserve those records before removing this feature.';
  end if;
end $$;

drop policy if exists agency_hermes_profile_checks_super_admin_select on agency_hermes_profile_checks;
drop trigger if exists agency_hermes_profile_checks_guard on agency_hermes_profile_checks;
drop function if exists app.guard_agency_hermes_profile_check();
drop table if exists agency_hermes_profile_checks;
