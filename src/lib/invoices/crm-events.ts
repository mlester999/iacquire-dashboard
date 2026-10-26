import { formatMinor, toDecimalString, type CurrencyCode } from "@/lib/money";
import { dayWords } from "@/lib/invoices/reminder-text";

// What an invoice or a payment announces to the rest of the CRM (the event outbox Automation Studio starts workflows from, and the timeline of the customer and the deal).
// Pure: the names, the keys that make each announcement happen once, what each carries, and the line it leaves on the timeline.
//
// An announcement carries ids and amounts and nothing else: no name, email, phone or address of the customer, no card, no provider's identifiers, no wording. The customer is
// the event's own contact and the deal rides in the payload, so a workflow can act on them without the payload holding who they are.

export const INVOICE_EVENT_TYPES = [
  "invoice.created", "invoice.issued", "invoice.paid", "invoice.overdue", "invoice.voided", "payment.verified", "payment.failed", "payment.refunded",
] as const;
export type InvoiceEventType = (typeof INVOICE_EVENT_TYPES)[number];

/** A line on the timeline for something a person recorded by hand: not an event, because nothing the provider confirmed happened. */
export type TimelineOnlyKind = "payment.recorded";

export interface AnnounceFacts {
  invoiceId: string;
  number: string | null;
  currency: CurrencyCode;
  totalMinor: number;
  opportunityId: string | null;
  dueOn?: string | null;
  balanceMinor?: number;
  daysOverdue?: number;
  /** The payment, refund or attempt the announcement is about, and the amount of it. */
  paymentId?: string | null;
  refundId?: string | null;
  attemptId?: string | null;
  /** The provider's id for the delivery that reported a failure that has no payment of its own. Used only to make the announcement happen once. */
  providerEventId?: string | null;
  amountMinor?: number;
  verification?: "provider_confirmed" | "manual";
  /** false for a provider's test mode: no real money moved. */
  livemode?: boolean;
  /** The invoice is a test invoice: nothing is owed on it, so nothing it does starts anything and its lines on the timeline say so. */
  isTest?: boolean;
}

/** The only keys a payload may have. A test keeps every announcement inside this list. */
export const PAYLOAD_KEYS = [
  "invoiceId", "number", "currency", "total", "balance", "dueOn", "daysOverdue", "opportunityId", "paymentId", "refundId", "attemptId", "amount", "verification", "livemode",
] as const;

const dec = (minor: number | undefined, currency: CurrencyCode) => (minor === undefined ? null : toDecimalString(minor, currency));

export function payloadFor(type: InvoiceEventType, f: AnnounceFacts): Record<string, string | number | boolean | null> {
  const base: Record<string, string | number | boolean | null> = { invoiceId: f.invoiceId, number: f.number, currency: f.currency, total: dec(f.totalMinor, f.currency), opportunityId: f.opportunityId };
  switch (type) {
    case "invoice.created":
    case "invoice.voided":
      return base;
    case "invoice.issued":
      return { ...base, dueOn: f.dueOn ?? null };
    case "invoice.overdue":
      return { ...base, dueOn: f.dueOn ?? null, balance: dec(f.balanceMinor, f.currency), daysOverdue: f.daysOverdue ?? null };
    case "invoice.paid":
      return { ...base, paymentId: f.paymentId ?? null, verification: f.verification ?? null, livemode: f.livemode ?? true };
    case "payment.verified":
    case "payment.failed":
      return { ...base, paymentId: f.paymentId ?? null, attemptId: f.attemptId ?? null, amount: dec(f.amountMinor, f.currency), verification: f.verification ?? null, livemode: f.livemode ?? true };
    case "payment.refunded":
      return { ...base, paymentId: f.paymentId ?? null, refundId: f.refundId ?? null, amount: dec(f.amountMinor, f.currency), livemode: f.livemode ?? true };
  }
}

/** The key that makes an announcement happen once, however many times the code that raises it runs. */
export function dedupeKeyFor(type: InvoiceEventType, f: AnnounceFacts): string {
  switch (type) {
    case "invoice.created": case "invoice.issued": case "invoice.paid": case "invoice.voided":
      return `${type}:${f.invoiceId}`;
    case "invoice.overdue":
      return `${type}:${f.invoiceId}:${f.dueOn ?? "none"}`;
    case "payment.verified":
      return `${type}:${f.paymentId ?? f.invoiceId}`;
    case "payment.failed":
      return f.paymentId ? `${type}:${f.paymentId}` : `${type}:${f.attemptId ?? f.invoiceId}:${f.providerEventId ?? "none"}`;
    case "payment.refunded":
      return `${type}:${f.refundId ?? f.invoiceId}`;
  }
}

/**
 * Whether the announcement may start a workflow. Money that moved in a provider's test mode, and everything about a test invoice, is a test: it is on the timeline, labelled,
 * but never starts something that would message a customer or change a deal. Everything else is announced.
 */
export const startsAutomations = (_type: InvoiceEventType, f: AnnounceFacts): boolean => f.livemode !== false && f.isTest !== true;

export function activityFor(type: InvoiceEventType | TimelineOnlyKind, f: AnnounceFacts): { kind: string; summary: string } {
  const out = activityLine(type, f);
  return f.isTest ? { kind: out.kind, summary: `${out.summary} (a test invoice: nothing is owed)`.slice(0, 300) } : out;
}

function activityLine(type: InvoiceEventType | TimelineOnlyKind, f: AnnounceFacts): { kind: string; summary: string } {
  const n = f.number ?? "(not numbered yet)";
  const money = formatMinor(f.amountMinor ?? f.totalMinor, f.currency, "code");
  const test = f.livemode === false ? " (test mode: no real money moved)" : "";
  switch (type) {
    case "invoice.created": return { kind: type, summary: f.totalMinor > 0 ? `Invoice draft started for ${formatMinor(f.totalMinor, f.currency, "code")}` : "Invoice draft started" };
    case "invoice.issued": return { kind: type, summary: `Invoice ${n} issued for ${formatMinor(f.totalMinor, f.currency, "code")}${f.dueOn ? `, due ${dayWords(f.dueOn)}` : ""}` };
    case "invoice.paid": return { kind: type, summary: `Invoice ${n} paid in full${f.verification === "manual" ? " (recorded by hand)" : ""}${test}` };
    case "invoice.overdue": return { kind: type, summary: `Invoice ${n} is overdue: ${formatMinor(f.balanceMinor ?? f.totalMinor, f.currency, "code")} was due ${f.dueOn ? dayWords(f.dueOn) : "earlier"}` };
    case "invoice.voided": return { kind: type, summary: `Invoice ${n} voided` };
    case "payment.verified": return { kind: type, summary: `Payment of ${money} for invoice ${n} confirmed by the payment provider${test}` };
    case "payment.recorded": return { kind: type, summary: `Payment of ${money} for invoice ${n} recorded by hand (not confirmed by a provider)` };
    case "payment.failed": return { kind: type, summary: `A payment${f.amountMinor ? ` of ${money}` : ""} for invoice ${n} failed; it is still owed${test}` };
    case "payment.refunded": return { kind: type, summary: `Refund of ${money} recorded on invoice ${n}${test}` };
  }
}
