-- Phase 5A: proposals. A client sends its own customer a priced proposal; a person approves the exact version that goes out; the customer's answer is recorded.
--
--   * proposal_settings: the workspace's approval rules and CRM effects (everything off or unset until the owner chooses; no price, term or validity is invented).
--   * proposal_counters, proposal_tax_rates, proposal_catalog_items: the workspace's own numbering, tax rates and price book. Nothing is seeded.
--   * proposal_templates and proposal_template_versions: reusable wording, frozen per version, approved by the owner before anyone sends from it.
--   * proposals: the working copy. proposal_versions: the frozen snapshot of a version (what a reviewer approves, what the customer sees, what a decision is bound to).
--   * proposal_events: the immutable history. proposal_decisions: the customer's (or a person's recorded) answer, append-only.
--   * proposal_share_links, proposal_link_challenges, proposal_link_sessions: the tokenized page for the customer, its emailed one-time code and the session that follows.
--     The customer sees the frozen version on that page; asking for the emailed code is the only way to answer. Nothing on those three tables is readable by the application role
--     except the link's own counters (never the token's hash).
--   * proposal_ai_runs: the record of an AI drafting request (the draft it produced is an ordinary draft a person must approve).
--   * Eight permissions (proposals.*) and nine notification kinds. The private-file bucket `proposal-documents` and its access rule came with 0090.
--
-- Additive. No existing row changes. Every table is workspace-keyed with composite foreign keys, has row-level security, and gives the application role
-- SELECT only: every write runs in trusted server code after its own authorization check. Nothing here contacts anyone. Amounts are integers in a currency's
-- minor unit (src/lib/money); a floating point amount is never stored.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

-- View: the whole team that works with customers, read-only viewers, and the agency (an agency person is limited to a client's proposals by assignment and works
-- inside the audited support session in the application). FOUNDER DECISION STILL OPEN: the select policies of the tables below use app.permitted_orgs('proposals.view'), which
-- (unlike contacts.view) does not require a support session for an agency caller, so at the database an assigned agency person is limited by assignment alone. Nothing reaches
-- them that way today: the browser roles hold no privilege on these tables, and no screen offers an agency person these records (the proposal pages are the client's own people's).
-- The files are different: 0090 makes the proposal-documents bucket require an active support session for an agency caller. If the founder wants the tables gated the same way, a later
-- migration adds 'proposals.view' to the session-gated list of app.permitted_orgs and app.has_permission (both replaced from their live definitions, with their rollbacks and
-- tests/rls-initplan-equivalence.test.ts); until then this paragraph is the record of the decision. Create (drafts, submit for approval): owner, manager, team member, sales rep. Discount (set or change a
-- discount or override a catalog price) and approve: the client's owner and manager. Send: owner, manager, sales rep. Record a decision made outside the product:
-- owner and manager. Catalog (price book, templates, tax rates): owner and manager, and the agency as a setup service. Settings: the owner.
insert into role_permissions (role, permission) values
  ('owner', 'proposals.view'), ('admin', 'proposals.view'), ('member', 'proposals.view'), ('sales_rep', 'proposals.view'), ('viewer', 'proposals.view'),
  ('agency_staff', 'proposals.view'), ('agency_manager', 'proposals.view'), ('agency_super_admin', 'proposals.view'),
  ('owner', 'proposals.create'), ('admin', 'proposals.create'), ('member', 'proposals.create'), ('sales_rep', 'proposals.create'),
  ('owner', 'proposals.discount'), ('admin', 'proposals.discount'),
  ('owner', 'proposals.approve'), ('admin', 'proposals.approve'),
  ('owner', 'proposals.send'), ('admin', 'proposals.send'), ('sales_rep', 'proposals.send'),
  ('owner', 'proposals.record_decision'), ('admin', 'proposals.record_decision'),
  ('owner', 'proposals.catalog'), ('admin', 'proposals.catalog'), ('agency_staff', 'proposals.catalog'), ('agency_manager', 'proposals.catalog'), ('agency_super_admin', 'proposals.catalog'),
  ('owner', 'proposals.settings')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Settings, numbering, tax rates, price book
