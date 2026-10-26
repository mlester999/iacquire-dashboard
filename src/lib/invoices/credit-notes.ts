import { formatMinor, isCurrency, taxPortion, type CurrencyCode } from "@/lib/money";
import { NUMBER_PADDING } from "@/lib/invoices/number";
import type { InvoicePaymentStatus, InvoiceStatus } from "@/lib/invoices/state";

// Credit notes on a client's customer invoices, as pure rules. The server enforces these, the database enforces the same arithmetic and the same states, and the screens only read them.
//
// A credit note reduces what a customer still owes on ONE issued invoice. It is not money received and not a refund: it never counts as a payment, as revenue, or as a reason to close a
// deal. It can only take off the part of the invoice that is still unpaid, so a balance never goes negative and nothing is owed back; handing money back stays a refund of a payment.
// Once issued it is immutable and cannot be voided: a correction is a new invoice. The wording of the document and the tax treatment of a credit are not approved by counsel.

export const CREDIT_STATUSES = ["draft", "pending_approval", "issued", "cancelled"] as const;
export type CreditNoteStatus = (typeof CREDIT_STATUSES)[number];

export const CREDIT_STATUS_LABELS: Record<CreditNoteStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  issued: "Issued",
  cancelled: "Cancelled",
};

/** One line saying what a status means, never softer than the truth. */
export const CREDIT_STATUS_EXPLAIN: Record<CreditNoteStatus, string> = {
  draft: "Not issued yet. The amount and reason can still change, and nothing is taken off the invoice.",
  pending_approval: "The owner or a manager has to look at this exact version before it is issued. Nothing is taken off the invoice yet.",
  issued: "Issued with its number. It has taken its amount off what the customer owes, and it can no longer be changed, deleted or voided.",
  cancelled: "Cancelled before it was issued. It never took anything off the invoice.",
};

const NEXT: Record<CreditNoteStatus, readonly CreditNoteStatus[]> = {
  draft: ["pending_approval", "issued", "cancelled"],
  pending_approval: ["draft", "issued", "cancelled"],
  issued: [],
  cancelled: [],
};

/** The same table the database trigger enforces. */
export const canTransitionCredit = (from: CreditNoteStatus, to: CreditNoteStatus) => NEXT[from].includes(to);
export const isEditableCredit = (s: CreditNoteStatus) => s === "draft";
export const isFinalCredit = (s: CreditNoteStatus) => s === "issued" || s === "cancelled";

export const CREDIT_REASON_MIN = 5;
export const CREDIT_REASON_MAX = 400;

/** The reason the person gives, trimmed; the problem with it, if any. */
export function creditReasonProblem(reason: unknown): string | null {
  if (typeof reason !== "string") return "Say why the invoice is being credited.";
  const r = reason.trim();
  if (r.length < CREDIT_REASON_MIN) return `Say why the invoice is being credited (at least ${CREDIT_REASON_MIN} characters). It is kept on the credit note.`;
  if (r.length > CREDIT_REASON_MAX) return `Keep the reason to ${CREDIT_REASON_MAX} characters.`;
  return null;
}

export interface CreditBasis {
  invoiceStatus: InvoiceStatus;
  isTest: boolean;
  writtenOff: boolean;
  paymentStatus: InvoicePaymentStatus;
  /** What is still owed on the invoice (total less credits less payments). */
  balanceMinor: number;
  /** A payment that is waiting, being reviewed, or a checkout a customer may be paying through: the amount they are paying would no longer be what is owed. */
  hasOpenPayment: boolean;
}

/** Why no credit note can be written or issued on this invoice right now, or null. Each is a sentence a person can act on. */
export function creditBlockedReason(f: CreditBasis): string | null {
  if (f.invoiceStatus !== "issued") return f.invoiceStatus === "void" ? "This invoice is void, so there is nothing to credit." : "Only an issued invoice can be credited.";
  if (f.isTest) return "This is a test invoice: nothing is owed on it, so it cannot be credited.";
  if (f.writtenOff) return "This invoice was written off, so there is nothing left to credit.";
  if (f.paymentStatus === "disputed") return "A payment on this invoice is under dispute. Settle that before crediting it.";
  if (f.balanceMinor <= 0) return "Nothing is owed on this invoice, so there is nothing to credit. If money was received that should go back, record a refund instead.";
  if (f.hasOpenPayment) return "A customer may be paying this invoice, or a payment is waiting for review. Resolve that first, so the amount they pay is the amount owed.";
  return null;
}

/** Why this amount cannot be a credit on an invoice with this much owed, or null. Whole minor units, more than zero, and no more than is still owed. */
export function creditAmountProblem(amountMinor: number, balanceMinor: number, currency?: CurrencyCode): string | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return "Enter the amount to credit.";
  if (amountMinor > balanceMinor) {
    const owed = currency && isCurrency(currency) ? ` (${formatMinor(balanceMinor, currency, "code")})` : "";
    return `A credit note can only take off what is still owed${owed}. If money was received that should go back, record a refund instead.`;
  }
  return null;
}

export interface CreditAuthorityFacts {
  status: CreditNoteStatus;
  /** Holds invoices.approve. */
  canApprove: boolean;
  /** Wrote the draft. */
  isAuthor: boolean;
  /** The business owner, who can approve their own. */
  isOwner: boolean;
}

/** Why this person cannot approve and issue this credit note, or null. Whoever wrote it cannot approve it unless they are the owner, so a credit always has a second pair of eyes. */
export function creditApproveBlockedReason(f: CreditAuthorityFacts): string | null {
  if (f.status === "issued") return "This credit note is already issued.";
  if (f.status === "cancelled") return "A cancelled credit note cannot be issued.";
  if (!f.canApprove) return "Only the business owner or a manager can approve and issue a credit note.";
  if (f.isAuthor && !f.isOwner) return "You wrote this credit note, so the owner or another manager has to approve it.";
  return null;
}

/** Who may change a draft credit note: the person who wrote it, or someone who can approve. */
export const canEditCredit = (f: { canCredit: boolean; canApprove: boolean; isAuthor: boolean }) => f.canCredit && (f.isAuthor || f.canApprove);

/** "CN-" and 7 become "CN-0007"; past four digits it simply grows. */
export function formatCreditNumber(prefix: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("A credit note number counts from 1.");
  return `${prefix}${String(n).padStart(NUMBER_PADDING, "0")}`;
}

/** The part of the invoice's tax that is in this credit, in proportion, rounded once. Reports that leave tax out take it off. Zero for an invoice with no tax. */
export function creditTaxPortion(amountMinor: number, invoiceTaxMinor: number, invoiceTotalMinor: number): number {
  return taxPortion(amountMinor, invoiceTaxMinor, invoiceTotalMinor);
}

export interface CreditSummary {
  /** The invoice's total, what was credited and what was paid. */
  totalMinor: number;
  creditedMinor: number;
  paidMinor: number;
  /** What the customer owes now. */
  owedMinor: number;
}

export const creditSummary = (totalMinor: number, creditedMinor: number, paidMinor: number): CreditSummary => ({
  totalMinor, creditedMinor, paidMinor, owedMinor: Math.max(totalMinor - creditedMinor - paidMinor, 0),
});
