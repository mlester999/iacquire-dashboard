import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import type { OrgContext } from "@/server/tenancy/context";
import type { Permission } from "@/lib/permissions";
import { formatMinor, parseAmount, toDecimalString, type CurrencyCode } from "@/lib/money";
import { todayIn } from "@/lib/invoices/state";
import {
  canEditCredit, canTransitionCredit, creditAmountProblem, creditApproveBlockedReason, creditBlockedReason, creditReasonProblem, creditTaxPortion, formatCreditNumber,
  type CreditNoteStatus,
} from "@/lib/invoices/credit-notes";
import { creditNoteContentHash } from "@/lib/invoices/credit-hash";
import { assertInvoicesAvailable } from "@/server/invoices/feature";
import { addInvoiceEvent, asAppError, iso, loadInvoiceRow, toMinor, type InvoiceRow } from "@/server/invoices/core";
import { recomputeInvoice } from "@/server/invoices/apply";
import { stopReminders, syncInvoiceReminders } from "@/server/invoices/reminders";
import { withdrawInvoiceDeliveriesInTx } from "@/server/invoices/delivery";

// Credit notes on a client's customer invoices. A credit note takes money off what a customer still owes on ONE issued invoice. It is not money received and not a refund: it never
// counts as a payment, as revenue, or as a reason to close a deal, and it can only reduce the part of the invoice that is still unpaid.
//
// The rules (src/lib/invoices/credit-notes.ts) are the ones the database keeps too:
//   * draft -> pending_approval -> issued, or cancelled before issue. Issued is final: it cannot be edited, voided or deleted. A mistake is corrected by a new invoice.
//   * the author cannot approve their own credit note unless they are the business owner; approving names the exact version read;
//   * the number comes from the workspace's own credit counter inside the issuing transaction and is never reused;
//   * issuing locks the invoice first, re-checks the balance and that no customer may be paying, and writes the invoice's credited amount through the one place that adds an invoice up
//     (recomputeInvoice), so the note and the invoice change together or not at all (the database refuses a mismatch at commit).
//   * every step is in the invoice's history and in the audit log, and the people who must act are told.
// Every query names the workspace; an id from another workspace is simply not found.

const must = (ctx: { can(permission: Permission): boolean }, permission: Permission, message: string) => {
  if (!ctx.can(permission)) throw new AppError("forbidden", message);
};

async function authorize(db: Queryable, ctx: OrgContext, permission: Permission, message: string) {
  await assertInvoicesAvailable(db, ctx);
  must(ctx, permission, message);
}

const notFound = () => new AppError("not_found", "That credit note was not found.");
const money = (minor: number, currency: CurrencyCode) => formatMinor(minor, currency, "code");

export interface CreditNoteView {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  status: CreditNoteStatus;
  number: string | null;
  currency: CurrencyCode;
  amountMinor: number;
  taxPortionMinor: number;
  reason: string;
  version: number;
  approvedVersion: number | null;
  createdBy: string | null;
  createdByName: string | null;
  approvedByName: string | null;
  issuedByName: string | null;
  approvedAt: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  billTo: Record<string, unknown>;
  billFrom: Record<string, unknown>;
  createdAt: string;
}

interface NoteRow {
  id: string;
  org_id: string;
  invoice_id: string;
  status: CreditNoteStatus;
  number: string | null;
  currency: CurrencyCode;
  amount_minor: string;
  tax_portion_minor: string;
  reason: string;
  version: number;
  approved_version: number | null;
  created_by: string | null;
  approved_by: string | null;
  issued_by: string | null;
  approved_at: Date | null;
  issued_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  bill_to: Record<string, unknown>;
  bill_from: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: Date;
}

const NOTE_COLUMNS = `c.id, c.org_id, c.invoice_id, c.status, c.number, c.currency, c.amount_minor::text as amount_minor, c.tax_portion_minor::text as tax_portion_minor, c.reason, c.version,
  c.approved_version, c.created_by, c.approved_by, c.issued_by, c.approved_at, c.issued_at, c.cancelled_at, c.cancel_reason, c.bill_to, c.bill_from, c.idempotency_key, c.created_at`;

