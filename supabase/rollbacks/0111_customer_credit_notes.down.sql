-- Rollback for 0111_customer_credit_notes.sql. NOT a migration: review, and run in one transaction.
--
-- REFUSED while any credit note has been issued: an issued credit note is a commercial record (it reduced what a customer owed, and its number was used), so the operator exports the
-- notes first (the offboarding export carries them) and decides what to do with the invoices they changed. Draft and cancelled notes carry no financial effect and go with the table.
-- The invoices go back to the 0093 arithmetic: balance_minor = total - paid and overpaid_minor = paid - total, which is what they are for any invoice with no credit.

do $$
begin
  if exists (select 1 from customer_credit_notes where status = 'issued') or exists (select 1 from customer_invoices where credited_minor > 0) then
    raise exception 'Rollback refused: credit notes have been issued. Export them first and settle the invoices they reduced; they are commercial records.';
  end if;
end $$;

drop trigger if exists customer_credit_notes_consistency on customer_credit_notes;
drop function if exists app.customer_credit_note_consistency();
drop trigger if exists customer_credit_notes_guard on customer_credit_notes;
drop function if exists app.customer_credit_note_guard();
drop policy if exists customer_credit_notes_select on customer_credit_notes;
drop table if exists customer_credit_notes;

-- The invoice guard as 0093 wrote it.
create or replace function app.customer_invoice_guard() returns trigger
language plpgsql as $$
declare
  line_count integer;
  line_subtotal bigint;
  line_tax bigint;
  line_total bigint;
  paid bigint;
  refunded bigint;
  disputed boolean;
  expected text;
