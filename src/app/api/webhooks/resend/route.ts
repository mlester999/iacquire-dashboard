import { after } from "next/server";
import { handleResendWebhook } from "@/server/messaging/transports/resend";
import { respondToConversation } from "@/server/messaging/responder";
import { dispatchDue } from "@/server/messaging/send";
import { readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 256_000;
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

/**
 * Resend webhooks (email.sent, email.delivered, email.delivery_delayed, email.bounced, email.complained, email.failed, email.suppressed
 * and email.received). There is no session: the Svix signature over the raw body, made with RESEND_WEBHOOK_SECRET, is the authentication.
 * Delivery updates are matched to our message by the "mid" tag the transport sets; a received email reaches the workspace whose reply
 * address it was sent to. Resend is answered at once; preparing an AI reply happens after the response.
 */
export async function POST(req: Request) {
  const rawBody = await readBoundedText(req, MAX_BODY_BYTES);
  if (rawBody === null) return new Response(JSON.stringify({ received: false }), { status: 413, headers: JSON_HEADERS });
  try {
    const result = await handleResendWebhook(rawBody, req.headers);
    const replies = result.replies ?? [];
    if (replies.length) {
      after(async () => {
        let queued = false;
        for (const { orgId, conversationId } of replies) {
          try {
            const reply = await respondToConversation(orgId, conversationId);
            if (reply.status === "queued") queued = true;
          } catch {
            console.error("[iacquire] reply preparation failed after resend webhook");
          }
        }
        if (queued) await dispatchDue({ limit: 5 }).catch(() => console.error("[iacquire] dispatch failed after resend webhook"));
      });
    }
    // Only the outcome word goes back; details stay in webhook_receipts.
    return new Response(JSON.stringify({ received: result.status < 300, outcome: result.outcome }), { status: result.status, headers: JSON_HEADERS });
  } catch (err) {
    // A 5xx lets Resend retry on its schedule; nothing about the request or the workspace is logged.
    console.error("[iacquire] resend webhook processing failed", { type: err instanceof Error ? err.name : "unknown" });
    return new Response(JSON.stringify({ received: false }), { status: 500, headers: JSON_HEADERS });
  }
}

export async function GET() {
  return new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Allow: "POST" } });
}
