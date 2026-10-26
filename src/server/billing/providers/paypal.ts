import "server-only";
import { env } from "@/server/env";
import { isCurrency, parseAmount } from "@/lib/money";
import { createPaypalProvider, disputeOutcomeOf } from "@/server/customer-payments/providers/paypal";
import type { PaymentProviderAdapter as WireProvider, CanonicalCheckout } from "@/server/customer-payments/providers/types";
import type { ProviderCredentials } from "@/server/customer-payments/credentials";
import type { NormalizedPaidPayment, NormalizedPaymentEvent, PaymentProviderAdapter, VerifyResult } from "@/server/billing/providers/types";

// PayPal for iAcquire's OWN purchases and plan payments. The wire format (OAuth, Orders v2, the capture call, the webhook check by asking PayPal) is the customer-payments PayPal
// provider's, used here with the app credentials from the environment: one place speaks PayPal, and what its tests prove about the payloads holds for both. This file only (a)
// reads the environment, (b) says what a mode is, and (c) turns PayPal's facts into the provider-neutral events the shared webhook handler and the purchase checkout already apply,
// with the same rules: the reference, mode, amount and currency must equal what WE stored, and nothing a browser sends is evidence.
//
// NOT VERIFIED against PayPal. Everything above this line in customer-payments/providers/paypal.ts lists the guesses a sandbox run must settle (the Orders v2 request, that approval
// does not take the money, the event names and shapes, webhook verification by asking PayPal, the currencies an account takes). Those apply here unchanged, plus one: that PayPal
// echoes our `custom_id` in the capture and in every event about it, which is how a payment is tied to its checkout.

const ASCII_REFERENCE = /^IAQ-[A-Z0-9]{8,40}$/;

export interface PaypalStatus {
  configured: boolean;
  webhookConfigured: boolean;
  /** The app's environment decides the mode: PayPal events do not say whether they are test or live. */
  livemode: boolean | null;
  environment: "sandbox" | "live";
  problems: string[];
}

export function paypalStatus(): PaypalStatus {
  const e = env();
  const problems: string[] = [];
  if (!e.PAYPAL_CLIENT_ID) problems.push("PAYPAL_CLIENT_ID is not set.");
  if (!e.PAYPAL_CLIENT_SECRET) problems.push("PAYPAL_CLIENT_SECRET is not set.");
  if (!e.PAYPAL_WEBHOOK_ID) problems.push("PAYPAL_WEBHOOK_ID is not set, so payments cannot be confirmed.");
  const configured = Boolean(e.PAYPAL_CLIENT_ID && e.PAYPAL_CLIENT_SECRET);
  return { configured, webhookConfigured: Boolean(e.PAYPAL_WEBHOOK_ID), livemode: configured ? e.PAYPAL_ENVIRONMENT === "live" : null, environment: e.PAYPAL_ENVIRONMENT, problems };
}

/** The app's credentials in the shape the PayPal provider takes, or null when they are not set. */
export function paypalAppCredentials(): ProviderCredentials | null {
  const e = env();
  if (!e.PAYPAL_CLIENT_ID || !e.PAYPAL_CLIENT_SECRET) return null;
  return { apiKey: e.PAYPAL_CLIENT_ID, apiSecret: e.PAYPAL_CLIENT_SECRET, webhookSecret: e.PAYPAL_WEBHOOK_ID ?? null, settings: { environment: e.PAYPAL_ENVIRONMENT } };
}

export interface PaypalDeps {
  /** The wire provider. Tests hand in one built over a replaced HTTP layer; nothing else should. */
  wire?: WireProvider;
}

const wireOf = (deps: PaypalDeps) => deps.wire ?? createPaypalProvider();

// ---------------------------------------------------------------------------
// Opening, completing and reading a checkout (the only calls that reach PayPal besides the webhook check)
// ---------------------------------------------------------------------------

