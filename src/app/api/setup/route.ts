import { NextResponse } from "next/server";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { getClientSetupSnapshot } from "@/server/setup/snapshots";
import { getSetupRevision } from "@/server/setup/core";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The client's setup state. The workspace comes from the signed-in session, never from the request,
 * and the data is read under row-level security. `?since=<revision>` answers cheaply when nothing changed.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireOrgContextOrThrow("setup.view");
    const since = Number(new URL(req.url).searchParams.get("since"));
    if (new URL(req.url).searchParams.get("scope") === ctx.org.orgId && Number.isInteger(since) && since > 0) {
      const current = await getSetupRevision(ctx.org.orgId);
      if (current !== null && current === since) return NextResponse.json({ unchanged: true, revision: current }, { headers: { "Cache-Control": "no-store" } });
    }
    const snapshot = await getClientSetupSnapshot(ctx);
    if (!snapshot) return NextResponse.json({ error: "Setup isn't available for this workspace." }, { status: 404 });
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
