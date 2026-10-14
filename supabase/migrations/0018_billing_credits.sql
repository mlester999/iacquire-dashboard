-- Prepaid service credits, metered usage, payments (PayMongo) and provider fees.
-- Money is stored as integer micro-dollars (1 USD = 1,000,000) so fractional-cent provider costs stay exact.
-- The ledger is authoritative and append-only; credit_accounts is a cache updated in the same
-- transaction and checked by a reconciliation function. All writes go through trusted server code.

-- ---------------------------------------------------------------------------
-- Notifications: deduplication and the event kinds used across billing, messaging, websites and operations
-- ---------------------------------------------------------------------------

alter table notifications add column dedupe_key text check (char_length(dedupe_key) <= 160);
create unique index notifications_dedupe_idx on notifications (user_id, dedupe_key) where dedupe_key is not null;

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'agent_task_completed', 'lead_awaiting_approval', 'booking_confirmed', 'workflow_failure',
  'knowledge_update_ready', 'support_reply', 'support_ticket_created', 'integration_disconnected',
  'usage_limit_approaching', 'approval_requested', 'approval_decided', 'agent_status', 'system',
  'setup_milestone', 'setup_action_required', 'setup_issue', 'setup_ready',
  'project_submitted', 'project_update', 'project_quote', 'project_decision', 'project_message',
  'maintenance_update',
  'billing_payment_received', 'billing_payment_failed', 'billing_low_balance', 'billing_credits_exhausted',
  'billing_budget_warning', 'billing_reconciliation',
  'escalation_action_required', 'escalation_fyi', 'escalation_claimed', 'escalation_unclaimed',
  'message_blocked', 'message_failed',
  'website_published', 'website_publish_failed', 'domain_verified', 'domain_renewal_due', 'domain_issue',
  'incident_opened', 'incident_recovered', 'integration_reconnect_required', 'account_inactivity_notice'));

-- ---------------------------------------------------------------------------
-- Agency-wide billing configuration
-- ---------------------------------------------------------------------------