-- ---------------------------------------------------------------------------

create table proposal_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- AI drafting is off until the owner turns it on. An AI draft always needs a person's approval, whatever else is set.
  ai_drafts_enabled boolean not null default false,
  -- ai_and_discounts: only AI drafts, discounts and large totals are reviewed (and anything a person without the send permission wrote). all: every proposal is.
  approval_mode text not null default 'ai_and_discounts' check (approval_mode in ('ai_and_discounts', 'all')),
  -- A proposal with any billing group's total (tax included) above this needs approval. Null: no threshold.
  approval_over_minor bigint check (approval_over_minor is null or approval_over_minor > 0),
  discount_needs_approval boolean not null default true,
  -- The person who wrote a proposal cannot be the one who approves it.
  two_person boolean not null default false,
  default_validity_days integer check (default_validity_days is null or default_validity_days between 1 and 365),
  -- CRM effects of sending and accepting. Off (null / none) until the owner chooses.
  tag_on_send_id uuid,
  stage_on_send_id uuid,
  deal_on_accept text not null default 'none' check (deal_on_accept in ('none', 'won_stage')),
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  foreign key (tag_on_send_id, org_id) references crm_tags (id, org_id) on delete set null (tag_on_send_id),
  foreign key (stage_on_send_id, org_id) references crm_pipeline_stages (id, org_id) on delete set null (stage_on_send_id)
);

-- P-0001, P-0002 ...: taken with an upsert that returns the new number, so two proposals never share one.
create table proposal_counters (
  org_id uuid primary key references organizations(id) on delete cascade,
  last_number integer not null default 0 check (last_number >= 0)
);

-- Tax is added on top of the price (exclusive). The workspace types its own rates; the platform gives no tax advice and has no jurisdiction logic.
create table proposal_tax_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  rate_bps integer not null check (rate_bps between 0 and 10000),
  archived_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id)
);
create unique index proposal_tax_rates_name_idx on proposal_tax_rates (org_id, lower(name)) where archived_at is null;
create trigger proposal_tax_rates_touch before update on proposal_tax_rates for each row execute function app.touch_updated_at();

-- The workspace's own price book. A proposal line copies the price when it is added, so a later edit here never changes a sent version.
create table proposal_catalog_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  unit_label text not null default 'each' check (char_length(btrim(unit_label)) between 1 and 30),
  unit_price_minor bigint not null check (unit_price_minor between 0 and 100000000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  billing text not null default 'one_time' check (billing in ('one_time', 'monthly', 'yearly')),
  tax_rate_id uuid,
  version integer not null default 1 check (version >= 1),
  archived_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (tax_rate_id, org_id) references proposal_tax_rates (id, org_id) on delete set null (tax_rate_id)
);
create index proposal_catalog_items_org_idx on proposal_catalog_items (org_id, lower(name)) where archived_at is null;
create trigger proposal_catalog_items_touch before update on proposal_catalog_items for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------

create table proposal_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  current_version integer not null default 1 check (current_version >= 1),
  -- The exact version the workspace owner approved for use. Editing makes a new version, which needs approving again.
  approved_version integer check (approved_version >= 1),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, org_id),
  check ((status = 'archived') = (archived_at is not null)),
  check ((status = 'approved') = (approved_version is not null and approved_at is not null) or status = 'archived'),
  check (approved_version is null or approved_version <= current_version)
);
create unique index proposal_templates_key_idx on proposal_templates (org_id, key) where archived_at is null;
create trigger proposal_templates_touch before update on proposal_templates for each row execute function app.touch_updated_at();

create table proposal_template_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  template_id uuid not null,
  version integer not null check (version >= 1),
  doc jsonb not null check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) <= 262144),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (template_id, version),
  foreign key (template_id, org_id) references proposal_templates (id, org_id) on delete cascade
);
create trigger proposal_template_versions_frozen before update on proposal_template_versions for each row execute function app.block_update();

