import "server-only";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { releaseReservation } from "@/server/billing/ledger";
import { HELD_UNTIL, voidApproval } from "@/server/crm/campaigns/state";
import { EMPTY_BATCH_COUNTS, readBatchCounts, type BatchCounts, type BatchNotice, type BatchNoticeCode, type BatchStatus } from "@/lib/reputation/batches";
import type { FeedbackScale, RequestKind } from "@/lib/reputation/scores";
import type { Channel } from "@/lib/messaging";

// State shared by the batch service and the batch job: the row, its counts and the notice explaining why it paused or stopped, holding and releasing the messages it queued
// that have not left, and ending it for good (a person cancelled it, or the approved wording no longer stands).

export interface BatchRow {
  id: string;
  org_id: string;
  name: string;
  status: BatchStatus;
  kind: RequestKind;
  scale: FeedbackScale;
  channel: Channel;
  template_id: string | null;
  criteria: unknown;
  rate_per_minute: number;
  estimate: unknown;
  counts: unknown;
  approval_id: string | null;
  approved_hash: string | null;
  approved_binding: unknown;
  requested_by: string | null;
  requested_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_by: string | null;
}

export const BATCH_COLUMNS =
  "id, org_id, name, status, kind, scale, channel, template_id, criteria, rate_per_minute, estimate, counts, approval_id, approved_hash, approved_binding, requested_by, requested_at, approved_by, approved_at, created_by, created_at, updated_at, started_at, completed_at, cancelled_by";

export async function lockBatch(db: Queryable, id: string, orgId: string, opts: { skipLocked?: boolean } = {}): Promise<BatchRow | null> {
  const { rows } = await db.query<BatchRow>(`select ${BATCH_COLUMNS} from review_request_batches where id = $1 and org_id = $2 for update${opts.skipLocked ? " skip locked" : ""}`, [id, orgId]);
  return rows[0] ?? null;
}

export const notice = (code: BatchNoticeCode, detail: string, at = new Date()): BatchNotice => ({ code, detail: detail.slice(0, 400), at: at.toISOString() });

/** Recounts the customers and stores the counts on the batch, keeping the notice and the wait unless told otherwise. */
export async function refreshBatchCounts(db: Queryable, b: Pick<BatchRow, "id" | "org_id" | "counts">, patch: { notice?: BatchNotice | null; waitUntil?: Date | null } = {}): Promise<BatchCounts> {
  const { rows } = await db.query<{ status: string; reason: string | null; n: string }>(
    `select status, case when status in ('excluded', 'failed') then reason end as reason, count(*)::text as n
     from review_request_batch_items where batch_id = $1 and org_id = $2 group by 1, 2`,
    [b.id, b.org_id],
  );
  const counts: BatchCounts = { ...EMPTY_BATCH_COUNTS, reasons: {} };
  for (const r of rows) {
    const n = Number(r.n);
    counts.total += n;
    if (r.status === "pending") counts.pending += n;
    else if (r.status === "queued") counts.queued += n;
    else if (r.status === "excluded") counts.excluded += n;
    else if (r.status === "failed") counts.failed += n;
    if (r.reason) counts.reasons[r.reason] = (counts.reasons[r.reason] ?? 0) + n;
  }
  // The row is re-read so a notice written earlier in this transaction is kept.
  const cur = readBatchCounts((await db.query<{ counts: unknown }>("select counts from review_request_batches where id = $1 and org_id = $2", [b.id, b.org_id])).rows[0]?.counts ?? b.counts);
  counts.notice = patch.notice === undefined ? cur.notice : patch.notice;
  counts.waitUntil = patch.waitUntil === undefined ? cur.waitUntil : (patch.waitUntil ? patch.waitUntil.toISOString() : null);
  await db.query("update review_request_batches set counts = $3::jsonb where id = $1 and org_id = $2", [b.id, b.org_id, JSON.stringify(counts)]);
  b.counts = counts;
  return counts;
}

