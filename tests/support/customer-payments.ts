// Fixtures for the customer payment tests: connections whose secrets the test knows, checkout attempts, and deliveries signed the way each provider signs them.
// Synthetic workspaces only. No provider is contacted: PayMongo's network layer is a recorded-shape fixture the test hands in, and the simulated provider lives in
// process. The PayMongo bodies here were written by hand from PayMongo's documentation as remembered, NOT captured from PayMongo (see providers/paymongo.ts).
import crypto from "node:crypto";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { withSystem } from "@/server/db";
import { CURRENT_AUTHORIZATION_VERSION, type ConnectionMode, type ConnectionStatus, type PaymentProviderId } from "@/lib/invoices/connection-rules";
import type { NormalizedEvent } from "@/lib/invoices/payment-events";
import { credentialVault } from "@/server/customer-payments/credentials";
import { newPublicKey, newReference } from "@/server/customer-payments/ids";
import { handleCustomerPaymentWebhook, type WebhookResult } from "@/server/customer-payments/webhooks";
import { SIGNATURE_HEADER, signSimulatedBody, simulatedBody, simulatedPlatform, simulatedProvider } from "@/server/customer-payments/providers/simulated";
import type { PaymongoHttp, PaymongoRequest, PaymongoResponse } from "@/server/customer-payments/providers/paymongo";
import { uid } from "./fixtures";
import { invoiceOrg, issuedInvoice, type InvoiceOrg } from "./invoices";

// Nothing in these tests may reach a payment provider, or anything else on the network. The real network layer of an adapter calls fetch, so fetch is replaced for every
// test that imports this file by one that records the attempt and fails, and a test that made an attempt fails (an adapter that swallows the error cannot hide it).
// A test that wants to look at the real layer stubs fetch itself, inside the test, which takes the place of this.
const networkAttempts: string[] = [];
beforeEach(() => {
  networkAttempts.length = 0;
  vi.stubGlobal("fetch", async (input: unknown) => {
    networkAttempts.push(String(input));
    throw new Error("No network in the customer payment tests.");
  });
});
afterEach(() => {
  expect(networkAttempts, "the test reached for the network").toEqual([]);
});

export const AUTHORIZATION = { accepted: true as const, version: CURRENT_AUTHORIZATION_VERSION };

export interface TestConnection {
  id: string;
  orgId: string;
  publicKey: string;
  provider: PaymentProviderId;
  mode: ConnectionMode;
  apiKey: string;
  webhookSecret: string;
}

/** A connected, authorized account whose secrets the test knows. Written straight to the table, so no provider is asked anything. */
export async function connect(
  io: InvoiceOrg,
  over: { provider?: "paymongo" | "simulated"; mode?: ConnectionMode; webhookSecret?: string | null; apiKey?: string; status?: ConnectionStatus; liveConfirmed?: boolean; currencies?: string[]; authorized?: boolean } = {},
): Promise<TestConnection> {
  const provider = over.provider ?? "paymongo";
  const mode = over.mode ?? (provider === "simulated" ? "test" : "test");
  const apiKey = over.apiKey ?? (provider === "simulated" ? `sim_${uid()}${uid()}` : `sk_${mode}_${uid()}${uid()}${uid()}`);
  const webhookSecret = over.webhookSecret === undefined ? `whsk_${crypto.randomBytes(12).toString("hex")}` : over.webhookSecret;
  const publicKey = newPublicKey();
  const status = over.status ?? (webhookSecret ? "connected" : "pending_verification");
  const r = await withSystem((db) =>
    db.query<{ id: string }>(
      `insert into customer_payment_connections (org_id, provider, mode, public_key, credentials, supported_currencies, status, authorized_by, authorized_at, authorization_text_version, live_confirmed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        io.orgId, provider, mode, publicKey, credentialVault.seal({ apiKey, webhookSecret }), over.currencies ?? (provider === "paymongo" ? ["PHP"] : ["PHP", "USD", "EUR", "GBP", "AUD", "CAD", "SGD", "JPY"]), status,
        over.authorized === false ? null : io.c.people.owner.id, over.authorized === false ? null : new Date(), over.authorized === false ? null : CURRENT_AUTHORIZATION_VERSION, over.liveConfirmed ? new Date() : null,
      ],
    ),
  );
  return { id: r.rows[0].id, orgId: io.orgId, publicKey, provider, mode, apiKey, webhookSecret: webhookSecret ?? "" };
}

export interface TestAttempt {
  id: string;
  reference: string;
  checkoutId: string | null;
  amountMinor: number;
  currency: string;
  invoiceId: string;
}

/** A checkout attempt for an invoice's balance, as startCheckout would have left it once the provider answered. */
export async function attempt(
  invoiceId: string,
  conn: TestConnection,
  over: { reference?: string; checkoutId?: string | null; amountMinor?: number; status?: string; ageMinutes?: number; expiresInHours?: number } = {},
): Promise<TestAttempt> {
  const inv = (await withSystem((db) => db.query<{ currency: string; balance: string }>("select currency, balance_minor::text as balance from customer_invoices where id = $1", [invoiceId]))).rows[0];
  const reference = over.reference ?? newReference();
  const checkoutId = over.checkoutId === undefined ? `cs_${uid()}${uid()}` : over.checkoutId;
  const amountMinor = over.amountMinor ?? Number(inv.balance);
  const r = await withSystem((db) =>
    db.query<{ id: string }>(
      `insert into customer_payment_attempts (org_id, invoice_id, connection_id, currency, amount_minor, reference, provider_checkout_id, checkout_url, status, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) returning id`,
      [
        conn.orgId, invoiceId, conn.id, inv.currency, amountMinor, reference, checkoutId, checkoutId ? `https://checkout.paymongo.com/${checkoutId}` : null, over.status ?? "redirected",
        new Date(Date.now() + (over.expiresInHours ?? 24) * 3_600_000), new Date(Date.now() - (over.ageMinutes ?? 0) * 60_000),
      ],
    ),
  );
  return { id: r.rows[0].id, reference, checkoutId, amountMinor, currency: inv.currency, invoiceId };
}

