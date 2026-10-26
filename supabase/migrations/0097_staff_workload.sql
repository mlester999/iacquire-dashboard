-- Phase 6E: staff workload management (agency side). A computed view of work that is already recorded in iAcquire (support requests, setup steps, custom projects and
-- maintenance requests), the agency people's capacity and time off, and a history of how the load moved. Nothing here is visible to a client, a client's customer, the AI
-- employees, Automation Studio or AQi, and no AI is involved anywhere in it.
--
--   * staff_work_profiles: a person's own capacity (points over the planning horizon), the days they work and the skills a manager recorded for them. All optional: a person
--     with no row works Monday to Friday and has the team default capacity, if the Super Admin set one.
--   * staff_time_off: days off (a part day counts half). The person records their own; a manager can record anyone's.
--   * staff_workload_settings: ONE row holding only what the Super Admin changed from the defaults in code (point weights, label thresholds, floors, the horizon, the team
--     default capacity, project-health limits). Every number is a proposal until the founder approves it; the defaults live in src/lib/staff-workload/rules.ts.
--   * staff_workload_snapshots: append-only history, written when a person's label or points change and once a day. Counts only: no client name, no item title.
--   * staff_workload_alerts: one open row per person who is Overloaded or Critical, so "Critical for 5 hours" and "tell the managers once a day" have something to stand on.
--   * work_assignment_events: append-only record of reassignments made from the workload board or from a suggestion (ids only; the modules keep their own histories).
--   * Five agency.workload.* permissions. Labels are for the person themself and for managers, never for clients and never for peers. Staff workload is a feature of the
--     agency workspace that a Super Admin switches on (org_features 'staff_workload'); absent means off.
--
-- Additive. No existing row changes. Every row belongs to the ONE agency workspace (a trigger refuses any other), every table has row-level security, and the application
-- role gets SELECT only: every write runs in trusted server code after its own check of the person's standing. A person's access follows their CURRENT standing: the helpers
-- below read the account's status, role, permission and the module switch on every statement. Nothing is granted to anon, authenticated or the published-site role.
--
-- The notification kinds staff_workload_alert and staff_work_overdue and the audience 'staff' are 0096's. The workload counts only work recorded in iAcquire: meetings,
-- internal tasks, Unified Inbox conversations, client CRM tasks and AI work are not in it.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

-- View: every agency role (a person can be denied it, one by one): their own load, their own items and their own time off.
-- Team: managers and the Super Admin see everyone's labels, the board, the calendar and the escalations. Assign: give work to someone (the module's own assign permission is
-- also needed). Manage: capacity, working days, skills and time off for others. Settings: the Super Admin only, and never delegable. No client role has any of them.
insert into role_permissions (role, permission) values
  ('agency_staff', 'agency.workload.view'), ('agency_manager', 'agency.workload.view'), ('agency_super_admin', 'agency.workload.view'),
  ('agency_manager', 'agency.workload.team'), ('agency_super_admin', 'agency.workload.team'),
  ('agency_manager', 'agency.workload.assign'), ('agency_super_admin', 'agency.workload.assign'),
  ('agency_manager', 'agency.workload.manage'), ('agency_super_admin', 'agency.workload.manage'),
  ('agency_super_admin', 'agency.workload.settings')
on conflict do nothing;

