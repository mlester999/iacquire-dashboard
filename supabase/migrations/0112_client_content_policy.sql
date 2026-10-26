-- 0112_client_content_policy.sql — a FLAGGED, OFF-BY-DEFAULT alternative for founder decision D70: who may read a client's approvals, activity, knowledge and leads without a support session.
--
-- TODAY (and after this migration, until a Super Admin switches the policy on): assigned agency staff can read a client's approvals, the client's activity log, shared knowledge and leads
-- WITHOUT a support session. CRM, inbox, calls and analytics are already behind one (a reasoned, time-limited, audited crm_support_session). The founder has not decided whether the four
-- employee-content areas should be too (docs/roadmap/phases-3-to-7/decisions.md D70), so nothing about what anyone can read changes here.
--
-- What this adds, all inert until the switch is turned on:
--   * agency_policy_switches: a row exists only once a Super Admin has changed the switch (no row means OFF). Server only (no grant to any signed-in role). A Super Admin changes it in the admin screen, with a note;
--     it is audited with who and when.
--   * app.client_content_session_required(): reads the switch (false when the row is missing).
--   * app.has_permission and app.permitted_orgs: the agency branch treats approvals.view, activity.view, knowledge.view and leads.view exactly like the CRM permissions while the switch is on
--     (needs an active read or write support session on that client), and a read or write session unlocks them. While it is off the two functions answer exactly as they did before (the
--     test tests/client-content-policy.test.ts compares the old and the new answers for every permission, role and session state). Client members are unaffected either way.
-- Both functions are the ones migration 0042 and migration 0060 wrote, with only the gate edited; the rollback puts those texts back.

create table agency_policy_switches (
  key text primary key check (key in ('client_content_needs_support_session')),
  enabled boolean not null default false,
  changed_by uuid references users(id) on delete set null,
  changed_at timestamptz,
  note text check (note is null or char_length(note) <= 400)
);
alter table agency_policy_switches enable row level security;
revoke all on agency_policy_switches from public, anon, authenticated, iaq_app_user, iaq_site_runtime;

create function app.client_content_session_required() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select s.enabled from agency_policy_switches s where s.key = 'client_content_needs_support_session'), false)
$$;
revoke all on function app.client_content_session_required() from public;
grant execute on function app.client_content_session_required() to iaq_app_user;

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
        (p_permission not in (
          'crm.view', 'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
          'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
          'opportunities.view', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book',
          'appointments.manage', 'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all',
          'inbox.reply', 'inbox.assign', 'inbox.notes', 'inbox.resume_ai', 'workflows.view', 'workflows.manage', 'templates.manage',
          'campaigns.manage', 'campaigns.send', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.view', 'analytics.export',
          'crm.provider.manage', 'crm.api.manage', 'crm.permissions.manage'
        ) and not (p_permission in ('approvals.view', 'activity.view', 'knowledge.view', 'leads.view') and app.client_content_session_required()))
        or exists (
          select 1 from crm_support_sessions s
          where s.org_id = p_org and s.user_id = app.current_user_id()
            and s.ended_at is null and s.expires_at > now()
            and (
              (s.mode = 'read' and p_permission = any(array[
                'crm.view', 'contacts.view', 'companies.view', 'sales.view', 'appointments.view', 'inbox.view', 'inbox.view_all',
                'workflows.view', 'analytics.view', 'calls.view', 'team.view', 'approvals.view', 'activity.view', 'knowledge.view', 'leads.view'
              ]::text[]))
              or (s.mode = 'write' and p_permission = any(array[
                'crm.view', 'contacts.view', 'companies.view', 'sales.view', 'appointments.view', 'inbox.view', 'inbox.view_all',
                'workflows.view', 'analytics.view', 'calls.view', 'team.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge',
                'contacts.import', 'contacts.delete', 'contacts.export', 'contacts.bulk', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage',
                'smartlists.share', 'pipelines.manage', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete',
                'calendars.manage', 'appointments.book', 'appointments.manage', 'notes.write', 'inbox.reply', 'inbox.notes',
                'inbox.assign', 'tasks.manage', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'analytics.export', 'forms.manage', 'reviews.manage', 'approvals.view', 'activity.view', 'knowledge.view', 'leads.view'
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
        (p_permission not in (
          'crm.view', 'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
          'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
          'opportunities.view', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book',
          'appointments.manage', 'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all',
          'inbox.reply', 'inbox.assign', 'inbox.notes', 'inbox.resume_ai', 'workflows.view', 'workflows.manage', 'templates.manage',
          'campaigns.manage', 'campaigns.send', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.view', 'analytics.export',
          'crm.provider.manage', 'crm.api.manage', 'crm.permissions.manage'
        ) and not (p_permission in ('approvals.view', 'activity.view', 'knowledge.view', 'leads.view') and app.client_content_session_required()))
        or exists (
          select 1 from crm_support_sessions s
          where s.org_id = o.id and s.user_id = (select app.current_user_id())
            and s.ended_at is null and s.expires_at > now()
            and (
              (s.mode = 'read' and p_permission = any(array[
                'crm.view', 'contacts.view', 'companies.view', 'sales.view', 'appointments.view', 'inbox.view', 'inbox.view_all',
                'workflows.view', 'analytics.view', 'calls.view', 'team.view', 'approvals.view', 'activity.view', 'knowledge.view', 'leads.view'
              ]::text[]))
              or (s.mode = 'write' and p_permission = any(array[
                'crm.view', 'contacts.view', 'companies.view', 'sales.view', 'appointments.view', 'inbox.view', 'inbox.view_all',
                'workflows.view', 'analytics.view', 'calls.view', 'team.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge',
                'contacts.import', 'contacts.delete', 'contacts.export', 'contacts.bulk', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage',
                'smartlists.share', 'pipelines.manage', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete',
                'calendars.manage', 'appointments.book', 'appointments.manage', 'notes.write', 'inbox.reply', 'inbox.notes',
                'inbox.assign', 'tasks.manage', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'analytics.export', 'forms.manage', 'reviews.manage', 'approvals.view', 'activity.view', 'knowledge.view', 'leads.view'
              ]::text[]))
            )
        )
      )
  ) c
$$;
revoke all on function app.permitted_orgs(text) from public;
grant execute on function app.permitted_orgs(text) to iaq_app_user;
