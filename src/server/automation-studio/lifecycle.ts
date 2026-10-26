import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { env } from "@/server/env";
import { assertManage, subscriptionForAgency } from "@/server/maintenance/service";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { applyVerifiedPayment } from "@/server/maintenance/payment";
import { applyPaymentFailed, noticeExpired, pauseWorkflowsForLapse } from "@/server/maintenance/lapse";
import type { SessionUser } from "@/server/auth/service";
import { GRACE_REMINDER_HOURS, MAX_GRACE_DAYS, STUDIO_LAPSE_POLICY, canTransition, paidThroughProblem, type PlanStatus, type PlanTransition } from "@/lib/automation-studio/plan";

/**
 * The Automation Studio plan's lifecycle after activation: a payment that failed, a payment that was verified, expiry, and what a lapse
 * does to the workspace's workflows. Every transition is made by an iAcquire team member who has checked it with the client or the payment
 * provider; nothing here talks to a payment provider, so "verified" means a person verified it (recurring card billing is not built).
 *
 * A lapse only ever PAUSES workflows built in Automation Studio (and those that use its premium steps). Nothing is deleted or failed:
 *  - runs in progress wait, because their workflow is paused and the engine does not claim runs of paused workflows;
 *  - definitions, versions, run history and conversations are kept;
 *  - CRM workflows, AI employees and their schedules, n8n / Zapier / Make connections, webhooks and the API are not touched;
 *  - when the plan is active again nothing switches itself back on: each workflow is validated and turned on by a person (setWorkflowStatus).
 */

const PLAN_LINK = "/maintenance";

function allow(status: string, t: PlanTransition) {
  if (!canTransition(status as PlanStatus, t)) {
    const what = t === "payment_failed" ? "marked as past due" : t === "payment_verified" ? "marked as paid" : "expired";
    throw new AppError("conflict", `A plan that is ${status.replace("_", " ")} can't be ${what}.`);
  }
}

// Pausing the workflows, the lapse notices and the move into past due are shared with the other ways a plan lapses (src/server/maintenance/lapse.ts).
export { pauseWorkflowsForLapse };

/**
 * An agency member records that a payment for the plan didn't go through. The workspace keeps Automation Studio for the grace period: the
 * platform default (STUDIO_PAYMENT_GRACE_DAYS, 7 unless configured), or `graceDays` (1 to 30) for this case. The owners are told the date.
 */
export async function recordPaymentFailed(user: SessionUser, subscriptionId: string, opts: { graceDays?: number; now?: Date } = {}): Promise<{ graceEndsAt: string; graceDays: number }> {
  assertManage(user);
  const now = opts.now ?? new Date();
  const graceDays = opts.graceDays ?? env().STUDIO_PAYMENT_GRACE_DAYS;
  if (!Number.isInteger(graceDays) || graceDays < 1 || graceDays > MAX_GRACE_DAYS) throw new AppError("invalid_input", `The grace period is a whole number of days from 1 to ${MAX_GRACE_DAYS}.`);
  const graceEnds = await withSystem(async (db) => {
    const s = await subscriptionForAgency(db, user, subscriptionId);
    return (await applyPaymentFailed(db, { subscription: s, actor: { kind: "agency", userId: user.id }, graceDays, now })).graceEndsAt;
  });
  return { graceEndsAt: graceEnds.toISOString(), graceDays };
}

/**
 * An agency member records a payment they verified, through `paidThroughOn`. A plan that was past due or expired becomes active again; the
 * workflows a lapse paused stay paused until a person turns each on (the owners are told).
 */
export async function recordVerifiedPayment(user: SessionUser, subscriptionId: string, input: { paidThroughOn: string }, now = new Date()): Promise<{ reactivated: boolean; workflowsWaiting: number }> {
  assertManage(user);
  const problem = paidThroughProblem(input.paidThroughOn, now);
  if (problem) throw new AppError("invalid_input", problem);
  return withSystem(async (db) => {
    const s = await subscriptionForAgency(db, user, subscriptionId);
    // The transition itself (checks, dates, the owner's notice, the audit entry) is shared with a payment a Super Admin records outside a provider.
    const out = await applyVerifiedPayment(db, { subscription: s, mode: "renew", actor: { kind: "agency", userId: user.id }, paidThroughOn: input.paidThroughOn, now });
    return { reactivated: out.reactivated, workflowsWaiting: out.workflowsWaiting };
  });
}

/** An agency member ends the plan now (past its grace period, or because the client asked). Studio workflows are paused. */
export async function expireSubscription(user: SessionUser, subscriptionId: string, now = new Date()): Promise<{ pausedWorkflows: number }> {
  assertManage(user);
  return withSystem(async (db) => {
    const s = await subscriptionForAgency(db, user, subscriptionId);
    allow(s.status, "expire");
    await db.query("update maintenance_subscriptions set status = 'expired', expired_at = $2 where id = $1", [subscriptionId, now.toISOString()]);
    const pausedWorkflows = await pauseWorkflowsForLapse(db, s.org_id, now);
    await noticeExpired(db, s.org_id, subscriptionId);
    await recordAudit({ orgId: s.org_id, actorUserId: user.id, actorKind: "agency", action: "maintenance.expired", targetType: "maintenance_subscription", targetId: subscriptionId, result: "success", metadata: { pausedWorkflows } }, db);
    return { pausedWorkflows };
  });
}

