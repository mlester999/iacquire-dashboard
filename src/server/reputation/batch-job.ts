import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { checkOrgAutomation } from "@/server/automation/gate";
import { systemActor } from "@/server/crm/actor";
import { queueReviewRequestInTx } from "@/server/crm/reviews";
import { getConsent } from "@/server/messaging/contacts";
import { assess } from "@/server/reputation/batches";
import { bindingChanges, readBinding, type BatchBinding } from "@/server/reputation/batch-binding";
import { loadAudience } from "@/server/reputation/batch-audience";
import {
  holdBatchMessages, lockBatch, notice, pauseBatchWith, refreshBatchCounts, releaseBatchMessages, setBatchNotice, stopBatchWith, type BatchRow,
} from "@/server/reputation/batch-state";
import { REPUTATION_BATCHES_FEATURE, SURVEYS_NOT_ENABLED_MESSAGE, batchesEnabledIn } from "@/server/reputation/entitlement";
import { APPROVAL_DAYS, classifyRefusal, readBatchCounts, type BatchNotice } from "@/lib/reputation/batches";
import { CHANNEL_LABELS } from "@/lib/messaging";
import { formatDateTime } from "@/lib/utils";

// The batch job (registered in src/server/ops/tick.ts as "reviewRequestBatches", before the dispatcher so what it queues goes out in the same run). Like every scheduler job it
// runs only when the scheduler does and, in a staged start, only when named in SCHEDULER_JOBS_ONLY; and it works only on batches an owner approved, in workspaces whose batch
// switch is on.
//
//  * An approved batch starts: the owner's approval is checked against what would be sent now (the approved wording and its business values, the criteria, the channel and the
//    pace, as one hash; the approver still being the owner; the approval still standing). Any difference stops the batch: nothing is sent that the owner did not see. The people
//    are then read once from the criteria and recorded, each either waiting or left out with the reason.
//  * Waiting customers are asked at most rate_per_minute in any minute, one at a time, each in its own transaction, through queueReviewRequestInTx: the same checks as one review
//    request (consent exactly "granted" on the channel, opt-outs, the 30-day cool-down, a person's hold, quiet hours, frequency limits, credits). The message's dedupe key
//    batch:<batch>:<customer> makes a second message to the same customer impossible.
//  * A customer's own address, consent or hold leaves just that customer out. Credits, the channel or a missing review link pause the whole batch for a person; an approved
//    wording that can no longer be sent stops it for good.
//  * A batch is finished when nobody is waiting. What it queued still goes out through the dispatcher on its own.

const BATCHES_PER_TICK = 5;
/** The most customers one batch's turn looks at in one tick, whatever happens to them, so a tick stays short. */
const MAX_EVALUATIONS_PER_TICK = 200;
/** The most messages one batch queues in one tick (the batch's own pace also applies, and is at most this). */
const MAX_QUEUED_PER_TICK = 60;
/** How long a batch waits before the scheduler looks again when the workspace is paused. */
const PAUSE_RECHECK_MS = 5 * 60_000;

export interface BatchJobResult {
  started: number;
  queued: number;
  excluded: number;
  failed: number;
  waiting: number;
  paused: number;
  stopped: number;
  completed: number;
}

const zero = (): BatchJobResult => ({ started: 0, queued: 0, excluded: 0, failed: 0, waiting: 0, paused: 0, stopped: 0, completed: 0 });

interface Prepared {
  id: string;
  orgId: string;
  org: { id: string; name: string; timezone: string };
  binding: BatchBinding;
  /** The owner whose approval the batch acts on (the author of its messages, never an AI). */
  approverId: string | null;
  ratePerMinute: number;
}

