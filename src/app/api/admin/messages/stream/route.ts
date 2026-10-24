import { NextResponse } from "next/server";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { inboxStatus } from "@/server/staff-messages/inbox";
import { accessRefusal } from "@/server/staff-messages/snapshot";
import { reserveStaffStream, staffInboxStream } from "@/server/staff-messages/stream";
import { errorResponse, NO_STORE } from "@/server/staff-messages/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Tells an open Messages page that something changed for the signed-in person. The frames carry a revision number and nothing else. A person without access gets a refusal
 * here, not a stream that opens and closes; one person has at most four streams open; each lives a minute at most and re-checks the person's standing every few seconds.
 */
export async function GET(req: Request) {
  try {
    const user = await requireAgencyOrThrow();
    const who = { id: user.id, platformRole: user.platformRole };
    const initial = await inboxStatus(who);
    if (initial.access === "changed") throw accessRefusal(initial.reason);
    const release = reserveStaffStream(user.id);
    if (!release) return NextResponse.json({ error: "Too many open connections.", code: "rate_limited" }, { status: 429, headers: NO_STORE });
    return new Response(staffInboxStream({ user: who, initial, signal: req.signal, release }), {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
