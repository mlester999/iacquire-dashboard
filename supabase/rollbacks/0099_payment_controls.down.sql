-- Rollback for 0099_payment_controls.sql. NOT a migration: review and run in one transaction.
-- Refuses when the controls have been used: a payment recorded by hand (it cannot exist where the provider must be PayMongo), a waiver a person made (a backfilled
-- waiver 'Activated before the payment gate' is not a person's decision and goes with its columns; its status stays 'waived', which is valid before 0099 too), a plan period
-- tied to a payment, or a notification of one of the four kinds. Export those deliberately first.

do $$
begin
  if exists (select 1 from payments where provider <> 'paymongo') then
    raise exception 'Rollback refused: payments recorded by hand (or by another provider) exist. Export them deliberately first.';
  end if;
  if exists (select 1 from billing_accounts where waived_by is not null or verified_payment_id is not null or (waiver_reason is not null and waiver_reason <> 'Activated before the payment gate' and waiver_reason <> 'Waived before a reason was recorded')) then
    raise exception 'Rollback refused: a waiver a person recorded, or a setup fee cleared by a verified payment, exists. Export the waiver reasons and payment links first.';
  end if;
  if exists (select 1 from maintenance_subscriptions where last_payment_id is not null) then
    raise exception 'Rollback refused: a maintenance plan period is tied to a payment. Export it first.';
  end if;
  if exists (select 1 from notifications where kind in ('billing_setup_payment_required', 'billing_setup_cleared', 'billing_renewal_due', 'billing_refund_recorded')) then
    raise exception 'Rollback refused: billing notifications of the new kinds exist. Delete or archive them first.';
  end if;
end $$;

-- The application role could read billing_accounts in full before: put that grant back (the column list goes with the columns it named).
revoke select on billing_accounts from iaq_app_user;
grant select on billing_accounts to iaq_app_user;
revoke select (provider, method, paid_on) on payments from iaq_app_user;

alter table maintenance_subscriptions drop constraint maintenance_subscriptions_last_payment_fk;
alter table maintenance_subscriptions drop column last_payment_id;

drop function app.setup_payment_cleared(uuid);

drop trigger billing_accounts_guard on billing_accounts;
drop function app.billing_account_guard();
alter table billing_accounts drop constraint billing_accounts_waiver_check;
alter table billing_accounts drop constraint billing_accounts_verified_payment_fk;
alter table billing_accounts drop column waiver_reason, drop column waived_by, drop column waived_at, drop column verified_payment_id;

drop trigger payments_manual_guard on payments;
drop function app.payment_manual_guard();
alter table payments drop constraint payments_id_org_key;
drop index payments_one_open_setup_idx;
drop index payments_manual_reference_idx;
alter table payments drop constraint payments_manual_evidence_check;
alter table payments drop column verified_by, drop column verified_at, drop column verification_note, drop column external_reference, drop column method, drop column paid_on;
alter table payments drop constraint payments_provider_check;
alter table payments add constraint payments_provider_check check (provider = 'paymongo');

-- The notification kinds added by 0099 are removed from the live allow-list (every other kind is left exactly as it is).
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'notifications_kind_check' and c.conrelid = 'notifications'::regclass;
  if def is null then
    raise exception 'notifications_kind_check not found';
  end if;
  kinds := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
  if cardinality(kinds) = 0 then
    literal := substring(def from '''\{([^}]*)\}''::text\[\]');
    if literal is not null then
      kinds := string_to_array(literal, ',');
    end if;
  end if;
  if kinds is null or cardinality(kinds) < 20 then
    raise exception 'could not read the current notification kinds (read %); refusing to rewrite them', coalesce(cardinality(kinds), 0);
  end if;
  kinds := array(select distinct k from unnest(kinds) as k where k not in ('billing_setup_payment_required', 'billing_setup_cleared', 'billing_renewal_due', 'billing_refund_recorded') order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- The 'waived' statuses written by the backfill stay: they are valid before 0099 and nothing here can tell them from a waiver a person chose.
-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0099_payment_controls';
