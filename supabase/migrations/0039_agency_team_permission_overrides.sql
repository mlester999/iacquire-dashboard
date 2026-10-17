-- Extend the existing agency team model with invitation permission drafts,
-- per-action overrides, and a revision counter for conflict-safe edits.
-- Role defaults stay in role_permissions and are not copied into each member row.

alter table agency_user_permission_overrides
  drop constraint if exists agency_user_permission_overrides_permission_check;
alter table agency_user_permission_overrides
  add constraint agency_user_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'contacts.view', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete',
    'contacts.import', 'contacts.export', 'contacts.bulk', 'companies.view', 'companies.edit',
    'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view',
    'appointments.book', 'appointments.manage', 'calendars.manage', 'calendars.connect',
    'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign', 'workflows.view',
    'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage',
    'calls.view', 'analytics.export', 'crm.view', 'setup.manage',
    'projects.manage', 'quotes.manage', 'website.publish'
  ));

create table invitation_agency_permission_overrides (
  invitation_id uuid not null references invitations(id) on delete cascade,
  permission text not null check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'contacts.view', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete',
    'contacts.import', 'contacts.export', 'contacts.bulk', 'companies.view', 'companies.edit',
    'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view',
    'appointments.book', 'appointments.manage', 'calendars.manage', 'calendars.connect',
    'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign', 'workflows.view',
    'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage',
    'calls.view', 'analytics.export', 'crm.view', 'setup.manage',
    'projects.manage', 'quotes.manage', 'website.publish'
  )),
  effect text not null check (effect in ('allow', 'deny')),
  primary key (invitation_id, permission)
);
alter table invitation_agency_permission_overrides enable row level security;
revoke all on invitation_agency_permission_overrides from public, anon, authenticated;

create table agency_team_member_versions (
  user_id uuid primary key references users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table agency_team_member_versions enable row level security;
revoke all on agency_team_member_versions from public, anon, authenticated;
insert into agency_team_member_versions(user_id)
  select id from users where platform_role in ('agency_manager', 'agency_staff')
  on conflict (user_id) do nothing;

-- Manager and Staff receive read access to the CRM records exposed in an audited support session.
-- Any write, delete or export still needs an explicit, per-person override and a write session.
insert into role_permissions(role, permission) values
  ('agency_staff', 'crm.view'), ('agency_manager', 'crm.view'),
  ('agency_staff', 'contacts.view'), ('agency_manager', 'contacts.view'),
  ('agency_staff', 'companies.view'), ('agency_manager', 'companies.view'),
  ('agency_staff', 'inbox.view'), ('agency_manager', 'inbox.view'),
  ('agency_staff', 'inbox.view_all'), ('agency_manager', 'inbox.view_all'),
  ('agency_staff', 'workflows.view'), ('agency_manager', 'workflows.view'),
  ('agency_staff', 'calls.view'), ('agency_manager', 'calls.view')
on conflict do nothing;
-- Support access is an assigned-client operation; writes are individually revocable.
insert into role_permissions(role, permission) values
  ('agency_staff', 'agency.support.view'), ('agency_manager', 'agency.support.view'),
  ('agency_staff', 'agency.support.manage'), ('agency_manager', 'agency.support.manage'),
  ('agency_super_admin', 'agency.support.view'), ('agency_super_admin', 'agency.support.manage')
on conflict do nothing;

-- File RLS must enforce the same scope and per-person support grants as server actions.
create or replace function app.file_permission(p_org uuid, p_bucket text, p_write boolean, p_visibility text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (p_visibility = 'client' or app.staff_assigned(p_org)) and
    case p_bucket
      when 'company-documents' then app.has_permission(p_org, case when p_write then 'knowledge.edit' else 'knowledge.view' end)
      when 'support-attachments' then
        case when app.is_agency_staff() then
          app.user_can_access_org(app.current_user_id(), p_org)
          and app.user_has_agency_permission(app.current_user_id(), case when p_write then 'agency.support.manage' else 'agency.support.view' end)
          and (p_visibility = 'client' or p_visibility = 'internal')
        else p_visibility = 'client' and app.has_permission(p_org, 'support.use') end
      when 'project-files' then case when p_write then app.staff_assigned(p_org) else app.has_permission(p_org, 'setup.view') end
      when 'project-uploads' then app.has_permission(p_org, case when p_write then 'projects.request' else 'projects.view' end) or app.staff_assigned(p_org)
      when 'portfolio-assets' then app.is_agency_admin()
      when 'brand-assets' then app.has_permission(p_org, case when p_write then 'workspace.manage_profile' else 'workspace.view' end)
      else false end,
    false)
$$;

-- Agency permissions can reach client CRM rows only from an active, audited support session.
-- Assignment and per-person action grants are checked again, so this does not expose raw RLS
-- reads to an agency account merely because it has client scope.
create or replace function app.has_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
      (select o.effect = 'grant' from member_permission_overrides o
       where o.org_id = p_org and o.user_id = app.current_user_id() and o.permission = p_permission and app.org_role(p_org) is not null),
      exists (select 1 from role_permissions rp where rp.permission = p_permission and rp.role = app.org_role(p_org)),
      false)
    or (
      app.staff_assigned(p_org)
      and app.user_can_access_org(app.current_user_id(), p_org)
      and exists (select 1 from organizations tenant where tenant.id=p_org and tenant.kind='client' and tenant.status not in ('suspended','archived'))
      and app.user_has_agency_permission(app.current_user_id(), p_permission)
      and (
        p_permission not in (
          'crm.view', 'contacts.view', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
          'companies.view', 'companies.edit', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
          'opportunities.view', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book',
          'appointments.manage', 'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all',
          'inbox.reply', 'inbox.assign', 'inbox.notes', 'inbox.resume_ai', 'workflows.view', 'workflows.manage', 'templates.manage',
          'campaigns.manage', 'campaigns.send', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.view', 'analytics.export',
          'crm.provider.manage', 'crm.api.manage', 'crm.permissions.manage'
        )
        or exists (
          select 1 from crm_support_sessions s
          where s.org_id = p_org and s.user_id = app.current_user_id()
            and s.ended_at is null and s.expires_at > now()
            and (
              (s.mode = 'read' and p_permission = any(array[
                'crm.view', 'contacts.view', 'companies.view', 'sales.view', 'appointments.view', 'inbox.view', 'inbox.view_all',
                'workflows.view', 'analytics.view', 'calls.view', 'team.view'
              ]::text[]))
              or (s.mode = 'write' and p_permission = any(array[
                'crm.view', 'contacts.view', 'companies.view', 'sales.view', 'appointments.view', 'inbox.view', 'inbox.view_all',
                'workflows.view', 'analytics.view', 'calls.view', 'team.view', 'contacts.edit', 'contacts.assign', 'contacts.merge',
                'contacts.import', 'contacts.delete', 'contacts.export', 'contacts.bulk', 'companies.edit', 'tags.manage', 'fields.manage',
                'smartlists.share', 'pipelines.manage', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete',
                'calendars.manage', 'appointments.book', 'appointments.manage', 'notes.write', 'inbox.reply', 'inbox.notes',
                'inbox.assign', 'tasks.manage', 'workflows.manage', 'templates.manage', 'forms.manage', 'reviews.manage'
              ]::text[]))
            )
        )
      )
    )
$$;

-- CRM write sessions are opt-in per person. Super Admin remains the only default grant.
delete from role_permissions
  where role in ('agency_staff', 'agency_manager') and permission = 'agency.crm.manage';

\n