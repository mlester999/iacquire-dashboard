-- Phase 6 (A, B, C, F): the Requests Center is finished on top of what already exists. No second ticketing system and no second project model.
--
--   * Request a Change: support_tickets gains the request type 'change' and six categories, and support_ticket_change holds what only the team knows about one (what kind
--     of change it is, whether the core system covers it, the monthly allowance covers it, or it needs a quote). Agency-only; the client never reads a classification.
--   * Out-of-scope changes to an agreed custom project are kept as a ledger that survives every outcome: project_change_orders (priced only when a quote was sent, frozen once
--     sent, never deleted), project_change_order_decisions (the client's recorded answer to one quote, append-only) and project_scope_amendments (what an accepted change added
--     to the agreed scope and price; the original client_projects.scope is never overwritten, the agreed scope is the original plus its amendments). The database refuses a
--     change marked accepted without the client's recorded acceptance of that exact quote, and an amendment that differs from the accepted price or currency.
--   * project_prerequisites: what a person confirmed before work starts (agreement, deposit, access, content). A record of a human check; nothing is detected or charged.
--   * client_projects: the warranty window, the revisions included and used. client_project_requests and project_messages: idempotency keys so a retry or a double click
--     makes one. project_messages and project_files can belong to a change order.
--   * support_message_mentions (internal notes only, team members who work on that client), support_ticket_ai_triage (a reviewable suggestion, never applied by itself),
--     support_surveys (resolution and project-completion satisfaction; OFF until the Super Admin switches it on).
--   * support_settings: the switches for surveys, AI triage, project review targets and the prerequisites. Event kinds and notification kinds are extended from the live
--     constraints. support_tickets.project_id becomes a composite (id, org_id) key so a request can never point at another workspace's project.
--   * A defect in 0015 is fixed on the way: a recorded quote decision could never be deleted, even by the purge of a departed client's data, so such a client could not be purged.
--     app.quote_approvals_append_only now lets a purge (iaq.purge) delete it and nothing else.
--
-- Additive. No existing row changes. Every table is workspace-keyed with composite foreign keys, has row-level security and gives the application role SELECT only (column
-- level where a column is internal): every write runs in trusted server code after its own authorization check. Nothing here contacts a provider, sends a message or charges.
-- Rollback: supabase/rollbacks/0098_requests_completion.down.sql (refuses while any of it has been used).

-- ---------------------------------------------------------------------------
-- support_tickets: the new request type, its categories, and a project link that cannot cross workspaces
-- ---------------------------------------------------------------------------

-- The lists are read back from the live constraints and extended in place, never rewritten from a copy, and their order is kept so the rollback restores each exactly.
do $$
declare
  spec record;
  def text;
  vals text[];
begin
  for spec in
    select * from (values
      ('support_tickets', 'support_tickets_request_type_check', 'request_type', array['change'], 3),
      ('support_tickets', 'support_tickets_category_check', 'category', array['change_ai_employee', 'change_website', 'change_automation', 'change_integration', 'change_project', 'change_other'], 15),
      ('support_ticket_events', 'support_ticket_events_kind_check', 'kind', array['mentioned', 'change_classified', 'survey_answered', 'ai_triage_applied'], 10),
      ('support_notification_rules', 'support_notification_rules_event_kind_check', 'event_kind', array['staff_mention', 'survey_requested'], 8),
      ('support_notification_log', 'support_notification_log_event_kind_check', 'event_kind', array['staff_mention', 'survey_requested'], 8),
      ('project_review_tasks', 'project_review_tasks_kind_check', 'kind', array['review_change'], 4)
    ) as s(tbl, con, col, extra, minimum)
  loop
    select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = spec.con and c.conrelid = spec.tbl::regclass;
    if def is null then
      raise exception '% not found; cannot extend it', spec.con;
    end if;
    vals := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
    if vals is null or cardinality(vals) < spec.minimum then
      raise exception 'could not read the current values from % (read %); refusing to rewrite it', spec.con, coalesce(cardinality(vals), 0);
    end if;
    vals := vals || array(select e from unnest(spec.extra) as e where not (e = any(vals)));
    execute format('alter table %I drop constraint %I', spec.tbl, spec.con);
    execute format('alter table %I add constraint %I check (%I in (%s))', spec.tbl, spec.con, spec.col,
      (select string_agg(quote_literal(v), ', ' order by o) from unnest(vals) with ordinality as t(v, o)));
  end loop;