create table agency_billing_settings (
  singleton boolean primary key default true check (singleton),
  -- PayMongo hosted checkout charges in PHP. Prices are set in USD, so a rate and its source must be recorded.
  usd_php_rate numeric(12, 6) check (usd_php_rate > 0),
  fx_source text check (char_length(fx_source) <= 200),
  fx_updated_at timestamptz,
  fx_updated_by uuid references users(id) on delete set null,
  topup_min_usd integer not null default 10 check (topup_min_usd >= 1),
  topup_max_usd integer not null default 2000 check (topup_max_usd >= topup_min_usd),
  -- Live (real-money) checkout stays blocked until someone confirms the provider and the legal/tax
  -- treatment of prepaid credits have been reviewed.
  live_payments_review_at timestamptz,
  live_payments_review_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into agency_billing_settings default values;

-- Rate versions are immutable. markup_bps is basis points of wholesale: 13000 = wholesale x 1.30.
create table usage_rate_versions (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version > 0),
  markup_bps integer not null check (markup_bps between 10000 and 50000),
  effective_at timestamptz not null default now(),
  notes text not null default '' check (char_length(notes) <= 1000),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
insert into usage_rate_versions (version, markup_bps, notes)
  values (1, 13000, 'Approved model: eligible provider wholesale consumption x 1.30. Fixed provider fees, taxes and processing charges are not marked up.');

create or replace function app.immutable_row() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;
create trigger usage_rate_versions_immutable before update or delete on usage_rate_versions for each row execute function app.immutable_row();

-- Client-facing unit rates, published only once the agency has measured provider costs. Empty by default.
create table usage_unit_rates (
  id uuid primary key default gen_random_uuid(),
  rate_version_id uuid not null references usage_rate_versions(id),
  provider text not null check (char_length(provider) between 1 and 60),
  unit_type text not null check (char_length(unit_type) between 1 and 60),
  unit_label text not null check (char_length(unit_label) between 1 and 80),
  wholesale_micros_per_unit numeric(20, 6) not null check (wholesale_micros_per_unit >= 0),
  client_micros_per_unit numeric(20, 6) not null check (client_micros_per_unit >= wholesale_micros_per_unit),
  note text check (char_length(note) <= 300),
  published_at timestamptz not null default now(),
  unique (rate_version_id, provider, unit_type)
);

-- ---------------------------------------------------------------------------
-- Per-organization accounts, budgets and the ledger
-- ---------------------------------------------------------------------------

create table credit_accounts (
  org_id uuid primary key references organizations(id) on delete cascade,
  balance_micros bigint not null default 0 check (balance_micros >= 0),
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  updated_at timestamptz not null default now(),
  -- Reservations can never exceed what the client actually holds.
  check (reserved_micros <= balance_micros)
);

create table billing_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  monthly_budget_micros bigint check (monthly_budget_micros > 0),
  warn_at_percent integer not null default 80 check (warn_at_percent between 1 and 100),
  hard_stop boolean not null default true,
  low_balance_micros bigint not null default 5000000 check (low_balance_micros >= 0),
  -- Auto-recharge is off and stays off until PayMongo's saved-payment capability is verified on the live account.
  auto_recharge_enabled boolean not null default false check (auto_recharge_enabled = false),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table credit_ledger_entries (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in (
    'payment_initiated', 'payment_confirmed', 'credits_granted', 'reservation_held', 'reservation_released',
    'usage_consumed', 'refund', 'reversal', 'adjustment', 'reconciliation')),
  delta_micros bigint not null default 0,
  reserved_delta_micros bigint not null default 0,
  balance_after_micros bigint not null check (balance_after_micros >= 0),
  reserved_after_micros bigint not null check (reserved_after_micros >= 0),
  reference_type text check (char_length(reference_type) <= 40),
  reference_id text check (char_length(reference_id) <= 120),
  idempotency_key text check (char_length(idempotency_key) between 8 and 160),
  memo text check (char_length(memo) <= 500),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, idempotency_key),
  check (kind not in ('payment_initiated', 'payment_confirmed') or (delta_micros = 0 and reserved_delta_micros = 0)),
  check (kind <> 'credits_granted' or (delta_micros > 0 and reserved_delta_micros = 0)),
  check (kind <> 'reservation_held' or (delta_micros = 0 and reserved_delta_micros > 0)),
  check (kind <> 'reservation_released' or (delta_micros = 0 and reserved_delta_micros < 0)),
  check (kind <> 'usage_consumed' or (delta_micros <= 0 and reserved_delta_micros = 0))
);
create index credit_ledger_org_idx on credit_ledger_entries (org_id, id desc);
create trigger credit_ledger_immutable before update or delete on credit_ledger_entries for each row execute function app.immutable_row();

-- ---------------------------------------------------------------------------
-- Payments and webhook receipts
-- ---------------------------------------------------------------------------

create table payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('setup_fee', 'credit_topup', 'maintenance', 'custom_project', 'domain', 'other')),
  status text not null default 'pending' check (status in (
    'pending', 'paid', 'failed', 'expired', 'cancelled', 'mismatch', 'refunded', 'partially_refunded', 'disputed')),
  description text not null check (char_length(description) between 1 and 200),
  usd_amount_micros bigint not null check (usd_amount_micros > 0),
  charged_currency text not null check (charged_currency ~ '^[A-Z]{3}$'),
  charged_amount_minor bigint not null check (charged_amount_minor > 0),
  fx_rate numeric(12, 6),
  fx_source text check (char_length(fx_source) <= 200),
  fx_at timestamptz,
  provider text not null default 'paymongo' check (provider = 'paymongo'),
  livemode boolean not null,
  reference_number text not null unique check (char_length(reference_number) between 8 and 60),
  provider_checkout_id text,
  provider_payment_id text,
  checkout_url text check (checkout_url ~ '^https://'),
  fee_minor bigint check (fee_minor >= 0),
  credits_micros bigint check (credits_micros > 0),
  refunded_micros bigint not null default 0 check (refunded_micros >= 0),
  failure_reason text check (char_length(failure_reason) <= 300),
  paid_at timestamptz,
  requested_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_checkout_id),
  unique (provider, provider_payment_id),
  check ((kind = 'credit_topup') = (credits_micros is not null)),
  check (status not in ('paid', 'refunded', 'partially_refunded') or paid_at is not null)
);
create index payments_org_idx on payments (org_id, created_at desc);
create trigger payments_touch before update on payments for each row execute function app.touch_updated_at();

