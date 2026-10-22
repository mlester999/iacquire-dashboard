-- Rollback for 0082_unified_inbox.sql. NOT a migration: stop the application first, review, and run in one transaction.
-- Drops only what 0082 added. conversations and conversation_messages keep every row and every pre-existing column.
-- Refused when conversation_events holds history, because that trail is not recoverable from anywhere else.

do $$
begin
  if exists (select 1 from conversation_events) then
    raise exception 'Rollback refused: conversation_events holds lifecycle history. Export it deliberately, then delete the rows, before rolling back.';
  end if;
end $$;

-- The rollout configuration is current state only (the history of changes is in audit_logs), so it is dropped without ceremony.
drop trigger if exists inbox_rollout_touch on inbox_rollout;
drop table if exists inbox_rollout;

drop policy if exists conversation_events_select on conversation_events;
drop trigger if exists conversation_events_immutable on conversation_events;
drop table conversation_events;

drop trigger if exists conversation_messages_status_changed on conversation_messages;
drop function if exists app.message_status_changed();
drop trigger if exists conversations_lifecycle on conversations;
drop function if exists app.conversation_lifecycle();

drop index if exists conversation_messages_body_trgm;
drop index if exists conversation_messages_failed_idx;
drop index if exists conversation_messages_retry_idx;
drop index if exists conversation_messages_changed_idx;
alter table conversation_messages
  drop column if exists retry_of,
  drop column if exists failure_kind,
  drop column if exists ownership_fence,
  drop column if exists status_changed_at;

drop index if exists conversations_sync_idx;
drop index if exists conversations_view_idx;
alter table conversations
  drop column if exists revision,
  drop column if exists ai_pause_reason,
  drop column if exists ai_paused_by,
  drop column if exists ai_paused_at,
  drop column if exists outcome,
  drop column if exists resolved_by,
  drop column if exists resolved_at,
  drop column if exists archived_by,
  drop column if exists archived_at;

-- Notification kinds: removed from the allow-list again (read back from the live constraint, so other kinds are untouched).
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
  if exists (select 1 from notifications where kind in ('conversation_assigned', 'conversation_new_inquiry', 'conversation_awaiting_reply')) then
    raise exception 'Rollback refused: notifications of the conversation kinds exist. Delete them deliberately first.';
  end if;
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'notifications_kind_check' and c.conrelid = 'notifications'::regclass;
  if def is null then
    raise exception 'Rollback refused: notifications_kind_check not found.';
  end if;
  -- Both forms the constraint can read back as (see the migration), and never an empty allow-list.
  kinds := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
  if cardinality(kinds) = 0 then
    literal := substring(def from '''\{([^}]*)\}''::text\[\]');
    if literal is not null then
      kinds := string_to_array(literal, ',');
    end if;
  end if;
  if kinds is null or cardinality(kinds) < 20 then
    raise exception 'Rollback refused: could not read the current notification kinds (read %).', coalesce(cardinality(kinds), 0);
  end if;
  kinds := array(select k from unnest(kinds) as k where k not in ('conversation_assigned', 'conversation_new_inquiry', 'conversation_awaiting_reply') order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
