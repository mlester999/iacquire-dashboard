-- Rollback for 0112_client_content_policy.sql. NOT a migration: review, and run in one transaction.
-- Puts app.has_permission (migration 0042) and app.permitted_orgs (migration 0060) back exactly as they were, then removes the switch and its function. REFUSED while the switch is on,
-- so a policy a Super Admin turned on is never silently dropped: switch it off first (and say why in the audit log).

do $$
begin
  if exists (select 1 from agency_policy_switches where key = 'client_content_needs_support_session' and enabled) then
    raise exception 'Rollback refused: the client content policy is switched on. Switch it off in the admin screen first.';
  end if;
end $$;

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

create or replace function app.permitted_orgs(p_permission text) returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  -- app.has_permission from migration 0042 combines membership grants with scoped agency access.
  -- CRM permissions in the agency branch also require a current support session in the correct mode.
  select coalesce(array_agg(c.org_id), '{}'::uuid[])
  from (
    select m.org_id from organization_memberships m
    where m.user_id = (select app.current_user_id()) and app.has_permission(m.org_id, p_permission)
    union
    select o.id from organizations o
    where o.kind = 'client' and o.status not in ('suspended', 'archived')
      and (select app.user_has_agency_permission(app.current_user_id(), p_permission))
      and (
        (select app.is_agency_admin())
        or ((select app.platform_role()) = 'agency_manager' and (
          coalesce((select s.scope_mode from agency_user_client_scopes s where s.user_id = (select app.current_user_id())), 'all_clients') = 'all_clients'
          or exists (select 1 from staff_assignments a where a.org_id = o.id and a.user_id = (select app.current_user_id()))
        ))
        or ((select app.platform_role()) in ('agency_staff', 'agency_manager')
          and exists (select 1 from staff_assignments a where a.org_id = o.id and a.user_id = (select app.current_user_id())))
      )
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
          where s.org_id = o.id and s.user_id = (select app.current_user_id())
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
  ) c
$$;

drop function if exists app.client_content_session_required();
drop table if exists agency_policy_switches;