-- The per-person override lists gain the four delegable ones. Read back from the live constraints and extended, keeping the order of what is there, never rewritten from a
-- copy (0096 was the last to extend them; a copy here would drop whatever a later migration added).
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
      raise exception '% not found; cannot extend the agency permission list', c;
    end if;
    perms := array(select m[1] from regexp_matches(def, '''([a-z0-9_.]+)''::text', 'g') as m);
    if cardinality(perms) < 50 then
      raise exception 'could not read the current agency permission list from % (read %); refusing to rewrite it', c, cardinality(perms);
    end if;
    perms := perms || array(select e from unnest(extra) as e where e <> all(perms));
    execute format('alter table %I drop constraint %I', t, c);
    execute format('alter table %I add constraint %I check (permission in (%s))', t, c,
      (select string_agg(quote_literal(p), ', ' order by o) from unnest(perms) with ordinality as u(p, o)));
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Who may see the workload right now
-- ---------------------------------------------------------------------------

-- The module is dormant until a Super Admin switches it on for the agency workspace (a row in org_features; no row means off).
create or replace function app.staff_workload_enabled() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from org_features f join organizations o on o.id = f.org_id
    where o.kind = 'agency' and f.feature = 'staff_workload' and f.enabled
  )
$$;

-- An ACTIVE agency account (disabled, demoted to 'none' or never an agency account: false) that holds the view permission (a deny override: false) while the module is on.
create or replace function app.staff_workload_allowed() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(app.is_agency_staff() and app.has_agency_permission('agency.workload.view') and app.staff_workload_enabled(), false)
$$;

-- Allowed, and also holds the team permission: may see everyone's label.
create or replace function app.staff_workload_team_allowed() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(app.staff_workload_allowed() and app.has_agency_permission('agency.workload.team'), false)
$$;

-- Allowed, and also holds the manage permission: may see and change other people's capacity, working days, skills and time off.
create or replace function app.staff_workload_manage_allowed() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(app.staff_workload_allowed() and app.has_agency_permission('agency.workload.manage'), false)
$$;

-- Whether the caller may see this person's load: their own, or anyone's for a holder of the team permission.
create or replace function app.can_view_staff_workload(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(app.staff_workload_allowed() and (p_user = app.current_user_id() or app.has_agency_permission('agency.workload.team')), false)
$$;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

create or replace function app.staff_workload_org_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from organizations o where o.id = new.org_id and o.kind = 'agency') then
    raise exception 'staff_workload_agency_only' using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- Capacity, time off, snapshots and alerts describe agency people only.
create or replace function app.staff_workload_person_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from users u where u.id = new.user_id and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')) then
    raise exception 'staff_workload_person_must_be_agency_staff' using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Profiles, time off, settings
-- ---------------------------------------------------------------------------

create table staff_work_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  -- Points over the planning horizon for a person with every working day available. Null: the team default applies (and if there is none, no label is shown).
  capacity_points integer check (capacity_points is null or capacity_points between 1 and 200),
  -- Monday is 1 and Sunday is 7.
  working_days smallint[] not null default '{1,2,3,4,5}' check (cardinality(working_days) between 1 and 7 and working_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  -- {skill: level 1..3}, the skills a manager recorded. Never inferred from what a person did.
  skills jsonb not null default '{}'::jsonb check (jsonb_typeof(skills) = 'object' and pg_column_size(skills) <= 512),
  -- Raised by every change, so two managers editing one person's profile at once see a conflict instead of overwriting each other.
  revision integer not null default 1,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function app.staff_work_profile_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id or new.org_id <> old.org_id then
      raise exception 'staff_work_profile_identity_is_fixed' using errcode = 'check_violation';
    end if;
    new.revision := old.revision + 1;
  end if;
  if cardinality(new.working_days) <> (select count(distinct d) from unnest(new.working_days) as d) then
    raise exception 'staff_work_profile_working_days_repeat' using errcode = 'check_violation';
  end if;
  -- The skills are the nine of the code list, each at level 1, 2 or 3.
  if exists (
    select 1 from jsonb_each(new.skills) as e
     where e.key <> all (array['support', 'setup', 'crm', 'website', 'ai_employees', 'integrations', 'billing', 'projects', 'maintenance'])
        or jsonb_typeof(e.value) <> 'number' or e.value::text !~ '^[123]$'
  ) then
    raise exception 'staff_work_profile_skills_invalid' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger staff_work_profiles_agency_only before insert or update of org_id on staff_work_profiles for each row execute function app.staff_workload_org_guard();
create trigger staff_work_profiles_person before insert on staff_work_profiles for each row execute function app.staff_workload_person_guard();
create trigger staff_work_profiles_guard before insert or update on staff_work_profiles for each row execute function app.staff_work_profile_guard();
create trigger staff_work_profiles_touch before update on staff_work_profiles for each row execute function app.touch_updated_at();

create table staff_time_off (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  -- Half a day off. Only for a single day.
  part_day boolean not null default false,
  kind text not null default 'leave' check (kind in ('leave', 'sick', 'holiday', 'training', 'other')),
  -- Seen by the person and by the people who manage time off, never by someone who only reads labels.
  note text check (note is null or char_length(note) <= 200),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (ends_on - starts_on <= 365),
  check (not part_day or starts_on = ends_on)
);
create index staff_time_off_user_idx on staff_time_off (user_id, starts_on, ends_on);
create index staff_time_off_range_idx on staff_time_off (starts_on, ends_on);
create trigger staff_time_off_agency_only before insert or update of org_id on staff_time_off for each row execute function app.staff_workload_org_guard();
create trigger staff_time_off_person before insert on staff_time_off for each row execute function app.staff_workload_person_guard();

-- One row, for the agency workspace, holding only what the Super Admin changed. The row is made the first time something is changed; until then the defaults in code apply.
create table staff_workload_settings (
  id boolean primary key default true check (id),
  org_id uuid not null references organizations(id) on delete cascade,
  rules jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object' and pg_column_size(rules) <= 8192),
  revision integer not null default 1,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger staff_workload_settings_agency_only before insert or update of org_id on staff_workload_settings for each row execute function app.staff_workload_org_guard();
create trigger staff_workload_settings_touch before update on staff_workload_settings for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- History
-- ---------------------------------------------------------------------------

-- Written when a person's label or points change, and once for each day (in the agency's time zone). Counts only: no client name, no item title, no person other than the
-- subject. Append-only; a row can go only after 400 days, when the person no longer exists, or in a purge.
create table staff_workload_snapshots (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  taken_at timestamptz not null default now(),
  -- The agency's calendar day when it was taken.
  day date not null,
  kind text not null check (kind in ('change', 'daily')),
  -- Null when the person's capacity could not be determined.
  label text check (label is null or label in ('available', 'balanced', 'busy', 'overloaded', 'critical')),
  points numeric(8, 2) not null check (points >= 0),
  capacity numeric(8, 2) check (capacity is null or capacity >= 0),
  overdue integer not null check (overdue >= 0),
  items integer not null check (items >= 0),
  escalated integer not null default 0 check (escalated >= 0),
  capacity_source text not null check (capacity_source in ('person', 'default', 'none')),
  rules_revision integer not null check (rules_revision >= 0)
);
-- A second job run on the same day cannot write a second daily row.
create unique index staff_workload_snapshots_daily_idx on staff_workload_snapshots (user_id, day) where kind = 'daily';
create index staff_workload_snapshots_user_idx on staff_workload_snapshots (user_id, taken_at desc);
create index staff_workload_snapshots_age_idx on staff_workload_snapshots (taken_at);
create trigger staff_workload_snapshots_agency_only before insert on staff_workload_snapshots for each row execute function app.staff_workload_org_guard();
create trigger staff_workload_snapshots_person before insert on staff_workload_snapshots for each row execute function app.staff_workload_person_guard();

create or replace function app.staff_workload_snapshot_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and (old.taken_at < now() - interval '400 days' or current_setting('iaq.purge', true) = 'on'
      or not exists (select 1 from users u where u.id = old.user_id)) then
    return old;
  end if;
  raise exception 'staff_workload_snapshots rows are append-only' using errcode = '42501';
end $$;
create trigger staff_workload_snapshots_immutable before update or delete on staff_workload_snapshots for each row execute function app.staff_workload_snapshot_guard();

-- One open row for each person who is Overloaded or Critical. "since" is when this stretch began; "critical_since" is when the person last became Critical within it.
create table staff_workload_alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  label text not null check (label in ('overloaded', 'critical')),
  since timestamptz not null default now(),
  critical_since timestamptz,
  -- The last time the managers were told about this stretch.
  notified_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check ((label = 'critical') = (critical_since is not null)),
  check (resolved_at is null or resolved_at >= since)
);
create unique index staff_workload_alerts_one_open on staff_workload_alerts (user_id) where resolved_at is null;
create index staff_workload_alerts_age_idx on staff_workload_alerts (resolved_at) where resolved_at is not null;
create trigger staff_workload_alerts_agency_only before insert or update of org_id on staff_workload_alerts for each row execute function app.staff_workload_org_guard();
create trigger staff_workload_alerts_person before insert on staff_workload_alerts for each row execute function app.staff_workload_person_guard();

-- Who gave which item to whom, from the board or from a suggestion. Ids only (a person's id can name no one once they are gone); client_ref is a soft reference to the
-- client workspace, with no foreign key, so removing a client never touches this history and the history never holds a client's name.
create table work_assignment_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  source text not null check (source in ('support', 'setup_task', 'project', 'maintenance')),
  item_id uuid not null,
  client_ref uuid,
  from_user uuid,
  to_user uuid,
  actor_id uuid not null,
  via text not null check (via in ('board', 'suggestion')),
  created_at timestamptz not null default now(),
  check (from_user is distinct from to_user)
);
create index work_assignment_events_to_idx on work_assignment_events (to_user, created_at desc) where to_user is not null;
create index work_assignment_events_item_idx on work_assignment_events (item_id, created_at);
create trigger work_assignment_events_agency_only before insert on work_assignment_events for each row execute function app.staff_workload_org_guard();

create or replace function app.work_assignment_events_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and current_setting('iaq.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'work_assignment_events rows are append-only' using errcode = '42501';
end $$;
create trigger work_assignment_events_immutable before update or delete on work_assignment_events for each row execute function app.work_assignment_events_guard();

revoke all on function app.staff_workload_enabled(), app.staff_workload_allowed(), app.staff_workload_team_allowed(), app.staff_workload_manage_allowed(),
  app.can_view_staff_workload(uuid) from public, anon, authenticated;
grant execute on function app.staff_workload_enabled(), app.staff_workload_allowed(), app.staff_workload_team_allowed(), app.staff_workload_manage_allowed(),
  app.can_view_staff_workload(uuid) to iaq_app_user;

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in person's standing, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table staff_work_profiles enable row level security;
alter table staff_time_off enable row level security;
alter table staff_workload_settings enable row level security;
alter table staff_workload_snapshots enable row level security;
alter table staff_workload_alerts enable row level security;
alter table work_assignment_events enable row level security;

revoke all on staff_work_profiles, staff_time_off, staff_workload_settings, staff_workload_snapshots, staff_workload_alerts, work_assignment_events from public, anon, authenticated;
grant select on staff_work_profiles, staff_time_off, staff_workload_settings, staff_workload_snapshots, staff_workload_alerts, work_assignment_events to iaq_app_user;

-- A profile and a person's history are theirs and, for a holder of the team permission, everyone's. Time off is the person's and the managers of time off (the team
-- permission shows who is away, through the server, not the reason). Alerts and board history are for the team permission. Every policy also names the one agency workspace,
-- so no row can be read by a request running for any other organization even if the permission helpers were ever changed by mistake.
create policy staff_work_profiles_select on staff_work_profiles for select to iaq_app_user
  using (org_id = (select o.id from organizations o where o.kind = 'agency')
    and ((user_id = (select app.current_user_id()) and (select app.staff_workload_allowed())) or (select app.staff_workload_team_allowed())));
create policy staff_time_off_select on staff_time_off for select to iaq_app_user
  using (org_id = (select o.id from organizations o where o.kind = 'agency')
    and ((user_id = (select app.current_user_id()) and (select app.staff_workload_allowed())) or (select app.staff_workload_manage_allowed())));
create policy staff_workload_settings_select on staff_workload_settings for select to iaq_app_user
  using (org_id = (select o.id from organizations o where o.kind = 'agency') and (select app.staff_workload_allowed()));
create policy staff_workload_snapshots_select on staff_workload_snapshots for select to iaq_app_user
  using (org_id = (select o.id from organizations o where o.kind = 'agency')
    and ((user_id = (select app.current_user_id()) and (select app.staff_workload_allowed())) or (select app.staff_workload_team_allowed())));
create policy staff_workload_alerts_select on staff_workload_alerts for select to iaq_app_user
  using (org_id = (select o.id from organizations o where o.kind = 'agency') and (select app.staff_workload_team_allowed()));
create policy work_assignment_events_select on work_assignment_events for select to iaq_app_user
  using (org_id = (select o.id from organizations o where o.kind = 'agency') and (select app.staff_workload_team_allowed()));
