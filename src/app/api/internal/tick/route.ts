import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { withSystem } from "@/server/db";
import { expireStaleReservations } from "@/server/billing/ledger";
import { dispatchDue } from "@/server/messaging/send";
import { processDueFollowUps } from "@/server/messaging/followups";
import { advanceEscalations } from "@/server/messaging/handoff";
import { respondToPending } from "@/server/messaging/responder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
 * `Authorization: Bearer $CRON_SECRET`. Every job is idempotent and safe to run twice, so overlapping ticks cannot double-act.
 */
export async function POST(req: Request) {
  if (!env().CRON_SECRET) return NextResponse.json({ error: "Worker endpoint is not configured." }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const ran: Record<string, number | string> = {};
  // Each job is independent and idempotent: one failing never stops the others, and running twice is harmless.
  const job = async (name: string, fn: () => Promise<number>) => {
    try {
      ran[name] = await fn();
    } catch (err) {
      console.error(`[iacquire] worker tick: ${name} failed`, { type: err instanceof Error ? err.name : "unknown" });
      ran[name] = "failed";
    }
  };
  await job("expiredReservations", () => withSystem((db) => expireStaleReservations(db)));
  await job("escalationsOpened", () => advanceEscalations());
  await job("followUpsPrepared", async () => (await processDueFollowUps()).processed);
  await job("repliesChecked", async () => (await respondToPending()).checked);
  await job("messagesDispatched", async () => (await dispatchDue()).attempted);
  return NextResponse.json({ ok: true, ran }, { headers: { "Cache-Control": "no-store" } });
}
