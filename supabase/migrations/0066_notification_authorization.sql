-- Notification authorization: record who a notification belongs to (client, agency, or direct)
-- and re-check the recipient's current client scope on every read.
--
-- Agency notifications previously stored org_id = null even when they described one client. The
-- recipient was selected from staff_assignments at write time, but a later reassignment or revocation
-- left the old row visible. This migration adds an explicit audience and associates agency rows with
-- the client organisation where the stored link proves it. It never deletes notification history.

alter table notifications add column audience text not null default 'client'
  check (audience in ('client', 'agency', 'direct'));

-- Every historical row addressed to an agency account becomes agency mail. Direct internal mail is
-- indistinguishable after the fact; treating it as agency mail is the safe default because it cannot
-- expose another client's history. Rows that remain without a client org are agency-wide mail and are
-- visible only to holders of agency.security.manage.
update notifications n
   set audience = 'agency'
  from users u
 where u.id = n.user_id
   and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin');

-- Resolve client-specific agency history from the stored destination. Only an exact client id, project
-- id, or support ticket id is trusted. No row is deleted; unresolved rows stay agency-wide.
with resolved as (
  select n.id, (regexp_match(n.link, '^/admin/clients/([0-9a-f-]{36})'))[1]::uuid as org_id
    from notifications n
   where n.audience = 'agency'
     and n.org_id is null
     and n.link ~ '^/admin/clients/[0-9a-f-]{36}'
)
update notifications n
   set org_id = r.org_id
  from resolved r
  join organizations o on o.id = r.org_id
 where n.id = r.id;

with resolved as (
  select n.id, p.org_id
    from notifications n
    join client_project_requests p on n.link = '/admin/projects/' || p.id::text
   where n.audience = 'agency'
     and n.org_id is null
)
update notifications n
   set org_id = r.org_id
  from resolved r
 where n.id = r.id;

with resolved as (
  select n.id, t.org_id
    from notifications n
    join support_tickets t on n.link = '/admin/support/' || t.id::text
   where n.audience = 'agency'
     and n.org_id is null
)
update notifications n
   set org_id = r.org_id
  from resolved r
 where n.id = r.id;

create or replace function app.notification_visible(p_user uuid, p_audience text, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_audience = 'direct' then true
    when p_audience = 'client' then p_org is null or app.user_can_access_org(p_user, p_org)
    when p_audience = 'agency' then
      case
        when p_org is null then coalesce(app.user_has_agency_permission(p_user, 'agency.security.manage'), false)
        else app.user_can_access_org(p_user, p_org)
      end
    else false
  end
$$;

revoke all on function app.notification_visible(uuid, text, uuid) from public;
grant execute on function app.notification_visible(uuid, text, uuid) to iaq_app_user, service_role;

drop policy if exists notifications_select on notifications;
create policy notifications_select on notifications for select to iaq_app_user
  using (
    user_id = app.current_user_id()
    and app.notification_visible(app.current_user_id(), audience, org_id)
  );

drop policy if exists notifications_update on notifications;
create policy notifications_update on notifications for update to iaq_app_user
  using (
    user_id = app.current_user_id()
    and app.notification_visible(app.current_user_id(), audience, org_id)
  )
  with check (
    user_id = app.current_user_id()
    and app.notification_visible(app.current_user_id(), audience, org_id)
  );

create index notifications_user_audience_scope_idx
  on notifications (user_id, audience, org_id, created_at desc);
