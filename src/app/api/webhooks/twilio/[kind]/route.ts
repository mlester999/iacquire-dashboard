import { after } from "next/server";
import { handleTwilioWebhook } from "@/server/messaging/transports/twilio";
import { respondToConversation } from "@/server/messaging/responder";
import { dispatchDue } from "@/server/messaging/send";
import { readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 256_000;
const TEXT = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

/**
 * Twilio SMS webhooks: /api/webhooks/twilio/inbound (a customer texted a connected number; configure it in Twilio as "A message comes in",
 * HTTP POST) and /api/webhooks/twilio/status (delivery updates; set per message as its StatusCallback). There is no session: X-Twilio-Signature,
 * checked with the tenant's own auth token over the URL rebuilt from TWILIO_WEBHOOK_BASE_URL (or APP_URL), is the authentication. Twilio is
 * answered at once (empty TwiML for incoming messages); preparing an AI reply happens after the response.
 */
export async function POST(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (kind !== "inbound" && kind !== "status") return new Response("Not found", { status: 404, headers: TEXT });
  const rawBody = await readBoundedText(req, MAX_BODY_BYTES);
  if (rawBody === null) return new Response("Payload too large", { status: 413, headers: TEXT });
  try {
    const result = await handleTwilioWebhook(kind, rawBody, req.headers, req.url);
    if (result.aiShouldRespond && result.conversationId && result.orgId) {
      const { conversationId, orgId } = result;
      after(async () => {
        try {
          const reply = await respondToConversation(orgId, conversationId);
          if (reply.status === "queued") await dispatchDue({ limit: 5 });
        } catch {
          console.error("[iacquire] reply preparation failed after twilio webhook");
        }
      });
    }
    return new Response(result.body, { status: result.status, headers: { "Content-Type": result.contentType, "Cache-Control": "no-store" } });
  } catch (err) {
    // A 5xx lets Twilio retry where its retry policy allows; nothing about the request or the tenant is logged.
    console.error("[iacquire] twilio webhook processing failed", { kind, type: err instanceof Error ? err.name : "unknown" });
    return new Response("Error", { status: 500, headers: TEXT });
  }
}

/** Only HTTP POST webhooks are supported (Twilio can be set to GET; that is not accepted here). */
export async function GET() {
  return new Response("Method not allowed", { status: 405, headers: { ...TEXT, Allow: "POST" } });
}
