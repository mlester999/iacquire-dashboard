import { NextResponse } from "next/server";
import { pingDb } from "@/server/db";
import { observeSchedulerFreshness, type SchedulerFreshness } from "@/server/ops/scheduler";

export const dynamic = "force-dynamic";

let lastSchedulerCheck = 0;
let schedulerState: SchedulerFreshness["state"] | "unknown" = "unknown";

/**
 * Public liveness probe for load balancers and uptime monitors. It reveals no configuration, credentials or client data.
 * Side effect: at most once a minute it also checks that the scheduler is still running and, if it is not, records an incident.
 * It cannot be left to the scheduler itself, which cannot report its own death. Liveness stays `ok` when only the scheduler is
 * stopped; the `scheduler` field lets uptime monitors alert on `never_ran`/`stale` without taking the web tier out of rotation.
 */
export async function GET() {
  const db = await pingDb();
  if (db.ok && Date.now() - lastSchedulerCheck > 60_000) {
    lastSchedulerCheck = Date.now();
    const freshness = await observeSchedulerFreshness().catch(() => null);
    if (freshness) schedulerState = freshness.state;
  }
  return NextResponse.json(
    { status: db.ok ? "ok" : "degraded", database: db.ok ? "ok" : "unavailable", scheduler: db.ok ? schedulerState : "unknown" },
    { status: db.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
