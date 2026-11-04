-- Rollback for 0121_ai_growth_partner_conversation.sql.
-- This refuses if the canonical conversation shape has been used, so rollback cannot erase or
-- strand a shared employee history.
do $$
begin
  if exists (select 1 from public.chat_conversations where growth_partner_id is not null or user_id is null) then
    raise exception 'Rollback refused: canonical or ownerless chat history exists. Export or migrate it first.';
  end if;
  if exists (select 1 from public.ai_growth_partners where runtime_agent_instance_id is not null) then
    raise exception 'Rollback refused: a Growth Partner runtime is bound. Detach it through an approved migration first.';
  end if;
end $$;

drop trigger if exists users_preserve_ai_growth_partner_conversations on public.users;
drop function if exists app.preserve_ai_growth_partner_conversations_on_user_delete();
drop trigger if exists ai_growth_partner_runtime_role_guard on public.ai_growth_partners;
drop function if exists app.require_growth_partner_runtime_role();
drop trigger if exists agent_instances_preserve_growth_partner_role on public.agent_instances;
drop function if exists app.preserve_growth_partner_runtime_role();

drop policy if exists growth_partner_messages_insert on public.chat_messages;
drop policy if exists growth_partner_conversations_update on public.chat_conversations;
drop policy if exists growth_partner_conversations_insert on public.chat_conversations;
drop policy if exists growth_partner_conversations_select on public.chat_conversations;

drop index if exists public.chat_conversations_growth_partner_org_idx;
drop index if exists public.chat_conversations_one_growth_partner_thread_idx;
drop index if exists public.chat_messages_author_user_idx;
alter table public.chat_messages drop column if exists author_user_id;
alter table public.chat_conversations
  drop constraint if exists chat_conversations_growth_partner_runtime_same_org,
  drop constraint if exists chat_conversations_owner_or_growth_partner_check,
  drop column if exists growth_partner_id,
  alter column user_id set not null;
alter table public.ai_growth_partners
  drop constraint if exists ai_growth_partners_id_runtime_org_key;

comment on table public.ai_growth_partners is
  'At most one logical AI Growth Partner identity per organization. Legacy employee rows are preserved until an explicit migration binds one verified runtime.';
