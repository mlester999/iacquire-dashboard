-- Phase 5F: public reviews read from a review site, and replies to them that a person approves and posts.
--
--   * review_connections: a Google Business Profile location, or a Facebook Page (the one connected for Social, reused: its token is never copied here). A Google refresh
--     token is stored AES-GCM sealed in a column the application role cannot read. Status says honestly whether the connection works.
--   * review_oauth_states: single-use sign-in state for Google's authorization flow, plus the sealed list of locations the person may choose from.
--   * external_reviews: the local mirror of what a review site returned. Nothing writes it except the sync that reads the site: no insert, update or delete is granted to
--     the application role, and no server action takes a review or a rating as input. A review has no contact unless a person linked one by hand.
--   * review_replies and review_reply_events: a reply to one review, bound to the exact version a person approved, with the history of every step. A reply is drafted by a
--     person or by the AI assist for a person, approved by the client's owner or manager, and posted only if its text still equals what was approved.
--
--   * customer_feedback.possible_contact_id (private feedback, not public reviews): a survey answer typed by a visitor next to an email or phone that matches an existing customer
--     is not that customer's own answer until a person says so. It is kept without a customer, with the possible match beside it for the team to confirm or dismiss.
--
-- Additive. No existing row changes. Every table is workspace-keyed with composite foreign keys, has row-level security, and gives the application role SELECT only:
-- every write runs in trusted server code after its own authorization check. Nothing here contacts a provider. The permissions (reviews.view, reviews.respond,
-- reviews.reply_publish) and the notification kinds came with 0094.

-- ---------------------------------------------------------------------------
-- Connections and the sign-in flow
-- ---------------------------------------------------------------------------

create table review_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('google', 'facebook')),
  -- google: the Business Profile API. meta: Facebook Page ratings and recommendations through the Graph API. simulated: a local stand-in used by tests and QA, refused in production.
  adapter text not null check (adapter in ('google', 'meta', 'simulated')),
  external_account_id text check (char_length(external_account_id) <= 160),
  -- google: the location. facebook: the Page.
  external_location_id text not null check (char_length(external_location_id) between 1 and 200),
  name text not null check (char_length(name) between 1 and 200),
  -- A Facebook connection reads through the Page the workspace already connected for Social media: the same account, its token stays there.
  social_account_id uuid,
  -- AES-GCM encrypted JSON (Google: the refresh token). Never readable by the application role, never returned to a browser, null once disconnected. A Facebook connection stores none.
  credentials text,
  scopes text[] not null default '{}',
  status text not null default 'connected' check (status in ('connected', 'needs_reauth', 'error', 'revoked', 'disconnected')),
  status_detail text check (char_length(status_detail) <= 400),
  -- Whether the site and the access that was granted allow a reply to be posted from here, as of the last time it was asked.
  can_reply boolean not null default false,
  -- Where an unfinished pass over the site's reviews stands: { pageToken, passStartedAt, pages }. A pass that finishes clears it.
  sync_cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(sync_cursor) = 'object' and pg_column_size(sync_cursor) <= 2048),
  sync_lease_until timestamptz,
  last_sync_at timestamptz,
  last_success_at timestamptz,
  -- The last time a pass reached the end of the site's list. Reviews not seen in a finished pass are marked removed; nothing is marked removed by a pass that did not finish.
  last_complete_at timestamptz,
  -- What the site SAYS it has (its own average and total), kept apart from what has been read: the screen shows both.
  reported_rating numeric(3, 2) check (reported_rating is null or reported_rating between 1 and 5),
  reported_review_count integer check (reported_review_count is null or reported_review_count >= 0),
  reported_at timestamptz,
  connected_by uuid references users(id) on delete set null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (social_account_id, org_id) references social_accounts (id, org_id) on delete restrict,
  check (adapter <> 'google' or provider = 'google'),
  check (adapter <> 'meta' or provider = 'facebook'),
  check (provider = 'facebook' or social_account_id is null),
  check (credentials is null or provider = 'google'),
  check (status <> 'disconnected' or credentials is null),
  check (status <> 'connected' or adapter <> 'google' or credentials is not null)
);
-- One location belongs to one workspace: the same Google location or Facebook Page cannot be read into two workspaces. (The simulated stand-in has no real location, so it is
-- only held to one live connection per workspace.)
create unique index review_connections_location_idx on review_connections (provider, external_location_id) where status <> 'disconnected' and adapter <> 'simulated';
create unique index review_connections_simulated_idx on review_connections (org_id, provider, external_location_id) where status <> 'disconnected' and adapter = 'simulated';
create index review_connections_org_idx on review_connections (org_id, connected_at desc);
-- The scheduler's work list: connections that are read, the one read longest ago first.
create index review_connections_sync_idx on review_connections (last_sync_at nulls first) where status in ('connected', 'error');
create trigger review_connections_touch before update on review_connections for each row execute function app.touch_updated_at();

