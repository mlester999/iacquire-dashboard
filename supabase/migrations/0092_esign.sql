-- Phase 5B: electronic signatures for proposals, through a signing service the CLIENT connects with its own account.
--
--   * esign_connections: the workspace's connection to a signing service (PandaDoc, or the simulated twin that tests and browser QA use and production refuses). The API key
--     and the webhook key are stored AES-GCM sealed in a column the application role cannot read. The service's webhook address carries a secret path token, kept only as a
--     hash (the token is derived from a server key, so the owner can be shown the address again).
--   * signature_requests: one request to one signer for one frozen version of one proposal, with the leased, resumable, idempotent steps a worker takes to ask the service,
--     the facts the service reports back, the signed copy once it has been fetched, and whether the signature was applied to the proposal or set aside (and why).
--   * signature_events: the immutable history of a request, including every webhook delivery by its event id so a replay changes nothing.
--   * proposals.connect: who may connect or disconnect the signing service. proposal_decisions.signature_request_id becomes a real foreign key, and a decision made by a
--     signature must name its request.
--
-- Additive. No existing row changes. Every table is workspace-keyed with composite foreign keys, has row-level security, and gives the application role SELECT only: every
-- write runs in trusted server code after its own authorization check. Nothing here contacts a provider. The notification kinds signature_completed and signature_failed came
-- with 0091. The bucket for signed copies and certificates is 0090's proposal-documents.

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

-- Connecting a signing service is the client's own decision: the account is theirs, and so is what it costs. The agency never connects one for a client.
insert into role_permissions (role, permission) values
  ('owner', 'proposals.connect'), ('admin', 'proposals.connect')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------

create table esign_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- pandadoc: the real service (written against a replaced HTTP layer only; see src/server/esign/providers/pandadoc.ts). simulated: an in-process stand-in that signs nothing
  -- for anyone, used by tests and browser QA, and refused in production.
  provider text not null check (provider in ('pandadoc', 'simulated')),
  mode text not null check (mode in ('sandbox', 'live', 'simulated')),
  label text not null default '' check (char_length(label) <= 80),
  -- AES-GCM sealed JSON { apiKey, webhookKey }. Never readable by the application role, never returned to a browser, null once disconnected or revoked.
  credentials text,
  -- sha256 of the secret in the service's webhook address. The address itself is derived from a server key and the connection's id, so it can be shown again without being stored.
  webhook_token_hash text not null unique check (webhook_token_hash ~ '^[0-9a-f]{64}$'),
  account_label text check (char_length(account_label) <= 120),
  status text not null default 'connected' check (status in ('connected', 'needs_attention', 'error', 'revoked', 'disconnected')),
  status_detail text check (char_length(status_detail) <= 400),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  connected_by uuid references users(id) on delete set null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  check ((provider = 'simulated') = (mode = 'simulated')),
  check (status not in ('revoked', 'disconnected') or credentials is null)
);
-- One live connection per workspace in this version. A revoked or disconnected one is history.
create unique index esign_connections_live_idx on esign_connections (org_id) where status not in ('revoked', 'disconnected');
create trigger esign_connections_touch before update on esign_connections for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Signature requests
-- ---------------------------------------------------------------------------

