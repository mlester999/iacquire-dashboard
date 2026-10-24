-- Phase 6D: the agency's internal staff Messages (agency staff to agency staff). Nothing here is visible to a client, a client's customer, the AI employees, Automation Studio or AQi.
--
--   * staff_conversations: a direct message (one per pair of people, named by direct_key), a group or a channel (visible to the whole team, or private). Every message of
--     a conversation takes the next number from last_seq, in the sending transaction, so the order is the database's and unread is a subtraction.
--   * staff_conversation_members: who is in a conversation, with each person's own read cursor (it can only move forward), mute and notification choice.
--   * staff_messages: the text, an optional thread root (one level), the people mentioned, and a client-made id so a retried send never posts twice. A deleted message is a
--     tombstone with no text.
--   * staff_message_reactions, staff_message_attachments (staged, then attached to a message; the bytes are in the private bucket 'staff-messages' of 0090),
--     staff_conversation_events (append-only history of who joined, left, renamed, archived), staff_inbox_state (one revision number per person: the only thing a
--     stream or a poll reads) and staff_message_settings (the one optional retention period; none by default).
--   * Three agency.messages.* permissions, the notification audience 'staff', five notification kinds (three used here, two by the workload module), and a directory
--     function for the people picker. Staff messages are a feature of the agency workspace that a Super Admin switches on (org_features 'staff_messages'); absent means off.
--
-- Additive. No existing row changes. Every row belongs to the ONE agency workspace (a trigger refuses any other), every table has row-level security, and the application
-- role gets SELECT only: every write runs in trusted server code after its own check of the person's standing. A person's access follows their CURRENT standing: the
-- helpers below read the account's status, role, permission, the module switch and the person's membership on every statement, so a person who is disabled, demoted or
-- denied the permission loses every row at once. Nothing is granted to anon, authenticated or the published-site role.
--
-- Not private by cryptography: these messages are protected by row-level security and the server's checks; anyone with the system database role, a backup or the service
-- role can read them. The Super Admin has no read access to another person's direct messages or private groups through any policy or function here.
--
-- The Realtime policy for a private topic is NOT here: it needs a function the browser role can execute, which this repository's migrations refuse to create without an
-- approved live-project test. It is supabase/optional/staff-messages-realtime.sql, applied by hand only after that test.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

-- Use: every agency role (a person can be denied it, one by one). Channels: managers and the Super Admin. Moderate: the Super Admin only, and never delegable.
-- No client role has any of them.
insert into role_permissions (role, permission) values
  ('agency_staff', 'agency.messages.use'), ('agency_manager', 'agency.messages.use'), ('agency_super_admin', 'agency.messages.use'),
  ('agency_manager', 'agency.messages.channels'), ('agency_super_admin', 'agency.messages.channels'),
  ('agency_super_admin', 'agency.messages.moderate')
on conflict do nothing;

