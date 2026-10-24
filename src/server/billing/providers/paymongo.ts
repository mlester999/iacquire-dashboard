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

export function normalizePaymongoEvent(event: PaymongoEvent): NormalizedPaymentEvent {
  const attrs = event.resource.attributes;
  const kind = event.type === "checkout_session.payment.paid" ? "payment_paid" : event.type === "payment.failed" ? "payment_failed" : "other";
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
