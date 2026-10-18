import { handleIcs, requestMetaFrom } from "@/server/calendars/public-booking";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The customer's appointment as an .ics file, authorized by its manage token (`?token=`). */
export async function GET(req: Request) {
  const res = await handleIcs(requestMetaFrom(req), new URL(req.url).searchParams.get("token"));
  return new Response(res.body, { status: res.status, headers: res.headers });
}
