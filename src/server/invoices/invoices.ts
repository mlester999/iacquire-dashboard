import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import type { OrgContext } from "@/server/tenancy/context";
import type { Permission } from "@/lib/permissions";
import { formatMinor, isCurrency, toDecimalString, type CurrencyCode } from "@/lib/money";
import { canEditDraft, canTransition, dueFromTerms, invoiceProblems, issueBlockedReason, todayIn, voidBlockedReason, type InvoiceStatus } from "@/lib/invoices/state";
import { formatInvoiceNumber } from "@/lib/invoices/number";
import { canonicalJson, invoiceContentHash, type HashedLine } from "@/lib/invoices/hash";
import { freeTextProblem } from "@/lib/invoices/guards";
import { reminderReasonText } from "@/lib/invoices/reminder-rules";
import { lineToForm, parseLines, type LineFormInput, type ParsedLine } from "@/lib/invoices/lines";
import { draftInputSchema, draftPatchSchema, reasonSchema, type BillToInput, type DraftInput, type DraftPatch } from "@/lib/invoices/schemas";
import { assertInvoicesAvailable } from "@/server/invoices/feature";
import { invoiceTokenHashFor } from "@/server/invoices/links";
import { announceCreated, announceIssued, announceVoided } from "@/server/invoices/crm-effects";
import { stopReminders, syncInvoiceReminders } from "@/server/invoices/reminders";
import { addInvoiceEvent, asAppError, INVOICE_COLUMNS, loadInvoiceRow, loadLines, readSettings, toMinor, type InvoiceRow, type LineRow } from "@/server/invoices/core";
import { detailFor, viewsFor, type InvoiceDetail, type InvoiceView } from "@/server/invoices/views";

// Writing an invoice, getting it approved and issued, and voiding or writing it off. The server decides everything here; the interface only reads the result.
// Rules that hold throughout:
//  * Only a draft can be edited, and every change to one bumps its version. An approval is of one exact version: the person approving names the version they read.
//  * Issuing assigns the number from the workspace's counter inside the issuing transaction, freezes the customer's and the business's details, and fixes a content hash.
//    From then on the amounts, dates and wording cannot change (the database refuses it too).
//  * Whether it was paid is never decided here: only src/server/invoices/apply.ts changes paid, refunded and payment status, from payment rows.
//  * Every write names the workspace in every query, so an id from another workspace is simply not found.

const must = (ctx: { can(permission: Permission): boolean }, permission: Permission, message: string) => {
  if (!ctx.can(permission)) throw new AppError("forbidden", message);
};

/** The workspace is a client's with invoicing switched on (the true reason is given first), then the person holds the permission. */
async function authorize(db: Queryable, ctx: OrgContext, permission: Permission, message: string) {
  await assertInvoicesAvailable(db, ctx);
  must(ctx, permission, message);
}

const notFound = () => new AppError("not_found", "That invoice was not found.");
const money = (minor: number, currency: CurrencyCode) => formatMinor(minor, currency, "code");