/**
 * A workspace with an issued invoice and a simulated connection whose checkout really exists on the simulated platform, so the authenticated read-back (which the
 * simulated provider supports) finds it. Resets the platform: one such workspace at a time per test.
 */
export async function simulatedSetup(over: { ageMinutes?: number } = {}) {
  simulatedPlatform.reset();
  const io = await invoiceOrg();
  const inv = (await issuedInvoice(io)).invoice;
  const conn = await connect(io, { provider: "simulated" });
  const balance = Number((await withSystem((db) => db.query<{ b: string }>("select balance_minor::text as b from customer_invoices where id = $1", [inv.id]))).rows[0].b);
  const reference = newReference();
  const co = await simulatedProvider.createCheckout({ apiKey: conn.apiKey, webhookSecret: conn.webhookSecret }, { reference, amountMinor: balance, currency: "PHP", description: "Invoice", successUrl: "https://x.example/a", cancelUrl: "https://x.example/b" });
  // Made in one step, with the checkout the platform just made, so its age is the age the test asked for (updating it afterwards would make it look touched just now).
  const a = await attempt(inv.id, conn, { reference, checkoutId: co.checkoutId, ageMinutes: over.ageMinutes });
  return { io, inv, conn, a };
}

// ---------------------------------------------------------------------------
// PayMongo-shaped bodies and signatures
// ---------------------------------------------------------------------------

