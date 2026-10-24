import "server-only";
import { env } from "@/server/env";
import { parseEvent, paymongoStatus, verifyWebhookSignature, type PaymongoEvent } from "@/server/billing/paymongo";
import type { NormalizedPaidPayment, NormalizedPaymentEvent, PaymentProviderAdapter } from "@/server/billing/providers/types";

// PayMongo is the first adapter. It only translates: the signature check and the payload reading are the functions in ../paymongo.ts, unchanged, so what the existing
// billing tests prove about them still holds. Contract source and its limits are stated there (not exercised against a live or test PayMongo account).

const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The payments inside a checkout-session event that PayMongo reports as paid. */
function paidPaymentsOf(attrs: Record<string, unknown>): NormalizedPaidPayment[] {
  const list = Array.isArray(attrs.payments) ? attrs.payments : [];
  return list
    .filter((p): p is { id: string; attributes: Record<string, unknown> } =>
      typeof p === "object" && p !== null && typeof (p as { id?: unknown }).id === "string" && typeof (p as { attributes?: unknown }).attributes === "object"
      && (p as { attributes: { status?: unknown } }).attributes !== null && (p as { attributes: { status?: unknown } }).attributes.status === "paid")
    .map((p) => ({ id: p.id, amountMinor: asNumber(p.attributes.amount), currency: asString(p.attributes.currency), feeMinor: asNumber(p.attributes.fee) }));
}

// Refund and dispute events. PayMongo documents refund notices; a dispute notice is not one this code has ever seen, so any event whose name says "dispute" or "chargeback" is read
// the same careful way. Neither contract has been exercised against a PayMongo account (the tests use hand-written bodies), which is why a refund or dispute is only REPORTED:
// recorded, linked to our payment when its provider id matches, and shown to a person. See applyReported in ../payments.ts.
const REFUND_EVENT = /refund/i;
const DISPUTE_EVENT = /dispute|chargeback/i;

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The provider payment a refund or dispute is about: named in the payload, or the resource itself when it is the payment. */
function reportedPaymentId(resource: PaymongoEvent["resource"]): string | null {
  const named = asString(resource.attributes.payment_id);
  if (named) return named;
  return resource.type === "payment" || /^pay_/.test(resource.id) ? resource.id : null;
}

/**
 * What a refund event reports. A refund notice is either the refund itself (payment.refund.updated: the refund's id, its payment_id, amount and status) or a payment that lists its
 * refunds (payment.refunded: several may ride on one payment, and the newest is this event's). The amount is used only when the payload states one. Same two shapes the customer
 * payments adapter reads; both are written from the documentation and have never been seen from a live account.
 */
function reportedRefund(resource: PaymongoEvent["resource"]): NonNullable<NormalizedPaymentEvent["refund"]> {
  const attrs = resource.attributes;
  if (resource.type === "refund" || /^ref_/.test(resource.id)) {
    return { id: resource.id, amountMinor: asNumber(attrs.amount), currency: asString(attrs.currency), status: asString(attrs.status) };
  }
  const listed = (Array.isArray(attrs.refunds) ? attrs.refunds : [])
    .map((r) => asRecord(r))
    .filter((r): r is Record<string, unknown> => r !== null && typeof r.id === "string" && asRecord(r.attributes) !== null);
  const created = (r: Record<string, unknown>) => asNumber((r.attributes as Record<string, unknown>).created_at) ?? 0;
  const newest = listed.reduce<Record<string, unknown> | null>((best, r) => (best === null || created(r) > created(best) ? r : best), null);
  if (!newest) return { id: null, amountMinor: null, currency: null, status: null };
  const inner = newest.attributes as Record<string, unknown>;
  return { id: newest.id as string, amountMinor: asNumber(inner.amount), currency: asString(inner.currency) ?? asString(attrs.currency), status: asString(inner.status) };
}

export function normalizePaymongoEvent(event: PaymongoEvent): NormalizedPaymentEvent {
  const attrs = event.resource.attributes;
  const kind = event.type === "checkout_session.payment.paid" ? "payment_paid"
    : event.type === "payment.failed" ? "payment_failed"
    : REFUND_EVENT.test(event.type) ? "payment_refunded"
    : DISPUTE_EVENT.test(event.type) ? "payment_disputed"
    : "other";
  return {
    provider: "paymongo",
    id: event.id,
    type: event.type,
    kind,
    livemode: event.livemode,
    checkoutId: kind === "payment_paid" ? event.resource.id : null,
    reference: asString(attrs.reference_number),
    paidPayments: kind === "payment_paid" ? paidPaymentsOf(attrs) : [],
    description: asString(attrs.description),
    providerPaymentId: kind === "payment_refunded" || kind === "payment_disputed" ? reportedPaymentId(event.resource) : null,
    refund: kind === "payment_refunded" ? reportedRefund(event.resource) : null,
  };
}

export const paymongoAdapter: PaymentProviderAdapter = {
  id: "paymongo",
  notReady: () => (env().PAYMONGO_WEBHOOK_SECRET ? null : "Webhook secret is not configured."),
  expectedLivemode: () => paymongoStatus().livemode,
  verify: ({ rawBody, headers, now }) => {
    const secret = env().PAYMONGO_WEBHOOK_SECRET;
    if (!secret) return { ok: false, reason: "not configured" };
    const sig = verifyWebhookSignature({ header: headers["paymongo-signature"] ?? null, rawBody, secret, now });
    return sig.ok ? { ok: true, livemode: sig.livemode } : { ok: false, reason: sig.reason };
  },
  parse: (rawBody) => {
    const event = parseEvent(rawBody);
    return event ? normalizePaymongoEvent(event) : null;
  },
};
