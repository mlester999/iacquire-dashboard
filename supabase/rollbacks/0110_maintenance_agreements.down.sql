-- Rollback for 0110_maintenance_agreements.sql. NOT a migration: switch recurring billing off, cancel every open PayPal subscription from the Billing screen (this does not cancel them at
-- PayPal), review, and run in one transaction.
--
-- The agreements and the charges they reported are the record of what PayPal was asked to collect and what it reported collecting. The payments those charges became stay (they are money
-- received and the plan periods they paid were applied through the normal transition), only their link to an agreement is lost. REFUSED while any agreement is open, so a subscription that
-- can still charge a client is never left without a record of it.

do $$
begin
  if exists (select 1 from maintenance_agreements where status in ('approval_pending', 'approved', 'active', 'suspended')) then
    raise exception 'Rollback refused: an automatic payment agreement is still open. Cancel it first (and cancel the subscription at PayPal).';
  end if;
end $$;

alter table payments drop constraint if exists payments_maintenance_agreement_fk;
drop index if exists payments_agreement_idx;
alter table payments drop column if exists maintenance_agreement_id;

drop table if exists maintenance_agreement_charges;
drop trigger if exists maintenance_agreements_guard on maintenance_agreements;
drop function if exists app.maintenance_agreement_guard();
drop table if exists maintenance_agreements;

alter table agency_billing_settings
  drop column if exists recurring_billing_at,
  drop column if exists recurring_billing_by,
  drop column if exists recurring_billing_enabled;
