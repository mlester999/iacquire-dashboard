import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { claimSchedulerTick, finishSchedulerTick, runScheduledJobs } from "@/server/ops/tick";
import { sanitizeErrorText } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

function authorized(req: Request) {
  const secret = env().CRON_SECRET;
  if (!secret) return false;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Scheduled worker entry point. A scheduler (for example Vercel Cron, Supabase cron or an external cron) calls it with
 * `Authorization: Bearer $CRON_SECRET`. Two independent switches are required: the secret and `SCHEDULER_ENABLED=true`, so shipping
 * scheduler configuration cannot start outbound work by itself. Overlapping invocations are serialized with a short database lease;
 * each job is idempotent, and a failure in one never stops the others.
 */
export async function POST(req: Request) {
  const config = env();
  if (!config.CRON_SECRET) return NextResponse.json({ error: "Worker endpoint is not configured." }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!config.SCHEDULER_ENABLED) {
    return NextResponse.json(
      { error: "Scheduler is disabled. Set SCHEDULER_ENABLED=true only after the scheduled work has been reviewed and approved." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // A slow tick (up to 120 s) can overlap the next cron invocation. Return 200 so the scheduler does not treat it as a failure.
  if (!(await claimSchedulerTick())) {
    return NextResponse.json({ ok: true, skipped: "another scheduler tick is active" }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const ran = await runScheduledJobs();
    await finishSchedulerTick(true);
    return NextResponse.json({ ok: true, ran }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await finishSchedulerTick(false, sanitizeErrorText(error));
    return NextResponse.json({ error: "Scheduled work failed. See the worker heartbeat for details." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

/**
 * The same authorized handler for hosts whose scheduler calls with GET (Vercel Cron does). The bearer secret is still required;
 * nothing is accepted from a cookie or query string.
 */
export async function GET(req: Request) {
  return POST(req);
}
