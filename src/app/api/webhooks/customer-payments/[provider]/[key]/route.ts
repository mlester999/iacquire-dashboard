import { handleCustomerPaymentWebhook, MAX_BODY_BYTES } from "@/server/customer-payments/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** The body as text, read as it arrives and abandoned the moment it passes the limit (a request that lies about, or leaves out, its length cannot make us hold it all). */
async function readLimited(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/**
 * A business's payment provider delivers an event for one of its connections. No session: the delivery is trusted only by its signature, over the raw body, checked
 * with that connection's own secret. The body is read as text before anything is parsed, because parsing first would change the bytes that were signed. Any 2xx
 * acknowledges the delivery; a 5xx makes the provider send it again, which is safe because applying an event is idempotent.
 */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string; key: string }> }) {
  const { provider, key } = await params;
  const rawBody = await readLimited(req);
  if (rawBody === null) return Response.json({ received: false }, { status: 413, headers: HEADERS });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  try {
    const r = await handleCustomerPaymentWebhook({ provider, key, rawBody, headers: req.headers, ip });
    return Response.json(r.body, { status: r.status, headers: HEADERS });
  } catch {
    // Nothing about the request, the workspace or the provider is logged here.
    console.error("[iacquire] customer payment webhook failed before it could be recorded");
    return Response.json({ received: false }, { status: 500, headers: HEADERS });
  }
}

/** Only POST deliveries exist. */
export async function GET() {
  return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...HEADERS, Allow: "POST" } });
}
