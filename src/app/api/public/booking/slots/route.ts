import { handleSlots, requestMetaFrom } from "@/server/calendars/public-booking";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Open times for a public booking page (by slugs), or for moving a booking (by its manage token). At most 14 days per request. */
export async function GET(req: Request) {
  const res = await handleSlots(requestMetaFrom(req), new URL(req.url).searchParams);
  return Response.json(res.body, { status: res.status, headers: res.headers });
}
