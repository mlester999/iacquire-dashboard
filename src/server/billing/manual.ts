import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import type { SessionUser } from "@/server/auth/service";
import { checkManualPayment, checkRefundFields, checkWaiverReason, MANUAL_KIND_LABEL, MICROS_PER_CENT, type ManualPaymentFields } from "@/lib/billing-clearance";
import { todayIn } from "@/lib/invoices/state";
import { formatUsd } from "@/lib/billing";
import { markSetupFeeWaived, markSetupFeePaid } from "@/server/billing/clearance";
import { afterSetupCleared } from "@/server/billing/after-clearing";
import { newPaymentReference, recordRefund } from "@/server/billing/payments";
import { applyVerifiedPayment } from "@/server/maintenance/payment";

/**
 * iAcquire's own money, recorded by a person: a payment that arrived outside a provider (a bank transfer, cash, a PayPal or PayMongo dashboard entry), a waiver of the
 * setup fee, and a refund. Only a Super Admin (billing.agency_manage) may do any of it, every one is audited with who and why, and none is ever inferred: nothing here
 * says a payment was detected, because a person saw it. These are iAcquire's setup fee and plan, not the invoices a client sends its own customers.
 */

type Admin = Pick<SessionUser, "id" | "platformRole">;

async function assertMayManage(db: Queryable, admin: Admin, orgId: string) {
  const { rows } = await db.query<{ ok: boolean }>(
    "select coalesce(app.user_has_agency_permission($1, 'billing.agency_manage'), false) and coalesce(app.user_can_access_org($1, $2), false) as ok",
    [admin.id, orgId],
  );
  if (rows[0]?.ok !== true) throw new AppError("forbidden", "Only a Super Admin can record payments, waive the setup fee or record refunds.");
}

async function clientOrg(db: Queryable, orgId: string) {
  const org = (await db.query<{ kind: string }>("select kind from organizations where id = $1", [orgId])).rows[0];
  if (!org || org.kind !== "client") throw new AppError("not_found", "Client not found.");
}

async function agencyToday(db: Queryable, now: Date) {
  const tz = (await db.query<{ timezone: string }>("select timezone from organizations where kind = 'agency' limit 1")).rows[0]?.timezone ?? "UTC";
  return { today: todayIn(now, tz), tz };
}

export interface ManualPaymentResult {
  paymentId: string;
  referenceNumber: string;
  /** The same bank reference was already recorded for this same payment: nothing was written twice. */
  duplicate: boolean;
  /** This payment is the one that cleared the setup fee. */
  clearedSetup: boolean;
  provisioningRequested: number;
}

/**
 * Records money a Super Admin saw arrive outside a provider. The payment, the status it changes and the AI employees' provisioning requests commit together or not at
 * all. The same reference never makes two payments: recording it again for the same workspace, kind and amount returns the first record untouched; for anything else
 * it is refused. A setup-fee payment must equal the agreed fee (anything else is a waiver with a reason); a maintenance payment names the period it covers and goes
 * through the same transition as an agency member's verification, so the plan and the money record agree.
 */
