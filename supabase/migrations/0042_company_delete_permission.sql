-- Company archival and deletion must not inherit the separate contact-delete grant.
-- Copy existing defaults and explicit choices first to preserve current behavior.
alter table member_permission_overrides
  drop constraint member_permission_overrides_permission_check;
alter table member_permission_overrides
  add constraint member_permission_overrides_permission_check check (permission in (
    'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
    'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share',
    'sales.view', 'pipelines.manage', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete',
    'appointments.view', 'appointments.book', 'appointments.manage', 'calendars.manage', 'calendars.connect',
    'tasks.manage', 'notes.write', 'inbox.view_all', 'inbox.assign',
    'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export'
  ));

insert into role_permissions(role,permission)
select role,'companies.delete' from role_permissions where permission='contacts.delete'
on conflict do nothing;

insert into member_permission_overrides(org_id,user_id,permission,effect,reason,granted_by)
select org_id,user_id,'companies.delete',effect,'Migrated from contacts.delete',granted_by
from member_permission_overrides where permission='contacts.delete'
on conflict (org_id,user_id,permission) do nothing;

alter table agency_user_permission_overrides
  drop constraint agency_user_permission_overrides_permission_check;
alter table agency_user_permission_overrides
  add constraint agency_user_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'agency.workforce.view', 'agency.workforce.manage',
    'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
    'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book', 'appointments.manage',
    'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign',
    'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export',
    'crm.view', 'setup.manage', 'projects.manage', 'quotes.manage', 'website.create', 'website.publish', 'website.edit', 'website.domains', 'website.review', 'website.archive'
  ));

insert into agency_user_permission_overrides(user_id,permission,effect,reason,updated_by)
select user_id,'companies.delete',effect,'Migrated from contacts.delete',updated_by
from agency_user_permission_overrides where permission='contacts.delete'
on conflict (user_id,permission) do nothing;

alter table invitation_agency_permission_overrides
  drop constraint invitation_agency_permission_overrides_permission_check;
alter table invitation_agency_permission_overrides
  add constraint invitation_agency_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'agency.workforce.view', 'agency.workforce.manage',
    'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
    'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
    'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book', 'appointments.manage',
    'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all', 'inbox.reply', 'inbox.notes', 'inbox.assign',
    'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export',
    'crm.view', 'setup.manage', 'projects.manage', 'quotes.manage', 'website.create', 'website.publish', 'website.edit', 'website.domains', 'website.review', 'website.archive'
  ));

insert into invitation_agency_permission_overrides(invitation_id,permission,effect)
select invitation_id,'companies.delete',effect
from invitation_agency_permission_overrides where permission='contacts.delete'
on conflict (invitation_id,permission) do nothing;

-- Company deletion is a write action: agency access still needs an active write support session.
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
          'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
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
                'contacts.import', 'contacts.delete', 'contacts.export', 'contacts.bulk', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage',
                'smartlists.share', 'pipelines.manage', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete',
                'calendars.manage', 'appointments.book', 'appointments.manage', 'notes.write', 'inbox.reply', 'inbox.notes',
                'inbox.assign', 'tasks.manage', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'analytics.export', 'forms.manage', 'reviews.manage'
              ]::text[]))
            )
        )
      )
    )
$$;