-- ---------------------------------------------------------------------------
-- AI drafting requests
-- ---------------------------------------------------------------------------

create table proposal_ai_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  kind text not null default 'draft' check (kind in ('draft')),
  brief jsonb not null default '{}'::jsonb check (jsonb_typeof(brief) = 'object' and pg_column_size(brief) <= 4096),
  -- What the model returned after the checks that drop unsupported claims and amounts. Suggestions only: nothing here is a proposal.
  output jsonb not null default '{}'::jsonb check (pg_column_size(output) <= 32768),
  status text not null check (status in ('succeeded', 'failed')),
  failure text check (char_length(failure) <= 400),
  created_at timestamptz not null default now(),
  unique (id, org_id)
);

-- ---------------------------------------------------------------------------
-- Proposals
-- ---------------------------------------------------------------------------

create table proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  number text not null check (number ~ '^P-[0-9]{4,}$'),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'changes_requested', 'rejected', 'approved', 'sent', 'accepted', 'declined', 'expired', 'withdrawn')),
  contact_id uuid,
  company_id uuid,
  opportunity_id uuid,
  template_id uuid,
  template_version integer,
  owner_user_id uuid references users(id) on delete set null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- The last day the proposal can be accepted, in the workspace's time zone.
  valid_until date,
  requires_signature boolean not null default false,
  client_name text not null default '' check (char_length(client_name) <= 160),
  client_company text not null default '' check (char_length(client_company) <= 160),
  client_email citext check (client_email is null or (char_length(client_email::text) <= 254 and client_email::text ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  -- The working copy: sections, lines and terms, with tokens not yet filled in. The frozen, filled-in copy is the version row.
  doc jsonb not null default '{}'::jsonb check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) <= 262144),
  -- Totals include tax, per billing group; groups are never added together.
  one_time_total_minor bigint not null default 0 check (one_time_total_minor >= 0),
  monthly_total_minor bigint not null default 0 check (monthly_total_minor >= 0),
  yearly_total_minor bigint not null default 0 check (yearly_total_minor >= 0),
  -- For the team only: never part of a frozen version, a page or a PDF.
  internal_notes text check (char_length(internal_notes) <= 4000),
  origin text not null default 'human' check (origin in ('human', 'ai')),
  ai_run_id uuid,
  -- Bumps on every change to what the customer will see. An approval names the version it approved; a changed proposal needs approving again.
  version integer not null default 1 check (version >= 1),
  approved_version integer,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  decision_note text check (char_length(decision_note) <= 600),
  sent_version integer,
  sent_at timestamptz,
  sent_by uuid references users(id) on delete set null,
  signature_state text not null default 'none' check (signature_state in ('none', 'requested', 'completed', 'failed', 'recorded_offline')),
  closed_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, number),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id),
  foreign key (company_id, org_id) references crm_companies (id, org_id) on delete set null (company_id),
  foreign key (opportunity_id, org_id) references crm_opportunities (id, org_id) on delete set null (opportunity_id),
  foreign key (template_id, org_id) references proposal_templates (id, org_id) on delete set null (template_id),
  foreign key (ai_run_id, org_id) references proposal_ai_runs (id, org_id) on delete set null (ai_run_id),
  -- An approval is of one version of one proposal: the database refuses a state that says approved or sent for a version other than the current one.
  check (approved_version is null or approved_version <= version),
  check ((approved_version is null) = (approved_at is null)),
  check (status not in ('approved', 'sent', 'accepted', 'declined', 'expired') or approved_version = version),
  check (status not in ('sent', 'accepted', 'declined', 'expired') or (sent_version = version and sent_at is not null and sent_by is not null)),
  check (sent_version is null or sent_version <= version),
  -- An AI-written proposal that is approved or has gone out always names a person who approved it.
  check (origin <> 'ai' or status not in ('approved', 'sent', 'accepted', 'declined', 'expired') or approved_by is not null),
  check (status not in ('rejected', 'accepted', 'declined', 'expired', 'withdrawn') or closed_at is not null),
  check (template_version is null or template_version >= 1)
);
create index proposals_org_idx on proposals (org_id, created_at desc);
create index proposals_status_idx on proposals (org_id, status);
create index proposals_contact_idx on proposals (org_id, contact_id) where contact_id is not null;
create index proposals_opportunity_idx on proposals (org_id, opportunity_id) where opportunity_id is not null;
create index proposals_expiry_idx on proposals (valid_until) where status = 'sent';
create trigger proposals_touch before update on proposals for each row execute function app.touch_updated_at();

