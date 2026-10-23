-- Phase 5C and 5D: invoices a client sends to its own customers, and the payments, refunds and provider connections behind them.
--
-- This is a different financial domain from iAcquire's own billing (billing_accounts, payments, credit_ledger_entries, agency_finance_entries): every table
-- here is prefixed customer_ and nothing here reads or writes those.
--
--   * customer_invoice_settings: the client's legal details for the document, the number counter and prefix, and the reminder and close-rule choices.
--   * customer_invoices + customer_invoice_lines: the document. Money is bigint minor units in a currency from an allow-list. The totals must equal the sum of
--     the lines when an invoice is submitted or issued, and an invoice is frozen once it leaves draft (money, lines, dates, wording, snapshots), enforced by
--     triggers, not only by code. paid / refunded / payment_status can change only to what the payment and refund rows add up to.
--   * customer_payments + customer_refunds: what was received and what was handed back. A payment names its invoice AND its currency in one composite foreign
--     key, so it can never be in another workspace's invoice or another currency. Amounts never change after insert.
--   * customer_payment_connections + customer_payment_attempts + customer_payment_events: the client's own PayMongo / PayPal account, the checkouts started,
--     and the durable receipt of every webhook. The credentials column is sealed and has no grant; the receipts have no grant at all.
--   * customer_invoice_events (append-only), customer_invoice_reminders.
--   * Nine invoices.* permissions, eight notification kinds, and the message scope 'billing'.
--
-- Additive. No existing row changes. Every table is workspace-keyed with composite foreign keys, has row-level security, and gives the application role SELECT
-- only (column level where a column is a secret): every write runs in trusted server code after its own authorization check. Nothing here contacts a provider.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

-- Agency staff get none: an invoice holds a customer's details and the client's finances. The owner and manager work with invoices; a sales rep drafts and submits
-- them; recording a refund, writing off, settings and the payment connection are the owner's alone.
insert into role_permissions (role, permission) values
  ('owner', 'invoices.view'), ('admin', 'invoices.view'), ('sales_rep', 'invoices.view'),
  ('owner', 'invoices.create'), ('admin', 'invoices.create'), ('sales_rep', 'invoices.create'),
  ('owner', 'invoices.approve'), ('admin', 'invoices.approve'),
  ('owner', 'invoices.send'), ('admin', 'invoices.send'),
  ('owner', 'invoices.record_payment'), ('admin', 'invoices.record_payment'),
  ('owner', 'invoices.void'), ('admin', 'invoices.void'),
  ('owner', 'invoices.refund'),
  ('owner', 'invoices.settings'),
  ('owner', 'invoices.connect_payments')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create table customer_invoice_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- What the document says about the business that sends it. Free text the owner types; nothing here claims a tax registration.
  legal_name text check (char_length(legal_name) <= 160),
  address_lines text[] not null default '{}' check (cardinality(address_lines) <= 6),
  tax_label text check (char_length(tax_label) <= 40),
  tax_id text check (char_length(tax_id) <= 60),
  reply_to_email text check (char_length(reply_to_email) <= 200),
  -- The number is assigned when an invoice is issued, from this counter, in the issuing transaction: prefix + next_number padded to four digits.
  number_prefix text not null default 'INV-' check (number_prefix ~ '^[A-Za-z0-9._/-]{0,12}$'),
  next_number bigint not null default 1 check (next_number >= 1 and next_number < 1000000000000),
  default_currency text check (default_currency in ('USD', 'PHP', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'JPY')),
  payment_terms_days integer not null default 14 check (payment_terms_days between 0 and 365),
  default_payment_instructions text check (char_length(default_payment_instructions) <= 1000),
  footer_note text check (char_length(footer_note) <= 600),
  -- When on, a person who may create invoices but not approve them can only submit; when off they may issue their own.
  approval_required_for_creators boolean not null default true,
  -- Reminders are off until the owner has authorized the exact wording: the switch cannot be on without the record of who authorized what.
  reminders_enabled boolean not null default false,
  reminder_offsets_days integer[] not null default '{-3,0,3,10}' check (cardinality(reminder_offsets_days) <= 8),
  reminder_max integer not null default 4 check (reminder_max between 1 and 8),
  -- Which channels a reminder may go out on. Email unless the owner chooses more: a text message uses the business's prepaid service credits.
  reminder_channels text[] not null default '{email}' check (cardinality(reminder_channels) between 1 and 3 and reminder_channels <@ array['email', 'sms', 'whatsapp']),
  reminders_authorized_by uuid references users(id) on delete set null,
  reminders_authorized_at timestamptz,
  reminders_body_hash text check (reminders_body_hash is null or reminders_body_hash ~ '^[0-9a-f]{64}$'),
  -- What happens to a linked deal when its invoice is fully paid: nothing, a task for the deal's owner, or (only for an invoice a person marked) won.
  close_rule text not null default 'none' check (close_rule in ('none', 'task', 'auto_won')),
  -- Whether a payment somebody recorded by hand counts as verified revenue in the Lead Sources report. Off: it is shown apart.
  count_manual_as_verified boolean not null default false,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  check (not reminders_enabled or (reminders_authorized_at is not null and reminders_body_hash is not null))
);
create trigger customer_invoice_settings_touch before update on customer_invoice_settings for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Provider connections (the client's own account; iAcquire never holds the money)
-- ---------------------------------------------------------------------------

create table customer_payment_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('paymongo', 'paypal', 'simulated')),
  mode text not null check (mode in ('test', 'live')),
  -- Names the connection in its webhook address. Not a secret: a request is trusted by its signature, which is checked against this connection's own secret.
  public_key text not null unique check (public_key ~ '^cpk_[a-z0-9]{20}$'),
  account_label text check (char_length(account_label) <= 120),
  -- AES-GCM sealed JSON (keys and webhook secret). Never readable by the application role, never returned to a browser; null once revoked.
  credentials text,
  -- The provider's own id for the webhook registration, when one was made through its API. An identifier only.
  webhook_ref text check (char_length(webhook_ref) <= 200),
  supported_currencies text[] not null default '{}' check (cardinality(supported_currencies) <= 8),
  status text not null default 'pending_verification' check (status in ('pending_verification', 'connected', 'needs_attention', 'disabled', 'revoked')),
  -- The owner's recorded authorization to use this account, and which wording they saw.
  authorized_by uuid references users(id) on delete set null,
  authorized_at timestamptz,
  authorization_text_version text check (char_length(authorization_text_version) <= 40),
  live_confirmed_at timestamptz,
  live_confirmed_by uuid references users(id) on delete set null,
  last_event_at timestamptz,
  last_checked_at timestamptz,
  last_error text check (char_length(last_error) <= 400),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  check (provider <> 'simulated' or mode = 'test')
);
create unique index customer_payment_connections_live_idx on customer_payment_connections (org_id, provider) where status <> 'revoked';
create trigger customer_payment_connections_touch before update on customer_payment_connections for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

