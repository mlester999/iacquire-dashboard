-- Add agency managers, explicit scope/permission controls, and auditable Hermes policy drafts.
-- Hermes v0.21.5 exposes toolsets as read-only and has no supported remote policy-write API;
-- policy rows therefore remain explicitly unenforced until the gateway contract changes.

alter table users drop constraint if exists users_platform_role_check;
alter table users add constraint users_platform_role_check
  check (platform_role in ('none', 'agency_staff', 'agency_manager', 'agency_super_admin'));

alter table invitations drop constraint if exists invitations_platform_role_check;
alter table invitations add constraint invitations_platform_role_check
  check (platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin'));
alter table invitations add column agency_scope_mode text;
update invitations set agency_scope_mode = case when platform_role = 'agency_manager' then 'all_clients' else 'assigned_clients' end
  where org_id is null and agency_scope_mode is null;
alter table invitations add constraint invitations_agency_scope_mode_check
  check ((org_id is not null and platform_role is null and agency_scope_mode is null)
      or (org_id is null and platform_role = 'agency_manager' and agency_scope_mode in ('all_clients', 'assigned_clients'))
      or (org_id is null and platform_role = 'agency_staff' and agency_scope_mode = 'assigned_clients'));
alter table invitations add column email_delivery_status text check (email_delivery_status in ('queued', 'captured', 'sent', 'failed'));
alter table invitations add column email_delivery_error text check (char_length(email_delivery_error) <= 300);

alter table role_permissions drop constraint if exists role_permissions_role_check;
alter table role_permissions add constraint role_permissions_role_check
  check (role in ('owner', 'admin', 'member', 'sales_rep', 'support', 'viewer', 'appointment_setter', 'agency_staff', 'agency_manager', 'agency_super_admin'));

-- A manager receives the existing safe operational permissions available to assigned agency staff.
-- Per-client access remains a separate check in app.staff_assigned/app.can_access_org.
insert into role_permissions (role, permission)
select 'agency_manager', permission from role_permissions where role = 'agency_staff'
on conflict do nothing;

insert into role_permissions (role, permission) values
  ('agency_manager', 'agency.clients.create'), ('agency_super_admin', 'agency.clients.create'),
  ('agency_manager', 'agency.clients.invite_users'), ('agency_super_admin', 'agency.clients.invite_users'),
  ('agency_super_admin', 'agency.team.manage'),
  ('agency_manager', 'agency.tool_policies.view'), ('agency_super_admin', 'agency.tool_policies.view'),
  ('agency_super_admin', 'agency.tool_policies.manage'),
  ('agency_manager', 'agency.integrations.health'), ('agency_super_admin', 'agency.integrations.health'),
  ('agency_super_admin', 'agency.integrations.manage'),
  ('agency_staff', 'agency.crm.read'), ('agency_manager', 'agency.crm.read'), ('agency_super_admin', 'agency.crm.read'),
  ('agency_staff', 'agency.crm.manage'), ('agency_manager', 'agency.crm.manage'), ('agency_super_admin', 'agency.crm.manage'),
  ('agency_super_admin', 'agency.security.manage'), ('agency_super_admin', 'agency.billing.manage'),
  ('agency_super_admin', 'agency.settings.manage'), ('agency_super_admin', 'agency.audit.view'),
  ('agency_super_admin', 'agency.workforce.full_capabilities.acknowledge')
on conflict do nothing;

create table agency_user_client_scopes (
  user_id uuid primary key references users(id) on delete cascade,
  scope_mode text not null check (scope_mode in ('all_clients', 'assigned_clients')),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger agency_user_client_scopes_touch before update on agency_user_client_scopes
  for each row execute function app.touch_updated_at();

create or replace function app.guard_agency_user_client_scope() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
declare target_role text;
begin
  select platform_role into target_role from users where id = new.user_id;
  if target_role not in ('agency_staff', 'agency_manager') then
    raise exception 'agency_scope_target_invalid' using errcode = 'check_violation';
  end if;
  if new.scope_mode = 'all_clients' and target_role <> 'agency_manager' then
    raise exception 'agency_staff_scope_must_be_assigned' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger agency_user_client_scopes_guard before insert or update on agency_user_client_scopes
  for each row execute function app.guard_agency_user_client_scope();

create table invitation_client_assignments (
  invitation_id uuid not null references invitations(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  primary key (invitation_id, org_id)
);
alter table invitation_client_assignments enable row level security;
revoke all on invitation_client_assignments from public, anon, authenticated;

-- Individual overrides are deliberately limited to operational permissions. Owner, security,
-- billing, credentials, integration and policy administration are never delegable.
create table agency_user_permission_overrides (
  user_id uuid not null references users(id) on delete cascade,
  permission text not null check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage')),
  effect text not null check (effect in ('allow', 'deny')),
  reason text not null default '' check (char_length(reason) <= 300),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, permission)
);
create trigger agency_user_permission_overrides_touch before update on agency_user_permission_overrides
  for each row execute function app.touch_updated_at();

create or replace function app.guard_agency_permission_override() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from users where id = new.user_id and platform_role = 'agency_super_admin') then
    raise exception 'agency_super_admin_permissions_are_non_delegable' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger agency_user_permission_overrides_guard before insert or update on agency_user_permission_overrides
  for each row execute function app.guard_agency_permission_override();

create or replace function app.user_has_agency_permission(p_user uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select o.effect = 'allow' from agency_user_permission_overrides o
      where o.user_id = u.id and o.permission = p_permission),
    exists (select 1 from role_permissions rp where rp.role = u.platform_role and rp.permission = p_permission),
    false)
  from users u
  where u.id = p_user and u.status = 'active' and u.platform_role <> 'none'
