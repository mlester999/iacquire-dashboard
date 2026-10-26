import "server-only";
import { env } from "@/server/env";
import { isCurrency, parseAmount } from "@/lib/money";
import { statusFromPaypal, type AgreementStatus } from "@/lib/maintenance-agreement";
import { paypalHttp, paypalFailureFor, type PaypalHttp, type PaypalResponse } from "@/server/customer-payments/providers/paypal";
import { ProviderCallError } from "@/server/customer-payments/providers/types";
import { paypalAppCredentials } from "@/server/billing/providers/paypal";
import type { NormalizedPaymentEvent } from "@/server/billing/providers/types";

// PayPal Subscriptions, for the optional automatic monthly payment of the maintenance plan. The wire calls only: opening a subscription, reading it, listing what it collected, and
// cancelling it. What any of that MEANS for a plan is decided in src/server/maintenance/agreement.ts through the shared receipt ledger, and nothing here changes a plan.
//
// NOT VERIFIED against PayPal. Written from PayPal's public Subscriptions API documentation (October 2026) and tested against a replaced HTTP layer with fixtures written by hand, not
// recorded from PayPal. A sandbox run must settle each of these before a client's money depends on it:
//   1. POST /v1/billing/subscriptions: the body (plan_id, custom_id, application_context with return_url / cancel_url / user_action SUBSCRIBE_NOW, optional start_time), that the answer
//      carries the id and a link with rel "approve", and that PayPal-Request-Id makes a repeated request return the same subscription.
//   2. GET /v1/billing/plans/{id}: the fields read to prove the plan is the one we priced (status ACTIVE, one REGULAR monthly cycle with no end, a fixed price, no setup fee, no trial).
//   3. GET /v1/billing/subscriptions/{id}: status, status_update_time, billing_info.next_billing_time and billing_info.failed_payments_count.
//   4. GET /v1/billing/subscriptions/{id}/transactions?start_time=&end_time=: the list of what was collected, each with a status (COMPLETED is the only one read as money), an id, a
//      time and amount_with_breakdown.gross_amount.
//   5. POST /v1/billing/subscriptions/{id}/cancel: answered with 204, and what a repeat answers (an error read back, never assumed to mean cancelled).
//   6. The webhook events: BILLING.SUBSCRIPTION.ACTIVATED / SUSPENDED / CANCELLED / EXPIRED / UPDATED / PAYMENT.FAILED (the resource is the subscription) and PAYMENT.SALE.COMPLETED /
//      REFUNDED / REVERSED (the resource is the sale, naming the subscription as billing_agreement_id), and the id a refund or a dispute carries for the sale.
//   7. That PayPal's retry schedule after a failed charge is the one set on the plan (payment_failure_threshold), and what status the subscription is in during the retries.
// A webhook is never trusted until PayPal itself has been asked about its signature (src/server/billing/providers/paypal.ts).

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const timeOf = (v: unknown): string | null => {
  const s = str(v);
  if (!s || !ISO.test(s) || !Number.isFinite(Date.parse(s))) return null;
  return new Date(s).toISOString();
};
const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{3,120}$/;

function minorOf(value: unknown, currency: string | null): number | null {
  if (typeof value !== "string" || !currency || !isCurrency(currency)) return null;
  try {
    return parseAmount(value, currency);
  } catch {
    return null;
  }
}

export interface SubscriptionsDeps {
  http?: PaypalHttp;
}

interface Session {
  environment: "sandbox" | "live";
  bearer: string;
  http: PaypalHttp;
}

async function open(deps: SubscriptionsDeps): Promise<Session> {
  const credentials = paypalAppCredentials();
  if (!credentials) throw new ProviderCallError("rejected", "PayPal is not connected.");
  const http = deps.http ?? paypalHttp;
  const environment = credentials.settings?.environment === "live" ? "live" : "sandbox";
  const res = await http({ method: "POST", path: "/v1/oauth2/token", environment, basic: { id: credentials.apiKey, secret: credentials.apiSecret ?? "" }, contentType: "application/x-www-form-urlencoded", body: "grant_type=client_credentials" });
  if (res.status < 200 || res.status >= 300) throw paypalFailureFor(res);
  const bearer = isRecord(res.json) ? str(res.json.access_token) : null;
  if (!bearer) throw new ProviderCallError("invalid_response", "PayPal returned an unexpected answer.");
  return { environment, bearer, http };
}

