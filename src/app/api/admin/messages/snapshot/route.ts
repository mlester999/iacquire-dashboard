import { NextResponse } from "next/server";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { buildSnapshot } from "@/server/staff-messages/snapshot";
import { errorResponse, NO_STORE, snapshotBrake } from "@/server/staff-messages/http";
import { parseSnapshotQuery } from "@/lib/staff-messages/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * What an open Messages page asks for to stay current: the person's conversations, the one they have open and its newest messages, or just the unread total for the
 * navigation badge. `?since=<revision>` makes an unchanged answer a few bytes. Only a signed-in agency account gets anything, and the person's standing and membership are read
 * from the database for this request: a conversation they are not in is "not there", in the same words as one that never existed.
 */
export async function GET(req: Request) {
  try {
    const user = await requireAgencyOrThrow();
    const wait = snapshotBrake(user.id);
    if (wait !== null) return NextResponse.json({ error: "Too many requests. Try again in a moment.", code: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(wait) } });
    const parsed = parseSnapshotQuery(new URL(req.url).searchParams);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message, code: "invalid_input" }, { status: 400, headers: NO_STORE });
    return NextResponse.json(await buildSnapshot({ id: user.id, platformRole: user.platformRole }, parsed.q), { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
