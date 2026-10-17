-- Website action overrides were introduced in this release and have no prior per-person
-- representation. Stop so an operator can review them before removing that capability.
do $$
begin
  if exists (select 1 from agency_user_permission_overrides where permission in ('website.create','website.edit','website.domains','website.review'))
     or exists (select 1 from invitation_agency_permission_overrides where permission in ('website.create','website.edit','website.domains','website.review')) then
    raise exception 'cannot rollback 0041 while Website Studio team overrides exist';
  end if;
end
$$;

-- The old CRM model has one combined create/edit permission. A deny on either new action wins
-- so rollback cannot accidentally grant the operation that had been removed.
insert into member_permission_overrides as current_override(org_id,user_id,permission,effect,reason,granted_by)
select org_id,user_id,
  case permission when 'contacts.create' then 'contacts.edit' when 'companies.create' then 'companies.edit' else 'opportunities.edit' end,
  effect,reason,granted_by
from member_permission_overrides
where permission in ('contacts.create','companies.create','opportunities.create')
on conflict (org_id,user_id,permission) do update
set effect = case when current_override.effect = 'revoke' or excluded.effect = 'revoke' then 'revoke' else 'grant' end,
    reason = left(concat_ws(' | ', nullif(current_override.reason,''), nullif(excluded.reason,'')),300),
    granted_by = coalesce(current_override.granted_by,excluded.granted_by),
    created_at = now();
delete from member_permission_overrides where permission in ('contacts.create','companies.create','opportunities.create');

insert into agency_user_permission_overrides as current_override(user_id,permission,effect,reason,updated_by)
select user_id,
  case permission when 'contacts.create' then 'contacts.edit' when 'companies.create' then 'companies.edit' else 'opportunities.edit' end,
  effect,reason,updated_by
from agency_user_permission_overrides
where permission in ('contacts.create','companies.create','opportunities.create')
on conflict (user_id,permission) do update
set effect = case when current_override.effect = 'deny' or excluded.effect = 'deny' then 'deny' else 'allow' end,
    reason = left(concat_ws(' | ', nullif(current_override.reason,''), nullif(excluded.reason,'')),300),
    updated_by = coalesce(current_override.updated_by,excluded.updated_by),
    updated_at = now();
delete from agency_user_permission_overrides where permission in ('contacts.create','companies.create','opportunities.create');

insert into invitation_agency_permission_overrides as current_override(invitation_id,permission,effect)
select invitation_id,
  case permission when 'contacts.create' then 'contacts.edit' when 'companies.create' then 'companies.edit' else 'opportunities.edit' end,
  effect
from invitation_agency_permission_overrides
where permission in ('contacts.create','companies.create','opportunities.create')
on conflict (invitation_id,permission) do update
set effect = case when current_override.effect = 'deny' or excluded.effect = 'deny' then 'deny' else 'allow' end;
delete from invitation_agency_permission_overrides where permission in ('contacts.create','companies.create','opportunities.create');

-- Archiving became independent from publishing. Collapse both effective states to the older single
-- publish grant. If they differ, deny both on rollback; this can remove access but cannot broaden it.
with choices as (
  select u.id as user_id,
    coalesce(p.effect='allow',exists(select 1 from role_permissions rp where rp.role=u.platform_role and rp.permission='website.publish')) as publish_allowed,
    coalesce(a.effect='allow',exists(select 1 from role_permissions rp where rp.role=u.platform_role and rp.permission='website.archive')) as archive_allowed,
    exists(select 1 from role_permissions rp where rp.role=u.platform_role and rp.permission='website.publish') as default_allowed,
    p.user_id is not null as had_publish_override
  from users u
  left join agency_user_permission_overrides p on p.user_id=u.id and p.permission='website.publish'
  left join agency_user_permission_overrides a on a.user_id=u.id and a.permission='website.archive'
  where p.user_id is not null or a.user_id is not null
), merged as (
  select user_id,
    case when publish_allowed=archive_allowed then publish_allowed else false end as allowed,
    default_allowed,had_publish_override
  from choices
)
insert into agency_user_permission_overrides as current_override(user_id,permission,effect,reason,updated_by)
select m.user_id,'website.publish',case when m.allowed then 'allow' else 'deny' end,
  'Conservatively merged publish and archive permissions during rollback',coalesce(p.updated_by,a.updated_by)
from merged m
left join agency_user_permission_overrides p on p.user_id=m.user_id and p.permission='website.publish'
left join agency_user_permission_overrides a on a.user_id=m.user_id and a.permission='website.archive'
where m.had_publish_override or m.allowed<>m.default_allowed
on conflict (user_id,permission) do update
set effect=excluded.effect,reason=excluded.reason,updated_by=coalesce(excluded.updated_by,current_override.updated_by),updated_at=now();
delete from agency_user_permission_overrides where permission='website.archive';

with choices as (
  select i.id as invitation_id,
    coalesce(p.effect='allow',exists(select 1 from role_permissions rp where rp.role=i.platform_role and rp.permission='website.publish')) as publish_allowed,
    coalesce(a.effect='allow',exists(select 1 from role_permissions rp where rp.role=i.platform_role and rp.permission='website.archive')) as archive_allowed,
    exists(select 1 from role_permissions rp where rp.role=i.platform_role and rp.permission='website.publish') as default_allowed,
    p.invitation_id is not null as had_publish_override
  from invitations i
  left join invitation_agency_permission_overrides p on p.invitation_id=i.id and p.permission='website.publish'
  left join invitation_agency_permission_overrides a on a.invitation_id=i.id and a.permission='website.archive'
  where p.invitation_id is not null or a.invitation_id is not null
), merged as (
  select invitation_id,
    case when publish_allowed=archive_allowed then publish_allowed else false end as allowed,
    default_allowed,had_publish_override
  from choices
)
insert into invitation_agency_permission_overrides as current_override(invitation_id,permission,effect)
select m.invitation_id,'website.publish',case when m.allowed then 'allow' else 'deny' end
from merged m
where m.had_publish_override or m.allowed<>m.default_allowed
on conflict (invitation_id,permission) do update set effect=excluded.effect;
delete from invitation_agency_permission_overrides where permission='website.archive';

alter table member_permission_overrides
  drop constraint member_permission_overrides_permission_check;
alter table member_permission_overrides
  add constraint member_permission_overrides_permission_check check (permission in (
    'contacts.view', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
    'companies.view', 'companies.edit', 'tags.manage', 'fields.manage', 'smartlists.share',
    'sales.view', 'pipelines.manage', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete',
    'appointments.view', 'appointments.book', 'appointments.manage', 'calendars.manage', 'calendars.connect',
    'tasks.manage', 'notes.write', 'inbox.view_all', 'inbox.assign',
    'workflows.view', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.export'
  ));

alter table agency_user_permission_overrides
  drop constraint agency_user_permission_overrides_permission_check;
alter table agency_user_permission_overrides
  add constraint agency_user_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'agency.workforce.view', 'agency.workforce.manage',
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

alter table invitation_agency_permission_overrides
  drop constraint invitation_agency_permission_overrides_permission_check;
alter table invitation_agency_permission_overrides
  add constraint invitation_agency_permission_overrides_permission_check check (permission in (
    'agency.clients.create', 'agency.clients.invite_users', 'agency.crm.read', 'agency.crm.manage', 'agency.support.view', 'agency.support.manage',
    'agency.workforce.view', 'agency.workforce.manage',
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

delete from role_permissions where permission in ('contacts.create','companies.create','opportunities.create','website.create','website.archive');

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
