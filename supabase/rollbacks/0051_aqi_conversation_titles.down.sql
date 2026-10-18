-- Rollback for 0051_aqi_conversation_titles.
-- Conversation data is preserved; only the provenance metadata is removed.
alter table aqi_conversations drop constraint if exists aqi_conversations_title_source_check;
alter table aqi_conversations drop column if exists title_generated_at;
alter table aqi_conversations drop column if exists title_source;