export async function recordManualPayment(admin: Admin, orgId: string, input: ManualPaymentFields & { billingStartOn?: string | null }, opts: { now?: Date } = {}): Promise<ManualPaymentResult> {
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    await assertMayManage(db, admin, orgId);
    await clientOrg(db, orgId);
    const account = (await db.query<{ setup_fee_cents: number; setup_payment_status: string }>("select setup_fee_cents, setup_payment_status from billing_accounts where org_id = $1 for update", [orgId])).rows[0];
    if (!account) throw new AppError("not_found", "This client has no billing account.");
    const { today, tz } = await agencyToday(db, now);
    const checked = checkManualPayment(input, { today, now, agreedSetupFeeCents: account.setup_fee_cents });
    if (!checked.ok) throw new AppError("invalid_input", checked.error);
    const v = checked.value;
    const micros = v.amountCents * MICROS_PER_CENT;

    // The same reference is the same payment: a double click, a retry or a second Super Admin finds the first record and changes nothing.
    const existing = (await db.query<{ id: string; org_id: string; kind: string; usd_amount_micros: string; reference_number: string }>(
      "select id, org_id, kind, usd_amount_micros::text, reference_number from payments where provider = 'manual' and lower(external_reference) = lower($1)", [v.externalReference],
    )).rows[0];
    if (existing) {
      if (existing.org_id !== orgId || existing.kind !== v.kind || Number(existing.usd_amount_micros) !== micros) {
        throw new AppError("conflict", "That reference is already recorded for a different payment. Each bank reference or receipt number is recorded once.");
      }
      return { paymentId: existing.id, referenceNumber: existing.reference_number, duplicate: true, clearedSetup: false, provisioningRequested: 0 };
    }

    if (v.kind === "setup_fee") {
      if (account.setup_payment_status === "paid") throw new AppError("conflict", "The setup fee is already paid.");
      if (account.setup_payment_status === "waived") throw new AppError("conflict", "The setup fee was waived, so there is nothing to pay.");
    }

    // A maintenance payment needs a plan to apply to; the plan is locked so its status cannot change under the transition.
    let plan: { id: string; org_id: string; status: string } | null = null;
    if (v.kind === "maintenance") {
      plan = (await db.query<{ id: string; org_id: string; status: string }>(
        `select id, org_id, status from maintenance_subscriptions where org_id = $1 and status in ('requested', 'active', 'past_due', 'expired', 'cancel_requested')
         order by created_at desc limit 1 for update`, [orgId],
      )).rows[0] ?? null;
      if (!plan) throw new AppError("conflict", "This client has no maintenance plan to apply the payment to. Record it as Other, or wait until the client requests the plan.");
    }

    // The payment is dated at midday on the day it arrived in the agency's time zone, and never in the future, so the finance report counts it in the right period.
    const reference = newPaymentReference();
    const inserted = (await db.query<{ id: string }>(
      `insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number,
         paid_at, requested_by, verified_by, verified_at, verification_note, external_reference, method, paid_on)
       values ($1, $2, 'paid', $3, $4, 'USD', $5, true, 'manual', $6,
         least(now(), (($7::date + time '12:00') at time zone $8)), null, $9, now(), $10, $11, $12, $7::date)
       returning id`,
      [orgId, v.kind, `${MANUAL_KIND_LABEL[v.kind]} (recorded by iAcquire)`, micros, v.amountCents, reference, v.paidOn, tz, admin.id, v.note, v.externalReference, v.method],
    )).rows[0];

    let clearedSetup = false;
    let provisioningRequested = 0;
    if (v.kind === "setup_fee") {
      const marked = await markSetupFeePaid(db, { orgId, paymentId: inserted.id, updatedBy: admin.id });
      if (marked.first) {
        provisioningRequested = (await afterSetupCleared(db, orgId, { actorUserId: admin.id, how: "payment", eventKey: inserted.id })).provisioningRequested;
        clearedSetup = true;
      }
    } else if (v.kind === "maintenance" && plan) {
      const throughDate = v.paidThroughOn as string;
      await applyVerifiedPayment(db, {
        subscription: plan,
        mode: plan.status === "requested" ? "activate" : "renew",
        actor: { kind: "agency", userId: admin.id },
        paidThroughOn: throughDate,
        paymentId: inserted.id,
        billingStartOn: input.billingStartOn || v.paidOn,
        now,
      });
    } else {
      await notifyOrgRoles(db, orgId, ["owner", "admin"], {
        kind: "billing_payment_received",
        severity: "success",
        title: "Payment received",
        body: `Reference ${reference}. Recorded by iAcquire.`,
        link: "/settings/billing",
        dedupeKey: `payment:${inserted.id}`,
      });
    }
    // A failed transition above (the plan's own rules) throws and rolls the payment row back with it. The bank reference stays on the payment row, not in the audit trail.
    await recordAudit({
      orgId, actorUserId: admin.id, actorKind: "agency", action: "billing.manual_payment_recorded", targetType: "payment", targetId: inserted.id, result: "success",
      metadata: { kind: v.kind, amountCents: v.amountCents, method: v.method, paidOn: v.paidOn, clearedSetup, ...(v.kind === "maintenance" ? { paidThroughOn: v.paidThroughOn } : {}) },
    }, db);
    return { paymentId: inserted.id, referenceNumber: reference, duplicate: false, clearedSetup, provisioningRequested };
  });
}