async function orgFacts(db: Queryable, orgId: string): Promise<{ name: string; timezone: string }> {
  const { rows } = await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [orgId]);
  return rows[0] ?? { name: "", timezone: "UTC" };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface InvoiceFilter {
  status?: InvoiceStatus[];
  paymentStatus?: Array<"unpaid" | "partially_paid" | "paid" | "disputed">;
  overdueOnly?: boolean;
  contactId?: string;
  opportunityId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/** What reading the invoice list needs to know about the person: a signed-in member of the workspace, and what their role may do. A CRM page has this from its actor. */
export interface InvoiceReader {
  can(permission: Permission): boolean;
  user: { id: string };
  org: { orgId: string; kind: "agency" | "client"; timezone: string };
}

/** The invoices of the workspace, newest first. Read under the signed-in person's own row-level security. */
export async function listInvoices(ctx: InvoiceReader, f: InvoiceFilter = {}, deps: { now?: Date } = {}): Promise<InvoiceView[]> {
  must(ctx, "invoices.view", "Your role can't see invoices.");
  const now = deps.now ?? new Date();
  return withUser(ctx.user.id, async (db) => {
    await assertInvoicesAvailable(db, ctx);
    const where = ["i.org_id = $1"];
    const params: unknown[] = [ctx.org.orgId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (f.status?.length) add("i.status = any(?::text[])", f.status);
    if (f.paymentStatus?.length) add("i.payment_status = any(?::text[])", f.paymentStatus);
    if (f.contactId) add("i.contact_id = ?", f.contactId);
    if (f.opportunityId) add("i.opportunity_id = ?", f.opportunityId);
    if (f.overdueOnly) {
      params.push(todayIn(now, ctx.org.timezone));
      where.push(`i.status = 'issued' and i.payment_status in ('unpaid', 'partially_paid') and i.written_off_at is null and i.due_on < $${params.length}::date`);
    }
    const q = f.search?.trim().slice(0, 80);
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(i.number ilike $${params.length} or exists (select 1 from contacts c where c.id = i.contact_id and c.org_id = i.org_id and (c.display_name ilike $${params.length} or c.email::text ilike $${params.length})))`);
    }
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
    const offset = Math.max(f.offset ?? 0, 0);
    const { rows } = await db.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from customer_invoices i where ${where.join(" and ")} order by i.created_at desc, i.id limit ${limit} offset ${offset}`, params,
    );
    return viewsFor(db, ctx.org.orgId, rows, ctx.org.timezone, now);
  });
}

export interface ReceivablesRow {
  currency: CurrencyCode;
  /** What is still owed on issued invoices that are not written off or paid. */
  outstandingMinor: number;
  overdueMinor: number;
  openCount: number;
  overdueCount: number;
  /** Real money received on issued invoices less the refunds recorded, so far. A payment the provider ran in test mode is not in it. */
  netReceivedMinor: number;
  /** Payments the provider ran in test mode that count toward an invoice's paid amount. No real money moved. */
  testPaidMinor: number;
}

export interface ReceivablesSummary {
  byCurrency: ReceivablesRow[];
  drafts: number;
  pendingApproval: number;
}

/** What is owed to the workspace, per currency (amounts in different currencies are never added together). Checked when it is read, not live. */
export async function receivablesSummary(ctx: OrgContext, deps: { now?: Date } = {}): Promise<ReceivablesSummary> {
  must(ctx, "invoices.view", "Your role can't see invoices.");
  const today = todayIn(deps.now ?? new Date(), ctx.org.timezone);
  return withUser(ctx.user.id, async (db) => {
    await assertInvoicesAvailable(db, ctx);
    const owing = "i.status = 'issued' and i.payment_status in ('unpaid', 'partially_paid') and i.written_off_at is null";
    const { rows } = await db.query<{ currency: CurrencyCode; outstanding: string; overdue: string; open_count: number; overdue_count: number }>(
      `select i.currency,
         coalesce(sum(i.balance_minor) filter (where ${owing}), 0)::text as outstanding,
         coalesce(sum(i.balance_minor) filter (where ${owing} and i.due_on < $2::date), 0)::text as overdue,
         (count(*) filter (where ${owing}))::int as open_count,
         (count(*) filter (where ${owing} and i.due_on < $2::date))::int as overdue_count
       from customer_invoices i where i.org_id = $1 and i.status in ('issued') group by i.currency order by i.currency`,
      [ctx.org.orgId, today],
    );
    // Money that really arrived (a payment recorded by hand, or one a provider took in live mode) less what was handed back, apart from what a provider ran in test mode.
    const received = await db.query<{ currency: CurrencyCode; live_paid: string; live_refunded: string; test_paid: string }>(
      `select p.currency,
         coalesce(sum(p.amount_minor) filter (where p.livemode), 0)::text as live_paid,
         coalesce(sum((select coalesce(sum(r.amount_minor), 0) from customer_refunds r where r.payment_id = p.id and r.org_id = p.org_id and r.status = 'succeeded')) filter (where p.livemode), 0)::text as live_refunded,
         coalesce(sum(p.amount_minor) filter (where not p.livemode), 0)::text as test_paid
       from customer_payments p where p.org_id = $1 and p.status in ('succeeded', 'partially_refunded', 'refunded', 'disputed') group by p.currency`,
      [ctx.org.orgId],
    );
    const receivedBy = new Map(received.rows.map((r) => [r.currency, r]));
    const counts = (await db.query<{ drafts: number; pending: number }>(
      `select (count(*) filter (where status = 'draft'))::int as drafts, (count(*) filter (where status = 'pending_approval'))::int as pending from customer_invoices where org_id = $1`, [ctx.org.orgId],
    )).rows[0];
    return {
      byCurrency: rows.map((r) => {
        const m = receivedBy.get(r.currency);
        return {
          currency: r.currency, outstandingMinor: toMinor(r.outstanding), overdueMinor: toMinor(r.overdue), openCount: r.open_count, overdueCount: r.overdue_count,
          netReceivedMinor: m ? toMinor(m.live_paid) - toMinor(m.live_refunded) : 0, testPaidMinor: m ? toMinor(m.test_paid) : 0,
        };
      }),
      drafts: counts?.drafts ?? 0,
      pendingApproval: counts?.pending ?? 0,
    };
  });
}

export interface PaymentView {
  id: string;
  amountMinor: number;
  currency: CurrencyCode;
  provider: "paymongo" | "paypal" | "simulated" | "manual";
  verification: "provider_confirmed" | "manual";
  method: string | null;
  status: string;
  livemode: boolean;
  receivedAt: string;
  evidence: string | null;
  taxPortionMinor: number;
  refundedMinor: number;
  recordedByName: string | null;
}

export interface RefundView {
  id: string;
  paymentId: string;
  amountMinor: number;
  status: string;
  source: string;
  reason: string;
  createdAt: string;
  recordedByName: string | null;
}

export interface InvoiceEventView {
  id: number;
  at: string;
  kind: string;
  actorName: string | null;
  actorKind: string;
  detail: Record<string, unknown>;
}

export interface ReminderView {
  stepKey: string;
  dueAt: string;
  status: string;
  reason: string | null;
  /** The reason in words a business owner reads ("" when there is none). */
  reasonText: string;
  /** Where the message the reminder became stands (sent, delivered, failed, blocked…), when the reader may see messages. */
  messageStatus: string | null;
  channel: string | null;
}

export interface InvoiceFullDetail extends InvoiceDetail {
  payments: PaymentView[];
  refunds: RefundView[];
  events: InvoiceEventView[];
  reminders: ReminderView[];
  /** The part of the workspace's settings the invoice screen needs to say what will happen next. */
  closeRule: "none" | "task" | "auto_won";
}

export async function getInvoiceDetail(ctx: OrgContext, id: string, deps: { now?: Date } = {}): Promise<InvoiceFullDetail> {
  must(ctx, "invoices.view", "Your role can't see invoices.");
  return withUser(ctx.user.id, async (db) => {
    await assertInvoicesAvailable(db, ctx);
    const row = await loadInvoiceRow(db, ctx.org.orgId, id);
    if (!row) throw notFound();
    const base = await detailFor(db, ctx.org.orgId, row, ctx.org.timezone, deps.now);
    const pay = await db.query<{ id: string; amount_minor: string; currency: CurrencyCode; provider: PaymentView["provider"]; verification: PaymentView["verification"]; method: string | null; status: string; livemode: boolean;
      received_at: Date; evidence: string | null; tax_portion_minor: string; full_name: string | null; refunded: string }>(
      `select p.id, p.amount_minor::text as amount_minor, p.currency, p.provider, p.verification, p.method, p.status, p.livemode, p.received_at, p.evidence, p.tax_portion_minor::text as tax_portion_minor,
         u.full_name, coalesce((select sum(r.amount_minor) from customer_refunds r where r.payment_id = p.id and r.org_id = p.org_id and r.status = 'succeeded'), 0)::text as refunded
       from customer_payments p left join users u on u.id = p.recorded_by where p.invoice_id = $1 and p.org_id = $2 order by p.received_at, p.created_at`, [id, ctx.org.orgId],
    );
    const ref = await db.query<{ id: string; payment_id: string; amount_minor: string; status: string; source: string; reason: string; created_at: Date; full_name: string | null }>(
      `select r.id, r.payment_id, r.amount_minor::text as amount_minor, r.status, r.source, r.reason, r.created_at, u.full_name from customer_refunds r left join users u on u.id = r.recorded_by
       where r.invoice_id = $1 and r.org_id = $2 order by r.created_at`, [id, ctx.org.orgId],
    );
    const ev = await db.query<{ id: string; at: Date; kind: string; actor_kind: string; detail: Record<string, unknown>; full_name: string | null }>(
      `select e.id::text as id, e.at, e.kind, e.actor_kind, e.detail, u.full_name from customer_invoice_events e left join users u on u.id = e.actor_id where e.invoice_id = $1 and e.org_id = $2 order by e.id`, [id, ctx.org.orgId],
    );
    const rem = await db.query<{ step_key: string; due_at: Date; status: string; reason: string | null; message_status: string | null; channel: string | null }>(
      `select r.step_key, r.due_at, r.status, r.reason, m.status as message_status, c.channel
       from customer_invoice_reminders r left join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id left join conversations c on c.id = m.conversation_id and c.org_id = m.org_id
       where r.invoice_id = $1 and r.org_id = $2 order by r.due_at`, [id, ctx.org.orgId],
    );
    const settings = await readSettings(db, ctx.org.orgId);
    return {
      ...base,
      payments: pay.rows.map((p) => ({
        id: p.id, amountMinor: toMinor(p.amount_minor), currency: p.currency, provider: p.provider, verification: p.verification, method: p.method, status: p.status, livemode: p.livemode,
        receivedAt: new Date(p.received_at).toISOString(), evidence: p.evidence, taxPortionMinor: toMinor(p.tax_portion_minor), refundedMinor: toMinor(p.refunded), recordedByName: p.full_name,
      })),
      refunds: ref.rows.map((r) => ({ id: r.id, paymentId: r.payment_id, amountMinor: toMinor(r.amount_minor), status: r.status, source: r.source, reason: r.reason, createdAt: new Date(r.created_at).toISOString(), recordedByName: r.full_name })),
      events: ev.rows.map((e) => ({ id: Number(e.id), at: new Date(e.at).toISOString(), kind: e.kind, actorName: e.full_name, actorKind: e.actor_kind, detail: e.detail })),
      reminders: rem.rows.map((r) => ({ stepKey: r.step_key, dueAt: new Date(r.due_at).toISOString(), status: r.status, reason: r.reason, reasonText: reminderReasonText(r.reason), messageStatus: r.message_status, channel: r.channel })),
      closeRule: settings.closeRule,
    };
  });
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** The customer, company and deal an invoice is for, checked to be this workspace's own. A deal brings its customer and company unless they are given. */
async function resolveLinks(db: Queryable, orgId: string, link: { contactId?: string | null; companyId?: string | null; opportunityId?: string | null }) {
  let contactId = link.contactId ?? null;
  let companyId = link.companyId ?? null;
  const opportunityId = link.opportunityId ?? null;
  if (opportunityId) {
    const deal = (await db.query<{ contact_id: string | null; company_id: string | null }>("select contact_id, company_id from crm_opportunities where id = $1 and org_id = $2 and archived_at is null", [opportunityId, orgId])).rows[0];
    if (!deal) throw new AppError("invalid_input", "That deal was not found.");
    if (contactId && deal.contact_id && deal.contact_id !== contactId) throw new AppError("invalid_input", "That deal belongs to a different customer.");
    contactId ??= deal.contact_id;
    companyId ??= deal.company_id;
  }
  if (contactId) {
    const ok = (await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [contactId, orgId])).rows[0];
    if (!ok) throw new AppError("invalid_input", "That customer was not found.");
  }
  if (companyId) {
    const ok = (await db.query("select 1 from crm_companies where id = $1 and org_id = $2 and deleted_at is null", [companyId, orgId])).rows[0];
    if (!ok) throw new AppError("invalid_input", "That company was not found.");
  }
  return { contactId, companyId, opportunityId };
}

async function defaultCurrency(db: Queryable, orgId: string, preferred: CurrencyCode | null): Promise<CurrencyCode> {
  if (preferred) return preferred;
  const ws = (await db.query<{ default_currency: string }>("select default_currency from crm_workspaces where org_id = $1", [orgId])).rows[0];
  return ws && isCurrency(ws.default_currency) ? ws.default_currency : "USD";
}

/** The customer's details as typed on this invoice: only what was filled in, trimmed, and none of it a card or a key. */
function cleanBillTo(input: BillToInput | undefined): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  const put = (key: string, label: string, value: string | null | undefined) => {
    const v = value?.replace(/\s+/g, " ").trim();
    if (!v) return;
    const problem = freeTextProblem(label, v);
    if (problem) throw new AppError("invalid_input", problem);
    out[key] = v;
  };
  put("name", "The customer's name", input.name);
  put("company", "The company name", input.company);
  put("email", "The customer's email", input.email);
  put("phone", "The customer's phone", input.phone);
  put("taxId", "The customer's tax number", input.taxId);
  const lines = (input.addressLines ?? []).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (const l of lines) {
    const problem = freeTextProblem("The customer's address", l);
    if (problem) throw new AppError("invalid_input", problem);
  }
  if (lines.length) out.addressLines = lines;
  return out;
}

