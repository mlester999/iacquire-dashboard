import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { runScheduledJobs } from "@/server/ops/tick";

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
 * Scheduled worker entry point. A scheduler (for example Supabase cron, a hosting cron or an n8n schedule) calls it with
 * `Authorization: Bearer $CRON_SECRET`. The jobs live in src/server/ops/tick.ts; each records a heartbeat, and a failure in one
 * never stops the others.
 */
export async function POST(req: Request) {
  if (!env().CRON_SECRET) return NextResponse.json({ error: "Worker endpoint is not configured." }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const ran = await runScheduledJobs();
  return NextResponse.json({ ok: true, ran }, { headers: { "Cache-Control": "no-store" } });
}
