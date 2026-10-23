import "server-only";
import { providerRequest } from "@/server/calendars/adapters/http";
import { isCurrency, parseAmount, toDecimalString, type CurrencyCode } from "@/lib/money";
import { paypalModeOf, PROVIDER_CURRENCIES } from "@/lib/invoices/connection-rules";
import { emptyEvent, looksLikeOurReference, type NormalizedEvent } from "@/lib/invoices/payment-events";
import type { ProviderCredentials } from "@/server/customer-payments/credentials";
import { ProviderCallError, type CanonicalCheckout, type CheckoutInput, type CheckoutResult, type CredentialCheck, type HeaderReader, type ParsedWebhook, type PaymentProviderAdapter, type SignatureCheck } from "@/server/customer-payments/providers/types";

// PayPal, for a business collecting on its OWN PayPal account.
//
// NOT VERIFIED against PayPal. Everything below is written from PayPal's public documentation as remembered when this was built (October 2026) and tested against a replaced
// HTTP layer and fixtures written by hand, not recorded from PayPal. Before a real client's money depends on it, a run against a PayPal sandbox app must settle each of these,
// which are the guesses most likely to be wrong:
//   1. The Orders v2 request: POST /v2/checkout/orders with intent CAPTURE, our reference in purchase_units[0].custom_id, and payment_source.paypal.experience_context carrying
//      the return and cancel addresses. Whether the buyer's approval address comes back as a link with rel "payer-action" or "approve" (both are read).
//   2. That approving does NOT take the money: the order is captured by a second call, POST /v2/checkout/orders/{id}/capture, made after the buyer returns (completeCheckout).
//   3. The event names and their shapes: PAYMENT.CAPTURE.COMPLETED / PENDING / DENIED / REFUNDED / REVERSED, CUSTOMER.DISPUTE.CREATED / RESOLVED, and CHECKOUT.ORDER.APPROVED.
//      Where each carries our reference (custom_id), the order id (supplementary_data.related_ids.order_id) and the capture a refund belongs to (a link with rel "up").
//   4. Webhook verification by asking PayPal: POST /v1/notifications/verify-webhook-signature with the five transmission headers, the webhook id and the event body exactly as
//      received, answered with verification_status SUCCESS. (The offline algorithm, a CRC32 of the body and an RSA check against the certificate at PAYPAL-CERT-URL, is not built.)
//   5. The read-only call that proves a client id and secret: the OAuth token call, and GET /v1/notifications/webhooks to see whether a webhook for our address is registered.
//   6. The currencies an account can take (all eight of ours are offered; an account may not support each), and whether JPY amounts are sent without decimals.
//   7. How long after an event PayPal still retries it, and what transmission time a retry carries (the window below is a guess).
// A PayPal event does not say whether it is test or live: the connection says (sandbox or live), and its address is the only thing that ties a delivery to it.

