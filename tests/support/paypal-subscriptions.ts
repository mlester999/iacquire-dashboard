// A stand-in for PayPal's Subscriptions API at the HTTP layer src/server/billing/providers/paypal-subscriptions.ts uses: a billing plan, opening a subscription, reading it, listing what
// it collected, and cancelling it, on top of the OAuth and webhook-verification endpoints of tests/support/paypal-agency.ts. Written from PayPal's public documentation and NEVER compared
// with the real service: a green test here proves this product's handling of the shapes below, not that PayPal behaves this way (see the NOT VERIFIED list in the provider module).
import crypto from "node:crypto";
import { fakePaypal } from "./paypal-agency";
import type { PaypalHttp, PaypalRequest } from "@/server/customer-payments/providers/paypal";

export type FakeSubscriptionStatus = "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";

export interface FakeSubscription {
  id: string;
  status: FakeSubscriptionStatus;
  plan_id: string;
  custom_id: string;
  requestId: string;
  start_time: string | null;
  statusUpdatedAt: string;
  failedPayments: number;
  nextBilling: string | null;
  transactions: Array<{ id: string; status: string; value: string; currency: string; fee: string; time: string }>;
}

export const TEST_PLAN_ID = "P-5ML4271244454362WXNWU5NQ";

const planOf = (over: Partial<{ status: string; value: string; currency: string; interval: string; cycles: number; trial: boolean; setup: string }> = {}) => ({
  id: TEST_PLAN_ID,
  status: over.status ?? "ACTIVE",
  billing_cycles: [
    ...(over.trial ? [{ tenure_type: "TRIAL", sequence: 1, total_cycles: 1, frequency: { interval_unit: "MONTH", interval_count: 1 }, pricing_scheme: { fixed_price: { value: "0", currency_code: "USD" } } }] : []),
    {
      tenure_type: "REGULAR", sequence: over.trial ? 2 : 1, total_cycles: over.cycles ?? 0, frequency: { interval_unit: over.interval ?? "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { value: over.value ?? "299.00", currency_code: over.currency ?? "USD" } },
    },
  ],
  payment_preferences: { auto_bill_outstanding: true, setup_fee: { value: over.setup ?? "0", currency_code: "USD" }, payment_failure_threshold: 3 },
});

export function fakePaypalSubscriptions(opts: { webhookId?: string } = {}) {
  const base = fakePaypal(opts);
  const subscriptions = new Map<string, FakeSubscription>();
  const byRequest = new Map<string, string>();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  // The base stand-in's switches (down, signaturesValid, tokenRejected) and this one's share one object, so a test sets any of them in one place.
  const state = Object.assign(base.state, {
    cancelDown: false,
    plan: {} as NonNullable<Parameters<typeof planOf>[0]>,
    planMissing: false,
    /** Hand back a different subscription id than the one asked about (a corrupted answer). */
    wrongIdOnRead: false,
  });
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const http: PaypalHttp = async (req: PaypalRequest) => {
    if (!req.path.startsWith("/v1/billing/")) return base.http(req);
    const body = req.body && req.contentType === "application/json" ? JSON.parse(req.body) : null;
    calls.push({ method: req.method, path: req.path, body });
    if (state.down) return { status: 503, json: { name: "SERVICE_UNAVAILABLE" } };

    if (req.path === `/v1/billing/plans/${TEST_PLAN_ID}` && req.method === "GET") return state.planMissing ? { status: 404, json: { name: "RESOURCE_NOT_FOUND" } } : { status: 200, json: planOf(state.plan) };

    if (req.path === "/v1/billing/subscriptions" && req.method === "POST") {
      const requestId = req.headers?.["PayPal-Request-Id"] ?? crypto.randomUUID();
      const known = byRequest.get(requestId);
      if (known) return { status: 200, json: view(subscriptions.get(known) as FakeSubscription) };
      const sub: FakeSubscription = {
        id: `I-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, status: "APPROVAL_PENDING", plan_id: String(body.plan_id), custom_id: String(body.custom_id), requestId,
        start_time: typeof body.start_time === "string" ? body.start_time : null, statusUpdatedAt: now(), failedPayments: 0, nextBilling: null, transactions: [],
      };
      subscriptions.set(sub.id, sub);
      byRequest.set(requestId, sub.id);
      return { status: 201, json: view(sub) };
    }

    const m = /^\/v1\/billing\/subscriptions\/([A-Za-z0-9_-]+)(\/transactions|\/cancel)?(\?.*)?$/.exec(req.path);
    if (m) {
      const sub = subscriptions.get(m[1]);
      if (!sub) return { status: 404, json: { name: "RESOURCE_NOT_FOUND" } };
      if (!m[2] && req.method === "GET") return { status: 200, json: state.wrongIdOnRead ? { ...view(sub), id: "I-SOMEONEELSE" } : view(sub) };
      if (m[2] === "/transactions") {
        return {
          status: 200,
          json: {
            transactions: sub.transactions.map((t) => ({ id: t.id, status: t.status, time: t.time, amount_with_breakdown: { gross_amount: { currency_code: t.currency, value: t.value }, fee_amount: { currency_code: t.currency, value: t.fee } } })),
            total_items: sub.transactions.length,
          },
        };
      }
      if (m[2] === "/cancel") {
        if (state.cancelDown) return { status: 503, json: { name: "SERVICE_UNAVAILABLE" } };
        if (sub.status === "CANCELLED" || sub.status === "EXPIRED") return { status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "SUBSCRIPTION_STATUS_INVALID" }] } };
        sub.status = "CANCELLED";
        sub.nextBilling = null;
        sub.statusUpdatedAt = now();
        return { status: 204, json: null };
      }
    }
    return { status: 404, json: { name: "NOT_FOUND" } };
  };

  function view(sub: FakeSubscription) {
    return {
      id: sub.id, plan_id: sub.plan_id, status: sub.status, status_update_time: sub.statusUpdatedAt, custom_id: sub.custom_id, start_time: sub.start_time ?? undefined,
      billing_info: { failed_payments_count: sub.failedPayments, next_billing_time: sub.nextBilling ?? undefined },
      links: sub.status === "APPROVAL_PENDING" ? [{ rel: "approve", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${sub.id}` }] : [{ rel: "self", href: `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${sub.id}` }],
    };
  }

  const get = (id: string) => {
    const sub = subscriptions.get(id);
    if (!sub) throw new Error(`no such subscription ${id}`);
    return sub;
  };

  return {
    ...base,
    http,
    calls,
    state,
    subscriptions,
    byReference: (reference: string) => [...subscriptions.values()].find((s) => s.custom_id === reference),
    /** The buyer approved on PayPal's page: PayPal moves the subscription to ACTIVE and schedules the next billing. */
    approve(id: string, nextBilling = new Date(Date.now() + 30 * 86_400_000)) {
      const s = get(id);
      s.status = "ACTIVE";
      s.statusUpdatedAt = now();
      s.nextBilling = nextBilling.toISOString().replace(/\.\d{3}Z$/, "Z");
    },
    setStatus(id: string, status: FakeSubscriptionStatus) {
      const s = get(id);
      s.status = status;
      s.statusUpdatedAt = now();
    },
    /** PayPal collected a payment for the subscription. */
    collect(id: string, over: { id?: string; value?: string; currency?: string; status?: string } = {}) {
      const s = get(id);
      const t = { id: over.id ?? `SALE${crypto.randomBytes(5).toString("hex").toUpperCase()}`, status: over.status ?? "COMPLETED", value: over.value ?? "299.00", currency: over.currency ?? "USD", fee: "9.19", time: now() };
      s.transactions.push(t);
      if ((over.status ?? "COMPLETED") === "COMPLETED") s.failedPayments = 0;
      return t;
    },
    failPayment(id: string) {
      get(id).failedPayments += 1;
    },
  };
}

