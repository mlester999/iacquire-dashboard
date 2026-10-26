-- 0111_customer_credit_notes.sql — credit notes on a client's customer invoices: a numbered, approved, immutable record that reduces what a customer still owes on ONE issued invoice.
--
-- This is the client's own invoicing (customer_*), not iAcquire's billing. A credit note is NOT money received and NOT a refund:
--   * it never counts as a payment, as revenue, or as a reason to close a deal (verified revenue stays the money that arrived, see src/lib/invoices/revenue.ts);
--   * it can only reduce the part of an invoice that is still unpaid (amount <= the invoice's balance when it is issued), so a balance never goes negative and nothing is owed back;
--     handing money back remains a refund of a payment (customer_refunds);
--   * once issued it is immutable and cannot be voided or deleted. A mistake is corrected by a new invoice. (Reversal is deliberately not offered in this release.)
--
-- What changes:
--   * customer_invoices.credited_minor: the sum of the issued credit notes, set only together with the note that causes it (a deferred database check keeps the two equal at commit).
--     balance_minor is now total - credited - paid (still never negative); overpaid_minor is what was paid beyond the total less the credit. Both are the same generated columns as
--     before for an invoice with no credit, so nothing that reads them changes for one.
--   * customer_invoices.payment_status gains 'credited': the whole invoice was credited and nothing was paid. 'paid' now also means "paid what was owed after credits" (some money
--     received, nothing left to pay); it never means a credit alone settled it, so a credit cannot close a deal as won or announce a payment.
--   * An invoice with an issued credit note cannot be voided (the credit would point at nothing), like an invoice that took a payment.
--   * customer_credit_notes: draft -> pending_approval -> issued, or cancelled (before issue). Numbered from its own counter at issue (customer_invoice_settings.credit_number_prefix and
--     next_credit_number), never reused. The customer's and the business's details are copied from the invoice at issue; a content hash fixes what was approved.
--   * Permission invoices.credit (owner, admin) to write and submit one; approving and issuing needs invoices.approve, and the author cannot approve their own unless they are the owner
--     (checked in the application, recorded in the row: created_by, approved_by, issued_by).
--
-- Additive for existing rows (credited_minor starts at 0 everywhere). Nothing here contacts a provider, a customer or a payment account. The wording of the document and the tax
-- treatment of a credit are NOT approved by counsel; see docs/invoices-and-payments.md.

-- ---------------------------------------------------------------------------
-- Permission and numbering
-- ---------------------------------------------------------------------------

insert into role_permissions (role, permission) values ('owner', 'invoices.credit'), ('admin', 'invoices.credit') on conflict do nothing;

alter table customer_invoice_settings
  add column credit_number_prefix text not null default 'CN-' check (credit_number_prefix ~ '^[A-Za-z0-9._/-]{0,12}$'),
  add column next_credit_number bigint not null default 1 check (next_credit_number >= 1 and next_credit_number < 1000000000000);

-- ---------------------------------------------------------------------------
-- The invoice: credited_minor, the new status, the balance
-- ---------------------------------------------------------------------------

alter table customer_invoices add column credited_minor bigint not null default 0 check (credited_minor between 0 and 9007199254740991);
alter table customer_invoices add constraint customer_invoices_credit_within_total check (credited_minor <= total_minor);
-- Only an issued invoice can carry a credit (a draft has nothing owed, a void one took none).
alter table customer_invoices add constraint customer_invoices_credit_only_issued check (credited_minor = 0 or status = 'issued');

-- balance_minor and overpaid_minor are generated, and a generated expression cannot be altered in place on every supported version, so each is dropped and added again with the
-- same name and meaning plus the credit. Their column grants go with them and are given again below.
alter table customer_invoices drop column balance_minor;
alter table customer_invoices drop column overpaid_minor;
alter table customer_invoices add column balance_minor bigint generated always as (greatest(total_minor - credited_minor - paid_minor, 0)) stored;
alter table customer_invoices add column overpaid_minor bigint generated always as (greatest(paid_minor - (total_minor - credited_minor), 0)) stored;

-- The status list, the "paid" rule and the "void" rule are replaced under the names they already have (the two unnamed table checks were named by the database when 0093 made the
-- table; they are found by what they say and put back under the same names, so the rollback restores the schema exactly).
do $$
declare
  c record;
  void_name text;
  paid_name text;
begin
  for c in select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.customer_invoices'::regclass and contype = 'c' loop
    if c.def like '%voided_at IS NOT NULL%' and c.def like '%is_test%' and c.def like '%paid_minor = 0%' and c.def like '%status%void%' and c.def not like '%payment_status%' then
      void_name := c.conname;
    elsif c.def like '%payment_status <> ''paid''%' then
      paid_name := c.conname;
    end if;
  end loop;
  if void_name is null or paid_name is null then
    raise exception 'could not find the void and paid checks of customer_invoices (void %, paid %); refusing to guess', void_name, paid_name;
  end if;
  execute format('alter table customer_invoices drop constraint %I', void_name);
  execute format('alter table customer_invoices drop constraint %I', paid_name);
  -- A real invoice that took money or was credited cannot be voided; a test invoice can (nothing on it was real).
  execute format('alter table customer_invoices add constraint %I check (status <> ''void'' or (voided_at is not null and (is_test or (paid_minor = 0 and credited_minor = 0))))', void_name);
  -- Paid means some money arrived and nothing is left to pay once the credit is taken off. Credited means the whole invoice was credited and nothing was paid.
  execute format('alter table customer_invoices add constraint %I check (payment_status <> ''paid'' or (paid_minor > 0 and paid_minor + credited_minor >= total_minor))', paid_name);
end $$;
alter table customer_invoices drop constraint customer_invoices_payment_status_check;
alter table customer_invoices add constraint customer_invoices_payment_status_check check (payment_status in ('unpaid', 'partially_paid', 'paid', 'disputed', 'credited'));
alter table customer_invoices add constraint customer_invoices_credited_status_check check (payment_status <> 'credited' or (paid_minor = 0 and credited_minor >= total_minor));

grant select (credited_minor, balance_minor, overpaid_minor) on customer_invoices to iaq_app_user;

-- ---------------------------------------------------------------------------
-- The credit note
-- ---------------------------------------------------------------------------

create table customer_credit_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid not null,
  currency text not null check (currency in ('USD', 'PHP', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'JPY')),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'issued', 'cancelled')),
  -- Null until issued. Assigned from customer_invoice_settings.next_credit_number in the issuing transaction; never reused.
  number text check (char_length(number) between 1 and 40),
  -- What is taken off what the customer owes, tax included, in the invoice's currency.
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 9007199254740991),
  -- The invoice's tax in this credit, in proportion to the invoice (rounded once, at issue). Reports that leave tax out take it off.
  tax_portion_minor bigint not null default 0 check (tax_portion_minor >= 0 and tax_portion_minor <= amount_minor),
  reason text not null check (char_length(reason) between 5 and 400),
  -- The customer's and the business's details as the invoice froze them, copied when the note is issued (empty before).
  bill_to jsonb not null default '{}'::jsonb check (jsonb_typeof(bill_to) = 'object' and pg_column_size(bill_to) <= 4096),
  bill_from jsonb not null default '{}'::jsonb check (jsonb_typeof(bill_from) = 'object' and pg_column_size(bill_from) <= 4096),
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  -- Bumps on every change to a draft. An approval names the version it approved.
  version integer not null default 1 check (version >= 1),
  approved_version integer,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  issued_at timestamptz,
  issued_by uuid references users(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references users(id) on delete set null,
  cancel_reason text check (char_length(cancel_reason) <= 400),
  idempotency_key text check (char_length(idempotency_key) <= 120),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (invoice_id, org_id, currency) references customer_invoices (id, org_id, currency),
  check (approved_version is null or approved_version <= version),
  check (number is null or status = 'issued'),
  check (status <> 'issued' or (number is not null and content_hash is not null and issued_at is not null and approved_version is not null)),
  check (status <> 'cancelled' or cancelled_at is not null)
);
create unique index customer_credit_notes_number_idx on customer_credit_notes (org_id, number) where number is not null;
create unique index customer_credit_notes_idempotency_idx on customer_credit_notes (org_id, idempotency_key) where idempotency_key is not null;
create index customer_credit_notes_invoice_idx on customer_credit_notes (invoice_id, created_at);
create index customer_credit_notes_org_idx on customer_credit_notes (org_id, created_at desc);
create trigger customer_credit_notes_touch before update on customer_credit_notes for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Guards: the rules the database keeps whatever the code does
-- ---------------------------------------------------------------------------

