import { addDays, isValidTimeZone, zonedDate } from "@/lib/calendars/slots";

// The life of a customer invoice, what counts as paid, overdue or owed, and who may issue one. Pure: the server enforces these rules (the database enforces the
// same transitions and the same arithmetic), and the interface only reads them.

export const INVOICE_STATUSES = ["draft", "pending_approval", "issued", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * What the payments and credits add up to. "paid": some money arrived and nothing is left to pay once the credit is taken off. "credited": the whole invoice was credited and nothing was
 * paid (a credit note is not a payment, so this never announces a payment or closes a deal).
 */
export const PAYMENT_STATUSES = ["unpaid", "partially_paid", "paid", "disputed", "credited"] as const;
export type InvoicePaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Where a draft came from: typed by a person, made by an automation, made from a deal, or made from an accepted proposal. Only a person's own typed draft can be issued without an approver. */
export type InvoiceCreatedVia = "manual" | "workflow" | "deal" | "proposal";

export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  issued: "Issued",
  void: "Void",
};

/** One line saying what a status means, for the person looking at it. Never softer than the truth. */
export const STATUS_EXPLAIN: Record<InvoiceStatus, string> = {
  draft: "Not issued yet. The amounts and wording can still change.",
  pending_approval: "The owner or a manager has to look at this exact version before it is issued.",
  issued: "Issued with its number. The amounts, dates and wording can no longer change.",
  void: "Cancelled. It keeps its number and nothing can be paid against it.",
};

export const PAYMENT_STATUS_LABELS: Record<InvoicePaymentStatus, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partly paid",
  paid: "Paid",
  disputed: "Disputed",
  credited: "Credited",
};

const NEXT: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ["pending_approval", "issued"],
  pending_approval: ["draft", "issued"],
  issued: ["void"],
  void: [],
};

/** The same table the database trigger enforces. */
export const canTransition = (from: InvoiceStatus, to: InvoiceStatus) => NEXT[from].includes(to);

/** Only a draft can be edited. A submitted invoice goes back to draft first, which also voids the submission. */
export const isEditable = (s: InvoiceStatus) => s === "draft";

/** Whether the money columns of the invoice hold anything: only an issued invoice (or a void one that never took a payment) can. */
export const takesPayments = (s: InvoiceStatus) => s === "issued";

export interface PaymentFacts {
  totalMinor: number;
  /** Everything received that counts (succeeded, part or fully refunded, or disputed), before refunds. */
  paidMinor: number;
  /** Any received payment the customer has disputed with their bank. */
  hasDispute: boolean;
  /** The issued credit notes against the invoice (none when absent). They reduce what is owed; they are not money received. */
  creditedMinor?: number;
}

/** What the payments add up to. The database computes the same thing and refuses any other value. */
export function derivePaymentStatus(f: PaymentFacts): InvoicePaymentStatus {
  const credited = f.creditedMinor ?? 0;
  if (f.hasDispute) return "disputed";
  if (f.paidMinor > 0 && f.paidMinor + credited >= f.totalMinor) return "paid";
  if (credited >= f.totalMinor && f.totalMinor > 0) return "credited";
  if (f.paidMinor > 0) return "partially_paid";
  return "unpaid";
}

/** What is still owed: the total less the credit and less what was paid. Never negative. */
export const balanceMinor = (totalMinor: number, paidMinor: number, creditedMinor = 0) => Math.max(totalMinor - creditedMinor - paidMinor, 0);
/** What was paid beyond what was owed after the credit. */
export const overpaidMinor = (totalMinor: number, paidMinor: number, creditedMinor = 0) => Math.max(paidMinor - (totalMinor - creditedMinor), 0);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !DAY.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  // A day that does not exist (February 31) would roll over into the next month, so it is compared back.
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Today's date in the workspace's time zone (a business in Manila is not overdue an hour early because the server runs in UTC). */
export function todayIn(now: Date, tz: string): string {
  return zonedDate(now.getTime(), isValidTimeZone(tz) ? tz : "UTC");
}

const dayNumber = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

export interface OverdueFacts {
  status: InvoiceStatus;
  paymentStatus: InvoicePaymentStatus;
  dueOn: string | null;
  writtenOff: boolean;
  /** A test invoice: nothing is owed on it, so it is never overdue. */
  isTest?: boolean;
}

/**
 * Overdue: issued, still owing, not written off, not under dispute, not a test invoice, and the due date is before today in the workspace's time zone. The due day itself is not
 * overdue. Nothing here claims to be live: it is true when it is read, and the sweep that raises the notice runs only when the scheduler does.
 */
