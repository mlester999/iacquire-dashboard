import "server-only";
import { sameSiteRequest } from "@/server/security/same-site";
import { looksLikeInvoiceToken } from "@/lib/invoices/token";
import { looksLikeReference, REFERENCE_HEADER, TOKEN_HEADER, type PayFailure } from "@/lib/invoices/public-http";
import { completeApprovedCheckout, paymentStatusByReference, paymentStatusByToken, startPublicPayment, type PublicContext } from "@/server/invoices/public";

// The thin HTTP layer of the customer's invoice page: it reads the request, calls the service in public.ts and answers. It is kept apart from the route files so it can be
// tested with plain Request objects. Nothing here decides anything. Every answer is never cached, never indexed and never passes an address on, and the link travels in a
// header: an address ends up in logs and history, and the link is a credential.

export const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } as const;
const MAX_BODY_BYTES = 2048;

const clientIp = (req: Request): string | null => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;

const json = (status: number, body: unknown, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

/** A request made from another site is refused before anything is read. A same-site request from this no-referrer page can arrive with Origin: null; see security/same-site.ts. */
export const sameSite = sameSiteRequest;

const contextOf = (req: Request, now?: Date): PublicContext => ({ ip: clientIp(req), now });

const FAILURE_STATUS: Record<PayFailure, number> = { invalid: 404, rate_limited: 429, paid: 409, unavailable: 503, disabled: 503, try_again: 503 };
/** The same answer for the platform's switch and for a workspace that takes no customers: neither says which, and a client may try again later. */
const unavailableAnswer = () => json(503, { error: "unavailable" }, { "Retry-After": "300" });

/** POST: the customer pressed "Pay online". The link is in a header; nothing else is read, so there is no amount, invoice or workspace to tamper with. */
export async function handlePay(req: Request, deps: Parameters<typeof startPublicPayment>[2] = {}, now?: Date): Promise<Response> {
  if (!sameSite(req)) return json(403, { error: "invalid", message: "Not allowed." });
  const token = req.headers.get(TOKEN_HEADER);
  if (!looksLikeInvoiceToken(token)) return json(404, { error: "invalid", message: "This link is not valid. Open the link from the message you received." });
  const r = await startPublicPayment(token, contextOf(req, now), deps);
  if (r.ok) return json(200, { url: r.url });
  return json(FAILURE_STATUS[r.reason], { error: r.reason, message: r.message }, r.reason === "rate_limited" || r.reason === "disabled" || r.retryAfterSeconds ? { "Retry-After": String(r.retryAfterSeconds ?? 300) } : {});
}

/**
 * GET: where a payment stands. Asked with the invoice's link (header), or with the reference of a checkout the customer started (header). The answer is recomputed from the
 * database every time; "paid" and "received" never come from anywhere else.
 */
export async function handleStatus(req: Request, now?: Date): Promise<Response> {
  const token = req.headers.get(TOKEN_HEADER);
  const reference = req.headers.get(REFERENCE_HEADER);
  const ctx = contextOf(req, now);
  if (looksLikeReference(reference)) {
    const r = await paymentStatusByReference(reference, ctx);
    if (r.state === "disabled") return unavailableAnswer();
    if (r.state === "rate_limited") return json(429, { error: "rate_limited" }, { "Retry-After": "60" });
    if (r.state === "invalid") return json(404, { error: "invalid" });
    const d = r.view.description;
    return json(200, { state: d.state, headline: d.headline, detail: d.detail, polling: d.polling, tone: d.tone });
  }
  if (looksLikeInvoiceToken(token)) {
    const r = await paymentStatusByToken(token, ctx);
    if (r.state === "disabled" || r.state === "unavailable") return unavailableAnswer();
    if (r.state === "rate_limited") return json(429, { error: "rate_limited" }, { "Retry-After": "60" });
    if (r.state === "invalid") return json(404, { error: "invalid" });
    return json(200, { paymentStatus: r.status.paymentStatus, balanceMinor: r.status.balanceMinor, currency: r.status.currency, hasPendingPayment: r.status.hasPendingPayment, banner: r.status.banner.kind });
  }
  return json(404, { error: "invalid" });
}

async function smallJson(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** POST: the customer came back from a provider that needs the approved payment taken (PayPal). The checkout is the one the provider names, checked against ours. */
export async function handleCapture(req: Request, deps: Parameters<typeof completeApprovedCheckout>[3] = {}, now?: Date): Promise<Response> {
  if (!sameSite(req)) return json(403, { ok: false });
  const body = await smallJson(req);
  const reference = body?.reference;
  const orderId = body?.checkoutId;
  if (!looksLikeReference(reference) || typeof orderId !== "string" || !/^[A-Za-z0-9_-]{4,120}$/.test(orderId)) return json(400, { ok: false });
  const r = await completeApprovedCheckout(reference, orderId, contextOf(req, now), deps);
  if (r.ok) return json(200, { ok: true });
  return json(r.reason === "rate_limited" ? 429 : r.reason === "invalid" ? 404 : 503, { ok: false, reason: r.reason }, r.reason === "rate_limited" ? { "Retry-After": "300" } : {});
}

/** Only the verbs each endpoint serves exist. */
export const methodNotAllowed = (allow: string) => json(405, { error: "method_not_allowed" }, { Allow: allow });