async function loadNote(db: Queryable, orgId: string, id: string, lock = false): Promise<NoteRow | null> {
  const { rows } = await db.query<NoteRow>(`select ${NOTE_COLUMNS} from customer_credit_notes c where c.id = $1 and c.org_id = $2${lock ? " for update of c" : ""}`, [id, orgId]);
  return rows[0] ?? null;
}

async function viewsOf(db: Queryable, orgId: string, rows: NoteRow[]): Promise<CreditNoteView[]> {
  if (!rows.length) return [];
  const userIds = [...new Set(rows.flatMap((r) => [r.created_by, r.approved_by, r.issued_by]).filter((x): x is string => Boolean(x)))];
  const names = new Map((userIds.length ? (await db.query<{ id: string; full_name: string }>("select id, full_name from users where id = any($1::uuid[])", [userIds])).rows : []).map((u) => [u.id, u.full_name]));
  const invoiceIds = [...new Set(rows.map((r) => r.invoice_id))];
  const numbers = new Map((await db.query<{ id: string; number: string | null }>("select id, number from customer_invoices where org_id = $1 and id = any($2::uuid[])", [orgId, invoiceIds])).rows.map((i) => [i.id, i.number]));
  return rows.map((r): CreditNoteView => ({
    id: r.id, invoiceId: r.invoice_id, invoiceNumber: numbers.get(r.invoice_id) ?? null, status: r.status, number: r.number, currency: r.currency, amountMinor: toMinor(r.amount_minor),
    taxPortionMinor: toMinor(r.tax_portion_minor), reason: r.reason, version: r.version, approvedVersion: r.approved_version, createdBy: r.created_by, createdByName: r.created_by ? names.get(r.created_by) ?? null : null,
    approvedByName: r.approved_by ? names.get(r.approved_by) ?? null : null, issuedByName: r.issued_by ? names.get(r.issued_by) ?? null : null, approvedAt: iso(r.approved_at), issuedAt: iso(r.issued_at),
    cancelledAt: iso(r.cancelled_at), cancelReason: r.cancel_reason, billTo: r.bill_to, billFrom: r.bill_from, createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** The credit notes of one invoice, newest first, read under the signed-in person's own row-level security. */
export async function listCreditNotes(ctx: OrgContext, invoiceId: string): Promise<CreditNoteView[]> {
  must(ctx, "invoices.view", "Your role can't see invoices.");
  return withUser(ctx.user.id, async (db) => {
    await assertInvoicesAvailable(db, ctx);
    return creditNotesOfInvoice(db, ctx.org.orgId, invoiceId);
  });
}

/** The credit notes of an invoice for a caller that has already established the right to read it. */
export async function creditNotesOfInvoice(db: Queryable, orgId: string, invoiceId: string): Promise<CreditNoteView[]> {
  const { rows } = await db.query<NoteRow>(`select ${NOTE_COLUMNS} from customer_credit_notes c where c.invoice_id = $1 and c.org_id = $2 order by c.created_at desc, c.id`, [invoiceId, orgId]);
  return viewsOf(db, orgId, rows);
}

export async function getCreditNote(ctx: OrgContext, id: string): Promise<CreditNoteView> {
  must(ctx, "invoices.view", "Your role can't see invoices.");
  return withUser(ctx.user.id, async (db) => {
    await assertInvoicesAvailable(db, ctx);
    const row = await loadNote(db, ctx.org.orgId, id);
    if (!row) throw notFound();
    return (await viewsOf(db, ctx.org.orgId, [row]))[0];
  });
}

/** The issued credit notes a customer sees on their invoice page: the number, the amount and the day. Nothing else. */
export async function publicCreditsOf(db: Queryable, orgId: string, invoiceId: string, tz: string): Promise<Array<{ number: string; amountMinor: number; issuedOn: string }>> {
  const { rows } = await db.query<{ number: string; amount_minor: string; issued_at: Date }>(
    "select number, amount_minor::text as amount_minor, issued_at from customer_credit_notes where invoice_id = $1 and org_id = $2 and status = 'issued' and number is not null order by issued_at, length(number), number", [invoiceId, orgId],
  );
  return rows.map((r) => ({ number: r.number, amountMinor: toMinor(r.amount_minor), issuedOn: todayIn(new Date(r.issued_at), tz) }));
}

// ---------------------------------------------------------------------------
// What an invoice allows
// ---------------------------------------------------------------------------

/** A payment that is waiting or being reviewed, or a checkout a customer may be paying through: what they pay would no longer be what is owed. */
async function hasOpenPayment(db: Queryable, orgId: string, invoiceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from customer_payments where invoice_id = $1 and org_id = $2 and status in ('pending', 'needs_review')
     union all select 1 from customer_payment_attempts where invoice_id = $1 and org_id = $2 and status in ('created', 'redirected', 'needs_review') limit 1`, [invoiceId, orgId],
  );
  return rows.length > 0;
}

async function invoiceBlock(db: Queryable, orgId: string, inv: InvoiceRow): Promise<string | null> {
  return creditBlockedReason({
    invoiceStatus: inv.status, isTest: inv.is_test, writtenOff: inv.written_off_at !== null, paymentStatus: inv.payment_status, balanceMinor: toMinor(inv.balance_minor),
    hasOpenPayment: await hasOpenPayment(db, orgId, inv.id),
  });
}

/** The customer's amount as the person typed it, in the invoice's currency, in minor units. */
function parsedAmount(text: unknown, currency: CurrencyCode): number {
  if (typeof text !== "string" || !text.trim()) throw new AppError("invalid_input", "Enter the amount to credit.");
  return asAppError(() => parseAmount(text.trim(), currency));
}

const actorOf = (ctx: OrgContext) => ({ id: ctx.user.id, kind: "user" as const });

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface CreditNoteInput {
  invoiceId: string;
  /** The amount as typed ("125.00"); parsed on the server in the invoice's currency. */
  amount: string;
  reason: string;
  /** A retry of the same request makes one credit note. */
  idempotencyKey?: string | null;
}

/** Writes a draft credit note. Nothing is taken off the invoice until it is approved and issued. */
export async function createCreditNoteDraft(ctx: OrgContext, input: CreditNoteInput): Promise<CreditNoteView> {
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.credit", "Only the business owner or a manager can write a credit note.");
    if (typeof input.invoiceId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.invoiceId)) throw new AppError("not_found", "That invoice was not found.");
    const problem = creditReasonProblem(input.reason);
    if (problem) throw new AppError("invalid_input", problem);
    const inv = await loadInvoiceRow(db, ctx.org.orgId, input.invoiceId, true);
    if (!inv) throw new AppError("not_found", "That invoice was not found.");
    const key = input.idempotencyKey?.trim().slice(0, 120) || null;
    if (key) {
      const twin = await db.query<NoteRow>(`select ${NOTE_COLUMNS} from customer_credit_notes c where c.org_id = $1 and c.idempotency_key = $2`, [ctx.org.orgId, key]);
      if (twin.rows[0]) {
        if (twin.rows[0].invoice_id !== inv.id) throw new AppError("conflict", "That request was already used for a different invoice.");
        return (await viewsOf(db, ctx.org.orgId, [twin.rows[0]]))[0];
      }
    }
    const blocked = await invoiceBlock(db, ctx.org.orgId, inv);
    if (blocked) throw new AppError("conflict", blocked);
    const amountMinor = parsedAmount(input.amount, inv.currency);
    const amountProblem = creditAmountProblem(amountMinor, toMinor(inv.balance_minor), inv.currency);
    if (amountProblem) throw new AppError("invalid_input", amountProblem);
    const created = (await db.query<{ id: string }>(
      "insert into customer_credit_notes (org_id, invoice_id, currency, amount_minor, reason, idempotency_key, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [ctx.org.orgId, inv.id, inv.currency, amountMinor, input.reason.trim(), key, ctx.user.id],
    )).rows[0];
    await addInvoiceEvent(db, ctx.org.orgId, inv.id, "credit_note_created", actorOf(ctx), { creditNoteId: created.id, amount: toDecimalString(amountMinor, inv.currency), currency: inv.currency });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "credit_note.created", targetType: "customer_credit_note", targetId: created.id, result: "success",
      metadata: { invoiceId: inv.id, invoiceNumber: inv.number, amount: toDecimalString(amountMinor, inv.currency), currency: inv.currency } }, db);
    return (await viewsOf(db, ctx.org.orgId, [(await loadNote(db, ctx.org.orgId, created.id)) as NoteRow]))[0];
  });
}

/** Changes the amount or the reason of a draft. Every change bumps the version, so an approval is always of one exact version. */
export async function updateCreditNoteDraft(ctx: OrgContext, id: string, patch: { amount?: string; reason?: string }, expectedVersion: number): Promise<CreditNoteView> {
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.credit", "Only the business owner or a manager can write a credit note.");
    // The invoice is locked before the note, the order every writer takes them (issueCreditNote does the same): two people acting on one draft at the same moment
    // then queue for the invoice instead of each holding the row the other wants, which Postgres would abort as a deadlock.
    const found = await loadNote(db, ctx.org.orgId, id);
    if (!found) throw notFound();
    const inv = await loadInvoiceRow(db, ctx.org.orgId, found.invoice_id, true);
    if (!inv) throw new AppError("not_found", "That invoice was not found.");
    const note = await loadNote(db, ctx.org.orgId, id, true);
    if (!note) throw notFound();
    if (!canEditCredit({ canCredit: ctx.can("invoices.credit"), canApprove: ctx.can("invoices.approve"), isAuthor: note.created_by === ctx.user.id })) throw new AppError("forbidden", "Only the person who wrote this credit note, or a manager, can change it.");
    if (note.status !== "draft") throw new AppError("conflict", note.status === "pending_approval" ? "This credit note is waiting for approval. Take it back to a draft to change it." : "This credit note can no longer be changed.");
    if (note.version !== expectedVersion) throw new AppError("conflict", "Someone changed this credit note. Reload to see their changes, then try again.");
    const blocked = await invoiceBlock(db, ctx.org.orgId, inv);
    if (blocked) throw new AppError("conflict", blocked);
    let amountMinor = toMinor(note.amount_minor);
    let reason = note.reason;
    if (patch.amount !== undefined) {
      amountMinor = parsedAmount(patch.amount, inv.currency);
      const amountProblem = creditAmountProblem(amountMinor, toMinor(inv.balance_minor), inv.currency);
      if (amountProblem) throw new AppError("invalid_input", amountProblem);
    }
    if (patch.reason !== undefined) {
      const problem = creditReasonProblem(patch.reason);
      if (problem) throw new AppError("invalid_input", problem);
      reason = patch.reason.trim();
    }
    await db.query("update customer_credit_notes set amount_minor = $3, reason = $4, version = version + 1 where id = $1 and org_id = $2", [id, ctx.org.orgId, amountMinor, reason]);
    await addInvoiceEvent(db, ctx.org.orgId, inv.id, "credit_note_edited", actorOf(ctx), { creditNoteId: id, amount: toDecimalString(amountMinor, inv.currency), currency: inv.currency });
    return (await viewsOf(db, ctx.org.orgId, [(await loadNote(db, ctx.org.orgId, id)) as NoteRow]))[0];
  });
}

/** Sends a draft for approval. What is wrong with it (the invoice changed, the amount no longer fits) stops it here, so a reviewer is never asked to look at something that could not be issued. */
export async function submitCreditNote(ctx: OrgContext, id: string, expectedVersion: number): Promise<CreditNoteView> {
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.credit", "Only the business owner or a manager can write a credit note.");
    // Same lock order as every other writer: the invoice first, then the note (see updateCreditNoteDraft).
    const found = await loadNote(db, ctx.org.orgId, id);
    if (!found) throw notFound();
    const inv = await loadInvoiceRow(db, ctx.org.orgId, found.invoice_id, true);
    if (!inv) throw new AppError("not_found", "That invoice was not found.");
    const note = await loadNote(db, ctx.org.orgId, id, true);
    if (!note) throw notFound();
    if (!canEditCredit({ canCredit: ctx.can("invoices.credit"), canApprove: ctx.can("invoices.approve"), isAuthor: note.created_by === ctx.user.id })) throw new AppError("forbidden", "Only the person who wrote this credit note, or a manager, can send it for approval.");
    if (!canTransitionCredit(note.status, "pending_approval")) throw new AppError("conflict", note.status === "pending_approval" ? "This credit note is already waiting for approval." : "This credit note cannot be sent for approval from its current state.");
    if (note.version !== expectedVersion) throw new AppError("conflict", "Someone changed this credit note. Reload to see their changes, then try again.");
    const blocked = await invoiceBlock(db, ctx.org.orgId, inv);
    if (blocked) throw new AppError("conflict", blocked);
    const amountProblem = creditAmountProblem(toMinor(note.amount_minor), toMinor(inv.balance_minor), inv.currency);
    if (amountProblem) throw new AppError("invalid_input", amountProblem);
    await db.query("update customer_credit_notes set status = 'pending_approval' where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    await addInvoiceEvent(db, ctx.org.orgId, inv.id, "credit_note_submitted", actorOf(ctx), { creditNoteId: id, version: note.version });
    await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], {
      kind: "invoice_approval_requested", title: "A credit note is waiting for your approval", body: `${money(toMinor(note.amount_minor), note.currency)} off ${inv.number ?? "an invoice"}`,
      link: `/invoices/${inv.id}`, dedupeKey: `credit-approval:${id}:${note.version}`,
    });
    return (await viewsOf(db, ctx.org.orgId, [(await loadNote(db, ctx.org.orgId, id)) as NoteRow]))[0];
  });
}

/** The author takes a submitted credit note back to a draft. */
export async function withdrawCreditNote(ctx: OrgContext, id: string): Promise<CreditNoteView> {
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.credit", "Only the business owner or a manager can write a credit note.");
    const note = await loadNote(db, ctx.org.orgId, id, true);
    if (!note) throw notFound();
    if (!canEditCredit({ canCredit: ctx.can("invoices.credit"), canApprove: ctx.can("invoices.approve"), isAuthor: note.created_by === ctx.user.id })) throw new AppError("forbidden", "Only the person who wrote this credit note, or a manager, can take it back.");
    if (note.status !== "pending_approval") throw new AppError("conflict", "This credit note is not waiting for approval.");
    await db.query("update customer_credit_notes set status = 'draft' where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    await addInvoiceEvent(db, ctx.org.orgId, note.invoice_id, "credit_note_withdrawn", actorOf(ctx), { creditNoteId: id, version: note.version });
    return (await viewsOf(db, ctx.org.orgId, [(await loadNote(db, ctx.org.orgId, id)) as NoteRow]))[0];
  });
}

/** A reviewer sends a submitted credit note back with a note. It becomes a draft again and the author is told. */
export async function returnCreditNote(ctx: OrgContext, id: string, input: { version: number; note: string }): Promise<CreditNoteView> {
  const text = input.note?.trim().slice(0, 400) ?? "";
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.approve", "Only the business owner or a manager can review credit notes.");
    if (text.length < 3) throw new AppError("invalid_input", "Say what should change.");
    const note = await loadNote(db, ctx.org.orgId, id, true);
    if (!note) throw notFound();
    if (note.status !== "pending_approval") throw new AppError("conflict", "This credit note is not waiting for approval.");
    if (note.version !== input.version) throw new AppError("conflict", "The credit note changed while you were reviewing it. Review the new version.");
    await db.query("update customer_credit_notes set status = 'draft' where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    await addInvoiceEvent(db, ctx.org.orgId, note.invoice_id, "credit_note_returned", actorOf(ctx), { creditNoteId: id, version: note.version, note: text });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "credit_note.returned", targetType: "customer_credit_note", targetId: id, result: "success", metadata: { version: note.version } }, db);
    if (note.created_by && note.created_by !== ctx.user.id) {
      await notifyUser(db, note.created_by, ctx.org.orgId, { kind: "invoice_approval_decided", title: "Changes were requested on your credit note", body: text, link: `/invoices/${note.invoice_id}`, dedupeKey: `credit-decided:${id}:${note.version}:returned` });
    }
    return (await viewsOf(db, ctx.org.orgId, [(await loadNote(db, ctx.org.orgId, id)) as NoteRow]))[0];
  });
}

/** Cancels a credit note that was never issued. It keeps its place in the history and never took anything off the invoice. */
export async function cancelCreditNote(ctx: OrgContext, id: string, reason: string): Promise<CreditNoteView> {
  const why = (reason ?? "").trim();
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.credit", "Only the business owner or a manager can cancel a credit note.");
    if (why.length < 5) throw new AppError("invalid_input", "Say why the credit note is being cancelled.");
    const note = await loadNote(db, ctx.org.orgId, id, true);
    if (!note) throw notFound();
    if (!canEditCredit({ canCredit: ctx.can("invoices.credit"), canApprove: ctx.can("invoices.approve"), isAuthor: note.created_by === ctx.user.id })) throw new AppError("forbidden", "Only the person who wrote this credit note, or a manager, can cancel it.");
    if (!canTransitionCredit(note.status, "cancelled")) throw new AppError("conflict", note.status === "issued" ? "An issued credit note cannot be cancelled. If it was a mistake, issue a new invoice for the difference." : "This credit note is already cancelled.");
    await db.query("update customer_credit_notes set status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancel_reason = $4 where id = $1 and org_id = $2", [id, ctx.org.orgId, ctx.user.id, why.slice(0, 400)]);
    await addInvoiceEvent(db, ctx.org.orgId, note.invoice_id, "credit_note_cancelled", actorOf(ctx), { creditNoteId: id, reason: why.slice(0, 200) });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "credit_note.cancelled", targetType: "customer_credit_note", targetId: id, result: "success", metadata: { invoiceId: note.invoice_id } }, db);
    return (await viewsOf(db, ctx.org.orgId, [(await loadNote(db, ctx.org.orgId, id)) as NoteRow]))[0];
  });
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

export interface IssuedCreditNote {
  creditNote: CreditNoteView;
  number: string;
  /** What the customer owes on the invoice now. */
  owedMinor: number;
  /** The invoice was credited in full or paid up with this credit: nothing more is owed. */
  settled: boolean;
}

/**
 * Approves and issues a credit note: the number comes from the workspace's credit counter in this transaction, the customer's and the business's details are copied from the invoice, a
 * content hash fixes what was approved, and the invoice's credited amount, balance and status are written together. The person names the version they read; if it changed, nothing is
 * issued. The author cannot approve their own credit note unless they are the owner.
 */
export async function issueCreditNote(ctx: OrgContext, id: string, input: { version: number }, deps: { now?: Date } = {}): Promise<IssuedCreditNote> {
  const now = deps.now ?? new Date();
  return withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    must(ctx, "invoices.credit", "Only the business owner or a manager can issue a credit note.");
    // The invoice is locked before the note, in the order every other writer takes them, so two things changing one invoice are done one after the other.
    const found = await db.query<{ invoice_id: string }>("select invoice_id from customer_credit_notes where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    if (!found.rows[0]) throw notFound();
    const inv = await loadInvoiceRow(db, ctx.org.orgId, found.rows[0].invoice_id, true);
    const note = await loadNote(db, ctx.org.orgId, id, true);
    if (!inv || !note) throw notFound();
    const blockedAuthority = creditApproveBlockedReason({ status: note.status, canApprove: ctx.can("invoices.approve"), isAuthor: note.created_by === ctx.user.id, isOwner: ctx.role === "owner" });
    if (blockedAuthority) throw new AppError(note.status === "issued" || note.status === "cancelled" ? "conflict" : "forbidden", blockedAuthority);
    if (note.version !== input.version) throw new AppError("conflict", "The credit note changed while you were reviewing it. Review the new version.");
    const blocked = await invoiceBlock(db, ctx.org.orgId, inv);
    if (blocked) throw new AppError("conflict", blocked);
    const amountMinor = toMinor(note.amount_minor);
    const amountProblem = creditAmountProblem(amountMinor, toMinor(inv.balance_minor), inv.currency);
    if (amountProblem) throw new AppError("conflict", amountProblem);

    const org = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [ctx.org.orgId])).rows[0];
    const issuedOn = todayIn(now, org?.timezone ?? "UTC");
    // The counter row exists from the first invoice issued; a workspace that never saved settings gets the defaults at version 0, so its first save still matches.
    await db.query("insert into customer_invoice_settings (org_id, version) values ($1, 0) on conflict (org_id) do nothing", [ctx.org.orgId]);
    const taken = (await db.query<{ n: string; credit_number_prefix: string }>(
      "update customer_invoice_settings set next_credit_number = next_credit_number + 1 where org_id = $1 returning (next_credit_number - 1)::text as n, credit_number_prefix", [ctx.org.orgId],
    )).rows[0];
    const number = formatCreditNumber(taken.credit_number_prefix, toMinor(taken.n));
    const taxPortion = creditTaxPortion(amountMinor, toMinor(inv.tax_minor), toMinor(inv.total_minor));
    const billTo = inv.bill_to ?? {};
    const billFrom = inv.bill_from ?? {};
    const hash = creditNoteContentHash({ number, invoiceNumber: inv.number ?? "", currency: inv.currency, amountMinor, taxPortionMinor: taxPortion, reason: note.reason, issuedOn, billFrom, billTo });
    await db.query(
      `update customer_credit_notes set status = 'issued', number = $3, tax_portion_minor = $4, bill_to = $5::jsonb, bill_from = $6::jsonb, content_hash = $7, approved_version = version,
         approved_by = $8, approved_at = $9, issued_at = $9, issued_by = $8 where id = $1 and org_id = $2`,
      [id, ctx.org.orgId, number, taxPortion, JSON.stringify(billTo), JSON.stringify(billFrom), hash, ctx.user.id, now],
    );
    // The invoice adds itself up again from the issued notes, its payments and its refunds: credited amount, balance and status change together, in this transaction.
    const after = await recomputeInvoice(db, ctx.org.orgId, inv.id);
    const settled = after.balanceMinor === 0;
    const actor = actorOf(ctx);
    await addInvoiceEvent(db, ctx.org.orgId, inv.id, "credit_note_issued", actor, {
      creditNoteId: id, number, amount: toDecimalString(amountMinor, inv.currency), currency: inv.currency, owed: toDecimalString(after.balanceMinor, inv.currency), invoiceNumber: inv.number,
    });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "credit_note.issued", targetType: "customer_credit_note", targetId: id, result: "success",
      metadata: { number, invoiceId: inv.id, invoiceNumber: inv.number, amount: toDecimalString(amountMinor, inv.currency), currency: inv.currency, taxPortion: toDecimalString(taxPortion, inv.currency), contentHash: hash,
        version: note.version, author: note.created_by, owedAfter: toDecimalString(after.balanceMinor, inv.currency) } }, db);
    if (note.created_by && note.created_by !== ctx.user.id) {
      await notifyUser(db, note.created_by, ctx.org.orgId, { kind: "invoice_approval_decided", title: "Your credit note was approved and issued", body: number, link: `/invoices/${inv.id}`, dedupeKey: `credit-decided:${id}:${note.version}:issued` });
    }
    // What is owed changed: reminders are planned again for what is left, and nothing more is sent about an invoice that is settled.
    if (settled) {
      await stopReminders(db, ctx.org.orgId, "nothing_owed", inv.id);
      await withdrawInvoiceDeliveriesInTx(db, ctx.org.orgId, inv.id, "invoice_credited");
    } else {
      await syncInvoiceReminders(db, ctx.org.orgId, inv.id, now);
    }
    return { creditNote: (await viewsOf(db, ctx.org.orgId, [(await loadNote(db, ctx.org.orgId, id)) as NoteRow]))[0], number, owedMinor: after.balanceMinor, settled };
  });
}
