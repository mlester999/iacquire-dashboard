-- A saved preview belongs to the conversation until it is confirmed or cancelled.
-- Refuse to remove the column while any conversation still carries that state.
set local lock_timeout = '5s';

do $$
begin
  if exists (
    select 1 from public.chat_conversations where pending_workforce_task is not null
  ) then
    raise exception 'Refusing to roll back 0138: saved Growth Partner task previews exist. Resolve them before removing the preview column.';
  end if;
end
$$;

alter table public.chat_conversations
  drop constraint if exists chat_conversations_pending_workforce_task_size;

alter table public.chat_conversations
  drop column if exists pending_workforce_task;
