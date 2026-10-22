-- Rollback for 0087_website_chat.sql. NOT a migration: stop the scheduler's "webChatRetention" job first, review, and run in one transaction.
-- Refuses when website chat has been used or switched on, so a visitor's conversation, a lead captured through it or a configured widget is never
-- dropped by accident.

do $$
begin
  if exists (select 1 from web_chat_sessions)
     or exists (select 1 from conversations where channel = 'web_chat')
     or exists (select 1 from contacts where created_via = 'website_chat')
     or exists (select 1 from web_chat_widgets where enabled or cardinality(allowed_origins) > 0 or last_seen_at is not null) then
    raise exception 'Rollback refused: website chat sessions, web_chat conversations, contacts created through the chat, or a switched-on widget exist. Export them deliberately first.';
  end if;
end $$;

drop function if exists app.site_chat_widget(text);

drop policy if exists web_chat_sessions_select on web_chat_sessions;
drop policy if exists web_chat_widgets_select on web_chat_widgets;

drop table web_chat_sessions;
drop table web_chat_widgets;

alter table conversations drop constraint conversations_channel_check;
alter table conversations add constraint conversations_channel_check check (channel in ('sms', 'whatsapp', 'email'));

alter table contacts drop constraint contacts_created_via_check;
alter table contacts add constraint contacts_created_via_check check (created_via in (
  'inbound_message', 'manual', 'import', 'website_form', 'form', 'booking', 'api', 'agent', 'workflow', 'ghl_migration', 'call'));

-- The notification kind added by 0087 is removed from the live allow-list (every other kind is left exactly as it is). Refuses while a notification of
-- that kind exists, because the constraint would then reject the existing rows.
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
  if exists (select 1 from notifications where kind = 'web_chat_lead') then
    raise exception 'Rollback refused: notifications of kind web_chat_lead exist. Delete or archive them first.';
  end if;
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'notifications_kind_check' and c.conrelid = 'notifications'::regclass;
  if def is null then
    raise exception 'notifications_kind_check not found';
  end if;
  kinds := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
  if cardinality(kinds) = 0 then
    literal := substring(def from '''\{([^}]*)\}''::text\[\]');
    if literal is not null then
      kinds := string_to_array(literal, ',');
    end if;
  end if;
  if kinds is null or cardinality(kinds) < 20 then
    raise exception 'could not read the current notification kinds (read %); refusing to rewrite them', coalesce(cardinality(kinds), 0);
  end if;
  kinds := array(select distinct k from unnest(kinds) as k where k <> 'web_chat_lead' order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0087_website_chat';