create table review_oauth_states (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('google')),
  -- sha256 of the state value handed to the provider; the value itself is not stored.
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  -- The PKCE verifier, sealed.
  code_verifier text,
  return_path text not null default '/crm/reviews?tab=settings' check (char_length(return_path) <= 200),
  -- After the provider sends the person back: the locations they may choose from and the sealed refresh token, encrypted, for ten minutes. The scheduler clears it once the
  -- state has expired.
  pending text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index review_oauth_states_user_idx on review_oauth_states (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The mirror
-- ---------------------------------------------------------------------------

create table external_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  connection_id uuid not null,
  provider_review_id text not null check (char_length(provider_review_id) between 1 and 200),
  -- Stars when the site uses stars (Google); a recommendation (yes or no) when it does not (Facebook). At least one.
  rating smallint check (rating between 1 and 5),
  recommends boolean,
  reviewer_name text check (char_length(reviewer_name) <= 200),
  reviewer_anonymous boolean not null default false,
  comment text check (char_length(comment) <= 4096),
  provider_created_at timestamptz,
  provider_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Not seen in a finished pass: the site no longer returns it (the reviewer or the site removed it). The row stays for a while, marked, and is cleared by the retention job.
  removed_at timestamptz,
  -- A reply that is on the site now, whoever wrote it.
  provider_reply_text text check (char_length(provider_reply_text) <= 4096),
  provider_reply_at timestamptz,
  -- Set only by a person, by hand. A reviewer's name is never matched to a customer automatically.
  contact_id uuid,
  contact_linked_by uuid references users(id) on delete set null,
  contact_linked_at timestamptz,
  -- Read from the simulated stand-in, so it shows a "Simulated" badge. Such rows exist only outside production.
  simulated boolean not null default false,
  -- The team was told about this review (a low star count); once.
  alerted_at timestamptz,
  unique (id, org_id),
  unique (connection_id, provider_review_id),
  foreign key (connection_id, org_id) references review_connections (id, org_id) on delete restrict,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id),
  check (rating is not null or recommends is not null)
);
create index external_reviews_org_idx on external_reviews (org_id, coalesce(provider_created_at, first_seen_at) desc) where removed_at is null;
create index external_reviews_connection_idx on external_reviews (connection_id, last_seen_at);
create index external_reviews_contact_idx on external_reviews (org_id, contact_id) where contact_id is not null;

-- ---------------------------------------------------------------------------
-- Replies
-- ---------------------------------------------------------------------------

