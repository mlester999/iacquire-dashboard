import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { STUDIO_LAPSE_POLICY, canTransition, type PlanStatus } from "@/lib/automation-studio/plan";

/**
 * What a verified payment does to a maintenance plan, in one place, so an agency member recording a payment, a Super Admin recording a payment received outside a
 * provider (src/server/billing/manual.ts) and, later, a provider's webhook all change the plan the same way: the same checks, the same dates, the same notice to the
 * owner and the same audit entry. Nothing here talks to a payment provider or decides that money arrived: the caller has already verified it, and says who did.
 */

const PLAN_LINK = "/maintenance";
const day = (d: Date) => d.toISOString().slice(0, 10);

export type PaymentActor = { kind: "agency"; userId: string } | { kind: "system"; userId: null };

export interface VerifiedPaymentInput {
  /** The plan row, already read FOR UPDATE by the caller. */
  subscription: { id: string; org_id: string; status: string };
  actor: PaymentActor;
  /** The last day the payment covers. The caller has checked it with paidThroughProblem. */
  paidThroughOn: string;
  /** The payment row the period was verified against; null for a period the agency verified in its own records without recording the money. */
  paymentId?: string | null;
  /**
   * "activate" starts a plan that was only requested (billing starts on `billingStartOn`); "renew" records a payment on a plan that already started, and brings a plan
   * that was past due or expired back to active.
   */
  mode: "activate" | "renew";
  billingStartOn?: string;
  now?: Date;
}

export interface VerifiedPaymentResult {
  activated: boolean;
  reactivated: boolean;
  /** Studio workflows a lapse paused that now wait for a person to turn them on. */
  workflowsWaiting: number;
}

export async function applyVerifiedPayment(db: Queryable, input: VerifiedPaymentInput): Promise<VerifiedPaymentResult> {
  const s = input.subscription;
  const now = input.now ?? new Date();
  const paymentId = input.paymentId ?? null;
  const actorKind = input.actor.kind;
  const actorUserId = input.actor.userId;

  if (input.mode === "activate") {
    if (s.status !== "requested") throw new AppError("conflict", "Only a requested plan can be activated.");
    if (!input.billingStartOn || !/^\d{4}-\d{2}-\d{2}$/.test(input.billingStartOn)) throw new AppError("invalid_input", "Use a valid billing start date.");
    const st = (await db.query<{ state: string | null; cleared: boolean }>(
      "select (select i.state from client_setup_instances i where i.org_id = $1) as state, app.setup_payment_cleared($1) as cleared", [s.org_id],
    )).rows[0];
    if (st?.state !== "activated") throw new AppError("conflict", "The core system isn't activated yet, so the plan can't start.");
    if (st.cleared !== true) throw new AppError("conflict", "The setup payment isn't confirmed yet, so the plan can't start.");
    await db.query(
      `update maintenance_subscriptions set status = 'active', activated_by = $2, activated_at = $6, billing_start_on = $3, renewal_on = null,
         last_payment_verified_at = $6, last_payment_verified_by = $2, paid_through_on = $4, last_payment_id = $5 where id = $1`,
      [s.id, actorUserId, input.billingStartOn, input.paidThroughOn, paymentId, now.toISOString()],
    );
    await notifyOrgRoles(db, s.org_id, ["owner"], { kind: "maintenance_update", severity: "success", title: "Managed maintenance is active", body: `Billing starts ${input.billingStartOn}.`, link: PLAN_LINK });
    await recordAudit({ orgId: s.org_id, actorUserId, actorKind, action: "maintenance.activated", targetType: "maintenance_subscription", targetId: s.id, result: "success", metadata: { billingStartOn: input.billingStartOn, paymentVerified: true, paidThroughOn: input.paidThroughOn, ...(paymentId ? { paymentId } : {}) } }, db);
    return { activated: true, reactivated: false, workflowsWaiting: 0 };
  }

  if (!canTransition(s.status as PlanStatus, "payment_verified")) throw new AppError("conflict", `A plan that is ${s.status.replace("_", " ")} can't be marked as paid.`);
  const reactivated = s.status === "past_due" || s.status === "expired";
  if (s.status === "expired") {
    // A workspace has one open plan. If the client enrolled again after this one expired, that request is the plan to activate.
    const newer = await db.query("select 1 from maintenance_subscriptions where org_id = $1 and id <> $2 and status in ('requested', 'active', 'past_due', 'cancel_requested')", [s.org_id, s.id]);
    if (newer.rows[0]) throw new AppError("conflict", "This workspace already has a newer plan request. Activate that one instead of reactivating the expired plan.");
  }
  await db.query(
    `update maintenance_subscriptions set status = case when status in ('past_due', 'expired') then 'active' else status end,
       past_due_since = null, grace_ends_at = null, expired_at = null,
       last_payment_verified_at = $2, last_payment_verified_by = $3, paid_through_on = $4, last_payment_id = coalesce($5, last_payment_id) where id = $1`,
    [s.id, now.toISOString(), actorUserId, input.paidThroughOn, paymentId],
  );
  const waiting = (await db.query<{ n: number }>("select count(*)::int as n from crm_workflows where org_id = $1 and status = 'paused' and entitlement_paused_at is not null", [s.org_id])).rows[0].n;
  if (reactivated) {
    await notifyOrgRoles(db, s.org_id, ["owner"], {
      kind: "maintenance_update",
      severity: "success",
      title: "Your maintenance plan is active again",
      body: waiting
        ? `${waiting === 1 ? "One Automation Studio workflow is" : `${waiting} Automation Studio workflows are`} still paused. ${STUDIO_LAPSE_POLICY.resume}`
        : "Automation Studio is available again.",
      link: PLAN_LINK,
      dedupeKey: `studio-reactivated:${s.id}:${day(now)}`,
    });
  }
  await recordAudit({ orgId: s.org_id, actorUserId, actorKind, action: "maintenance.payment_verified", targetType: "maintenance_subscription", targetId: s.id, result: "success", metadata: { paidThroughOn: input.paidThroughOn, reactivated, ...(paymentId ? { paymentId } : {}) } }, db);
  return { activated: false, reactivated, workflowsWaiting: waiting };
}