-- The frozen copy of a version, written when a proposal is submitted for approval (so the reviewer sees exactly what is frozen) or sent. content_hash covers the whole
-- snapshot, which is what an approval, a customer's decision and a signature are bound to. source_hash covers the working fields it was made from, so sending can
-- check that nothing was changed behind the approval's back.
create table proposal_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  proposal_id uuid not null,
  version integer not null check (version >= 1),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and pg_column_size(snapshot) <= 524288),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  one_time_total_minor bigint not null default 0 check (one_time_total_minor >= 0),
  monthly_total_minor bigint not null default 0 check (monthly_total_minor >= 0),
  yearly_total_minor bigint not null default 0 check (yearly_total_minor >= 0),
  pdf_file_id uuid,
  pdf_sha256 text check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_bytes integer check (pdf_bytes is null or pdf_bytes > 0),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  superseded_at timestamptz,
  unique (proposal_id, version),
  unique (id, org_id),
  foreign key (proposal_id, org_id) references proposals (id, org_id) on delete cascade,
  foreign key (pdf_file_id, org_id) references private_files (id, org_id) on delete set null (pdf_file_id)
);

-- Once saved, a version's content never changes. The PDF columns are written once; the file may later be removed (its id clears), but not replaced. sent_at and
-- superseded_at are set once.
create or replace function app.proposal_versions_frozen() returns trigger language plpgsql as $$
begin
  if new.org_id <> old.org_id or new.proposal_id <> old.proposal_id or new.version <> old.version
     or new.snapshot is distinct from old.snapshot or new.content_hash <> old.content_hash or new.source_hash <> old.source_hash
     or new.one_time_total_minor <> old.one_time_total_minor or new.monthly_total_minor <> old.monthly_total_minor or new.yearly_total_minor <> old.yearly_total_minor then
    raise exception 'proposal_versions content cannot be changed once saved' using errcode = '42501';
  end if;
  if (old.pdf_file_id is not null and new.pdf_file_id is not null and new.pdf_file_id <> old.pdf_file_id)
     or (old.pdf_sha256 is not null and new.pdf_sha256 is distinct from old.pdf_sha256)
     or (old.pdf_bytes is not null and new.pdf_bytes is distinct from old.pdf_bytes)
     or (old.sent_at is not null and new.sent_at is distinct from old.sent_at)
     or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
    raise exception 'proposal_versions rendering and delivery facts cannot be changed once set' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger proposal_versions_frozen before update on proposal_versions for each row execute function app.proposal_versions_frozen();

-- Every create, edit, approval, send and decision, with who did it. Append-only. actor_id is kept as written and is not a foreign key, so a record of who did something
-- never changes afterwards.
create table proposal_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  proposal_id uuid not null,
  version integer,
  at timestamptz not null default now(),
  kind text not null check (char_length(kind) between 1 and 40),
  actor_id uuid,
  actor_kind text not null default 'user' check (actor_kind in ('user', 'ai', 'system', 'recipient', 'provider')),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048),
  foreign key (proposal_id, org_id) references proposals (id, org_id) on delete cascade
);
create index proposal_events_proposal_idx on proposal_events (proposal_id, id);
-- Append-only. The one exception is the purge of a departed client's data, which offboarding declares with iaq.purge (the same switch the invoice tables honour); without it a
-- workspace that ever had a proposal could never be deleted.
create or replace function app.proposal_events_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('iaq.purge', true) = 'on' then
    return old;
  end if;
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;
create trigger proposal_events_immutable before update or delete on proposal_events for each row execute function app.proposal_events_append_only();

