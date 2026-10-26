import { handleDeauthorize } from "@/server/social/webhooks";
import { readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** Meta's deauthorize callback for the social app. No session: the request is trusted only if its signed_request verifies with the app secret. */
export async function POST(req: Request) {
  const body = await readBoundedText(req, 8_000);
  if (body === null) return Response.json({ error: "too_large" }, { status: 413, headers: HEADERS });
  const r = await handleDeauthorize(body);
  return Response.json(r.body, { status: r.status, headers: HEADERS });
}
