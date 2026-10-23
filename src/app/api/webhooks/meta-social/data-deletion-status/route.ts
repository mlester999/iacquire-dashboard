import { deletionStatus } from "@/server/social/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The address Meta shows a person who asked for their data to be deleted. It reveals only whether a request with that code was processed. */
export async function GET(req: Request) {
  const r = await deletionStatus(new URL(req.url).searchParams.get("code"));
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
