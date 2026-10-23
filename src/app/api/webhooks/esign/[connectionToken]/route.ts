import { handleEsignWebhook, MAX_BODY_BYTES } from "@/server/esign/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" };

/** The body as bytes, read as it arrives and abandoned the moment it passes the limit (a request that lies about, or leaves out, its length cannot make us hold it all). */
async function readLimited(req: Request): Promise<Buffer | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * A client's signing service reports what happened to a document. No session: the delivery is trusted only by its signature, checked over the exact bytes with the key of the
 * connection this secret address belongs to (see src/server/esign/webhook.ts). Any 2xx acknowledges the delivery; a 5xx makes the service send it again, which is safe
 * because applying a report is idempotent.
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectionToken: string }> }) {
  const { connectionToken } = await params;
  const rawBody = await readLimited(req);
  if (rawBody === null) return Response.json({ received: false, reason: "too_large" }, { status: 413, headers: HEADERS });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  try {
    const r = await handleEsignWebhook({ token: connectionToken, rawBody, headers: req.headers, query: new URL(req.url).searchParams, ip });
    return Response.json(r.body, { status: r.status, headers: r.status === 429 ? { ...HEADERS, "Retry-After": "60" } : HEADERS });
  } catch {
    // Nothing about the request, the workspace or the service is logged here.
    console.error("[iacquire] a signing webhook failed before it could be recorded");
    return Response.json({ received: false }, { status: 500, headers: HEADERS });
  }
}

/** Only POST deliveries exist. */
export async function GET() {
  return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...HEADERS, Allow: "POST" } });
}
