-- 0103_purchase_checkouts.sql — online checkout for a purchase intent, and a provider-verified maintenance period.
--
-- Until now a purchase intent could only be paid outside the product and recorded by a Super Admin (0101). This adds the online path without a second billing system:
--
--   * purchase_intent_checkouts: one PayMongo hosted checkout for one intent. It exists BEFORE any workspace does, so it cannot live in `payments` (which belongs to a client
--     workspace). It keeps the amounts WE asked for (the frozen US$1,499 converted at the agency's published rate, stored with the rate), the reference we sent, the mode, and
--     what the provider's signed notice later said. Only that signed notice can move it to "paid"; a browser return page never can.
--   * purchase_intents gains the evidence source (manual or provider), the checkout that paid it, a payment hold (a refund or dispute reported before provisioning), and whether
--     the Super Admin who invited the buyer allowed the workspace to be created the moment the payment is verified.
--   * payments gains the maintenance plan and the number of months a provider-verified maintenance payment covers, so the same signed notice that clears a setup fee can renew a plan.
--   * agency_billing_settings gains one switch, off by default: whether purchase checkouts may be started at all.
--
-- Nothing here is applied to a hosted database, and nothing charges anyone: with the switch off, or without PayMongo keys and an exchange rate, no checkout is created.

-- ---------------------------------------------------------------------------
-- The checkout
-- ---------------------------------------------------------------------------

create table purchase_intent_checkouts (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references purchase_intents(id) on delete restrict,
  agency_org_id uuid not null references organizations(id) on delete restrict,
  provider text not null default 'paymongo' check (provider in ('paymongo', 'paypal')),
  -- The reference we send to the provider and expect back; unguessable, safe to show on a receipt.
  reference_number text not null unique check (char_length(reference_number) between 8 and 60),
  status text not null default 'creating' check (status in ('creating', 'pending', 'paid', 'failed', 'cancelled', 'expired', 'mismatch', 'refunded', 'disputed')),
  -- What was frozen on the intent, and what we asked the provider to charge for it.
  usd_amount_cents integer not null check (usd_amount_cents > 0),
  charged_currency text not null check (charged_currency ~ '^[A-Z]{3}$'),
  charged_amount_minor bigint not null check (charged_amount_minor > 0),
  fx_rate numeric(12, 6),
  fx_source text check (char_length(fx_source) <= 200),
  fx_at timestamptz,
  livemode boolean not null,
  provider_checkout_id text,
  provider_payment_id text,
  -- https only, except the address of the simulated provider on this very machine (the application refuses to use that address anywhere but development and test, see env.ts).
  checkout_url text check (checkout_url ~ '^https://' or checkout_url ~ '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/'),
  fee_minor bigint check (fee_minor >= 0),
  failure_reason text check (char_length(failure_reason) <= 300),
  paid_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_checkout_id),
  unique (provider, provider_payment_id),
  unique (id, intent_id),
  check (status not in ('paid', 'refunded', 'disputed') or (paid_at is not null and provider_payment_id is not null)),
  check (status <> 'pending' or (provider_checkout_id is not null and checkout_url is not null))
);
-- One open checkout per intent: a buyer cannot be charged twice by two links.
create unique index purchase_checkouts_one_open on purchase_intent_checkouts (intent_id) where status in ('creating', 'pending');
create index purchase_checkouts_intent on purchase_intent_checkouts (intent_id, created_at desc);
create index purchase_checkouts_pending_age on purchase_intent_checkouts (created_at) where status in ('creating', 'pending');
create trigger purchase_checkouts_touch before update on purchase_intent_checkouts for each row execute function app.touch_updated_at();

-- The amount is the frozen offer's, copied by the database from the intent and nowhere else: a caller cannot ask for another price, and the intent must belong to the agency workspace.
create or replace function app.purchase_checkout_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  frozen integer;
  owner uuid;