const ok = (res: PaypalResponse) => res.status >= 200 && res.status < 300;

/** The plan id this deployment bills the maintenance plan with, or null until the founder sets it. */
export const maintenancePlanId = (): string | null => env().PAYPAL_MAINTENANCE_PLAN_ID ?? null;

// ---------------------------------------------------------------------------
// The PayPal plan must be the plan we priced
// ---------------------------------------------------------------------------

export interface PlanCheck {
  ok: boolean;
  /** Why not, in words for the Super Admin. */
  problems: string[];
}

/**
 * Reads PayPal's plan and proves it charges exactly what the maintenance plan costs here: active, one regular monthly cycle with no end, a fixed price equal to ours, no setup fee and
 * no trial. A price is NEVER taken from PayPal's side: if the two disagree, no subscription is opened and the Super Admin is told which part differs.
 */
export async function checkMaintenancePlan(expected: { amountMinor: number; currency: string }, deps: SubscriptionsDeps = {}): Promise<PlanCheck> {
  const planId = maintenancePlanId();
  if (!planId) return { ok: false, problems: ["PAYPAL_MAINTENANCE_PLAN_ID is not set."] };
  const session = await open(deps);
  const res = await session.http({ method: "GET", path: `/v1/billing/plans/${encodeURIComponent(planId)}`, environment: session.environment, bearer: session.bearer });
  if (res.status === 404) return { ok: false, problems: ["PayPal has no plan with the configured id."] };
  if (!ok(res)) throw paypalFailureFor(res);
  const plan = isRecord(res.json) ? res.json : {};
  const problems: string[] = [];
  if (str(plan.id) !== planId) problems.push("PayPal answered with a different plan.");
  if (plan.status !== "ACTIVE") problems.push("The PayPal plan is not active.");
  const cycles = Array.isArray(plan.billing_cycles) ? plan.billing_cycles.filter(isRecord) : [];
  if (cycles.length !== 1) problems.push("The PayPal plan must have exactly one billing cycle (no trial).");
  const cycle = cycles[0] ?? {};
  const frequency = isRecord(cycle.frequency) ? cycle.frequency : {};
  if (cycle.tenure_type !== "REGULAR") problems.push("The PayPal plan's cycle must be a regular one.");
  if (frequency.interval_unit !== "MONTH" || Number(frequency.interval_count) !== 1) problems.push("The PayPal plan must bill every month.");
  if (Number(cycle.total_cycles) !== 0) problems.push("The PayPal plan must bill until it is cancelled (no end).");
  const price = isRecord(cycle.pricing_scheme) && isRecord(cycle.pricing_scheme.fixed_price) ? cycle.pricing_scheme.fixed_price : {};
  if (str(price.currency_code) !== expected.currency) problems.push(`The PayPal plan is not priced in ${expected.currency}.`);
  else if (minorOf(price.value, expected.currency) !== expected.amountMinor) problems.push("The PayPal plan's price is not the maintenance plan's price.");
  const preferences = isRecord(plan.payment_preferences) ? plan.payment_preferences : {};
  const setup = isRecord(preferences.setup_fee) ? preferences.setup_fee : null;
  if (setup && minorOf(setup.value, str(setup.currency_code)) !== 0) problems.push("The PayPal plan has a setup fee, which this product does not charge.");
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Opening, reading, listing and cancelling
// ---------------------------------------------------------------------------

export interface OpenedSubscription {
  providerAgreementId: string;
  approvalUrl: string;
  status: AgreementStatus;
}

/** Only a PayPal page is ever handed to a customer. */
function approvalUrlOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderCallError("invalid_response", "PayPal returned an invalid approval link. Nothing was charged.");
  }
  if (url.protocol !== "https:" || !/(^|\.)paypal\.com$/i.test(url.hostname)) throw new ProviderCallError("invalid_response", "The approval link did not point to PayPal, so it was not used. Nothing was charged.");
  return url.toString();
}

/**
 * Asks PayPal to open a subscription on the maintenance plan for one buyer to approve. The reference is the idempotency key, so asking twice for one agreement gives one subscription.
 * Nothing is charged by this: PayPal charges only after the buyer approves on its page. `startTime` defers the first charge (a plan already paid through a future day is not charged
 * for a period it has).
 */
