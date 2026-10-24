-- Rollback for 0088_workforce_chat_schedule_previews.sql.
-- Pending proposals are drafts; remove them before dropping the column.
alter table public.chat_conversations drop column if exists pending_workforce_schedule;
