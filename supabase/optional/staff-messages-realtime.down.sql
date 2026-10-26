-- Removes what supabase/optional/staff-messages-realtime.sql added. NOT a migration. Safe to run when the other file was never applied.

drop policy if exists iaq_staffmsg_realtime_read on realtime.messages;
drop function if exists app.staff_topic_allowed(text);