-- One row per provider event id. Replays and PayMongo retries find the row and do nothing.
create table payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'paymongo',
  provider_event_id text not null,
  event_type text not null check (char_length(event_type) <= 80),
  livemode boolean,
  payment_id uuid references payments(id) on delete set null,
  outcome text not null default 'received' check (outcome in ('received', 'processed', 'ignored', 'rejected', 'error')),
  detail text check (char_length(detail) <= 300),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id)
);

-- ---------------------------------------------------------------------------
-- Reservations and metered usage
-- ---------------------------------------------------------------------------

create table usage_reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  purpose text not null check (char_length(purpose) between 1 and 120),
  job_reference text check (char_length(job_reference) <= 160),
  estimated_micros bigint not null check (estimated_micros > 0),
  settled_micros bigint check (settled_micros >= 0),
  status text not null default 'held' check (status in ('held', 'settled', 'released', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (org_id, job_reference),
  check ((status = 'held') = (resolved_at is null))
);
create index usage_reservations_open_idx on usage_reservations (expires_at) where status = 'held';

create table metered_usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 60),
  unit_type text not null check (unit_type in (
    'ai_tokens_in', 'ai_tokens_out', 'ai_research_call', 'sms_segment', 'whatsapp_message', 'email_send',
    'premium_api_call', 'automation_execution', 'other')),
  quantity numeric(20, 6) not null check (quantity >= 0),
  wholesale_micros bigint not null check (wholesale_micros >= 0),
  rate_version_id uuid not null references usage_rate_versions(id),
  markup_bps integer not null check (markup_bps >= 10000),
  client_micros bigint not null check (client_micros >= 0),
  charged_micros bigint not null default 0 check (charged_micros >= 0),
  -- What could not be collected because credits ran out. Visible to the agency for reconciliation.
  uncollected_micros bigint not null default 0 check (uncollected_micros >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  fx_rate numeric(12, 6),
  fx_source text check (char_length(fx_source) <= 200),
  fx_at timestamptz,
  provider_reference text check (char_length(provider_reference) <= 160),
  job_reference text check (char_length(job_reference) <= 160),
  message_id uuid,
  reservation_id uuid references usage_reservations(id),
  billing_status text not null default 'settled' check (billing_status in ('settled', 'partially_collected', 'uncollected', 'waived', 'refunded')),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (charged_micros + uncollected_micros = client_micros),
  unique (org_id, provider, provider_reference)
);
create index metered_usage_org_idx on metered_usage_events (org_id, occurred_at desc);