create table customer_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid,
  company_id uuid,
  opportunity_id uuid,
  -- Phase 5A: an invoice made from an accepted proposal says so. Nothing writes this yet.
  source_type text check (source_type is null or source_type in ('proposal')),
  source_id uuid,
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'issued', 'void')),
  -- Derived from the payment rows by a trigger: it can never say paid without payments that add up to the total.
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'partially_paid', 'paid', 'disputed')),
  written_off_at timestamptz,
  written_off_by uuid references users(id) on delete set null,
  write_off_reason text check (char_length(write_off_reason) <= 400),
  -- Null until issued. Assigned from customer_invoice_settings.next_number in the issuing transaction; a voided invoice keeps its number, which is never reused.
  number text check (char_length(number) between 1 and 40),
  currency text not null check (currency in ('USD', 'PHP', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'JPY')),
  tax_inclusive boolean not null default false,
  subtotal_minor bigint not null default 0 check (subtotal_minor between 0 and 9007199254740991),
  tax_minor bigint not null default 0 check (tax_minor between 0 and 9007199254740991),
  total_minor bigint not null default 0 check (total_minor between 0 and 9007199254740991),
  -- Everything received against the invoice (before refunds), and the refunds recorded. Set only by src/server/invoices/apply.ts, and the trigger below
  -- refuses any value the payment and refund rows do not add up to.
  paid_minor bigint not null default 0 check (paid_minor between 0 and 9007199254740991),
  refunded_minor bigint not null default 0 check (refunded_minor between 0 and 9007199254740991),
  balance_minor bigint generated always as (greatest(total_minor - paid_minor, 0)) stored,
  overpaid_minor bigint generated always as (greatest(paid_minor - total_minor, 0)) stored,
  issue_on date,
  due_on date,
  -- The customer's and the business's details as they were when the invoice was issued. They do not follow later edits to the contact or the settings.
  bill_to jsonb not null default '{}'::jsonb check (jsonb_typeof(bill_to) = 'object' and pg_column_size(bill_to) <= 4096),
  bill_from jsonb not null default '{}'::jsonb check (jsonb_typeof(bill_from) = 'object' and pg_column_size(bill_from) <= 4096),
  payment_instructions text check (char_length(payment_instructions) <= 1000),
  notes text check (char_length(notes) <= 2000),
  terms text check (char_length(terms) <= 2000),
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  -- Bumps on every change to a draft. An approval names the version it approved; a changed invoice needs approving again.
  version integer not null default 1 check (version >= 1),
  approved_version integer,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  -- Set by a person for this one invoice: paying it in full may close the linked deal as won, when the owner's close rule allows it.
  closes_deal boolean not null default false,
  public_token_version integer not null default 1 check (public_token_version >= 1),
  -- sha256 of the customer's link token (the token is derived from the invoice id with a server key and never stored). The application role cannot read it.
  public_token_hash text check (public_token_hash is null or public_token_hash ~ '^[0-9a-f]{64}$'),
  first_viewed_at timestamptz,
  issued_at timestamptz,
  issued_by uuid references users(id) on delete set null,
  voided_at timestamptz,
  voided_by uuid references users(id) on delete set null,
  void_reason text check (char_length(void_reason) <= 400),
  -- A workflow that creates a draft names it, so a redelivered event makes one invoice.
  idempotency_key text check (char_length(idempotency_key) <= 120),
  created_by uuid references users(id) on delete set null,
  created_via text not null default 'manual' check (created_via in ('manual', 'workflow', 'deal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  -- Payments carry the invoice's currency in their own foreign key.
  unique (id, org_id, currency),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id),
  foreign key (company_id, org_id) references crm_companies (id, org_id) on delete set null (company_id),
  foreign key (opportunity_id, org_id) references crm_opportunities (id, org_id) on delete set null (opportunity_id),
  check ((source_type is null) = (source_id is null)),
  check (total_minor = subtotal_minor + tax_minor),
  check (refunded_minor <= paid_minor),
  check (due_on is null or issue_on is null or due_on >= issue_on),
  check (approved_version is null or approved_version <= version),
  check (status not in ('issued', 'void') or (number is not null and content_hash is not null and issue_on is not null and due_on is not null and total_minor > 0 and issued_at is not null and approved_version is not null)),
  check (status <> 'void' or (voided_at is not null and paid_minor = 0)),
  check (status in ('issued', 'void') or (paid_minor = 0 and refunded_minor = 0 and payment_status = 'unpaid' and written_off_at is null)),
  check (payment_status <> 'unpaid' or paid_minor = 0),
  check (payment_status <> 'partially_paid' or (paid_minor > 0 and paid_minor < total_minor)),
  check (payment_status <> 'paid' or paid_minor >= total_minor)
);
create unique index customer_invoices_number_idx on customer_invoices (org_id, number) where number is not null;
create unique index customer_invoices_idempotency_idx on customer_invoices (org_id, idempotency_key) where idempotency_key is not null;
-- The customer's page finds its invoice by the hash of the link's token, so that lookup is an index lookup and no two invoices can share a link.
create unique index customer_invoices_token_idx on customer_invoices (public_token_hash) where public_token_hash is not null;
create index customer_invoices_list_idx on customer_invoices (org_id, status, due_on);
create index customer_invoices_created_idx on customer_invoices (org_id, created_at desc);
create index customer_invoices_contact_idx on customer_invoices (org_id, contact_id) where contact_id is not null;
create index customer_invoices_deal_idx on customer_invoices (org_id, opportunity_id) where opportunity_id is not null;
create trigger customer_invoices_touch before update on customer_invoices for each row execute function app.touch_updated_at();

