-- 0110_maintenance_agreements.sql — the optional automatic monthly payment for the maintenance plan (PayPal Subscriptions), as records the product can check.
--
-- Today a maintenance period is paid one of three ways: a person at iAcquire records a payment received outside the product, the owner pays N months online (a hosted checkout), or
-- nothing arrives and the renewal sweep reminds. This adds a fourth, OPTIONAL one: the owner approves a PayPal subscription for the plan's own monthly price, and PayPal then tries to
-- collect each month. What it does NOT do is decide who is paid. A period is paid only when PayPal reports a COMPLETED charge for the agreement, and that charge goes through the very same
-- transition a payment recorded by hand uses (src/server/maintenance/payment.ts); an agreement that is "active" grants nothing by itself.
--
--   * maintenance_agreements: one row per subscription we asked PayPal to open for a plan. It keeps the amount and currency WE asked for, the mode, the status PayPal last reported
--     (and when PayPal dated that news, so a late or repeated delivery cannot undo a newer one), and a HOLD: a refund or dispute on one of its charges holds the agreement, and
--     while it is held a further charge is recorded as money received but is not applied to the plan until a person releases the hold. Terminal states never come back.
--   * maintenance_agreement_charges: every charge PayPal reported for an agreement, with what was done about it (applied, held for a person, or a mismatch that changed nothing).
--     One row per provider charge, so a charge delivered twice, or found again by the reconciliation job, is one charge.
--   * payments.maintenance_agreement_id: the payment row a charge became, so a refund or dispute notice (which names the provider's payment) finds its agreement.
--   * agency_billing_settings.recurring_billing_enabled: the Super Admin's switch. OFF until a Super Admin turns it on; with it off no subscription is ever opened.
--
-- Nothing here contacts PayPal, charges anyone or enables anything. Additive; the rollback is in supabase/rollbacks.

-- ---------------------------------------------------------------------------
-- The agreement
-- ---------------------------------------------------------------------------

create table maintenance_agreements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  subscription_id uuid not null,
  provider text not null default 'paypal' check (provider = 'paypal'),
  -- Our reference, sent to PayPal as the subscription's custom id and used as the idempotency key of the request that opens it.
  reference_number text not null unique check (char_length(reference_number) between 8 and 60),
  -- PayPal's id for the subscription ("I-..."); empty until PayPal has answered the request that opens it.
  provider_agreement_id text check (char_length(provider_agreement_id) between 3 and 120),
  status text not null default 'approval_pending' check (status in ('approval_pending', 'approved', 'active', 'suspended', 'cancelled', 'expired', 'abandoned')),
  livemode boolean not null,
  -- What WE asked PayPal to collect each month: the plan's own price, read from the plan row when the agreement was opened.
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  approval_url text check (approval_url ~ '^https://'),
  next_billing_at timestamptz,
  failed_payments integer not null default 0 check (failed_payments >= 0),
  -- When PayPal dated the newest news applied to this agreement; older news is stale.
  last_event_at timestamptz,
  last_checked_at timestamptz,
  -- A refund or dispute on one of its charges: further charges are recorded but not applied until a person releases the hold.
  hold text check (hold in ('refunded', 'disputed')),
  hold_since timestamptz,
  hold_released_by uuid references users(id) on delete set null,
  hold_released_at timestamptz,
  hold_release_note text check (char_length(hold_release_note) between 5 and 500),
  requested_by uuid references users(id) on delete set null,
  cancelled_by uuid references users(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text check (char_length(cancel_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (provider, provider_agreement_id),
  constraint maintenance_agreements_plan_fk foreign key (subscription_id, org_id) references maintenance_subscriptions (id, org_id),
  check ((hold is null) = (hold_since is null)),
  -- An agreement PayPal knows is named; one that is only a local attempt is not yet approved.
  check (status = 'approval_pending' or status = 'abandoned' or provider_agreement_id is not null)
);
-- A plan has one open agreement at a time: the owner cannot be asked to approve two, and a second one can never charge twice.
create unique index maintenance_agreements_one_open on maintenance_agreements (subscription_id) where status in ('approval_pending', 'approved', 'active', 'suspended');
create index maintenance_agreements_org_idx on maintenance_agreements (org_id, created_at desc);
create index maintenance_agreements_check_idx on maintenance_agreements (last_checked_at nulls first) where status in ('approval_pending', 'approved', 'active', 'suspended', 'abandoned');
create trigger maintenance_agreements_touch before update on maintenance_agreements for each row execute function app.touch_updated_at();

-- What was asked of PayPal never changes, a provider id is set once, and an agreement that ended never comes back (the application checks these too; the database is the last word).
create function app.maintenance_agreement_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.org_id is distinct from old.org_id or new.subscription_id is distinct from old.subscription_id or new.provider is distinct from old.provider
     or new.reference_number is distinct from old.reference_number or new.amount_minor is distinct from old.amount_minor or new.currency is distinct from old.currency
     or new.livemode is distinct from old.livemode then
    raise exception 'The terms of an automatic payment agreement never change' using errcode = '23514';
  end if;
  if old.provider_agreement_id is not null and new.provider_agreement_id is distinct from old.provider_agreement_id then
    raise exception 'The provider id of an agreement is set once' using errcode = '23514';
  end if;
  if old.status in ('cancelled', 'expired') and new.status is distinct from old.status then
    raise exception 'An agreement that has ended does not come back' using errcode = '23514';
  end if;
  -- An abandoned attempt may still be discovered active at the provider (the buyer approved late); it then ends by cancellation, never by returning to life.
  if old.status = 'abandoned' and new.status not in ('abandoned', 'cancelled') then
    raise exception 'An abandoned agreement does not come back' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger maintenance_agreements_guard before update on maintenance_agreements for each row execute function app.maintenance_agreement_guard();

-- ---------------------------------------------------------------------------
-- The charges PayPal reported
-- ---------------------------------------------------------------------------

alter table payments add column maintenance_agreement_id uuid;

create table maintenance_agreement_charges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agreement_id uuid not null,
  -- The payment row a verified charge became. Null for a charge that matched nothing we asked for (it is not money we can account for, so no payment is made up for it).
  payment_id uuid,
  provider_charge_id text not null check (char_length(provider_charge_id) between 3 and 120),
  amount_minor bigint check (amount_minor > 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  outcome text not null check (outcome in ('applied', 'held', 'mismatch')),
  detail text check (char_length(detail) <= 300),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  released_by uuid references users(id) on delete set null,
  unique (agreement_id, provider_charge_id),
  constraint maintenance_agreement_charges_agreement_fk foreign key (agreement_id, org_id) references maintenance_agreements (id, org_id),
  constraint maintenance_agreement_charges_payment_fk foreign key (payment_id, org_id) references payments (id, org_id),
  check (outcome = 'mismatch' or payment_id is not null),
  check ((outcome = 'applied') = (applied_at is not null))
);
create index maintenance_agreement_charges_agreement_idx on maintenance_agreement_charges (agreement_id, created_at);
create index maintenance_agreement_charges_held_idx on maintenance_agreement_charges (agreement_id) where outcome = 'held';

alter table payments add constraint payments_maintenance_agreement_fk foreign key (maintenance_agreement_id, org_id) references maintenance_agreements (id, org_id);
create index payments_agreement_idx on payments (maintenance_agreement_id) where maintenance_agreement_id is not null;

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

alter table agency_billing_settings
  add column recurring_billing_enabled boolean not null default false,
  add column recurring_billing_by uuid references users(id) on delete set null,
  add column recurring_billing_at timestamptz;

-- ---------------------------------------------------------------------------
-- Who may read: nobody signed in. The owner's screen and the team's screens read through trusted server code after their own permission check, as the plan's paid-through day does.
-- ---------------------------------------------------------------------------

alter table maintenance_agreements enable row level security;
alter table maintenance_agreement_charges enable row level security;
revoke all on maintenance_agreements, maintenance_agreement_charges from public, anon, authenticated, iaq_app_user, iaq_site_runtime;
