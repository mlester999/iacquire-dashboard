-- Per-message verification is retained security evidence. The migration may be
-- reversed only before a target has that evidence, including historical backfill.
set local lock_timeout = '5s';
lock table public.conversation_messages in access exclusive mode;

do $$
begin
  if exists (select 1 from public.conversation_messages where sender_verified) then
    raise exception 'Rollback refused: verified message sender proof exists. Retain migration 0140 and apply a forward fix.';
  end if;
end
$$;

alter table public.conversation_messages drop column sender_verified;