create table customer_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid not null,
  position integer not null check (position between 1 and 100),
  description text not null check (char_length(description) between 1 and 300),
  -- Thousandths of a unit: 1000 is one.
  quantity_milli integer not null check (quantity_milli between 1 and 999999999),
  unit_price_minor bigint not null check (unit_price_minor between 0 and 9007199254740991),
  discount_bps integer check (discount_bps is null or discount_bps between 0 and 10000),
  tax_rate_bps integer check (tax_rate_bps is null or tax_rate_bps between 0 and 10000),
  -- The line as src/lib/money computed it: gross, discount, net (after discount), tax, what the customer pays for the line, and the line without tax.
  gross_minor bigint not null check (gross_minor between 0 and 9007199254740991),
  discount_minor bigint not null check (discount_minor between 0 and 9007199254740991),
  net_minor bigint not null check (net_minor between 0 and 9007199254740991),
  tax_minor bigint not null check (tax_minor between 0 and 9007199254740991),
  total_minor bigint not null check (total_minor between 0 and 9007199254740991),
  ex_tax_minor bigint not null check (ex_tax_minor between 0 and 9007199254740991),
  created_at timestamptz not null default now(),
  unique (invoice_id, position),
  foreign key (invoice_id, org_id) references customer_invoices (id, org_id) on delete cascade,
  check (net_minor = gross_minor - discount_minor),
  check (total_minor = ex_tax_minor + tax_minor)
);

-- What happened to an invoice, by whom. Append-only (a purge of a departed client can still delete). The set of kinds grows in code; the database guards the shape.
create table customer_invoice_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid not null,
  at timestamptz not null default now(),
  kind text not null check (kind ~ '^[a-z][a-z_]{2,39}$'),
  actor_kind text not null default 'user' check (actor_kind in ('user', 'system', 'provider', 'workflow', 'customer')),
  actor_id uuid references users(id) on delete set null,
  -- Ids, numbers, amounts and short labels. Never a customer's name or contact details, a card, a key or a message. The one free-text exception is the reason a person
  -- typed for requesting changes, voiding or writing off, which is the business's own note.
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048),
  foreign key (invoice_id, org_id) references customer_invoices (id, org_id) on delete cascade
);
create index customer_invoice_events_invoice_idx on customer_invoice_events (invoice_id, id);
-- A close rule acts once per invoice.
create unique index customer_invoice_events_close_rule_idx on customer_invoice_events (invoice_id) where kind = 'close_rule_applied';