create or replace function app.customer_credit_note_guard() returns trigger
language plpgsql as $$
declare
  inv customer_invoices;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.number is not null or new.issued_at is not null or new.approved_version is not null or new.cancelled_at is not null then
      raise exception 'A credit note is created as a draft' using errcode = '23514';
    end if;
    select * into inv from customer_invoices where id = new.invoice_id and org_id = new.org_id;
    if found and (inv.status <> 'issued' or inv.is_test) then
      raise exception 'A credit note applies to an issued invoice that is not a test invoice' using errcode = '23514';
    end if;
    if found and new.amount_minor > inv.total_minor then
      raise exception 'A credit note cannot be for more than the invoice' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'draft' or current_setting('iaq.purge', true) = 'on' then
      return old;
    end if;
    raise exception 'A credit note that has left draft cannot be deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.org_id <> old.org_id or new.invoice_id <> old.invoice_id or new.currency <> old.currency or new.created_at <> old.created_at
     or (new.created_by is distinct from old.created_by and new.created_by is not null) or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'The identity of a credit note never changes' using errcode = '42501';
  end if;
  if new.status <> old.status and not (
       (old.status = 'draft' and new.status in ('pending_approval', 'issued', 'cancelled'))
    or (old.status = 'pending_approval' and new.status in ('draft', 'issued', 'cancelled'))) then
    raise exception 'A credit note cannot go from % to %', old.status, new.status using errcode = '42501';
  end if;
  -- Issued and cancelled are final: nothing about the note changes again. (The customer's details can be erased on a privacy request, and only to the erased form; the people
  -- columns go to null when a person is removed.)
  if old.status in ('issued', 'cancelled') then
    if (to_jsonb(new) - 'updated_at' - 'bill_to' - 'approved_by' - 'issued_by' - 'cancelled_by' - 'created_by') is distinct from (to_jsonb(old) - 'updated_at' - 'bill_to' - 'approved_by' - 'issued_by' - 'cancelled_by' - 'created_by')
       or (new.approved_by is distinct from old.approved_by and new.approved_by is not null) or (new.issued_by is distinct from old.issued_by and new.issued_by is not null)
       or (new.cancelled_by is distinct from old.cancelled_by and new.cancelled_by is not null) then
      raise exception 'A credit note that is issued or cancelled can no longer change' using errcode = '42501';
    end if;
    if new.bill_to is distinct from old.bill_to and new.bill_to <> '{"erased": true}'::jsonb then
      raise exception 'The customer details on a credit note can only be erased, not rewritten' using errcode = '42501';
    end if;
    return new;
  end if;
  select * into inv from customer_invoices where id = new.invoice_id and org_id = new.org_id;
  if new.amount_minor > inv.total_minor then
    raise exception 'A credit note cannot be for more than the invoice' using errcode = '23514';
  end if;
  -- Once submitted, what was submitted does not change (the author takes it back to a draft first).
  if old.status = 'pending_approval' and new.status = 'pending_approval' and (new.amount_minor <> old.amount_minor or new.reason <> old.reason or new.version <> old.version) then
    raise exception 'A submitted credit note cannot be edited' using errcode = '42501';
  end if;
  if new.status = 'issued' then
    -- It reduces what is still owed, never more: the invoice is issued, real, not written off, not under dispute, and the amount fits in the balance as it stands (the credit being
    -- issued is not in credited_minor yet).
    if inv.status <> 'issued' or inv.is_test then
      raise exception 'A credit note applies to an issued invoice that is not a test invoice' using errcode = '23514';
    end if;
    if inv.written_off_at is not null or inv.payment_status = 'disputed' then
      raise exception 'A credit note cannot be issued on an invoice that is written off or under dispute' using errcode = '23514';
    end if;
    if new.amount_minor > inv.balance_minor then
      raise exception 'A credit note cannot be for more than is still owed on the invoice' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger customer_credit_notes_guard before insert or update or delete on customer_credit_notes for each row execute function app.customer_credit_note_guard();

