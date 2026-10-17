-- Refuse a downgrade if two independent delete decisions can no longer be represented by one permission.
do $$
begin
  if exists (
    select 1 from (
      select role,
        exists(select 1 from role_permissions p where p.role=r.role and p.permission='contacts.delete') as contacts_allowed,
        exists(select 1 from role_permissions p where p.role=r.role and p.permission='companies.delete') as companies_allowed
      from (select distinct role from role_permissions where permission in ('contacts.delete','companies.delete')) r
    ) effective where contacts_allowed is distinct from companies_allowed
  ) then
    raise exception 'cannot rollback 0042 while company delete role defaults differ from contact delete defaults';
  end if;

  if exists (
    select 1 from member_permission_overrides c
    full join member_permission_overrides co
      on c.org_id=co.org_id and c.user_id=co.user_id
      and c.permission='contacts.delete' and co.permission='companies.delete'
    join organization_memberships m on m.org_id=coalesce(c.org_id,co.org_id) and m.user_id=coalesce(c.user_id,co.user_id)
    where (c.permission='contacts.delete' or co.permission='companies.delete')
      and coalesce(c.effect='grant',exists(select 1 from role_permissions p where p.role=m.role and p.permission='contacts.delete'))
        is distinct from
      coalesce(co.effect='grant',exists(select 1 from role_permissions p where p.role=m.role and p.permission='companies.delete'))
  ) then
    raise exception 'cannot rollback 0042 while member company delete overrides differ from contact delete overrides';
  end if;

  if exists (
    select 1 from users u
    left join agency_user_permission_overrides c on c.user_id=u.id and c.permission='contacts.delete'
    left join agency_user_permission_overrides co on co.user_id=u.id and co.permission='companies.delete'
    where coalesce(c.effect='allow',exists(select 1 from role_permissions p where p.role=u.platform_role and p.permission='contacts.delete'))
      is distinct from
      coalesce(co.effect='allow',exists(select 1 from role_permissions p where p.role=u.platform_role and p.permission='companies.delete'))
  ) then
    raise exception 'cannot rollback 0042 while agency company delete overrides differ from contact delete overrides';
  end if;

  if exists (
    select 1 from invitations i
    left join invitation_agency_permission_overrides c on c.invitation_id=i.id and c.permission='contacts.delete'
    left join invitation_agency_permission_overrides co on co.invitation_id=i.id and co.permission='companies.delete'
    where i.org_id is null and
      coalesce(c.effect='allow',exists(select 1 from role_permissions p where p.role=i.platform_role and p.permission='contacts.delete'))
        is distinct from
      coalesce(co.effect='allow',exists(select 1 from role_permissions p where p.role=i.platform_role and p.permission='companies.delete'))
  ) then
    raise exception 'cannot rollback 0042 while invitation company delete overrides differ from contact delete overrides';
  end if;
end
$$;

delete from member_permission_overrides where permission='companies.delete';
delete from agency_user_permission_overrides where permission='companies.delete';
delete from invitation_agency_permission_overrides where permission='companies.delete';
delete from role_permissions where permission='companies.delete';

alter table member_permission_overrides drop constraint member_permission_overrides_permission_check;
alter table member_permission_overrides add constraint member_permission_overrides_permission_check check (permission in (
  'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
  'companies.view', 'companies.create', 'companies.edit', 'tags.manage', 'fields.manage', 'smartlists.share',
  'sales.view', 'pipelines.manage', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete',
  'appointments.view', 'appointments.book', 'appointments.manage', 'calendars.manage', 'calendars.connect',
  'tasks.manage', 'notes.write', 'inbox.view_all', 'inbox.assign',
  'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export'
));

alter table agency_user_permission_overrides drop constraint agency_user_permission_overrides_permission_check;
alter table agency_user_permission_overrides add constraint agency_user_permission_overrides_permission_check check (permission in (
  'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
  'agency.workforce.view', 'agency.workforce.manage',
  'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
  'companies.view', 'companies.create', 'companies.edit', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
  'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book', 'appointments.manage',
  'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign',
  'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export',
  'crm.view', 'setup.manage', 'projects.manage', 'quotes.manage', 'website.create', 'website.publish', 'website.edit', 'website.domains', 'website.review', 'website.archive'
));

alter table invitation_agency_permission_overrides drop constraint invitation_agency_permission_overrides_permission_check;
alter table invitation_agency_permission_overrides add constraint invitation_agency_permission_overrides_permission_check check (permission in (
  'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
  'agency.workforce.view', 'agency.workforce.manage',
  'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
  'companies.view', 'companies.create', 'companies.edit', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
  'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book', 'appointments.manage',
  'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign',
  'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export',
  'crm.view', 'setup.manage', 'projects.manage', 'quotes.manage', 'website.create', 'website.publish', 'website.edit', 'website.domains', 'website.review', 'website.archive'
));

-- Restore the 0041 authorization function. Companies use the shared contact-delete gate again.
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
          'crm.view', 'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
          'companies.view', 'companies.create', 'companies.edit', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
          'opportunities.view', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book',
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
                'workflows.view', 'analytics.view', 'calls.view', 'team.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge',
                'contacts.import', 'contacts.delete', 'contacts.export', 'contacts.bulk', 'companies.create', 'companies.edit', 'tags.manage', 'fields.manage',
                'smartlists.share', 'pipelines.manage', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete',
                'calendars.manage', 'appointments.book', 'appointments.manage', 'notes.write', 'inbox.reply', 'inbox.notes',
                'inbox.assign', 'tasks.manage', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'analytics.export', 'forms.manage', 'reviews.manage'
              ]::text[]))
            )
        )
      )
    )
$$;
