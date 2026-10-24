-- Store one short-lived, structured appointment proposal per chat conversation.
-- A preview does not hold a slot; explicit confirmation calls the guarded booking service.
alter table public.chat_conversations
  add column if not exists pending_workforce_booking jsonb
  check (pending_workforce_booking is null or pg_column_size(pending_workforce_booking) <= 4096);

comment on column public.chat_conversations.pending_workforce_booking is
  'Server-only, expiring appointment proposal awaiting explicit chat confirmation; booking policy and approval gates apply when submitted.';
