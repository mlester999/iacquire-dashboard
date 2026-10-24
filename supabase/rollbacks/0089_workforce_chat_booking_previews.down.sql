-- Rollback for 0089_workforce_chat_booking_previews.sql.
-- A preview is a pending user decision; resolve it before dropping the column.
do $$
begin
  if exists (select 1 from public.chat_conversations where pending_workforce_booking is not null) then
    raise exception 'resolve pending appointment booking proposals before rolling back 0089';
  end if;
end $$;

alter table public.chat_conversations drop column if exists pending_workforce_booking;