const ORIGINS = { sandbox: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" } as const;
const PAGE_HOST = /(^|\.)paypal\.com$/i;
const CERT_HOST = /(^|\.)paypal\.com$/i;
/** A delivery older than this is refused (the guess in 7 above); a replay inside it is stopped by the event ledger. */
const TRANSMISSION_WINDOW_MS = 72 * 3_600_000;

export interface PaypalRequest {
  method: "GET" | "POST";
  path: string;
  environment: "sandbox" | "live";
  /** Already serialized: JSON, or form-encoded for the token call. */
  body?: string;
  contentType?: string;
  bearer?: string;
  basic?: { id: string; secret: string };
  headers?: Record<string, string>;
}
export interface PaypalResponse {
  status: number;
  json: unknown;
}
/** The one place this adapter touches the network: a test hands in its own. */
export type PaypalHttp = (req: PaypalRequest) => Promise<PaypalResponse>;

/** The real network call: PayPal's two fixed origins only, no redirects, the secret in a header and never in a URL, a time limit and a size cap. */
export const paypalHttp: PaypalHttp = async (req) => {
  const origin = ORIGINS[req.environment];
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (req.contentType) headers["Content-Type"] = req.contentType;
  if (req.bearer) headers.Authorization = `Bearer ${req.bearer}`;
  else if (req.basic) headers.Authorization = `Basic ${Buffer.from(`${req.basic.id}:${req.basic.secret}`).toString("base64")}`;
  let res;
  try {
    res = await providerRequest(null, `${origin}${req.path}`, [origin], { method: req.method, headers, body: req.body, timeoutMs: 15_000, maxBytes: 1_000_000 }, "PayPal");
  } catch {
    throw new ProviderCallError("unreachable", "PayPal could not be reached, or took too long to answer.");
  }
  let json: unknown = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The provider's own sentence with any address or key-like text taken out, so it can be shown to a person. */
function clean(text: string, max: number): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/gi, "[url]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function refusal(res: PaypalResponse): string {
  const j = isRecord(res.json) ? res.json : null;
  const name = j && typeof j.name === "string" && /^[A-Z0-9_]{2,60}$/.test(j.name) ? j.name : null;
  const message = j && typeof j.message === "string" ? clean(j.message, 160) : null;
  return `PayPal declined the request${name ? ` (${name})` : ""}${message ? `: ${message}` : ""}.`;
}

function failFor(res: PaypalResponse): ProviderCallError {
  if (res.status === 401 || res.status === 403) return new ProviderCallError("rejected", "PayPal did not accept this client ID and secret. Check that they are for the right mode (sandbox or live) and that the app is still active.", res.status);
  if (res.status === 429 || res.status >= 500) return new ProviderCallError("unreachable", "PayPal is busy or having trouble right now. Try again in a few minutes.", res.status);
  return new ProviderCallError("rejected", refusal(res), res.status);
}

const environmentOf = (c: ProviderCredentials): "sandbox" | "live" | null => (c.settings?.environment === "live" ? "live" : c.settings?.environment === "sandbox" ? "sandbox" : null);

function approvalUrlOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderCallError("invalid_response", "PayPal returned an invalid payment link. Nothing was charged.");
  }
  // Only a PayPal page: a link anywhere else is never handed to a customer.
  if (url.protocol !== "https:" || !PAGE_HOST.test(url.hostname)) throw new ProviderCallError("invalid_response", "The payment link did not point to PayPal, so it was not used. Nothing was charged.");
  return url.toString();
}

/** PayPal's decimal string in this currency's minor unit, or null when it is not a valid amount in that currency. */
function minorOf(value: unknown, currency: string | null): number | null {
  if (typeof value !== "string" || !currency || !isCurrency(currency)) return null;
  try {
    return parseAmount(value, currency);
  } catch {
    return null;
  }
}

const currencyOf = (v: unknown): CurrencyCode | null => {
  const c = typeof v === "string" ? v.toUpperCase() : null;
  return c && isCurrency(c) ? c : null;
};

function captureStatus(s: unknown): "paid" | "pending" | "failed" | "other" {
  return s === "COMPLETED" ? "paid" : s === "PENDING" ? "pending" : s === "DECLINED" || s === "FAILED" ? "failed" : "other";
}

/** An order as PayPal describes it, as the provider-neutral record of a checkout. */
function canonicalOf(order: unknown, checkoutId: string): CanonicalCheckout {
  const o = isRecord(order) ? order : {};
  if (str(o.id) !== checkoutId) throw new ProviderCallError("invalid_response", "PayPal returned an unexpected answer.");
  const unit = Array.isArray(o.purchase_units) && isRecord(o.purchase_units[0]) ? o.purchase_units[0] : {};
  const captures = isRecord(unit.payments) && Array.isArray(unit.payments.captures) ? unit.payments.captures.filter(isRecord) : [];
  const payments = captures.flatMap((cap) => {
    const id = str(cap.id);
    if (!id) return [];
    const amount = isRecord(cap.amount) ? cap.amount : {};
    const currency = currencyOf(amount.currency_code);
    const fee = isRecord(cap.seller_receivable_breakdown) && isRecord(cap.seller_receivable_breakdown.paypal_fee) ? cap.seller_receivable_breakdown.paypal_fee : {};
    return [{ id, status: captureStatus(cap.status), amountMinor: minorOf(amount.value, currency), currency, feeMinor: minorOf(fee.value, currency), livemode: null as boolean | null }];
  });
  const status = payments.some((p) => p.status === "paid") ? "paid" : o.status === "VOIDED" ? "expired" : ["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED"].includes(String(o.status)) ? "open" : "other";
  return { checkoutId, reference: str(unit.custom_id), status, payments };
}

