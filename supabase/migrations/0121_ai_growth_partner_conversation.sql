-- 0121: reserve one tenant-shared permanent conversation for the unified Growth Partner.
-- No conversation is created or bound by this migration. A later runtime migration must create
-- the conversation only after one verified Growth Partner Hermes profile is attached.

alter table ai_growth_partners
  add constraint ai_growth_partners_id_runtime_org_key
  unique (id, runtime_agent_instance_id, org_id);

alter table chat_conversations
  add column growth_partner_id uuid;

alter table chat_messages
  add column author_user_id uuid references users(id) on delete set null;
create index chat_messages_author_user_idx on chat_messages (org_id, author_user_id, created_at)
  where author_user_id is not null;

alter table chat_conversations
  alter column user_id drop not null;

alter table chat_conversations
  add constraint chat_conversations_owner_or_growth_partner_check
  check (user_id is not null or growth_partner_id is not null);

alter table chat_conversations
  add constraint chat_conversations_growth_partner_runtime_same_org
  foreign key (growth_partner_id, agent_instance_id, org_id)
  references ai_growth_partners (id, runtime_agent_instance_id, org_id)
  on delete cascade;

create unique index chat_conversations_one_growth_partner_thread_idx
  on chat_conversations (growth_partner_id)
  where growth_partner_id is not null;
create index chat_conversations_growth_partner_org_idx
  on chat_conversations (org_id, growth_partner_id)
  where growth_partner_id is not null;

-- The consolidated identity may never be bound to one of the six legacy specialists. A future
-- migration must add the dedicated role and verifier before any runtime or thread can be attached.
create function app.require_growth_partner_runtime_role() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  if new.runtime_agent_instance_id is null then
    return new;
  end if;
  select role_key into v_role from public.agent_instances
   where id = new.runtime_agent_instance_id and org_id = new.org_id;
  if v_role is distinct from 'growth_partner' then
    raise exception 'growth_partner_requires_dedicated_runtime' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function app.require_growth_partner_runtime_role() from public;
create trigger ai_growth_partner_runtime_role_guard
  before insert or update of runtime_agent_instance_id, org_id on ai_growth_partners
  for each row execute function app.require_growth_partner_runtime_role();

create function app.preserve_growth_partner_runtime_role() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.role_key <> 'growth_partner' and exists (
    select 1 from public.ai_growth_partners p where p.runtime_agent_instance_id = old.id
  ) then
    raise exception 'growth_partner_runtime_role_is_immutable' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function app.preserve_growth_partner_runtime_role() from public;
create trigger agent_instances_preserve_growth_partner_role
  before update of role_key on agent_instances
  for each row execute function app.preserve_growth_partner_runtime_role();

comment on column chat_conversations.growth_partner_id is
  'Optional canonical, tenant-shared AI Growth Partner thread. It can only reference the partner’s bound runtime profile and only one such row is allowed per partner.';

-- Keep the private-chat policies from 0060 byte-for-byte intact. A separate permissive policy adds
-- access only for the shared thread, and uses the statement-level tenant helper required by the
-- repository's RLS performance guard.
create policy growth_partner_conversations_select on chat_conversations for select to iaq_app_user
  using (
    growth_partner_id is not null
    and org_id = any ((select app.permitted_orgs('agents.use'::text))::uuid[])
  );
create policy growth_partner_conversations_insert on chat_conversations for insert to iaq_app_user
  with check (
    growth_partner_id is not null
    and user_id is null
    and org_id = any ((select app.permitted_orgs('agents.use'::text))::uuid[])
  );
create policy growth_partner_conversations_update on chat_conversations for update to iaq_app_user
  using (
    growth_partner_id is not null
    and org_id = any ((select app.permitted_orgs('agents.use'::text))::uuid[])
  )
  with check (
    growth_partner_id is not null
    and user_id is null
    and deleted_at is null
    and org_id = any ((select app.permitted_orgs('agents.use'::text))::uuid[])
  );

-- The legacy message-insert policy remains unchanged. This extra policy permits a member to write
-- as themselves only into the canonical shared thread in a workspace they can access.
create policy growth_partner_messages_insert on chat_messages for insert to iaq_app_user
  with check (
    role = 'user'
    and author_user_id = (select app.current_user_id())
    and org_id = any ((select app.permitted_orgs('agents.use'::text))::uuid[])
    and exists (select 1 from chat_conversations c
                where c.id = conversation_id and c.org_id = chat_messages.org_id
                  and c.growth_partner_id is not null and c.deleted_at is null)
  );

-- The legacy role chat owns ordinary conversations. Keep its list, open, edit, delete and send paths
-- from accidentally treating a future shared partner thread as one of those private chats.
comment on table ai_growth_partners is
  'At most one logical AI Growth Partner identity per organization. Legacy employee rows are preserved until an explicit migration binds one verified runtime and its canonical conversation.';

-- Preserve the canonical thread if the user who first creates it is later removed. Ordinary private
-- chats retain the previous ON DELETE CASCADE behavior.
create function app.preserve_ai_growth_partner_conversations_on_user_delete() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update chat_conversations
     set user_id = null
   where user_id = old.id and growth_partner_id is not null;
  return old;
end $$;
revoke all on function app.preserve_ai_growth_partner_conversations_on_user_delete() from public;
create trigger users_preserve_ai_growth_partner_conversations
  before delete on users
  for each row execute function app.preserve_ai_growth_partner_conversations_on_user_delete();
