import "server-only";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { sanitizeErrorText } from "@/lib/ops";
import { ProviderCallError } from "@/server/customer-payments/providers/types";
import { recordAndApply, newPaymentReference } from "@/server/billing/payments";
import { paypalAdapter, paypalStatus } from "@/server/billing/providers/paypal";
import {
  cancelSubscription, chargeEventFrom, checkMaintenancePlan, listCollectedCharges, openSubscription, readSubscription, statusEventFrom, type SubscriptionsDeps,
} from "@/server/billing/providers/paypal-subscriptions";
import { AGREEMENT_SELECT, agreementForPlan, agreementsForPlans, recurringAvailability, type AgreementRow, type AgreementView, type RecurringAvailability } from "@/server/maintenance/agreement-read";
import { releaseHold } from "@/server/maintenance/agreement";
import { assertManage } from "@/server/maintenance/service";
import { AGREEMENT_APPROVAL_WINDOW_HOURS, isTerminalAgreement, type AgreementStatus } from "@/lib/maintenance-agreement";
import { addDays, daysUntil } from "@/lib/billing-renewal";
import { todayIn } from "@/lib/invoices/state";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";

// The optional automatic monthly payment for the maintenance plan: opening, returning from, reading, cancelling and reconciling a PayPal subscription. What a provider's facts do to the
// plan is decided in src/server/maintenance/agreement.ts, through the shared receipt ledger; this file makes the calls and the records around them. Nothing here marks a period paid,
// and nothing here is reached without the Super Admin's switch (agency_billing_settings.recurring_billing_enabled, off by default) and PayPal being connected.
//
// Every call to PayPal is made OUTSIDE a database transaction: a slow provider never holds a lock on a plan.

export { agreementForPlan, agreementsForPlans, recurringAvailability };
export type { AgreementView, RecurringAvailability };

export interface ServiceDeps {
  paypal?: SubscriptionsDeps;
}