function normalize(ev: Record<string, unknown>, connectionLive: boolean): NormalizedEvent {
  const base = { eventId: str(ev.id) ?? "", type: str(ev.event_type) ?? "unknown", livemode: connectionLive };
  const r = isRecord(ev.resource) ? ev.resource : {};
  const ignored = (reason: string) => ({ ...emptyEvent("ignored", base), reason });
  const amount = isRecord(r.amount) ? r.amount : {};
  const currency = currencyOf(amount.currency_code);
  const amountMinor = minorOf(amount.value, currency);
  const orderId = isRecord(r.supplementary_data) && isRecord(r.supplementary_data.related_ids) ? str(r.supplementary_data.related_ids.order_id) : null;
  const custom = str(r.custom_id);
  const reference = custom && looksLikeOurReference(custom) ? custom : null;
  const fee = isRecord(r.seller_receivable_breakdown) && isRecord(r.seller_receivable_breakdown.paypal_fee) ? r.seller_receivable_breakdown.paypal_fee : {};
  const occurredAt = str(r.create_time) ?? str(ev.create_time);
  const captureFacts = { checkoutId: orderId, reference, paymentId: str(r.id), amountMinor, currency, feeMinor: minorOf(fee.value, currency), method: "paypal", occurredAt };

  switch (base.type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      return r.status === "COMPLETED" ? { ...emptyEvent("payment.succeeded", base), ...captureFacts } : ignored("The capture is not in the completed state.");
    case "PAYMENT.CAPTURE.PENDING":
      return { ...emptyEvent("payment.pending", base), ...captureFacts };
    case "PAYMENT.CAPTURE.DENIED":
      return { ...emptyEvent("payment.failed", base), ...captureFacts, reason: "PayPal denied the payment." };
    case "PAYMENT.CAPTURE.REFUNDED": {
      // The resource is the refund; the capture it belongs to is the link that points up.
      const up = (Array.isArray(r.links) ? r.links : []).find((l) => isRecord(l) && l.rel === "up" && typeof l.href === "string");
      const captureId = up && isRecord(up) ? /\/captures\/([A-Za-z0-9_-]{4,120})\/?$/.exec(String(up.href))?.[1] ?? null : null;
      return { ...emptyEvent("refund.succeeded", base), paymentId: captureId, refundId: str(r.id), amountMinor, currency, reason: str(r.note_to_payer) ?? "Refunded at PayPal", occurredAt };
    }
    case "PAYMENT.CAPTURE.REVERSED":
      // Money taken back by the buyer's bank or PayPal: the invoice is held as disputed for a person to look at.
      return { ...emptyEvent("dispute.opened", base), paymentId: str(r.id), amountMinor, currency, occurredAt };
    case "CUSTOMER.DISPUTE.CREATED":
    case "CUSTOMER.DISPUTE.RESOLVED": {
      const tx = Array.isArray(r.disputed_transactions) && isRecord(r.disputed_transactions[0]) ? r.disputed_transactions[0] : {};
      return { ...emptyEvent(base.type === "CUSTOMER.DISPUTE.CREATED" ? "dispute.opened" : "dispute.closed", base), paymentId: str(tx.seller_transaction_id), occurredAt };
    }
    case "CHECKOUT.ORDER.APPROVED":
      // The buyer approved. That is not payment: the money is counted when the capture completes.
      return ignored("Approval is not payment. The money is counted when PayPal reports the payment was captured.");
    default:
      return ignored("Event type is not used.");
  }
}

const HEADER_NAMES = { algo: "paypal-auth-algo", cert: "paypal-cert-url", id: "paypal-transmission-id", sig: "paypal-transmission-sig", time: "paypal-transmission-time" } as const;

function transmissionOf(headers: HeaderReader): { algo: string; cert: string; id: string; sig: string; time: string } | null {
  const get = (n: string) => headers.get(n);
  const algo = get(HEADER_NAMES.algo);
  const cert = get(HEADER_NAMES.cert);
  const id = get(HEADER_NAMES.id);
  const sig = get(HEADER_NAMES.sig);
  const time = get(HEADER_NAMES.time);
  if (!algo || !cert || !id || !sig || !time) return null;
  if (algo.length > 40 || id.length > 120 || sig.length > 2000 || time.length > 40 || cert.length > 400) return null;
  return { algo, cert, id, sig, time };
}