-- At commit, an invoice's credited amount is exactly the sum of its issued credit notes: the note and the invoice move together or not at all.
create or replace function app.customer_credit_note_consistency() returns trigger
language plpgsql as $$
declare
  want bigint;
  have bigint;
begin
  select coalesce(sum(amount_minor), 0) into want from customer_credit_notes where invoice_id = new.invoice_id and org_id = new.org_id and status = 'issued';
  select credited_minor into have from customer_invoices where id = new.invoice_id and org_id = new.org_id;
  -- The invoice is gone (a departed client's purge or a discarded test invoice): nothing to keep in step.
  if have is not null and have <> want then
    raise exception 'The credited amount of an invoice must equal its issued credit notes (have %, notes %)', have, want using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger customer_credit_notes_consistency after insert or update on customer_credit_notes deferrable initially deferred for each row execute function app.customer_credit_note_consistency();

-- The invoice: a credit starts at zero, moves only with the notes, and the status is what the payments and credits add up to. This is the 0093 function with the credit added.
create or replace function app.customer_invoice_guard() returns trigger
language plpgsql as $$
declare
  line_count integer;
  line_subtotal bigint;
  line_tax bigint;
  line_total bigint;
  paid bigint;
  refunded bigint;
  credited bigint;
  disputed boolean;
  expected text;
begin
  -- An invoice is born a draft with nothing paid: the only way to an issued invoice is through the issue transition below, which starts unpaid too. (The application only ever
  -- inserts drafts; this keeps a direct write from making an invoice that is issued, void or paid with no payment rows behind it.)
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.paid_minor <> 0 or new.refunded_minor <> 0 or new.credited_minor <> 0 or new.payment_status <> 'unpaid' or new.written_off_at is not null then
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
  -- An invoice starts unpaid: whatever reaches issued, from a draft or from approval, has no payment, no refund, no credit, no dispute and no write-off yet. (The reconciliation of
  -- the paid amount against the payment rows below applies to an invoice that is already issued; without this, the way in could set them to anything the table's checks allow.)
  if new.status = 'issued' and old.status <> 'issued' and (new.paid_minor <> 0 or new.refunded_minor <> 0 or new.credited_minor <> 0 or new.payment_status <> 'unpaid' or new.written_off_at is not null) then
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
  if new.paid_minor <> old.paid_minor or new.refunded_minor <> old.refunded_minor or new.credited_minor <> old.credited_minor or new.payment_status <> old.payment_status then
    if old.status <> 'issued' or new.status <> 'issued' then
      raise exception 'Payments and credits apply only to an issued invoice' using errcode = '42501';
    end if;
    select coalesce(sum(amount_minor), 0) into paid from customer_payments
      where invoice_id = new.id and org_id = new.org_id and status in ('succeeded', 'partially_refunded', 'refunded', 'disputed');
    select coalesce(sum(amount_minor), 0) into refunded from customer_refunds
      where invoice_id = new.id and org_id = new.org_id and status = 'succeeded';
    select coalesce(sum(amount_minor), 0) into credited from customer_credit_notes
      where invoice_id = new.id and org_id = new.org_id and status = 'issued';
    select exists (select 1 from customer_payments where invoice_id = new.id and org_id = new.org_id and status = 'disputed') into disputed;
    expected := case
      when disputed then 'disputed'
      when paid > 0 and paid + credited >= new.total_minor then 'paid'
      when credited >= new.total_minor then 'credited'
      when paid > 0 then 'partially_paid'
      else 'unpaid' end;
    if new.paid_minor <> paid or new.refunded_minor <> refunded or new.credited_minor <> credited or new.payment_status <> expected then
      raise exception 'The paid amount, the credited amount and the status of an invoice must equal what its payments, refunds and credit notes add up to' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in member's access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table customer_credit_notes enable row level security;
revoke all on customer_credit_notes from public, anon, authenticated;
grant select on customer_credit_notes to iaq_app_user;
create policy customer_credit_notes_select on customer_credit_notes for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('invoices.view'::text))::uuid[]));