end $$;

-- The single-column key of 0015 trusted the service code to link a request to its own workspace's project. The composite key makes the database say so too; a deleted
-- project still leaves the request in place with the link cleared.
alter table support_tickets drop constraint support_tickets_project_id_fkey;
alter table support_tickets add constraint support_tickets_project_org_fkey
  foreign key (project_id, org_id) references client_project_requests (id, org_id) on delete set null (project_id);

-- Resolved requests waiting for their satisfaction survey are found through this index.
create index support_tickets_resolved_idx on support_tickets (resolved_at) where status = 'resolved';

-- A mention is stored against the exact message, the request, the workspace and the "internal" flag it had. The key lets a mention row say "internal" in a foreign key, so a
-- mention can never sit on a public reply, and a message cannot be turned public while a mention still names it.
alter table support_messages add constraint support_messages_mention_target_key unique (id, ticket_id, org_id, internal);

-- ---------------------------------------------------------------------------
-- Request a Change: what the team decided about it
-- ---------------------------------------------------------------------------

create table support_ticket_change (
  ticket_id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  -- Where the client said the change is. 'project' names the custom project it belongs to; the others name a part of the product.
  target_kind text not null check (target_kind in ('ai_employee', 'website', 'automation', 'integration', 'project', 'other')),
  project_id uuid,
  -- null = not looked at yet. Only the team writes it; nothing here is a price or a promise.
  classification text check (classification in ('covered', 'managed_allowance', 'needs_quote', 'out_of_scope')),
  classified_by uuid references users(id) on delete set null,
  classified_at timestamptz,
  resolution_note text check (char_length(resolution_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ticket_id, org_id) references support_tickets (id, org_id) on delete cascade,
  foreign key (project_id, org_id) references client_project_requests (id, org_id),
  check ((target_kind = 'project') = (project_id is not null)),
  check ((classification is null) = (classified_at is null))
);
create index support_ticket_change_project_idx on support_ticket_change (project_id) where project_id is not null;
create index support_ticket_change_open_idx on support_ticket_change (org_id) where classification is null;
create trigger support_ticket_change_touch before update on support_ticket_change for each row execute function app.touch_updated_at();

-- Only a Request a Change request has a change record, and its project is the one the request itself names.
create function app.support_ticket_change_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from support_tickets t
     where t.id = new.ticket_id and t.org_id = new.org_id and t.request_type = 'change' and t.project_id is not distinct from new.project_id
  ) then
    raise exception 'A change record belongs only to a Request a Change request, and to the project that request names' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger support_ticket_change_guard before insert on support_ticket_change for each row execute function app.support_ticket_change_guard();

-- ---------------------------------------------------------------------------
-- Custom projects: the change-order ledger
-- ---------------------------------------------------------------------------

create sequence project_change_order_ref_seq start with 1001;

