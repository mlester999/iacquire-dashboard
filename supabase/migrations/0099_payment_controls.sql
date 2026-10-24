-- Phase 7 (milestone M1): iAcquire's OWN setup payment becomes evidence the product can check, and a payment received outside a provider can be recorded.
--
-- This is iAcquire's billing (the setup fee, the maintenance plan): billing_accounts and payments. It is not the invoices a client sends to its own customers (0093).
--
--   * billing_accounts: a waiver carries a reason, who waived it and when; a payment that cleared the setup fee is named (verified_payment_id). The database refuses
--     'paid' without a verified setup payment and 'waived' without a reason, so a status can no longer be typed in.
--   * payments: the provider may now be 'manual' (a Super Admin saw the money arrive: bank transfer, cash, a PayPal or PayMongo dashboard) or 'paypal' (reserved: no
--     PayPal code exists). A manual payment must name its reference, method, date and who verified it; the same reference is never recorded twice; its evidence cannot be
--     edited afterwards. One setup-fee checkout can be open at a time, so a second pay button can never double-charge.
--   * app.setup_payment_cleared(org): the single yes/no every gate asks (paid or waived). A signed-in caller gets an answer only for a workspace it belongs to.
--   * maintenance_subscriptions.last_payment_id: the payment a plan period was verified against, so the subscription and the money record agree.
--   * Four notification kinds.
--
-- Additive, with two data steps that are marked below. Nothing here contacts a provider, charges anyone or enables anything.

-- ---------------------------------------------------------------------------
-- payments: provider, manual-payment evidence, one open setup checkout
-- ---------------------------------------------------------------------------

alter table payments drop constraint payments_provider_check;
alter table payments add constraint payments_provider_check check (provider in ('paymongo', 'paypal', 'manual'));

alter table payments
  add column verified_by uuid references users(id) on delete set null,
  add column verified_at timestamptz,
  add column verification_note text check (char_length(verification_note) between 5 and 500),
  add column external_reference text check (char_length(external_reference) between 3 and 120),
  add column method text check (method in ('bank_transfer', 'cash', 'check', 'card', 'paypal', 'paymongo', 'other')),
  add column paid_on date;

-- A payment recorded by hand is evidence, not a click: what it was, how it arrived, when, who checked it and what they checked. Provider payments carry none of these.
alter table payments add constraint payments_manual_evidence_check check (
  (provider = 'manual' and external_reference is not null and method is not null and paid_on is not null and verified_at is not null and verification_note is not null
    and status in ('paid', 'refunded', 'partially_refunded'))
  or (provider <> 'manual' and external_reference is null and method is null and paid_on is null and verified_by is null and verified_at is null and verification_note is null)
);
-- The bank reference or receipt number is recorded once, whatever its capitalisation.
create unique index payments_manual_reference_idx on payments (lower(external_reference)) where provider = 'manual';

-- A second setup-fee checkout cannot be open while one is (a client cannot be charged twice by two links). A superseded pending checkout would block this index, so any
-- such duplicate (none is expected: no screen starts a setup checkout yet) is expired first, keeping the newest.
update payments set status = 'expired', failure_reason = 'Superseded by a newer setup-fee checkout'
 where kind = 'setup_fee' and status = 'pending'
   and id not in (select distinct on (org_id) id from payments where kind = 'setup_fee' and status = 'pending' order by org_id, created_at desc, id);
create unique index payments_one_open_setup_idx on payments (org_id) where kind = 'setup_fee' and status = 'pending';

-- A foreign key can name a payment and its workspace together, so a record can never point at another workspace's payment.
alter table payments add constraint payments_id_org_key unique (id, org_id);

create function app.payment_manual_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- The verifier is a person; the foreign key may later set it to null when that account is removed, but it is never inserted empty.
    if new.provider = 'manual' and new.verified_by is null then
      raise exception 'A payment recorded by hand names the person who verified it' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.provider is distinct from old.provider then
    raise exception 'The provider of a payment never changes' using errcode = '23514';
  end if;
  if old.provider = 'manual' and (
       new.org_id is distinct from old.org_id or new.kind is distinct from old.kind or new.usd_amount_micros is distinct from old.usd_amount_micros
       or new.charged_currency is distinct from old.charged_currency or new.charged_amount_minor is distinct from old.charged_amount_minor
       or new.external_reference is distinct from old.external_reference or new.method is distinct from old.method or new.paid_on is distinct from old.paid_on
       or new.verification_note is distinct from old.verification_note or new.verified_at is distinct from old.verified_at or new.reference_number is distinct from old.reference_number
       or (new.verified_by is distinct from old.verified_by and new.verified_by is not null)) then
    raise exception 'The evidence of a payment recorded by hand cannot be edited' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger payments_manual_guard before insert or update on payments for each row execute function app.payment_manual_guard();