function cleanFreeText(what: string, text: string | null | undefined): string | null {
  const v = text?.replace(/\r\n/g, "\n").trim() || null;
  const problem = freeTextProblem(what, v);
  if (problem) throw new AppError("invalid_input", problem);
  return v;
}

async function writeLines(db: Queryable, orgId: string, invoiceId: string, lines: ParsedLine[]) {
  await db.query("delete from customer_invoice_lines where invoice_id = $1 and org_id = $2", [invoiceId, orgId]);
  for (const l of lines) {
    await db.query(
      `insert into customer_invoice_lines (org_id, invoice_id, position, description, quantity_milli, unit_price_minor, discount_bps, tax_rate_bps, gross_minor, discount_minor, net_minor, tax_minor, total_minor, ex_tax_minor)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [orgId, invoiceId, l.position, l.description, l.quantityMilli, l.unitPriceMinor, l.discountBps, l.taxRateBps, l.amounts.gross, l.amounts.discount, l.amounts.net, l.amounts.tax, l.amounts.total, l.amounts.exTax],
    );
  }
}

const lineSignature = (l: { description: string; quantityMilli: number; unitPriceMinor: number; discountBps: number | null; taxRateBps: number | null; gross: number; discount: number; net: number; tax: number; total: number }) =>
  canonicalJson(l);

const parsedSignature = (lines: ParsedLine[]) =>
  lines.map((l) => lineSignature({ description: l.description, quantityMilli: l.quantityMilli, unitPriceMinor: l.unitPriceMinor, discountBps: l.discountBps, taxRateBps: l.taxRateBps, gross: l.amounts.gross, discount: l.amounts.discount, net: l.amounts.net, tax: l.amounts.tax, total: l.amounts.total })).join("|");

const storedSignature = (rows: LineRow[]) =>
  rows.map((l) => lineSignature({ description: l.description, quantityMilli: l.quantity_milli, unitPriceMinor: toMinor(l.unit_price_minor), discountBps: l.discount_bps, taxRateBps: l.tax_rate_bps, gross: toMinor(l.gross_minor), discount: toMinor(l.discount_minor), net: toMinor(l.net_minor), tax: toMinor(l.tax_minor), total: toMinor(l.total_minor) })).join("|");

/** Stored lines back to what a person would have typed, so they can be read again under another tax mode. */
function formLines(rows: LineRow[], currency: CurrencyCode): LineFormInput[] {
  return rows.map((l) => lineToForm({ description: l.description, quantityMilli: l.quantity_milli, unitPriceMinor: toMinor(l.unit_price_minor), discountBps: l.discount_bps, discountMinor: toMinor(l.discount_minor), taxRateBps: l.tax_rate_bps }, currency, toDecimalString));
}

/**
 * Starts an invoice as a draft. The workspace's default currency, payment instructions and terms fill in what was left out. A repeated request with the same idempotency
 * key returns the draft it already made.
 */
export async function createDraft(ctx: OrgContext, rawInput: unknown, opts: { via?: "manual" | "deal" } = {}): Promise<InvoiceDetail> {
  const input: DraftInput = draftInputSchema.parse(rawInput);
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.create", "Your role can't write invoices.");
    const org = await orgFacts(db, ctx.org.orgId);
    if (input.idempotencyKey) {
      const existing = await db.query<{ id: string }>("select id from customer_invoices where org_id = $1 and idempotency_key = $2", [ctx.org.orgId, input.idempotencyKey]);
      if (existing.rows[0]) return detailFor(db, ctx.org.orgId, (await loadInvoiceRow(db, ctx.org.orgId, existing.rows[0].id)) as InvoiceRow, org.timezone);
    }
    const settings = await readSettings(db, ctx.org.orgId);
    const links = await resolveLinks(db, ctx.org.orgId, input);
    const currency = await defaultCurrency(db, ctx.org.orgId, input.currency && isCurrency(input.currency) ? input.currency : settings.defaultCurrency);
    const taxInclusive = input.taxInclusive ?? false;
    const parsed = asAppError(() => parseLines(input.lines ?? [], currency, taxInclusive));
    const payment = cleanFreeText("The payment instructions", input.paymentInstructions) ?? settings.defaultPaymentInstructions;
    const notes = cleanFreeText("The notes", input.notes);
    const terms = cleanFreeText("The terms", input.terms);
    const { rows } = await db.query<{ id: string }>(
      `insert into customer_invoices (org_id, contact_id, company_id, opportunity_id, currency, tax_inclusive, subtotal_minor, tax_minor, total_minor, due_on, bill_to, payment_instructions, notes, terms,
         closes_deal, idempotency_key, created_by, created_via)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18)
       on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing returning id`,
      [ctx.org.orgId, links.contactId, links.companyId, links.opportunityId, currency, taxInclusive, parsed.totals.subtotal, parsed.totals.tax, parsed.totals.total, input.dueOn ?? null,
        JSON.stringify(cleanBillTo(input.billTo)), payment, notes, terms, input.closesDeal ?? false, input.idempotencyKey ?? null, ctx.user.id, opts.via ?? "manual"],
    );
    if (!rows[0]) {
      // A twin request with the same key won the insert a moment ago: it is the same invoice.
      const twin = (await db.query<{ id: string }>("select id from customer_invoices where org_id = $1 and idempotency_key = $2", [ctx.org.orgId, input.idempotencyKey])).rows[0];
      if (!twin) throw new AppError("conflict", "That invoice could not be created. Try again.");
      return detailFor(db, ctx.org.orgId, (await loadInvoiceRow(db, ctx.org.orgId, twin.id)) as InvoiceRow, org.timezone);
    }
    await writeLines(db, ctx.org.orgId, rows[0].id, parsed.lines);
    await addInvoiceEvent(db, ctx.org.orgId, rows[0].id, "created", { id: ctx.user.id, kind: "user" }, { currency, lines: parsed.lines.length, via: opts.via ?? "manual" });
    await announceCreated(db, ctx.org.orgId, rows[0].id, { id: ctx.user.id, kind: "user" });
    return detailFor(db, ctx.org.orgId, (await loadInvoiceRow(db, ctx.org.orgId, rows[0].id)) as InvoiceRow, org.timezone);
  });
}

/**
 * Changes a draft. If anything it says changes, the version goes up (so any earlier look at it is out of date); nothing changes when nothing changed. Changing the
 * currency of a draft that has lines needs the lines entered again: a price typed as 1500 means something else in yen. `expectedVersion` stops two people overwriting each other.
 */
export async function updateDraft(ctx: OrgContext, id: string, rawPatch: unknown, expectedVersion: number): Promise<InvoiceDetail> {
  const patch: DraftPatch = draftPatchSchema.parse(rawPatch);
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.create", "Your role can't write invoices.");
    const org = await orgFacts(db, ctx.org.orgId);
    const row = await loadInvoiceRow(db, ctx.org.orgId, id, true);
    if (!row) throw notFound();
    if (!canEditDraft({ canCreate: ctx.can("invoices.create"), canApprove: ctx.can("invoices.approve"), isAuthor: row.created_by === ctx.user.id })) throw new AppError("forbidden", "Only the person who wrote this invoice, or a manager, can change it.");
    if (row.status !== "draft") throw new AppError("conflict", row.status === "pending_approval" ? "This invoice has been sent for approval. Take it back to a draft to change it." : "An invoice that has been issued cannot be changed.");
    if (row.version !== expectedVersion) throw new AppError("conflict", "Someone changed this invoice. Reload to see their changes, then try again.");
    const stored = await loadLines(db, ctx.org.orgId, id);
    const currency = patch.currency !== undefined && isCurrency(patch.currency) ? patch.currency : row.currency;
    if (currency !== row.currency && stored.length && patch.lines === undefined) throw new AppError("invalid_input", "Changing the currency means entering the lines again: an amount means something different in another currency.");
    const taxInclusive = patch.taxInclusive ?? row.tax_inclusive;
    const links = patch.contactId !== undefined || patch.companyId !== undefined || patch.opportunityId !== undefined
      ? await resolveLinks(db, ctx.org.orgId, { contactId: patch.contactId !== undefined ? patch.contactId : row.contact_id, companyId: patch.companyId !== undefined ? patch.companyId : row.company_id, opportunityId: patch.opportunityId !== undefined ? patch.opportunityId : row.opportunity_id })
      : { contactId: row.contact_id, companyId: row.company_id, opportunityId: row.opportunity_id };
    const inputs = patch.lines ?? formLines(stored, row.currency);
    const parsed = asAppError(() => parseLines(inputs, currency, taxInclusive));
    const next = {
      contact_id: links.contactId, company_id: links.companyId, opportunity_id: links.opportunityId, currency, tax_inclusive: taxInclusive,
      due_on: patch.dueOn !== undefined ? patch.dueOn : row.due_on,
      bill_to: patch.billTo !== undefined ? cleanBillTo(patch.billTo) : row.bill_to,
      payment_instructions: patch.paymentInstructions !== undefined ? cleanFreeText("The payment instructions", patch.paymentInstructions) : row.payment_instructions,
      notes: patch.notes !== undefined ? cleanFreeText("The notes", patch.notes) : row.notes,
      terms: patch.terms !== undefined ? cleanFreeText("The terms", patch.terms) : row.terms,
      closes_deal: patch.closesDeal ?? row.closes_deal,
    };
    const changed: string[] = [];
    for (const k of Object.keys(next) as Array<keyof typeof next>) if (canonicalJson(next[k]) !== canonicalJson(row[k])) changed.push(k);
    if (parsedSignature(parsed.lines) !== storedSignature(stored)) changed.push("lines");
    if (!changed.length) return detailFor(db, ctx.org.orgId, row, org.timezone);
    await writeLines(db, ctx.org.orgId, id, parsed.lines);
    await db.query(
      `update customer_invoices set contact_id = $3, company_id = $4, opportunity_id = $5, currency = $6, tax_inclusive = $7, subtotal_minor = $8, tax_minor = $9, total_minor = $10,
         due_on = $11, bill_to = $12::jsonb, payment_instructions = $13, notes = $14, terms = $15, closes_deal = $16, version = version + 1
       where id = $1 and org_id = $2`,
      [id, ctx.org.orgId, next.contact_id, next.company_id, next.opportunity_id, next.currency, next.tax_inclusive, parsed.totals.subtotal, parsed.totals.tax, parsed.totals.total, next.due_on,
        JSON.stringify(next.bill_to), next.payment_instructions, next.notes, next.terms, next.closes_deal],
    );
    await addInvoiceEvent(db, ctx.org.orgId, id, "edited", { id: ctx.user.id, kind: "user" }, { changed, version: row.version + 1 });
    return detailFor(db, ctx.org.orgId, (await loadInvoiceRow(db, ctx.org.orgId, id)) as InvoiceRow, org.timezone);
  });
}

/** Deletes a draft that was never issued. Its number was never taken, so nothing is lost. An issued invoice is voided, never deleted. */
export async function discardDraft(ctx: OrgContext, id: string): Promise<void> {
  await withSystem(async (db) => {
    await authorize(db, ctx, "invoices.create", "Your role can't change invoices.");
    const row = await loadInvoiceRow(db, ctx.org.orgId, id, true);
    if (!row) throw notFound();
    if (!canEditDraft({ canCreate: ctx.can("invoices.create"), canApprove: ctx.can("invoices.approve"), isAuthor: row.created_by === ctx.user.id })) throw new AppError("forbidden", "Only the person who wrote this invoice, or a manager, can discard it.");
    if (row.status !== "draft") throw new AppError("conflict", row.status === "pending_approval" ? "Take this invoice back to a draft before discarding it." : "Only a draft can be discarded. An issued invoice is voided instead.");
    await db.query("delete from customer_invoices where id = $1 and org_id = $2 and status = 'draft'", [id, ctx.org.orgId]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.draft_discarded", targetType: "customer_invoice", targetId: id, result: "success", metadata: { version: row.version } }, db);
  });
}

// ---------------------------------------------------------------------------
// Approval and issue
// ---------------------------------------------------------------------------

async function problemsFor(db: Queryable, row: InvoiceRow, issueOn: string) {
  const lineCount = Number((await db.query<{ n: string }>("select count(*)::text as n from customer_invoice_lines where invoice_id = $1 and org_id = $2", [row.id, row.org_id])).rows[0].n);
  // A customer who has been removed leaves the link null, and one who was merged away or archived is no customer to bill: "no customer" covers all of them.
  const customer = row.contact_id ? (await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [row.contact_id, row.org_id])).rows.length > 0 : false;
  return invoiceProblems({ contactId: customer ? row.contact_id : null, lineCount, totalMinor: toMinor(row.total_minor), dueOn: row.due_on, issueOn });
}

/** Sends a draft for approval. What is wrong with it stops it here, so a reviewer is never asked to look at something that could not be issued. */
export async function submitForApproval(ctx: OrgContext, id: string, expectedVersion: number, deps: { now?: Date } = {}): Promise<InvoiceDetail> {
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.create", "Your role can't write invoices.");
    const org = await orgFacts(db, ctx.org.orgId);
    const row = await loadInvoiceRow(db, ctx.org.orgId, id, true);
    if (!row) throw notFound();
    if (!canEditDraft({ canCreate: ctx.can("invoices.create"), canApprove: ctx.can("invoices.approve"), isAuthor: row.created_by === ctx.user.id })) throw new AppError("forbidden", "Only the person who wrote this invoice, or a manager, can send it for approval.");
    if (!canTransition(row.status, "pending_approval")) throw new AppError("conflict", row.status === "pending_approval" ? "This invoice is already waiting for approval." : "This invoice cannot be sent for approval from its current state.");
    if (row.version !== expectedVersion) throw new AppError("conflict", "Someone changed this invoice. Reload to see their changes, then try again.");
    const problems = await problemsFor(db, row, todayIn(deps.now ?? new Date(), org.timezone));
    if (problems.length) throw new AppError("invalid_input", problems[0].message);
    await db.query("update customer_invoices set status = 'pending_approval' where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    await addInvoiceEvent(db, ctx.org.orgId, id, "submitted", { id: ctx.user.id, kind: "user" }, { version: row.version });
    const [view] = await viewsFor(db, ctx.org.orgId, [row], org.timezone);
    await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], {
      kind: "invoice_approval_requested", title: "An invoice is waiting for your approval", body: `${money(toMinor(row.total_minor), row.currency)}${view.contactName ? ` for ${view.contactName}` : ""}`,
      link: `/invoices/${id}`, dedupeKey: `invoice-approval:${id}:${row.version}`,
    });
    return detailFor(db, ctx.org.orgId, (await loadInvoiceRow(db, ctx.org.orgId, id)) as InvoiceRow, org.timezone);
  });
}

/** Takes a submitted invoice back to a draft (the writer changed their mind). It can then be edited. */
export async function withdrawFromApproval(ctx: OrgContext, id: string): Promise<InvoiceDetail> {
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.create", "Your role can't write invoices.");
    const org = await orgFacts(db, ctx.org.orgId);
    const row = await loadInvoiceRow(db, ctx.org.orgId, id, true);
    if (!row) throw notFound();
    if (!canEditDraft({ canCreate: ctx.can("invoices.create"), canApprove: ctx.can("invoices.approve"), isAuthor: row.created_by === ctx.user.id })) throw new AppError("forbidden", "Only the person who wrote this invoice, or a manager, can take it back.");
    if (row.status !== "pending_approval") throw new AppError("conflict", "This invoice is not waiting for approval.");
    await db.query("update customer_invoices set status = 'draft' where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    await addInvoiceEvent(db, ctx.org.orgId, id, "withdrawn", { id: ctx.user.id, kind: "user" }, { version: row.version });
    return detailFor(db, ctx.org.orgId, (await loadInvoiceRow(db, ctx.org.orgId, id)) as InvoiceRow, org.timezone);
  });
}

/** A reviewer sends a submitted invoice back with a note. It becomes a draft again; the writer is told. */
export async function requestChanges(ctx: OrgContext, id: string, input: { version: number; note: string }): Promise<InvoiceDetail> {
  const note = input.note?.trim().slice(0, 400) ?? "";
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.approve", "Only the business owner or a manager can review invoices.");
    if (note.length < 3) throw new AppError("invalid_input", "Say what should change.");
    const org = await orgFacts(db, ctx.org.orgId);
    const row = await loadInvoiceRow(db, ctx.org.orgId, id, true);
    if (!row) throw notFound();
    if (row.status !== "pending_approval") throw new AppError("conflict", "This invoice is not waiting for approval.");
    if (row.version !== input.version) throw new AppError("conflict", "The invoice changed while you were reviewing it. Review the new version.");
    await db.query("update customer_invoices set status = 'draft' where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    await addInvoiceEvent(db, ctx.org.orgId, id, "changes_requested", { id: ctx.user.id, kind: "user" }, { version: row.version, note });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.changes_requested", targetType: "customer_invoice", targetId: id, result: "success", metadata: { version: row.version } }, db);
    if (row.created_by && row.created_by !== ctx.user.id) {
      await notifyUser(db, row.created_by, ctx.org.orgId, { kind: "invoice_approval_decided", title: "Changes were requested on your invoice", body: note, link: `/invoices/${id}`, dedupeKey: `invoice-decided:${id}:${row.version}:changes` });
    }
    return detailFor(db, ctx.org.orgId, (await loadInvoiceRow(db, ctx.org.orgId, id)) as InvoiceRow, org.timezone);
  });
}

interface ContactFacts {
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
}

const place = (a: { city: string | null; region: string | null; postal_code: string | null }) => [a.city, [a.region, a.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/** The customer's details at issue: what the person typed on the invoice wins, and the contact (and company) fill in the rest. */
async function billToSnapshot(db: Queryable, row: InvoiceRow): Promise<Record<string, unknown>> {
  const typed = row.bill_to ?? {};
  const contact = row.contact_id
    ? (await db.query<ContactFacts>("select display_name, first_name, last_name, email::text as email, phone, address_line1, address_line2, city, region, postal_code, country from contacts where id = $1 and org_id = $2", [row.contact_id, row.org_id])).rows[0]
    : undefined;
  const company = row.company_id
    ? (await db.query<{ name: string } & Omit<ContactFacts, "display_name" | "first_name" | "last_name">>("select name, email::text as email, phone, address_line1, address_line2, city, region, postal_code, country from crm_companies where id = $1 and org_id = $2", [row.company_id, row.org_id])).rows[0]
    : undefined;
  const name = contact ? contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(" ") : "";
  const source = contact?.address_line1 || contact?.city ? contact : company;
  const addressLines = source ? [source.address_line1, source.address_line2, place(source), source.country].filter((x): x is string => Boolean(x)) : [];
  const out: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length)) out[key] = value;
  };
  set("name", typed.name ?? (name || undefined));
  set("company", typed.company ?? company?.name);
  set("email", typed.email ?? contact?.email ?? company?.email);
  set("phone", typed.phone ?? contact?.phone ?? company?.phone);
  set("addressLines", typed.addressLines ?? addressLines);
  set("taxId", typed.taxId);
  return out;
}

export interface IssueResult {
  detail: InvoiceDetail;
  number: string;
}

/**
 * Approves and issues an invoice: the number is taken from the workspace's counter in this transaction, the customer's and the business's details are frozen, and a
 * content hash fixes what was approved. The person names the version they read; if the invoice changed since, nothing is issued. Owners and managers issue any draft or
 * submitted invoice; somebody who can only create invoices can issue their own draft when the owner switched approval off for creators.
 */
export async function issueInvoice(ctx: OrgContext, id: string, input: { version: number }, deps: { now?: Date } = {}): Promise<IssueResult> {
  const now = deps.now ?? new Date();
  return withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    const org = await orgFacts(db, ctx.org.orgId);
    const row = await loadInvoiceRow(db, ctx.org.orgId, id, true);
    if (!row) throw notFound();
    const settings = await readSettings(db, ctx.org.orgId);
    const blocked = issueBlockedReason({
      status: row.status, canApprove: ctx.can("invoices.approve"), canCreate: ctx.can("invoices.create"), isAuthor: row.created_by === ctx.user.id, createdVia: row.created_via,
      approvalRequiredForCreators: settings.approvalRequiredForCreators,
    });
    if (blocked) throw new AppError(row.status === "issued" || row.status === "void" ? "conflict" : "forbidden", blocked);
    if (row.version !== input.version) throw new AppError("conflict", "The invoice changed while you were reviewing it. Review the new version.");
    const issueOn = todayIn(now, org.timezone);
    const problems = await problemsFor(db, row, issueOn);
    if (problems.length) throw new AppError("invalid_input", problems[0].message);

    // The counter row exists from the first issue; a workspace that never saved settings gets the defaults, at version 0 so its first save still matches.
    await db.query("insert into customer_invoice_settings (org_id, version) values ($1, 0) on conflict (org_id) do nothing", [ctx.org.orgId]);
    const taken = (await db.query<{ n: string; number_prefix: string }>(
      "update customer_invoice_settings set next_number = next_number + 1 where org_id = $1 returning (next_number - 1)::text as n, number_prefix", [ctx.org.orgId],
    )).rows[0];
    const number = formatInvoiceNumber(taken.number_prefix, toMinor(taken.n));
    const dueOn = row.due_on ?? dueFromTerms(issueOn, settings.paymentTermsDays);
    const lines = await loadLines(db, ctx.org.orgId, id);
    const billTo = await billToSnapshot(db, row);
    const billFrom: Record<string, unknown> = { name: settings.legalName ?? org.name };
    if (settings.addressLines.length) billFrom.addressLines = settings.addressLines;
    if (settings.taxLabel) billFrom.taxLabel = settings.taxLabel;
    if (settings.taxId) billFrom.taxId = settings.taxId;
    if (settings.replyToEmail) billFrom.replyToEmail = settings.replyToEmail;
    const hashedLines: HashedLine[] = lines.map((l) => ({
      position: l.position, description: l.description, quantityMilli: l.quantity_milli, unitPriceMinor: toMinor(l.unit_price_minor), discountBps: l.discount_bps, taxRateBps: l.tax_rate_bps,
      grossMinor: toMinor(l.gross_minor), discountMinor: toMinor(l.discount_minor), netMinor: toMinor(l.net_minor), taxMinor: toMinor(l.tax_minor), totalMinor: toMinor(l.total_minor), exTaxMinor: toMinor(l.ex_tax_minor),
    }));
    const hash = invoiceContentHash({
      number, currency: row.currency, taxInclusive: row.tax_inclusive, issueOn, dueOn, billFrom, billTo, lines: hashedLines, subtotalMinor: toMinor(row.subtotal_minor), taxMinor: toMinor(row.tax_minor),
      totalMinor: toMinor(row.total_minor), paymentInstructions: row.payment_instructions, notes: row.notes, terms: row.terms,
    });
    const wasPending = row.status === "pending_approval";
    await db.query(
      `update customer_invoices set status = 'issued', number = $3, issue_on = $4::date, due_on = $5::date, bill_to = $6::jsonb, bill_from = $7::jsonb, content_hash = $8, approved_version = version,
         approved_by = $9, approved_at = $10, issued_at = $10, issued_by = $9, public_token_hash = $11
       where id = $1 and org_id = $2`,
      [id, ctx.org.orgId, number, issueOn, dueOn, JSON.stringify(billTo), JSON.stringify(billFrom), hash, ctx.user.id, now, invoiceTokenHashFor(id, row.public_token_version)],
    );
    const actor = { id: ctx.user.id, kind: "user" as const };
    if (wasPending) await addInvoiceEvent(db, ctx.org.orgId, id, "approved", actor, { version: row.version });
    await addInvoiceEvent(db, ctx.org.orgId, id, "issued", actor, { number, total: toDecimalString(toMinor(row.total_minor), row.currency), currency: row.currency, dueOn, version: row.version });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.issued", targetType: "customer_invoice", targetId: id, result: "success", metadata: { number, version: row.version, total: toDecimalString(toMinor(row.total_minor), row.currency), currency: row.currency, contentHash: hash } }, db);
    if (row.created_by && row.created_by !== ctx.user.id) {
      await notifyUser(db, row.created_by, ctx.org.orgId, { kind: "invoice_approval_decided", title: "Your invoice was approved and issued", body: number, link: `/invoices/${id}`, dedupeKey: `invoice-decided:${id}:${row.version}:approved` });
    }
    await announceIssued(db, ctx.org.orgId, id, actor);
    // With reminders on and authorized, the issued invoice gets its reminder days now; with them off this plans nothing.
    await syncInvoiceReminders(db, ctx.org.orgId, id, now);
    return { detail: await detailFor(db, ctx.org.orgId, (await loadInvoiceRow(db, ctx.org.orgId, id)) as InvoiceRow, org.timezone, now), number };
  });
}

// ---------------------------------------------------------------------------
// Void and write-off
// ---------------------------------------------------------------------------

/**
 * Voids an issued invoice that took no money. It keeps its number (never reused), its customer link stops working, and its scheduled reminders are cancelled. An invoice
 * with any payment, or with a checkout a customer may be using, cannot be voided: a refund is recorded instead.
 */
export async function voidInvoice(ctx: OrgContext, id: string, rawInput: unknown): Promise<InvoiceDetail> {
  const { reason } = reasonSchema.parse(rawInput);
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.void", "Only the business owner or a manager can void an invoice.");
    const org = await orgFacts(db, ctx.org.orgId);
    const row = await loadInvoiceRow(db, ctx.org.orgId, id, true);
    if (!row) throw notFound();
    const open = await db.query(
      `select 1 from customer_payments where invoice_id = $1 and org_id = $2 and status in ('succeeded', 'partially_refunded', 'refunded', 'disputed', 'pending', 'needs_review')
       union all select 1 from customer_payment_attempts where invoice_id = $1 and org_id = $2 and status in ('created', 'redirected', 'needs_review') limit 1`, [id, ctx.org.orgId],
    );
    const blocked = voidBlockedReason({ status: row.status, paidMinor: toMinor(row.paid_minor), hasOpenPayment: open.rows.length > 0 });
    if (blocked) throw new AppError("conflict", blocked);
    await db.query("update customer_invoices set status = 'void', voided_at = now(), voided_by = $3, void_reason = $4, public_token_hash = null where id = $1 and org_id = $2", [id, ctx.org.orgId, ctx.user.id, reason.trim()]);
    await stopReminders(db, ctx.org.orgId, "invoice_voided", id);
    await addInvoiceEvent(db, ctx.org.orgId, id, "voided", { id: ctx.user.id, kind: "user" }, { number: row.number, reason: reason.trim().slice(0, 200) });
    await announceVoided(db, ctx.org.orgId, id, { id: ctx.user.id, kind: "user" });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.voided", targetType: "customer_invoice", targetId: id, result: "success", metadata: { number: row.number } }, db);
    return detailFor(db, ctx.org.orgId, (await loadInvoiceRow(db, ctx.org.orgId, id)) as InvoiceRow, org.timezone);
  });
}

/**
 * Writes off what is still owed on an issued invoice: the business gives up collecting it. Final, owner only, with a reason. A write-off is never revenue: it
 * records a loss of the receivable and changes no payment. A late payment can still be recorded after it.
 */
export async function writeOffInvoice(ctx: OrgContext, id: string, rawInput: unknown): Promise<InvoiceDetail> {
  const { reason } = reasonSchema.parse(rawInput);
  return withSystem(async (db) => {
    await authorize(db, ctx, "invoices.refund", "Only the business owner can write an invoice off.");
    const org = await orgFacts(db, ctx.org.orgId);
    const row = await loadInvoiceRow(db, ctx.org.orgId, id, true);
    if (!row) throw notFound();
    if (row.status !== "issued") throw new AppError("conflict", "Only an issued invoice can be written off.");
    if (row.written_off_at) throw new AppError("conflict", "This invoice was already written off.");
    if (toMinor(row.balance_minor) <= 0) throw new AppError("conflict", "Nothing is owed on this invoice, so there is nothing to write off.");
    await db.query("update customer_invoices set written_off_at = now(), written_off_by = $3, write_off_reason = $4 where id = $1 and org_id = $2", [id, ctx.org.orgId, ctx.user.id, reason.trim()]);
    await stopReminders(db, ctx.org.orgId, "written_off", id);
    await addInvoiceEvent(db, ctx.org.orgId, id, "written_off", { id: ctx.user.id, kind: "user" }, { number: row.number, balance: toDecimalString(toMinor(row.balance_minor), row.currency), currency: row.currency, reason: reason.trim().slice(0, 200) });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.written_off", targetType: "customer_invoice", targetId: id, result: "success", metadata: { number: row.number, balance: toDecimalString(toMinor(row.balance_minor), row.currency), currency: row.currency } }, db);
    return detailFor(db, ctx.org.orgId, (await loadInvoiceRow(db, ctx.org.orgId, id)) as InvoiceRow, org.timezone);
  });
}
