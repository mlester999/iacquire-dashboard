import "server-only";
import type { Queryable } from "@/server/db";
import { formatQuantity, type CurrencyCode } from "@/lib/money";
import { daysOverdue, isOverdue, type InvoicePaymentStatus, type InvoiceStatus } from "@/lib/invoices/state";
import { iso, loadLines, toMinor, type InvoiceRow, type LineRow } from "@/server/invoices/core";

// How an invoice looks to the screens: names resolved, amounts as integers in the currency's minor unit, dates as plain days or ISO instants. Nothing sealed, no
// link hash and no customer link is in a view.

export interface InvoiceLineView {
  id: string;
  position: number;
  description: string;
  quantity: string;
  quantityMilli: number;
  unitPriceMinor: number;
  discountBps: number | null;
  discountMinor: number;
  taxRateBps: number | null;
  grossMinor: number;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
  exTaxMinor: number;
}

export interface InvoiceView {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  paymentStatus: InvoicePaymentStatus;
  currency: CurrencyCode;
  taxInclusive: boolean;
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  balanceMinor: number;
  overpaidMinor: number;
  issueOn: string | null;
  dueOn: string | null;
  billTo: Record<string, unknown>;
  billFrom: Record<string, unknown>;
  paymentInstructions: string | null;
  notes: string | null;
  terms: string | null;
  version: number;
  approvedVersion: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
  closesDeal: boolean;
  writtenOffAt: string | null;
  writeOffReason: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  firstViewedAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdVia: "manual" | "workflow" | "deal";
  createdAt: string;
  updatedAt: string;
  overdue: boolean;
  daysOverdue: number;
}

export const lineView = (r: LineRow): InvoiceLineView => ({
  id: r.id, position: r.position, description: r.description, quantity: formatQuantity(r.quantity_milli), quantityMilli: r.quantity_milli, unitPriceMinor: toMinor(r.unit_price_minor),
  discountBps: r.discount_bps, discountMinor: toMinor(r.discount_minor), taxRateBps: r.tax_rate_bps, grossMinor: toMinor(r.gross_minor), netMinor: toMinor(r.net_minor),
  taxMinor: toMinor(r.tax_minor), totalMinor: toMinor(r.total_minor), exTaxMinor: toMinor(r.ex_tax_minor),
});

/** Views for rows already loaded, with the names of the people and records they point at. `tz` is the workspace's zone, for what counts as overdue. */
export async function viewsFor(db: Queryable, orgId: string, rows: InvoiceRow[], tz: string, now = new Date()): Promise<InvoiceView[]> {
  if (!rows.length) return [];
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((x): x is string => Boolean(x)))];
  const companyIds = [...new Set(rows.map((r) => r.company_id).filter((x): x is string => Boolean(x)))];
  const dealIds = [...new Set(rows.map((r) => r.opportunity_id).filter((x): x is string => Boolean(x)))];
  const userIds = [...new Set(rows.flatMap((r) => [r.created_by, r.approved_by]).filter((x): x is string => Boolean(x)))];
  const contacts = new Map((contactIds.length ? (await db.query<{ id: string; name: string }>(
    "select id, coalesce(nullif(display_name, ''), email::text, phone, 'Unnamed contact') as name from contacts where org_id = $1 and id = any($2::uuid[])", [orgId, contactIds])).rows : []).map((c) => [c.id, c.name]));
  const companies = new Map((companyIds.length ? (await db.query<{ id: string; name: string }>("select id, name from crm_companies where org_id = $1 and id = any($2::uuid[])", [orgId, companyIds])).rows : []).map((c) => [c.id, c.name]));
  const deals = new Map((dealIds.length ? (await db.query<{ id: string; name: string }>("select id, name from crm_opportunities where org_id = $1 and id = any($2::uuid[])", [orgId, dealIds])).rows : []).map((c) => [c.id, c.name]));
  const users = new Map((userIds.length ? (await db.query<{ id: string; full_name: string }>("select id, full_name from users where id = any($1::uuid[])", [userIds])).rows : []).map((u) => [u.id, u.full_name]));
  return rows.map((r): InvoiceView => {
    const overdueFacts = { status: r.status, paymentStatus: r.payment_status, dueOn: r.due_on, writtenOff: r.written_off_at !== null };
    const overdue = isOverdue(overdueFacts, now, tz);
    return {
      id: r.id, number: r.number, status: r.status, paymentStatus: r.payment_status, currency: r.currency, taxInclusive: r.tax_inclusive,
      contactId: r.contact_id, contactName: r.contact_id ? contacts.get(r.contact_id) ?? null : null, companyId: r.company_id, companyName: r.company_id ? companies.get(r.company_id) ?? null : null,
      opportunityId: r.opportunity_id, opportunityName: r.opportunity_id ? deals.get(r.opportunity_id) ?? null : null,
      subtotalMinor: toMinor(r.subtotal_minor), taxMinor: toMinor(r.tax_minor), totalMinor: toMinor(r.total_minor), paidMinor: toMinor(r.paid_minor), refundedMinor: toMinor(r.refunded_minor),
      balanceMinor: toMinor(r.balance_minor), overpaidMinor: toMinor(r.overpaid_minor), issueOn: r.issue_on, dueOn: r.due_on, billTo: r.bill_to, billFrom: r.bill_from,
      paymentInstructions: r.payment_instructions, notes: r.notes, terms: r.terms, version: r.version, approvedVersion: r.approved_version,
      approvedByName: r.approved_by ? users.get(r.approved_by) ?? null : null, approvedAt: iso(r.approved_at), closesDeal: r.closes_deal, writtenOffAt: iso(r.written_off_at),
      writeOffReason: r.write_off_reason, issuedAt: iso(r.issued_at), voidedAt: iso(r.voided_at), voidReason: r.void_reason, firstViewedAt: iso(r.first_viewed_at), createdBy: r.created_by,
      createdByName: r.created_by ? users.get(r.created_by) ?? null : null, createdVia: r.created_via, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
      overdue, daysOverdue: overdue ? daysOverdue(r.due_on, now, tz) : 0,
    };
  });
}

export interface InvoiceDetail {
  invoice: InvoiceView;
  lines: InvoiceLineView[];
}

export async function detailFor(db: Queryable, orgId: string, row: InvoiceRow, tz: string, now = new Date()): Promise<InvoiceDetail> {
  const [invoice] = await viewsFor(db, orgId, [row], tz, now);
  return { invoice, lines: (await loadLines(db, orgId, row.id)).map(lineView) };
}
