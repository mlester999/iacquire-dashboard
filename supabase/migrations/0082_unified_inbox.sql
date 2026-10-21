-- Unified Inbox foundation. Purely additive: no existing column, constraint or row changes meaning.
--
-- conversations / conversation_messages (0019) stay the one source of truth for every channel. This adds what the inbox needs on top:
--
--   * Lifecycle: archived_at (Archived), resolved_at / resolved_by / outcome (Resolved and what came of it). "Waiting" is derived from
--     last_inbound_at / last_outbound_at and is not stored, so it cannot go stale.
--   * AI control: ai_paused_at / ai_paused_by / ai_pause_reason. A pause keeps the AI employee attached and stops its replies; it is
--     different from a takeover (a person becomes the owner). Both bump ownership_version.
--   * Execution fencing: conversation_messages.ownership_fence is the ownership_version an AI-authored message was prepared under;
--     evaluateSend refuses to send it if the version moved (takeover, pause, resume, another employee) before it left.
--   * Change tracking for near-real-time sync: conversations.revision (bumped on every update) and conversation_messages.status_changed_at
--     (set on insert and whenever the status changes). Both are maintained by row-local BEFORE triggers, so they take no lock on any other
--     row and cannot add a deadlock to the send path.
--   * Failed-send handling: conversation_messages.failure_kind separates "the provider refused it" (safe to retry) from "we never heard
--     back" (the customer may already have it), and retry_of links a re-send to the message it replaces.
--   * conversation_events: an append-only lifecycle trail (assignment, AI assignment, pause, status, priority, archive, handoff, links).
--     It holds ids, labels and short enums only (never message text), and is read under the same row-level security as the conversation.
--
-- Written by trusted server code only (read-only grants for the application role). Rollback: supabase/rollbacks/0082_unified_inbox.down.sql.

alter table conversations
  add column archived_at timestamptz,
  add column archived_by uuid references users(id) on delete set null,
  add column resolved_at timestamptz,
  add column resolved_by uuid references users(id) on delete set null,
  add column outcome text check (outcome in ('booked', 'qualified', 'answered', 'not_a_fit', 'no_response', 'spam', 'other')),
  add column ai_paused_at timestamptz,
  add column ai_paused_by uuid references users(id) on delete set null,
  add column ai_pause_reason text check (char_length(ai_pause_reason) <= 300),
  add column revision bigint not null default 0;

-- Open conversations of one inbox view, and "what changed since" for the sync poll.
create index conversations_view_idx on conversations (org_id, status, archived_at, last_message_at desc);
create index conversations_sync_idx on conversations (org_id, updated_at desc);

alter table conversation_messages
  add column status_changed_at timestamptz not null default now(),
  add column ownership_fence integer check (ownership_fence >= 1),
  add column failure_kind text check (failure_kind in ('rejected', 'unconfirmed')),
  add column retry_of uuid references conversation_messages(id) on delete set null;

create index conversation_messages_changed_idx on conversation_messages (org_id, status_changed_at desc);
create index conversation_messages_retry_idx on conversation_messages (retry_of) where retry_of is not null;
-- "A message could not be sent" in Needs attention: the recent failures of a workspace, without scanning its history.
create index conversation_messages_failed_idx on conversation_messages (org_id, failed_at desc) where status = 'failed';

-- Searching what customers actually wrote. Optional like the contact search index (0027): without pg_trgm the search still works, only slower.
do $$
declare s text;
begin
  select n.nspname into s from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  if s is not null then
    execute format('create index conversation_messages_body_trgm on conversation_messages using gin (body %I.gin_trgm_ops) where direction <> ''internal''', s);
  else
    raise notice 'pg_trgm unavailable; inbox message search will not use a trigram index';
  end if;
end $$;

-- A message that was failed before this migration is described by its detail text only; leave failure_kind empty rather than guess.

create or replace function app.conversation_lifecycle() returns trigger
language plpgsql
as $$
begin
  new.revision := old.revision + 1;
  -- A customer writing again brings an archived conversation back to the inbox.
  if new.last_inbound_at is distinct from old.last_inbound_at then
    new.archived_at := null;
    new.archived_by := null;
  end if;
  if new.status = 'closed' and old.status <> 'closed' then
    new.resolved_at := coalesce(new.resolved_at, now());
  elsif new.status <> 'closed' and old.status = 'closed' then
    -- Reopened (by a person or by a new customer message): it is no longer resolved, archived or concluded.
    new.resolved_at := null;
    new.resolved_by := null;
    new.outcome := null;
    new.archived_at := null;
    new.archived_by := null;
  end if;
  return new;
end
$$;
create trigger conversations_lifecycle before update on conversations for each row execute function app.conversation_lifecycle();

create or replace function app.message_status_changed() returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end
$$;
create trigger conversation_messages_status_changed before update on conversation_messages for each row execute function app.message_status_changed();

-- ---------------------------------------------------------------------------
-- Lifecycle events
-- ---------------------------------------------------------------------------

create table conversation_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null,
  -- assigned, ai_assigned, ai_paused, ai_resumed, status_changed, priority_changed, archived, unarchived, handoff_requested,
  -- task_linked, opportunity_linked, message_retried (the set grows in code; the database only guards the shape).
  kind text not null check (kind ~ '^[a-z][a-z_]{2,39}$'),
  actor_kind text not null check (actor_kind in ('user', 'ai', 'system', 'workflow', 'agency')),
  actor_user_id uuid references users(id) on delete set null,
  agent_id uuid references agent_instances(id) on delete set null,
  -- Ids, enums and short labels only. Never message text or contact details.
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete cascade
);
create index conversation_events_conversation_idx on conversation_events (conversation_id, id);
create index conversation_events_org_idx on conversation_events (org_id, id);
create trigger conversation_events_immutable before update on conversation_events for each row execute function app.immutable_row();

alter table conversation_events enable row level security;
revoke all on conversation_events from public, anon, authenticated;
grant select on conversation_events to iaq_app_user;
create policy conversation_events_select on conversation_events for select to iaq_app_user using (
  exists (select 1 from conversations c where c.id = conversation_id and c.org_id = conversation_events.org_id));

-- ---------------------------------------------------------------------------
-- Notification kinds
-- ---------------------------------------------------------------------------

-- Three kinds for conversation attention. The existing allow-list is read back from the live constraint and extended instead of being
-- rewritten from a copy, so a kind added by another migration (or by a branch merged around this one) is never dropped by this one.
do $$
declare
  def text;
  kinds text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'notifications_kind_check' and c.conrelid = 'notifications'::regclass;
  if def is null then
    raise exception 'notifications_kind_check not found; cannot extend the notification kinds';
  end if;
  kinds := array(select m[1] from regexp_matches(def, '''([a-z_]+)''::text', 'g') as m);
  kinds := array(select distinct k from unnest(kinds || array['conversation_assigned', 'conversation_new_inquiry', 'conversation_awaiting_reply']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute format('alter table notifications add constraint notifications_kind_check check (kind = any (%L::text[]))', kinds);
end $$;
