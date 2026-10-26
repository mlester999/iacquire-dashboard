// A stand-in for PayPal's REST API at the HTTP layer the PayPal wire provider uses (customer-payments/providers/paypal.ts). It models only what the product relies on:
// OAuth, Orders v2 create / get / capture, and webhook verification by asking PayPal. It was written from PayPal's public documentation and has NEVER been compared with the real
// service (see the "NOT VERIFIED" notes in that provider): a green test here proves this product's handling of the shapes below, not that PayPal behaves this way.
import crypto from "node:crypto";
import { createPaypalProvider } from "@/server/customer-payments/providers/paypal";
import type { PaypalHttp, PaypalRequest } from "@/server/customer-payments/providers/paypal";

export interface FakeOrder {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED" | "VOIDED";
  amount: { currency_code: string; value: string };
  custom_id: string;
  invoice_id?: string;
  requestId: string;
  captures: Array<{ id: string; status: string; amount: { currency_code: string; value: string }; custom_id: string; fee: string }>;
}

export function fakePaypal(opts: { webhookId?: string } = {}) {
  const orders = new Map<string, FakeOrder>();
  const byRequest = new Map<string, string>();
  const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string>; bearer: boolean }> = [];
  const state = { signaturesValid: true, down: false, captureAmountOverride: null as string | null, captureCurrencyOverride: null as string | null, capturePending: false, captureDeclined: false, tokenRejected: false };
  const webhookId = opts.webhookId ?? "WH-TEST-0123456789";

  const http: PaypalHttp = async (req: PaypalRequest) => {
    const body = req.body && req.contentType === "application/json" ? JSON.parse(req.body) : req.body ?? null;
    calls.push({ method: req.method, path: req.path, body, headers: req.headers ?? {}, bearer: Boolean(req.bearer) });
    if (state.down) return { status: 503, json: { name: "SERVICE_UNAVAILABLE" } };
    if (req.path === "/v1/oauth2/token") return state.tokenRejected ? { status: 401, json: { error: "invalid_client" } } : { status: 200, json: { access_token: "A21-test-token", token_type: "Bearer", expires_in: 32000 } };
    if (req.path === "/v2/checkout/orders" && req.method === "POST") {
      const requestId = req.headers?.["PayPal-Request-Id"] ?? crypto.randomUUID();
      const existing = byRequest.get(requestId);
      if (existing) return { status: 200, json: view(orders.get(existing) as FakeOrder) };
      const unit = (body as { purchase_units: Array<{ custom_id: string; amount: { currency_code: string; value: string }; invoice_id?: string }> }).purchase_units[0];
      const order: FakeOrder = { id: `ORD${orders.size + 1}${crypto.randomBytes(3).toString("hex").toUpperCase()}`, status: "CREATED", amount: unit.amount, custom_id: unit.custom_id, invoice_id: unit.invoice_id, requestId, captures: [] };
      orders.set(order.id, order);
      byRequest.set(requestId, order.id);
      return { status: 201, json: view(order) };
    }
    const orderMatch = /^\/v2\/checkout\/orders\/([A-Za-z0-9_-]+)(\/capture)?$/.exec(req.path);
    if (orderMatch) {
      const order = orders.get(orderMatch[1]);
      if (!order) return { status: 404, json: { name: "RESOURCE_NOT_FOUND" } };
      if (!orderMatch[2]) return { status: 200, json: view(order) };
      if (order.status === "COMPLETED") return { status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } };
      if (order.status !== "APPROVED") return { status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] } };
      if (state.captureDeclined) return { status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } };
      order.status = "COMPLETED";
      order.captures.push({
        id: `CAP${crypto.randomBytes(5).toString("hex").toUpperCase()}`, status: state.capturePending ? "PENDING" : "COMPLETED",
        amount: { currency_code: state.captureCurrencyOverride ?? order.amount.currency_code, value: state.captureAmountOverride ?? order.amount.value }, custom_id: order.custom_id, fee: "58.46",
      });
      return { status: 201, json: view(order) };
    }
    if (req.path === "/v1/notifications/verify-webhook-signature") {
      const sent = body as { webhook_id?: string };
      return { status: 200, json: { verification_status: state.signaturesValid && sent.webhook_id === webhookId ? "SUCCESS" : "FAILURE" } };
    }
    return { status: 404, json: { name: "NOT_FOUND" } };
  };

  function view(order: FakeOrder) {
    return {
      id: order.id,
      status: order.status,
      purchase_units: [{
        custom_id: order.custom_id, invoice_id: order.invoice_id, amount: order.amount,
        payments: order.captures.length ? { captures: order.captures.map((c) => ({ id: c.id, status: c.status, amount: c.amount, custom_id: c.custom_id, seller_receivable_breakdown: { paypal_fee: { currency_code: c.amount.currency_code, value: c.fee } } })) } : undefined,
      }],
      links: [{ rel: "self", href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${order.id}` }, { rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}` }],
    };
  }

  return {
    http,
    wire: createPaypalProvider({ http }),
    calls,
    state,
    webhookId,
    orders,
    /** The buyer approved the order on PayPal's page (nothing is captured by this). */
    approve(orderId: string) {
      const o = orders.get(orderId);
      if (!o) throw new Error("no such order");
      o.status = "APPROVED";
    },
    byReference(reference: string) {
      return [...orders.values()].find((o) => o.custom_id === reference);
    },
  };
}