create table signature_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  proposal_id uuid not null,
  proposal_version integer not null check (proposal_version >= 1),
  -- What the signer is asked to sign: the content hash of the frozen version and the sha256 of the PDF that was stored for it. The worker checks the PDF against this before it
  -- uploads anything, and the completion is applied only if the proposal is still on this exact version.
  version_hash text not null check (version_hash ~ '^[0-9a-f]{64}$'),
  pdf_file_id uuid,
  pdf_sha256 text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  connection_id uuid not null,
  provider text not null check (provider in ('pandadoc', 'simulated')),
  mode text not null check (mode in ('sandbox', 'live', 'simulated')),
  -- queued: waiting for the worker. sending: a worker holds it. sent / viewed: the service says the signer was asked / opened it. completed / declined / expired: the service's
  -- word. voided: a person (or a closed proposal) withdrew it. superseded: the proposal was revised after it. failed: it could not be created (a definite answer). unknown: an
  -- answer was lost after something may have been created; it is checked with the service and never sent again on a guess.
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'viewed', 'completed', 'declined', 'expired', 'voided', 'failed', 'unknown', 'superseded')),
  signer_name text not null check (char_length(btrim(signer_name)) between 1 and 160),
  signer_email citext not null check (char_length(signer_email::text) <= 254 and signer_email::text ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  signer_contact_id uuid,
  provider_document_id text check (char_length(provider_document_id) between 1 and 120),
  -- The steps already done at the service (document created, ready, send attempted), so a resumed job continues instead of repeating.
  provider_state jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_state) = 'object' and pg_column_size(provider_state) <= 4096),
  -- proposal : id : version : n, with n counting the earlier requests for that version. A doubled click or a redelivered job names the same key and finds the same request.
  idempotency_key text not null unique check (char_length(idempotency_key) <= 160),
  run_at timestamptz not null default now(),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  -- A worker holds the request until the lease runs out. A worker that dies simply stops renewing; another takes it over, resuming from provider_state.
  lease_until timestamptz,
  claimed_by text check (char_length(claimed_by) <= 80),
  last_error text check (char_length(last_error) <= 400),
  last_error_kind text check (last_error_kind in ('rate_limited', 'auth', 'permission', 'invalid_content', 'transient', 'unknown_outcome', 'blocked')),
  sent_at timestamptz,
  completed_at timestamptz,
  finished_at timestamptz,
  -- A completion is APPLIED (the proposal becomes accepted, a decision is recorded) only when the proposal is still sent, on this version, unanswered and not past its date.
  -- Otherwise the service's fact is kept and the reason it was set aside is recorded here for a person to see. Never both.
  applied_at timestamptz,
  not_applied_reason text check (not_applied_reason in ('superseded', 'voided', 'proposal_closed', 'expired', 'already_answered', 'integrity')),
  signed_file_id uuid,
  signed_sha256 text check (signed_sha256 is null or signed_sha256 ~ '^[0-9a-f]{64}$'),
  certificate_file_id uuid,
  certificate_sha256 text check (certificate_sha256 is null or certificate_sha256 ~ '^[0-9a-f]{64}$'),
  -- Fetching the signed copy is retried on its own schedule and given up after a while; the completion does not wait for it.
  copy_attempts integer not null default 0 check (copy_attempts >= 0),
  copy_next_at timestamptz,
  copy_gave_up_at timestamptz,
  -- Why a person (or the system) withdrew it, and whether the service was told. none: not needed (it never reached the service). wanted: the service still has to be told.
  -- done: told. manual: the service has no way for iAcquire to withdraw it; the business is asked to do it there.
  void_reason text check (char_length(void_reason) <= 200),
  cancel_state text not null default 'none' check (cancel_state in ('none', 'wanted', 'done', 'manual')),
  cancel_attempts integer not null default 0 check (cancel_attempts >= 0),
  last_polled_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (proposal_id, org_id) references proposals (id, org_id) on delete cascade,
  -- A connection that has requests is never deleted (disconnecting keeps the row); the key is not "restrict" so that removing a whole workspace can delete both in one statement.
  foreign key (connection_id, org_id) references esign_connections (id, org_id),
  foreign key (pdf_file_id, org_id) references private_files (id, org_id) on delete set null (pdf_file_id),
  foreign key (signed_file_id, org_id) references private_files (id, org_id) on delete set null (signed_file_id),
  foreign key (certificate_file_id, org_id) references private_files (id, org_id) on delete set null (certificate_file_id),
  foreign key (signer_contact_id, org_id) references contacts (id, org_id) on delete set null (signer_contact_id),
  check (status <> 'completed' or completed_at is not null),
  check (applied_at is null or status = 'completed'),
  check (applied_at is null or not_applied_reason is null),
  check (not_applied_reason is null or status = 'completed'),
  check (status not in ('sent', 'viewed') or provider_document_id is not null),
  check (signed_file_id is null or status = 'completed')
);
-- One live request per version of a proposal: a second tap, a second worker or a second person cannot start a parallel signing.
create unique index signature_requests_live_idx on signature_requests (proposal_id, proposal_version) where status in ('queued', 'sending', 'sent', 'viewed', 'unknown');
-- A document at the service belongs to one request; the webhook finds its request by (connection, document).
create unique index signature_requests_document_idx on signature_requests (connection_id, provider_document_id) where provider_document_id is not null;
create index signature_requests_proposal_idx on signature_requests (proposal_id, created_at desc);
create index signature_requests_due_idx on signature_requests (run_at) where status = 'queued';
create index signature_requests_lease_idx on signature_requests (lease_until) where status = 'sending';
create index signature_requests_poll_idx on signature_requests (last_polled_at nulls first) where status in ('sent', 'viewed');
create index signature_requests_copy_idx on signature_requests (copy_next_at nulls first) where status = 'completed' and signed_file_id is null and copy_gave_up_at is null;
create index signature_requests_cancel_idx on signature_requests (id) where cancel_state = 'wanted';
create trigger signature_requests_touch before update on signature_requests for each row execute function app.touch_updated_at();

