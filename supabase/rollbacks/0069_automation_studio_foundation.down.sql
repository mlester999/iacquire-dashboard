-- Rollback for 0069_automation_studio_foundation.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the
-- scheduler first, and run it in one transaction. Roll back later migrations first (highest number first).
--
-- It refuses while anything exists that only this migration can represent: workflows built in Automation Studio, versions that use premium
-- features, plans that are past due or expired, and usage counters or limits (they are the billing and fair-use evidence).

do $$
begin
  if exists (select 1 from crm_workflows where origin = 'studio' or entitlement_paused_at is not null) then
    raise exception 'Rollback refused: workflows built in Automation Studio (or paused because the plan lapsed) exist. Export or remove them deliberately first.';
  end if;
  if exists (select 1 from crm_workflow_versions where cardinality(premium_features) > 0) then
    raise exception 'Rollback refused: published workflow versions that use premium features exist.';
  end if;
  if exists (select 1 from maintenance_subscriptions where status in ('past_due', 'expired')
      or past_due_since is not null or grace_ends_at is not null or expired_at is not null or last_payment_verified_at is not null or paid_through_on is not null) then
    raise exception 'Rollback refused: maintenance plans carry payment-lifecycle history (past due, expired or verified payments). Resolve them deliberately first.';
  end if;
  if exists (select 1 from automation_studio_usage) or exists (select 1 from automation_studio_limits) then
    raise exception 'Rollback refused: Automation Studio usage counters or limits exist. Export them first.';
  end if;
end $$;

drop policy if exists automation_studio_usage_select on automation_studio_usage;
drop policy if exists automation_studio_limits_select on automation_studio_limits;
drop table automation_studio_usage;
drop table automation_studio_limits;

drop index if exists crm_workflow_runs_live_idx;
drop index if exists crm_workflows_studio_idx;
drop index if exists crm_workflow_versions_premium_idx;

drop trigger if exists crm_workflow_versions_frozen on crm_workflow_versions;
create trigger crm_workflow_versions_frozen before update of version, trigger_config, steps, effects, content_hash, workflow_id, org_id
  on crm_workflow_versions for each row execute function app.block_update();
alter table crm_workflow_versions drop column premium_features;

alter table crm_workflows drop constraint crm_workflows_entitlement_pause_check;
alter table crm_workflows drop column entitlement_paused_at;
alter table crm_workflows drop column origin;

drop index if exists maintenance_one_open_plan;
create unique index maintenance_one_open_plan on maintenance_subscriptions (org_id) where status in ('requested', 'active', 'cancel_requested');
alter table maintenance_subscriptions drop constraint maintenance_subscriptions_grace_check;
alter table maintenance_subscriptions drop constraint maintenance_subscriptions_lifecycle_check;
alter table maintenance_subscriptions
  drop column past_due_since,
  drop column grace_ends_at,
  drop column expired_at,
  drop column last_payment_verified_at,
  drop column last_payment_verified_by,
  drop column paid_through_on;
alter table maintenance_subscriptions drop constraint maintenance_subscriptions_status_check;
alter table maintenance_subscriptions add constraint maintenance_subscriptions_status_check
  check (status in ('requested', 'active', 'cancel_requested', 'cancelled', 'declined'));