/** Sets (or clears) the notice and the wait without recounting. */
export async function setBatchNotice(db: Queryable, b: Pick<BatchRow, "id" | "org_id" | "counts">, n: BatchNotice | null, extra: { waitUntil?: Date | null } = {}): Promise<void> {
  const cur = readBatchCounts((await db.query<{ counts: unknown }>("select counts from review_request_batches where id = $1 and org_id = $2", [b.id, b.org_id])).rows[0]?.counts ?? b.counts);
  const next: BatchCounts = { ...cur, notice: n, waitUntil: extra.waitUntil === undefined ? cur.waitUntil : (extra.waitUntil ? extra.waitUntil.toISOString() : null) };
  await db.query("update review_request_batches set counts = $3::jsonb where id = $1 and org_id = $2", [b.id, b.org_id, JSON.stringify(next)]);
  b.counts = next;
}

/** The batch's messages that are queued but have not left (or been claimed for sending). */
const QUEUED_OF_BATCH = `
  from crm_review_requests r where r.batch_id = $1 and r.org_id = $2 and r.message_id is not null and m.id = r.message_id and m.org_id = r.org_id and m.status = 'queued'`;

/**
 * Holds the messages a batch queued that have not left yet, and gives back their credit holds. They stay queued (so nothing is sent twice and the dedupe key stays theirs)
 * and are released on resume, when every send rule is checked again before they go.
 */
export async function holdBatchMessages(db: Queryable, b: Pick<BatchRow, "id" | "org_id">): Promise<number> {
  const { rows } = await db.query<{ id: string; reservation_id: string | null }>(
    `update conversation_messages m set send_after = $3, status_detail = 'Held: the batch is paused.' ${QUEUED_OF_BATCH} returning m.id, m.reservation_id`,
    [b.id, b.org_id, HELD_UNTIL.toISOString()],
  );
  for (const m of rows) if (m.reservation_id) await releaseReservation(db, { orgId: b.org_id, reservationId: m.reservation_id, reason: "Review request batch paused" });
  return rows.length;
}

/** Lets held messages go again (on resume). The dispatcher re-checks every rule and takes a fresh credit hold for each. */
export async function releaseBatchMessages(db: Queryable, b: Pick<BatchRow, "id" | "org_id">, now: Date): Promise<number> {
  const res = await db.query(`update conversation_messages m set send_after = $3, status_detail = null ${QUEUED_OF_BATCH} and m.send_after >= $4`, [b.id, b.org_id, now.toISOString(), HELD_UNTIL.toISOString()]);
  return res.rowCount;
}

/**
 * Ends a batch's work: customers still waiting are left out (with the reason), and messages it queued that have not left are stopped, their credit holds given back and their
 * requests cancelled, so nobody receives a link from a batch that no longer stands. Messages already sent stay sent.
 */
export async function withdrawBatchWork(db: Queryable, b: Pick<BatchRow, "id" | "org_id">, why: "batch_cancelled" | "batch_stopped", detail: string): Promise<{ waiting: number; messages: number }> {
  const waiting = await db.query("update review_request_batch_items set status = 'excluded', reason = $3, updated_at = now() where batch_id = $1 and org_id = $2 and status = 'pending'", [b.id, b.org_id, why]);
  const { rows } = await db.query<{ id: string; reservation_id: string | null }>(
    `update conversation_messages m set status = 'blocked', blocked_reason = $3, status_detail = $4 ${QUEUED_OF_BATCH} returning m.id, m.reservation_id`,
    [b.id, b.org_id, why, detail.slice(0, 300)],
  );
  for (const m of rows) if (m.reservation_id) await releaseReservation(db, { orgId: b.org_id, reservationId: m.reservation_id, reason: "Review request batch ended" });
  if (rows.length) {
    const ids = rows.map((m) => m.id);
    await db.query("update crm_review_requests set status = 'cancelled' where org_id = $1 and batch_id = $2 and message_id = any($3::uuid[]) and status in ('pending', 'queued')", [b.org_id, b.id, ids]);
    await db.query(
      `update review_request_batch_items i set status = 'excluded', reason = 'withdrawn', updated_at = now()
       from crm_review_requests r where r.id = i.request_id and r.org_id = i.org_id and r.message_id = any($3::uuid[]) and i.batch_id = $1 and i.org_id = $2 and i.status = 'queued'`,
      [b.id, b.org_id, ids],
    );
  }
  return { waiting: waiting.rowCount, messages: rows.length };
}

/**
 * Ends every batch of a workspace that is closing, as if its owner had cancelled each one: the owner's approval is withdrawn, nobody still waiting is asked, and what was queued
 * but not sent is stopped. Returns how many batches it ended. (The offboarding shutdown calls this inside its own transaction, before it stops queued messages in general.)
 */