create table customer_invoice_reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid not null,
  -- before_due:-3, on_due:0, after_due:3: one reminder per step per invoice.
  step_key text not null check (step_key ~ '^[a-z_]{3,20}:-?[0-9]{1,3}$'),
  due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'queued', 'blocked', 'skipped', 'cancelled')),
  reason text check (char_length(reason) <= 200),
  message_id uuid references conversation_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invoice_id, step_key),
  foreign key (invoice_id, org_id) references customer_invoices (id, org_id) on delete cascade
);
create index customer_invoice_reminders_due_idx on customer_invoice_reminders (due_at) where status = 'scheduled';
create trigger customer_invoice_reminders_touch before update on customer_invoice_reminders for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Payment attempts, payments, refunds, webhook receipts
-- ---------------------------------------------------------------------------

create table customer_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid not null,
  connection_id uuid not null,
  currency text not null check (currency in ('USD', 'PHP', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'JPY')),
  -- Always the invoice's balance as the server computed it when the attempt was made; never an amount a browser sent.
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 9007199254740991),
  -- Unguessable; the provider echoes it, and a webhook is matched to its attempt by it AND by the provider's checkout id.
  reference text not null unique check (reference ~ '^CP-[A-Za-z0-9]{20,40}$'),
  provider_checkout_id text check (char_length(provider_checkout_id) <= 120),
  -- The provider-hosted page. Not readable by the application role: the payer gets it from the pay page.
  checkout_url text check (checkout_url is null or (checkout_url ~* '^https://' and char_length(checkout_url) <= 1000)),
  status text not null default 'created' check (status in ('created', 'redirected', 'succeeded', 'failed', 'expired', 'cancelled', 'needs_review')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (invoice_id, org_id, currency) references customer_invoices (id, org_id, currency),
  foreign key (connection_id, org_id) references customer_payment_connections (id, org_id)
);
-- One open attempt per invoice: a double click or a second tab finds the same checkout.
create unique index customer_payment_attempts_open_idx on customer_payment_attempts (invoice_id) where status in ('created', 'redirected');
create index customer_payment_attempts_invoice_idx on customer_payment_attempts (invoice_id, created_at desc);
-- A webhook names the provider's checkout; it is matched to its attempt through the connection's own checkouts.
create index customer_payment_attempts_checkout_idx on customer_payment_attempts (connection_id, provider_checkout_id) where provider_checkout_id is not null;
create trigger customer_payment_attempts_touch before update on customer_payment_attempts for each row execute function app.touch_updated_at();

create table customer_payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid not null,
  connection_id uuid,
  attempt_id uuid,
  provider text not null check (provider in ('paymongo', 'paypal', 'simulated', 'manual')),
  provider_payment_id text check (char_length(provider_payment_id) between 1 and 120),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 9007199254740991),
  fee_minor bigint check (fee_minor is null or (fee_minor >= 0 and fee_minor <= 9007199254740991)),
  -- The part of the payment that is the invoice's tax, in proportion, worked out once when the payment was recorded. Revenue leaves it out.
  tax_portion_minor bigint not null default 0 check (tax_portion_minor >= 0 and tax_portion_minor <= amount_minor),
  currency text not null check (currency in ('USD', 'PHP', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'JPY')),
  -- false for a provider's test mode. A payment somebody recorded by hand is a real-world record: true.
  livemode boolean not null,
  -- provider_confirmed: the provider said so in a verified event (or an authenticated read). manual: a person recorded it, with their evidence.
  verification text not null check (verification in ('provider_confirmed', 'manual')),
  method text check (char_length(method) <= 40),
  status text not null default 'succeeded' check (status in ('succeeded', 'pending', 'failed', 'needs_review', 'partially_refunded', 'refunded', 'disputed')),
  received_at timestamptz not null,
  recorded_by uuid references users(id) on delete set null,
  evidence text check (char_length(evidence) <= 600),
  idempotency_key text check (char_length(idempotency_key) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (id, invoice_id, org_id, currency),
  unique (connection_id, provider_payment_id),
  foreign key (invoice_id, org_id, currency) references customer_invoices (id, org_id, currency),
  foreign key (connection_id, org_id) references customer_payment_connections (id, org_id),
  foreign key (attempt_id, org_id) references customer_payment_attempts (id, org_id),
  check ((verification = 'manual') = (provider = 'manual')),
  check ((provider = 'manual') = (connection_id is null)),
  check (provider = 'manual' or provider_payment_id is not null),
  check (provider <> 'manual' or livemode),
  check (verification <> 'manual' or coalesce(char_length(evidence), 0) >= 3)
);
create unique index customer_payments_idempotency_idx on customer_payments (org_id, idempotency_key) where idempotency_key is not null;
create index customer_payments_invoice_idx on customer_payments (invoice_id, received_at);
create index customer_payments_org_idx on customer_payments (org_id, received_at desc);
create trigger customer_payments_touch before update on customer_payments for each row execute function app.touch_updated_at();

