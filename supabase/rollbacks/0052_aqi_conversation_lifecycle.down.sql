-- Rollback for 0052_aqi_conversation_lifecycle.
-- The lifecycle flag is dropped; the previous code treats every conversation as history again.
drop index if exists aqi_conversations_saved_idx;
alter table aqi_conversations drop column if exists saved_by;
alter table aqi_conversations drop column if exists saved_at;
