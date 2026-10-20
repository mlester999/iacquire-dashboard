-- Rollback for 0068_aqi_operations.
-- Refuses while there is operations data that would be lost silently: action records are an audit
-- trail of what a Super Admin approved, and operations conversations are investigation history.
-- Export or archive them first, then run this again.
do $$
begin
  if exists (select 1 from aqi_ops_actions) then
    raise exception 'aqi_ops_actions has rows; archive them before rolling back 0068';
  end if;
  if exists (select 1 from aqi_conversations where surface = 'operations') then
    raise exception 'operations conversations exist; archive or delete them before rolling back 0068';
  end if;
end
$$;

drop index if exists crm_webhook_deliveries_org_created_idx;
drop index if exists appointment_reminders_org_updated_idx;
drop index if exists audit_logs_action_created_idx;
drop table if exists aqi_ops_briefings;
drop table if exists aqi_ops_briefing_settings;
drop table if exists aqi_ops_actions;
drop index if exists aqi_conversations_surface_idx;
alter table aqi_conversations drop column if exists surface;