export type FakePaypal = ReturnType<typeof fakePaypal>;

/** The five transmission headers PayPal sends with a delivery (lower-case names, as the route passes them). */
export function paypalHeaders(over: Partial<Record<string, string>> = {}): Record<string, string | null> {
  return {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
    "paypal-transmission-id": over["paypal-transmission-id"] ?? crypto.randomUUID(),
    "paypal-transmission-sig": "c2lnbmF0dXJl",
    "paypal-transmission-time": over["paypal-transmission-time"] ?? new Date().toISOString(),
    ...over,
  };
}

const eventId = () => `WH-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;

/** PAYMENT.CAPTURE.COMPLETED for a capture of an order, as PayPal's webhook carries it. */
export function captureCompletedEvent(o: { orderId: string; reference: string; captureId?: string; amount?: string; currency?: string; status?: string; id?: string }): string {
  return JSON.stringify({
    id: o.id ?? eventId(), event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: new Date().toISOString(),
    resource: {
      id: o.captureId ?? `CAP${crypto.randomBytes(5).toString("hex").toUpperCase()}`, status: o.status ?? "COMPLETED", custom_id: o.reference,
      amount: { currency_code: o.currency ?? "USD", value: o.amount ?? "1499.00" },
      seller_receivable_breakdown: { paypal_fee: { currency_code: o.currency ?? "USD", value: "58.46" } },
      supplementary_data: { related_ids: { order_id: o.orderId } },
    },
  });
}

export function captureDeniedEvent(o: { reference: string; id?: string }): string {
  return JSON.stringify({ id: o.id ?? eventId(), event_type: "PAYMENT.CAPTURE.DENIED", resource: { id: "CAPDENIED1", status: "DENIED", custom_id: o.reference, amount: { currency_code: "USD", value: "1499.00" } } });
}

export function captureRefundedEvent(o: { captureId: string; amount?: string; id?: string }): string {
  return JSON.stringify({
    id: o.id ?? eventId(), event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: { id: `REF${crypto.randomBytes(4).toString("hex")}`, status: "COMPLETED", amount: { currency_code: "USD", value: o.amount ?? "1499.00" }, links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${o.captureId}` }] },
  });
}

export function captureReversedEvent(o: { captureId: string; id?: string }): string {
  return JSON.stringify({ id: o.id ?? eventId(), event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: o.captureId, status: "REVERSED", amount: { currency_code: "USD", value: "1499.00" } } });
}

export function disputeCreatedEvent(o: { captureId: string; id?: string }): string {
  return JSON.stringify({ id: o.id ?? eventId(), event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1", disputed_transactions: [{ seller_transaction_id: o.captureId }] } });
}
