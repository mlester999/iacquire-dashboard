import { handleVoiceWebhook } from "@/server/integrations/voice/handler";
import { readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// call_ended and call_analyzed carry the whole call object (transcript included), so the limit is generous; only a few fields are kept.
const MAX_BODY_BYTES = 2_000_000;
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

/**
 * Retell AI webhooks (call_started, call_ended, call_analyzed). Set this as the agent's (or the account's) webhook URL. There is no
 * session: the workspace is found from the agent id and X-Retell-Signature is checked with that workspace's Retell API key (the one with
 * the webhook badge). Retell waits 10 seconds for a 2xx and retries up to 3 times, so the work here is short and idempotent.
 */
export async function POST(req: Request) {
  const rawBody = await readBoundedText(req, MAX_BODY_BYTES);
  if (rawBody === null) return new Response(JSON.stringify({ received: false }), { status: 413, headers: JSON_HEADERS });
  try {
    const result = await handleVoiceWebhook("retell", rawBody, req.headers);
    const headers = result.retryAfterSeconds ? { ...JSON_HEADERS, "Retry-After": String(result.retryAfterSeconds) } : JSON_HEADERS;
    return new Response(JSON.stringify({ received: result.status < 300, outcome: result.outcome }), { status: result.status, headers });
  } catch (err) {
    console.error("[iacquire] retell webhook processing failed", { type: err instanceof Error ? err.name : "unknown" });
    return new Response(JSON.stringify({ received: false }), { status: 500, headers: JSON_HEADERS });
  }
}

export async function GET() {
  return new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Allow: "POST" } });
}
