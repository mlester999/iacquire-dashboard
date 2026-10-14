import { NextResponse } from "next/server";
import { pingDb } from "@/server/db";

export const dynamic = "force-dynamic";

/** Public liveness probe for load balancers. Reveals no configuration. */
export async function GET() {
  const db = await pingDb();
  return NextResponse.json({ status: db.ok ? "ok" : "degraded", database: db.ok ? "ok" : "unavailable" }, { status: db.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