export function isOverdue(f: OverdueFacts, now: Date, tz: string): boolean {
  if (f.status !== "issued" || f.writtenOff || f.isTest || !f.dueOn || !isDay(f.dueOn)) return false;
  if (f.paymentStatus !== "unpaid" && f.paymentStatus !== "partially_paid") return false;
  return f.dueOn < todayIn(now, tz);
}

/** Whole days past the due date in the workspace's zone (0 on the due day and before). */
export function daysOverdue(dueOn: string | null, now: Date, tz: string): number {
  if (!dueOn || !isDay(dueOn)) return 0;
  return Math.max(dayNumber(todayIn(now, tz)) - dayNumber(dueOn), 0);
}

/** The due date for an invoice issued on a day, from the workspace's payment terms. */
export const dueFromTerms = (issueOn: string, termsDays: number) => addDays(issueOn, termsDays);

export interface InvoiceProblem {
  code: "no_customer" | "no_lines" | "zero_total" | "due_before_issue" | "no_number";
  message: string;
}

export interface ProblemFacts {
  contactId: string | null;
  lineCount: number;
  totalMinor: number;
  /** The due date the draft carries, if it has one, and the day it would be issued on. */
  dueOn: string | null;
  issueOn: string;
}

/** What stops an invoice being sent for approval or issued. Each is a sentence a person can act on. */
export function invoiceProblems(f: ProblemFacts): InvoiceProblem[] {
  const out: InvoiceProblem[] = [];
  if (!f.contactId) out.push({ code: "no_customer", message: "Choose the customer this invoice is for." });
  if (f.lineCount === 0) out.push({ code: "no_lines", message: "Add at least one line." });
  else if (f.totalMinor <= 0) out.push({ code: "zero_total", message: "The invoice total must be more than zero." });
  if (f.dueOn && f.dueOn < f.issueOn) out.push({ code: "due_before_issue", message: "The due date is before the day the invoice would be issued. Choose a later due date." });
  return out;
}

export interface IssueAuthorityFacts {
  status: InvoiceStatus;
  canApprove: boolean;
  canCreate: boolean;
  isAuthor: boolean;
  createdVia: InvoiceCreatedVia;
  /** customer_invoice_settings.approval_required_for_creators. */
  approvalRequiredForCreators: boolean;
}

/**
 * Why this person cannot issue this invoice, or null when they can. The owner and managers (who may approve) issue any submitted or draft invoice. Somebody who
 * may only create invoices can issue their own draft only when the owner switched approval off for creators; an invoice a workflow, a deal or an accepted proposal made is never
 * issued without an approver, whatever the setting.
 */
export function issueBlockedReason(f: IssueAuthorityFacts): string | null {
  if (f.status === "issued") return "This invoice is already issued.";
  if (f.status === "void") return "A void invoice cannot be issued.";
  if (f.canApprove) return null;
  if (f.canCreate && f.status === "draft" && f.isAuthor && f.createdVia === "manual" && !f.approvalRequiredForCreators) return null;
  if (f.canCreate) return "This invoice needs the owner's or a manager's approval before it can be issued. Send it for approval.";
  return "Only the business owner or a manager can approve and issue an invoice.";
}

/** Who may change a draft: the person who wrote it, or someone who can approve invoices. */
export const canEditDraft = (f: { canCreate: boolean; canApprove: boolean; isAuthor: boolean }) => f.canCreate && (f.isAuthor || f.canApprove);

export interface VoidFacts {
  status: InvoiceStatus;
  paidMinor: number;
  /** The issued credit notes against the invoice: an invoice that was credited cannot be voided, the credit would point at nothing. */
  creditedMinor?: number;
  /** A payment that is waiting, being reviewed, or an open checkout a customer may be paying through. */
  hasOpenPayment: boolean;
  /** A test invoice has only test payments, so none of what blocks a real invoice applies. */
  isTest?: boolean;
}

/** Why an invoice cannot be voided, or null. A voided invoice that took money would hide it. A test invoice took none, whatever its test payments say. */
export function voidBlockedReason(f: VoidFacts): string | null {
  if (f.status !== "issued") return f.status === "void" ? "This invoice is already void." : "Only an issued invoice can be voided. A draft can be discarded.";
  if (f.isTest) return null;
  if (f.paidMinor > 0) return "This invoice has a payment recorded against it, so it cannot be voided. Record a refund instead.";
  if ((f.creditedMinor ?? 0) > 0) return "A credit note was issued against this invoice, so it cannot be voided. Issue a new invoice for any correction.";
  if (f.hasOpenPayment) return "A customer may be paying this invoice, or a payment is waiting for review. Resolve that first.";
  return null;
}
