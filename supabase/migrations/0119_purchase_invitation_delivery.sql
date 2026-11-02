-- 0119: purchase invitation delivery records and payment-provider connection checks.
--
-- 1. purchase_intent_deliveries: one row for every attempt to put a purchase link in a buyer's hands (the first invitation, a resend with a fresh link, a rotation shared by
--    hand). It records what is TRUE about the attempt: pending (not answered yet), sent (the email provider accepted the message, which is not proof it arrived), delivered or
--    bounced (the provider's own later notice), failed (refused or unreachable) or manual (no email was attempted, a person shares the link). It never holds the link or the
--    token: only a hash of the token ever exists on the purchase, and the email's stored copy has the link cut out of it.
-- 2. payment_provider_checks: the result of a read-only, authorized "check connection" call to PayMongo or PayPal, with a fingerprint of the non-secret shape of the
--    configuration it was made with, so "test verified" stops being true the moment the keys, mode or webhook setting change. It holds no key, secret or token.
-- 3. purchase_intent_events accepts one more kind, 'invitation_email', for the timeline.
--
-- Additive only. Both tables are written by trusted server code (withSystem); the application role can only read them, scoped to the one agency workspace.

create table purchase_intent_deliveries (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references purchase_intents(id) on delete cascade,
  agency_org_id uuid not null references organizations(id) on delete restrict,
  -- invitation: the link made with the purchase. resend: a fresh link made and emailed (the earlier one stopped working). rotation: a fresh link made and shown to the Super Admin to share by hand.
  kind text not null check (kind in ('invitation', 'resend', 'rotation')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'bounced', 'failed', 'manual')),
  -- Why no email was attempted (manual) or why it failed. Fixed words; the provider's own explanation, trimmed, is in "error".
  reason text check (reason is null or reason in ('chosen', 'email_off', 'email_not_configured', 'sender_not_ready', 'provider_refused', 'provider_unreachable')),
  recipient text not null check (char_length(recipient) between 3 and 254),
  provider text not null check (provider in ('resend', 'capture', 'none')),
  outbox_id uuid references email_outbox(id) on delete set null,
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 120),
  error text check (error is null or char_length(error) <= 300),
  -- Makes a double press or a retried request one invitation and one email: a repeated key finds the row it made.
  idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  link_expires_at timestamptz not null,
  requested_by uuid references users(id) on delete set null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint purchase_intent_deliveries_completed_check check ((status = 'pending') = (completed_at is null)),
  constraint purchase_intent_deliveries_reason_required check ((status in ('manual', 'failed')) = (reason is not null))
);
create unique index purchase_intent_deliveries_idempotency on purchase_intent_deliveries (agency_org_id, idempotency_key) where idempotency_key is not null;
create index purchase_intent_deliveries_intent on purchase_intent_deliveries (intent_id, created_at desc, id);
create index purchase_intent_deliveries_message on purchase_intent_deliveries (provider_message_id) where provider_message_id is not null;

-- The delivery's agency must be the intent's agency, and the agency workspace. Checked here, not trusted from the caller.
create or replace function app.purchase_delivery_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from purchase_intents i where i.id = new.intent_id and i.agency_org_id = new.agency_org_id) then
    raise exception 'purchase_delivery_agency_mismatch' using errcode = '23514';
  end if;
  if not exists (select 1 from organizations where id = new.agency_org_id and kind = 'agency') then
    raise exception 'purchase_delivery_must_be_the_agency_workspace' using errcode = '23514';
  end if;
  new.recipient := lower(btrim(new.recipient));
  new.updated_at := now();
  return new;
end $$;
create trigger purchase_intent_deliveries_guard before insert or update on purchase_intent_deliveries for each row execute function app.purchase_delivery_guard();

create table payment_provider_checks (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('paymongo', 'paypal')),
  livemode boolean not null,
  -- verified: the provider accepted the credentials (and, where it can say, a webhook for this site's address exists). webhook_not_registered: the credentials work but the provider lists
  -- no enabled webhook for this site's address, so a payment could not be confirmed. The others are what they say.
  outcome text not null check (outcome in ('verified', 'webhook_not_registered', 'credentials_rejected', 'unreachable', 'unexpected_response', 'not_configured')),
  ok boolean not null,
  -- A hash of the shape of the configuration that was checked (which settings are set, the mode, the payment methods, a hash of each credential). It cannot be turned back into a key.
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{16}$'),
  -- Non-secret facts the check read (for example "a webhook is registered for this site's address"). Never a key, a secret or a token.
  facts jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 4096),
  checked_by uuid references users(id) on delete set null,
  checked_at timestamptz not null default now(),
  constraint payment_provider_checks_ok_check check (ok = (outcome = 'verified'))
);
create index payment_provider_checks_latest on payment_provider_checks (provider, checked_at desc, id desc);

create or replace function app.payment_provider_checks_immutable() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  raise exception 'payment_provider_checks rows are append-only' using errcode = '42501';
end $$;
create trigger payment_provider_checks_immutable before update or delete on payment_provider_checks for each row execute function app.payment_provider_checks_immutable();

revoke all on function app.purchase_delivery_guard() from public;
revoke all on function app.payment_provider_checks_immutable() from public;

alter table purchase_intent_deliveries enable row level security;
alter table payment_provider_checks enable row level security;
revoke all on purchase_intent_deliveries, payment_provider_checks from public, anon, authenticated, iaq_site_runtime;
grant select on purchase_intent_deliveries, payment_provider_checks to iaq_app_user;
create policy purchase_intent_deliveries_select on purchase_intent_deliveries for select to iaq_app_user
  using (agency_org_id = (select app.purchase_intent_agency_org()) and (select app.purchase_intents_allowed()));
create policy payment_provider_checks_select on payment_provider_checks for select to iaq_app_user
  using ((select app.purchase_intent_agency_org()) is not null and (select app.purchase_intents_allowed()));

alter table purchase_intent_events drop constraint purchase_intent_events_kind_check;
alter table purchase_intent_events add constraint purchase_intent_events_kind_check check (kind in (
  'created', 'link_rotated', 'started', 'payment_verified', 'workspace_created', 'provisioned', 'cancelled', 'expired',
  'checkout_started', 'checkout_failed', 'checkout_expired', 'payment_received', 'payment_mismatch', 'payment_held', 'provision_failed', 'provision_retried', 'hold_released',
  'invitation_email'));
