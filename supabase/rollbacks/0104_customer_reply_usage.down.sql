-- Rollback for 0104_customer_reply_usage.sql. NOT a migration: run it in one transaction.
-- Refuses while any customer reply was recorded or any workspace has a reply cap: they are usage and billing evidence, not disposable configuration. Export them deliberately, then remove them.

do $$
begin
  if exists (select 1 from usage_events where kind = 'customer_reply') then
    raise exception 'Rollback refused: customer reply usage was recorded. Export it deliberately first.';
  end if;
  if exists (select 1 from usage_limits where monthly_customer_replies is not null) then
    raise exception 'Rollback refused: a workspace has a monthly customer reply cap. Export it deliberately first.';
  end if;
end $$;

alter table usage_limits drop column monthly_customer_replies;

alter table usage_events drop constraint usage_events_kind_check;
alter table usage_events add constraint usage_events_kind_check check (kind in ('agent_message', 'agent_run_failed', 'lead_research', 'help_request', 'crm_sync'));
