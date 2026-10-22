-- Phase 3A: the embeddable AI website chat.
--
--   * web_chat_widgets: one configuration per workspace (public key, allowed sites, branding, what the assistant may say, limits).
--   * web_chat_sessions: one row per visitor chat session. The visitor holds an opaque token (only its hash is stored); everything a visitor types
--     about themselves (name, email, phone) is stored here as UNVERIFIED and is never matched into an existing contact.
--   * conversations.channel accepts 'web_chat', so a website chat is a conversation of the Unified Inbox (takeover, pause, ownership fence,
--     escalation, CRM context and lead-scoring events all apply). Nothing about the provider-send configuration (messaging_channels, consent
--     events, suppressions, templates) changes: a reply to a visitor is a stored message the open widget collects, never a provider send.
--   * contacts.created_via accepts 'website_chat'.
--   * One notification kind, web_chat_lead.
--
-- Additive and nullable-first. No existing row changes. Every new table is workspace-keyed with composite foreign keys, has row-level security, and
-- gives the application role SELECT only: every write runs in trusted server code after its own authorization check (the public widget endpoints
-- resolve the workspace from the widget key or the site host, never from the request body).

-- ---------------------------------------------------------------------------
-- Widget configuration
-- ---------------------------------------------------------------------------

create table web_chat_widgets (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- Names the widget on a page. Not a secret: it grants only the visitor chat surface of this one workspace, and only from an allowed site.
  public_key text not null unique check (public_key ~ '^wk_[A-Za-z0-9]{24}$'),
  enabled boolean not null default false,

  -- Where the widget may run. Exact host names ("www.example.com") or one-level wildcards ("*.example.com"), lower case, no scheme or path.
  allowed_origins text[] not null default '{}' check (cardinality(allowed_origins) <= 20),
  -- Install automatically on this workspace's own Website Studio sites (served from their own host, same-origin).
  auto_install_sites boolean not null default true,

  title text not null default 'Chat with us' check (char_length(title) between 1 and 60),
  welcome_message text not null default 'Hi! How can we help today?' check (char_length(welcome_message) between 1 and 300),
  offline_message text not null default 'We are away right now. Leave your details and a team member will get back to you.' check (char_length(offline_message) between 1 and 300),
  brand_color text not null default '#2563eb' check (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  position text not null default 'bottom-right' check (position in ('bottom-right', 'bottom-left')),
  launcher_label text not null default 'Chat' check (char_length(launcher_label) between 1 and 24),

  -- The visitor's details: never asked, offered after the first answer, or required before chatting.
  lead_form text not null default 'offer' check (lead_form in ('never', 'offer', 'required')),
  privacy_notice text not null default 'This chat is answered by an AI assistant and may be reviewed by the team. Do not share payment details or passwords.'
    check (char_length(privacy_notice) between 1 and 600),
  privacy_url text check (privacy_url is null or (privacy_url ~ '^https://' and char_length(privacy_url) <= 300)),
  offer_marketing_opt_in boolean not null default false,

  -- What the assistant does: answers with the AI employee on the conversation, or only takes a message outside business hours.
  ai_enabled boolean not null default true,
  ai_role_key text not null default 'sales_assistant' check (ai_role_key in ('sales_assistant', 'appointment_setter')),
  offline_behavior text not null default 'ai_answers' check (offline_behavior in ('ai_answers', 'leave_message')),
  -- The company-knowledge sections the visitor-facing assistant may use. Pricing is not in the default list: a workspace opts in.
  knowledge_sections text[] not null default '{business_description,products_services,faq,business_hours,policies,brand_voice}',
  allow_booking boolean not null default true,
  -- Up to three optional questions shown with the lead form: [{ "key": "service", "label": "...", "kind": "text" | "choice", "choices": [...], "required": bool }].
  qualification_questions jsonb not null default '[]'::jsonb check (jsonb_typeof(qualification_questions) = 'array' and pg_column_size(qualification_questions) <= 4096),

  -- Limits and retention.
  daily_session_limit integer not null default 300 check (daily_session_limit between 1 and 5000),
  session_message_limit integer not null default 60 check (session_message_limit between 5 and 300),
  retention_days integer not null default 90 check (retention_days between 7 and 730),
  anonymous_retention_days integer not null default 30 check (anonymous_retention_days between 1 and 365),

  -- Installation evidence: the last time the widget loaded from an allowed site (never inferred).
  last_seen_at timestamptz,
  last_seen_origin text check (char_length(last_seen_origin) <= 253),

  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);
create trigger web_chat_widgets_touch before update on web_chat_widgets for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Visitor sessions
-- ---------------------------------------------------------------------------

create table web_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- sha256 (hex) of the session token the visitor's browser holds. The token itself is never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Where the chat ran: 'site' (a Website Studio site, same-origin) or 'embed' (an external site).
  surface text not null check (surface in ('site', 'embed')),
  origin_host text not null check (char_length(origin_host) between 1 and 253),

  contact_id uuid,
  conversation_id uuid,

  -- What the visit carried, exactly as it arrived (never inferred): landing path, referrer (no query), UTM and click ids.
  landing_path text check (char_length(landing_path) <= 300),
  referrer text check (char_length(referrer) <= 300),
  attribution jsonb not null default '{}'::jsonb check (jsonb_typeof(attribution) = 'object' and pg_column_size(attribution) <= 2048),

  -- The visitor's own time zone as the browser reports it (validated), used to show booking times in their zone.
  timezone text check (char_length(timezone) <= 64),

  -- Typed by the visitor, UNVERIFIED. Never matched into an existing contact.
  visitor_name text check (char_length(visitor_name) <= 120),
  visitor_email citext check (char_length(visitor_email) <= 254),
  visitor_phone text check (char_length(visitor_phone) <= 32),
  lead_captured_at timestamptz,
  privacy_ack_at timestamptz,
  marketing_opt_in boolean not null default false,
  -- A live contact that already holds the same email or phone (exactly one): a hint for a person to review and merge, never a link.
  possible_match_contact_id uuid,

  qualification jsonb not null default '{}'::jsonb check (jsonb_typeof(qualification) = 'object' and pg_column_size(qualification) <= 4096),
  qualification_completed_at timestamptz,
  booking_requested_at timestamptz,
  handoff_requested_at timestamptz,

  status text not null default 'active' check (status in ('active', 'closed')),
  -- A keyed hash of the visitor's address, used only to rate-limit and to investigate abuse. The address itself is not stored.
  ip_hash text check (char_length(ip_hash) <= 64),
  message_count integer not null default 0 check (message_count >= 0),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_visitor_message_at timestamptz,
  closed_at timestamptz,

  foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id),
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete set null (conversation_id),
  unique (id, org_id)
);
create index web_chat_sessions_org_idx on web_chat_sessions (org_id, created_at desc);
create index web_chat_sessions_conversation_idx on web_chat_sessions (conversation_id) where conversation_id is not null;
create index web_chat_sessions_retention_idx on web_chat_sessions (last_seen_at);
create index web_chat_sessions_contact_idx on web_chat_sessions (org_id, contact_id) where contact_id is not null;