-- One row per change a client asks for on an agreed project. Declined and withdrawn rows are kept for good. The price, the weeks and the terms exist only once a quote was
-- sent (a draft quote is the team's own page, never a row the client can read), and they cannot change afterwards: a changed quote is a new version.
create table project_change_orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('CHG-' || nextval('project_change_order_ref_seq')::text),
  org_id uuid not null,
  request_id uuid not null,
  -- The Request a Change request it came from, if it came from there.
  ticket_id uuid,
  title text not null check (char_length(title) between 3 and 160),
  description text not null check (char_length(description) between 1 and 4000),
  status text not null default 'submitted' check (status in ('submitted', 'under_review', 'needs_info', 'quoted', 'accepted', 'declined', 'withdrawn', 'applied')),
  classification text not null default 'undetermined' check (classification in ('undetermined', 'in_scope_revision', 'out_of_scope')),
  -- 0 until a quote is sent; the first quote is 1. Moves only on the way into 'quoted'.
  quote_version integer not null default 0 check (quote_version >= 0),
  additional_cents integer check (additional_cents >= 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  additional_weeks_min integer check (additional_weeks_min > 0),
  additional_weeks_max integer check (additional_weeks_max > 0),
  terms_text text check (char_length(terms_text) <= 2000),
  valid_until date,
  content_hash text check (content_hash ~ '^[0-9a-f]{64}$'),
  requested_by uuid references users(id) on delete set null,
  requested_at timestamptz not null default now(),
  quoted_by uuid references users(id) on delete set null,
  quoted_at timestamptz,
  decided_at timestamptz,
  applied_by uuid references users(id) on delete set null,
  applied_at timestamptz,
  -- Agency-only. Not granted to the application role.
  internal_notes text check (char_length(internal_notes) <= 4000),
  idempotency_key text check (char_length(idempotency_key) between 8 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (id, request_id),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade,
  foreign key (ticket_id, org_id) references support_tickets (id, org_id),
  check (additional_weeks_max is null or additional_weeks_min is null or additional_weeks_max >= additional_weeks_min),
  constraint project_change_orders_quote_shape check ((quote_version > 0) = (quoted_at is not null)),
  -- A quote is for an out-of-scope change, has a price in a currency and a hash of its terms; before one is sent none of those exist.
  constraint project_change_orders_priced_only_when_quoted check (
    (quote_version = 0 and additional_cents is null and currency is null and additional_weeks_min is null and additional_weeks_max is null and terms_text is null
       and valid_until is null and content_hash is null)
    or (quote_version > 0 and classification = 'out_of_scope' and additional_cents is not null and currency is not null and content_hash is not null)
  ),
  constraint project_change_orders_quoted_states check (status not in ('quoted', 'accepted') or quote_version > 0),
  constraint project_change_orders_classified_states check (status not in ('quoted', 'accepted', 'applied') or classification <> 'undetermined'),
  constraint project_change_orders_accepted_decided check (status <> 'accepted' or decided_at is not null),
  constraint project_change_orders_applied_shape check ((status = 'applied') = (applied_at is not null))
);
create unique index project_change_orders_idempotency_idx on project_change_orders (org_id, requested_by, idempotency_key) where idempotency_key is not null;
create unique index project_change_orders_ticket_idx on project_change_orders (ticket_id) where ticket_id is not null;
-- A client has one quote to act on at a time.
create unique index project_change_orders_one_live_quote on project_change_orders (request_id) where status = 'quoted';
create index project_change_orders_request_idx on project_change_orders (request_id, created_at desc);
create index project_change_orders_queue_idx on project_change_orders (org_id, status, updated_at desc) where status in ('submitted', 'under_review', 'needs_info', 'quoted');
create trigger project_change_orders_touch before update on project_change_orders for each row execute function app.touch_updated_at();

alter table project_messages add column client_message_id uuid, add column change_order_id uuid;
alter table project_messages add foreign key (change_order_id, request_id) references project_change_orders (id, request_id) on delete set null (change_order_id);
create unique index project_messages_client_id_idx on project_messages (request_id, client_message_id) where client_message_id is not null;
create index project_messages_change_order_idx on project_messages (change_order_id) where change_order_id is not null;

alter table project_files add column change_order_id uuid;
alter table project_files add foreign key (change_order_id, request_id) references project_change_orders (id, request_id) on delete set null (change_order_id);
create index project_files_change_order_idx on project_files (change_order_id) where change_order_id is not null;

-- The client's answer to one quote of one change. Append-only: the only delete is the purge of a departed client's data (see offboarding).
create table project_change_order_decisions (
  id uuid primary key default gen_random_uuid(),
  change_order_id uuid not null,
  org_id uuid not null,
  quote_version integer not null check (quote_version >= 1),
  decision text not null check (decision in ('accepted', 'declined')),
  note text check (char_length(note) <= 2000),
  decided_by uuid not null references users(id),
  decided_at timestamptz not null default now(),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- What the person ticked. An acknowledgement tied to an account and a time, not an electronic signature.
  acknowledgement text not null check (char_length(acknowledgement) between 1 and 1000),
  ip_hash text,
  unique (id, org_id),
  unique (change_order_id, quote_version),
  foreign key (change_order_id, org_id) references project_change_orders (id, org_id) on delete cascade
);

-- What an accepted change added to the agreed project. One per change; the price and currency are the accepted quote's; the currency is the project's own.
create table project_scope_amendments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  request_id uuid not null,
  change_order_id uuid not null unique,
  added_scope text not null check (char_length(added_scope) between 1 and 4000),
  added_cents integer not null check (added_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  added_weeks_min integer check (added_weeks_min > 0),
  added_weeks_max integer check (added_weeks_max > 0),
  agreed_by uuid references users(id) on delete set null,
  agreed_at timestamptz not null default now(),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade,
  foreign key (change_order_id, request_id) references project_change_orders (id, request_id) on delete cascade,
  check (added_weeks_max is null or added_weeks_min is null or added_weeks_max >= added_weeks_min)
);
create index project_scope_amendments_request_idx on project_scope_amendments (request_id, agreed_at);

-- The agreed project's currency is what an amendment adds in. The key below names both, so an amendment can never be in another currency, and a project must have been
-- agreed (a client_projects row exists) before anything is added to it.
alter table client_projects add constraint client_projects_request_currency_key unique (request_id, currency);
alter table project_scope_amendments add constraint project_scope_amendments_currency_fk foreign key (request_id, currency) references client_projects (request_id, currency);

-- Warranty and revisions, as the team recorded them at handover. null means no number was stated; the quote's own wording stays the terms.
alter table client_projects
  add column warranty_days integer check (warranty_days between 0 and 3650),
  add column warranty_ends_on date,
  add column revisions_included integer check (revisions_included between 0 and 100),
  add column revisions_used integer not null default 0 check (revisions_used >= 0);
alter table client_projects add constraint client_projects_warranty_check check (warranty_ends_on is null or warranty_days is not null);
-- A revision beyond the number included is not free: it is a change that needs a quote, so the count cannot pass what was included.
alter table client_projects add constraint client_projects_revisions_check check (revisions_included is null or revisions_used <= revisions_included);

alter table client_project_requests add column idempotency_key text check (char_length(idempotency_key) between 8 and 80);
create unique index client_project_requests_idempotency_idx on client_project_requests (org_id, created_by, idempotency_key) where idempotency_key is not null;

-- The overdue-review job finds open tasks past their time through this index, and marks each one when it has told the team, so a task is announced once however long it stays
-- open and the job never has to walk the tasks it already announced. Agency-only table: nothing here is granted to the application role.
alter table project_review_tasks add column overdue_notified_at timestamptz;
create index project_review_tasks_due_idx on project_review_tasks (due_at) where status = 'open' and due_at is not null and overdue_notified_at is null;

-- A change request nobody has looked at is a task like a new project request's first review, so the same job sees it when it is late. The key names the project as well, so a
-- task can only point at a change of its own project, and only a change-review task names one.
alter table project_review_tasks add column change_order_id uuid;
alter table project_review_tasks add constraint project_review_tasks_change_fkey foreign key (change_order_id, request_id) references project_change_orders (id, request_id) on delete cascade;
alter table project_review_tasks add constraint project_review_tasks_change_kind_check check ((kind = 'review_change') = (change_order_id is not null));
create index project_review_tasks_change_idx on project_review_tasks (change_order_id) where change_order_id is not null;

create function app.project_change_order_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- A change request is kept for good, whatever became of it. A purge of a departed client's data declares itself with iaq.purge (see offboarding).
    if current_setting('iaq.purge', true) = 'on' then
      return old;
    end if;
    raise exception 'A change request is never deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'submitted' or new.quote_version <> 0 or new.classification <> 'undetermined' then
      raise exception 'A change request starts as submitted, unquoted and unclassified' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.org_id <> old.org_id or new.request_id <> old.request_id or new.ref <> old.ref or new.requested_at <> old.requested_at
     or new.title <> old.title or new.description <> old.description then
    raise exception 'What was asked, and for which project, never changes' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (case old.status
      when 'submitted' then new.status in ('under_review', 'declined', 'withdrawn')
      when 'under_review' then new.status in ('needs_info', 'quoted', 'applied', 'declined', 'withdrawn')
      when 'needs_info' then new.status in ('under_review', 'declined', 'withdrawn')
      when 'quoted' then new.status in ('under_review', 'accepted', 'declined', 'withdrawn')
      when 'accepted' then new.status = 'applied'
      else false end) then
    raise exception 'invalid_change_order_transition: % -> %', old.status, new.status using errcode = '23514';
  end if;
  if new.quote_version is distinct from old.quote_version then
    -- A new quote: only from review, one version at a time, and it is the same statement that writes its terms.
    if not (old.status = 'under_review' and new.status = 'quoted' and new.quote_version = old.quote_version + 1) then
      raise exception 'A quote version moves only when a new quote is sent' using errcode = '23514';
    end if;
  elsif old.quote_version > 0 and (
      new.classification is distinct from old.classification or new.additional_cents is distinct from old.additional_cents or new.currency is distinct from old.currency
      or new.additional_weeks_min is distinct from old.additional_weeks_min or new.additional_weeks_max is distinct from old.additional_weeks_max
      or new.terms_text is distinct from old.terms_text or new.valid_until is distinct from old.valid_until or new.content_hash is distinct from old.content_hash) then
    raise exception 'The terms of a quote that was sent cannot be edited; send a new quote' using errcode = '23514';
  end if;
  -- Nothing is accepted or declined on a guess: only against the client's recorded answer to this very quote.
  if new.status = 'accepted' and old.status is distinct from 'accepted' and not exists (
      select 1 from project_change_order_decisions d
       where d.change_order_id = new.id and d.quote_version = new.quote_version and d.decision = 'accepted' and d.content_hash = new.content_hash) then
    raise exception 'A change is accepted only against the client''s recorded acceptance of its quote' using errcode = '23514';
  end if;
  if new.status = 'declined' and old.status = 'quoted' and not exists (
      select 1 from project_change_order_decisions d
       where d.change_order_id = new.id and d.quote_version = new.quote_version and d.decision = 'declined') then
    raise exception 'A quote is declined only against the client''s recorded answer' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger project_change_orders_guard before insert or update or delete on project_change_orders for each row execute function app.project_change_order_guard();

create function app.project_change_order_decisions_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- The answer is to the quote that is waiting, as it was sent: its version and its hash.
    if not exists (
      select 1 from project_change_orders o
       where o.id = new.change_order_id and o.org_id = new.org_id and o.status = 'quoted' and o.quote_version = new.quote_version and o.content_hash = new.content_hash
    ) then
      raise exception 'A decision is recorded only against the quote that is waiting, as it was sent' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' and current_setting('iaq.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'project_change_order_decisions is append-only' using errcode = '42501';
end
$$;
create trigger project_change_order_decisions_guard before insert or update or delete on project_change_order_decisions for each row execute function app.project_change_order_decisions_guard();

-- 0015 made a client's recorded quote decisions append-only with no way out, so a client who had ever decided a quote could never have its data purged when it leaves: the purge
-- deletes every row of the workspace and stops at the first table that refuses. The recorded decision keeps its protection against everything else; a purge of a departed
-- client's data declares itself with iaq.purge, as it does for the records above.
create or replace function app.quote_approvals_append_only() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and current_setting('iaq.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'quote_approvals is append-only' using errcode = 'insufficient_privilege';
end
$$;

create function app.project_scope_amendments_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- What is added is exactly what the client accepted: an out-of-scope change whose accepted quote has this price and this currency.
    if not exists (
      select 1 from project_change_orders o
       where o.id = new.change_order_id and o.request_id = new.request_id and o.org_id = new.org_id and o.status in ('accepted', 'applied')
         and o.classification = 'out_of_scope' and o.additional_cents = new.added_cents and o.currency = new.currency
    ) then
      raise exception 'A scope amendment records exactly the price and currency of an accepted change' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' and current_setting('iaq.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'project_scope_amendments is append-only' using errcode = '42501';
end
$$;
create trigger project_scope_amendments_guard before insert or update or delete on project_scope_amendments for each row execute function app.project_scope_amendments_guard();

-- ---------------------------------------------------------------------------
-- Custom projects: what a person confirmed before work starts
-- ---------------------------------------------------------------------------

create table project_prerequisites (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  org_id uuid not null,
  kind text not null check (kind in ('agreement', 'deposit', 'access', 'content', 'change', 'other')),
  label text not null check (char_length(label) between 3 and 160),
  required boolean not null default true,
  blocks text not null default 'start' check (blocks in ('start', 'handover')),
  status text not null default 'pending' check (status in ('pending', 'satisfied', 'waived')),
  -- A person's record. Never detected, never charged: the evidence says what they checked and where.
  evidence_note text check (char_length(evidence_note) <= 1000),
  satisfied_by uuid references users(id) on delete set null,
  satisfied_at timestamptz,
  waived_reason text check (char_length(waived_reason) <= 1000),
  waived_by uuid references users(id) on delete set null,
  waived_at timestamptz,
  -- Reserved for the records a later phase may offer as evidence (a proposal, an invoice, a payment); nothing writes them today.
  source_kind text check (source_kind in ('proposal', 'invoice', 'payment')),
  source_id uuid,
  change_order_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade,
  foreign key (change_order_id, request_id) references project_change_orders (id, request_id),
  check ((source_kind is null) = (source_id is null)),
  constraint project_prerequisites_satisfied_check check (status <> 'satisfied' or (satisfied_at is not null and coalesce(char_length(evidence_note) >= 3, false))),
  constraint project_prerequisites_waived_check check (status <> 'waived' or (waived_at is not null and coalesce(char_length(waived_reason) >= 5, false))),
  constraint project_prerequisites_pending_check check (status <> 'pending' or (satisfied_at is null and waived_at is null))
);
-- The agreement and the deposit are asked for once per project, so seeding them again after a replay adds nothing.
create unique index project_prerequisites_once_idx on project_prerequisites (request_id, kind) where kind in ('agreement', 'deposit');
create index project_prerequisites_request_idx on project_prerequisites (request_id, status);
create trigger project_prerequisites_touch before update on project_prerequisites for each row execute function app.touch_updated_at();

-- A satisfied or waived prerequisite is the record of what a person checked: it is not deleted (a mistaken one is waived with a reason), except in a purge.
create function app.project_prerequisites_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if old.status = 'pending' or current_setting('iaq.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'A prerequisite that was confirmed or waived is kept as the record of it' using errcode = '42501';
end
$$;
create trigger project_prerequisites_guard before delete on project_prerequisites for each row execute function app.project_prerequisites_guard();

-- ---------------------------------------------------------------------------
-- Requests: mentions, the AI triage record, satisfaction surveys
-- ---------------------------------------------------------------------------

create table support_message_mentions (
  message_id uuid not null,
  ticket_id uuid not null,
  org_id uuid not null references organizations(id) on delete cascade,
  mentioned_user_id uuid not null references users(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  -- Always true: the key below names the message together with its flag, so a mention exists only on an internal note.
  internal boolean not null default true check (internal),
  created_at timestamptz not null default now(),
  primary key (message_id, mentioned_user_id),
  foreign key (message_id, ticket_id, org_id, internal) references support_messages (id, ticket_id, org_id, internal) on delete cascade
);
create index support_message_mentions_user_idx on support_message_mentions (mentioned_user_id, created_at desc);
create index support_message_mentions_ticket_idx on support_message_mentions (ticket_id);

-- Only a team member who works on the client can be mentioned.
create function app.support_message_mention_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from users u
     where u.id = new.mentioned_user_id and u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
       and app.user_can_access_org(u.id, new.org_id)
  ) then
    raise exception 'Only a team member who works on this client can be mentioned' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger support_message_mention_guard before insert on support_message_mentions for each row execute function app.support_message_mention_guard();

create table support_ticket_ai_triage (
  ticket_id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  -- pending: waiting for the triage job. ready: suggestions waiting for a person. applied / dismissed: a person answered. failed: nothing could be produced. skipped: not needed.
  status text not null default 'pending' check (status in ('pending', 'ready', 'applied', 'dismissed', 'failed', 'skipped')),
  -- rules: the built-in rules only. ai: a model refined the summary or the questions (the rules result is still the base).
  source text not null default 'rules' check (source in ('rules', 'ai')),
  intent text check (intent ~ '^[a-z_]{2,40}$'),
  suggested_request_type text check (suggested_request_type in ('support', 'issue', 'feedback', 'change')),
  suggested_category text check (char_length(suggested_category) <= 60),
  suggested_priority text check (suggested_priority in ('low', 'normal', 'high', 'urgent')),
  routing jsonb not null default '{}'::jsonb check (jsonb_typeof(routing) = 'object' and pg_column_size(routing) <= 8192),
  duplicate_candidates jsonb not null default '[]'::jsonb check (jsonb_typeof(duplicate_candidates) = 'array' and pg_column_size(duplicate_candidates) <= 8192),
  context_summary text check (char_length(context_summary) <= 4000),
  clarifying_questions jsonb not null default '[]'::jsonb check (jsonb_typeof(clarifying_questions) = 'array' and jsonb_array_length(clarifying_questions) <= 4 and pg_column_size(clarifying_questions) <= 4096),
  next_actions jsonb not null default '[]'::jsonb check (jsonb_typeof(next_actions) = 'array' and jsonb_array_length(next_actions) <= 8 and pg_column_size(next_actions) <= 8192),
  -- A short, plain reason. Never a provider's response body.
  ai_error text check (char_length(ai_error) <= 300),
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  review_outcome text check (review_outcome in ('accepted', 'edited', 'dismissed')),
  -- For the job that fills it in: a lease so two runs never take the same row, a count and the next time to try.
  attempts integer not null default 0 check (attempts >= 0),
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ticket_id, org_id) references support_tickets (id, org_id) on delete cascade,
  check ((reviewed_at is null) = (review_outcome is null)),
  check ((status = 'applied') = coalesce(review_outcome in ('accepted', 'edited'), false)),
  check ((status = 'dismissed') = coalesce(review_outcome = 'dismissed', false))
);
create index support_ticket_ai_triage_due_idx on support_ticket_ai_triage (next_attempt_at) where status = 'pending';
create index support_ticket_ai_triage_review_idx on support_ticket_ai_triage (org_id, status) where status = 'ready';
create trigger support_ticket_ai_triage_touch before update on support_ticket_ai_triage for each row execute function app.touch_updated_at();

create table support_surveys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('ticket_resolution', 'project_completion')),
  ticket_id uuid,
  project_request_id uuid,
  -- The person who opened the request (or the project) is the only one asked, and the only one who can answer.
  requested_for_user_id uuid not null references users(id) on delete cascade,
  status text not null default 'requested' check (status in ('requested', 'answered', 'expired', 'skipped')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz,
  rating integer check (rating between 1 and 5),
  helpful boolean,
  comment text check (char_length(comment) <= 1000),
  answered_by uuid references users(id) on delete set null,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ticket_id, org_id) references support_tickets (id, org_id) on delete cascade,
  foreign key (project_request_id, org_id) references client_project_requests (id, org_id) on delete cascade,
  check (num_nonnulls(ticket_id, project_request_id) = 1),
  check ((kind = 'ticket_resolution') = (ticket_id is not null)),
  constraint support_surveys_answered_check check (
    (status = 'answered' and rating is not null and answered_at is not null)
    or (status <> 'answered' and rating is null and helpful is null and comment is null and answered_at is null)
  )
);
-- One survey per request and per project, however many times the job runs.
create unique index support_surveys_ticket_idx on support_surveys (ticket_id) where ticket_id is not null;
create unique index support_surveys_project_idx on support_surveys (project_request_id) where project_request_id is not null;
create index support_surveys_person_idx on support_surveys (requested_for_user_id, status);
create index support_surveys_org_idx on support_surveys (org_id, status, requested_at desc);
create index support_surveys_expiry_idx on support_surveys (expires_at) where status = 'requested' and expires_at is not null;
create trigger support_surveys_touch before update on support_surveys for each row execute function app.touch_updated_at();

-- A survey is answered once. After that it is a record: the answer, who gave it and when do not change.
create function app.support_surveys_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.org_id <> old.org_id or new.kind <> old.kind or new.ticket_id is distinct from old.ticket_id or new.project_request_id is distinct from old.project_request_id
     or new.requested_for_user_id <> old.requested_for_user_id then
    raise exception 'A survey stays with the request and the person it was for' using errcode = '23514';
  end if;
  if old.status <> 'requested' and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'A survey that was answered, expired or skipped does not change' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger support_surveys_guard before update on support_surveys for each row execute function app.support_surveys_guard();

-- ---------------------------------------------------------------------------
-- Settings: every switch ships off or empty
-- ---------------------------------------------------------------------------

-- Surveys are off until the Super Admin turns them on; the 24 hours before one is sent is a proposal for the founder to confirm. AI triage is allowed but needs a configured
-- provider before a model is ever called (the rules pass always runs). A project review target and showing it to clients are both off. Project prerequisites (the written
-- agreement and the payment terms confirmed by a person before work starts) are off until the founder decides which ones apply.
alter table support_settings
  add column surveys_enabled boolean not null default false,
  add column survey_delay_hours integer not null default 24 check (survey_delay_hours between 0 and 720),
  add column ai_triage_enabled boolean not null default true,
  add column project_review_target_hours integer check (project_review_target_hours between 1 and 720),
  add column show_project_targets_to_clients boolean not null default false,
  add column project_prerequisites_enabled boolean not null default false;
alter table support_settings add constraint support_settings_project_target_check check (not show_project_targets_to_clients or project_review_target_hours is not null);

insert into support_notification_rules (event_kind, mode) values ('staff_mention', 'in_app'), ('survey_requested', 'in_app');

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in person's access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table support_ticket_change enable row level security;
alter table project_change_orders enable row level security;
alter table project_change_order_decisions enable row level security;
alter table project_scope_amendments enable row level security;
alter table project_prerequisites enable row level security;
alter table support_message_mentions enable row level security;
alter table support_ticket_ai_triage enable row level security;
alter table support_surveys enable row level security;

revoke all on support_ticket_change, project_change_orders, project_change_order_decisions, project_scope_amendments, project_prerequisites, support_message_mentions,
  support_ticket_ai_triage, support_surveys from public, anon, authenticated, iaq_site_runtime;

-- Agency-only: the classification, the mentions and the triage record have no client policy at all.
grant select on support_ticket_change, support_message_mentions, support_ticket_ai_triage, support_surveys to iaq_app_user;
create policy support_ticket_change_select on support_ticket_change for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('agency.support.view'))::uuid[]));
create policy support_message_mentions_select on support_message_mentions for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('agency.support.view'))::uuid[]));
create policy support_ticket_ai_triage_select on support_ticket_ai_triage for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('agency.support.view'))::uuid[]));
-- A survey: the person it was sent to, the people who see the whole workspace's requests, and the team.
create policy support_surveys_select on support_surveys for select to iaq_app_user
  using (
    org_id = any ((select app.permitted_orgs('agency.support.view'))::uuid[])
    or org_id = any ((select app.permitted_orgs('support.view_all'))::uuid[])
    or (requested_for_user_id = (select app.current_user_id()) and org_id = any ((select app.permitted_orgs('support.use'))::uuid[]))
  );

