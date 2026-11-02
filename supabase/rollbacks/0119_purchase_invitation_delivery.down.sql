-- Rollback for 0119_purchase_invitation_delivery.sql. NOT a migration: stop sending purchase invitations first and run in one transaction.
-- Refuses while any delivery record, provider check or 'invitation_email' timeline entry exists: they are the record of who was emailed what and when, and of what was checked
-- with a payment provider. Export them deliberately, then remove them.

do $$
begin
  if exists (select 1 from purchase_intent_deliveries) then
    raise exception 'Rollback refused: purchase invitation deliveries exist. Export them deliberately first.';
  end if;
  if exists (select 1 from payment_provider_checks) then
    raise exception 'Rollback refused: payment provider connection checks exist. Export them deliberately first.';
  end if;
  if exists (select 1 from purchase_intent_events where kind = 'invitation_email') then
    raise exception 'Rollback refused: the purchase timeline holds invitation email entries. Export them deliberately first.';
  end if;
end $$;

alter table purchase_intent_events drop constraint purchase_intent_events_kind_check;
alter table purchase_intent_events add constraint purchase_intent_events_kind_check check (kind in (
  'created', 'link_rotated', 'started', 'payment_verified', 'workspace_created', 'provisioned', 'cancelled', 'expired',
  'checkout_started', 'checkout_failed', 'checkout_expired', 'payment_received', 'payment_mismatch', 'payment_held', 'provision_failed', 'provision_retried', 'hold_released'));

drop policy if exists payment_provider_checks_select on payment_provider_checks;
drop policy if exists purchase_intent_deliveries_select on purchase_intent_deliveries;
drop table payment_provider_checks;
drop table purchase_intent_deliveries;
drop function app.payment_provider_checks_immutable();
drop function app.purchase_delivery_guard();
