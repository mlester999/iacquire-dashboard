import "server-only";
import { providerRequest } from "@/server/calendars/adapters/http";
import { parseEvent as parseEnvelope, verifyWebhookSignature, type PaymongoEvent } from "@/server/billing/paymongo";
import { isCurrency } from "@/lib/money";
import { paymongoModeOf, PROVIDER_CURRENCIES } from "@/lib/invoices/connection-rules";
import { emptyEvent, type NormalizedEvent } from "@/lib/invoices/payment-events";
import type { ProviderCredentials } from "@/server/customer-payments/credentials";
import { ProviderCallError, type CanonicalCheckout, type CheckoutInput, type CheckoutResult, type CredentialCheck, type ParsedWebhook, type PaymentProviderAdapter, type SignatureCheck } from "@/server/customer-payments/providers/types";

// PayMongo, for a business collecting on its OWN PayMongo account (not iAcquire's: src/server/billing/paymongo.ts is the agency's, and this file only borrows its two
// pure functions, the signature check and the event envelope reader, which take the secret as an argument).
//
// NOT VERIFIED against PayMongo. Everything below is written from PayMongo's public documentation as remembered when this was built (October 2026) and tested against a
// replaced HTTP layer and fixtures that were written by hand, not recorded from PayMongo. Before a real client's money depends on it, a run against a PayMongo test
// account must settle each of these, which are the guesses most likely to be wrong:
//   1. The checkout path: this uses POST /v1/checkout_sessions. The agency's own code (src/server/billing/paymongo.ts) calls /v2/checkout_sessions and says it never ran
//      either; one of the two is wrong. The path is CHECKOUT_PATH below.
//   2. The refund events: `payment.refunded` (a payment carrying a `refunds` list) and `payment.refund.updated` (a refund carrying `payment_id`, `amount`, `status`).
//   3. The failure event: `payment.failed`, and where it carries the reference (`external_reference_number`, `metadata.reference` or the description are all read).
//   4. The read-back: GET /v1/checkout_sessions/{id} listing `payments` with their status, amount and currency.
//   5. The read-only call that proves a key: GET /v1/webhooks (a secret key lists its webhooks; a rejected key answers 401).
//   6. That a registered webhook's signing secret is shown once and pasted by the owner (registering one through the API is not attempted).
//   7. The smallest amount PayMongo accepts for a checkout, and which payment methods an account has enabled (this asks for cards unless the owner chose others).
// PayMongo settles Philippine pesos only, so a connection offers PHP.

const API_ORIGIN = "https://api.paymongo.com";
export const CHECKOUT_PATH = "/v1/checkout_sessions"; // UNVERIFIED: see 1 above.
const CHECKOUT_HOST = /(^|\.)paymongo\.com$/i;
const DEFAULT_METHODS = ["card"]; // UNVERIFIED: see 7 above.

export interface PaymongoRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  apiKey: string;
}
export interface PaymongoResponse {
  status: number;
  json: unknown;
}
/** The one place this adapter touches the network: a test hands in its own. */
export type PaymongoHttp = (req: PaymongoRequest) => Promise<PaymongoResponse>;