/** Opens a hosted PayPal order for the frozen amount. The reference is the idempotency key, so asking twice for one attempt gives one order. */
export async function openPaypalOrder(input: { reference: string; amountMinor: number; currency: string; description: string; returnUrl: string; cancelUrl: string }, deps: PaypalDeps = {}): Promise<{ checkoutId: string; checkoutUrl: string }> {
  const credentials = paypalAppCredentials();
  if (!credentials) throw new Error("PayPal is not connected.");
  if (!ASCII_REFERENCE.test(input.reference) || !isCurrency(input.currency)) throw new Error("A PayPal order needs one of our references and a supported currency.");
  return wireOf(deps).createCheckout(credentials, { reference: input.reference, amountMinor: input.amountMinor, currency: input.currency, description: input.description, successUrl: input.returnUrl, cancelUrl: input.cancelUrl });
}

/**
 * After the buyer approved, asks PayPal to take the money, from this server with the app's credentials. The browser contributes nothing but the page it landed on: the order id is
 * the one WE stored, and what comes back is PayPal's own record of the order and its captures. An order the buyer has not approved is left as it is.
 */
export async function completePaypalOrder(checkoutId: string, reference: string, deps: PaypalDeps = {}): Promise<CanonicalCheckout | null> {
  const credentials = paypalAppCredentials();
  const wire = wireOf(deps);
  if (!credentials || !wire.completeCheckout) return null;
  return wire.completeCheckout(credentials, checkoutId, { reference });
}

/** PayPal's own record of an order (the authenticated read-back), for the sweep that settles a payment whose notice never arrived. */
export async function readPaypalOrder(checkoutId: string, deps: PaypalDeps = {}): Promise<CanonicalCheckout | null> {
  const credentials = paypalAppCredentials();
  const wire = wireOf(deps);
  if (!credentials || !wire.fetchCheckout) return null;
  return wire.fetchCheckout(credentials, checkoutId);
}

/**
 * PayPal's record of an order, as the same "paid" event a signed notice would carry. Null unless PayPal itself says a capture COMPLETED. The event id is derived from the capture, so
 * the shared receipt ledger treats the capture response, the later signed notice and a read-back as one payment.
 */
export function paidEventFromCheckout(order: CanonicalCheckout, livemode: boolean): NormalizedPaymentEvent | null {
  const paid = order.payments.filter((p) => p.status === "paid");
  if (paid.length !== 1) return null;
  const only = paid[0];
  return {
    provider: "paypal",
    id: `capture:${only.id}`,
    type: "ORDER.CAPTURED",
    kind: "payment_paid",
    livemode,
    checkoutId: order.checkoutId,
    reference: order.reference,
    paidPayments: [{ id: only.id, amountMinor: only.amountMinor, currency: only.currency, feeMinor: only.feeMinor } satisfies NormalizedPaidPayment],
    description: null,
  };
}

// ---------------------------------------------------------------------------
// The signed notice
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** PayPal's decimal string, in the major unit, as minor units; null when it is not a valid amount in that currency. */
function minorOf(value: unknown, currency: string | null): number | null {
  if (typeof value !== "string" || !currency || !isCurrency(currency)) return null;
  try {
    return parseAmount(value, currency);
  } catch {
    return null;
  }
}