create table customer_refunds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  payment_id uuid not null,
  invoice_id uuid not null,
  currency text not null check (currency in ('USD', 'PHP', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'JPY')),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 9007199254740991),
  tax_portion_minor bigint not null default 0 check (tax_portion_minor >= 0 and tax_portion_minor <= amount_minor),
  status text not null default 'succeeded' check (status in ('pending', 'succeeded', 'failed')),
  -- manual_record: a person says the refund was made in the provider's dashboard (this release moves no money). provider_event: a verified event said so.
  source text not null check (source in ('provider_event', 'manual_record', 'chargeback', 'api_initiated')),
  provider_refund_id text check (char_length(provider_refund_id) between 1 and 120),
  reason text not null check (char_length(reason) between 3 and 400),
  recorded_by uuid references users(id) on delete set null,
  idempotency_key text check (char_length(idempotency_key) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payment_id, provider_refund_id),
  foreign key (payment_id, invoice_id, org_id, currency) references customer_payments (id, invoice_id, org_id, currency)
);
create unique index customer_refunds_idempotency_idx on customer_refunds (org_id, idempotency_key) where idempotency_key is not null;
create index customer_refunds_invoice_idx on customer_refunds (invoice_id, created_at);
create trigger customer_refunds_touch before update on customer_refunds for each row execute function app.touch_updated_at();

-- The durable receipt of every webhook a connection received. Written before anything is processed, so a failure while processing leaves a row to retry from.
-- No raw body is kept: its sha256 and the normalized facts only.
create table customer_payment_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  connection_id uuid not null,
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 200),
  event_type text not null check (char_length(event_type) between 1 and 120),
  livemode boolean,
  outcome text not null default 'received' check (outcome in ('received', 'processed', 'duplicate', 'ignored', 'rejected', 'error', 'deferred')),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048),
  attempts integer not null default 0 check (attempts >= 0),
  payload_sha256 text check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (connection_id, provider_event_id),
  foreign key (connection_id, org_id) references customer_payment_connections (id, org_id)
);
create index customer_payment_events_open_idx on customer_payment_events (received_at) where outcome in ('received', 'deferred', 'error');

-- ---------------------------------------------------------------------------
-- Guards: the rules the database keeps whatever the code does
-- ---------------------------------------------------------------------------

-- A purge of a departed client's data declares itself with iaq.purge (see offboarding); nothing else can delete a financial row.