/** The real network call: PayMongo's fixed origin only, no redirects, the key in a header and never in a URL, a time limit and a size cap. */
export const paymongoHttp: PaymongoHttp = async (req) => {
  let res;
  try {
    res = await providerRequest(
      null,
      `${API_ORIGIN}${req.path}`,
      [API_ORIGIN],
      { method: req.method, headers: { Authorization: `Basic ${Buffer.from(`${req.apiKey}:`).toString("base64")}`, "Content-Type": "application/json" }, body: req.body === undefined ? undefined : JSON.stringify(req.body), timeoutMs: 15_000, maxBytes: 1_000_000 },
      "PayMongo",
    );
  } catch {
    throw new ProviderCallError("unreachable", "PayMongo could not be reached, or took too long to answer.");
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
const minor = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** The provider's own sentence with any address or key-like text taken out, so it can be shown to a person. */
function clean(text: string, max: number): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/gi, "[url]")
    .replace(/\b(?:sk|pk|whsec|whsk)[A-Za-z0-9._-]{12,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** The provider's reason for a refusal, made safe to show: its error code, and its own sentence with any URL or key-like text removed. */
function refusal(res: PaymongoResponse): string {
  const first = isRecord(res.json) && Array.isArray(res.json.errors) && isRecord(res.json.errors[0]) ? res.json.errors[0] : null;
  const code = first && typeof first.code === "string" && /^[a-z0-9_]{2,60}$/.test(first.code) ? first.code : null;
  const detail = first && typeof first.detail === "string" ? clean(first.detail, 160) : null;
  return `PayMongo declined the request${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}.`;
}

/** Turns a non-success answer into the error a person can act on. 404 is handled by the caller where it means "not found". */
function failFor(res: PaymongoResponse): ProviderCallError {
  if (res.status === 401 || res.status === 403) return new ProviderCallError("rejected", "PayMongo did not accept this key. Check that it is the secret key, for the right mode, and that it is still active.", res.status);
  if (res.status === 429 || res.status >= 500) return new ProviderCallError("unreachable", "PayMongo is busy or having trouble right now. Try again in a few minutes.", res.status);
  return new ProviderCallError("rejected", refusal(res), res.status);
}

const methodsFor = (c: ProviderCredentials) => (c.settings?.paymentMethods?.length ? c.settings.paymentMethods : DEFAULT_METHODS);

function checkoutUrlOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderCallError("invalid_response", "PayMongo returned an invalid checkout link. Nothing was charged.");
  }
  // Only a PayMongo page: a link anywhere else is never handed to a customer.
  if (url.protocol !== "https:" || !CHECKOUT_HOST.test(url.hostname)) throw new ProviderCallError("invalid_response", "The checkout link did not point to PayMongo, so it was not used. Nothing was charged.");
  return url.toString();
}

const statusOfPayment = (s: unknown): "paid" | "pending" | "failed" | "other" => (s === "paid" ? "paid" : s === "pending" ? "pending" : s === "failed" ? "failed" : "other");

/** A reference of ours inside whatever the failure event carries. */
function referenceIn(attrs: Record<string, unknown>): string | null {
  const direct = str(attrs.external_reference_number) ?? (isRecord(attrs.metadata) ? str(attrs.metadata.reference) : null);
  if (direct && /^CP-[A-Za-z0-9]{20,40}$/.test(direct)) return direct;
  const fromText = /\b(CP-[A-Za-z0-9]{20,40})\b/.exec(str(attrs.description) ?? "");
  return fromText ? fromText[1] : null;
}

function currencyOf(v: unknown): string | null {
  const c = typeof v === "string" ? v.toUpperCase() : null;
  return c && isCurrency(c) ? c : null;
}

/** One PayMongo delivery as facts. A type this product does not use becomes "ignored", which the services acknowledge without storing anything. */
function normalize(ev: PaymongoEvent): NormalizedEvent {
  const base = { eventId: ev.id, type: ev.type, livemode: ev.livemode };
  const attrs = ev.resource.attributes;
  const ignored = (reason: string) => ({ ...emptyEvent("ignored", base), reason });

  if (ev.type === "checkout_session.payment.paid") {
    const paid = (Array.isArray(attrs.payments) ? attrs.payments : []).filter((p): p is { id: string; attributes: Record<string, unknown> } => isRecord(p) && typeof p.id === "string" && isRecord(p.attributes) && p.attributes.status === "paid");
    if (paid.length !== 1) return ignored("The event does not hold exactly one paid payment; a later check of the checkout records each one.");
    const p = paid[0].attributes;
    const source = isRecord(p.source) ? str(p.source.type) : null;
    return { ...emptyEvent("payment.succeeded", base), checkoutId: ev.resource.id, reference: str(attrs.reference_number), paymentId: paid[0].id, amountMinor: minor(p.amount), currency: currencyOf(p.currency), feeMinor: minor(p.fee), method: source };
  }
  if (ev.type === "payment.failed") {
    return { ...emptyEvent("payment.failed", base), reference: referenceIn(attrs), paymentId: ev.resource.id, amountMinor: minor(attrs.amount), currency: currencyOf(attrs.currency), reason: str(attrs.failed_message) ?? str(attrs.failed_code) };
  }
  if (ev.type === "payment.refund.updated") {
    const status = str(attrs.status);
    const kind = status === "succeeded" ? "refund.succeeded" : status === "failed" ? "refund.failed" : status === "pending" ? "refund.pending" : null;
    if (!kind) return ignored("The refund is in a state this product does not act on.");
    return { ...emptyEvent(kind, base), paymentId: str(attrs.payment_id), refundId: ev.resource.id, amountMinor: minor(attrs.amount), currency: currencyOf(attrs.currency), reason: str(attrs.reason) ?? str(attrs.notes) };
  }
  if (ev.type === "payment.refunded") {
    const list = (Array.isArray(attrs.refunds) ? attrs.refunds : []).filter((r): r is { id: string; attributes: Record<string, unknown> } => isRecord(r) && typeof r.id === "string" && isRecord(r.attributes));
    // Several partial refunds ride on one payment; the newest is this event's (an older one was reported by its own event).
    const newest = [...list].sort((a, b) => (minor(a.attributes.created_at) ?? 0) - (minor(b.attributes.created_at) ?? 0)).at(-1);
    if (!newest) return ignored("The event lists no refund.");
    const status = str(newest.attributes.status);
    if (status !== "succeeded") return ignored("The refund has not succeeded yet.");
    return { ...emptyEvent("refund.succeeded", base), paymentId: ev.resource.id, refundId: newest.id, amountMinor: minor(newest.attributes.amount), currency: currencyOf(newest.attributes.currency ?? attrs.currency), reason: str(newest.attributes.reason) ?? str(newest.attributes.notes) };
  }
  return ignored("Event type is not used.");
}

export function createPaymongoProvider(deps: { http?: PaymongoHttp } = {}): PaymentProviderAdapter {
  const http = deps.http ?? paymongoHttp;
  return {
    id: "paymongo",
    contractVerified: false,
    supportedCurrencies: PROVIDER_CURRENCIES.paymongo,

    modeOf: (c) => paymongoModeOf(c.apiKey),

    async verifyCredentials(c, opts): Promise<CredentialCheck> {
      let res: PaymongoResponse;
      try {
        res = await http({ method: "GET", path: "/v1/webhooks", apiKey: c.apiKey });
      } catch (e) {
        return { ok: false, reason: e instanceof ProviderCallError && e.kind === "rejected" ? "rejected" : "unreachable", message: e instanceof ProviderCallError ? e.message : "PayMongo could not be reached." };
      }
      if (res.status >= 200 && res.status < 300) {
        const list = isRecord(res.json) && Array.isArray(res.json.data) ? res.json.data : null;
        const found = list === null ? null : list.some((w) => isRecord(w) && isRecord(w.attributes) && w.attributes.url === opts.webhookUrl && w.attributes.status !== "disabled");
        return { ok: true, accountLabel: null, webhookFound: found };
      }
      const err = failFor(res);
      return { ok: false, reason: err.kind === "rejected" ? "rejected" : "unreachable", message: err.message };
    },

    async createCheckout(c, input: CheckoutInput): Promise<CheckoutResult> {
      const res = await http({
        method: "POST",
        path: CHECKOUT_PATH,
        apiKey: c.apiKey,
        body: {
          data: {
            attributes: {
              line_items: [{ name: input.description.slice(0, 120), amount: input.amountMinor, currency: input.currency, quantity: 1 }],
              payment_method_types: methodsFor(c),
              success_url: input.successUrl,
              cancel_url: input.cancelUrl,
              reference_number: input.reference,
              description: input.description.slice(0, 200),
              send_email_receipt: false,
              metadata: { reference: input.reference },
            },
          },
        },
      });
      if (res.status < 200 || res.status >= 300) throw failFor(res);
      const data = isRecord(res.json) && isRecord(res.json.data) ? res.json.data : null;
      const id = data ? str(data.id) : null;
      const url = data && isRecord(data.attributes) ? str(data.attributes.checkout_url) : null;
      if (!id || !url) throw new ProviderCallError("invalid_response", "PayMongo returned an unexpected answer. Nothing was charged.");
      return { checkoutId: id, checkoutUrl: checkoutUrlOf(url) };
    },

    async fetchCheckout(c, checkoutId): Promise<CanonicalCheckout | null> {
      if (!/^[A-Za-z0-9_-]{4,120}$/.test(checkoutId)) return null;
      const res = await http({ method: "GET", path: `${CHECKOUT_PATH}/${checkoutId}`, apiKey: c.apiKey });
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) throw failFor(res);
      const data = isRecord(res.json) && isRecord(res.json.data) ? res.json.data : null;
      const attrs = data && isRecord(data.attributes) ? data.attributes : null;
      if (!data || !attrs || str(data.id) !== checkoutId) throw new ProviderCallError("invalid_response", "PayMongo returned an unexpected answer.");
      const payments = (Array.isArray(attrs.payments) ? attrs.payments : [])
        .filter((p): p is { id: string; attributes: Record<string, unknown> } => isRecord(p) && typeof p.id === "string" && isRecord(p.attributes))
        .map((p) => ({ id: p.id, status: statusOfPayment(p.attributes.status), amountMinor: minor(p.attributes.amount), currency: currencyOf(p.attributes.currency), feeMinor: minor(p.attributes.fee), livemode: typeof p.attributes.livemode === "boolean" ? p.attributes.livemode : null }));
      const status = payments.some((p) => p.status === "paid") ? "paid" : attrs.status === "expired" ? "expired" : attrs.status === "active" ? "open" : "other";
      return { checkoutId, reference: str(attrs.reference_number), status, payments };
    },

    verifyWebhook({ rawBody, headers, secret, now }): SignatureCheck {
      const r = verifyWebhookSignature({ header: headers.get("paymongo-signature"), rawBody, secret, now });
      return r.ok ? { ok: true, livemode: r.livemode } : { ok: false, reason: r.reason };
    },

    parseEvent(rawBody): ParsedWebhook | null {
      const ev = parseEnvelope(rawBody);
      return ev ? { event: normalize(ev) } : null;
    },
  };
}

export const paymongoProvider = createPaymongoProvider();
