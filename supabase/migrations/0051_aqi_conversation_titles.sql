-- Conversation title provenance.
--
-- AQi already persists every conversation. Automatic titles must never overwrite a title the person
-- chose. `title_source` records where the current title came from:
--   default  — the placeholder created with the conversation
--   auto     — generated from the conversation topic (model or deterministic fallback)
--   manual   — renamed by the conversation owner
-- Existing non-placeholder titles are treated as manual so the migration cannot rewrite them.

alter table aqi_conversations add column if not exists title_source text;
alter table aqi_conversations add column if not exists title_generated_at timestamptz;

update aqi_conversations
set title_source = case when title = 'New conversation' then 'default' else 'manual' end
where title_source is null;

alter table aqi_conversations alter column title_source set default 'default';
alter table aqi_conversations alter column title_source set not null;
alter table aqi_conversations drop constraint if exists aqi_conversations_title_source_check;
alter table aqi_conversations
  add constraint aqi_conversations_title_source_check
  check (title_source in ('default', 'auto', 'manual'));
