import { formatMinor, toDecimalString, type CurrencyCode } from "@/lib/money";
import { DELIVERY_CHANNEL_WORDS, type DeliveryChannel } from "@/lib/invoices/delivery-text";
import { INVOICE_WITHDRAWN_REASON_TEXT, type InvoiceWithdrawReason } from "@/lib/invoices/delivery-state";

// The words the invoice screens use for what the records say. Pure. A kind this file does not know is shown as plain words made from its name, never hidden: the
// history is the record, and a record the screen cannot name is still a record.

const WHEN = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** "2026-11-06" -> "Nov 6, 2026". A plain day has no time zone, so it is read as a day and never shifted. */
export function formatDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const [y, m, d] = day.split("-").map(Number);
  return WHEN.format(new Date(Date.UTC(y, m - 1, d)));
}

/** An instant in the workspace's time zone, e.g. "Nov 6, 2026, 9:05 AM". */
export function formatInstant(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }).format(t);
  } catch {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(t);
  }
}

export const money = (minor: number, currency: CurrencyCode) => formatMinor(minor, currency, "symbol");
export const moneyCode = (minor: number, currency: CurrencyCode) => formatMinor(minor, currency, "code");
/** For a form field: 1500 PHP -> "1500.00" (no symbol, no grouping), the way parseAmount reads it back. */
export const amountText = (minor: number, currency: CurrencyCode) => toDecimalString(minor, currency);

/** The badge for a draft a person did not type, or null for one they did. Anything this does not know is said as "something else", never as a deal. */
export function madeByText(via: string): string | null {
  switch (via) {
    case "manual": return null;
    case "workflow": return "Made by an automation";
    case "deal": return "Made by a deal";
    case "proposal": return "Made from a proposal";
    default: return "Made by something else";
  }
}

type Detail = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** The first line of the history of an invoice made from a proposal: where it came from and what was and was not copied. */
function fromProposalSentence(d: Detail): string {
  const copied = count(d.lines);
  const left = count(d.recurringLines);
  const from = str(d.proposalNumber) ? `proposal ${str(d.proposalNumber)}${count(d.proposalVersion) ? ` (version ${count(d.proposalVersion)})` : ""}` : "a proposal";
  return `Draft made from ${from}: ${copied} ${copied === 1 ? "line" : "lines"} the customer pays once ${copied === 1 ? "was" : "were"} copied.${left ? ` ${left} monthly or yearly ${left === 1 ? "line was" : "lines were"} not copied.` : ""}`;
}