create or replace function app.customer_invoice_guard() returns trigger
language plpgsql as $$
declare
  line_count integer;
  line_subtotal bigint;
  line_tax bigint;
  line_total bigint;
  paid bigint;
  refunded bigint;
  disputed boolean;
  expected text;
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or current_setting('iaq.purge', true) = 'on' then
      return old;
    end if;
    raise exception 'An invoice that has left draft cannot be deleted' using errcode = '42501';
  end if;
  -- The people columns are foreign keys that go to null when a user is deleted; they never change to anyone else.
  if new.id <> old.id or new.org_id <> old.org_id or new.created_at <> old.created_at or (new.created_by is distinct from old.created_by and new.created_by is not null)
     or new.created_via <> old.created_via or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'The identity of an invoice never changes' using errcode = '42501';
  end if;
  if new.status <> old.status and not (
       (old.status = 'draft' and new.status in ('pending_approval', 'issued'))
    or (old.status = 'pending_approval' and new.status in ('draft', 'issued'))
    or (old.status = 'issued' and new.status = 'void')) then
    raise exception 'An invoice cannot go from % to %', old.status, new.status using errcode = '42501';
  end if;
  -- Submitting or issuing: the totals are exactly the sum of the lines, and there is at least one line.
  if new.status in ('pending_approval', 'issued') and new.status <> old.status then
    select count(*), coalesce(sum(ex_tax_minor), 0), coalesce(sum(tax_minor), 0), coalesce(sum(total_minor), 0)
      into line_count, line_subtotal, line_tax, line_total
      from customer_invoice_lines where invoice_id = new.id and org_id = new.org_id;
    if line_count = 0 or line_subtotal <> new.subtotal_minor or line_tax <> new.tax_minor or line_total <> new.total_minor then
      raise exception 'The invoice totals must equal the sum of its lines' using errcode = '23514';
    end if;
  end if;
  if old.status = 'draft' then
    return new;
  end if;
  -- Issuing sets the number, the snapshots, the hash and the dates.
  if new.status = 'issued' and old.status <> 'issued' then
    return new;
  end if;
  -- Past this point the invoice was already submitted, issued or void: what it says is frozen.
  if new.currency <> old.currency or new.tax_inclusive <> old.tax_inclusive
     or new.subtotal_minor <> old.subtotal_minor or new.tax_minor <> old.tax_minor or new.total_minor <> old.total_minor
     or new.issue_on is distinct from old.issue_on or new.due_on is distinct from old.due_on
     or new.payment_instructions is distinct from old.payment_instructions or new.notes is distinct from old.notes or new.terms is distinct from old.terms
     or new.bill_from is distinct from old.bill_from or new.number is distinct from old.number or new.content_hash is distinct from old.content_hash
     or new.version <> old.version or new.closes_deal <> old.closes_deal
     or new.source_type is distinct from old.source_type or new.source_id is distinct from old.source_id
     or new.issued_at is distinct from old.issued_at or (new.issued_by is distinct from old.issued_by and new.issued_by is not null)
     or new.approved_version is distinct from old.approved_version or (new.approved_by is distinct from old.approved_by and new.approved_by is not null)
     or new.approved_at is distinct from old.approved_at then
    raise exception 'This invoice has left draft: its amounts, dates, wording and number can no longer change' using errcode = '42501';
  end if;
  -- The customer's details may be erased on a privacy request, and only to the erased form; they are never rewritten to other content.
  if new.bill_to is distinct from old.bill_to and new.bill_to <> '{"erased": true}'::jsonb then
    raise exception 'The customer details on an issued invoice can only be erased, not rewritten' using errcode = '42501';
  end if;
  if (new.voided_at is distinct from old.voided_at or (new.voided_by is distinct from old.voided_by and new.voided_by is not null) or new.void_reason is distinct from old.void_reason)
     and not (old.status = 'issued' and new.status = 'void') then
    raise exception 'Only voiding an issued invoice records a void' using errcode = '42501';
  end if;
  if (new.written_off_at is distinct from old.written_off_at or (new.written_off_by is distinct from old.written_off_by and new.written_off_by is not null)
      or new.write_off_reason is distinct from old.write_off_reason)
     and (old.status <> 'issued' or old.written_off_at is not null) then
    raise exception 'A write-off applies to an issued invoice, once, and is final' using errcode = '42501';
  end if;
  if new.paid_minor <> old.paid_minor or new.refunded_minor <> old.refunded_minor or new.payment_status <> old.payment_status then
    if old.status <> 'issued' or new.status <> 'issued' then
      raise exception 'Payments apply only to an issued invoice' using errcode = '42501';
    end if;
    select coalesce(sum(amount_minor), 0) into paid from customer_payments
      where invoice_id = new.id and org_id = new.org_id and status in ('succeeded', 'partially_refunded', 'refunded', 'disputed');
    select coalesce(sum(amount_minor), 0) into refunded from customer_refunds
      where invoice_id = new.id and org_id = new.org_id and status = 'succeeded';
    select exists (select 1 from customer_payments where invoice_id = new.id and org_id = new.org_id and status = 'disputed') into disputed;
    expected := case when disputed then 'disputed' when paid >= new.total_minor then 'paid' when paid > 0 then 'partially_paid' else 'unpaid' end;
    if new.paid_minor <> paid or new.refunded_minor <> refunded or new.payment_status <> expected then
      raise exception 'The paid amount and status of an invoice must equal what its payments and refunds add up to' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger customer_invoices_guard before update or delete on customer_invoices for each row execute function app.customer_invoice_guard();

create or replace function app.customer_invoice_line_guard() returns trigger
language plpgsql as $$
declare
  st text;
begin
  if tg_op = 'DELETE' then
    if current_setting('iaq.purge', true) = 'on' then
      return old;
    end if;
    select status into st from customer_invoices where id = old.invoice_id and org_id = old.org_id;
    -- No parent row: the draft itself is being deleted and this is the cascade.
    if st is null or st = 'draft' then
      return old;
    end if;
    raise exception 'The lines of an invoice can be changed only while it is a draft' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.invoice_id <> old.invoice_id or new.org_id <> old.org_id) then
    raise exception 'A line never moves to another invoice' using errcode = '42501';
  end if;
  select status into st from customer_invoices where id = new.invoice_id and org_id = new.org_id;
  if st is distinct from 'draft' then
    raise exception 'The lines of an invoice can be changed only while it is a draft' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger customer_invoice_lines_guard before insert or update or delete on customer_invoice_lines for each row execute function app.customer_invoice_line_guard();

-- Events cannot be edited. They go with their invoice when a draft is discarded (the parent row is already gone then), and with a purge.
create or replace function app.customer_invoice_event_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and (current_setting('iaq.purge', true) = 'on'
     or not exists (select 1 from customer_invoices where id = old.invoice_id and org_id = old.org_id)) then
    return old;
  end if;
  raise exception 'customer_invoice_events rows are append-only' using errcode = '42501';
end $$;
create trigger customer_invoice_events_guard before update or delete on customer_invoice_events for each row execute function app.customer_invoice_event_guard();

