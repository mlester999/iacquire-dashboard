-- Employee operating modes and emergency stops.
-- These are enforced at execution time by src/server/automation/gate.ts, never only by the interface.
-- New employees start in approval_required; autonomous needs verified readiness and the owner.

alter table agent_instances
  add column mode text not null default 'approval_required'
    check (mode in ('autonomous', 'approval_required', 'paused')),
  add column mode_changed_by uuid references users(id) on delete set null,
  add column mode_changed_at timestamptz,
  add column mode_reason text check (char_length(mode_reason) <= 500);

-- One row per active or lifted pause. "agency" is the emergency pause only agency staff can set.
-- Client-visible columns never include an agency reason; that stays in the audit log.
create table automation_pauses (
  org_id uuid not null references organizations(id) on delete cascade,
  scope text not null check (scope in ('messaging', 'outbound', 'agency')),
  active boolean not null default false,
  reason text check (char_length(reason) <= 500),
  set_by uuid references users(id) on delete set null,
  set_at timestamptz,
  primary key (org_id, scope),
  -- An agency pause never carries free text a client could read.
  check (scope <> 'agency' or reason is null)
);

alter table automation_pauses enable row level security;
revoke all on automation_pauses from public, anon, authenticated;
grant select (org_id, scope, active, reason, set_at) on automation_pauses to iaq_app_user;
create policy automation_pauses_select on automation_pauses for select to iaq_app_user
  using (app.can_access_org(org_id));

insert into role_permissions (role, permission) values
  ('owner', 'automation.pause'), ('admin', 'automation.pause'),
  ('owner', 'automation.go_autonomous');
