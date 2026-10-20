import { NextResponse } from "next/server";
import { requireUserOrThrow } from "@/server/auth/session";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { getRequestDetail } from "@/server/support/service";
import { getAgencyRequest } from "@/server/support/agency";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/**
 * The current state of one request, for the page to refresh itself without a reload. The caller's own session decides which view they
 * get: the team's view needs an agency account that can reach this client, and the client's view needs a workspace member who can see
 * the request. A forged id, or asking for the other view, returns "not found" and nothing else.
 */
export async function GET(req: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  try {
    const user = await requireUserOrThrow();
    const { ticketId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return NextResponse.json({ error: "Request not found." }, { status: 404 });
    const wantsAgency = new URL(req.url).searchParams.get("as") === "agency";
    const detail = wantsAgency && user.platformRole !== "none" ? await getAgencyRequest(user, ticketId) : await getRequestDetail(await requireOrgContextOrThrow("support.use"), ticketId);
    if (!detail) return NextResponse.json({ error: "Request not found." }, { status: 404 });
    return NextResponse.json(detail, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  }
}