export type FakePaypalSubscriptions = ReturnType<typeof fakePaypalSubscriptions>;

const eventId = () => `WH-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;

/** A BILLING.SUBSCRIPTION.* webhook, whose resource is the subscription. */
export function subscriptionEvent(type: string, sub: { id: string; status: string; custom_id?: string; failedPayments?: number; nextBilling?: string | null; statusUpdatedAt?: string; createTime?: string }, over: { id?: string; createTime?: string } = {}): string {
  const at = over.createTime ?? sub.createTime ?? new Date().toISOString();
  return JSON.stringify({
    id: over.id ?? eventId(), event_type: type, create_time: at,
    resource: {
      id: sub.id, status: sub.status, custom_id: sub.custom_id, status_update_time: sub.statusUpdatedAt ?? at,
      billing_info: { failed_payments_count: sub.failedPayments ?? 0, next_billing_time: sub.nextBilling ?? undefined },
    },
  });
}

/** PAYMENT.SALE.COMPLETED for a charge of a subscription, whose resource is the sale. */
export function saleCompletedEvent(o: { agreementId: string; saleId?: string; total?: string; currency?: string; state?: string; id?: string; createTime?: string; omitAgreement?: boolean }): string {
  return JSON.stringify({
    id: o.id ?? eventId(), event_type: "PAYMENT.SALE.COMPLETED", create_time: o.createTime ?? new Date().toISOString(),
    resource: {
      id: o.saleId ?? `SALE${crypto.randomBytes(5).toString("hex").toUpperCase()}`, state: o.state ?? "completed", amount: { total: o.total ?? "299.00", currency: o.currency ?? "USD" },
      transaction_fee: { value: "9.19", currency: "USD" }, billing_agreement_id: o.omitAgreement ? undefined : o.agreementId, create_time: o.createTime ?? new Date().toISOString(),
    },
  });
}

export function saleRefundedEvent(o: { saleId: string; total?: string; id?: string; state?: string }): string {
  return JSON.stringify({
    id: o.id ?? eventId(), event_type: "PAYMENT.SALE.REFUNDED", create_time: new Date().toISOString(),
    resource: { id: `REF${crypto.randomBytes(4).toString("hex")}`, state: o.state ?? "completed", amount: { total: o.total ?? "299.00", currency: "USD" }, sale_id: o.saleId },
  });
}

export function saleReversedEvent(o: { saleId: string; id?: string }): string {
  return JSON.stringify({ id: o.id ?? eventId(), event_type: "PAYMENT.SALE.REVERSED", create_time: new Date().toISOString(), resource: { id: `REV${crypto.randomBytes(4).toString("hex")}`, sale_id: o.saleId, state: "reversed" } });
}