const upper = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
const wordList = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** Checks a batch that is approved or sending and, when it is approved, starts it. Returns what the queue loop needs, or null when it ended or must wait. One transaction. */
async function prepare(id: string, orgId: string, now: Date, out: BatchJobResult): Promise<Prepared | null> {
  return withSystem(async (db) => {
    const b = await lockBatch(db, id, orgId, { skipLocked: true });
    if (!b || (b.status !== "approved" && b.status !== "sending")) return null;
    // Switched off since it was approved: it is left exactly as it is (not deleted, not hidden) until the switch is on again.
    if (!(await batchesEnabledIn(db, orgId))) return null;

    // A paused workspace (or iAcquire's own pause) holds the batch, including what it queued and has not sent (the dispatcher does not apply pauses to the system's own sends);
    // it continues by itself when the pause is lifted.
    for (const scope of ["messaging", "outbound"] as const) {
      const gate = await checkOrgAutomation(db, orgId, scope);
      if (!gate.allowed) {
        await holdBatchMessages(db, b);
        await setBatchNotice(db, b, notice("workspace_paused", `${gate.detail} The batch continues by itself when that is lifted.`, now), { waitUntil: new Date(now.getTime() + PAUSE_RECHECK_MS) });
        out.waiting += 1;
        return null;
      }
    }
    if (readBatchCounts(b.counts).notice?.code === "workspace_paused") {
      await releaseBatchMessages(db, b, now);
      await setBatchNotice(db, b, null, { waitUntil: null });
    }

    const stop = async (n: BatchNotice) => {
      await stopBatchWith(db, b, n);
      out.stopped += 1;
      return null;
    };

    const approval = b.approval_id
      ? (await db.query<{ status: string; expires_at: Date | null }>("select status, expires_at from approval_requests where id = $1 and org_id = $2", [b.approval_id, orgId])).rows[0]
      : undefined;
    if (!approval || approval.status !== "approved" || !b.approved_hash) {
      return stop(notice("approval_void", "The owner's approval of this batch no longer stands, so nothing more is sent. Copy the batch and ask the owner to approve the copy.", now));
    }
    if (approval.expires_at && new Date(approval.expires_at).getTime() <= now.getTime()) {
      return stop(notice("approval_expired", `The owner's approval lapsed after ${APPROVAL_DAYS} days, so nothing more is sent. Copy the batch and ask the owner to approve the copy.`, now));
    }
    const role = b.approved_by
      ? (await db.query<{ role: string }>("select role from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [orgId, b.approved_by])).rows[0]?.role
      : undefined;
    if (role !== "owner") {
      return stop(notice("approval_void", "The person who approved this batch is no longer an owner of this workspace, so the approval no longer stands and nothing more is sent. Copy the batch and ask an owner to approve the copy.", now));
    }

    // Everything the owner approved, as it is now. Any difference stops the batch.
    const a = await assess(db, b, now);
    if (!a.binding || !a.criteria || a.hash !== b.approved_hash) {
      // No binding means the wording is gone (edited, archived or no longer approved) or the people can't be read any more.
      const changed = a.binding ? bindingChanges(readBinding(b.approved_binding), a.binding, a.customValues) : [a.template ? "who it is for" : "the message"];
      const detail = `${upper(wordList(changed))} changed after the owner approved this batch, so nothing more is sent. Copy the batch and ask the owner to approve the copy.`;
      return stop(notice(changed.includes("the message") ? "template_changed" : "approval_void", detail, now));
    }

    if (b.status === "approved") {
      // The people are read from the criteria once, now: each is waiting, or left out with the reason.
      const { people, tooLarge } = await loadAudience(db, orgId, a.org.timezone, a.criteria, b.channel, now);
      if (tooLarge) return stop(notice("too_large", "More people matched than one batch may ask by the time it started. Narrow the dates and make a new batch.", now));
      await db.query(
        `insert into review_request_batch_items (org_id, batch_id, contact_id, status, reason, appointment_id, opportunity_id, fact_at)
         select $1, $2, x.contact_id, case when x.reason is null then 'pending' else 'excluded' end, x.reason, x.appointment_id, x.opportunity_id, x.fact_at
         from jsonb_to_recordset($3::jsonb) as x(contact_id uuid, reason text, appointment_id uuid, opportunity_id uuid, fact_at timestamptz)
         on conflict (batch_id, contact_id) do nothing`,
        [orgId, b.id, JSON.stringify(people.map((p) => ({ contact_id: p.contactId, reason: p.outcome === "eligible" ? null : p.outcome, appointment_id: p.appointmentId, opportunity_id: p.opportunityId, fact_at: p.factAt.toISOString() })))],
      );
      // A person's hold on automatic messages is that person's explicit choice: each customer it keeps out of this batch is audited with its reason, the same way a held
      // automatic ask is anywhere else, so the Reviews numbers count them.
      for (const held of people.filter((x) => x.outcome === "held_by_person")) {
        await recordAudit({ orgId, actorKind: "system", action: "crm.review_request_held", targetType: "contact", targetId: held.contactId, result: "denied", metadata: { via: "batch", reason: "held_by_person", batchId: b.id } }, db);
      }
      await db.query("update review_request_batches set status = 'sending', started_at = coalesce(started_at, $3) where id = $1 and org_id = $2 and status = 'approved'", [b.id, orgId, now.toISOString()]);
      b.status = "sending";
      const counts = await refreshBatchCounts(db, b, { notice: null, waitUntil: null });
      await recordAudit({ orgId, actorKind: "system", action: "reputation.batch_started", targetType: "review_request_batch", targetId: b.id, approvalId: b.approval_id, result: "success", metadata: { total: counts.total, waiting: counts.pending, leftOut: counts.excluded } }, db);
      out.started += 1;
    }
    return { id: b.id, orgId, org: a.org, binding: a.binding, approverId: b.approved_by, ratePerMinute: b.rate_per_minute };
  });
}

type Step = "none" | "paced" | "not_sending" | "queued" | "excluded" | "failed" | "paused" | "stopped";

/**
 * How many more customers this batch may ask now: its pace in any minute, less those asked in the last minute and those whose message hasn't gone yet (so a slow dispatcher
 * can't pile them up). A message waiting for the sending window (quiet hours, business hours) hasn't gone either: it counts, so the window opening releases at most one
 * minute of the approved pace and not the whole night's queue. Read inside the transaction that holds the batch's row, so two turns at once can't both spend the same room.
 */
async function paceRoom(db: Queryable, p: Prepared, now: Date): Promise<number> {
  const { rows } = await db.query<{ recent: string; backlog: string }>(
    `select (select count(*) from review_request_batch_items where batch_id = $1 and org_id = $2 and queued_at > $3::timestamptz - interval '60 seconds')::text as recent,
            (select count(*) from review_request_batch_items i join crm_review_requests r on r.id = i.request_id and r.org_id = i.org_id
               join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
               where i.batch_id = $1 and i.org_id = $2 and i.status = 'queued' and m.status = 'queued')::text as backlog`,
    [p.id, p.orgId, now.toISOString()],
  );
  return Math.max(0, Math.min(p.ratePerMinute - Number(rows[0].recent), p.ratePerMinute - Number(rows[0].backlog)));
}

/** A customer who withdrew consent shows as that, not as having none (the send path reports both as "no consent"). */
async function consentReason(db: Queryable, b: BatchRow, contactId: string, binding: BatchBinding): Promise<"consent_withdrawn" | "no_consent"> {
  return (await getConsent(db, b.org_id, contactId, binding.channel, "service")) === "revoked" ? "consent_withdrawn" : "no_consent";
}

/** One waiting customer: asked, left out with the reason, or the batch paused or stopped. One transaction. */
async function queueNext(p: Prepared, now: Date): Promise<Step> {
  return withSystem(async (db): Promise<Step> => {
    const b = await lockBatch(db, p.id, p.orgId);
    if (!b || b.status !== "sending") return "not_sending";
    if ((await paceRoom(db, p, now)) <= 0) return "paced";
    const item = (await db.query<{ contact_id: string; appointment_id: string | null; opportunity_id: string | null }>(
      `select contact_id, appointment_id, opportunity_id from review_request_batch_items where batch_id = $1 and org_id = $2 and status = 'pending'
       order by fact_at desc nulls last, contact_id limit 1 for update skip locked`,
      [b.id, b.org_id],
    )).rows[0];
    if (!item) return "none";
    const setItem = (status: "queued" | "excluded" | "failed", reason: string | null, requestId: string | null = null) =>
      db.query(
        `update review_request_batch_items set status = $4, reason = $5, request_id = $6, queued_at = case when $4 = 'queued' then $7::timestamptz else queued_at end, updated_at = now()
         where batch_id = $1 and org_id = $2 and contact_id = $3`,
        [b.id, b.org_id, item.contact_id, status, reason, requestId, now.toISOString()],
      );

    const t = p.binding;
    let refusal: { reason: string; detail: string };
    try {
      const res = await queueReviewRequestInTx(
        db,
        systemActor(p.org, "Review request batch"),
        {
          contactId: item.contact_id, templateId: t.templateId, contentHash: t.templateContentHash, appointmentId: item.appointment_id, opportunityId: item.opportunity_id,
          kind: t.kind, scale: t.scale,
        },
        { via: "batch", requestedBy: p.approverId, dedupeKey: `batch:${b.id}:${item.contact_id}`, batchId: b.id, now },
      );
      if (res.status === "queued") {
        await setItem("queued", null, res.requestId);
        return "queued";
      }
      refusal = { reason: res.reason, detail: res.detail };
    } catch (err) {
      // The approved wording is no longer the template's approved wording (loadApprovedTemplate refuses), or the customer is gone.
      if (!(err instanceof AppError)) throw err;
      refusal = { reason: err.code === "not_found" ? "not_found" : "template_changed", detail: err.message };
    }

    const c = classifyRefusal(refusal.reason);
    if (c.action === "leave_out") {
      await setItem("excluded", c.reason === "no_consent" ? await consentReason(db, b, item.contact_id, t) : c.reason);
      return "excluded";
    }
    if (c.action === "fail") {
      await setItem("failed", c.reason);
      return "failed";
    }
    const detail = c.action === "pause" ? pauseDetail(c.code, b, refusal.detail) : stopDetail(refusal.detail);
    if (c.action === "pause") {
      await pauseBatchWith(db, b, notice(c.code, detail, now), { hold: false });
      return "paused";
    }
    await stopBatchWith(db, b, notice(c.code, detail, now));
    return "stopped";
  });
}

function pauseDetail(code: BatchNotice["code"], b: BatchRow, refused: string): string {
  switch (code) {
    case "credits": return "Service credits ran out, so the batch paused. Messages already queued still go. Add credits, then resume it to continue.";
    case "budget": return "Sending more would pass this workspace's monthly spending limit, so the batch paused. Raise the limit or wait for next month, then resume it.";
    case "price": return "iAcquire hasn't published a price for this channel, so nothing more can be billed or sent. The batch paused.";
    case "channel": return `${CHANNEL_LABELS[b.channel]} isn't verified and switched on for this workspace any more, so the batch paused. Fix the channel, then resume it.`;
    case "provider": return "Another system owns these conversations, so iAcquire can't message these customers. The batch paused. Move conversations to iAcquire, then resume it.";
    case "no_links": return "There is no public review link switched on, so a review request can't be sent. The batch paused. Add a link, then resume it.";
    case "surveys_not_enabled": return `${SURVEYS_NOT_ENABLED_MESSAGE} The batch paused.`;
    default: return refused;
  }
}

const stopDetail = (refused: string) => `${refused} The approved wording can't be sent, so the batch stopped. Copy it and ask the owner to approve the copy.`;

/** Finishes a sending batch once nobody is waiting; otherwise recounts. */
async function finishIfDone(p: Prepared, now: Date, out: BatchJobResult): Promise<void> {
  await withSystem(async (db) => {
    const b = await lockBatch(db, p.id, p.orgId);
    if (!b || b.status !== "sending") return;
    const counts = await refreshBatchCounts(db, b, { waitUntil: null });
    if (counts.pending > 0) return;
    await db.query("update review_request_batches set status = 'completed', completed_at = $3 where id = $1 and org_id = $2 and status = 'sending'", [b.id, b.org_id, now.toISOString()]);
    await recordAudit({ orgId: b.org_id, actorKind: "system", action: "reputation.batch_completed", targetType: "review_request_batch", targetId: b.id, approvalId: b.approval_id, result: "success", metadata: { queued: counts.queued, leftOut: counts.excluded, failed: counts.failed } }, db);
    await notifyOrgRoles(db, b.org_id, ["owner", "admin"], {
      kind: "system", severity: "success", title: `Review request batch “${b.name.slice(0, 80)}” finished`,
      body: `${counts.queued.toLocaleString("en-US")} asked, ${counts.excluded.toLocaleString("en-US")} left out by the send rules${counts.failed ? `, ${counts.failed.toLocaleString("en-US")} not sent` : ""}. Finished ${formatDateTime(now, p.org.timezone)}.`,
      link: `/crm/reviews?tab=batches&batch=${b.id}`, dedupeKey: `review-batch-completed:${b.id}`,
    });
    out.completed += 1;
  });
}

/** One batch's turn: prepare (and maybe start), ask what the pace allows, then finish it or recount. */
export async function advanceBatch(id: string, orgId: string, now: Date, out: BatchJobResult = zero()): Promise<BatchJobResult> {
  const p = await prepare(id, orgId, now, out);
  if (!p) return out;
  let queued = 0;
  for (let i = 0; i < MAX_EVALUATIONS_PER_TICK && queued < MAX_QUEUED_PER_TICK; i += 1) {
    const step = await queueNext(p, now);
    if (step === "queued") {
      queued += 1;
      out.queued += 1;
    } else if (step === "excluded") out.excluded += 1;
    else if (step === "failed") out.failed += 1;
    else if (step === "paused") {
      out.paused += 1;
      return out;
    } else if (step === "stopped") {
      out.stopped += 1;
      return out;
    } else break;
  }
  await finishIfDone(p, now, out);
  return out;
}

/**
 * Scheduler entry point. Safe to run twice at once or back to back: each batch is claimed with its row lock, each customer moves from waiting to asked in the same transaction as
 * their message, and the message's dedupe key refuses a second one for the same customer.
 *
 * Every workspace is considered, a suspended or archived one included: prepare() is the only place that parks a batch's queued messages when the workspace may not send, so a
 * workspace that was suspended with messages waiting must still reach it. It starts nothing there; it only holds.
 */
export async function processReviewBatches(opts: { now?: Date; limit?: number } = {}): Promise<BatchJobResult> {
  const now = opts.now ?? new Date();
  const out = zero();
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; org_id: string }>(
      `select b.id, b.org_id from review_request_batches b
       join org_features f on f.org_id = b.org_id and f.feature = $3 and f.enabled
       where b.status in ('approved', 'sending') and coalesce((b.counts->>'waitUntil')::timestamptz, '-infinity'::timestamptz) <= $1::timestamptz
       order by coalesce(b.started_at, b.approved_at), b.id limit $2`,
      [now.toISOString(), Math.min(20, opts.limit ?? BATCHES_PER_TICK), REPUTATION_BATCHES_FEATURE],
    ),
  );
  for (const r of rows) {
    try {
      await advanceBatch(r.id, r.org_id, now, out);
    } catch (err) {
      // One batch failing never holds back the others; it is tried again on the next tick.
      console.error("[iacquire] advancing a review request batch failed", { batchId: r.id, error: err instanceof Error ? err.name : "unknown" });
    }
  }
  return out;
}
