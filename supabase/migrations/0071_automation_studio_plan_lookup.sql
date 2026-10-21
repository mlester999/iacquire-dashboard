-- Automation Studio: a narrow, read-only way for the portal shell to learn whether a workspace has the plan.
--
-- The shell (every portal page) shows a lock on the Automation Studio menu entry when the workspace has no plan. It runs as the signed-in
-- person, and maintenance_subscriptions is readable by that role only through column grants for people who may see maintenance (0015); the
-- columns the plan lifecycle added in 0069 (grace_ends_at, paid_through_on) are deliberately not granted, and widening the table's grants
-- would also hide the lock from people who can see automations but not maintenance.
--
-- This function returns just the four facts the entitlement decision needs (status, grace end, paid-through date, creation time) for the
-- workspace's current plan, and only to people who can see its automations (the same permission as the screens). It reads nothing else,
-- writes nothing, and the server still decides entitlement itself for every page and action; the menu lock is cosmetic.
-- Rollback: supabase/rollbacks/0071_automation_studio_plan_lookup.down.sql.

create or replace function app.automation_studio_plan(p_org uuid) returns json
language sql stable security definer set search_path = public, pg_temp
as $$
  select json_build_object('id', s.id, 'status', s.status, 'grace_ends_at', s.grace_ends_at, 'paid_through_on', s.paid_through_on::text, 'created_at', s.created_at)
  from maintenance_subscriptions s
  where s.org_id = p_org and app.has_permission(p_org, 'workflows.view')
  order by (s.status in ('requested', 'active', 'past_due', 'cancel_requested')) desc, s.created_at desc
  limit 1
$$;
revoke all on function app.automation_studio_plan(uuid) from public;
grant execute on function app.automation_studio_plan(uuid) to iaq_app_user;