const currencyOf = (v: unknown): string | null => (typeof v === "string" && isCurrency(v.toUpperCase()) ? v.toUpperCase() : null);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
/** An ISO time PayPal sent, normalised; null when it is not one. */
const timeOf = (v: unknown): string | null => (typeof v === "string" && ISO_TIME.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

/** A BILLING.SUBSCRIPTION event's resource as the agreement it is about, or null when it names none. */
function subscriptionOf(r: Record<string, unknown>): NonNullable<NormalizedPaymentEvent["agreement"]> | null {
  const id = str(r.id);
  if (!id || !/^[A-Za-z0-9_-]{3,120}$/.test(id)) return null;
  const info = isRecord(r.billing_info) ? r.billing_info : {};
  const failed = Number(info.failed_payments_count);
  return { id, status: str(r.status), nextBillingAt: timeOf(info.next_billing_time), failedPayments: Number.isInteger(failed) && failed >= 0 ? failed : null, custom: str(r.custom_id) };
}

/** A PayPal webhook body into the provider-neutral event, or null when it is not one. Mode comes from the app's environment: the body does not say. */
export function normalizePaypalWebhook(rawBody: string, livemode: boolean): NormalizedPaymentEvent | null {
  let ev: unknown;
  try {
    ev = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(ev) || !str(ev.id) || !str(ev.event_type)) return null;
  const id = str(ev.id) as string;
  const type = str(ev.event_type) as string;
  const r = isRecord(ev.resource) ? ev.resource : {};
  const amount = isRecord(r.amount) ? r.amount : {};
  const currency = currencyOf(amount.currency_code);
  const amountMinor = minorOf(amount.value, currency);
  const orderId = isRecord(r.supplementary_data) && isRecord(r.supplementary_data.related_ids) ? str(r.supplementary_data.related_ids.order_id) : null;
  const custom = str(r.custom_id);
  const reference = custom && ASCII_REFERENCE.test(custom) ? custom : null;
  const fee = isRecord(r.seller_receivable_breakdown) && isRecord(r.seller_receivable_breakdown.paypal_fee) ? r.seller_receivable_breakdown.paypal_fee : {};
  const feeMinor = minorOf(fee.value, currencyOf(fee.currency_code));
  const base = { provider: "paypal" as const, id, type, livemode, checkoutId: null as string | null, reference: null as string | null, paidPayments: [] as NormalizedPaidPayment[], description: null as string | null };

  switch (type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      // A capture that is not in the completed state is not money.
      if (r.status !== "COMPLETED") return { ...base, kind: "other" };
      return { ...base, kind: "payment_paid", checkoutId: orderId, reference, paidPayments: str(r.id) ? [{ id: str(r.id) as string, amountMinor, currency, feeMinor }] : [] };
    case "PAYMENT.CAPTURE.DENIED":
      // A failed attempt names no checkout; our reference rides in the description so it can be linked back, as PayMongo's does.
      return { ...base, kind: "payment_failed", description: reference ? `[${reference}]` : null };
    case "PAYMENT.CAPTURE.REFUNDED": {
      // The resource is the refund; the capture it belongs to is the link that points up.
      const up = (Array.isArray(r.links) ? r.links : []).find((l) => isRecord(l) && l.rel === "up" && typeof l.href === "string");
      const captureId = up && isRecord(up) ? /\/captures\/([A-Za-z0-9_-]{4,120})\/?$/.exec(String(up.href))?.[1] ?? null : null;
      return { ...base, kind: "payment_refunded", reference, providerPaymentId: captureId, refund: { id: str(r.id), amountMinor, currency, status: str(r.status) } };
    }
    case "PAYMENT.CAPTURE.REVERSED":
      // Money taken back by the buyer's bank or PayPal: held for a person, never applied.
      return { ...base, kind: "payment_disputed", reference, providerPaymentId: str(r.id) };
    case "CUSTOMER.DISPUTE.CREATED": {
      const tx = Array.isArray(r.disputed_transactions) && isRecord(r.disputed_transactions[0]) ? r.disputed_transactions[0] : {};
      return { ...base, kind: "payment_disputed", providerPaymentId: str(tx.seller_transaction_id) };
    }
    // The automatic monthly payment of the maintenance plan (PayPal Subscriptions). The resource of a BILLING.SUBSCRIPTION event is the subscription; the resource of a
    // PAYMENT.SALE event is the sale, which names its subscription as billing_agreement_id (a sale with none is not ours and is ignored).
    case "BILLING.SUBSCRIPTION.CREATED":
    case "BILLING.SUBSCRIPTION.ACTIVATED":
    case "BILLING.SUBSCRIPTION.RE-ACTIVATED":
    case "BILLING.SUBSCRIPTION.UPDATED":
    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
      const agreement = subscriptionOf(r);
      if (!agreement) return { ...base, kind: "other" };
      if (type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") {
        // A failed charge does not change the subscription's status, so the resource's status_update_time is the day it was last ACTIVATED or SUSPENDED, months old by the third renewal.
        // Dating the failure by it would make every failure after a collected charge look older than that charge and be dropped as stale. It is dated by the event itself, then by the
        // failure PayPal records on the subscription, and only then by the status time.
        const info = isRecord(r.billing_info) ? r.billing_info : {};
        const last = isRecord(info.last_failed_payment) ? info.last_failed_payment : {};
        return { ...base, kind: "agreement_payment_failed", occurredAt: timeOf(ev.create_time) ?? timeOf(last.time) ?? timeOf(r.status_update_time), agreement };
      }
      // The status's own time is preferred (the read-back dates its news the same way); the event's creation time is the fallback.
      return { ...base, kind: "agreement_status", occurredAt: timeOf(r.status_update_time) ?? timeOf(ev.create_time), agreement };
    }
    case "PAYMENT.SALE.COMPLETED": {
      const agreementId = str(r.billing_agreement_id);
      if (!agreementId) return { ...base, kind: "other" };
      // A sale that is not in the completed state is not money.
      if (r.state !== "completed") return { ...base, kind: "other" };
      const saleAmount = isRecord(r.amount) ? r.amount : {};
      const saleCurrency = currencyOf(saleAmount.currency);
      const saleFee = isRecord(r.transaction_fee) ? r.transaction_fee : {};
      return {
        ...base, kind: "agreement_charge", occurredAt: timeOf(r.create_time) ?? timeOf(ev.create_time),
        paidPayments: str(r.id) ? [{ id: str(r.id) as string, amountMinor: minorOf(saleAmount.total, saleCurrency), currency: saleCurrency, feeMinor: minorOf(saleFee.value, currencyOf(saleFee.currency)) }] : [],
        agreement: { id: agreementId, status: null, nextBillingAt: null, failedPayments: null, custom: null },
      };
    }
    case "PAYMENT.SALE.REFUNDED": {
      // The resource is the refund; the sale it belongs to is sale_id.
      const refundAmount = isRecord(r.amount) ? r.amount : {};
      const refundCurrency = currencyOf(refundAmount.currency);
      return { ...base, kind: "payment_refunded", providerPaymentId: str(r.sale_id), refund: { id: str(r.id), amountMinor: minorOf(refundAmount.total, refundCurrency), currency: refundCurrency, status: r.state === "completed" ? "succeeded" : r.state === "pending" ? "pending" : r.state === "failed" || r.state === "cancelled" ? "failed" : null } };
    }
    case "PAYMENT.SALE.REVERSED":
      // Money taken back by the buyer's bank or PayPal: held for a person, never applied. Which id names the sale is one of the things a sandbox run must settle.
      return { ...base, kind: "payment_disputed", providerPaymentId: str(r.sale_id) ?? str(r.id) };
    default:
      // Approval is not payment; a resolved dispute is reported by a person, not applied (disputeOutcomeOf is kept for the day that changes).
      void disputeOutcomeOf;
      return { ...base, kind: "other" };
  }
}

