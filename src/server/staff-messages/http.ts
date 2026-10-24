import "server-only";
import { NextResponse } from "next/server";
import { toPublicError } from "@/server/errors";
import type { AccessError } from "@/lib/staff-messages/snapshot";

// The few things the four Messages routes share: how a refusal is written, and a small per-process brake on the snapshot endpoint.

export const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** A refusal as JSON: the words that are safe to show, the code, and (for a change in the person's standing) the reason the page gives for stopping. */
export function errorResponse(error: unknown): NextResponse {
  const e = toPublicError(error);
  const body: AccessError = { error: e.message, code: e.code };
  if (e.code === "forbidden" || e.code === "not_enabled") body.reason = e.code;
  const headers: Record<string, string> = { ...NO_STORE };
  if (e.code === "rate_limited" && e.retryAfterSeconds) headers["Retry-After"] = String(e.retryAfterSeconds);
  return NextResponse.json(body, { status: e.status, headers });
}

// A page asks for a snapshot every 15 to 20 seconds, once more when a stream says something changed, and when the tab is focused again. Far more than that is a runaway loop
// in a page, and each answer costs a database read, so the endpoint answers "slow down" past this many in ten seconds. It counts in this process only (a deployment with
// several instances allows that many on each), which is enough to stop a loop; nothing relies on it for security.
const WINDOW_MS = 10_000;
const MAX_IN_WINDOW = 30;
const recent = new Map<string, number[]>();

/** Records one snapshot request for the person. Returns the seconds to wait when they have made too many lately, otherwise null. */
export function snapshotBrake(userId: string, now: number = Date.now()): number | null {
  const kept = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length >= MAX_IN_WINDOW) {
    recent.set(userId, kept);
    return Math.max(1, Math.ceil((WINDOW_MS - (now - kept[0])) / 1000));
  }
  kept.push(now);
  recent.set(userId, kept);
  // Forget people who have gone quiet, so the map does not grow with every person who ever signed in.
  if (recent.size > 500) for (const [id, times] of recent) if (times.every((t) => now - t >= WINDOW_MS)) recent.delete(id);
  return null;
}

export const resetSnapshotBrake = (): void => recent.clear();