export async function openSubscription(input: { reference: string; returnUrl: string; cancelUrl: string; startTime?: Date | null }, deps: SubscriptionsDeps = {}): Promise<OpenedSubscription> {
  const planId = maintenancePlanId();
  if (!planId) throw new ProviderCallError("rejected", "PAYPAL_MAINTENANCE_PLAN_ID is not set.");
  if (!/^IAQ-[A-Z0-9]{8,40}$/.test(input.reference)) throw new ProviderCallError("rejected", "A subscription needs one of our references.");
  const session = await open(deps);
  const body: Record<string, unknown> = {
    plan_id: planId,
    custom_id: input.reference,
    application_context: {
      brand_name: "iAcquire",
      locale: "en-US",
      shipping_preference: "NO_SHIPPING",
      user_action: "SUBSCRIBE_NOW",
      payment_method: { payer_selected: "PAYPAL", payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED" },
      return_url: input.returnUrl,
      cancel_url: input.cancelUrl,
    },
  };
  if (input.startTime) body.start_time = input.startTime.toISOString().replace(/\.\d{3}Z$/, "Z");
  const res = await session.http({
    method: "POST", path: "/v1/billing/subscriptions", environment: session.environment, bearer: session.bearer, contentType: "application/json", body: JSON.stringify(body),
    headers: { "PayPal-Request-Id": input.reference, Prefer: "return=representation" },
  });
  if (!ok(res)) throw paypalFailureFor(res);
  const j = isRecord(res.json) ? res.json : null;
  const id = j ? str(j.id) : null;
  const links = j && Array.isArray(j.links) ? j.links.filter(isRecord) : [];
  const approve = links.find((l) => l.rel === "approve");
  const href = approve ? str(approve.href) : null;
  if (!id || !SUBSCRIPTION_ID.test(id) || !href) throw new ProviderCallError("invalid_response", "PayPal returned an unexpected answer. Nothing was charged.");
  // A subscription PayPal says is anything but waiting for approval was not opened by this request as we meant it.
  const status = statusFromPaypal(j?.status) ?? "approval_pending";
  return { providerAgreementId: id, approvalUrl: approvalUrlOf(href), status };
}

export interface SubscriptionFacts {
  providerAgreementId: string;
  status: AgreementStatus | null;
  /** The raw status word, for the record. */
  rawStatus: string | null;
  statusUpdatedAt: string | null;
  nextBillingAt: string | null;
  failedPayments: number | null;
  reference: string | null;
}

/** PayPal's own record of a subscription (the authenticated read), or null when PayPal does not know the id. */
export async function readSubscription(providerAgreementId: string, deps: SubscriptionsDeps = {}): Promise<SubscriptionFacts | null> {
  if (!SUBSCRIPTION_ID.test(providerAgreementId)) return null;
  const session = await open(deps);
  const res = await session.http({ method: "GET", path: `/v1/billing/subscriptions/${providerAgreementId}`, environment: session.environment, bearer: session.bearer });
  if (res.status === 404) return null;
  if (!ok(res)) throw paypalFailureFor(res);
  const j = isRecord(res.json) ? res.json : null;
  // An answer about a different subscription is not an answer.
  if (!j || str(j.id) !== providerAgreementId) throw new ProviderCallError("invalid_response", "PayPal returned an unexpected answer.");
  const info = isRecord(j.billing_info) ? j.billing_info : {};
  const failed = Number(info.failed_payments_count);
  return {
    providerAgreementId,
    status: statusFromPaypal(j.status),
    rawStatus: str(j.status),
    statusUpdatedAt: timeOf(j.status_update_time),
    nextBillingAt: timeOf(info.next_billing_time),
    failedPayments: Number.isInteger(failed) && failed >= 0 ? failed : null,
    reference: str(j.custom_id),
  };
}

export interface CollectedCharge {
  id: string;
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
  at: string | null;
}

/**
 * What PayPal says a subscription collected between two moments. Only a charge whose status is COMPLETED is returned: a declined, pending or refunded one is not money this product
 * applies (a refunded one reaches a person through the refund notice).
 */
export async function listCollectedCharges(providerAgreementId: string, window: { from: Date; to: Date }, deps: SubscriptionsDeps = {}): Promise<CollectedCharge[]> {
  if (!SUBSCRIPTION_ID.test(providerAgreementId)) return [];
  const session = await open(deps);
  const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const res = await session.http({
    method: "GET", path: `/v1/billing/subscriptions/${providerAgreementId}/transactions?start_time=${encodeURIComponent(stamp(window.from))}&end_time=${encodeURIComponent(stamp(window.to))}`,
    environment: session.environment, bearer: session.bearer,
  });
  if (res.status === 404) return [];
  if (!ok(res)) throw paypalFailureFor(res);
  const list = isRecord(res.json) && Array.isArray(res.json.transactions) ? res.json.transactions.filter(isRecord) : [];
  return list.flatMap((t) => {
    const id = str(t.id);
    if (!id || t.status !== "COMPLETED") return [];
    const breakdown = isRecord(t.amount_with_breakdown) ? t.amount_with_breakdown : {};
    const gross = isRecord(breakdown.gross_amount) ? breakdown.gross_amount : {};
    const fee = isRecord(breakdown.fee_amount) ? breakdown.fee_amount : {};
    const currency = str(gross.currency_code)?.toUpperCase() ?? null;
    return [{ id, amountMinor: minorOf(gross.value, currency), currency, feeMinor: minorOf(fee.value, str(fee.currency_code)?.toUpperCase() ?? null), at: timeOf(t.time) }];
  });
}

export type CancelResult = "cancelled" | "already_ended" | "unknown";

/**
 * Asks PayPal to cancel a subscription. 204 is a cancellation; a refusal because it is no longer cancellable is read back (a subscription PayPal says is cancelled or expired is
 * "already ended"); anything else is an error the caller must show, never assumed to have worked.
 */
export async function cancelSubscription(providerAgreementId: string, reason: string, deps: SubscriptionsDeps = {}): Promise<CancelResult> {
  if (!SUBSCRIPTION_ID.test(providerAgreementId)) return "unknown";
  const session = await open(deps);
  const res = await session.http({
    method: "POST", path: `/v1/billing/subscriptions/${providerAgreementId}/cancel`, environment: session.environment, bearer: session.bearer, contentType: "application/json",
    body: JSON.stringify({ reason: reason.slice(0, 128) }),
  });
  if (ok(res)) return "cancelled";
  if (res.status === 404) return "unknown";
  if (res.status === 422) {
    const now = await readSubscription(providerAgreementId, { http: session.http });
    if (now?.status === "cancelled" || now?.status === "expired") return "already_ended";
  }
  throw paypalFailureFor(res);
}

// ---------------------------------------------------------------------------
// Facts as the shared receipt ledger's events (the same shape a signed notice has)
// ---------------------------------------------------------------------------

/** PayPal's read of a subscription as the same "status" event a signed notice carries. Its id is derived from the status and when PayPal dated it, so a repeat is one event. */
export function statusEventFrom(facts: SubscriptionFacts, livemode: boolean): NormalizedPaymentEvent | null {
  if (!facts.status) return null;
  return {
    provider: "paypal", id: `sub:${facts.providerAgreementId}:${facts.rawStatus}:${facts.statusUpdatedAt ?? "-"}`, type: "SUBSCRIPTION.READ", kind: "agreement_status", livemode,
    checkoutId: null, reference: null, paidPayments: [], description: null, occurredAt: facts.statusUpdatedAt,
    agreement: { id: facts.providerAgreementId, status: facts.rawStatus, nextBillingAt: facts.nextBillingAt, failedPayments: facts.failedPayments, custom: facts.reference },
  };
}

/** A charge PayPal lists as collected, as the same "charge" event a signed sale notice carries. Its id is the charge's, so the list, the notice and a repeat are one charge. */
export function chargeEventFrom(providerAgreementId: string, charge: CollectedCharge, livemode: boolean): NormalizedPaymentEvent {
  return {
    provider: "paypal", id: `txn:${charge.id}`, type: "SUBSCRIPTION.TRANSACTION", kind: "agreement_charge", livemode,
    checkoutId: null, reference: null, description: null, occurredAt: charge.at,
    paidPayments: [{ id: charge.id, amountMinor: charge.amountMinor, currency: charge.currency, feeMinor: charge.feeMinor }],
    agreement: { id: providerAgreementId, status: null, nextBillingAt: null, failedPayments: null, custom: null },
  };
}