export function createPaypalProvider(deps: { http?: PaypalHttp } = {}): PaymentProviderAdapter {
  const http = deps.http ?? paypalHttp;

  async function token(c: ProviderCredentials): Promise<{ environment: "sandbox" | "live"; bearer: string }> {
    const environment = environmentOf(c);
    if (!environment || !c.apiSecret) throw new ProviderCallError("rejected", "The saved PayPal details are incomplete. Paste the client ID and secret again.");
    const res = await http({ method: "POST", path: "/v1/oauth2/token", environment, basic: { id: c.apiKey, secret: c.apiSecret }, contentType: "application/x-www-form-urlencoded", body: "grant_type=client_credentials" });
    if (res.status < 200 || res.status >= 300) throw failFor(res);
    const bearer = isRecord(res.json) ? str(res.json.access_token) : null;
    if (!bearer) throw new ProviderCallError("invalid_response", "PayPal returned an unexpected answer.");
    return { environment, bearer };
  }

  /** The order as PayPal holds it, with the token that read it (so a capture right after does not ask for another). */
  async function readOrder(c: ProviderCredentials, checkoutId: string): Promise<{ raw: unknown; environment: "sandbox" | "live"; bearer: string } | null> {
    if (!/^[A-Za-z0-9_-]{4,120}$/.test(checkoutId)) return null;
    const { environment, bearer } = await token(c);
    const res = await http({ method: "GET", path: `/v2/checkout/orders/${checkoutId}`, environment, bearer });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw failFor(res);
    return { raw: res.json, environment, bearer };
  }

  async function getOrder(c: ProviderCredentials, checkoutId: string): Promise<CanonicalCheckout | null> {
    const read = await readOrder(c, checkoutId);
    return read ? canonicalOf(read.raw, checkoutId) : null;
  }

  return {
    id: "paypal",
    contractVerified: false,
    verifiesRemotely: true,
    supportedCurrencies: PROVIDER_CURRENCIES.paypal,

    modeOf: (c) => paypalModeOf(c.settings?.environment),

    async verifyCredentials(c, opts): Promise<CredentialCheck> {
      try {
        const { environment, bearer } = await token(c);
        const res = await http({ method: "GET", path: "/v1/notifications/webhooks", environment, bearer });
        if (res.status >= 200 && res.status < 300) {
          const list = isRecord(res.json) && Array.isArray(res.json.webhooks) ? res.json.webhooks : null;
          return { ok: true, accountLabel: null, webhookFound: list === null ? null : list.some((w) => isRecord(w) && w.url === opts.webhookUrl) };
        }
        // The keys work (the token call accepted them) but this app may not be allowed to list webhooks: whether a webhook exists is simply not known.
        return { ok: true, accountLabel: null, webhookFound: null };
      } catch (e) {
        return { ok: false, reason: e instanceof ProviderCallError && e.kind === "rejected" ? "rejected" : "unreachable", message: e instanceof ProviderCallError ? e.message : "PayPal could not be reached." };
      }
    },

    async createCheckout(c, input: CheckoutInput): Promise<CheckoutResult> {
      const { environment, bearer } = await token(c);
      const body = JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          custom_id: input.reference,
          description: input.description.slice(0, 120),
          amount: { currency_code: input.currency, value: toDecimalString(input.amountMinor, input.currency) },
        }],
        payment_source: { paypal: { experience_context: { return_url: input.successUrl, cancel_url: input.cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } },
      });
      // The reference is the idempotency key: asking twice for the same attempt gives the same order.
      const res = await http({ method: "POST", path: "/v2/checkout/orders", environment, bearer, contentType: "application/json", body, headers: { "PayPal-Request-Id": input.reference, Prefer: "return=representation" } });
      if (res.status < 200 || res.status >= 300) throw failFor(res);
      const j = isRecord(res.json) ? res.json : null;
      const id = j ? str(j.id) : null;
      const links = j && Array.isArray(j.links) ? j.links.filter(isRecord) : [];
      const approve = links.find((l) => l.rel === "payer-action") ?? links.find((l) => l.rel === "approve");
      const href = approve ? str(approve.href) : null;
      if (!id || !href) throw new ProviderCallError("invalid_response", "PayPal returned an unexpected answer. Nothing was charged.");
      return { checkoutId: id, checkoutUrl: approvalUrlOf(href) };
    },

    fetchCheckout: (c, checkoutId) => getOrder(c, checkoutId),

    async completeCheckout(c, checkoutId, opts): Promise<CanonicalCheckout | null> {
      const read = await readOrder(c, checkoutId);
      if (!read) return null;
      // Only an order the buyer approved is captured. One already paid, or not yet approved, is left exactly as it is.
      if (!isRecord(read.raw) || read.raw.status !== "APPROVED") return canonicalOf(read.raw, checkoutId);
      const { environment, bearer } = read;
      const res = await http({ method: "POST", path: `/v2/checkout/orders/${checkoutId}/capture`, environment, bearer, contentType: "application/json", body: "{}", headers: { "PayPal-Request-Id": `${opts.reference}-capture`, Prefer: "return=representation" } });
      if (res.status >= 200 && res.status < 300) return canonicalOf(res.json, checkoutId);
      // Captured a moment ago by the buyer's own return (or a retry): read it back.
      if (res.status === 422 && isRecord(res.json) && Array.isArray(res.json.details) && res.json.details.some((d) => isRecord(d) && d.issue === "ORDER_ALREADY_CAPTURED")) return getOrder(c, checkoutId);
      throw failFor(res);
    },

    async verifyWebhook({ rawBody, headers, secret, now, credentials }): Promise<SignatureCheck> {
      try {
        const t = transmissionOf(headers);
        if (!t) return { ok: false, reason: "missing" };
        let cert: URL;
        try {
          cert = new URL(t.cert);
        } catch {
          return { ok: false, reason: "malformed" };
        }
        if (cert.protocol !== "https:" || !CERT_HOST.test(cert.hostname)) return { ok: false, reason: "certificate_host" };
        const sent = Date.parse(t.time);
        if (!Number.isFinite(sent) || Math.abs(now - sent) > TRANSMISSION_WINDOW_MS) return { ok: false, reason: "stale" };
        if (!credentials) return { ok: false, reason: "no_credentials" };
        // The body is put into the request as text, so it must be exactly one JSON object: anything else (text after the object that adds keys of its own, such as another
        // webhook id) could change what PayPal is asked.
        try {
          if (!isRecord(JSON.parse(rawBody))) return { ok: false, reason: "malformed" };
        } catch {
          return { ok: false, reason: "malformed" };
        }
        const { environment, bearer } = await token(credentials);
        // The event body goes in exactly as received: parsing and re-writing it would change the bytes that were signed.
        const body = `{"auth_algo":${JSON.stringify(t.algo)},"cert_url":${JSON.stringify(t.cert)},"transmission_id":${JSON.stringify(t.id)},"transmission_sig":${JSON.stringify(t.sig)},"transmission_time":${JSON.stringify(t.time)},"webhook_id":${JSON.stringify(secret)},"webhook_event":${rawBody}}`;
        const res = await http({ method: "POST", path: "/v1/notifications/verify-webhook-signature", environment, bearer, contentType: "application/json", body });
        if (res.status >= 200 && res.status < 300 && isRecord(res.json) && res.json.verification_status === "SUCCESS") return { ok: true, livemode: null };
        return { ok: false, reason: "mismatch" };
      } catch {
        // Nothing about why is returned to the caller: an unreachable PayPal and a forged delivery look the same from outside.
        return { ok: false, reason: "unverifiable" };
      }
    },

    parseEvent(rawBody, ctx): ParsedWebhook | null {
      let ev: unknown;
      try {
        ev = JSON.parse(rawBody);
      } catch {
        return null;
      }
      if (!isRecord(ev) || !str(ev.id) || !str(ev.event_type)) return null;
      return { event: normalize(ev, ctx?.connectionLive ?? false) };
    },
  };
}

export const paypalProvider = createPaypalProvider();