/** The Super Admin opens or closes the automatic payment. Closing it never touches an agreement that is already open (it keeps collecting until it is cancelled). Audited with who. */
export async function setRecurringBillingEnabled(user: SessionUser, enabled: boolean): Promise<RecurringAvailability> {
  return withSystem(async (db) => {
    const me = (await db.query<{ ok: boolean }>("select (status = 'active' and platform_role = 'agency_super_admin') as ok from users where id = $1", [user.id])).rows[0];
    if (user.platformRole !== "agency_super_admin" || !me?.ok) throw new AppError("forbidden", "Only a Super Admin can switch automatic payments on or off.");
    const agency = (await db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1")).rows[0]?.id ?? null;
    const changed = await db.query(
      "update agency_billing_settings set recurring_billing_enabled = $1, recurring_billing_by = $2, recurring_billing_at = now() where recurring_billing_enabled is distinct from $1", [enabled, user.id],
    );
    if (changed.rowCount) {
      await recordAudit({ orgId: agency, actorUserId: user.id, actorKind: "agency", action: enabled ? "recurring_billing.enabled" : "recurring_billing.disabled", targetType: "agency_billing_settings", result: "success", metadata: { enabled } }, db);
    }
    return recurringAvailability(db);
  });
}

// ---------------------------------------------------------------------------
// Opening an agreement
// ---------------------------------------------------------------------------

const OPENABLE = ["requested", "active", "past_due", "expired"];

/**
 * The owner asks to pay the maintenance plan monthly and automatically through PayPal. Nothing is charged here and nothing about the plan changes: this opens a subscription for the
 * plan's own price (read from the plan row, and proved equal to PayPal's plan first) and returns PayPal's page for the buyer to approve. A press that finds an approval still waiting
 * returns that same link.
 */
export async function startMaintenanceAgreement(ctx: OrgContext, deps: ServiceDeps = {}): Promise<{ approvalUrl: string; reference: string; resumed: boolean }> {
  if (!ctx.can("maintenance.manage_plan")) throw new AppError("forbidden", "Only a workspace owner can set up automatic payments.");
  const orgId = ctx.org.orgId;

  const prepared = await withSystem(async (db) => {
    const availability = await recurringAvailability(db);
    if (!availability.available) throw new AppError("integration_unavailable", "Automatic payments aren't available right now. You can still pay for the plan online. Nothing was charged.");
    const plan = (await db.query<{ id: string; status: string; monthly_price_cents: number; currency: string; paid_through_on: string | null }>(
      "select id, status, monthly_price_cents, currency, paid_through_on::text as paid_through_on from maintenance_subscriptions where org_id = $1 and status in ('requested', 'active', 'past_due', 'expired', 'cancel_requested') order by created_at desc limit 1 for update", [orgId],
    )).rows[0];
    if (!plan) throw new AppError("not_found", "There's no maintenance plan to pay for. Request the plan first.");
    if (plan.status === "cancel_requested") throw new AppError("conflict", "You've asked to cancel this plan, so automatic payments can't be set up for it.");
    if (!OPENABLE.includes(plan.status)) throw new AppError("conflict", "This plan can't take automatic payments in its current state.");
    if (plan.currency !== "USD") throw new AppError("conflict", "This plan is not priced in US dollars.");
    if (plan.status === "requested") {
      // A requested plan starts when the first charge is confirmed, and can only start once the core system is activated and the setup fee cleared: no subscription is opened that could not be applied.
      const st = (await db.query<{ state: string | null; cleared: boolean }>("select (select i.state from client_setup_instances i where i.org_id = $1) as state, app.setup_payment_cleared($1) as cleared", [orgId])).rows[0];
      if (st?.state !== "activated" || st.cleared !== true) throw new AppError("conflict", "The plan can start once the core system is activated and the setup fee is confirmed. Nothing was charged.");
    }
    const open = (await db.query<AgreementRow>(`${AGREEMENT_SELECT} where a.subscription_id = $1 and a.status in ('approval_pending', 'approved', 'active', 'suspended') for update of a`, [plan.id])).rows[0];
    if (open) {
      const fresh = Date.now() - new Date(open.created_at).getTime() < AGREEMENT_APPROVAL_WINDOW_HOURS * 3_600_000;
      if (open.status === "approval_pending" && open.approval_url && fresh) return { kind: "resume" as const, approvalUrl: open.approval_url, reference: open.reference_number };
      throw new AppError("conflict", open.status === "approval_pending" ? "An automatic payment is waiting for approval and has not expired yet. Wait for it to close, or cancel it first." : "Automatic payments are already set up for this plan.");
    }
    const tz = (await db.query<{ timezone: string }>("select timezone from organizations where kind = 'agency' limit 1")).rows[0]?.timezone ?? "UTC";
    return { kind: "new" as const, plan, today: todayIn(new Date(), tz), livemode: availability.livemode === true };
  });
  if (prepared.kind === "resume") return { approvalUrl: prepared.approvalUrl, reference: prepared.reference, resumed: true };

  // PayPal's plan must be the plan we priced: a price is never taken from PayPal's side.
  const check = await checkMaintenancePlan({ amountMinor: prepared.plan.monthly_price_cents, currency: "USD" }, deps.paypal).catch((e: unknown) => {
    if (e instanceof ProviderCallError) throw new AppError("integration_unavailable", "PayPal couldn't be reached to set up automatic payments. Nothing was charged. Please try again in a few minutes.");
    throw e;
  });
  if (!check.ok) {
    await withSystem(async (db) => {
      await notifyAgency(db, null, {
        kind: "billing_reconciliation", severity: "warning", title: "Automatic payments are blocked: the PayPal plan doesn't match",
        body: `${check.problems.join(" ")} No subscription was opened. Fix the plan in PayPal (or PAYPAL_MAINTENANCE_PLAN_ID) and try again.`.slice(0, 900),
        link: "/admin/maintenance", dedupeKey: `agreement-plan-check:${new Date().toISOString().slice(0, 10)}`,
      });
    });
    throw new AppError("integration_unavailable", "Automatic payments aren't available right now. You can still pay for the plan online. Nothing was charged.");
  }

  const reference = newPaymentReference();
  const appUrl = env().APP_URL.replace(/\/$/, "");
  // A plan already paid through a later day is not charged again until that day has passed.
  const covered = daysUntil(prepared.plan.paid_through_on, prepared.today);
  const startAt = prepared.plan.paid_through_on && covered !== null && covered >= 1 ? new Date(`${addDays(prepared.plan.paid_through_on, 1)}T00:00:00Z`) : null;

  const created = await withSystem(async (db) => {
    const inserted = await db.query<{ id: string }>(
      `insert into maintenance_agreements (org_id, subscription_id, reference_number, livemode, amount_minor, currency, requested_by)
       values ($1, $2, $3, $4, $5, 'USD', $6) returning id`,
      [orgId, prepared.plan.id, reference, prepared.livemode, prepared.plan.monthly_price_cents, ctx.user.id],
    );
    await recordAudit({ orgId, actorUserId: ctx.user.id, actorKind: "user", action: "maintenance.agreement_started", targetType: "maintenance_agreement", targetId: inserted.rows[0].id, result: "success", metadata: { reference, amountMinor: prepared.plan.monthly_price_cents, deferredTo: startAt ? startAt.toISOString().slice(0, 10) : null } }, db);
    return inserted.rows[0].id;
  });

  let opened: Awaited<ReturnType<typeof openSubscription>>;
  try {
    opened = await openSubscription({
      reference, returnUrl: `${appUrl}/maintenance?agreement=${reference}&return=success`, cancelUrl: `${appUrl}/maintenance?agreement=${reference}&return=cancelled`, startTime: startAt,
    }, deps.paypal);
  } catch (e) {
    await withSystem(async (db) => {
      await db.query("update maintenance_agreements set status = 'abandoned' where id = $1 and status = 'approval_pending'", [created]);
      await recordAudit({ orgId, actorUserId: ctx.user.id, actorKind: "user", action: "maintenance.agreement_start_failed", targetType: "maintenance_agreement", targetId: created, result: "failure", metadata: { error: sanitizeErrorText(e, 160) } }, db);
    });
    throw new AppError("integration_unavailable", "PayPal couldn't set up automatic payments right now. Nothing was charged. Please try again in a few minutes.");
  }
  await withSystem((db) =>
    db.query("update maintenance_agreements set provider_agreement_id = coalesce(provider_agreement_id, $2), approval_url = $3 where id = $1", [created, opened.providerAgreementId, opened.approvalUrl]),
  );
  return { approvalUrl: opened.approvalUrl, reference, resumed: false };
}

// ---------------------------------------------------------------------------
// Reading PayPal's own record
// ---------------------------------------------------------------------------

interface SyncRow {
  id: string;
  org_id: string;
  provider_agreement_id: string | null;
  status: AgreementStatus;
  livemode: boolean;
  created_at: Date;
}

const CHARGE_LOOKBACK_DAYS = 35;

/**
 * Asks PayPal about one agreement and applies what it says through the receipt ledger: its status, and every charge it lists as collected. Safe to run any number of times. The
 * agreement is also cancelled at PayPal when the buyer approved it after the product gave up on it (PayPal would otherwise charge for something the product treats as ended).
 */
async function syncOne(a: SyncRow, deps: SubscriptionsDeps, now: Date): Promise<{ charges: number; cancelledLate: boolean }> {
  if (!a.provider_agreement_id) return { charges: 0, cancelledLate: false };
  const facts = await readSubscription(a.provider_agreement_id, deps);
  if (!facts) {
    await withSystem((db) => db.query("update maintenance_agreements set last_checked_at = now() where id = $1", [a.id]));
    return { charges: 0, cancelledLate: false };
  }
  const event = statusEventFrom(facts, a.livemode);
  if (event) await recordAndApply(paypalAdapter, event);

  let cancelledLate = false;
  if (a.status === "abandoned" && (facts.status === "approved" || facts.status === "active" || facts.status === "suspended")) {
    await cancelSubscription(a.provider_agreement_id, "The agreement was not approved in time.", deps);
    cancelledLate = true;
    await withSystem(async (db) => {
      await db.query("update maintenance_agreements set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Approved after it was closed' where id = $1 and status = 'abandoned'", [a.id]);
      await recordAudit({ orgId: a.org_id, actorKind: "system", action: "maintenance.agreement_cancelled", targetType: "maintenance_agreement", targetId: a.id, result: "success", metadata: { reason: "approved_after_closed" } }, db);
    });
  }

  let charges = 0;
  if (facts.status && facts.status !== "approval_pending") {
    const from = new Date(Math.max(new Date(a.created_at).getTime(), now.getTime() - CHARGE_LOOKBACK_DAYS * 86_400_000));
    for (const c of await listCollectedCharges(a.provider_agreement_id, { from, to: new Date(now.getTime() + 3_600_000) }, deps)) {
      const out = await recordAndApply(paypalAdapter, chargeEventFrom(a.provider_agreement_id, c, a.livemode));
      if (out.outcome === "processed") charges += 1;
    }
  }
  await withSystem((db) => db.query("update maintenance_agreements set last_checked_at = now() where id = $1", [a.id]));
  return { charges, cancelledLate };
}

/**
 * The buyer is back from PayPal's page. This reads PayPal's own record of the subscription (and what it collected so far) and applies it; it sends nothing to PayPal but a read, and the
 * browser contributes only the reference of the agreement. It never says a payment was received: the page reads the stored state afterwards.
 */
export async function completeAgreementReturn(ctx: OrgContext, reference: string, deps: ServiceDeps = {}, now = new Date()): Promise<{ status: AgreementStatus } | null> {
  if (!ctx.can("maintenance.manage_plan")) throw new AppError("forbidden", "Only a workspace owner can set up automatic payments.");
  if (!/^IAQ-[A-Z0-9]{8,40}$/.test(reference)) return null;
  const a = (await withSystem((db) => db.query<SyncRow>(
    "select id, org_id, provider_agreement_id, status, livemode, created_at from maintenance_agreements where reference_number = $1 and org_id = $2", [reference, ctx.org.orgId],
  ))).rows[0];
  if (!a) return null;
  try {
    await syncOne(a, deps.paypal ?? {}, now);
  } catch (e) {
    // PayPal being slow must not turn the buyer's return into an error page: the hourly check and the signed notices will bring the record up to date.
    console.error("[iacquire] an automatic payment could not be read back", { error: sanitizeErrorText(e, 120) });
  }
  const after = (await withSystem((db) => db.query<{ status: AgreementStatus }>("select status from maintenance_agreements where id = $1", [a.id]))).rows[0];
  return after ? { status: after.status } : null;
}

// ---------------------------------------------------------------------------
// Ending an agreement
// ---------------------------------------------------------------------------

type Ender = { kind: "user"; userId: string } | { kind: "agency"; userId: string } | { kind: "system"; userId: null };

/**
 * Cancels an agreement at PayPal first, and only records it cancelled once PayPal has said so (or said it already ended). A cancel PayPal cannot be reached for leaves the agreement
 * exactly as it is and says so: the money side is never recorded as stopped when it may not be. The plan itself is unchanged by this.
 */
async function endAgreement(agreementId: string, by: Ender, reason: string, deps: SubscriptionsDeps): Promise<"cancelled" | "already_ended"> {
  const row = (await withSystem((db) => db.query<SyncRow>("select id, org_id, provider_agreement_id, status, livemode, created_at from maintenance_agreements where id = $1", [agreementId]))).rows[0];
  if (!row) throw new AppError("not_found", "That agreement was not found.");
  if (isTerminalAgreement(row.status)) return "already_ended";

  let outcome: "cancelled" | "already_ended" | "unconfirmed" = "cancelled";
  if (row.provider_agreement_id) {
    try {
      const result = await cancelSubscription(row.provider_agreement_id, reason, deps);
      outcome = result === "already_ended" ? "already_ended" : "cancelled";
    } catch (e) {
      // A subscription waiting for approval has no charges to stop: if PayPal will not cancel it, it is closed here and the late-approval check cancels it should it ever be approved.
      if (row.status !== "approval_pending") {
        await withSystem(async (db) => {
          await recordAudit({ orgId: row.org_id, actorUserId: by.userId, actorKind: by.kind === "system" ? "system" : by.kind, action: "maintenance.agreement_cancel_failed", targetType: "maintenance_agreement", targetId: row.id, result: "failure", metadata: { error: sanitizeErrorText(e, 160) } }, db);
          await notifyAgency(db, row.org_id, {
            kind: "billing_reconciliation", severity: "critical", title: "An automatic payment could not be cancelled at PayPal",
            body: "The cancel request did not go through, so the agreement may still be collecting. Cancel it in PayPal, then check the client's billing.",
            link: `/admin/clients/${row.org_id}?tab=billing`, dedupeKey: `agreement-cancel-failed:${row.id}:${new Date().toISOString().slice(0, 10)}`,
          });
        });
        throw new AppError("integration_unavailable", "PayPal couldn't be reached to stop the automatic payment, so it is still on. Please try again, or cancel it in your PayPal account.");
      }
      outcome = "unconfirmed";
    }
  }
  await withSystem(async (db) => {
    const abandoned = outcome === "unconfirmed";
    await db.query(
      "update maintenance_agreements set status = $2, next_billing_at = null, cancelled_by = $3, cancelled_at = now(), cancel_reason = $4 where id = $1 and status not in ('cancelled', 'expired')",
      [row.id, abandoned ? "abandoned" : "cancelled", by.userId, reason.slice(0, 300)],
    );
    await recordAudit({ orgId: row.org_id, actorUserId: by.userId, actorKind: by.kind === "system" ? "system" : by.kind, action: "maintenance.agreement_cancelled", targetType: "maintenance_agreement", targetId: row.id, result: "success", metadata: { reason: reason.slice(0, 200), providerConfirmed: !abandoned } }, db);
    await notifyOrgRoles(db, row.org_id, ["owner", "admin"], {
      kind: "maintenance_update", severity: "info", title: "Automatic payments are stopped",
      body: "The automatic PayPal payment for your maintenance plan was cancelled. The plan itself is unchanged; after the day it is paid through, each period is paid by hand or online.",
      link: "/maintenance", dedupeKey: `agreement-ended:${row.id}`,
    });
  });
  return outcome === "cancelled" ? "cancelled" : "already_ended";
}

/** The owner stops the automatic payment. */
export async function cancelAgreementAsOwner(ctx: OrgContext, deps: ServiceDeps = {}): Promise<void> {
  if (!ctx.can("maintenance.manage_plan")) throw new AppError("forbidden", "Only a workspace owner can stop automatic payments.");
  const open = (await withSystem((db) => db.query<{ id: string }>(
    "select a.id from maintenance_agreements a where a.org_id = $1 and a.status in ('approval_pending', 'approved', 'active', 'suspended') order by a.created_at desc limit 1", [ctx.org.orgId],
  ))).rows[0];
  if (!open) throw new AppError("not_found", "There are no automatic payments to stop.");
  await endAgreement(open.id, { kind: "user", userId: ctx.user.id }, "Stopped by the workspace owner", deps.paypal ?? {});
}

/** A team member stops a client's automatic payment (for example at the client's request). */
export async function cancelAgreementAsAgency(user: SessionUser, agreementId: string, deps: ServiceDeps = {}): Promise<void> {
  assertManage(user);
  const ok = await withSystem(async (db) => {
    const r = (await db.query<{ org_id: string }>("select org_id from maintenance_agreements where id = $1", [agreementId])).rows[0];
    return r ? (await db.query<{ allowed: boolean }>("select app.user_can_access_org($1, $2) as allowed", [user.id, r.org_id])).rows[0]?.allowed === true : false;
  });
  if (!ok) throw new AppError("not_found", "That agreement was not found.");
  await endAgreement(agreementId, { kind: "agency", userId: user.id }, "Stopped by iAcquire", deps.paypal ?? {});
}

/**
 * The plan has ended (the owner's request was confirmed, or it was cancelled), so nothing more may be collected for it. Called after the plan's own change is committed. A failure is
 * reported to the team and never undoes the plan's change; the plan row is the owner's truth, the agreement is the provider's.
 */
export async function stopAgreementForEndedPlan(subscriptionId: string, why: string, deps: ServiceDeps = {}): Promise<void> {
  const open = (await withSystem((db) => db.query<{ id: string }>(
    "select id from maintenance_agreements where subscription_id = $1 and status in ('approval_pending', 'approved', 'active', 'suspended')", [subscriptionId],
  ))).rows;
  for (const a of open) {
    try {
      await endAgreement(a.id, { kind: "system", userId: null }, why, deps.paypal ?? {});
    } catch (e) {
      console.error("[iacquire] an automatic payment could not be stopped with its plan", { error: sanitizeErrorText(e, 120) });
    }
  }
}

/** A team member releases a hold after dealing with the refund or dispute, saying why. Held charges are then applied in order. */
export async function releaseAgreementHold(user: SessionUser, agreementId: string, note: string): Promise<{ applied: number; refused: number }> {
  assertManage(user);
  return withSystem(async (db) => {
    const r = (await db.query<{ org_id: string }>("select org_id from maintenance_agreements where id = $1", [agreementId])).rows[0];
    const ok = r && (await db.query<{ allowed: boolean }>("select app.user_can_access_org($1, $2) as allowed", [user.id, r.org_id])).rows[0]?.allowed === true;
    if (!r || !ok) throw new AppError("not_found", "That agreement was not found.");
    return releaseHold(db, { agreementId, actorUserId: user.id, note });
  });
}

// ---------------------------------------------------------------------------
// The hourly check
// ---------------------------------------------------------------------------

export interface AgreementReconcileResult {
  checked: number;
  charges: number;
  abandoned: number;
  cancelledLate: number;
  failed: number;
  skipped: string | null;
}

const RECONCILE_BATCH = 50;

/**
 * Job maintenanceAgreementReconcile. For every open agreement (and for abandoned ones that could still be approved for a month): reads PayPal's own record, applies the status and any
 * charge a lost notice never delivered, closes an approval nobody gave in time, and cancels one that was approved after it was closed. It calls only the read endpoints and the
 * cancel endpoint, charges no one, and runs whether or not the switch is on (an agreement already open keeps being looked after).
 */
export async function runAgreementReconcile(opts: { now?: Date; batch?: number; deps?: ServiceDeps } = {}): Promise<AgreementReconcileResult> {
  const now = opts.now ?? new Date();
  const out: AgreementReconcileResult = { checked: 0, charges: 0, abandoned: 0, cancelledLate: 0, failed: 0, skipped: null };
  const status = paypalStatus();
  if (!status.configured) return { ...out, skipped: "PayPal is not connected." };
  const rows = (await withSystem((db) => db.query<SyncRow>(
    `select id, org_id, provider_agreement_id, status, livemode, created_at from maintenance_agreements
      where livemode = $1 and (status in ('approval_pending', 'approved', 'active', 'suspended') or (status = 'abandoned' and created_at > $2))
      order by last_checked_at nulls first, created_at limit $3`,
    [status.livemode === true, new Date(now.getTime() - 30 * 86_400_000), Math.min(Math.max(opts.batch ?? RECONCILE_BATCH, 1), 200)],
  ))).rows;
  for (const a of rows) {
    out.checked += 1;
    try {
      const r = await syncOne(a, opts.deps?.paypal ?? {}, now);
      out.charges += r.charges;
      if (r.cancelledLate) out.cancelledLate += 1;
      // An approval nobody gave in time is closed. It is read again first, so one approved a moment ago is not.
      if (a.status === "approval_pending" && now.getTime() - new Date(a.created_at).getTime() > AGREEMENT_APPROVAL_WINDOW_HOURS * 3_600_000) {
        const closed = await withSystem(async (db) => {
          const c = await db.query("update maintenance_agreements set status = 'abandoned', cancel_reason = 'Not approved in time' where id = $1 and status = 'approval_pending'", [a.id]);
          if (c.rowCount) await recordAudit({ orgId: a.org_id, actorKind: "system", action: "maintenance.agreement_abandoned", targetType: "maintenance_agreement", targetId: a.id, result: "success" }, db);
          return Boolean(c.rowCount);
        });
        if (closed) out.abandoned += 1;
      }
    } catch (e) {
      out.failed += 1;
      console.error("[iacquire] an automatic payment could not be checked", { error: sanitizeErrorText(e, 120) });
    }
  }
  return out;
}
