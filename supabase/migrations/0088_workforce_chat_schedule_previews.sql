-- Store one short-lived, structured schedule preview per chat conversation.
-- A proposal is not a schedule; confirmation creates it paused through the guarded service path.
alter table public.chat_conversations
  add column if not exists pending_workforce_schedule jsonb
  check (pending_workforce_schedule is null or pg_column_size(pending_workforce_schedule) <= 4096);

comment on column public.chat_conversations.pending_workforce_schedule is
  'Server-only, expiring schedule proposal awaiting explicit chat confirmation; accepted schedules are always saved paused.';
