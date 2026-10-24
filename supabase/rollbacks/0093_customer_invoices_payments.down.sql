-- Rollback for 0093_customer_invoices_payments.sql. NOT a migration: stop the scheduler's invoice and payment jobs first, review, and run in one transaction.
-- Refuses when invoicing has been used (an invoice, a payment, a refund, a payment attempt, a connection to a payment account, a webhook receipt or an invoice
-- reminder exists, or a message was queued with the billing scope), so a client's financial records and sealed provider credentials are never dropped by
-- accident. An unused settings row is configuration and goes with its table.

do $$
begin
  if exists (select 1 from customer_invoices)
     or exists (select 1 from customer_payments)
     or exists (select 1 from customer_refunds)
     or exists (select 1 from customer_payment_attempts)
     or exists (select 1 from customer_payment_connections)
     or exists (select 1 from customer_payment_events)
     or exists (select 1 from customer_invoice_reminders)
     or exists (select 1 from customer_invoice_events) then
    raise exception 'Rollback refused: customer invoices, payments, refunds, payment connections, webhook receipts or invoice reminders exist. Export them deliberately first.';
  end if;
  if exists (select 1 from conversation_messages where scope = 'billing') then
    raise exception 'Rollback refused: messages with the billing scope exist. Export or archive them first.';
  end if;
  if exists (select 1 from notifications where kind in ('invoice_approval_requested', 'invoice_approval_decided', 'invoice_paid', 'invoice_payment_failed', 'invoice_overdue', 'invoice_refund_recorded', 'payment_connection_attention', 'payment_review_needed')) then
    raise exception 'Rollback refused: invoice notifications exist. Delete or archive them first.';
  end if;
end $$;

drop policy if exists customer_payment_connections_select on customer_payment_connections;
drop policy if exists customer_refunds_select on customer_refunds;
drop policy if exists customer_payments_select on customer_payments;
drop policy if exists customer_payment_attempts_select on customer_payment_attempts;
drop policy if exists customer_invoice_reminders_select on customer_invoice_reminders;
drop policy if exists customer_invoice_events_select on customer_invoice_events;
drop policy if exists customer_invoice_lines_select on customer_invoice_lines;
drop policy if exists customer_invoices_select on customer_invoices;
drop policy if exists customer_invoice_settings_select on customer_invoice_settings;

drop table customer_payment_events;
drop table customer_refunds;
drop table customer_payments;
drop table customer_payment_attempts;
drop table customer_invoice_reminders;
drop table customer_invoice_events;
drop table customer_invoice_lines;
drop table customer_invoices;
drop table customer_payment_connections;
drop table customer_invoice_settings;

drop function app.customer_invoice_reminder_guard();
drop function app.customer_refund_guard();
drop function app.customer_payment_event_guard();
drop function app.customer_payment_attempt_guard();
drop function app.customer_payment_guard();
drop function app.customer_invoice_event_guard();
drop function app.customer_invoice_line_guard();
drop function app.customer_invoice_guard();

delete from role_permissions where permission in ('invoices.view', 'invoices.create', 'invoices.approve', 'invoices.send', 'invoices.record_payment', 'invoices.void', 'invoices.refund', 'invoices.settings', 'invoices.connect_payments');
-- A workspace a Super Admin had switched invoicing on for loses that switch with the tables it was for.
delete from org_features where feature = 'invoices';

-- The billing scope is taken out of the live list (every other scope is left exactly as it is, in the order it has).
do $$
declare
  def text;
  scopes text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'conversation_messages_scope_check' and c.conrelid = 'conversation_messages'::regclass;
  if def is null then
    raise exception 'conversation_messages_scope_check not found';
  end if;
  scopes := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
  if scopes is null or cardinality(scopes) < 5 then
    raise exception 'could not read the current message scopes (read %); refusing to rewrite them', coalesce(cardinality(scopes), 0);
  end if;
  scopes := array(select k from unnest(scopes) with ordinality as t(k, o) where k <> 'billing' order by o);
  alter table conversation_messages drop constraint conversation_messages_scope_check;
  execute 'alter table conversation_messages add constraint conversation_messages_scope_check check (scope in (' || (select string_agg(quote_literal(k), ', ' order by o) from unnest(scopes) with ordinality as t(k, o)) || '))';
end $$;

-- The notification kinds added by 0093 are removed from the live allow-list (every other kind is left exactly as it is).
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
  kinds := array(select distinct k from unnest(kinds) as k where k not in ('invoice_approval_requested', 'invoice_approval_decided', 'invoice_paid', 'invoice_payment_failed', 'invoice_overdue', 'invoice_refund_recorded', 'payment_connection_attention', 'payment_review_needed') order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0093_customer_invoices_payments';