-- Fixed provider charges (number rental, registration, domains). Disclosed, approved by the client,
-- and billed at cost: they are never part of the metered markup.
create table provider_fees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 60),
  kind text not null check (kind in ('number_rental', 'sender_registration', 'whatsapp_connection', 'domain', 'other')),
  description text not null check (char_length(description) between 1 and 200),
  amount_micros bigint not null check (amount_micros > 0),
  recurrence text not null default 'one_time' check (recurrence in ('one_time', 'monthly', 'annual')),
  status text not null default 'disclosed' check (status in ('disclosed', 'approved', 'billed', 'waived', 'cancelled')),
  next_due_at timestamptz,
  disclosed_at timestamptz not null default now(),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (status not in ('approved', 'billed') or approved_at is not null)
);
create index provider_fees_org_idx on provider_fees (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Reconciliation: does the ledger add up to the cached account?
-- ---------------------------------------------------------------------------

create or replace function app.credit_reconciliation(p_org uuid)
returns table (balance_micros bigint, ledger_balance_micros bigint, reserved_micros bigint, ledger_reserved_micros bigint, consistent boolean)
language sql stable set search_path = public, pg_temp
as $$
  select a.balance_micros, coalesce(sum(l.delta_micros), 0)::bigint, a.reserved_micros, coalesce(sum(l.reserved_delta_micros), 0)::bigint,
         a.balance_micros = coalesce(sum(l.delta_micros), 0) and a.reserved_micros = coalesce(sum(l.reserved_delta_micros), 0)
  from credit_accounts a left join credit_ledger_entries l on l.org_id = a.org_id
  where a.org_id = p_org group by a.org_id, a.balance_micros, a.reserved_micros
$$;

-- ---------------------------------------------------------------------------
-- Row level security. Clients read; only server code writes.
-- ---------------------------------------------------------------------------

alter table agency_billing_settings enable row level security;
alter table usage_rate_versions enable row level security;
alter table usage_unit_rates enable row level security;
alter table credit_accounts enable row level security;
alter table billing_settings enable row level security;
alter table credit_ledger_entries enable row level security;
alter table payments enable row level security;
alter table payment_webhook_events enable row level security;
alter table usage_reservations enable row level security;
alter table metered_usage_events enable row level security;
alter table provider_fees enable row level security;
revoke all on agency_billing_settings, usage_rate_versions, usage_unit_rates, credit_accounts, billing_settings,
  credit_ledger_entries, payments, payment_webhook_events, usage_reservations, metered_usage_events, provider_fees
  from public, anon, authenticated;

-- Agency settings and webhook receipts: no grants at all (server only).
-- Published rates are public to signed-in users so pricing is transparent.
grant select on usage_rate_versions, usage_unit_rates to iaq_app_user;
create policy usage_rate_versions_select on usage_rate_versions for select to iaq_app_user using (true);
create policy usage_unit_rates_select on usage_unit_rates for select to iaq_app_user using (true);

grant select on credit_accounts, billing_settings, credit_ledger_entries, usage_reservations to iaq_app_user;
create policy credit_accounts_select on credit_accounts for select to iaq_app_user using (app.has_permission(org_id, 'usage.view'));
create policy billing_settings_select on billing_settings for select to iaq_app_user using (app.has_permission(org_id, 'usage.view'));
create policy credit_ledger_select on credit_ledger_entries for select to iaq_app_user using (app.has_permission(org_id, 'usage.view'));
create policy usage_reservations_select on usage_reservations for select to iaq_app_user using (app.has_permission(org_id, 'usage.view'));

-- Usage lines show the client's charge. Provider wholesale cost and uncollected amounts are agency-only columns.
grant select (id, org_id, provider, unit_type, quantity, markup_bps, client_micros, charged_micros, currency, job_reference,
  billing_status, occurred_at) on metered_usage_events to iaq_app_user;
create policy metered_usage_select on metered_usage_events for select to iaq_app_user using (app.has_permission(org_id, 'usage.view'));

-- Payment rows are visible to the people who may see billing; the provider's checkout/payment ids are not granted.
grant select (id, org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode,
  reference_number, checkout_url, credits_micros, refunded_micros, paid_at, created_at) on payments to iaq_app_user;
create policy payments_select on payments for select to iaq_app_user using (app.has_permission(org_id, 'billing.view'));

grant select on provider_fees to iaq_app_user;
create policy provider_fees_select on provider_fees for select to iaq_app_user using (app.has_permission(org_id, 'billing.view') or app.has_permission(org_id, 'usage.view'));

insert into role_permissions (role, permission) values
  ('owner', 'credits.topup'), ('admin', 'credits.topup'),
  ('owner', 'billing.configure'), ('admin', 'billing.configure'),
  ('agency_staff', 'billing.agency_view'), ('agency_super_admin', 'billing.agency_view'),
  ('agency_super_admin', 'billing.agency_manage');

-- Existing organizations get an empty account and default settings.
insert into credit_accounts (org_id) select id from organizations where kind = 'client' on conflict do nothing;
insert into billing_settings (org_id) select id from organizations where kind = 'client' on conflict do nothing;
