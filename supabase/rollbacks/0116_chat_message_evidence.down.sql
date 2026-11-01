-- Rollback for 0116_chat_message_evidence.sql. NOT a migration: review, and run in one transaction.
-- Removes the evidence marker and its check from chat_messages. The marker is derived metadata about a reply (what kind of thing it was), not a business record, so nothing is
-- refused and nothing else depends on it; after this the chat shows no chip on any message, exactly as it did before 0116. Safe to run when the column is already gone.

alter table public.chat_messages drop constraint if exists chat_messages_evidence_shape;
alter table public.chat_messages drop column if exists evidence;
