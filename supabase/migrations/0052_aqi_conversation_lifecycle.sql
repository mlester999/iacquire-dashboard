-- 0052_aqi_conversation_lifecycle.sql
-- Explicit AQi conversation lifecycle.
--
-- AQi still persists a turn while it is happening so streaming, attachments, feedback and budget
-- accounting have a real conversation to belong to. A chat is now temporary until the person
-- explicitly saves it: only saved chats appear in conversation history. Closing the panel never
-- changes this state.
--
-- Existing conversations predate the explicit save action. They were visible in history before this
-- migration, so they are backfilled as saved rather than silently disappearing.
-- This migration is local/prepared only until an authorized hosted release.

alter table aqi_conversations
  add column if not exists saved_at timestamptz,
  add column if not exists saved_by uuid references users(id) on delete set null;

update aqi_conversations
set saved_at = created_at
where saved_at is null;

create index if not exists aqi_conversations_saved_idx
  on aqi_conversations (user_id, org_id, saved_at desc nulls last, last_message_at desc);

comment on column aqi_conversations.saved_at is
  'When the person explicitly saved this chat to their history. Null means the chat is temporary and must not appear in history.';
comment on column aqi_conversations.saved_by is
  'The person who explicitly saved this chat. Only set on saved conversations.';
