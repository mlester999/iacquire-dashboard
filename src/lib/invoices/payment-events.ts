import { isCurrency } from "@/lib/money";
import { REFERENCE_RE } from "@/lib/invoices/connection-rules";

// What a payment provider's webhook says, reduced to the facts that matter, and the rules for what each fact may do. Pure: the server stores these facts (never the raw
// body, which can carry a customer's name and email) and applies them under these rules.
//
// The one rule underneath all of them: money is counted only when every fact agrees. The mode of the event is the mode of the connection, the reference is one we
// issued on this connection, the provider's checkout id is the one we stored for that reference, and the amount and currency are exactly what the attempt asked
// for. Anything else is kept for a person to look at and counts for nothing.

export const EVENT_KINDS = ["payment.succeeded", "payment.failed", "payment.pending", "refund.succeeded", "refund.failed", "refund.pending", "dispute.opened", "dispute.closed", "ignored"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface NormalizedEvent {
  kind: EventKind;
  /** The provider's id for the event: the replay key. */
  eventId: string;
  /** The provider's own name for the event, for the record. */
  type: string;
  livemode: boolean;
  /** The provider's checkout id (PayMongo: the checkout session; PayPal: the order). */
  checkoutId: string | null;
  /** The reference this product issued for the attempt and the provider echoed back. */
  reference: string | null;
  /** The provider's payment id. */
  paymentId: string | null;
  refundId: string | null;
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
  method: string | null;
  /** A short reason: a refund's, a failure's, or why an event was ignored. */
  reason: string | null;
  /** When the provider says it happened, as an ISO instant. */
  occurredAt: string | null;
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);
const minor = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

export function emptyEvent(kind: EventKind, base: Pick<NormalizedEvent, "eventId" | "type" | "livemode">): NormalizedEvent {
  return { kind, ...base, checkoutId: null, reference: null, paymentId: null, refundId: null, amountMinor: null, currency: null, feeMinor: null, method: null, reason: null, occurredAt: null };
}

/** Reads facts back from a stored receipt. Returns null for anything that is not exactly the shape this code writes. */
export function readFacts(value: unknown): NormalizedEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!(EVENT_KINDS as readonly string[]).includes(v.kind as string) || typeof v.livemode !== "boolean") return null;
  const eventId = text(v.eventId, 200);
  const type = text(v.type, 120);
  if (!eventId || !type) return null;
  const currency = text(v.currency, 3);
  return {
    kind: v.kind as EventKind, eventId, type, livemode: v.livemode, checkoutId: text(v.checkoutId, 120), reference: text(v.reference, 60), paymentId: text(v.paymentId, 120),
    refundId: text(v.refundId, 120), amountMinor: minor(v.amountMinor), currency: currency && isCurrency(currency) ? currency : null, feeMinor: minor(v.feeMinor), method: text(v.method, 40),
    reason: text(v.reason, 200), occurredAt: text(v.occurredAt, 40),
  };
}

/** The facts as stored: short, no raw body, nothing about the payer. */
export function storableFacts(e: NormalizedEvent): NormalizedEvent {
  return { ...e, eventId: e.eventId.slice(0, 200), type: e.type.slice(0, 120), reason: e.reason ? e.reason.slice(0, 200) : null, method: e.method ? e.method.slice(0, 40) : null };
}

export const looksLikeOurReference = (r: string | null | undefined): r is string => typeof r === "string" && REFERENCE_RE.test(r);

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type ReviewReason = "checkout_mismatch" | "provider_disagrees" | "provider_missing_payment" | "currency_mismatch" | "amount_mismatch" | "no_payment_id";

export type EventDecision =
  | { action: "apply" }
  /** Keep the money for a person to look at; counts for nothing. `record` says whether a payment row can hold it (it cannot when its currency differs from the invoice's). */
  | { action: "review"; reason: ReviewReason; record: boolean }
  | { action: "reject"; reason: string }
  | { action: "ignore"; reason: string }
  | { action: "defer"; reason: string };

export interface AttemptFacts {
  reference: string;
  /** Null until the provider's answer to the checkout request has been stored (and for good, if the answer was lost). */
  checkoutId: string | null;
  /** The checkout request is recent and still waiting for its answer, so a payment event that beats it is only early. */
  settingUp: boolean;
  amountMinor: number;
  currency: string;
}

/** What the provider says when asked directly with the business's own key: the authenticated read-back. */
export interface Canonical {
  status: "paid" | "pending" | "failed" | "other";
  amountMinor: number | null;
  currency: string | null;
  reference: string | null;
  checkoutId: string | null;
}

