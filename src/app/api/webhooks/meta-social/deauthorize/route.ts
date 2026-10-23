import { handleDeauthorize } from "@/server/social/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** Meta's deauthorize callback for the social app. No session: the request is trusted only if its signed_request verifies with the app secret. */
export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > 8_000) return Response.json({ error: "too_large" }, { status: 413, headers: HEADERS });
  const r = await handleDeauthorize(await req.text());
  return Response.json(r.body, { status: r.status, headers: HEADERS });
}
