-- Rollback for 0089_workforce_chat_booking_previews.sql.
-- A preview is not a booking; drop any pending proposal before removing the column.
alter table public.chat_conversations drop column if exists pending_workforce_booking;
