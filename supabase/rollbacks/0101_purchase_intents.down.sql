-- Rollback for 0101_purchase_intents.sql. NOT a migration: stop any purchase flow first and run in one transaction.
-- Refuses while any purchase intent or timeline row exists: a price shown to a buyer, a verified payment reference or a created workspace is a commercial record, not
-- disposable configuration. Export the rows deliberately, then remove them.

do $$
begin
  if exists (select 1 from purchase_intents) or exists (select 1 from purchase_intent_events) then
    raise exception 'Rollback refused: purchase intents or their timeline exist. Export them deliberately first.';
  end if;
end $$;

drop policy if exists purchase_intent_events_select on purchase_intent_events;
drop policy if exists purchase_intents_select on purchase_intents;
drop table purchase_intent_events;
drop table purchase_intents;
drop function app.purchase_intent_events_immutable();
drop function app.purchase_intent_event_agency_guard();
drop function app.purchase_intent_agency_guard();
drop function app.purchase_intents_allowed();
drop function app.purchase_intent_agency_org();
