import "server-only";
import { withSystem } from "@/server/db";
import { loadSupportSettings } from "@/server/support/settings";
import { applyStatusChange } from "@/server/support/lifecycle";
import { checkResponseTargets } from "@/server/support/response-clock";
import { flushSupportEmails } from "@/server/support/notify";
import { cleanupStagedUploads, purgeRetainedAttachments } from "@/server/support/attachments";
import type { TicketCore } from "@/server/support/access";

// Scheduled work for Support & Requests. Registered in src/server/ops/tick.ts, so it shares the scheduler's lease, heartbeats and
// failure handling. Every job is idempotent: a run that repeats, or two that overlap, changes nothing twice.

/** Raises response-target notices (approaching / overdue) and escalation flags. Returns how many notices were raised. */
export async function runResponseTargetCheck(): Promise<number> {
  const r = await checkResponseTargets();
  return r.approaching + r.overdue + r.escalated;
}

/** Sends queued support emails and retries failed ones. Returns how many emails were attempted. */
export async function runSupportEmails(): Promise<number> {
  const r = await flushSupportEmails({ limit: 100 });
  return r.sent + r.captured + r.failed + r.skipped;
}

/** Closes resolved requests the client never came back to, once the Super Admin's auto-close period has passed (off by default). */
export async function autoCloseResolvedRequests(limit = 100): Promise<number> {
  const settings = await loadSupportSettings();
  if (!settings.autoCloseResolvedDays) return 0;
  const days = settings.autoCloseResolvedDays;
  const ids = await withSystem(async (db) =>
    (await db.query<{ id: string }>(
      "select id from support_tickets where status = 'resolved' and resolved_at < now() - make_interval(days => $1) order by resolved_at limit $2",
      [days, limit],
    )).rows,
  );
  let closed = 0;
  for (const { id } of ids) {
    const did = await withSystem(async (db) => {
      const { rows } = await db.query<TicketCore>(
        `select id, ref, org_id, created_by, subject, request_type, category, status, priority, assigned_to, feedback_stage, first_responded_at, resolved_at, reopened_count
         from support_tickets where id = $1 for update`,
        [id],
      );
      // Re-checked under the lock: the client may have reopened it a moment ago.
      if (!rows[0] || rows[0].status !== "resolved") return false;
      await applyStatusChange(db, rows[0], "closed", { userId: null, kind: "system" }, {
        note: `Closed automatically ${days} day${days === 1 ? "" : "s"} after it was resolved.`,
        threadLine: `This request was closed automatically ${days} day${days === 1 ? "" : "s"} after it was resolved. Open a new request if you need more help.`,
      });
      return true;
    });
    if (did) closed += 1;
  }
  return closed;
}

/** Removes files that were never sent and, when configured, files of long-closed requests. Returns how many files were removed. */
export async function runAttachmentCleanup(): Promise<number> {
  return (await cleanupStagedUploads()) + (await purgeRetainedAttachments());
}
