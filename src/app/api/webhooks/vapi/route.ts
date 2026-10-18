import { handleVoiceWebhook } from "@/server/integrations/voice/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// An end-of-call report carries the whole transcript and message list, so the limit is generous; only a few fields are kept.
const MAX_BODY_BYTES = 2_000_000;
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

/**
 * Vapi server messages ("Server URL"). Point a saved assistant's or phone number's server URL here, with a Vapi credential (Bearer token,
 * X-Vapi-Secret or HMAC) and serverMessages ["status-update", "end-of-call-report"]. There is no session: the workspace is found from
 * the assistant / phone-number id and the request is authenticated with that workspace's own secret (src/server/integrations/voice).
 * Only the outcome word goes back.
 */
export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response(JSON.stringify({ received: false }), { status: 413, headers: JSON_HEADERS });
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return new Response(JSON.stringify({ received: false }), { status: 413, headers: JSON_HEADERS });
  try {
    const result = await handleVoiceWebhook("vapi", rawBody, req.headers);
    const headers = result.retryAfterSeconds ? { ...JSON_HEADERS, "Retry-After": String(result.retryAfterSeconds) } : JSON_HEADERS;
    return new Response(JSON.stringify({ received: result.status < 300, outcome: result.outcome }), { status: result.status, headers });
  } catch (err) {
    // A 5xx lets Vapi retry; nothing about the call or the workspace is logged.
    console.error("[iacquire] vapi webhook processing failed", { type: err instanceof Error ? err.name : "unknown" });
    return new Response(JSON.stringify({ received: false }), { status: 500, headers: JSON_HEADERS });
  }
}

export async function GET() {
  return new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Allow: "POST" } });
}
