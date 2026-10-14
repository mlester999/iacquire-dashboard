import { NextResponse } from "next/server";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { fillDays, getAnalytics, parseRange } from "@/server/queries/analytics";
import { recordAudit } from "@/server/audit";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ctx = await requireOrgContextOrThrow("analytics.export");
    const sp = new URL(req.url).searchParams;
    const range = parseRange({ range: sp.get("range") ?? undefined, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined });
    const a = await getAnalytics(ctx, range);
    const leads = new Map(fillDays(a.leads.byDay, range, ctx.org.timezone).map((d) => [d.day, d.n]));
    const msgs = fillDays(a.messagesByDay, range, ctx.org.timezone);
    const lines = [
      `# iAcquire analytics export · ${ctx.org.name} · ${range.from.toISOString()} to ${range.to.toISOString()} · days in ${ctx.org.timezone}`,
      "date,ai_messages,leads_researched",
      ...msgs.map((d) => `${d.day},${d.n},${leads.get(d.day) ?? 0}`),
      "",
      "metric,value",
      `leads_total,${a.leads.totals.total}`,
      `leads_approved,${a.leads.totals.approved}`,
      `leads_rejected,${a.leads.totals.rejected}`,
      `appointments_booked,${a.appointments ? a.appointments.booked : "unavailable"}`,
      `appointments_showed,${a.appointments ? a.appointments.showed : "unavailable"}`,
      `opportunities_won,${a.sales ? a.sales.won : "unavailable"}`,
      `opportunities_lost,${a.sales ? a.sales.lost : "unavailable"}`,
      `agent_tool_steps,${a.workforce.toolSteps}`,
      `approvals_executed,${a.execution.succeeded}`,
      `approvals_held,${a.execution.blocked}`,
      `approvals_failed,${a.execution.failed}`,
      `tokens,${a.usage.tokens}`,
    ];
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "analytics.exported", result: "success", metadata: { days: range.days } });
    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="analytics-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