-- A change request, as the client sees it: not the team's notes, not who quoted or applied it, not the retry key.
grant select (id, ref, org_id, request_id, ticket_id, title, description, status, classification, quote_version, additional_cents, currency, additional_weeks_min,
  additional_weeks_max, terms_text, valid_until, content_hash, requested_by, requested_at, quoted_at, decided_at, applied_at, created_at, updated_at)
  on project_change_orders to iaq_app_user;
create policy project_change_orders_select on project_change_orders for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('projects.view'))::uuid[]));

-- The recorded answer, without the hash of the address it came from.
grant select (id, change_order_id, org_id, quote_version, decision, note, decided_by, decided_at, content_hash, acknowledgement) on project_change_order_decisions to iaq_app_user;
create policy project_change_order_decisions_select on project_change_order_decisions for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('projects.view'))::uuid[]));

grant select on project_scope_amendments to iaq_app_user;
create policy project_scope_amendments_select on project_scope_amendments for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('projects.view'))::uuid[]));

-- The client's read-only "Before we start" list: what is asked for and whether it is done, not the team's evidence or who confirmed it.
grant select (id, request_id, org_id, kind, label, required, blocks, status, satisfied_at, waived_at, change_order_id, created_at, updated_at) on project_prerequisites to iaq_app_user;
create policy project_prerequisites_select on project_prerequisites for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('projects.view'))::uuid[]));

-- ---------------------------------------------------------------------------
-- Notification kinds
-- ---------------------------------------------------------------------------

-- Read back from the live constraint and extended, never rewritten from a copy (see 0083, 0087, 0089 and 0099).
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
  kinds := array(select distinct k from unnest(kinds || array['support_mention', 'support_survey', 'project_change_order', 'project_prerequisite', 'project_review_overdue']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
