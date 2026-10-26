import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import type { PaymentActor } from "@/server/maintenance/payment";
import { STUDIO_LAPSE_POLICY, STUDIO_PLAN_NAME, canTransition, type PlanStatus } from "@/lib/automation-studio/plan";

/**
 * What it means for a maintenance plan to stop being paid for, in one place: pausing the Automation Studio workflows, telling the owners what that does and does not touch, and
 * the move into "past due". An agency member ending or cancelling a plan, a client ending an unpaid one, the grace period running out and the renewal sweep all use these, so
 * every way a plan lapses pauses the same workflows and says the same words. A lapse only ever PAUSES workflows built in Automation Studio (and those that use its premium
 * steps); nothing is deleted or failed, and core CRM workflows, the AI employees and external automations are never selected. Nothing here talks to a payment provider.
 */

const PLAN_LINK = "/maintenance";
const day = (d: Date) => d.toISOString().slice(0, 10);

/** What a lapse does and does not touch, as one notice body. */
export const lapseNoticeBody = (...lead: string[]) => [...lead, STUDIO_LAPSE_POLICY.paused, STUDIO_LAPSE_POLICY.kept, STUDIO_LAPSE_POLICY.unaffected].join(" ").slice(0, 900);

/**
 * Pauses the workspace's switched-on Automation Studio workflows because the plan lapsed, and tells the owners once a day. Returns how many it paused. Safe to run again: a
 * workflow already paused is not touched, and a person's own pause is never marked as a plan pause.
 */
export async function pauseWorkflowsForLapse(db: Queryable, orgId: string, now = new Date()): Promise<number> {
  const paused = await db.query<{ id: string; name: string }>(
    `update crm_workflows w set status = 'paused', entitlement_paused_at = $2
       from crm_workflow_versions v
      where w.org_id = $1 and w.status = 'active' and v.id = w.published_version_id and v.org_id = w.org_id and cardinality(v.premium_features) > 0
      returning w.id, w.name`,
    [orgId, now.toISOString()],
  );
  for (const w of paused.rows) {
    await recordAudit({ orgId, actorKind: "system", action: "crm.workflow_paused_for_plan", targetType: "crm_workflow", targetId: w.id, result: "success", metadata: { name: w.name.slice(0, 80) } }, db);
  }
  if (paused.rows.length) {
    await notifyOrgRoles(db, orgId, ["owner", "admin"], {
      kind: "maintenance_update",
      severity: "warning",
      title: `${paused.rows.length === 1 ? "An Automation Studio workflow was" : `${paused.rows.length} Automation Studio workflows were`} paused`,
      body: `Your ${STUDIO_PLAN_NAME} plan isn't active. ${STUDIO_LAPSE_POLICY.paused} ${STUDIO_LAPSE_POLICY.kept} ${STUDIO_LAPSE_POLICY.unaffected}`.slice(0, 900),
      link: PLAN_LINK,
      dedupeKey: `studio-lapse:${orgId}:${day(now)}`,
    });
  }
  return paused.rows.length;
}

/** Tells the owners the plan has ended and what that means (once per plan), whether or not any workflow needed pausing. */
export async function noticeExpired(db: Queryable, orgId: string, subscriptionId: string) {
  await notifyOrgRoles(db, orgId, ["owner"], {
    kind: "maintenance_update",
    severity: "warning",
    title: "Your maintenance plan has expired",
    body: lapseNoticeBody().concat(" Contact iAcquire to reactivate the plan.").slice(0, 900),
    link: PLAN_LINK,
    dedupeKey: `studio-expired:${subscriptionId}`,
  });
}

/** Tells the owners the plan is cancelled and what that means (once per plan). The plan is not revived: a client who wants it again enrols again. */
export async function noticeCancelled(db: Queryable, orgId: string, subscriptionId: string) {
  await notifyOrgRoles(db, orgId, ["owner"], {
    kind: "maintenance_update",
    title: "Your maintenance plan is cancelled",
    body: lapseNoticeBody("Nothing more will be billed for it.").concat(" To use Automation Studio again, enrol in the plan again.").slice(0, 900),
    link: PLAN_LINK,
    dedupeKey: `studio-cancelled:${subscriptionId}`,
  });
}

export interface PaymentFailedInput {
  subscription: { id: string; org_id: string; status: string };
  /** An agency member who recorded it, or the system when the renewal sweep did (only while a Super Admin has switched that on). */
  actor: PaymentActor;
  /** A whole number of days, 1 to 30, already checked by the caller. */
  graceDays: number;
  now: Date;
  /**
   * "failed": a person recorded that a payment did not go through. "not_recorded": the period the plan was paid through ended and no payment has been recorded since (the
   * automatic path). The wording differs: the second never says a payment failed, because nothing is known about a payment that was never seen.
   */
  cause?: "failed" | "not_recorded";
  /** The day the plan was paid through, named in the "not recorded" wording. */
  paidThroughOn?: string | null;
}

/** Moves a plan into past due with a disclosed grace period, tells the owners the date, and records who did it. The caller holds the plan row locked. */
export async function applyPaymentFailed(db: Queryable, input: PaymentFailedInput): Promise<{ graceEndsAt: Date }> {
  const s = input.subscription;
  if (!canTransition(s.status as PlanStatus, "payment_failed")) throw new AppError("conflict", `A plan that is ${s.status.replace("_", " ")} can't be marked as past due.`);
  const graceEnds = new Date(input.now.getTime() + input.graceDays * 86_400_000);
  const notRecorded = input.cause === "not_recorded";
  await db.query("update maintenance_subscriptions set status = 'past_due', past_due_since = $2, grace_ends_at = $3 where id = $1", [s.id, input.now.toISOString(), graceEnds.toISOString()]);
  const keeps = `Automation Studio keeps working for ${input.graceDays} more day${input.graceDays === 1 ? "" : "s"}, until ${day(graceEnds)}. After that its workflows are paused (nothing is deleted)`;
  await notifyOrgRoles(db, s.org_id, ["owner"], {
    kind: "maintenance_update",
    severity: "warning",
    title: notRecorded ? "iAcquire hasn't recorded a payment for your maintenance plan" : "A payment for your maintenance plan didn't go through",
    body: notRecorded
      ? `Your plan was paid through ${input.paidThroughOn ?? "the last recorded date"}, and iAcquire has no record of a payment for the next period. ${keeps} until a payment is recorded. If you have already paid, contact iAcquire. Your CRM, AI employees and external automations aren't affected.`
      : `${keeps} until the payment is sorted out. Your CRM, AI employees and external automations aren't affected.`,
    link: PLAN_LINK,
    dedupeKey: `studio-payment-failed:${s.id}:${day(input.now)}`,
  });
  await recordAudit({
    orgId: s.org_id, actorUserId: input.actor.userId, actorKind: input.actor.kind, action: "maintenance.payment_failed", targetType: "maintenance_subscription", targetId: s.id, result: "success",
    metadata: { graceEndsAt: graceEnds.toISOString(), graceDays: input.graceDays, ...(notRecorded ? { cause: "no_payment_recorded", paidThroughOn: input.paidThroughOn ?? null } : {}) },
  }, db);
  return { graceEndsAt: graceEnds };
}