-- ---------------------------------------------------------------------------
-- The customer's page: share links, emailed codes, sessions
-- ---------------------------------------------------------------------------

-- A share link is a credential. Only the sha256 of its token is stored (the token is derived from a server key, so staff can be shown it again without it being kept).
create table proposal_share_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  proposal_id uuid not null,
  version integer not null check (version >= 1),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  recipient_email citext check (recipient_email is null or char_length(recipient_email::text) <= 254),
  recipient_name text check (char_length(recipient_name) <= 160),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  delivery_channel text not null default 'manual_link' check (delivery_channel in ('manual_link', 'email')),
  -- Three honest levels of "seen": opened (a GET: may be a scanner), viewed (a browser beacon after the page stayed visible), verified (the emailed code was entered).
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer not null default 0 check (open_count >= 0),
  first_viewed_at timestamptz,
  viewed_count integer not null default 0 check (viewed_count >= 0),
  verified_at timestamptz,
  downloaded_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (proposal_id, org_id) references proposals (id, org_id) on delete cascade
);
-- One live link per proposal version.
create unique index proposal_share_links_live_idx on proposal_share_links (proposal_id, version) where revoked_at is null;

create table proposal_link_challenges (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null,
  org_id uuid not null references organizations(id) on delete cascade,
  -- HMAC of the code under a server key; the code itself is never stored.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (link_id, org_id) references proposal_share_links (id, org_id) on delete cascade
);
create index proposal_link_challenges_link_idx on proposal_link_challenges (link_id, created_at desc);
-- The daily clean-up removes old challenges and sessions by date.
create index proposal_link_challenges_expiry_idx on proposal_link_challenges (expires_at);

create table proposal_link_sessions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null,
  org_id uuid not null references organizations(id) on delete cascade,
  session_hash text not null unique check (session_hash ~ '^[0-9a-f]{64}$'),
  verified_email citext not null,
  expires_at timestamptz not null,
  max_expires_at timestamptz not null,
  ip_hash text,
  ua_hash text,
  created_at timestamptz not null default now(),
  foreign key (link_id, org_id) references proposal_share_links (id, org_id) on delete cascade
);
create index proposal_link_sessions_link_idx on proposal_link_sessions (link_id);
create index proposal_link_sessions_expiry_idx on proposal_link_sessions (max_expires_at);

-- ---------------------------------------------------------------------------
-- Decisions
-- ---------------------------------------------------------------------------

-- A recorded answer, bound to the exact content hash that was shown. Not an electronic signature unless a signing service verified one (method provider_signature).
-- Append-only: the only change ever allowed is clearing attestation_file_id when the stored scan is removed.
create table proposal_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  proposal_id uuid not null,
  version integer not null check (version >= 1),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision in ('accepted', 'declined', 'changes_requested')),
  method text not null check (method in ('verified_acknowledgement', 'provider_signature', 'recorded_by_staff')),
  decided_name text check (char_length(decided_name) <= 160),
  decided_email citext check (char_length(decided_email::text) <= 254),
  acknowledgement_version integer check (acknowledgement_version >= 1),
  acknowledgement_text text check (char_length(acknowledgement_text) <= 1000),
  note text check (char_length(note) <= 2000),
  ip_hash text,
  ua_hash text,
  -- Foreign key to the signature request is added with the e-signature tables (0092).
  signature_request_id uuid,
  recorded_by uuid,
  attestation_file_id uuid,
  decided_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (proposal_id, org_id) references proposals (id, org_id) on delete cascade,
  foreign key (attestation_file_id, org_id) references private_files (id, org_id) on delete set null (attestation_file_id),
  check ((method = 'recorded_by_staff') = (recorded_by is not null)),
  -- Accepting online is the only answer that carries the acknowledgement the customer ticked; declining or asking for changes records the verified address and nothing more.
  check (method <> 'verified_acknowledgement' or (decided_email is not null and (decision <> 'accepted' or (acknowledgement_version is not null and acknowledgement_text is not null)))),
  check (method <> 'provider_signature' or decision = 'accepted')
);
-- One accepted or declined answer per version: a second tap, a replay or a race records nothing new.
create unique index proposal_decisions_final_idx on proposal_decisions (proposal_id, version) where decision in ('accepted', 'declined');
create index proposal_decisions_proposal_idx on proposal_decisions (proposal_id, decided_at);

