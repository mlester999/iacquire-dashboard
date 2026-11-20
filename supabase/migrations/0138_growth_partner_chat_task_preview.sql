-- Persist one Growth Partner chat task preview per conversation. Confirmation is a separate,
-- audited action; task rows are created only after the signed-in person confirms the preview.
alter table public.chat_conversations
  add column if not exists pending_workforce_task jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.chat_conversations'::regclass
       and conname = 'chat_conversations_pending_workforce_task_size'
  ) then
    alter table public.chat_conversations
      add constraint chat_conversations_pending_workforce_task_size
      check (pending_workforce_task is null or pg_column_size(pending_workforce_task) <= 4096);
  end if;
end $$;

comment on column public.chat_conversations.pending_workforce_task is
  'A short-lived, requester-scoped Growth Partner chat task preview. The task is created only after an explicit confirmation.';