-- A payment's amount, currency, invoice, source and time never change after it is recorded; only its status moves, and a failed payment stays failed.
create or replace function app.customer_payment_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('iaq.purge', true) = 'on' then
      return old;
    end if;
    raise exception 'customer_payments rows are never deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.org_id <> old.org_id or new.invoice_id <> old.invoice_id or new.connection_id is distinct from old.connection_id or new.attempt_id is distinct from old.attempt_id
     or new.provider <> old.provider or new.provider_payment_id is distinct from old.provider_payment_id or new.amount_minor <> old.amount_minor
     or new.tax_portion_minor <> old.tax_portion_minor or new.currency <> old.currency or new.livemode <> old.livemode or new.verification <> old.verification
     or new.received_at <> old.received_at or (new.recorded_by is distinct from old.recorded_by and new.recorded_by is not null) or new.evidence is distinct from old.evidence
     or new.idempotency_key is distinct from old.idempotency_key or new.created_at <> old.created_at then
    raise exception 'A recorded payment cannot be changed, only its status can move' using errcode = '42501';
  end if;
  if new.status <> old.status and not (
       (old.status = 'pending' and new.status in ('succeeded', 'failed', 'needs_review'))
    or (old.status = 'needs_review' and new.status in ('succeeded', 'failed'))
    or (old.status = 'succeeded' and new.status in ('partially_refunded', 'refunded', 'disputed'))
    or (old.status = 'partially_refunded' and new.status in ('refunded', 'disputed'))
    or (old.status = 'disputed' and new.status in ('succeeded', 'partially_refunded', 'refunded'))) then
    raise exception 'A % payment cannot become %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;
create trigger customer_payments_guard before update or delete on customer_payments for each row execute function app.customer_payment_guard();

-- A checkout attempt asked for one amount, in one currency, for one invoice, through one connection, under one reference: none of that changes afterwards, and a
-- finished attempt stays finished (a late event cannot revive an expired or cancelled one).
create or replace function app.customer_payment_attempt_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('iaq.purge', true) = 'on' then
      return old;
    end if;
    raise exception 'customer_payment_attempts rows are never deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.org_id <> old.org_id or new.invoice_id <> old.invoice_id or new.connection_id <> old.connection_id or new.currency <> old.currency
     or new.amount_minor <> old.amount_minor or new.reference <> old.reference or new.created_at <> old.created_at then
    raise exception 'A payment attempt cannot be changed, only its status can move' using errcode = '42501';
  end if;
  if new.status <> old.status and not (
       (old.status = 'created' and new.status in ('redirected', 'succeeded', 'failed', 'expired', 'cancelled', 'needs_review'))
    or (old.status = 'redirected' and new.status in ('succeeded', 'failed', 'expired', 'cancelled', 'needs_review'))
    or (old.status = 'needs_review' and new.status in ('succeeded', 'failed', 'cancelled'))) then
    raise exception 'A % payment attempt cannot become %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;
create trigger customer_payment_attempts_guard before update or delete on customer_payment_attempts for each row execute function app.customer_payment_attempt_guard();

-- A webhook receipt keeps what it received (the event, the connection, the fingerprint of the body, when); only its outcome and attempt count move.
create or replace function app.customer_payment_event_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('iaq.purge', true) = 'on' then
      return old;
    end if;
    raise exception 'customer_payment_events rows are never deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.org_id <> old.org_id or new.connection_id <> old.connection_id or new.provider_event_id <> old.provider_event_id or new.event_type <> old.event_type
     or new.payload_sha256 is distinct from old.payload_sha256 or new.received_at <> old.received_at then
    raise exception 'A webhook receipt cannot be changed, only its outcome can move' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger customer_payment_events_guard before update or delete on customer_payment_events for each row execute function app.customer_payment_event_guard();

-- A refund names a payment that counts, and the refunds of one payment never add up to more than it. The payment row is locked first, so two refunds recorded
-- at the same moment cannot both fit.
create or replace function app.customer_refund_guard() returns trigger
language plpgsql as $$
declare
  pay customer_payments;
  others bigint;
begin
  if tg_op = 'DELETE' then
    if current_setting('iaq.purge', true) = 'on' then
      return old;
    end if;
    raise exception 'customer_refunds rows are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.org_id <> old.org_id or new.payment_id <> old.payment_id or new.invoice_id <> old.invoice_id or new.amount_minor <> old.amount_minor
       or new.currency <> old.currency or new.source <> old.source or new.provider_refund_id is distinct from old.provider_refund_id or new.reason <> old.reason
       or (new.recorded_by is distinct from old.recorded_by and new.recorded_by is not null) or new.created_at <> old.created_at then
      raise exception 'A recorded refund cannot be changed, only its status can move' using errcode = '42501';
    end if;
    if old.status <> 'pending' and new.status <> old.status then
      raise exception 'A % refund stays %', old.status, old.status using errcode = '42501';
    end if;
  end if;
  select * into pay from customer_payments where id = new.payment_id and org_id = new.org_id for update;
  if tg_op = 'INSERT' and pay.status not in ('succeeded', 'partially_refunded', 'disputed', 'refunded') then
    raise exception 'Only a payment that was received can be refunded' using errcode = '23514';
  end if;
  if new.status = 'succeeded' then
    select coalesce(sum(amount_minor), 0) into others from customer_refunds
      where payment_id = new.payment_id and org_id = new.org_id and status = 'succeeded' and id <> new.id;
    if others + new.amount_minor > pay.amount_minor then
      raise exception 'The refunds of a payment cannot add up to more than the payment' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger customer_refunds_guard before insert or update or delete on customer_refunds for each row execute function app.customer_refund_guard();

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in member's access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table customer_invoice_settings enable row level security;
alter table customer_payment_connections enable row level security;
alter table customer_invoices enable row level security;
alter table customer_invoice_lines enable row level security;
alter table customer_invoice_events enable row level security;
alter table customer_invoice_reminders enable row level security;
alter table customer_payment_attempts enable row level security;
alter table customer_payments enable row level security;
alter table customer_refunds enable row level security;
alter table customer_payment_events enable row level security;

