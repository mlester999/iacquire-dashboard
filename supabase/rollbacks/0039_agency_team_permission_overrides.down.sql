-- Refuse a destructive rollback if new per-person or invitation settings exist.
do $$
begin
  if exists (
    select 1 from agency_user_permission_overrides
    where permission not in ('agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage')
  ) then
    raise exception 'cannot rollback 0039 while expanded agency permission overrides exist';
  end if;
  if exists (select 1 from invitation_agency_permission_overrides) then
    raise exception 'cannot rollback 0039 while invitation permission drafts exist';
  end if;
end
$$;

drop table agency_team_member_versions;
drop table invitation_agency_permission_overrides;

-- Restore the CRM RLS permission behavior installed by 0038.
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

create or replace function app.file_permission(p_org uuid, p_bucket text, p_write boolean, p_visibility text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (p_visibility = 'client' or app.staff_assigned(p_org)) and
    case p_bucket
      when 'company-documents' then app.has_permission(p_org, case when p_write then 'knowledge.edit' else 'knowledge.view' end)
      when 'support-attachments' then app.has_permission(p_org, 'support.use') or app.staff_assigned(p_org)
      when 'project-files' then case when p_write then app.staff_assigned(p_org) else app.has_permission(p_org, 'setup.view') end
      when 'project-uploads' then app.has_permission(p_org, case when p_write then 'projects.request' else 'projects.view' end) or app.staff_assigned(p_org)
      when 'portfolio-assets' then app.is_agency_admin()
      when 'brand-assets' then app.has_permission(p_org, case when p_write then 'workspace.manage_profile' else 'workspace.view' end)
      else false end,
    false)
$$;

delete from role_permissions where role in ('agency_staff','agency_manager','agency_super_admin') and permission in ('agency.support.view','agency.support.manage');

alter table agency_user_permission_overrides
  drop constraint agency_user_permission_overrides_permission_check;
alter table agency_user_permission_overrides
  add constraint agency_user_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage'
  ));

delete from role_permissions
  where role in ('agency_staff', 'agency_manager')
    and permission in ('crm.view', 'contacts.view', 'companies.view', 'inbox.view', 'inbox.view_all', 'workflows.view', 'calls.view');
insert into role_permissions(role, permission) values
  ('agency_staff', 'agency.crm.manage'), ('agency_manager', 'agency.crm.manage')
on conflict do nothing;

\n