-- Rollback for 0047_aqi_assistant.sql. NOT a migration.
-- Refuses while AQi conversations exist; export or delete them deliberately first.
do $$
begin
  if exists (select 1 from aqi_conversations) then
    raise exception 'Rollback refused: AQi conversations exist. Export or remove them deliberately first.';
  end if;
end $$;

drop table if exists aqi_usage_events;
drop table if exists aqi_messages;
drop table if exists aqi_conversations;
drop table if exists aqi_suggested_questions;
drop table if exists aqi_knowledge_entries;
drop table if exists aqi_config_versions;