export async function endWorkspaceBatches(db: Queryable, orgId: string, byUserId: string | null): Promise<number> {
  const { rows } = await db.query<BatchRow>(`select ${BATCH_COLUMNS} from review_request_batches where org_id = $1 and status not in ('completed', 'cancelled', 'stopped') for update`, [orgId]);
  for (const b of rows) {
    await db.query("update review_request_batches set status = 'cancelled', cancelled_by = $3, completed_at = now() where id = $1 and org_id = $2", [b.id, orgId, byUserId]);
    if (b.approval_id) await voidApproval(db, b, "The workspace is closing.", byUserId);
    await withdrawBatchWork(db, b, "batch_cancelled", "Not sent: the workspace is closing.");
    await refreshBatchCounts(db, b, { notice: null, waitUntil: null });
    await recordAudit({ orgId, actorUserId: byUserId, actorKind: byUserId ? "user" : "system", action: "reputation.batch_cancelled", targetType: "review_request_batch", targetId: b.id, approvalId: b.approval_id, result: "success", metadata: { reason: "offboarding" } }, db);
  }
  return rows.length;
}

const OWNERS_AND_MANAGERS = ["owner", "admin"] as const;

/** Tells the owner and managers that a batch stopped or paused by itself. A batch that needs a person's decision should never fail quietly. */
export async function tellTeam(db: Queryable, b: Pick<BatchRow, "id" | "org_id" | "name">, n: BatchNotice, final: boolean): Promise<void> {
  const kind = n.code === "credits" ? "billing_credits_exhausted" : n.code === "budget" ? "billing_budget_warning" : "message_blocked";
  await notifyOrgRoles(db, b.org_id, [...OWNERS_AND_MANAGERS], {
    kind, severity: "warning", title: `Review request batch “${b.name.slice(0, 80)}” ${final ? "stopped" : "paused"}`, body: n.detail,
    link: `/crm/reviews?tab=batches&batch=${b.id}`, dedupeKey: `review-batch-${final ? "stopped" : "paused"}:${b.id}:${n.code}:${n.at.slice(0, 13)}`,
  });
}

/**
 * Pauses a batch that is approved or sending. `hold` also holds what it queued and has not sent (a person's pause); a pause for credits or a missing link leaves them, since
 * messages already paid for still go.
 */
export async function pauseBatchWith(db: Queryable, b: BatchRow, n: BatchNotice, opts: { hold: boolean; byUserId?: string | null; notify?: boolean }): Promise<number> {
  await db.query("update review_request_batches set status = 'paused' where id = $1 and org_id = $2 and status in ('approved', 'sending')", [b.id, b.org_id]);
  b.status = "paused";
  const held = opts.hold ? await holdBatchMessages(db, b) : 0;
  await refreshBatchCounts(db, b, { notice: n, waitUntil: null });
  await recordAudit({
    orgId: b.org_id, actorUserId: opts.byUserId ?? null, actorKind: opts.byUserId ? "user" : "system", action: "reputation.batch_paused", targetType: "review_request_batch", targetId: b.id,
    approvalId: b.approval_id, result: "success", metadata: { code: n.code, hold: opts.hold },
  }, db);
  if (opts.notify !== false) await tellTeam(db, b, n, false);
  return held;
}

/** Ends a batch because what the owner approved no longer stands. It cannot be resumed: it is copied and approved again. */
export async function stopBatchWith(db: Queryable, b: BatchRow, n: BatchNotice, opts: { notify?: boolean } = {}): Promise<void> {
  await db.query("update review_request_batches set status = 'stopped', completed_at = now() where id = $1 and org_id = $2 and status in ('approved', 'sending', 'paused')", [b.id, b.org_id]);
  b.status = "stopped";
  await voidApproval(db, b, n.detail, null);
  await withdrawBatchWork(db, b, "batch_stopped", "Not sent: the batch was stopped because what the owner approved no longer stands.");
  await refreshBatchCounts(db, b, { notice: n, waitUntil: null });
  await recordAudit({ orgId: b.org_id, actorKind: "system", action: "reputation.batch_stopped", targetType: "review_request_batch", targetId: b.id, approvalId: b.approval_id, result: "success", metadata: { code: n.code } }, db);
  if (opts.notify !== false) await tellTeam(db, b, n, true);
}
