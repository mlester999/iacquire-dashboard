-- Rollback for 0106_workforce_chat_schedule_previews.sql.
-- A preview is a pending user decision; resolve it before dropping the column.
do $$
begin
  if exists (select 1 from public.chat_conversations where pending_workforce_schedule is not null) then
    raise exception 'resolve pending workforce schedule proposals before rolling back 0106';
  end if;
end $$;

alter table public.chat_conversations drop column if exists pending_workforce_schedule;
