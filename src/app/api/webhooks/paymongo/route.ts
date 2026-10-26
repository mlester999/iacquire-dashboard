import { NextResponse } from "next/server";
import { handlePaymongoWebhook } from "@/server/billing/payments";
import { readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 256_000;

/**
 * PayMongo webhook endpoint. It has no session: authenticity comes from the signature over the raw body.
 * The body is read as text before any parsing, because parsing first would change the bytes that were signed.
 * Any 2xx acknowledges a delivery; a 5xx makes PayMongo retry, which is safe because processing is idempotent.
 */
export async function POST(req: Request) {
  const rawBody = await readBoundedText(req, MAX_BODY_BYTES);
  if (rawBody === null) return NextResponse.json({ received: false }, { status: 413 });
  try {
    const result = await handlePaymongoWebhook({ rawBody, signatureHeader: req.headers.get("paymongo-signature") });
    return NextResponse.json({ received: result.httpStatus < 300, outcome: result.outcome }, { status: result.httpStatus, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[iacquire] paymongo webhook processing failed", { type: err instanceof Error ? err.name : "unknown" });
    return NextResponse.json({ received: false }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