begin
  -- An invoice is born a draft with nothing paid: the only way to an issued invoice is through the issue transition below, which starts unpaid too. (The application only ever
  -- inserts drafts; this keeps a direct write from making an invoice that is issued, void or paid with no payment rows behind it.)
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.paid_minor <> 0 or new.refunded_minor <> 0 or new.payment_status <> 'unpaid' or new.written_off_at is not null then
      raise exception 'An invoice is created as a draft' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    -- A draft, a test invoice (its payments and checkouts were test-mode ones: the guards below let them go first) and a departed client's purge are the only deletes.
    if old.status = 'draft' or old.is_test or current_setting('iaq.purge', true) = 'on' then
      return old;
    end if;
    raise exception 'An invoice that has left draft cannot be deleted' using errcode = '42501';
  end if;
  -- The people columns are foreign keys that go to null when a user is deleted; they never change to anyone else.
  if new.id <> old.id or new.org_id <> old.org_id or new.created_at <> old.created_at or (new.created_by is distinct from old.created_by and new.created_by is not null)
     or new.created_via <> old.created_via or new.idempotency_key is distinct from old.idempotency_key
     or new.source_type is distinct from old.source_type or new.source_id is distinct from old.source_id or new.source_version is distinct from old.source_version then
    raise exception 'The identity of an invoice never changes' using errcode = '42501';
  end if;
  if new.status <> old.status and not (
       (old.status = 'draft' and new.status in ('pending_approval', 'issued'))
    or (old.status = 'pending_approval' and new.status in ('draft', 'issued'))
    or (old.status = 'issued' and new.status = 'void')) then
    raise exception 'An invoice cannot go from % to %', old.status, new.status using errcode = '42501';
  end if;
  -- Whether it is a test invoice is chosen while it is a draft and fixed from the moment it leaves draft (and cannot change on the way back to one either).
  if new.is_test <> old.is_test and (old.status <> 'draft' or new.status <> 'draft') then
    raise exception 'Whether this is a test invoice was fixed when it left draft' using errcode = '42501';
  end if;
  -- Submitting or issuing: the totals are exactly the sum of the lines, and there is at least one line.
  if new.status in ('pending_approval', 'issued') and new.status <> old.status then
    select count(*), coalesce(sum(ex_tax_minor), 0), coalesce(sum(tax_minor), 0), coalesce(sum(total_minor), 0)
      into line_count, line_subtotal, line_tax, line_total
      from customer_invoice_lines where invoice_id = new.id and org_id = new.org_id;
    if line_count = 0 or line_subtotal <> new.subtotal_minor or line_tax <> new.tax_minor or line_total <> new.total_minor then
      raise exception 'The invoice totals must equal the sum of its lines' using errcode = '23514';
    end if;
  end if;
  -- An invoice starts unpaid: whatever reaches issued, from a draft or from approval, has no payment, no refund, no dispute and no write-off yet. (The reconciliation of the paid
  -- amount against the payment rows below applies to an invoice that is already issued; without this, the way in could set them to anything the table's checks allow.)
  if new.status = 'issued' and old.status <> 'issued' and (new.paid_minor <> 0 or new.refunded_minor <> 0 or new.payment_status <> 'unpaid' or new.written_off_at is not null) then
    raise exception 'An invoice starts unpaid when it is issued' using errcode = '23514';
  end if;
  if old.status = 'draft' then
    return new;
  end if;
  -- Issuing sets the number, the snapshots, the hash and the dates.
  if new.status = 'issued' and old.status <> 'issued' then
    return new;
  end if;
  -- Past this point the invoice was already submitted, issued or void: what it says is frozen.
  if new.currency <> old.currency or new.tax_inclusive <> old.tax_inclusive
     or new.subtotal_minor <> old.subtotal_minor or new.tax_minor <> old.tax_minor or new.total_minor <> old.total_minor
     or new.issue_on is distinct from old.issue_on or new.due_on is distinct from old.due_on
     or new.payment_instructions is distinct from old.payment_instructions or new.notes is distinct from old.notes or new.terms is distinct from old.terms
     or new.bill_from is distinct from old.bill_from or new.number is distinct from old.number or new.content_hash is distinct from old.content_hash
     or new.version <> old.version or new.closes_deal <> old.closes_deal
     or new.issued_at is distinct from old.issued_at or (new.issued_by is distinct from old.issued_by and new.issued_by is not null)
     or new.approved_version is distinct from old.approved_version or (new.approved_by is distinct from old.approved_by and new.approved_by is not null)
     or new.approved_at is distinct from old.approved_at then
    raise exception 'This invoice has left draft: its amounts, dates, wording and number can no longer change' using errcode = '42501';
  end if;
  -- The customer's details may be erased on a privacy request, and only to the erased form; they are never rewritten to other content.
  if new.bill_to is distinct from old.bill_to and new.bill_to <> '{"erased": true}'::jsonb then
    raise exception 'The customer details on an issued invoice can only be erased, not rewritten' using errcode = '42501';
  end if;
  if (new.voided_at is distinct from old.voided_at or (new.voided_by is distinct from old.voided_by and new.voided_by is not null) or new.void_reason is distinct from old.void_reason)
     and not (old.status = 'issued' and new.status = 'void') then
    raise exception 'Only voiding an issued invoice records a void' using errcode = '42501';
  end if;
  if (new.written_off_at is distinct from old.written_off_at or (new.written_off_by is distinct from old.written_off_by and new.written_off_by is not null)
      or new.write_off_reason is distinct from old.write_off_reason)
     and (old.status <> 'issued' or old.written_off_at is not null) then
    raise exception 'A write-off applies to an issued invoice, once, and is final' using errcode = '42501';
  end if;
  if new.paid_minor <> old.paid_minor or new.refunded_minor <> old.refunded_minor or new.payment_status <> old.payment_status then
    if old.status <> 'issued' or new.status <> 'issued' then
      raise exception 'Payments apply only to an issued invoice' using errcode = '42501';
    end if;
    select coalesce(sum(amount_minor), 0) into paid from customer_payments
      where invoice_id = new.id and org_id = new.org_id and status in ('succeeded', 'partially_refunded', 'refunded', 'disputed');
    select coalesce(sum(amount_minor), 0) into refunded from customer_refunds
      where invoice_id = new.id and org_id = new.org_id and status = 'succeeded';
    select exists (select 1 from customer_payments where invoice_id = new.id and org_id = new.org_id and status = 'disputed') into disputed;
    expected := case when disputed then 'disputed' when paid >= new.total_minor then 'paid' when paid > 0 then 'partially_paid' else 'unpaid' end;
    if new.paid_minor <> paid or new.refunded_minor <> refunded or new.payment_status <> expected then
      raise exception 'The paid amount and status of an invoice must equal what its payments and refunds add up to' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- The invoice: the generated columns first (they read credited_minor), then the column and every check that mentions it, then the 0093 checks and status list again.
alter table customer_invoices drop column balance_minor;
alter table customer_invoices drop column overpaid_minor;
alter table customer_invoices drop constraint if exists customer_invoices_credited_status_check;
alter table customer_invoices drop constraint if exists customer_invoices_credit_only_issued;
alter table customer_invoices drop constraint if exists customer_invoices_credit_within_total;
alter table customer_invoices drop column credited_minor cascade;
alter table customer_invoices drop constraint customer_invoices_payment_status_check;
alter table customer_invoices add constraint customer_invoices_payment_status_check check (payment_status in ('unpaid', 'partially_paid', 'paid', 'disputed'));
-- Dropping credited_minor dropped the two checks that mentioned it; they come back as 0093 made them, under the names the database gave them then.
alter table customer_invoices add constraint customer_invoices_check8 check (status <> 'void' or (voided_at is not null and (is_test or paid_minor = 0)));
alter table customer_invoices add constraint customer_invoices_check13 check (payment_status <> 'paid' or paid_minor >= total_minor);
alter table customer_invoices add column balance_minor bigint generated always as (greatest(total_minor - paid_minor, 0)) stored;
alter table customer_invoices add column overpaid_minor bigint generated always as (greatest(paid_minor - total_minor, 0)) stored;
grant select (balance_minor, overpaid_minor) on customer_invoices to iaq_app_user;

alter table customer_invoice_settings
  drop column if exists next_credit_number,
  drop column if exists credit_number_prefix;

delete from role_permissions where permission = 'invoices.credit';