export interface SucceededInput {
  event: NormalizedEvent;
  connectionLive: boolean;
  /** The attempt this connection issued under the event's reference, or null. */
  attempt: AttemptFacts | null;
  /** null: not asked (the signed event stands alone). "missing": asked, and the provider does not show the payment. */
  canonical: Canonical | "missing" | null;
}

/** What a verified "payment succeeded" event may do. Money is applied only when every fact agrees. */
export function decideSucceeded(i: SucceededInput): EventDecision {
  const e = i.event;
  if (e.livemode !== i.connectionLive) return { action: "reject", reason: "The event is from the other mode (test or live) than this connection." };
  if (!looksLikeOurReference(e.reference)) return { action: "ignore", reason: "Not one of this product's checkouts." };
  if (!i.attempt) return { action: "reject", reason: "No checkout on this connection has that reference." };
  if (!e.paymentId) return { action: "reject", reason: "The event names no payment, so there is nothing to record." };
  if (i.attempt.checkoutId === null && i.attempt.settingUp) return { action: "defer", reason: "The checkout for that reference is still being set up." };
  // The amount can only be recorded when it is a valid amount in the invoice's own currency.
  const recordable = e.amountMinor !== null && e.amountMinor > 0 && e.currency === i.attempt.currency;
  // No stored checkout id to compare (the provider's answer to the checkout request never reached us) is a mismatch too: the money is real, a person decides.
  if (!e.checkoutId || !i.attempt.checkoutId || e.checkoutId !== i.attempt.checkoutId) return { action: "review", reason: "checkout_mismatch", record: recordable };
  if (i.canonical === "missing") return { action: "review", reason: "provider_missing_payment", record: recordable };
  if (i.canonical) {
    const c = i.canonical;
    const agrees = c.status === "paid" && c.amountMinor === e.amountMinor && c.currency === e.currency && (c.reference === null || c.reference === i.attempt.reference) && (c.checkoutId === null || c.checkoutId === i.attempt.checkoutId);
    if (!agrees) return { action: "review", reason: "provider_disagrees", record: recordable };
  }
  if (e.currency !== i.attempt.currency) return { action: "review", reason: "currency_mismatch", record: false };
  if (e.amountMinor === null || e.amountMinor <= 0 || e.amountMinor !== i.attempt.amountMinor) return { action: "review", reason: "amount_mismatch", record: recordable };
  return { action: "apply" };
}

/** A failed or pending payment: recorded against its attempt when the event is ours, ignored quietly when it is not (the business's other sales share the account). */
export function decideNotSucceeded(i: { event: NormalizedEvent; connectionLive: boolean; attempt: AttemptFacts | null }): EventDecision {
  const e = i.event;
  if (e.livemode !== i.connectionLive) return { action: "reject", reason: "The event is from the other mode (test or live) than this connection." };
  if (!looksLikeOurReference(e.reference) || !i.attempt) return { action: "ignore", reason: "Not one of this product's checkouts." };
  if (e.checkoutId && i.attempt.checkoutId && e.checkoutId !== i.attempt.checkoutId) return { action: "ignore", reason: "The checkout does not belong to that reference." };
  return { action: "apply" };
}

export interface PaymentFactsForRefund {
  status: "succeeded" | "pending" | "failed" | "needs_review" | "partially_refunded" | "refunded" | "disputed";
  currency: string;
  amountMinor: number;
}

/**
 * A verified refund or dispute event. It can only be applied to a payment this product recorded and counted. One that arrives before its payment is deferred (events
 * can be reordered); one for a payment still waiting for review is deferred too. A refund in another currency is refused, whatever the payment's status.
 */
export function decideAfterPayment(i: { event: NormalizedEvent; connectionLive: boolean; payment: PaymentFactsForRefund | null }): EventDecision {
  const e = i.event;
  if (e.livemode !== i.connectionLive) return { action: "reject", reason: "The event is from the other mode (test or live) than this connection." };
  if (!e.paymentId) return { action: "ignore", reason: "The event names no payment." };
  if (!i.payment) return { action: "defer", reason: "The payment this refers to has not been recorded here (yet)." };
  if (i.payment.status === "pending" || i.payment.status === "needs_review") return { action: "defer", reason: "The payment this refers to is waiting for review." };
  if (i.payment.status === "failed") return { action: "reject", reason: "The payment this refers to failed, so there is nothing to refund." };
  if (e.kind.startsWith("refund.") && e.currency !== null && e.currency !== i.payment.currency) return { action: "reject", reason: "The refund is in a different currency from the payment." };
  return { action: "apply" };
}