export interface SweepResult {
  expired: number;
  workspacesLapsed: number;
  workflowsPaused: number;
  workspacesRestored: number;
}

/**
 * The scheduler's pass over the plan (job "studioEntitlementSweep", every tick: two indexed queries when nothing is premium):
 *  1. Plans past due whose grace period ended become expired.
 *  2. Any workspace with a switched-on Automation Studio workflow but no entitlement gets those workflows paused. This also catches a plan
 *     that was cancelled, or a row changed outside the portal, so the engine's own checks are never the only protection.
 *  3. A workspace whose plan is active again and still has plan-paused workflows is told once that they wait for a person.
 * Core CRM workflows and AI employees are never selected: only versions that use premium features are.
 */
export async function sweepStudioEntitlements(now = new Date()): Promise<SweepResult> {
  const out: SweepResult = { expired: 0, workspacesLapsed: 0, workflowsPaused: 0, workspacesRestored: 0 };

  const lapsed = await withSystem(async (db) => {
    const rows = (await db.query<{ id: string; org_id: string }>(
      "update maintenance_subscriptions set status = 'expired', expired_at = $1 where status = 'past_due' and grace_ends_at <= $1 returning id, org_id",
      [now.toISOString()],
    )).rows;
    for (const s of rows) {
      await recordAudit({ orgId: s.org_id, actorKind: "system", action: "maintenance.expired", targetType: "maintenance_subscription", targetId: s.id, result: "success", metadata: { reason: "grace_period_ended" } }, db);
      await noticeExpired(db, s.org_id, s.id);
    }
    return rows;
  });
  out.expired = lapsed.length;

  // A plan whose grace period is nearly over: the owners are reminded once, with the date.
  await withSystem(async (db) => {
    const ending = await db.query<{ id: string; org_id: string; grace_ends_at: Date }>(
      "select id, org_id, grace_ends_at from maintenance_subscriptions where status = 'past_due' and grace_ends_at > $1 and grace_ends_at <= $2 limit 500",
      [now.toISOString(), new Date(now.getTime() + GRACE_REMINDER_HOURS * 3_600_000).toISOString()],
    );
    for (const s of ending.rows) {
      await notifyOrgRoles(db, s.org_id, ["owner"], {
        kind: "maintenance_update",
        severity: "warning",
        title: "Automation Studio will pause soon",
        body: `The payment for your maintenance plan still hasn't been received. Automation Studio keeps working until ${new Date(s.grace_ends_at).toISOString().slice(0, 10)}; after that its workflows are paused (nothing is deleted). Contact iAcquire to sort out the payment.`,
        link: PLAN_LINK,
        dedupeKey: `studio-grace-ending:${s.id}`,
      });
    }
  });

  // One transaction per workspace: a problem in one never holds back, or rolls back, the others.
  const live = await withSystem((db) =>
    db.query<{ org_id: string }>(
      `select distinct w.org_id from crm_workflows w join crm_workflow_versions v on v.id = w.published_version_id and v.org_id = w.org_id
        where w.status = 'active' and cardinality(v.premium_features) > 0 limit 2000`,
    ),
  );
  for (const { org_id } of live.rows) {
    const paused = await withSystem(async (db) => ((await studioEntitlement(db, org_id, now)).entitled ? 0 : pauseWorkflowsForLapse(db, org_id, now)));
    if (paused) {
      out.workspacesLapsed += 1;
      out.workflowsPaused += paused;
    }
  }

  const waiting = await withSystem((db) =>
    db.query<{ org_id: string; n: number; last_paused: Date }>(
      `select org_id, count(*)::int as n, max(entitlement_paused_at) as last_paused from crm_workflows
        where status = 'paused' and entitlement_paused_at is not null group by org_id limit 2000`,
    ),
  );
  for (const w of waiting.rows) {
    const told = await withSystem(async (db) => {
      if (!(await studioEntitlement(db, w.org_id, now)).entitled) return false;
      await notifyOrgRoles(db, w.org_id, ["owner", "admin"], {
        kind: "maintenance_update",
        severity: "info",
        title: `${w.n === 1 ? "An Automation Studio workflow is" : `${w.n} Automation Studio workflows are`} waiting for you`,
        body: `Your plan is active, and ${w.n === 1 ? "this workflow was" : "these workflows were"} paused while it wasn't. ${STUDIO_LAPSE_POLICY.resume}`,
        link: "/crm/workflows",
        dedupeKey: `studio-waiting:${w.org_id}:${new Date(w.last_paused).toISOString().slice(0, 10)}`,
      });
      return true;
    });
    if (told) out.workspacesRestored += 1;
  }
  return out;
}