/** `Paymongo-Signature`: t=<unix>,te=<hmac when test>,li=<hmac when live>, HMAC-SHA256 of "t.<raw body>" with the webhook's secret. */
export function paymongoSignature(body: string, secret: string, opts: { live?: boolean; t?: number } = {}): string {
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},te=${opts.live ? "" : sig},li=${opts.live ? sig : ""}`;
}

const envelope = (eventId: string, type: string, livemode: boolean, resource: unknown) => JSON.stringify({ data: { id: eventId, type: "event", attributes: { type, livemode, created_at: 1_700_000_000, updated_at: 1_700_000_000, data: resource } } });

export function paymongoPaid(o: { eventId?: string; checkoutId: string; reference: string; amount: number; currency?: string; livemode?: boolean; paymentId?: string; fee?: number; source?: string }): string {
  const paymentId = o.paymentId ?? `pay_${uid()}${uid()}`;
  return envelope(o.eventId ?? `evt_${uid()}${uid()}`, "checkout_session.payment.paid", o.livemode ?? false, {
    id: o.checkoutId, type: "checkout_session",
    attributes: {
      reference_number: o.reference, status: "active", metadata: { reference: o.reference },
      payments: [{ id: paymentId, type: "payment", attributes: { amount: o.amount, fee: o.fee ?? 250, net_amount: o.amount - (o.fee ?? 250), currency: o.currency ?? "PHP", status: "paid", source: { type: o.source ?? "card" } } }],
    },
  });
}

export function paymongoFailed(o: { eventId?: string; paymentId?: string; reference?: string | null; amount?: number; currency?: string; livemode?: boolean }): string {
  return envelope(o.eventId ?? `evt_${uid()}${uid()}`, "payment.failed", o.livemode ?? false, {
    id: o.paymentId ?? `pay_${uid()}${uid()}`, type: "payment",
    attributes: { amount: o.amount ?? 150000, currency: o.currency ?? "PHP", status: "failed", description: o.reference ? `Invoice [${o.reference}]` : "Something else", failed_message: "Card declined", metadata: o.reference ? { reference: o.reference } : {} },
  });
}

export function paymongoRefundUpdated(o: { eventId?: string; refundId?: string; paymentId: string; amount: number; currency?: string; status?: string; reason?: string; livemode?: boolean }): string {
  return envelope(o.eventId ?? `evt_${uid()}${uid()}`, "payment.refund.updated", o.livemode ?? false, {
    id: o.refundId ?? `ref_${uid()}${uid()}`, type: "refund", attributes: { amount: o.amount, currency: o.currency ?? "PHP", payment_id: o.paymentId, status: o.status ?? "succeeded", reason: o.reason ?? "requested_by_customer" },
  });
}

export function paymongoOther(type: string, livemode = false): string {
  return envelope(`evt_${uid()}${uid()}`, type, livemode, { id: `res_${uid()}${uid()}`, type: "payment", attributes: { amount: 1000, currency: "PHP", status: "paid" } });
}

// ---------------------------------------------------------------------------
// Delivering
// ---------------------------------------------------------------------------

const headerFor = (provider: PaymentProviderId) => (provider === "simulated" ? SIGNATURE_HEADER : "paymongo-signature");

/** Hands a delivery to the real webhook handler, signed with the connection's own secret unless the test says otherwise. */
export function deliver(
  conn: TestConnection,
  rawBody: string,
  over: { signature?: string | null; secret?: string; live?: boolean; t?: number; key?: string; provider?: string; ip?: string | null; now?: Date } = {},
): Promise<WebhookResult> {
  const sign = () => (conn.provider === "simulated" ? signSimulatedBody(over.secret ?? conn.webhookSecret, rawBody, over.t) : paymongoSignature(rawBody, over.secret ?? conn.webhookSecret, { live: over.live ?? conn.mode === "live", t: over.t }));
  const signature = over.signature === undefined ? sign() : over.signature;
  const headers = new Headers();
  if (signature !== null) headers.set(headerFor(conn.provider), signature);
  return handleCustomerPaymentWebhook({ provider: over.provider ?? conn.provider, key: over.key ?? conn.publicKey, rawBody, headers, ip: over.ip ?? null, now: over.now });
}

/** A simulated delivery of these facts, signed with the connection's secret. */
export function simulatedDelivery(conn: TestConnection, facts: Partial<NormalizedEvent> & Pick<NormalizedEvent, "kind">, over: Parameters<typeof deliver>[2] = {}) {
  return deliver(conn, simulatedBody({ type: `simulated.${facts.kind}`, livemode: conn.mode === "live", ...facts }), over);
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

export const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
export const receipts = (connId: string) => q<{ id: string; provider_event_id: string; outcome: string; attempts: number; detail: { facts?: Record<string, unknown>; note?: string; error?: string } }>("select id, provider_event_id, outcome, attempts, detail from customer_payment_events where connection_id = $1 order by received_at, id", [connId]);
export const paymentsOf = (invoiceId: string) => q<{ id: string; status: string; amount_minor: string; provider_payment_id: string | null; livemode: boolean; verification: string; attempt_id: string | null }>("select id, status, amount_minor::text, provider_payment_id, livemode, verification, attempt_id from customer_payments where invoice_id = $1 order by created_at, id", [invoiceId]);
export const invoiceNow = async (id: string) => (await q<{ payment_status: string; paid_minor: string; refunded_minor: string; balance_minor: string; overpaid_minor: string }>("select payment_status, paid_minor::text, refunded_minor::text, balance_minor::text, overpaid_minor::text from customer_invoices where id = $1", [id]))[0];
export const attemptNow = async (id: string) => (await q<{ status: string; provider_checkout_id: string | null }>("select status, provider_checkout_id from customer_payment_attempts where id = $1", [id]))[0];

// ---------------------------------------------------------------------------
// A PayMongo network layer that is a fixture
// ---------------------------------------------------------------------------

export interface FakePaymongo {
  http: PaymongoHttp;
  calls: PaymongoRequest[];
  /** What the next call(s) answer, by a predicate on the request. Falls back to a plain 404. */
  on(match: (req: PaymongoRequest) => boolean, answer: PaymongoResponse | ((req: PaymongoRequest) => PaymongoResponse)): void;
  throwNext(error: Error): void;
}

export function fakePaymongo(): FakePaymongo {
  const calls: PaymongoRequest[] = [];
  const routes: Array<{ match: (r: PaymongoRequest) => boolean; answer: PaymongoResponse | ((r: PaymongoRequest) => PaymongoResponse) }> = [];
  const failures: Error[] = [];
  const http: PaymongoHttp = async (req) => {
    calls.push(req);
    const f = failures.shift();
    if (f) throw f;
    const route = routes.find((r) => r.match(req));
    if (!route) return { status: 404, json: { errors: [{ code: "resource_not_found" }] } };
    return typeof route.answer === "function" ? route.answer(req) : route.answer;
  };
  return { http, calls, on: (match, answer) => void routes.unshift({ match, answer }), throwNext: (e) => void failures.push(e) };
}