-- ---------------------------------------------------------------------------
-- billing_accounts: waiver record, the payment that cleared the setup fee
-- ---------------------------------------------------------------------------

alter table billing_accounts
  add column waiver_reason text check (char_length(waiver_reason) between 5 and 500),
  add column waived_by uuid references users(id) on delete set null,
  add column waived_at timestamptz,
  add column verified_payment_id uuid;
alter table billing_accounts add constraint billing_accounts_verified_payment_fk foreign key (verified_payment_id, org_id) references payments (id, org_id);

-- DATA STEP 1 (housekeeping): a status of 'waived' set by hand before a reason was required keeps its status and gets an honest reason, so the new rule can hold.
update billing_accounts set waiver_reason = 'Waived before a reason was recorded' where setup_payment_status = 'waived' and waiver_reason is null;

-- DATA STEP 2 (FOUNDER DECISION 1, OPEN: waive, require payment, or grandfather by date). Recommended default: every workspace whose setup is ALREADY activated is waived
-- with this recorded reason, so the live client keeps what it has. A workspace that is not activated yet is not touched: it needs a payment or a waiver. A refunded setup
-- fee is an explicit decision and is not overwritten. The rollback leaves this alone: 'waived' is a valid status before this migration too.
update billing_accounts b
   set setup_payment_status = 'waived', waiver_reason = 'Activated before the payment gate', waived_at = now()
 where b.setup_payment_status not in ('paid', 'waived', 'refunded')
   and exists (select 1 from client_setup_instances i where i.org_id = b.org_id and i.state = 'activated');

alter table billing_accounts add constraint billing_accounts_waiver_check check (setup_payment_status <> 'waived' or waiver_reason is not null);

create function app.billing_account_guard() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.setup_payment_status = 'paid' and (tg_op = 'INSERT' or old.setup_payment_status is distinct from 'paid') then
    if new.verified_payment_id is null or not exists (
      select 1 from payments p where p.id = new.verified_payment_id and p.org_id = new.org_id and p.kind = 'setup_fee' and p.status in ('paid', 'partially_refunded')) then
      raise exception 'A setup fee is marked paid only against a verified setup payment' using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
create trigger billing_accounts_guard before insert or update on billing_accounts for each row execute function app.billing_account_guard();

-- ---------------------------------------------------------------------------
-- The one question every gate asks
-- ---------------------------------------------------------------------------

-- Trusted server code (no signed-in user) may ask about any workspace. A signed-in caller is answered only for a workspace it can access: false for any other, so the
-- function cannot be used to probe another client's payment status. The waiver reason and who waived it stay out of reach of the application role (see the grants).
create function app.setup_payment_cleared(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when app.current_user_id() is not null and not app.can_access_org(p_org) then false
    else coalesce((select b.setup_payment_status in ('paid', 'waived') from billing_accounts b where b.org_id = p_org), false)
  end
$$;
revoke all on function app.setup_payment_cleared(uuid) from public;
grant execute on function app.setup_payment_cleared(uuid) to iaq_app_user;

-- ---------------------------------------------------------------------------
-- The plan period a verified payment paid for
-- ---------------------------------------------------------------------------

alter table maintenance_subscriptions add column last_payment_id uuid;
alter table maintenance_subscriptions add constraint maintenance_subscriptions_last_payment_fk foreign key (last_payment_id, org_id) references payments (id, org_id);

-- ---------------------------------------------------------------------------
-- Grants: select-only, column level where a column is internal
-- ---------------------------------------------------------------------------

-- billing_accounts was readable in full. The waiver reason and who waived it are the agency's, so the grant becomes a column list (every column that was readable, plus
-- the payment that cleared the fee). Agency screens read the waiver through trusted server code.
revoke select on billing_accounts from iaq_app_user;
grant select (org_id, setup_fee_cents, currency, setup_payment_status, activation_status, invoice_url, receipt_url, paid_at, service_terms, updated_by, updated_at, verified_payment_id)
  on billing_accounts to iaq_app_user;
-- A client who may see its payments also sees how a payment arrived (online or recorded by iAcquire) and the date; the reference, the note and the verifier stay internal.
grant select (provider, method, paid_on) on payments to iaq_app_user;

-- ---------------------------------------------------------------------------
-- Notification kinds
-- ---------------------------------------------------------------------------

-- Read back from the live constraint and extended, never rewritten from a copy (see 0083, 0087, 0089 and 0093).
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
  kinds := array(select distinct k from unnest(kinds || array['billing_setup_payment_required', 'billing_setup_cleared', 'billing_renewal_due', 'billing_refund_recorded']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
