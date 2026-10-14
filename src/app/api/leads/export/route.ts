import { NextResponse } from "next/server";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { leadsToCsv, listLeads } from "@/server/leads/service";
import { recordAudit } from "@/server/audit";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ctx = await requireOrgContextOrThrow("leads.export");
    const status = new URL(req.url).searchParams.get("status");
    const filter = status === "pending" || status === "approved" || status === "rejected" ? status : "all";
    const rows = await listLeads(ctx, filter);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "leads.exported", result: "success", metadata: { count: rows.length, filter } });
    return new NextResponse(leadsToCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