const reader = (headers: Record<string, string | null | undefined>) => ({ get: (name: string) => headers[name.toLowerCase()] ?? null });

/** The adapter the shared webhook handler uses for PayPal. The delivery is checked by asking PayPal with the app's credentials and webhook id; nothing in the body is trusted before that. */
export function createPaypalAdapter(deps: PaypalDeps = {}): PaymentProviderAdapter {
  return {
    id: "paypal",
    notReady: () => {
      const s = paypalStatus();
      if (!s.configured) return "PayPal is not connected.";
      if (!s.webhookConfigured) return "The PayPal webhook id is not set, so a delivery cannot be verified.";
      return null;
    },
    expectedLivemode: () => paypalStatus().livemode,
    async verify({ rawBody, headers, now }): Promise<VerifyResult> {
      const credentials = paypalAppCredentials();
      const webhookId = env().PAYPAL_WEBHOOK_ID;
      if (!credentials || !webhookId) return { ok: false, reason: "not configured" };
      const check = await wireOf(deps).verifyWebhook({ rawBody, headers: reader(headers), secret: webhookId, now: now ?? Date.now(), credentials });
      // The webhook id belongs to one app in one environment, so a delivery it verifies is in the environment this app is configured for.
      return check.ok ? { ok: true, livemode: paypalStatus().livemode === true } : { ok: false, reason: check.reason };
    },
    parse: (rawBody) => normalizePaypalWebhook(rawBody, paypalStatus().livemode === true),
  };
}

export const paypalAdapter: PaymentProviderAdapter = createPaypalAdapter();