-- The per-person override lists of 0039 to 0065 gain the two delegable ones. Read back from the live constraints and extended, keeping the order of what is there, never
-- rewritten from a copy (0065 was the last to copy the list; a copy here would drop whatever a later migration added).
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
      raise exception '% not found; cannot extend the agency permission list', c;
    end if;
    perms := array(select m[1] from regexp_matches(def, '''([a-z0-9_.]+)''::text', 'g') as m);
    if cardinality(perms) < 50 then
      raise exception 'could not read the current agency permission list from % (read %); refusing to rewrite it', c, cardinality(perms);
    end if;
    perms := perms || array(select e from unnest(extra) as e where e <> all(perms));
    execute format('alter table %I drop constraint %I', t, c);
    execute format('alter table %I add constraint %I check (permission in (%s))', t, c,
      (select string_agg(quote_literal(p), ', ' order by o) from unnest(perms) with ordinality as u(p, o)));
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Who may use staff Messages right now
-- ---------------------------------------------------------------------------

-- The module is dormant until a Super Admin switches it on for the agency workspace (a row in org_features; no row means off).
create or replace function app.staff_messages_enabled() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from org_features f join organizations o on o.id = f.org_id
    where o.kind = 'agency' and f.feature = 'staff_messages' and f.enabled
  )
$$;

-- An ACTIVE agency account (disabled, demoted to 'none' or never an agency account: false) that holds the permission (a deny override: false) while the module is on.
create or replace function app.staff_messages_allowed() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(app.is_agency_staff() and app.has_agency_permission('agency.messages.use') and app.staff_messages_enabled(), false)
$$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create or replace function app.staff_org_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from organizations o where o.id = new.org_id and o.kind = 'agency') then
    raise exception 'staff_messages_agency_only' using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- One row, for the agency workspace. A retention period is the only setting, and it is empty: nothing is deleted by age unless a Super Admin chose a period.
create table staff_message_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  retention_days integer check (retention_days is null or retention_days between 30 and 3650),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger staff_message_settings_agency_only before insert or update of org_id on staff_message_settings for each row execute function app.staff_org_guard();
create trigger staff_message_settings_touch before update on staff_message_settings for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Conversations and members
-- ---------------------------------------------------------------------------

create table staff_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('direct', 'group', 'channel')),
  name text check (name is null or char_length(name) between 1 and 80),
  topic text check (topic is null or char_length(topic) <= 250),
  -- A channel is either open to the whole team to join ('staff') or by invitation ('private'). A direct message or a group is always private.
  visibility text not null default 'private' check (visibility in ('staff', 'private')),
  -- The two people of a direct message, their ids sorted and joined by a colon: one direct message per pair, whoever opens it first.
  direct_key text check (direct_key is null or (
    direct_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    -- Compared as plain bytes (collate "C"), which is how the code sorts the two ids, whatever collation the database was created with.
    and (split_part(direct_key, ':', 1) collate "C") < (split_part(direct_key, ':', 2) collate "C"))),
  created_by uuid references users(id) on delete set null,
  archived_at timestamptz,
  archived_by uuid references users(id) on delete set null,
  -- The number of the newest message. The sending transaction takes the next one with an update of this row, which makes writers to one conversation take turns.
  last_seq bigint not null default 0 check (last_seq >= 0),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  check ((kind = 'direct') = (direct_key is not null)),
  check (kind <> 'direct' or (name is null and topic is null and visibility = 'private')),
  check (kind = 'direct' or name is not null),
  check (visibility = 'private' or kind = 'channel')
);
create unique index staff_conversations_direct_key_idx on staff_conversations (direct_key) where direct_key is not null;
-- Two live channels never share a name, whatever the case.
create unique index staff_conversations_channel_name_idx on staff_conversations (lower(name)) where kind = 'channel' and archived_at is null;
create index staff_conversations_directory_idx on staff_conversations (lower(name)) where kind = 'channel' and visibility = 'staff' and archived_at is null;
create trigger staff_conversations_agency_only before insert or update of org_id on staff_conversations for each row execute function app.staff_org_guard();
create trigger staff_conversations_touch before update on staff_conversations for each row execute function app.touch_updated_at();

create table staff_conversation_members (
  conversation_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  -- Active means left_at is null. A person who left (or whose account stopped being agency staff) keeps the row so history stays truthful.
  left_at timestamptz,
  muted boolean not null default false,
  notify text not null default 'all' check (notify in ('all', 'mentions', 'none')),
  -- The newest message this person has read. It only moves forward and never past the newest message (the trigger below enforces both).
  last_read_seq bigint not null default 0 check (last_read_seq >= 0),
  last_read_at timestamptz,
  added_by uuid references users(id) on delete set null,
  primary key (conversation_id, user_id),
  foreign key (conversation_id, org_id) references staff_conversations (id, org_id) on delete cascade
);
create index staff_members_user_idx on staff_conversation_members (user_id) where left_at is null;
create index staff_members_conversation_idx on staff_conversation_members (conversation_id) where left_at is null;

-- The caller's conversations: the active memberships, and none at all unless the caller is allowed right now. Every row-level policy below reads it.
create or replace function app.staff_conversation_ids() returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when app.staff_messages_allowed()
    then coalesce((select array_agg(m.conversation_id) from staff_conversation_members m where m.user_id = app.current_user_id() and m.left_at is null), '{}'::uuid[])
    else '{}'::uuid[] end
$$;

-- The backstops for the member rules the service also checks: only an agency account that may use Messages can be added; a direct message holds exactly its two people; a
-- conversation holds at most 200 active members; the read cursor never goes back and never passes the newest message; identity columns never change.
create or replace function app.staff_member_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
declare
  conv record;
begin
  select kind, direct_key, last_seq into conv from staff_conversations where id = new.conversation_id;
  if tg_op = 'UPDATE' then
    if new.conversation_id <> old.conversation_id or new.user_id <> old.user_id or new.org_id <> old.org_id or new.joined_at <> old.joined_at then
      raise exception 'staff_member_identity_is_fixed' using errcode = 'check_violation';
    end if;
    if new.last_read_seq < old.last_read_seq then
      new.last_read_seq := old.last_read_seq;
    end if;
  end if;
  if new.last_read_seq > conv.last_seq then
    new.last_read_seq := conv.last_seq;
  end if;
  if tg_op = 'INSERT' or (old.left_at is not null and new.left_at is null) then
    if not coalesce(app.user_has_agency_permission(new.user_id, 'agency.messages.use'), false) then
      raise exception 'staff_member_not_eligible' using errcode = 'check_violation';
    end if;
    if conv.kind = 'direct' and position(new.user_id::text in conv.direct_key) = 0 then
      raise exception 'staff_direct_has_two_people' using errcode = 'check_violation';
    end if;
    if (select count(*) from staff_conversation_members m where m.conversation_id = new.conversation_id and m.left_at is null and m.user_id <> new.user_id) >= 200 then
      raise exception 'staff_conversation_is_full' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger staff_conversation_members_guard before insert or update on staff_conversation_members for each row execute function app.staff_member_guard();

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

create table staff_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null,
  seq bigint not null check (seq >= 1),
  -- One level only: a reply points at the message that started the thread, never at another reply. Cleared if the root is removed by the retention period.
  thread_root_id uuid,
  -- Kept when the person leaves; null only if the account itself is deleted (the screens say "Former team member").
  author_id uuid references users(id) on delete set null,
  -- Mention tokens (<@user-id>) stay in the text; the people they name are listed here, validated against the conversation's members.
  body text not null,
  mentions uuid[] not null default '{}' check (cardinality(mentions) <= 20),
  -- Made by the sender's browser for each message it composes: a send that is retried (a lost answer, a double click) finds the message it already made.
  client_message_id uuid not null,
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (id, conversation_id),
  unique (conversation_id, seq),
  unique (conversation_id, author_id, client_message_id),
  foreign key (conversation_id, org_id) references staff_conversations (id, org_id) on delete cascade,
  foreign key (thread_root_id, conversation_id) references staff_messages (id, conversation_id) on delete set null (thread_root_id),
  -- A deleted message keeps its place and loses its text.
  check ((deleted_at is null and char_length(body) between 1 and 8000) or (deleted_at is not null and body = ''))
);
create index staff_messages_thread_idx on staff_messages (thread_root_id, seq) where thread_root_id is not null;
create index staff_messages_created_idx on staff_messages (created_at);

-- Search over what colleagues wrote. Optional like the CRM and inbox indexes: without pg_trgm the search still works, only slower.
do $$
declare s text;
begin
  select n.nspname into s from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  if s is not null then
    execute format('create index staff_messages_body_trgm on staff_messages using gin (body %I.gin_trgm_ops) where deleted_at is null', s);
  else
    raise notice 'pg_trgm unavailable; staff message search will not use a trigram index';
  end if;
end $$;

-- The number must have been taken from the conversation's counter, and a thread root must itself be a root.
create or replace function app.staff_message_insert_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.seq > (select c.last_seq from staff_conversations c where c.id = new.conversation_id) then
    raise exception 'staff_message_number_not_taken' using errcode = 'check_violation';
  end if;
  if new.thread_root_id is not null and exists (select 1 from staff_messages r where r.id = new.thread_root_id and r.thread_root_id is not null) then
    raise exception 'staff_thread_is_one_level' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger staff_messages_insert_guard before insert on staff_messages for each row execute function app.staff_message_insert_guard();

-- What a message may become: its place, author and thread never change (the author and the thread root can only be cleared, by the foreign keys); an edit is stamped; a
-- deleted message stays deleted and empty.
create or replace function app.staff_message_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.id <> old.id or new.org_id <> old.org_id or new.conversation_id <> old.conversation_id or new.seq <> old.seq
     or new.client_message_id <> old.client_message_id or new.created_at <> old.created_at then
    raise exception 'staff_message_place_is_fixed' using errcode = 'check_violation';
  end if;
  if (new.author_id is distinct from old.author_id and new.author_id is not null) or (new.thread_root_id is distinct from old.thread_root_id and new.thread_root_id is not null) then
    raise exception 'staff_message_author_and_thread_are_fixed' using errcode = 'check_violation';
  end if;
  if old.deleted_at is not null and (new.deleted_at is null or new.body <> '') then
    raise exception 'staff_message_stays_deleted' using errcode = 'check_violation';
  end if;
  if new.deleted_at is null and new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end $$;
create trigger staff_messages_guard before update on staff_messages for each row execute function app.staff_message_guard();

-- Reactions are a short allow-list of names (the screens show the pictures), so no free text can sit in a reaction.
create table staff_message_reactions (
  message_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  reaction text not null check (reaction in ('thumbs_up', 'thumbs_down', 'heart', 'laugh', 'surprised', 'sad', 'tada', 'eyes', 'check', 'pray', 'rocket', 'cross')),
  conversation_id uuid not null,
  org_id uuid not null references organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, reaction),
  foreign key (message_id, conversation_id) references staff_messages (id, conversation_id) on delete cascade,
  foreign key (conversation_id, org_id) references staff_conversations (id, org_id) on delete cascade
);
create index staff_message_reactions_conversation_idx on staff_message_reactions (conversation_id);

create table staff_message_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null,
  -- Empty while the file is staged (uploaded in the composer, not sent yet).
  message_id uuid,
  private_file_id uuid not null,
  uploaded_by uuid references users(id) on delete set null,
  status text not null default 'staged' check (status in ('staged', 'attached', 'removed')),
  -- A staged file nobody sent is removed after this time.
  expires_at timestamptz not null,
  filename text not null check (char_length(filename) between 1 and 200),
  mime_type text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at timestamptz not null default now(),
  attached_at timestamptz,
  unique (id, org_id),
  unique (private_file_id),
  foreign key (conversation_id, org_id) references staff_conversations (id, org_id) on delete cascade,
  foreign key (message_id, conversation_id) references staff_messages (id, conversation_id) on delete cascade,
  foreign key (private_file_id, org_id) references private_files (id, org_id) on delete restrict,
  check ((status = 'staged' and message_id is null) or (status = 'attached' and message_id is not null and attached_at is not null) or status = 'removed')
);
create index staff_message_attachments_message_idx on staff_message_attachments (message_id) where message_id is not null;
create index staff_message_attachments_staged_idx on staff_message_attachments (expires_at) where status = 'staged';

-- At most five files on a message, whatever the code does.
create or replace function app.staff_attachment_cap() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.status = 'attached' and (select count(*) from staff_message_attachments a where a.message_id = new.message_id and a.status = 'attached' and a.id <> new.id) >= 5 then
    raise exception 'staff_message_has_too_many_files' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger staff_message_attachments_cap before insert or update on staff_message_attachments for each row execute function app.staff_attachment_cap();

-- ---------------------------------------------------------------------------
-- History and the inbox revision
-- ---------------------------------------------------------------------------

-- Who joined, left, renamed or archived, for the conversation's members. Ids and short words only, never a message. Append-only. The person columns are plain ids (no foreign
-- key): an account that is deleted later must not rewrite history.
create table staff_conversation_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null,
  at timestamptz not null default now(),
  kind text not null check (kind in ('created', 'member_added', 'member_removed', 'member_left', 'renamed', 'topic_changed', 'archived', 'unarchived')),
  actor_id uuid,
  subject_id uuid,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 1024),
  foreign key (conversation_id, org_id) references staff_conversations (id, org_id) on delete cascade
);
create index staff_conversation_events_idx on staff_conversation_events (conversation_id, id);
create trigger staff_conversation_events_immutable before update or delete on staff_conversation_events for each row execute function app.immutable_row();

-- One number per person, raised in the transaction of every message that concerns them. A stream or a poll compares it with the one it last saw and reads nothing else.
create table staff_inbox_state (
  user_id uuid primary key references users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
create trigger staff_inbox_state_agency_only before insert or update of org_id on staff_inbox_state for each row execute function app.staff_org_guard();

-- ---------------------------------------------------------------------------
-- The people picker
-- ---------------------------------------------------------------------------

-- Row-level security on users hides other staff from an agency person, so the picker reads through this function: the people who could be added to a conversation
-- (active agency accounts that may use Messages), and only for a caller who may use Messages. A name, a role and an id; no address, no status, no last sign-in.
create or replace function app.staff_directory() returns table (id uuid, name text, platform_role text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select u.id, coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)), u.platform_role
  from users u
  where app.staff_messages_allowed() and u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
    and coalesce(app.user_has_agency_permission(u.id, 'agency.messages.use'), false)
$$;

revoke all on function app.staff_messages_enabled(), app.staff_messages_allowed(), app.staff_conversation_ids(), app.staff_directory() from public, anon, authenticated;
grant execute on function app.staff_messages_enabled(), app.staff_messages_allowed(), app.staff_conversation_ids(), app.staff_directory() to iaq_app_user;

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in person's standing, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table staff_message_settings enable row level security;
alter table staff_conversations enable row level security;
alter table staff_conversation_members enable row level security;
alter table staff_messages enable row level security;
alter table staff_message_reactions enable row level security;
alter table staff_message_attachments enable row level security;
alter table staff_conversation_events enable row level security;
alter table staff_inbox_state enable row level security;

revoke all on staff_message_settings, staff_conversations, staff_conversation_members, staff_messages, staff_message_reactions, staff_message_attachments,
  staff_conversation_events, staff_inbox_state from public, anon, authenticated;
grant select on staff_message_settings, staff_conversations, staff_conversation_members, staff_messages, staff_message_reactions, staff_message_attachments,
  staff_conversation_events, staff_inbox_state to iaq_app_user;

-- A conversation is visible to its active members, and a team-wide channel to anyone who may use Messages (its name and topic, so the directory can list it; its
-- messages stay with its members).
create policy staff_conversations_select on staff_conversations for select to iaq_app_user
  using (id = any ((select app.staff_conversation_ids())::uuid[])
    or (kind = 'channel' and visibility = 'staff' and archived_at is null and (select app.staff_messages_allowed())));
create policy staff_conversation_members_select on staff_conversation_members for select to iaq_app_user
  using (conversation_id = any ((select app.staff_conversation_ids())::uuid[]));
create policy staff_messages_select on staff_messages for select to iaq_app_user
  using (conversation_id = any ((select app.staff_conversation_ids())::uuid[]));
create policy staff_message_reactions_select on staff_message_reactions for select to iaq_app_user
  using (conversation_id = any ((select app.staff_conversation_ids())::uuid[]));
-- A file still staged is visible to the person who is composing the message and to nobody else.
create policy staff_message_attachments_select on staff_message_attachments for select to iaq_app_user
  using (conversation_id = any ((select app.staff_conversation_ids())::uuid[]) and (message_id is not null or uploaded_by = (select app.current_user_id())));
create policy staff_conversation_events_select on staff_conversation_events for select to iaq_app_user
  using (conversation_id = any ((select app.staff_conversation_ids())::uuid[]));
create policy staff_inbox_state_select on staff_inbox_state for select to iaq_app_user
  using (user_id = (select app.current_user_id()) and (select app.staff_messages_allowed()));
create policy staff_message_settings_select on staff_message_settings for select to iaq_app_user
  using ((select app.staff_messages_allowed()));

-- ---------------------------------------------------------------------------
-- Notifications: the audience 'staff' and the kinds
-- ---------------------------------------------------------------------------

-- The audience list gains 'staff', read back from the live constraint. A staff notification is visible to an active agency account and to nobody else; the existing
-- 'direct' audience stays what it was (it would show an agency account's mail to the same person later invited into a client workspace).
do $$
declare
  def text;
  vals text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'notifications_audience_check' and c.conrelid = 'notifications'::regclass;
  if def is null then
    raise exception 'notifications_audience_check not found; cannot add the staff audience';
  end if;
  vals := array(select m[1] from regexp_matches(def, '''([a-z]+)''::text', 'g') as m);
  if cardinality(vals) < 3 then
    raise exception 'could not read the current notification audiences from notifications_audience_check (read %); refusing to rewrite it', cardinality(vals);
  end if;
  if not ('staff' = any(vals)) then
    vals := vals || array['staff'];
  end if;
  alter table notifications drop constraint notifications_audience_check;
  execute 'alter table notifications add constraint notifications_audience_check check (audience in (' || (select string_agg(quote_literal(v), ', ' order by o) from unnest(vals) with ordinality as u(v, o)) || '))';
end $$;

-- 0067's function with one more branch. A staff notification is visible to an active agency account; its title carries no message text and no person's name.
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
    when p_audience = 'staff' then
      exists (select 1 from users u where u.id = p_user and u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin'))
    else false
  end
$$;

-- Read back from the live constraint and extended, never rewritten from a copy (see 0083, 0087 and 0089).
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'notifications_kind_check' and c.conrelid = 'notifications'::regclass;
  if def is null then
    raise exception 'notifications_kind_check not found; cannot extend the notification kinds';
  end if;
  kinds := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
  if cardinality(kinds) = 0 then
    literal := substring(def from '''\{([^}]*)\}''::text\[\]');
    if literal is not null then
      kinds := string_to_array(literal, ',');
    end if;
  end if;
  if kinds is null or cardinality(kinds) < 20 then
    raise exception 'could not read the current notification kinds from notifications_kind_check (read %); refusing to rewrite it', coalesce(cardinality(kinds), 0);
  end if;
  kinds := array(select distinct k from unnest(kinds || array['staff_message_direct', 'staff_message_mention', 'staff_message_added', 'staff_workload_alert', 'staff_work_overdue']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
