import "server-only";
import type { Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { applyPaymentFailed } from "@/server/maintenance/lapse";
import { applyMaintenancePeriod, newPaymentReference, type PaymentRow } from "@/server/billing/payments";
import { RECENT_CHARGE_DAYS, chargeVerdict, isTerminalAgreement, moveAgreement, statusFromPaypal, type AgreementStatus } from "@/lib/maintenance-agreement";
import { daysUntil } from "@/lib/billing-renewal";
import { todayIn } from "@/lib/invoices/state";
import type { NormalizedPaymentEvent } from "@/server/billing/providers/types";

// What a provider's facts about an automatic-payment agreement DO, applied inside the shared receipt ledger's transaction (recordAndApply in src/server/billing/payments.ts). The caller
// has already established the fact (a verified delivery, or PayPal's own answer to a call this server made); the ledger makes a fact applied twice harmless. Nothing here talks to PayPal.
//
// The rules that matter:
//   * An agreement's STATUS grants nothing. A period is paid only by a COMPLETED charge, and that charge goes through the plan's own transition (applyMaintenancePeriod ->
//     applyVerifiedPayment): the same checks, dates, notice and audit entry as a payment recorded by hand.
//   * Money is recorded even when it cannot be applied (a held agreement, a plan that cannot take it): a payment is never dropped, and a plan is never extended against its rules.
//   * A refund or a dispute on a charge holds the agreement. While it is held a further charge is recorded but NOT applied: a person releases the hold. A refund or a dispute never
//     re-enables anything by itself, and never takes anything away by itself either (the notice only reports).
//   * A failed charge starts the plan's grace period only when the period it was meant to pay has already ended; until then the plan is still paid for, and the person is told.
//   * Agreements that ended never come back; news dated before news already applied is ignored.

export interface AgreementApplyResult {
  outcome: "processed" | "ignored" | "rejected";
  detail?: string;
  paymentId?: string;
}

interface AgreementRow {
  id: string;
  org_id: string;
  subscription_id: string;
  provider_agreement_id: string | null;
  reference_number: string;
  status: AgreementStatus;
  livemode: boolean;
  amount_minor: string;
  currency: string;
  next_billing_at: Date | null;
  failed_payments: number;
  last_event_at: Date | null;
  hold: "refunded" | "disputed" | null;
}

const COLUMNS = "id, org_id, subscription_id, provider_agreement_id, reference_number, status, livemode, amount_minor, currency, next_billing_at, failed_payments, last_event_at, hold";
const REFERENCE = /^IAQ-[A-Z0-9]{8,40}$/;
const PLAN_LINK = "/maintenance";
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const later = (a: Date | null, b: Date | null): Date | null => (a && b ? (a.getTime() >= b.getTime() ? a : b) : a ?? b);

/**
 * The agreement a provider fact is about, locked. Found by the provider's id; or, for news that names our own reference but arrived before the provider's id was stored (the answer
 * to the request that opened the subscription had not been written yet), adopted by that reference: only an agreement with no provider id yet can be adopted, once.
 */
async function lockAgreement(db: Queryable, ref: { id: string; custom: string | null }): Promise<AgreementRow | undefined> {
  const found = (await db.query<AgreementRow>(`select ${COLUMNS} from maintenance_agreements where provider = 'paypal' and provider_agreement_id = $1 for update`, [ref.id])).rows[0];
  if (found) return found;
  if (!ref.custom || !REFERENCE.test(ref.custom)) return undefined;
  const open = (await db.query<AgreementRow>(`select ${COLUMNS} from maintenance_agreements where reference_number = $1 and provider_agreement_id is null for update`, [ref.custom])).rows[0];
  if (!open) return undefined;
  await db.query("update maintenance_agreements set provider_agreement_id = $2 where id = $1", [open.id, ref.id]);
  return { ...open, provider_agreement_id: ref.id };
}

async function agencyTimezone(db: Queryable): Promise<string> {
  return (await db.query<{ timezone: string }>("select timezone from organizations where kind = 'agency' limit 1")).rows[0]?.timezone ?? "UTC";
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** The provider's status for an agreement: moves it only as far as the rules in src/lib/maintenance-agreement.ts allow. */
export async function applyAgreementStatus(db: Queryable, event: NormalizedPaymentEvent): Promise<AgreementApplyResult> {
  const a = event.agreement;
  if (!a) return { outcome: "ignored", detail: "The event names no agreement." };
  const row = await lockAgreement(db, a);
  if (!row) return { outcome: "ignored", detail: "No automatic payment agreement matches this subscription." };
  if (row.livemode !== event.livemode) return { outcome: "rejected", detail: "Agreement mode mismatch." };
  const incoming = statusFromPaypal(a.status);
  if (!incoming) return { outcome: "ignored", detail: "The status is not one this product uses." };

  const when = event.occurredAt ? new Date(event.occurredAt) : null;
  const move = moveAgreement(row.status, incoming, { at: when, lastAt: row.last_event_at });
  await db.query("update maintenance_agreements set last_checked_at = now() where id = $1", [row.id]);

  if (move.ignored === "terminal" && row.status === "abandoned" && (incoming === "approved" || incoming === "active" || incoming === "suspended")) {
    // The buyer approved after the attempt was given up on: PayPal can now charge for something the product treats as ended. A person is told at once; the reconciliation job cancels it.
    await notifyAgency(db, row.org_id, {
      kind: "billing_reconciliation", severity: "critical", title: "A late approval: PayPal reports an abandoned automatic payment as live",
      body: `Agreement ${row.reference_number}: the buyer approved it after it was closed. PayPal may charge for it. The hourly check cancels it at PayPal; you can also cancel it in PayPal now. Any charge it makes is still recorded.`,
      link: `/admin/clients/${row.org_id}?tab=billing`, dedupeKey: `agreement-late:${row.id}`,
    });
    await recordAudit({ orgId: row.org_id, actorKind: "system", action: "maintenance.agreement_late_approval", targetType: "maintenance_agreement", targetId: row.id, result: "success", metadata: { providerStatus: incoming } }, db);
    return { outcome: "processed", detail: "A late approval was reported for a closed agreement; a person was told." };
  }
  if (!move.changed && move.ignored !== "same") return { outcome: "ignored", detail: `Not applied (${move.ignored}).` };

  const to = move.status;
  const stampedAt = later(row.last_event_at, when);
  await db.query(
    `update maintenance_agreements set status = $2, next_billing_at = $3, failed_payments = $4, last_event_at = $5,
       cancelled_at = case when $2 = 'cancelled' and cancelled_at is null then now() else cancelled_at end where id = $1`,
    [row.id, to, isTerminalAgreement(to) ? null : a.nextBillingAt ? new Date(a.nextBillingAt) : row.next_billing_at, a.failedPayments ?? row.failed_payments, stampedAt],
  );
  if (!move.changed) return { outcome: "processed", detail: "Dates refreshed; the status is unchanged." };

  await recordAudit({ orgId: row.org_id, actorKind: "system", action: "maintenance.agreement_status", targetType: "maintenance_agreement", targetId: row.id, result: "success", metadata: { from: row.status, to } }, db);
  if (to === "active") {
    await notifyOrgRoles(db, row.org_id, ["owner", "admin"], {
      kind: "maintenance_update", severity: "success", title: row.status === "suspended" ? "Automatic payments are on again" : "Automatic payments are on",
      body: "PayPal will charge the maintenance plan each month. A month counts as paid only when PayPal confirms the charge; until then the plan is exactly as paid as it was.",
      link: PLAN_LINK, dedupeKey: `agreement-active:${row.id}:${row.status}`,
    });
  } else if (to === "suspended") {
    await notifyOrgRoles(db, row.org_id, ["owner", "admin"], {
      kind: "maintenance_update", severity: "warning", title: "Automatic payments are paused",
      body: "PayPal paused the automatic payment for your maintenance plan. Update your payment method with PayPal, or pay for the plan online. Your CRM, AI employees and external automations are not affected.",
      link: PLAN_LINK, dedupeKey: `agreement-suspended:${row.id}`,
    });
    await notifyAgency(db, row.org_id, { kind: "billing_reconciliation", severity: "warning", title: "PayPal paused a client's automatic payment", body: `Agreement ${row.reference_number} is suspended${(a.failedPayments ?? row.failed_payments) ? ` after ${a.failedPayments ?? row.failed_payments} failed charge(s)` : ""}. The plan stays as it is until a payment is confirmed.`, link: `/admin/clients/${row.org_id}?tab=billing`, dedupeKey: `agreement-suspended:${row.id}` });
  } else if (to === "cancelled" || to === "expired") {
    await notifyOrgRoles(db, row.org_id, ["owner", "admin"], {
      kind: "maintenance_update", severity: "info", title: "Automatic payments have ended",
      body: "The PayPal agreement for your maintenance plan is no longer active. The plan itself is unchanged and stays paid through the day it was paid through; after that, each period is paid by hand or online.",
      link: PLAN_LINK, dedupeKey: `agreement-ended:${row.id}`,
    });
    await notifyAgency(db, row.org_id, { kind: "billing_reconciliation", severity: "info", title: "An automatic payment agreement ended", body: `Agreement ${row.reference_number} is ${to}. The plan is unchanged; further periods are paid by hand or online.`, link: `/admin/clients/${row.org_id}?tab=billing`, dedupeKey: `agreement-ended:${row.id}` });
  }
  return { outcome: "processed", detail: `Agreement is ${to.replace("_", " ")}.` };
}

// ---------------------------------------------------------------------------
// A failed charge
// ---------------------------------------------------------------------------

export async function applyAgreementPaymentFailed(db: Queryable, event: NormalizedPaymentEvent): Promise<AgreementApplyResult> {
  const a = event.agreement;
  if (!a) return { outcome: "ignored", detail: "The event names no agreement." };
  const row = await lockAgreement(db, a);
  if (!row) return { outcome: "ignored", detail: "No automatic payment agreement matches this subscription." };
  if (row.livemode !== event.livemode) return { outcome: "rejected", detail: "Agreement mode mismatch." };
  if (isTerminalAgreement(row.status)) return { outcome: "ignored", detail: "The agreement has ended." };

  const when = event.occurredAt ? new Date(event.occurredAt) : null;
  // A failure dated before something newer we already applied (a successful retry) is old news.
  if (when && row.last_event_at && when.getTime() < row.last_event_at.getTime()) return { outcome: "ignored", detail: "Not applied (stale)." };
  const failed = a.failedPayments ?? row.failed_payments + 1;
  await db.query("update maintenance_agreements set failed_payments = $2, last_event_at = $3, last_checked_at = now() where id = $1", [row.id, failed, later(row.last_event_at, when)]);

  const plan = (await db.query<{ id: string; org_id: string; status: string; paid_through_on: string | null }>(
    "select id, org_id, status, paid_through_on::text as paid_through_on from maintenance_subscriptions where id = $1 and org_id = $2 for update", [row.subscription_id, row.org_id],
  )).rows[0];
  const now = new Date();
  const today = todayIn(now, await agencyTimezone(db));
  const left = daysUntil(plan?.paid_through_on, today);
  // The grace period starts when the period the failed charge was meant to pay has ended. While the plan is still paid through a later day, nothing is taken from it.
  let graceEndsAt: Date | null = null;
  if (plan && (plan.status === "active" || plan.status === "cancel_requested") && left !== null && left < 0) {
    graceEndsAt = (await applyPaymentFailed(db, { subscription: plan, actor: { kind: "system", userId: null }, graceDays: env().STUDIO_PAYMENT_GRACE_DAYS, now, cause: "failed" })).graceEndsAt;
  }
  await recordAudit({
    orgId: row.org_id, actorKind: "system", action: "maintenance.agreement_charge_failed", targetType: "maintenance_agreement", targetId: row.id, result: "success",
    metadata: { failedPayments: failed, planStatus: plan?.status ?? null, pastDue: Boolean(graceEndsAt), ...(graceEndsAt ? { graceEndsAt: graceEndsAt.toISOString() } : {}) },
  }, db);
  if (!graceEndsAt) {
    const covered = left !== null && left >= 0;
    await notifyOrgRoles(db, row.org_id, ["owner", "admin"], {
      kind: "billing_payment_failed", severity: "warning", title: "PayPal could not collect your maintenance payment",
      body: covered
        ? `Your plan is paid through ${plan?.paid_through_on}, so nothing has changed. Update your payment method with PayPal, or pay for the plan online, before then. Your CRM, AI employees and external automations are not affected.`
        : "Update your payment method with PayPal, or pay for the plan online, to keep Automation Studio working. Your CRM, AI employees and external automations are not affected.",
      link: PLAN_LINK, dedupeKey: `agreement-failed:${row.id}:${failed}`,
    });
  }
  await notifyAgency(db, row.org_id, {
    kind: "billing_reconciliation", severity: "warning", title: "A client's automatic payment failed",
    body: `Agreement ${row.reference_number}: PayPal reports ${failed} failed charge${failed === 1 ? "" : "s"}. ${graceEndsAt ? `The plan is past due; Automation Studio keeps working until ${dayOf(graceEndsAt)}.` : "The plan is still paid through its current day, so nothing was changed."}`,
    link: `/admin/clients/${row.org_id}?tab=billing`, dedupeKey: `agreement-failed-agency:${row.id}:${failed}`,
  });
  return { outcome: "processed", detail: graceEndsAt ? "Failed charge recorded; the plan is past due." : "Failed charge recorded; the plan is still paid through its day." };
}

// ---------------------------------------------------------------------------
// A completed charge
// ---------------------------------------------------------------------------

export async function applyAgreementCharge(db: Queryable, event: NormalizedPaymentEvent): Promise<AgreementApplyResult> {
  const a = event.agreement;
  if (!a || event.paidPayments.length !== 1) return { outcome: "ignored", detail: "No single completed charge in the event." };
  const charge = event.paidPayments[0];
  const row = await lockAgreement(db, a);
  if (!row) {
    await notifyAgency(db, null, {
      kind: "billing_reconciliation", severity: "warning", title: "PayPal reported a charge for a subscription we have no record of",
      body: `Event ${event.type} names a subscription that is not one of our agreements, so nothing was recorded. Check it in PayPal.`,
      link: "/admin/billing?tab=rates", dedupeKey: `agreement-unmatched:${event.provider}:${charge.id}`,
    });
    return { outcome: "ignored", detail: "A charge was reported for a subscription we have no record of." };
  }
  const already = (await db.query(
    "select 1 from maintenance_agreement_charges where agreement_id = $1 and provider_charge_id = $2 union all select 1 from payments where provider = 'paypal' and provider_payment_id = $2", [row.id, charge.id],
  )).rows.length > 0;
  const recentCharge = (await db.query(
    "select 1 from maintenance_agreement_charges where agreement_id = $1 and outcome in ('applied', 'held') and created_at > now() - make_interval(days => $2::int) limit 1", [row.id, RECENT_CHARGE_DAYS],
  )).rows.length > 0;
  const verdict = chargeVerdict(
    { status: row.status, livemode: row.livemode, amountMinor: Number(row.amount_minor), currency: row.currency, hold: row.hold },
    { providerPaymentId: charge.id, amountMinor: charge.amountMinor, currency: charge.currency, livemode: event.livemode, alreadyRecorded: already, recentCharge },
  );
  if (verdict.action === "duplicate") return { outcome: "ignored", detail: "Already recorded." };
  if (verdict.action === "reject") return { outcome: "rejected", detail: verdict.reason };
  if (verdict.action === "mismatch") {
    await db.query(
      `insert into maintenance_agreement_charges (org_id, agreement_id, provider_charge_id, amount_minor, currency, outcome, detail) values ($1, $2, $3, $4, $5, 'mismatch', $6)
       on conflict (agreement_id, provider_charge_id) do nothing`,
      [row.org_id, row.id, charge.id, charge.amountMinor && charge.amountMinor > 0 ? charge.amountMinor : null, charge.currency, verdict.reason.slice(0, 300)],
    );
    await notifyAgency(db, row.org_id, {
      kind: "billing_reconciliation", severity: "critical", title: "A PayPal charge did not match its agreement",
      body: `Agreement ${row.reference_number}: ${verdict.reason} Nothing was applied to the plan. Review the charge in PayPal.`,
      link: `/admin/clients/${row.org_id}?tab=billing`, dedupeKey: `agreement-mismatch:${row.id}:${charge.id}`,
    });
    return { outcome: "rejected", detail: "Amount or currency mismatch." };
  }
  if (row.currency !== "USD") return { outcome: "rejected", detail: "The agreement is not in US dollars." };

  const minor = Number(charge.amountMinor);
  const payment = (await db.query<PaymentRow>(
    `insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, provider, livemode, reference_number, provider_payment_id, fee_minor,
       paid_at, maintenance_subscription_id, covers_months, maintenance_agreement_id)
     values ($1, 'maintenance', 'paid', $2, $3, 'USD', $4, 'paypal', $5, $6, $7, $8, now(), $9, 1, $10) returning *`,
    [row.org_id, "Managed Maintenance + Automation Studio (automatic monthly payment)", minor * 10_000, minor, row.livemode, newPaymentReference(), charge.id, charge.feeMinor, row.subscription_id, row.id],
  )).rows[0];

  const held = verdict.action === "record_held";
  const applied = held ? false : await applyMaintenancePeriod(db, payment);
  await db.query(
    `insert into maintenance_agreement_charges (org_id, agreement_id, payment_id, provider_charge_id, amount_minor, currency, outcome, detail, applied_at)
     values ($1, $2, $3, $4, $5, 'USD', $6, $7, $8)`,
    [row.org_id, row.id, payment.id, charge.id, minor, applied ? "applied" : "held", held ? verdict.reason.slice(0, 300) : applied ? null : "The plan could not take the payment.", applied ? new Date() : null],
  );
  const when = event.occurredAt ? new Date(event.occurredAt) : null;
  // A completed charge ends the run of failures: the next one starts counting again.
  await db.query("update maintenance_agreements set failed_payments = case when $2::boolean then 0 else failed_payments end, last_event_at = $3, last_checked_at = now() where id = $1", [row.id, applied, later(row.last_event_at, when)]);
  await recordAudit({
    orgId: row.org_id, actorKind: "system", action: "billing.payment_confirmed", targetType: "payment", targetId: payment.id, result: "success",
    metadata: { kind: "maintenance", reference: payment.reference_number, provider: "paypal", agreement: row.reference_number, applied, ...(held ? { held: true } : {}) },
  }, db);
  if (applied) {
    await notifyOrgRoles(db, row.org_id, ["owner", "admin"], { kind: "billing_payment_received", severity: "success", title: "Payment received", body: `Reference ${payment.reference_number}.`, link: "/settings/billing", dedupeKey: `payment:${payment.id}` });
    return { outcome: "processed", paymentId: payment.id };
  }
  await notifyAgency(db, row.org_id, {
    kind: "billing_reconciliation", severity: "critical", title: held ? "A charge arrived on a held automatic payment" : "A charge arrived that the plan could not take",
    body: `Reference ${payment.reference_number}. ${held ? verdict.reason : "The plan refused it."} The money is recorded, the plan was NOT extended. ${held ? "Release the hold once the refund or dispute is dealt with, and it is applied." : "Record the period by hand, or refund the payment."}`,
    link: `/admin/clients/${row.org_id}?tab=billing`, dedupeKey: `agreement-held:${payment.id}`,
  });
  if (held) {
    await notifyOrgRoles(db, row.org_id, ["owner", "admin"], { kind: "billing_payment_received", severity: "info", title: "Payment received and being reviewed", body: `Reference ${payment.reference_number}. iAcquire is reviewing an earlier payment on this plan before the new period is added.`, link: "/settings/billing", dedupeKey: `payment:${payment.id}` });
  }
  return { outcome: "processed", detail: held ? "Recorded and held; the plan was not extended." : "Recorded; the plan could not take it.", paymentId: payment.id };
}

// ---------------------------------------------------------------------------
// A refund or a dispute on one of its charges
// ---------------------------------------------------------------------------

/** Holds the agreement a reported refund or dispute belongs to. A dispute is never downgraded to a refund. The notice itself only reports; this only stops new periods being added unseen. */
export async function holdAgreementAfterNotice(db: Queryable, agreementId: string, kind: "refunded" | "disputed", info: { paymentId: string; reference: string }): Promise<void> {
  const row = (await db.query<{ id: string; org_id: string; hold: "refunded" | "disputed" | null; reference_number: string }>("select id, org_id, hold, reference_number from maintenance_agreements where id = $1 for update", [agreementId])).rows[0];
  if (!row) return;
  const next = row.hold === "disputed" ? "disputed" : kind;
  await db.query("update maintenance_agreements set hold = $2, hold_since = coalesce(hold_since, now()), hold_released_at = null, hold_released_by = null, hold_release_note = null where id = $1", [row.id, next]);
  if (row.hold === next) return;
  await recordAudit({ orgId: row.org_id, actorKind: "system", action: "maintenance.agreement_held", targetType: "maintenance_agreement", targetId: row.id, result: "success", metadata: { hold: next, paymentId: info.paymentId, reference: info.reference } }, db);
  await notifyAgency(db, row.org_id, {
    kind: "billing_reconciliation", severity: "critical", title: "An automatic payment is on hold",
    body: `Agreement ${row.reference_number}: a ${next === "disputed" ? "dispute" : "refund"} was reported on ${info.reference}. New charges are recorded but not added to the plan until you release the hold. Nothing already paid was taken away.`,
    link: `/admin/clients/${row.org_id}?tab=billing`, dedupeKey: `agreement-hold:${row.id}:${next}`,
  });
}

/**
 * A person at iAcquire releases a hold, saying why. Held charges are then applied in the order they arrived, through the same transition as any payment. Nothing else is touched.
 * Returns how many charges were applied and how many the plan still could not take.
 */
export async function releaseHold(db: Queryable, input: { agreementId: string; actorUserId: string; note: string }): Promise<{ applied: number; refused: number }> {
  const note = input.note.trim();
  if (note.length < 5) throw new AppError("invalid_input", "Record why the hold is being released.");
  const row = (await db.query<{ id: string; org_id: string; hold: string | null }>("select id, org_id, hold from maintenance_agreements where id = $1 for update", [input.agreementId])).rows[0];
  if (!row) throw new AppError("not_found", "That agreement was not found.");
  const heldCharges = (await db.query<{ id: string; payment_id: string }>("select id, payment_id from maintenance_agreement_charges where agreement_id = $1 and outcome = 'held' order by created_at, id for update", [row.id])).rows;
  if (!row.hold && heldCharges.length === 0) throw new AppError("conflict", "There is nothing to release.");
  if (row.hold) {
    await db.query("update maintenance_agreements set hold = null, hold_since = null, hold_released_by = $2, hold_released_at = now(), hold_release_note = $3 where id = $1", [row.id, input.actorUserId, note.slice(0, 500)]);
  }
  let applied = 0;
  let refused = 0;
  for (const c of heldCharges) {
    const payment = (await db.query<PaymentRow>("select * from payments where id = $1 and org_id = $2 for update", [c.payment_id, row.org_id])).rows[0];
    if (payment && (await applyMaintenancePeriod(db, payment))) {
      await db.query("update maintenance_agreement_charges set outcome = 'applied', applied_at = now(), released_by = $2, detail = null where id = $1", [c.id, input.actorUserId]);
      applied += 1;
    } else {
      refused += 1;
    }
  }
  await recordAudit({ orgId: row.org_id, actorUserId: input.actorUserId, actorKind: "agency", action: "maintenance.agreement_hold_released", targetType: "maintenance_agreement", targetId: row.id, result: "success", metadata: { applied, refused, note: note.slice(0, 200) } }, db);
  return { applied, refused };
}
