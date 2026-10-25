-- Rollback for 0103_purchase_checkouts.sql. NOT a migration: stop any purchase checkout first and run in one transaction.
-- Refuses while any purchase checkout exists, while any intent was paid online, or while a payment names a maintenance plan period: a provider-verified payment is a
-- commercial record, not disposable configuration. Export it deliberately, then remove it.

do $$
begin
  if exists (select 1 from purchase_intent_checkouts) then
    raise exception 'Rollback refused: purchase checkouts exist. Export them deliberately first.';
  end if;
  if exists (select 1 from purchase_intents where payment_source = 'provider' or auto_provision or payment_hold is not null) then
    raise exception 'Rollback refused: a purchase intent was paid online, set to provision itself or put on hold. Export it deliberately first.';
  end if;
  if exists (select 1 from payments where maintenance_subscription_id is not null) then
    raise exception 'Rollback refused: a payment names the maintenance plan period it covers. Export it deliberately first.';
  end if;
  if exists (select 1 from purchase_intent_events where kind in ('checkout_started', 'checkout_failed', 'checkout_expired', 'payment_received', 'payment_mismatch', 'payment_held', 'provision_failed', 'provision_retried')) then
    raise exception 'Rollback refused: the purchase timeline holds online-checkout events. Export them deliberately first.';
  end if;
end $$;

alter table agency_billing_settings drop column purchase_checkout_enabled;

alter table payments drop constraint payments_checkout_url_check;
alter table payments add constraint payments_checkout_url_check check (checkout_url ~ '^https://');

drop index payments_one_open_maintenance_idx;
alter table payments drop constraint payments_maintenance_period_check;
alter table payments drop constraint payments_maintenance_plan_fk;
alter table payments drop column covers_months;
alter table payments drop column maintenance_subscription_id;

alter table payment_webhook_events drop column purchase_checkout_id;

alter table purchase_intent_events drop constraint purchase_intent_events_kind_check;
alter table purchase_intent_events add constraint purchase_intent_events_kind_check check (kind in (
  'created', 'link_rotated', 'started', 'payment_verified', 'workspace_created', 'provisioned', 'cancelled', 'expired'));

alter table purchase_intents drop constraint purchase_intents_source_check;
alter table purchase_intents drop constraint purchase_intents_checkout_fk;
alter table purchase_intents
  drop column last_provision_at,
  drop column last_provision_error,
  drop column provision_attempts,
  drop column payment_hold,
  drop column payment_checkout_id,
  drop column payment_source,
  drop column auto_provision;

drop policy if exists purchase_checkouts_select on purchase_intent_checkouts;
drop table purchase_intent_checkouts;
drop function app.purchase_checkout_guard();
