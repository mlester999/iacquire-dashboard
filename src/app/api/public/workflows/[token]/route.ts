import { hashIp } from "@/server/security/crypto";
import { INBOUND_MAX_BODY_BYTES, handleInboundWebhook } from "@/server/crm/workflows/inbound";
import { readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };

/**
 * A workflow's private inbound URL (trigger "Inbound webhook"). The signed token in the path is the only authorization; the workspace
 * and the workflow come from it on the server. POST a JSON object (32 KB at most); an Idempotency-Key header makes a retried call start
 * nothing new. See src/server/crm/workflows/inbound.ts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > INBOUND_MAX_BODY_BYTES) return Response.json({ status: "error", detail: "The body is too large (32 KB at most)." }, { status: 413, headers: HEADERS });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("json")) return Response.json({ status: "error", detail: "Send JSON (Content-Type: application/json)." }, { status: 415, headers: HEADERS });
  let body: unknown;
  try {
    const text = await readBoundedText(req, INBOUND_MAX_BODY_BYTES);
    if (text === null) return Response.json({ status: "error", detail: "The body is too large (32 KB at most)." }, { status: 413, headers: HEADERS });
    body = JSON.parse(text);
  } catch {
    return Response.json({ status: "error", detail: "The body isn't valid JSON." }, { status: 400, headers: HEADERS });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  try {
    const res = await handleInboundWebhook({ token, body, idempotencyKey: req.headers.get("idempotency-key"), ipHash: hashIp(ip) });
    return Response.json(res.body, { status: res.httpStatus, headers: HEADERS });
  } catch (err) {
    console.error("[iacquire] workflow inbound webhook failed", { type: err instanceof Error ? err.name : "unknown" });
    return Response.json({ status: "error", detail: "Something went wrong. Try again later." }, { status: 500, headers: HEADERS });
  }
}