export interface WaiverResult {
  /** False when the fee was already waived: nothing was written. */
  changed: boolean;
  provisioningRequested: number;
}

/**
 * Waives the setup fee with a reason a person states (founder decision 3, open: whether the reason is shown to the client; today it is not). A waiver clears the same gate
 * a payment does. A fee that is already paid cannot be waived (refund it instead), and an open setup checkout is cancelled so the client cannot pay after the waiver.
 */
export async function waiveSetupFee(admin: Admin, orgId: string, input: { reason: string }): Promise<WaiverResult> {
  const checked = checkWaiverReason(input.reason);
  if (!checked.ok) throw new AppError("invalid_input", checked.error);
  return withSystem(async (db) => {
    await assertMayManage(db, admin, orgId);
    await clientOrg(db, orgId);
    const account = (await db.query<{ setup_payment_status: string }>("select setup_payment_status from billing_accounts where org_id = $1 for update", [orgId])).rows[0];
    if (!account) throw new AppError("not_found", "This client has no billing account.");
    if (account.setup_payment_status === "paid") throw new AppError("conflict", "The setup fee is already paid. Record a refund instead of waiving it.");
    if (account.setup_payment_status === "waived") return { changed: false, provisioningRequested: 0 };
    const marked = await markSetupFeeWaived(db, { orgId, reason: checked.reason, waivedBy: admin.id });
    await db.query("update payments set status = 'cancelled', failure_reason = 'The setup fee was waived' where org_id = $1 and kind = 'setup_fee' and status = 'pending'", [orgId]);
    const after = await afterSetupCleared(db, orgId, { actorUserId: admin.id, how: "waiver", eventKey: `waiver:${orgId}:${Date.now()}` });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "billing.setup_waived", targetType: "billing_account", targetId: orgId, result: "success", metadata: { reason: checked.reason, previous: marked.previous } }, db);
    return { changed: true, provisioningRequested: after.provisioningRequested };
  });
}

export interface RefundResult {
  removedMicros: number;
  shortfallMicros: number;
  /** A full refund of the payment that cleared the setup fee: nothing new is provisioned until a payment or a waiver clears it again. */
  setupRefunded: boolean;
}

/** Records a refund the Super Admin made with the provider or by hand, and tells the client's owners. Never pauses or removes anything that is already running. */
export async function recordRefundAction(admin: Admin, paymentId: string, input: { amount: string; reason: string }): Promise<RefundResult> {
  const checked = checkRefundFields(input);
  if (!checked.ok) throw new AppError("invalid_input", checked.error);
  const target = (await withSystem(async (db) => {
    const p = (await db.query<{ org_id: string; kind: string; description: string }>("select org_id, kind, description from payments where id = $1", [paymentId])).rows[0];
    if (!p) throw new AppError("not_found", "Payment not found.");
    await assertMayManage(db, admin, p.org_id);
    return p;
  }));
  const micros = checked.amountCents * MICROS_PER_CENT;
  const removed = await recordRefund({ paymentId, amountMicros: micros, actorUserId: admin.id, reason: checked.reason });
  const after = await withSystem(async (db) => {
    const status = (await db.query<{ setup_payment_status: string }>("select setup_payment_status from billing_accounts where org_id = $1", [target.org_id])).rows[0]?.setup_payment_status;
    const total = (await db.query<{ refunded: string }>("select refunded_micros::text as refunded from payments where id = $1", [paymentId])).rows[0]?.refunded ?? "0";
    await notifyOrgRoles(db, target.org_id, ["owner", "admin"], {
      kind: "billing_refund_recorded",
      severity: "info",
      title: "A refund was recorded",
      body: `${formatUsd(micros)} was refunded for: ${target.description}.`,
      link: "/settings/billing",
      // One notice per refund: the running total only grows, so each refund of a payment has its own key.
      dedupeKey: `refund:${paymentId}:${total}`,
    });
    return status;
  });
  return { ...removed, setupRefunded: target.kind === "setup_fee" && after === "refunded" };
}