/** One sentence for an entry of an invoice's history. The detail holds ids, numbers, amounts and short labels only (never a customer's details), and so does the sentence. */
export function eventSentence(kind: string, d: Detail): string {
  const amount = str(d.amount) && str(d.currency) ? `${str(d.currency)} ${str(d.amount)}` : "";
  switch (kind) {
    case "created": return d.via === "proposal" ? fromProposalSentence(d) : "Draft created.";
    case "edited": return "Draft edited.";
    case "submitted": return "Sent for approval.";
    case "withdrawn": return "Taken back to a draft.";
    case "changes_requested": return `Changes requested${str(d.note) ? `: ${str(d.note)}` : "."}`;
    case "approved": return "Approved.";
    case "issued": return `Issued${str(d.number) ? ` as ${str(d.number)}` : ""}${amount ? ` for ${amount}` : ""}.`;
    case "link_shown": return "The customer's link was shown to a team member.";
    case "link_rotated": return "The customer's link was replaced. The old link stopped working.";
    case "delivery_queued": {
      const word = Object.hasOwn(DELIVERY_CHANNEL_WORDS, str(d.channel)) ? DELIVERY_CHANNEL_WORDS[str(d.channel) as DeliveryChannel] : "a message";
      return `A message with the customer's link was queued, to go by ${word}${str(d.waitingUntil) ? " when sending hours open" : ""}. The list of messages shows where it went and what became of it.`;
    }
    case "delivery_withdrawn": {
      const n = Number(d.count) || 1;
      const why = Object.hasOwn(INVOICE_WITHDRAWN_REASON_TEXT, str(d.reason)) ? INVOICE_WITHDRAWN_REASON_TEXT[str(d.reason) as InvoiceWithdrawReason] : "";
      return `${n === 1 ? "A message that had not gone out was" : `${n} messages that had not gone out were`} stopped. ${why}`.trim();
    }
    case "viewed": return "The customer opened the invoice.";
    case "checkout_started": return `A payment page was opened${amount ? ` for ${amount}` : ""}.`;
    case "payment_verified": return `${str(d.provider) === "simulated" ? "A test payment" : "A payment"} was confirmed by the payment provider${amount ? `: ${amount}` : ""}.${d.livemode === false ? " Test mode: no real money moved." : ""}`;
    case "manual_payment_recorded": return `A payment was recorded by hand${amount ? `: ${amount}` : ""}.`;
    case "payment_failed": return `A payment attempt did not go through${amount ? ` (${amount})` : ""}.`;
    case "payment_needs_review": return `A payment was kept for review and not counted${amount ? ` (${amount})` : ""}.`;
    case "paid": return "Paid in full.";
    case "overpaid": return `Paid more than the invoice total${str(d.overpaid) ? ` (${str(d.currency)} ${str(d.overpaid)} extra)` : ""}. Nothing was refunded.`;
    case "refund_recorded": return `A refund was recorded${amount ? `: ${amount}` : ""}.`;
    case "dispute_opened": return "The customer disputed a payment with their bank.";
    case "dispute_closed": return d.outcome === "won" ? "A payment dispute was closed in your favour. The money stays received." : d.outcome === "lost" ? `A payment dispute was lost${str(d.lost) && str(d.currency) ? `: ${str(d.currency)} ${str(d.lost)} was taken back` : ""}.` : "A payment dispute was closed.";
    case "dispute_result_unknown": return "A payment dispute was closed, but how it ended is not known. The payment stays disputed until you record the result.";
    case "refund_matched": return `A refund the payment provider reported matched one recorded by hand${amount ? ` (${amount})` : ""}. It is counted once.`;
    case "overdue": return "The invoice became overdue.";
    case "voided": return `Voided${str(d.reason) ? `: ${str(d.reason)}` : "."}`;
    case "written_off": return `Written off${str(d.reason) ? `: ${str(d.reason)}` : "."}`;
    case "credit_note_created": return `A credit note was drafted${amount ? ` for ${amount}` : ""}. Nothing is taken off the invoice until it is approved and issued.`;
    case "credit_note_edited": return `A draft credit note was edited${amount ? ` (${amount})` : ""}.`;
    case "credit_note_submitted": return "A credit note was sent for approval.";
    case "credit_note_withdrawn": return "A credit note was taken back to a draft.";
    case "credit_note_returned": return `A credit note was sent back${str(d.note) ? `: ${str(d.note)}` : "."}`;
    case "credit_note_cancelled": return `A credit note was cancelled before it was issued${str(d.reason) ? `: ${str(d.reason)}` : "."}`;
    case "credit_note_issued": return `Credit note ${str(d.number) || "issued"}${amount ? ` for ${amount}` : ""} was issued.${str(d.owed) && str(d.currency) ? ` ${str(d.currency)} ${str(d.owed)} is still owed.` : ""}`;
    case "reminder_queued": return "A reminder was handed to the message queue.";
    case "reminder_blocked": return `A reminder was blocked${str(d.why) ? `: ${str(d.why)}` : "."}`;
    case "reminder_not_sent": return "A reminder was not sent.";
    case "reminders_stopped": return "Scheduled reminders were stopped.";
    case "close_rule_applied": return "The owner's rule for the linked deal was applied.";
    case "effect_failed": return "Something that follows this change (a notice or an automation) could not run. The invoice itself is unaffected.";
    case "customer_details_erased": return "The customer's details were erased on request. Amounts and numbers were kept.";
    default: return kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) + ".";
  }
}

export const PROVIDER_NAMES: Record<string, string> = { paymongo: "PayMongo", paypal: "PayPal", simulated: "Simulated provider (testing)", manual: "Recorded by hand" };

export const PAYMENT_ROW_LABELS: Record<string, string> = {
  succeeded: "Received", pending: "Pending", failed: "Failed", needs_review: "Needs a look", partially_refunded: "Partly refunded", refunded: "Refunded", disputed: "Disputed",
};

export const REFUND_SOURCE_LABELS: Record<string, string> = {
  provider_event: "Reported by the payment provider", manual_record: "Recorded by hand", chargeback: "Chargeback", api_initiated: "Started from this product",
};

/** "e_wallet" -> "E-wallet" style for the method a person chose; other values are made readable. */
export function methodLabel(method: string | null | undefined): string {
  if (!method) return "";
  const known: Record<string, string> = { bank_transfer: "Bank transfer", cash: "Cash", check: "Check", card_terminal: "Card, on your own terminal", e_wallet: "E-wallet", other: "Other", card: "Card", simulated: "Test checkout" };
  return known[method] ?? method.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
