import { NextResponse } from "next/server";
import { requireAgencyOrgAccessOrThrow } from "@/server/tenancy/context";
import { getAgencySetupSnapshot } from "@/server/setup/snapshots";
import { getSetupRevision } from "@/server/setup/core";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The agency's full setup state for one client. Staff only see clients they are assigned to. */
export async function GET(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const { orgId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(orgId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const user = await requireAgencyOrgAccessOrThrow(orgId);
    const since = Number(new URL(req.url).searchParams.get("since"));
    if (new URL(req.url).searchParams.get("scope") === orgId && Number.isInteger(since) && since > 0) {
      const current = await getSetupRevision(orgId);
      if (current !== null && current === since) return NextResponse.json({ unchanged: true, revision: current }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(await getAgencySetupSnapshot(user, orgId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