begin
  select setup_fee_cents, agency_org_id into frozen, owner from purchase_intents where id = new.intent_id;
  if frozen is null then
    raise exception 'purchase_checkout_needs_an_intent' using errcode = '23514';
  end if;
  if new.agency_org_id is distinct from owner then
    raise exception 'purchase_checkout_agency_mismatch' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.usd_amount_cents <> frozen then
      raise exception 'purchase_checkout_amount_must_be_the_frozen_setup_fee' using errcode = '23514';
    end if;
  else
    if new.intent_id is distinct from old.intent_id or new.usd_amount_cents is distinct from old.usd_amount_cents or new.charged_amount_minor is distinct from old.charged_amount_minor
       or new.charged_currency is distinct from old.charged_currency or new.reference_number is distinct from old.reference_number or new.livemode is distinct from old.livemode
       or new.provider is distinct from old.provider then
      raise exception 'purchase_checkout_terms_never_change' using errcode = '23514';
    end if;
    -- A checkout that was paid never goes back to unpaid; the only moves out of "paid" are the provider's reported refund and dispute.
    if old.status = 'paid' and new.status not in ('paid', 'refunded', 'disputed') then
      raise exception 'purchase_checkout_paid_is_final' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger purchase_checkouts_guard before insert or update on purchase_intent_checkouts for each row execute function app.purchase_checkout_guard();
revoke all on function app.purchase_checkout_guard() from public;

-- ---------------------------------------------------------------------------
-- The intent: where its evidence came from, what paid it, whether a person must look first
-- ---------------------------------------------------------------------------

alter table purchase_intents
  add column auto_provision boolean not null default false,
  add column payment_source text not null default 'manual' check (payment_source in ('manual', 'provider')),
  add column payment_checkout_id uuid,
  -- A refund or dispute the provider reported before the workspace was made: provisioning waits for a person.
  add column payment_hold text check (payment_hold in ('refunded', 'disputed', 'mismatch')),
  add column provision_attempts integer not null default 0 check (provision_attempts >= 0),
  add column last_provision_error text check (last_provision_error is null or char_length(last_provision_error) <= 300),
  add column last_provision_at timestamptz;

alter table purchase_intents add constraint purchase_intents_checkout_fk foreign key (payment_checkout_id, id) references purchase_intent_checkouts (id, intent_id);
-- Provider evidence names the checkout that produced it; manual evidence names none.
alter table purchase_intents add constraint purchase_intents_source_check check ((payment_source = 'provider') = (payment_checkout_id is not null));

alter table purchase_intent_events drop constraint purchase_intent_events_kind_check;
alter table purchase_intent_events add constraint purchase_intent_events_kind_check check (kind in (
  'created', 'link_rotated', 'started', 'payment_verified', 'workspace_created', 'provisioned', 'cancelled', 'expired',
  'checkout_started', 'checkout_failed', 'checkout_expired', 'payment_received', 'payment_mismatch', 'payment_held', 'provision_failed', 'provision_retried'));

-- ---------------------------------------------------------------------------
-- Webhook ledger, maintenance periods and the switch
-- ---------------------------------------------------------------------------

alter table payment_webhook_events add column purchase_checkout_id uuid references purchase_intent_checkouts(id) on delete set null;

alter table payments
  add column maintenance_subscription_id uuid,
  add column covers_months smallint check (covers_months between 1 and 12);
-- The same address rule as the purchase checkouts: https, or the simulated provider on this machine.
alter table payments drop constraint payments_checkout_url_check;
alter table payments add constraint payments_checkout_url_check check (checkout_url ~ '^https://' or checkout_url ~ '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/');
alter table payments add constraint payments_maintenance_plan_fk foreign key (maintenance_subscription_id, org_id) references maintenance_subscriptions (id, org_id);
alter table payments add constraint payments_maintenance_period_check check ((maintenance_subscription_id is null) = (covers_months is null));
-- A plan cannot have two online period checkouts open at once.
create unique index payments_one_open_maintenance_idx on payments (maintenance_subscription_id) where kind = 'maintenance' and status = 'pending' and maintenance_subscription_id is not null;

alter table agency_billing_settings add column purchase_checkout_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Who may read: the same people who read purchase intents; every write is trusted server code.
-- ---------------------------------------------------------------------------

alter table purchase_intent_checkouts enable row level security;
revoke all on purchase_intent_checkouts from public, anon, authenticated, iaq_site_runtime;
grant select on purchase_intent_checkouts to iaq_app_user;
create policy purchase_checkouts_select on purchase_intent_checkouts for select to iaq_app_user
  using (agency_org_id = (select app.purchase_intent_agency_org()) and (select app.purchase_intents_allowed()));
