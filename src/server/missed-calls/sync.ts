import "server-only";
import type { Queryable } from "@/server/db";
import { logSafeServerDiagnostic } from "@/server/diagnostics";
import { syncCaseForCall, type SyncResult } from "@/server/missed-calls/cases";

/**
 * Syncs the missed-call case for a call record without ever failing the caller. The sync runs inside its own savepoint: if it throws, only its
 * own work is undone, the call record stays saved, and the sweep in the scheduler's recovery job picks the call up again later. Returns null
 * when the sync failed.
 */
export async function syncCaseForCallSafely(db: Queryable, orgId: string, callRecordId: string, now = new Date()): Promise<SyncResult | null> {
  await db.query("savepoint missed_call_sync");
  try {
    const r = await syncCaseForCall(db, orgId, callRecordId, now);
    await db.query("release savepoint missed_call_sync");
    return r;
  } catch (err) {
    await db.query("rollback to savepoint missed_call_sync");
    if (process.env.MCC_DEBUG) console.error("[iacquire] missed-call sync failed (debug)", err);
    else if (process.env.NODE_ENV !== "test") logSafeServerDiagnostic("missed call sync failed", err, "missed_call_sync");
    return null;
  }
}