create table review_replies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  review_id uuid not null,
  -- Bumps on every change to the text. An approval names the version it approved; a changed reply needs approving again.
  version integer not null default 1 check (version >= 1),
  body text not null check (char_length(body) between 1 and 4096),
  -- human: a person wrote it. ai: the AI assist drafted it for a person, who may have edited it since; it still needs a person's approval, always.
  origin text not null default 'human' check (origin in ('human', 'ai')),
  -- What the AI assist reports about its own draft: the company-knowledge sections it used and the checks it ran. Never the review's text.
  ai_meta jsonb check (ai_meta is null or (jsonb_typeof(ai_meta) = 'object' and pg_column_size(ai_meta) <= 2048)),
  author_id uuid references users(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'changes_requested', 'approved', 'posting', 'posted', 'failed', 'needs_reconciliation', 'rejected', 'cancelled')),
  approved_version integer,
  -- sha256 of the review, the version and the exact text that was approved. The text must still produce it at the moment of posting.
  approved_hash text check (approved_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  decision_note text check (char_length(decision_note) <= 600),
  -- Written BEFORE the request to the site leaves, so a crash in between is recognised as "possibly sent" and checked, never assumed unsent.
  sending_at timestamptz,
  posted_at timestamptz,
  posted_by uuid references users(id) on delete set null,
  -- provider: iAcquire sent it and the site accepted it. person: a person said they posted it themselves. verified_at is when a read of the site showed this exact text.
  posted_via text check (posted_via in ('provider', 'person')),
  verified_at timestamptz,
  failure_code text check (char_length(failure_code) <= 60),
  failure_message text check (char_length(failure_message) <= 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (review_id, org_id) references external_reviews (id, org_id) on delete cascade,
  check (approved_version is null or approved_version <= version),
  check ((approved_hash is null) = (approved_version is null)),
  check (status not in ('approved', 'posting', 'posted', 'needs_reconciliation') or (approved_version is not null and approved_by is not null)),
  check (status not in ('posting', 'needs_reconciliation') or sending_at is not null),
  check (status <> 'posted' or (posted_at is not null and posted_via is not null))
);
-- One open reply per review: a draft, a request waiting for a decision, an approved reply, one being sent or checked, or a failed one a person can still retry. A reply that was
-- posted, rejected or cancelled is closed, and a new one can be started (a posted reply is replaced on the site by the new one).
create unique index review_replies_open_idx on review_replies (review_id) where status in ('draft', 'pending_approval', 'changes_requested', 'approved', 'posting', 'failed', 'needs_reconciliation');
create index review_replies_org_idx on review_replies (org_id, status, updated_at desc);
create trigger review_replies_touch before update on review_replies for each row execute function app.touch_updated_at();

create table review_reply_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  reply_id uuid not null,
  at timestamptz not null default now(),
  kind text not null check (char_length(kind) between 1 and 40),
  actor_id uuid references users(id) on delete set null,
  actor_kind text not null default 'user' check (actor_kind in ('user', 'ai', 'system')),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048),
  foreign key (reply_id, org_id) references review_replies (id, org_id) on delete cascade
);
create index review_reply_events_reply_idx on review_reply_events (reply_id, id);

-- ---------------------------------------------------------------------------
-- Survey answers that may belong to a customer
-- ---------------------------------------------------------------------------

-- A public survey form identifies people only by what they typed. When the typed email or phone matches an existing customer whose address nobody has verified, the answer is
-- stored with no customer (contact_id null) and the customer it may be from here. Nothing is done about that customer (no timeline entry, no event, no stop to their programs, no
-- named count) until a person confirms the match, which moves it to contact_id; a person who says it is not them clears it. Never both at once.
alter table customer_feedback add column possible_contact_id uuid;
alter table customer_feedback add constraint customer_feedback_possible_contact_fk foreign key (possible_contact_id, org_id) references contacts (id, org_id) on delete set null (possible_contact_id);
alter table customer_feedback add constraint customer_feedback_possible_contact_check check (possible_contact_id is null or contact_id is null);
create index customer_feedback_possible_contact_idx on customer_feedback (org_id, possible_contact_id) where possible_contact_id is not null;

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in member's access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table review_connections enable row level security;
alter table review_oauth_states enable row level security;
alter table external_reviews enable row level security;
alter table review_replies enable row level security;
alter table review_reply_events enable row level security;

revoke all on review_connections, review_oauth_states, external_reviews, review_replies, review_reply_events from public, anon, authenticated;
-- The sign-in state and its encrypted choices are server-only: no grant at all.
-- The mirror and the replies are read-only for the application role. A review reaches the mirror only from the sync that reads the site.
grant select on external_reviews, review_replies, review_reply_events to iaq_app_user;
-- A connection is readable except its credentials.
grant select (id, org_id, provider, adapter, external_account_id, external_location_id, name, social_account_id, scopes, status, status_detail, can_reply, sync_cursor, sync_lease_until,
  last_sync_at, last_success_at, last_complete_at, reported_rating, reported_review_count, reported_at, connected_by, connected_at, disconnected_at, created_at, updated_at)
  on review_connections to iaq_app_user;

create policy review_connections_select on review_connections for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('reviews.view'::text))::uuid[]));
create policy external_reviews_select on external_reviews for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('reviews.view'::text))::uuid[]));
create policy review_replies_select on review_replies for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('reviews.view'::text))::uuid[]));
create policy review_reply_events_select on review_reply_events for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('reviews.view'::text))::uuid[]));
