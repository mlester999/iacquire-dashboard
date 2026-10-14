import { NextResponse } from "next/server";
import { pingDb } from "@/server/db";
import { observeSchedulerFreshness } from "@/server/ops/scheduler";

export const dynamic = "force-dynamic";

let lastSchedulerCheck = 0;

/**
 * Public liveness probe for load balancers and uptime monitors. Reveals no configuration.
 * Side effect: at most once a minute it also checks that the scheduler is still running and, if it is not, records an incident.
 * It cannot be left to the scheduler itself, which cannot report its own death. The response never depends on that check, because a
 * stopped scheduler is not a reason for a load balancer to take the web server out of rotation.
 */
export async function GET() {
  const db = await pingDb();
  if (db.ok && Date.now() - lastSchedulerCheck > 60_000) {
    lastSchedulerCheck = Date.now();
    await observeSchedulerFreshness().catch(() => undefined);
  }
  return NextResponse.json({ status: db.ok ? "ok" : "degraded", database: db.ok ? "ok" : "unavailable" }, { status: db.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