-- ---------------------------------------------------------------------------
-- The channel and the created-via value
-- ---------------------------------------------------------------------------

alter table conversations drop constraint conversations_channel_check;
alter table conversations add constraint conversations_channel_check check (channel in ('sms', 'whatsapp', 'email', 'web_chat'));

alter table contacts drop constraint contacts_created_via_check;
alter table contacts add constraint contacts_created_via_check check (created_via in (
  'inbound_message', 'manual', 'import', 'website_form', 'form', 'booking', 'api', 'agent', 'workflow', 'ghl_migration', 'call', 'website_chat'));

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in member's access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table web_chat_widgets enable row level security;
alter table web_chat_sessions enable row level security;

revoke all on web_chat_widgets, web_chat_sessions from public, anon, authenticated;
grant select on web_chat_widgets, web_chat_sessions to iaq_app_user;

create policy web_chat_widgets_select on web_chat_widgets for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('website.view'::text))::uuid[]));
create policy web_chat_sessions_select on web_chat_sessions for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('inbox.view'::text))::uuid[]));

-- ---------------------------------------------------------------------------
-- Website Studio sites
-- ---------------------------------------------------------------------------

-- A published site runs under a database role with no table privileges, so it can only ask this one question: "is the chat installed on this host, and
-- which public key names it?". The answer is the key and nothing else, and only for a verified host with a live publication whose workspace switched the
-- chat on and chose to install it on its own sites. The chat itself is served by the portal, never from the site's runtime.
create or replace function app.site_chat_widget(p_host text)
returns table (public_key text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select w.public_key
  from app.site_by_host(p_host) s
  join web_chat_widgets w on w.org_id = s.org_id
  where w.enabled and w.auto_install_sites
  limit 1
$$;
revoke all on function app.site_chat_widget(text) from public;
grant execute on function app.site_chat_widget(text) to iaq_site_runtime;

-- ---------------------------------------------------------------------------
-- Notification kind
-- ---------------------------------------------------------------------------

-- "A website visitor shared their details". The allow-list is read back from the live constraint and extended, never rewritten from a copy (see 0083).
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
  kinds := array(select distinct k from unnest(kinds || array['web_chat_lead']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
