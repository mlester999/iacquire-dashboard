import { formatMinor, toDecimalString, type CurrencyCode } from "@/lib/money";

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

type Detail = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One sentence for an entry of an invoice's history. The detail holds ids, numbers, amounts and short labels only (never a customer's details), and so does the sentence. */
export function eventSentence(kind: string, d: Detail): string {
  const amount = str(d.amount) && str(d.currency) ? `${str(d.currency)} ${str(d.amount)}` : "";
  switch (kind) {
    case "created": return "Draft created.";
    case "edited": return "Draft edited.";
    case "submitted": return "Sent for approval.";
    case "withdrawn": return "Taken back to a draft.";
    case "changes_requested": return `Changes requested${str(d.note) ? `: ${str(d.note)}` : "."}`;
    case "approved": return "Approved.";
    case "issued": return `Issued${str(d.number) ? ` as ${str(d.number)}` : ""}${amount ? ` for ${amount}` : ""}.`;
    case "link_shown": return "The customer's link was shown to a team member.";
    case "link_rotated": return "The customer's link was replaced. The old link stopped working.";
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
    case "dispute_closed": return "A payment dispute was closed.";
    case "overdue": return "The invoice became overdue.";
    case "voided": return `Voided${str(d.reason) ? `: ${str(d.reason)}` : "."}`;
    case "written_off": return `Written off${str(d.reason) ? `: ${str(d.reason)}` : "."}`;
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
