import "server-only";
import crypto from "node:crypto";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";

// Contract source: PayMongo developer documentation (webhook signing, hosted checkout, event payloads),
// read 2026-10-14. It has NOT been exercised against a live or test PayMongo account yet.

const OFFICIAL_API = "https://api.paymongo.com";
const CHECKOUT_HOST = /(^|\.)paymongo\.com$/i;

/** The provider's API address: PayMongo's own, or (development and test only, a key that is a test key, this machine only: env.ts refuses anything else) the simulator's. */
const apiBase = () => (env().PAYMONGO_API_BASE ?? OFFICIAL_API).replace(/\/$/, "");

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PaymongoStatus {
  configured: boolean;
  webhookConfigured: boolean;
  /** Derived from the key prefix; null until a key is set. */
  livemode: boolean | null;
  paymentMethods: string[];
  problems: string[];
}

export function paymongoStatus(): PaymongoStatus {
  const e = env();
  const problems: string[] = [];
  if (!e.PAYMONGO_SECRET_KEY) problems.push("PAYMONGO_SECRET_KEY is not set.");
  if (!e.PAYMONGO_WEBHOOK_SECRET) problems.push("PAYMONGO_WEBHOOK_SECRET is not set, so payments cannot be confirmed.");
  const paymentMethods = e.PAYMONGO_PAYMENT_METHODS.split(",").map((m) => m.trim()).filter(Boolean);
  if (!paymentMethods.length) problems.push("PAYMONGO_PAYMENT_METHODS lists no payment methods.");
  return {
    configured: Boolean(e.PAYMONGO_SECRET_KEY) && paymentMethods.length > 0,
    webhookConfigured: Boolean(e.PAYMONGO_WEBHOOK_SECRET),
    livemode: e.PAYMONGO_SECRET_KEY ? e.PAYMONGO_SECRET_KEY.startsWith("sk_live_") : null,
    paymentMethods,
    problems,
  };
}

export interface ParsedSignature {
  timestamp: string;
  test: string;
  live: string;
}

export function parseSignatureHeader(header: string | null | undefined): ParsedSignature | null {
  if (!header) return null;
  const parts = new Map<string, string>();
  for (const piece of header.split(",")) {
    const index = piece.indexOf("=");
    if (index > 0) parts.set(piece.slice(0, index).trim(), piece.slice(index + 1).trim());
  }
  const timestamp = parts.get("t");
  if (!timestamp || !/^\d{9,12}$/.test(timestamp)) return null;
  return { timestamp, test: parts.get("te") ?? "", live: parts.get("li") ?? "" };
}

export type SignatureResult = { ok: true; livemode: boolean } | { ok: false; reason: "missing" | "malformed" | "mismatch" | "stale" };

/**
 * Verifies a webhook against the raw request body. The signed string is `<timestamp>.<raw body>`, HMAC-SHA256 with the
 * endpoint's secret. `te` signs test events and `li` signs live events; the other is empty. A signature that is valid
 * for one mode is never accepted for the other. The timestamp window only limits how old a *forged* replay can be;
 * the event id ledger is what makes legitimate retries and replays harmless, so the window is deliberately generous.
 */
export function verifyWebhookSignature(input: { header: string | null | undefined; rawBody: string; secret: string; now?: number; toleranceSeconds?: number }): SignatureResult {
  if (!input.header) return { ok: false, reason: "missing" };
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const livemode = parsed.live.length > 0 && parsed.test.length === 0;
  const provided = livemode ? parsed.live : parsed.test;
  if (!provided || (parsed.live && parsed.test)) return { ok: false, reason: "malformed" };
  const expected = crypto.createHmac("sha256", input.secret).update(`${parsed.timestamp}.${input.rawBody}`).digest("hex");
  const a = Buffer.from(provided.toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(parsed.timestamp)) > (input.toleranceSeconds ?? 24 * 3600)) return { ok: false, reason: "stale" };
  return { ok: true, livemode };
}

export interface PaymongoResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}

export interface PaymongoEvent {
  /** The provider's event id, or a stable fallback derived from the resource, used for de-duplication. */
  id: string;
  type: string;
  livemode: boolean;
  resource: PaymongoResource;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Accepts the documented envelope and the alternate one shown on the hosted-checkout page. */
export function parseEvent(raw: string): PaymongoEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(body) || !isRecord(body.data)) return null;
  const outer = body.data;
  let type: unknown;
  let livemode: unknown;
  let resource: unknown;
  let id: unknown;
  if (isRecord(outer.attributes) && typeof outer.attributes.type === "string") {
    type = outer.attributes.type;
    livemode = outer.attributes.livemode;
    resource = outer.attributes.data;
    id = outer.id;
  } else if (typeof outer.type === "string" && isRecord(outer.data)) {
    type = outer.type;
    livemode = outer.livemode;
    resource = outer.data;
    id = undefined;
  } else {
    return null;
  }
  if (typeof type !== "string" || typeof livemode !== "boolean" || !isRecord(resource)) return null;
  if (typeof resource.id !== "string" || !isRecord(resource.attributes)) return null;
  const eventId = typeof id === "string" && id.length >= 6 ? id : `${type}:${resource.id}`;
  return { id: eventId.slice(0, 120), type: type.slice(0, 80), livemode, resource: { id: resource.id, type: typeof resource.type === "string" ? resource.type : "", attributes: resource.attributes } };
}

export interface CheckoutRequest {
  amountMinor: number;
  currency: string;
  name: string;
  description: string;
  referenceNumber: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  id: string;
  checkoutUrl: string;
}

/** Creates a hosted checkout session. Only the checkout id and URL are trusted from the response. */
export async function createCheckoutSession(req: CheckoutRequest, deps: { fetch?: FetchLike } = {}): Promise<CheckoutSession> {
  const status = paymongoStatus();
  if (!status.configured) throw new AppError("integration_unavailable", "Payments are not connected yet.");
  const key = env().PAYMONGO_SECRET_KEY as string;
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${apiBase()}/v2/checkout_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
      body: JSON.stringify({
        data: {
          attributes: {
            line_items: [{ name: req.name.slice(0, 120), amount: req.amountMinor, currency: req.currency, quantity: 1 }],
            payment_method_types: status.paymentMethods,
            success_url: req.successUrl,
            cancel_url: req.cancelUrl,
            reference_number: req.referenceNumber,
            description: req.description.slice(0, 200),
            send_email_receipt: false,
            metadata: { reference: req.referenceNumber },
          },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new AppError("integration_unavailable", "The payment provider could not be reached. Nothing was charged. Please try again.");
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) throw new AppError("upstream_error", "The payment provider declined to start this checkout. Nothing was charged.");
  const data = isRecord(json) && isRecord(json.data) ? json.data : null;
  const attrs = data && isRecord(data.attributes) ? data.attributes : null;
  const id = data && typeof data.id === "string" ? data.id : null;
  const url = attrs && typeof attrs.checkout_url === "string" ? attrs.checkout_url : null;
  if (!id || !url) throw new AppError("upstream_error", "The payment provider returned an unexpected response. Nothing was charged.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError("upstream_error", "The payment provider returned an invalid checkout link.");
  }
  const simulated = env().PAYMONGO_API_BASE ? new URL(env().PAYMONGO_API_BASE as string).origin : null;
  if (!(simulated && parsed.origin === simulated) && (parsed.protocol !== "https:" || !CHECKOUT_HOST.test(parsed.hostname))) throw new AppError("upstream_error", "The checkout link did not point to PayMongo, so it was not used.");
  return { id, checkoutUrl: parsed.toString() };
}
