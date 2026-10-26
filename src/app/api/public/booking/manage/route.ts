import { handleManage, requestMetaFrom } from "@/server/calendars/public-booking";
import { readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 4_000;
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

/** Reschedules or cancels a booking from the customer's manage link: `{ action: "reschedule" | "cancel", token, … }`. */
export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ ok: false, code: "invalid", error: "That request is too large." }, { status: 413, headers });
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return Response.json({ ok: false, code: "invalid", error: "Send the change as JSON." }, { status: 415, headers });
  let body: unknown;
  try {
    const text = await readBoundedText(req, MAX_BODY);
    if (text === null) return Response.json({ ok: false, code: "invalid", error: "That request is too large." }, { status: 413, headers });
    body = JSON.parse(text);
  } catch {
    return Response.json({ ok: false, code: "invalid", error: "That request couldn't be read. Reload the page and try again." }, { status: 400, headers });
  }
  const res = await handleManage(requestMetaFrom(req), body);
  return Response.json(res.body, { status: res.status, headers: res.headers });
}
