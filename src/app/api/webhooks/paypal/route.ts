import { NextResponse } from "next/server";
import { handleProviderWebhook } from "@/server/billing/payments";
import { paypalAdapter } from "@/server/billing/providers/paypal";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 256_000;
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const PAYPAL_HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"] as const;

/**
 * PayPal webhook endpoint for iAcquire's own purchases and plan payments. It has no session: a delivery is trusted only after PayPal itself confirms its signature (the check asks
 * PayPal, with the app's credentials and webhook id, so every delivery that reaches it costs two calls to PayPal; the per-address limit is applied first). The body is read as text
 * before anything is parsed, because parsing first would change the bytes that were signed. Any 2xx acknowledges a delivery; a 5xx makes PayPal send it again, which is safe because
 * applying an event is idempotent (the receipt ledger and the checkout's own status).
 */
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const limited = await consumeRateLimit(RATE_LIMITS.paypalWebhookByIp, ip);
  if (!limited.allowed) return NextResponse.json({ received: false }, { status: 429, headers: { ...HEADERS, "Retry-After": "60" } });
  const rawBody = await readBoundedText(req, MAX_BODY_BYTES);
  if (rawBody === null) return NextResponse.json({ received: false }, { status: 413, headers: HEADERS });
  const headers: Record<string, string | null> = {};
  for (const name of PAYPAL_HEADERS) headers[name] = req.headers.get(name);
  try {
    const result = await handleProviderWebhook(paypalAdapter, { rawBody, headers });
    return NextResponse.json({ received: result.httpStatus < 300, outcome: result.outcome }, { status: result.httpStatus, headers: HEADERS });
  } catch (err) {
    console.error("[iacquire] paypal webhook processing failed", { type: err instanceof Error ? err.name : "unknown" });
    return NextResponse.json({ received: false }, { status: 500, headers: HEADERS });
  }
}

/** Only POST deliveries exist. */
export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { ...HEADERS, Allow: "POST" } });
}