revoke all on customer_invoice_settings, customer_payment_connections, customer_invoices, customer_invoice_lines, customer_invoice_events, customer_invoice_reminders,
  customer_payment_attempts, customer_payments, customer_refunds, customer_payment_events from public, anon, authenticated;
-- The webhook receipts are server-only: no grant at all.
grant select on customer_invoice_settings, customer_invoice_lines, customer_invoice_events, customer_invoice_reminders, customer_payments, customer_refunds to iaq_app_user;
-- An invoice is readable except its link hash.
grant select (id, org_id, contact_id, company_id, opportunity_id, source_type, source_id, status, payment_status, written_off_at, written_off_by, write_off_reason, number, currency,
  tax_inclusive, subtotal_minor, tax_minor, total_minor, paid_minor, refunded_minor, balance_minor, overpaid_minor, issue_on, due_on, bill_to, bill_from, payment_instructions, notes,
  terms, content_hash, version, approved_version, approved_by, approved_at, closes_deal, public_token_version, first_viewed_at, issued_at, issued_by, voided_at, voided_by,
  void_reason, idempotency_key, created_by, created_via, created_at, updated_at) on customer_invoices to iaq_app_user;
-- A connection is readable except its credentials.
grant select (id, org_id, provider, mode, public_key, account_label, webhook_ref, supported_currencies, status, authorized_by, authorized_at, authorization_text_version, live_confirmed_at,
  live_confirmed_by, last_event_at, last_checked_at, last_error, created_by, created_at, updated_at) on customer_payment_connections to iaq_app_user;
-- An attempt is readable except the provider's checkout address.
grant select (id, org_id, invoice_id, connection_id, currency, amount_minor, reference, provider_checkout_id, status, expires_at, created_at, updated_at) on customer_payment_attempts to iaq_app_user;

create policy customer_invoice_settings_select on customer_invoice_settings for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('invoices.view'::text))::uuid[]));
create policy customer_invoices_select on customer_invoices for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('invoices.view'::text))::uuid[]));
create policy customer_invoice_lines_select on customer_invoice_lines for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('invoices.view'::text))::uuid[]));
create policy customer_invoice_events_select on customer_invoice_events for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('invoices.view'::text))::uuid[]));
create policy customer_invoice_reminders_select on customer_invoice_reminders for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('invoices.view'::text))::uuid[]));
create policy customer_payment_attempts_select on customer_payment_attempts for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('invoices.view'::text))::uuid[]));
create policy customer_payments_select on customer_payments for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('invoices.view'::text))::uuid[]));
create policy customer_refunds_select on customer_refunds for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('invoices.view'::text))::uuid[]));
create policy customer_payment_connections_select on customer_payment_connections for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('invoices.connect_payments'::text))::uuid[]));

-- ---------------------------------------------------------------------------
-- Notification kinds and the message scope
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
  kinds := array(select distinct k from unnest(kinds || array['invoice_approval_requested', 'invoice_approval_decided', 'invoice_paid', 'invoice_payment_failed', 'invoice_overdue', 'invoice_refund_recorded', 'payment_connection_attention', 'payment_review_needed']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- An invoice reminder is its own kind of message: a service message about a bill the customer already has, not a reply or a sales follow-up. The live list is read
-- back and 'billing' is added at the end, in the order the list already has, so the rollback restores it exactly.
do $$
declare
  def text;
  scopes text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'conversation_messages_scope_check' and c.conrelid = 'conversation_messages'::regclass;
  if def is null then
    raise exception 'conversation_messages_scope_check not found; cannot add the billing scope';
  end if;
  scopes := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
  if scopes is null or cardinality(scopes) < 5 then
    raise exception 'could not read the current message scopes from conversation_messages_scope_check (read %); refusing to rewrite it', coalesce(cardinality(scopes), 0);
  end if;
  if not ('billing' = any(scopes)) then
    scopes := scopes || array['billing'];
  end if;
  alter table conversation_messages drop constraint conversation_messages_scope_check;
  execute 'alter table conversation_messages add constraint conversation_messages_scope_check check (scope in (' || (select string_agg(quote_literal(k), ', ' order by o) from unnest(scopes) with ordinality as t(k, o)) || '))';
end $$;
