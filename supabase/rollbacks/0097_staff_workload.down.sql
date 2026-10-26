-- Rollback for 0097_staff_workload.sql. NOT a migration: stop the scheduler's staffWorkloadSnapshots job first, review, and run in one transaction. Run it BEFORE the
-- rollback of 0096 (the staff notification kinds it deletes would make 0096's rollback refuse).
-- Refuses when the workload module has been used (a capacity or skills profile, time off, a snapshot, an alert, an assignment made from the board, or rules a Super Admin
-- changed), so a colleague's time off or the founder's rules are never dropped by accident. The workload notices (staff_workload_alert, staff_work_overdue) are derived from
-- that history and are deleted with it, and so is the workspace switch.

do $$
begin
  if exists (select 1 from staff_work_profiles)
     or exists (select 1 from staff_time_off)
     or exists (select 1 from staff_workload_snapshots)
     or exists (select 1 from staff_workload_alerts)
     or exists (select 1 from work_assignment_events)
     or exists (select 1 from staff_workload_settings where rules <> '{}'::jsonb) then
    raise exception 'Rollback refused: staff workload profiles, time off, history, alerts, assignments or changed rules exist. Export them deliberately first.';
  end if;
end $$;

drop policy if exists work_assignment_events_select on work_assignment_events;
drop policy if exists staff_workload_alerts_select on staff_workload_alerts;
drop policy if exists staff_workload_snapshots_select on staff_workload_snapshots;
drop policy if exists staff_workload_settings_select on staff_workload_settings;
drop policy if exists staff_time_off_select on staff_time_off;
drop policy if exists staff_work_profiles_select on staff_work_profiles;

drop table work_assignment_events;
drop table staff_workload_alerts;
drop table staff_workload_snapshots;
drop table staff_workload_settings;
drop table staff_time_off;
drop table staff_work_profiles;

drop function app.can_view_staff_workload(uuid);
drop function app.staff_workload_manage_allowed();
drop function app.staff_workload_team_allowed();
drop function app.staff_workload_allowed();
drop function app.staff_workload_enabled();
drop function app.work_assignment_events_guard();
drop function app.staff_workload_snapshot_guard();
drop function app.staff_work_profile_guard();
drop function app.staff_workload_person_guard();
drop function app.staff_workload_org_guard();

delete from role_permissions where permission in ('agency.workload.view', 'agency.workload.team', 'agency.workload.assign', 'agency.workload.manage', 'agency.workload.settings');
-- The workspace switch and the notices the module made are not history: with the tables gone they would switch the module back on, and make 0096's rollback refuse, the
-- moment 0097 is applied again.
delete from org_features where feature = 'staff_workload';
delete from notifications where kind in ('staff_workload_alert', 'staff_work_overdue');

-- The two per-person override lists lose the four delegable permissions, keeping the order of everything else.
do $$
declare
  t text;
  c text;
  def text;
  perms text[];
  extra text[] := array['agency.workload.view', 'agency.workload.team', 'agency.workload.assign', 'agency.workload.manage'];
begin
  foreach t in array array['agency_user_permission_overrides', 'invitation_agency_permission_overrides'] loop
    c := t || '_permission_check';
    select pg_get_constraintdef(k.oid) into def from pg_constraint k where k.conname = c and k.conrelid = t::regclass;
    if def is null then
      raise exception '% not found', c;
    end if;
    perms := array(select m[1] from regexp_matches(def, '''([a-z0-9_.]+)''::text', 'g') as m);
    if cardinality(perms) < 50 then
      raise exception 'could not read the current agency permission list from % (read %); refusing to rewrite it', c, cardinality(perms);
    end if;
    -- Overrides that name a permission being removed go with it (the constraint would refuse them).
    execute format('delete from %I where permission = any($1)', t) using extra;
    perms := array(select p from unnest(perms) with ordinality as u(p, o) where p <> all(extra) order by o);
    execute format('alter table %I drop constraint %I', t, c);
    execute format('alter table %I add constraint %I check (permission in (%s))', t, c,
      (select string_agg(quote_literal(p), ', ' order by o) from unnest(perms) with ordinality as u(p, o)));
  end loop;
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0097_staff_workload';
