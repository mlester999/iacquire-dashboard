-- Phase 7 (milestone M4): the personalized demo funnel for prospects.
--
--   * demo_settings: one row of switches and limits, written only by a Super Admin. The demo is OFF until that row says otherwise (and the environment switch DEMO_ENABLED agrees).
--   * demo_prospects: one row per person who asked for the demo, keyed by a normalized email address, so registering again never gives a second window or a fresh message count.
--   * demo_verifications: single-use, hash-only links by email (to confirm an address, and to come back). demo_sessions: the prospect's own cookie, hash-only, separate from the
--     portal's sign-in.
--   * demo_messages: the AI chat transcript, with the idempotency key of each message and the state of its reservation. demo_events: the append-only timeline of a prospect.
--     demo_usage_days: the platform's daily counters, for the daily caps.
--   * Two agency permissions (agency.prospects.view, agency.prospects.manage) and four agency notification kinds (a prospect confirmed their address, asked for a consultation,
--     pressed Buy now, or the platform's daily demo budget was reached).
--
-- A prospect is never a user. Nothing here creates or references a user, an organization, a membership, an invitation or a sign-in for a prospect: the only links out are the agency
-- person a prospect is assigned to and the actor of a timeline entry (both agency users), the access request a prospect also filed, and the client workspace a Super Admin
-- converted a prospect into on purpose (converted_org_id).
--
-- Additive. Every table has row-level security and NO grant for the application role, the Data API roles or the published-site role: the portal reads and writes them only in trusted
-- server code, after its own authorization check (agency people through guarded server functions, prospects through their own session). Nothing here contacts a provider.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

-- View: agency managers and Super Admins (the people who follow leads up). Manage (settings, extend, block, assign, note, erase, convert): Super Admins only.
-- Neither is delegable per person: the override tables keep the permission lists they have.
insert into role_permissions (role, permission) values
  ('agency_manager', 'agency.prospects.view'), ('agency_super_admin', 'agency.prospects.view'),
  ('agency_super_admin', 'agency.prospects.manage')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- No row exists until a Super Admin saves one: the application reads the defaults below from code (src/lib/demo/settings.ts keeps the two in step) until then, so the migration
-- itself adds no data. All numbers are PROPOSALS pending the founder's confirmation.
create table demo_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  -- The AI chat. Off: the scripted tour is what a prospect gets, and the room says the chat is not available.
  ai_enabled boolean not null default false,
  window_hours integer not null default 24 check (window_hours between 1 and 168),
  message_limit integer not null default 10 check (message_limit between 1 and 100),
  max_extension_hours integer not null default 72 check (max_extension_hours between 0 and 720),
  max_extra_messages integer not null default 20 check (max_extra_messages between 0 and 200),
  -- The platform's daily ceilings (UTC day): demos started, and AI messages answered. 0 stops it.
  daily_start_cap integer not null default 50 check (daily_start_cap between 0 and 10000),
  daily_message_cap integer not null default 300 check (daily_message_cap between 0 and 100000),
  consultation_url text check (consultation_url is null or (consultation_url ~* '^https://[^[:space:]]+$' and char_length(consultation_url) <= 500)),
  -- Days after a window ended (or the last visit) that a transcript and the prospect's details are kept. Someone who never confirmed their address is cleared after 7 days.
  retention_days integer not null default 90 check (retention_days between 7 and 730),
  blocked_email_domains text[] not null default '{}' check (cardinality(blocked_email_domains) <= 500),
  version integer not null default 1,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger demo_settings_touch before update on demo_settings for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Prospects
-- ---------------------------------------------------------------------------

create table demo_prospects (
  id uuid primary key default gen_random_uuid(),
  -- The same person's earlier request through /get-started, so the agency sees one pipeline. Matched by address only; never changes the request.
  access_request_id uuid references access_requests(id) on delete set null,
  name text check (name is null or char_length(name) between 1 and 120),
  work_email text check (work_email is null or char_length(work_email) between 3 and 254),
  -- The key of "one demo per address": lower case, without a plus tag, and for Gmail without dots. Null once the prospect's details were erased.
  email_normalized text unique check (email_normalized is null or char_length(email_normalized) between 3 and 254),
  business_name text check (business_name is null or char_length(business_name) between 1 and 160),
  industry text check (industry is null or industry ~ '^[a-z][a-z_]{1,40}$'),
  status text not null default 'unverified' check (status in ('unverified', 'active', 'expired', 'consultation_requested', 'purchase_started', 'converted', 'declined', 'blocked')),
  verified_at timestamptz,
  -- The window opens when the address is confirmed. A moment equal to this one is already outside it.
  window_ends_at timestamptz,
  extended_hours integer not null default 0 check (extended_hours between 0 and 720),
  extended_count integer not null default 0 check (extended_count >= 0),
  -- Copied from the settings when the address is confirmed, so changing the settings later never moves a prospect who already started.
  message_limit integer not null default 10 check (message_limit between 1 and 100),
  extra_messages integer not null default 0 check (extra_messages between 0 and 200),
  messages_used integer not null default 0 check (messages_used >= 0),
  -- Orders the transcript. Never goes down, even when a message that failed is given back.
  message_seq integer not null default 0 check (message_seq >= 0),
  last_seen_at timestamptz,
  -- A keyed hash of the address the request came from: abuse analysis only. Erased with the rest.
  ip_hash text check (ip_hash is null or char_length(ip_hash) <= 64),
  utm jsonb not null default '{}'::jsonb check (jsonb_typeof(utm) = 'object' and pg_column_size(utm) <= 1024),
  -- The notice the prospect ticked. Its wording is counsel's to approve; the version says which text it was.
  consent_at timestamptz,
  consent_version text check (consent_version is null or char_length(consent_version) <= 40),
  marketing_opt_in boolean not null default false,
  consultation_requested_at timestamptz,
  consultation_done_at timestamptz,
  purchase_started_at timestamptz,
  -- Set only by the explicit conversion a Super Admin runs (or, later, by a verified payment). Nothing else ever makes a workspace from a prospect.
  converted_org_id uuid references organizations(id) on delete set null,
  converted_at timestamptz,
  -- A conversion in progress: set before the workspace is made so two Super Admins cannot make two, cleared when it succeeds or fails.
  conversion_claimed_at timestamptz,
  conversion_claimed_by uuid references users(id) on delete set null,
  owner_user_id uuid references users(id) on delete set null,
  erased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The cap, as the last line of defence: whatever the code does, a prospect cannot be answered more often than the window allows.
  check (messages_used <= message_limit + extra_messages),
  check (verified_at is null or window_ends_at is not null),
  check (status not in ('active', 'expired', 'consultation_requested', 'purchase_started', 'converted') or verified_at is not null),
  check (converted_org_id is null or status = 'converted'),
  check (status <> 'converted' or converted_at is not null),
  check (erased_at is not null or (name is not null and work_email is not null and email_normalized is not null)),
  check (erased_at is null or (name is null and work_email is null and email_normalized is null and business_name is null and ip_hash is null and utm = '{}'::jsonb))
);
create index demo_prospects_status_idx on demo_prospects (status, created_at desc);
-- The expiry job looks for open windows that have ended.
create index demo_prospects_window_idx on demo_prospects (window_ends_at) where status = 'active';
create index demo_prospects_owner_idx on demo_prospects (owner_user_id) where owner_user_id is not null;
create index demo_prospects_retention_idx on demo_prospects (created_at) where erased_at is null;
create trigger demo_prospects_touch before update on demo_prospects for each row execute function app.touch_updated_at();

-- A link sent by email. Only the hash of the token is stored; opening the link's page changes nothing, pressing its button consumes it once.
create table demo_verifications (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references demo_prospects(id) on delete cascade,
  purpose text not null check (purpose in ('verify', 'return')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index demo_verifications_prospect_idx on demo_verifications (prospect_id, created_at desc);

-- The prospect's own session: a cookie of its own, never the portal's.
create table demo_sessions (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references demo_prospects(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  user_agent_hash text check (user_agent_hash is null or char_length(user_agent_hash) <= 64),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index demo_sessions_prospect_idx on demo_sessions (prospect_id);

-- ---------------------------------------------------------------------------
-- The transcript
-- ---------------------------------------------------------------------------

create table demo_messages (
  id bigint generated always as identity primary key,
  prospect_id uuid not null references demo_prospects(id) on delete cascade,
  seq integer not null check (seq >= 1),
  role text not null check (role in ('user', 'assistant', 'system')),
  -- Which of the six AI Employees the prospect asked. Only a persona: no employee, tool, memory or workspace is involved.
  employee_role text check (employee_role is null or employee_role in ('operations_manager', 'lead_hunter', 'appointment_setter', 'sales_assistant', 'crm_manager', 'performance_analyst')),
  body text not null check (char_length(body) <= 4000),
  -- A prospect's message carries the key their browser made for it: sending it again finds the same row and counts nothing twice.
  client_message_id text check (client_message_id is null or client_message_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  -- A prospect's message: pending (counted, waiting for the answer), answered, or failed (not counted: the answer never came).
  state text check (state is null or state in ('pending', 'answered', 'failed')),
  reply_to_id bigint references demo_messages(id) on delete cascade,
  input_chars integer check (input_chars is null or input_chars >= 0),
  output_chars integer check (output_chars is null or output_chars >= 0),
  created_at timestamptz not null default now(),
  unique (prospect_id, seq),
  unique (prospect_id, client_message_id),
  check ((role = 'user') = (client_message_id is not null)),
  check ((role = 'user') = (state is not null)),
  check (role = 'assistant' or reply_to_id is null)
);
create index demo_messages_pending_idx on demo_messages (created_at) where state = 'pending';

-- The timeline. Rows are never edited; erasing a prospect redacts the free text of its rows (notes, reasons) and nothing else.
create table demo_events (
  id bigint generated always as identity primary key,
  prospect_id uuid not null references demo_prospects(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (kind in (
    'registered', 'verified', 'accessed', 'return_link', 'message_blocked', 'message_released', 'limit_reached', 'extended', 'expired', 'cta_consultation', 'cta_buy',
    'consultation_done', 'note', 'assigned', 'blocked', 'declined', 'reopened', 'transcript_viewed', 'converted', 'erased')),
  actor_kind text not null default 'system' check (actor_kind in ('prospect', 'user', 'system')),
  -- An agency person. A prospect is never a user, so this is empty for everything a prospect does.
  actor_id uuid references users(id) on delete set null,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048)
);
create index demo_events_prospect_idx on demo_events (prospect_id, id);

create or replace function app.demo_event_guard() returns trigger
language plpgsql as $$
begin
  -- Gone with the prospect (the parent row is already deleted when the cascade reaches here), or with an erasure.
  if tg_op = 'DELETE' and (current_setting('iaq.demo_erase', true) = 'on' or not exists (select 1 from demo_prospects where id = old.prospect_id)) then
    return old;
  end if;
  if tg_op = 'UPDATE' and new.prospect_id = old.prospect_id and new.kind = old.kind and new.at = old.at and new.actor_kind = old.actor_kind then
    -- An agency user was removed: the entry stays, without the person.
    if new.actor_id is null and old.actor_id is not null and new.detail = old.detail then
      return new;
    end if;
    -- An erasure may redact what a row says, never when it happened, what it was or who did it.
    if current_setting('iaq.demo_erase', true) = 'on' and new.actor_id is not distinct from old.actor_id then
      return new;
    end if;
  end if;
  raise exception 'demo_events rows are append-only' using errcode = '42501';
end $$;
create trigger demo_events_guard before update or delete on demo_events for each row execute function app.demo_event_guard();

-- The platform's daily counters (UTC day): demos started, AI messages taken from the daily cap, and messages refused.
create table demo_usage_days (
  day date primary key,
  starts integer not null default 0 check (starts >= 0),
  messages integer not null default 0 check (messages >= 0),
  blocked integer not null default 0 check (blocked >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security: no policy and no grant. Server code reads and writes these after its own check.
-- ---------------------------------------------------------------------------

alter table demo_settings enable row level security;
alter table demo_prospects enable row level security;
alter table demo_verifications enable row level security;
alter table demo_sessions enable row level security;
alter table demo_messages enable row level security;
alter table demo_events enable row level security;
alter table demo_usage_days enable row level security;

revoke all on demo_settings, demo_prospects, demo_verifications, demo_sessions, demo_messages, demo_events, demo_usage_days from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Notification kinds
-- ---------------------------------------------------------------------------

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
  kinds := array(select distinct k from unnest(kinds || array['demo_prospect_verified', 'demo_consultation_requested', 'demo_purchase_started', 'demo_budget_reached']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