$$;

create or replace function app.has_agency_permission(p_permission text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce(app.user_has_agency_permission(app.current_user_id(), p_permission), false) $$;

create or replace function app.is_agency_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce(app.platform_role() in ('agency_staff', 'agency_manager', 'agency_super_admin'), false) $$;

create or replace function app.staff_assigned(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.is_agency_admin()
      or (
        app.platform_role() = 'agency_manager'
        and exists (select 1 from organizations o where o.id = p_org and o.kind = 'client' and o.status not in ('suspended', 'archived'))
        and coalesce((select s.scope_mode from agency_user_client_scopes s where s.user_id = app.current_user_id()), 'all_clients') = 'all_clients'
      )
      or (
        app.platform_role() in ('agency_staff', 'agency_manager')
        and exists (select 1 from staff_assignments s join organizations o on o.id = s.org_id
                    where s.org_id = p_org and s.user_id = app.current_user_id() and o.kind = 'client' and o.status not in ('suspended', 'archived'))
      )
$$;

create or replace function app.user_can_access_org(p_user uuid, p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from users u where u.id = p_user and u.status = 'active') and (
    exists (select 1 from organization_memberships m join organizations o on o.id = m.org_id
      where m.org_id = p_org and m.user_id = p_user and m.status = 'active'
        and o.status not in ('suspended', 'archived'))
    or exists (select 1 from users u where u.id = p_user and u.status = 'active' and u.platform_role = 'agency_super_admin')
    or exists (select 1 from users u join organizations o on o.id = p_org
      where u.id = p_user and u.status = 'active' and o.kind = 'client' and o.status not in ('suspended', 'archived')
        and (u.platform_role = 'agency_super_admin'
          or (u.platform_role = 'agency_manager' and coalesce((select s.scope_mode from agency_user_client_scopes s where s.user_id = p_user), 'all_clients') = 'all_clients')
          or (u.platform_role in ('agency_staff', 'agency_manager') and exists (select 1 from staff_assignments a where a.user_id = p_user and a.org_id = p_org))))
  )
$$;

create or replace function app.has_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select
    coalesce(
      (select o.effect = 'grant' from member_permission_overrides o
       where o.org_id = p_org and o.user_id = app.current_user_id() and o.permission = p_permission and app.org_role(p_org) is not null),
      exists (select 1 from role_permissions rp where rp.permission = p_permission and rp.role = app.org_role(p_org)),
      false)
    or (app.staff_assigned(p_org) and app.user_has_agency_permission(app.current_user_id(), p_permission))
$$;

revoke all on function app.user_has_agency_permission(uuid, text), app.has_agency_permission(text), app.user_can_access_org(uuid, uuid) from public;
grant execute on function app.user_has_agency_permission(uuid, text), app.has_agency_permission(text), app.user_can_access_org(uuid, uuid) to iaq_app_user;

-- Tighten older broad agency reads to the resource's client scope. Global credentials and
-- gateway configuration remain visible only to the non-delegable Super Admin role.
drop policy if exists integration_status_select on integration_status;
create policy integration_status_select on integration_status for select to iaq_app_user
  using ((org_id is not null and app.has_permission(org_id, 'integrations.view'))
    or (org_id is null and app.has_agency_permission('agency.integrations.health')));

drop policy if exists incidents_select on incidents;
create policy incidents_select on incidents for select to iaq_app_user using (
  app.is_agency_admin()
  or (org_id is not null and app.staff_assigned(org_id) and app.has_permission(org_id, 'incidents.view'))
  or (org_id is not null and client_visible and app.has_permission(org_id, 'incidents.view'))
);
drop policy if exists incident_events_select on incident_events;
create policy incident_events_select on incident_events for select to iaq_app_user using (
  app.is_agency_admin()
  or (org_id is not null and app.staff_assigned(org_id) and app.has_permission(org_id, 'incidents.view'))
  or exists (select 1 from incidents i where i.id = incident_id and i.org_id is not null and i.client_visible and app.has_permission(i.org_id, 'incidents.view'))
);

drop policy if exists fair_use_policies_select on fair_use_policies;
create policy fair_use_policies_select on fair_use_policies for select to iaq_app_user using (
  (org_id is not null and app.staff_assigned(org_id) and app.has_permission(org_id, 'usage.view'))
  or (org_id is null and app.is_agency_admin())
);
drop policy if exists fair_use_status_select on fair_use_status;
create policy fair_use_status_select on fair_use_status for select to iaq_app_user using (app.has_permission(org_id, 'usage.view'));

drop policy if exists hermes_gateways_agency_select on hermes_gateways;
create policy hermes_gateways_agency_select on hermes_gateways for select to iaq_app_user using (app.is_agency_admin());

alter table agency_user_client_scopes enable row level security;
revoke all on agency_user_client_scopes from public, anon, authenticated;
grant select on agency_user_client_scopes to iaq_app_user;
create policy agency_user_client_scopes_select on agency_user_client_scopes for select to iaq_app_user
  using (user_id = app.current_user_id() or app.is_agency_admin());

alter table agency_user_permission_overrides enable row level security;
revoke all on agency_user_permission_overrides from public, anon, authenticated;
grant select on agency_user_permission_overrides to iaq_app_user;
create policy agency_user_permission_overrides_select on agency_user_permission_overrides for select to iaq_app_user
  using (user_id = app.current_user_id() or app.is_agency_admin());

-- Keep agency access boundary data visible only to people already allowed into that client.
drop policy if exists staff_assignments_select on staff_assignments;
create policy staff_assignments_select on staff_assignments for select to iaq_app_user
  using (user_id = app.current_user_id() or app.is_agency_admin()
    or (app.staff_assigned(org_id) and app.has_permission(org_id, 'team.view')));

-- Hermes policies are desired-state records only. The API server's /v1/toolsets endpoint is read-only;
-- it cannot write config or accept per-run tool restrictions, so this table never claims enforcement.
create table hermes_tool_policies (
  id uuid primary key default gen_random_uuid(),
  scope_kind text not null check (scope_kind in ('internal_agency', 'client_default', 'client', 'agent')),
  org_id uuid references organizations(id) on delete cascade,
  agent_id uuid references agent_instances(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  allowed_capabilities text[] not null default '{}',
  blocked_toolsets text[] not null default '{}',
  approval_mode text not null default 'client_rules' check (approval_mode in ('client_rules', 'approval_required', 'read_only')),
  acknowledged_full_capabilities boolean not null default false,
  acknowledged_by uuid references users(id) on delete set null,
  acknowledged_at timestamptz,
  enforcement_status text not null default 'not_enforced' check (enforcement_status = 'not_enforced'),
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope_kind in ('internal_agency', 'client_default') and org_id is null and agent_id is null)
    or (scope_kind = 'client' and org_id is not null and agent_id is null)
    or (scope_kind = 'agent' and agent_id is not null)
  ),
  check (not acknowledged_full_capabilities or scope_kind = 'internal_agency')
);
create unique index hermes_tool_policies_internal_unique on hermes_tool_policies(scope_kind) where scope_kind = 'internal_agency';
create unique index hermes_tool_policies_default_unique on hermes_tool_policies(scope_kind) where scope_kind = 'client_default';
create unique index hermes_tool_policies_client_unique on hermes_tool_policies(org_id) where scope_kind = 'client';
create unique index hermes_tool_policies_agent_unique on hermes_tool_policies(agent_id) where scope_kind = 'agent';
create trigger hermes_tool_policies_touch before update on hermes_tool_policies for each row execute function app.touch_updated_at();

create table hermes_tool_policy_history (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid references hermes_tool_policies(id) on delete set null,
  scope_kind text not null check (scope_kind in ('internal_agency', 'client_default', 'client', 'agent')),
  org_id uuid references organizations(id) on delete cascade,
  agent_id uuid references agent_instances(id) on delete cascade,
  action text not null check (action in ('created', 'updated', 'reset', 'full_capabilities_acknowledged')),
  policy_snapshot jsonb not null check (jsonb_typeof(policy_snapshot) = 'object'),
  actor_user_id uuid references users(id) on delete set null,
  occurred_at timestamptz not null default now()
);

insert into hermes_tool_policies (scope_kind, name, allowed_capabilities, blocked_toolsets, approval_mode)
values ('internal_agency', 'Full Hermes Capabilities', array['full_hermes_capabilities'], '{}', 'client_rules')
on conflict do nothing;
insert into hermes_tool_policies (scope_kind, name, allowed_capabilities, blocked_toolsets, approval_mode)
values ('client_default', 'Managed Automation',
  array['web_search', 'web_research', 'web_extract', 'approved_read_only_browsing', 'client_knowledge', 'client_memory', 'approved_tasks', 'client_crm_read', 'client_crm_write', 'calendar_availability', 'authorized_booking', 'draft_customer_replies', 'authorized_messages', 'client_reporting', 'approved_employee_collaboration'],
  array['terminal', 'file', 'code_execution', 'browser', 'computer_use', 'cronjob', 'delegation', 'connections', 'catalog', 'kanban'],
  'client_rules')
on conflict do nothing;

create table hermes_tool_policy_acknowledgements (
  agent_id uuid primary key references agent_instances(id) on delete cascade,
  policy_id uuid not null references hermes_tool_policies(id) on delete cascade,
  verified_profile text not null check (verified_profile ~ '^iacquire-[a-z0-9-]{3,80}$'),
  acknowledged_by uuid not null references users(id) on delete restrict,
  acknowledged_at timestamptz not null default now()
);
alter table hermes_tool_policy_acknowledgements enable row level security;
revoke all on hermes_tool_policy_acknowledgements from public, anon, authenticated;
grant select on hermes_tool_policy_acknowledgements to iaq_app_user;
create policy hermes_tool_policy_acknowledgements_select on hermes_tool_policy_acknowledgements for select to iaq_app_user
  using (app.has_agency_permission('agency.tool_policies.view'));

alter table hermes_tool_policies enable row level security;
revoke all on hermes_tool_policies from public, anon, authenticated;
grant select on hermes_tool_policies to iaq_app_user;
create policy hermes_tool_policies_select on hermes_tool_policies for select to iaq_app_user
  using (
    (scope_kind in ('internal_agency', 'client_default') and app.has_agency_permission('agency.tool_policies.view'))
    or (scope_kind = 'client' and org_id is not null and app.staff_assigned(org_id) and app.has_agency_permission('agency.tool_policies.view'))
    or (scope_kind = 'agent' and exists (select 1 from agent_instances a join organizations o on o.id=a.org_id where a.id = agent_id and
      a.org_id = hermes_tool_policies.org_id and (o.kind = 'agency' or app.staff_assigned(a.org_id)))
      and app.has_agency_permission('agency.tool_policies.view'))
  );

alter table hermes_tool_policy_history enable row level security;
revoke all on hermes_tool_policy_history from public, anon, authenticated;
grant select on hermes_tool_policy_history to iaq_app_user;
create policy hermes_tool_policy_history_select on hermes_tool_policy_history for select to iaq_app_user
  using (app.has_agency_permission('agency.tool_policies.view') and
    (org_id is null or scope_kind = 'internal_agency' or app.staff_assigned(org_id)));
