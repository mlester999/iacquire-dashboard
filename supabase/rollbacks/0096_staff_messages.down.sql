-- Rollback for 0096_staff_messages.sql. NOT a migration: stop the scheduler's staffMessagesMaintenance job first, review, and run in one transaction.
-- Refuses when staff Messages has been used (a conversation, a message or an attachment exists, or a file is stored in the staff-messages bucket), so a colleague's
-- conversation is never dropped by accident, and when a staff notification exists. The settings row is configuration and goes with its table; so does the workspace switch.

do $$
begin
  if exists (select 1 from staff_conversations)
     or exists (select 1 from staff_messages)
     or exists (select 1 from staff_message_attachments)
     or exists (select 1 from private_files where bucket = 'staff-messages') then
    raise exception 'Rollback refused: staff conversations, messages, attachments or stored staff files exist. Export them deliberately first.';
  end if;
  if exists (select 1 from notifications where audience = 'staff' or kind in ('staff_message_direct', 'staff_message_mention', 'staff_message_added', 'staff_workload_alert', 'staff_work_overdue')) then
    raise exception 'Rollback refused: staff notifications exist. Delete or archive them first.';
  end if;
end $$;

drop policy if exists staff_message_settings_select on staff_message_settings;
drop policy if exists staff_inbox_state_select on staff_inbox_state;
drop policy if exists staff_conversation_events_select on staff_conversation_events;
drop policy if exists staff_message_attachments_select on staff_message_attachments;
drop policy if exists staff_message_reactions_select on staff_message_reactions;
drop policy if exists staff_messages_select on staff_messages;
drop policy if exists staff_conversation_members_select on staff_conversation_members;
drop policy if exists staff_conversations_select on staff_conversations;

drop table staff_conversation_events;
drop table staff_message_attachments;
drop table staff_message_reactions;
drop table staff_messages;
drop table staff_conversation_members;
drop table staff_inbox_state;
drop table staff_conversations;
drop table staff_message_settings;

drop function app.staff_directory();
drop function app.staff_conversation_ids();
drop function app.staff_messages_allowed();
drop function app.staff_messages_enabled();
drop function app.staff_attachment_cap();
drop function app.staff_message_guard();
drop function app.staff_message_insert_guard();
drop function app.staff_member_guard();
drop function app.staff_org_guard();

delete from role_permissions where permission in ('agency.messages.use', 'agency.messages.channels', 'agency.messages.moderate');
-- The workspace switch is not history: with the tables gone it would switch the module back on the moment 0096 is applied again.
delete from org_features where feature = 'staff_messages';

-- The two per-person override lists lose the two delegable permissions, keeping the order of everything else.
do $$
declare
  t text;
  c text;
  def text;
  perms text[];
  extra text[] := array['agency.messages.use', 'agency.messages.channels'];
begin
  foreach t in array array['agency_user_permission_overrides', 'invitation_agency_permission_overrides'] loop
    c := t || '_permission_check';
    select pg_get_constraintdef(k.oid) into def from pg_constraint k where k.conname = c and k.conrelid = t::regclass;
    if def is null then
      raise exception '% not found', c;
    end if;
    perms := array(select m[1] from regexp_matches(def, '''([a-z0-9_.]+)''::text', 'g') as m);
    if cardinality(perms) < 50 then
      raise exception 'could not read the current agency permission list from % (read %); refusing to rewrite it', c, cardinality(perms);
    end if;
    -- Overrides that name a permission being removed go with it (the constraint would refuse them).
    execute format('delete from %I where permission = any($1)', t) using extra;
    perms := array(select p from unnest(perms) with ordinality as u(p, o) where p <> all(extra) order by o);
    execute format('alter table %I drop constraint %I', t, c);
    execute format('alter table %I add constraint %I check (permission in (%s))', t, c,
      (select string_agg(quote_literal(p), ', ' order by o) from unnest(perms) with ordinality as u(p, o)));
  end loop;
end $$;

-- The audience list without 'staff' (no staff notification exists: the guard above refused otherwise).
do $$
declare
  def text;
  vals text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'notifications_audience_check' and c.conrelid = 'notifications'::regclass;
  if def is null then
    raise exception 'notifications_audience_check not found';
  end if;
  vals := array(select m[1] from regexp_matches(def, '''([a-z]+)''::text', 'g') as m);
  if cardinality(vals) < 3 then
    raise exception 'could not read the current notification audiences (read %); refusing to rewrite them', cardinality(vals);
  end if;
  vals := array(select v from unnest(vals) with ordinality as u(v, o) where v <> 'staff' order by o);
  alter table notifications drop constraint notifications_audience_check;
  execute 'alter table notifications add constraint notifications_audience_check check (audience in (' || (select string_agg(quote_literal(v), ', ' order by o) from unnest(vals) with ordinality as u(v, o)) || '))';
end $$;

-- 0067's definition, without the staff branch.
create or replace function app.notification_visible(p_user uuid, p_audience text, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_audience = 'direct' then true
    when p_audience = 'client' then p_org is null or app.user_can_access_org(p_user, p_org)
    when p_audience = 'agency' then
      case
        when p_org is null then coalesce(app.user_has_agency_permission(p_user, 'agency.security.manage'), false)
        else app.user_can_access_org(p_user, p_org)
      end
    else false
  end
$$;

-- The notification kinds added by 0096 are removed from the live allow-list (every other kind is left exactly as it is).
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
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
  kinds := array(select distinct k from unnest(kinds) as k where k not in ('staff_message_direct', 'staff_message_mention', 'staff_message_added', 'staff_workload_alert', 'staff_work_overdue') order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0096_staff_messages';