create or replace function app.proposal_decisions_append_only() returns trigger language plpgsql as $$
begin
  -- A purge of a departed client's data declares itself with iaq.purge (see offboarding); nothing else can delete a recorded answer.
  if tg_op = 'DELETE' and current_setting('iaq.purge', true) = 'on' then
    return old;
  end if;
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'attestation_file_id') = (to_jsonb(old) - 'attestation_file_id')
     and old.attestation_file_id is not null and new.attestation_file_id is null then
    return new;
  end if;
  raise exception 'proposal_decisions is append-only' using errcode = '42501';
end $$;
create trigger proposal_decisions_append_only before update or delete on proposal_decisions for each row execute function app.proposal_decisions_append_only();

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in member's access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table proposal_settings enable row level security;
alter table proposal_counters enable row level security;
alter table proposal_tax_rates enable row level security;
alter table proposal_catalog_items enable row level security;
alter table proposal_templates enable row level security;
alter table proposal_template_versions enable row level security;
alter table proposal_ai_runs enable row level security;
alter table proposals enable row level security;
alter table proposal_versions enable row level security;
alter table proposal_events enable row level security;
alter table proposal_share_links enable row level security;
alter table proposal_link_challenges enable row level security;
alter table proposal_link_sessions enable row level security;
alter table proposal_decisions enable row level security;

revoke all on proposal_settings, proposal_counters, proposal_tax_rates, proposal_catalog_items, proposal_templates, proposal_template_versions, proposal_ai_runs, proposals,
  proposal_versions, proposal_events, proposal_share_links, proposal_link_challenges, proposal_link_sessions, proposal_decisions
  from public, anon, authenticated, iaq_site_runtime;
-- The counter, the emailed-code challenges and the customer sessions are server-only: no grant at all.
grant select on proposal_settings, proposal_tax_rates, proposal_catalog_items, proposal_templates, proposal_template_versions, proposal_ai_runs, proposals, proposal_versions,
  proposal_events, proposal_decisions to iaq_app_user;
-- A share link is readable except the hash of its token.
grant select (id, org_id, proposal_id, version, recipient_email, recipient_name, expires_at, revoked_at, delivery_channel, first_opened_at, last_opened_at, open_count, first_viewed_at,
  viewed_count, verified_at, downloaded_at, created_by, created_at) on proposal_share_links to iaq_app_user;

create policy proposal_settings_select on proposal_settings for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy proposal_tax_rates_select on proposal_tax_rates for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy proposal_catalog_items_select on proposal_catalog_items for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy proposal_templates_select on proposal_templates for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy proposal_template_versions_select on proposal_template_versions for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy proposal_ai_runs_select on proposal_ai_runs for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy proposals_select on proposals for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy proposal_versions_select on proposal_versions for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy proposal_events_select on proposal_events for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy proposal_share_links_select on proposal_share_links for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy proposal_decisions_select on proposal_decisions for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));

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
  kinds := array(select distinct k from unnest(kinds || array['proposal_approval_requested', 'proposal_approval_decided', 'proposal_viewed', 'proposal_accepted', 'proposal_declined', 'proposal_changes_requested', 'proposal_expiring', 'signature_completed', 'signature_failed']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
