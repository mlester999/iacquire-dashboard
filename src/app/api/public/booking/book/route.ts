import { handleBook, requestMetaFrom } from "@/server/calendars/public-booking";
import { readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 20_000;
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

/** Books from a public booking page. JSON in, JSON out; the decisions live in handleBook. */
export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ ok: false, code: "invalid", error: "That booking is too large to send." }, { status: 413, headers });
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return Response.json({ ok: false, code: "invalid", error: "Send the booking as JSON." }, { status: 415, headers });
  let body: unknown;
  try {
    const text = await readBoundedText(req, MAX_BODY);
    if (text === null) return Response.json({ ok: false, code: "invalid", error: "That booking is too large to send." }, { status: 413, headers });
    body = JSON.parse(text);
  } catch {
    return Response.json({ ok: false, code: "invalid", error: "That booking couldn't be read. Reload the page and try again." }, { status: 400, headers });
  }
  const res = await handleBook(requestMetaFrom(req), body);
  return Response.json(res.body, { status: res.status, headers: res.headers });
}