-- What was asked of the signer never changes, a completed request never goes back, and the facts written once stay as written.
create or replace function app.signature_requests_guard() returns trigger language plpgsql as $$
begin
  if new.org_id <> old.org_id or new.proposal_id <> old.proposal_id or new.proposal_version <> old.proposal_version or new.version_hash <> old.version_hash
     or new.pdf_sha256 <> old.pdf_sha256 or new.connection_id <> old.connection_id or new.provider <> old.provider or new.mode <> old.mode
     or new.signer_name <> old.signer_name or new.signer_email <> old.signer_email or new.idempotency_key <> old.idempotency_key then
    raise exception 'signature_requests: what was asked of the signer cannot be changed' using errcode = '42501';
  end if;
  if old.status = 'completed' and new.status <> 'completed' then
    raise exception 'signature_requests: a completed request cannot go back to another state' using errcode = '42501';
  end if;
  if (old.provider_document_id is not null and new.provider_document_id is distinct from old.provider_document_id)
     or (old.signed_sha256 is not null and new.signed_sha256 is distinct from old.signed_sha256)
     or (old.applied_at is not null and new.applied_at is distinct from old.applied_at)
     or (old.completed_at is not null and new.completed_at is distinct from old.completed_at) then
    raise exception 'signature_requests: a fact recorded once cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger signature_requests_guard before update on signature_requests for each row execute function app.signature_requests_guard();

-- Every step and every delivery, with who or what did it. Append-only. A webhook delivery carries the service's own event id (or one made from its content), so a replay finds
-- the row that is already there and changes nothing.
create table signature_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  request_id uuid not null,
  at timestamptz not null default now(),
  kind text not null check (char_length(kind) between 1 and 40),
  source text not null check (source in ('user', 'system', 'provider_webhook', 'provider_poll')),
  provider_event_id text check (char_length(provider_event_id) between 1 and 200),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048),
  foreign key (request_id, org_id) references signature_requests (id, org_id) on delete cascade
);
create index signature_events_request_idx on signature_events (request_id, id);
create unique index signature_events_provider_idx on signature_events (request_id, provider_event_id) where provider_event_id is not null;
-- Append-only. The one exception is the purge of a departed client's data, which offboarding declares with iaq.purge (the same switch proposal_events honours).
create or replace function app.signature_events_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('iaq.purge', true) = 'on' then
    return old;
  end if;
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;
create trigger signature_events_immutable before update or delete on signature_events for each row execute function app.signature_events_append_only();

-- ---------------------------------------------------------------------------
-- The decision a signature makes names its request
-- ---------------------------------------------------------------------------

-- A decision is append-only, so the key refuses a delete of the request it names instead of clearing the column. A signature decision always names its request, and no other
-- decision does.
alter table proposal_decisions add constraint proposal_decisions_signature_request_fkey foreign key (signature_request_id, org_id) references signature_requests (id, org_id);
alter table proposal_decisions add constraint proposal_decisions_signature_method_check check ((method = 'provider_signature') = (signature_request_id is not null));

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in member's access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table esign_connections enable row level security;
alter table signature_requests enable row level security;
alter table signature_events enable row level security;

revoke all on esign_connections, signature_requests, signature_events from public, anon, authenticated, iaq_site_runtime;
grant select on signature_requests, signature_events to iaq_app_user;
-- A connection is readable except its sealed credentials and the hash of its webhook secret.
grant select (id, org_id, provider, mode, label, account_label, status, status_detail, last_checked_at, last_success_at, connected_by, connected_at, disconnected_at, created_at, updated_at)
  on esign_connections to iaq_app_user;

create policy esign_connections_select on esign_connections for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy signature_requests_select on signature_requests for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
create policy signature_events_select on signature_events for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('proposals.view'::text))::uuid[]));
