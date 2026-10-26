-- Rollback for 0107_workforce_chat_booking_previews.sql.
-- A preview is a pending user decision; resolve it before dropping the column.
do $$
begin
  if exists (select 1 from public.chat_conversations where pending_workforce_booking is not null) then
    raise exception 'resolve pending appointment booking proposals before rolling back 0107';
  end if;
end $$;

alter table public.chat_conversations drop column if exists pending_workforce_booking;
