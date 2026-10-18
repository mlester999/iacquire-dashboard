import { after } from "next/server";
import { handleMetaWebhook, handleMetaWebhookVerify } from "@/server/messaging/transports/meta-whatsapp";
import { syncWhatsappTemplates } from "@/server/messaging/whatsapp-templates";
import { respondToConversation } from "@/server/messaging/responder";
import { dispatchDue } from "@/server/messaging/send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Meta batches up to 1,000 updates in one request, so this cap is larger than the other webhooks' 256 KB. */
const MAX_BODY_BYTES = 1_000_000;
const TEXT = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/**
 * WhatsApp Business Cloud API webhooks for the iAcquire Meta app. Configure <APP_URL>/api/webhooks/meta-whatsapp as the app's callback URL,
 * with META_WEBHOOK_VERIFY_TOKEN as its verify token, and subscribe to the "messages" field (and "message_template_status_update", so a
 * paused or rejected template stops being offered at once). There is no session: the subscription handshake checks the verify token, and
 * every event POST must carry a valid X-Hub-Signature-256 made with META_APP_SECRET.
 */
export async function GET(req: Request) {
  const result = handleMetaWebhookVerify(new URL(req.url).searchParams);
  return new Response(result.body, { status: result.status, headers: TEXT });
}

/**
 * Events are recorded before the answer (Meta does not keep events it was told were received), and Meta is answered as soon as they are.
 * Preparing AI replies and re-syncing changed templates happen after the response.
 */
export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413, headers: TEXT });
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413, headers: TEXT });
  try {
    const result = await handleMetaWebhook(rawBody, req.headers);
    if (result.respond.length || result.templateSync.length) {
      const { respond, templateSync } = result;
      after(async () => {
        let queued = false;
        for (const { orgId, conversationId } of respond) {
          try {
            const reply = await respondToConversation(orgId, conversationId);
            if (reply.status === "queued") queued = true;
          } catch {
            console.error("[iacquire] reply preparation failed after whatsapp webhook");
          }
        }
        if (queued) {
          try {
            await dispatchDue({ limit: 5 });
          } catch {
            console.error("[iacquire] dispatch after whatsapp webhook failed");
          }
        }
        for (const orgId of templateSync) {
          try {
            await syncWhatsappTemplates(orgId);
          } catch {
            console.error("[iacquire] whatsapp template sync after webhook failed");
          }
        }
      });
    }
    return new Response(result.body, { status: result.status, headers: TEXT });
  } catch (err) {
    // A 5xx makes Meta retry; replay receipts skip whatever was already recorded. Nothing about the payload or tenant is logged.
    console.error("[iacquire] whatsapp webhook processing failed", { type: err instanceof Error ? err.name : "unknown" });
    return new Response("Error", { status: 500, headers: TEXT });
  }
}
