import { after, NextResponse } from "next/server";
import { handleGhlWebhook } from "@/server/messaging/ingest";
import { respondToConversation } from "@/server/messaging/responder";
import { dispatchDue } from "@/server/messaging/send";
import { readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 256_000;

/**
 * GoHighLevel webhook endpoint (InboundMessage and OutboundMessage). It has no session: the RSA signature over the raw body is
 * the authentication, and the workspace comes only from our own location mapping. Preparing the AI reply happens after the
 * response, so GoHighLevel is acknowledged immediately; a recovery sweep answers anything a restart interrupts.
 */
export async function POST(req: Request) {
  const rawBody = await readBoundedText(req, MAX_BODY_BYTES);
  if (rawBody === null) return NextResponse.json({ received: false }, { status: 413 });
  try {
    const result = await handleGhlWebhook({ rawBody, signature: req.headers.get("x-wh-signature") });
    if (result.aiShouldRespond && result.conversationId) {
      const { conversationId } = result;
      const orgId = result.orgId;
      after(async () => {
        try {
          if (orgId) {
            const reply = await respondToConversation(orgId, conversationId);
            if (reply.status === "queued") await dispatchDue({ limit: 5 });
          }
        } catch {
          console.error("[iacquire] reply preparation failed after webhook");
        }
      });
    }
    return NextResponse.json({ received: result.httpStatus < 300, outcome: result.outcome }, { status: result.httpStatus, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[iacquire] ghl webhook processing failed", { type: err instanceof Error ? err.name : "unknown" });
    return NextResponse.json({ received: false }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
