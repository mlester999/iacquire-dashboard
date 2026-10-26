// Journey 8: the optional monthly maintenance plan, bought and run through PayPal subscriptions, across the maintenance, billing, agreement and Automation Studio
// entitlement services.
//
// The owner opens automatic payments for the US$299/month plan. PayPal's completed charge is the only thing that pays a period, and it extends the paid-through day.
// A renewal PayPal reports as failed starts the grace window, in which the workspace keeps working. A refund reported on the charge puts automatic payments on hold
// without taking anything away or breaking the workspace; a person releases the hold, and a charge that arrived while held is applied then. Finally the owner cancels
// the plan and the subscription is stopped at PayPal first.
//
// One external boundary is simulated and only here:
//   * PayPal, and only PayPal: tests/support/paypal-subscriptions.ts (with tests/support/paypal-agency.ts) is an HTTP stand-in for OAuth, the billing plan, opening,
//     reading and cancelling a subscription, listing its transactions, and webhook verification. src/server/billing/providers/paypal-subscriptions.ts is given that
//     stand-in as its wire, so no socket is opened and no PayPal account exists. The bodies are written from PayPal's public documentation and were never compared
//     with the real service: a green run proves this product's handling of those shapes, not PayPal's behaviour.
// No email or payment provider is contacted: notices are rows in the product's own notification table.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.PAYPAL_CLIENT_ID = "AaTestClientIdNotReal0123456789";
process.env.PAYPAL_CLIENT_SECRET = "EkTestSecretNotReal0123456789abc";
process.env.PAYPAL_WEBHOOK_ID = "WH-TEST-0123456789";
process.env.PAYPAL_ENVIRONMENT = "sandbox";
process.env.PAYPAL_MAINTENANCE_PLAN_ID = "P-5ML4271244454362WXNWU5NQ";

import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { handleProviderWebhook } from "@/server/billing/payments";
import { createPaypalAdapter } from "@/server/billing/providers/paypal";
import { completeAgreementReturn, releaseAgreementHold, startMaintenanceAgreement } from "@/server/maintenance/agreement-service";
import { requestMaintenanceCancellation } from "@/server/maintenance/service";
import { sweepStudioEntitlements } from "@/server/automation-studio/lifecycle";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { addDays, nextPaidThrough } from "@/lib/billing-renewal";
import { todayIn } from "@/lib/invoices/state";
import { agencyUser, createUser, ctxFor, uid } from "../support/fixtures";
import { crmOrg } from "../support/crm";
import { clearSetupPayment, markActivated } from "../support/billing";
import { DAY, auditOf, coreWorkflowFor, noticesOf, planRow, setAgencyTimezone, studioWorkflowFor, workflowRow } from "../support/billing-plan";
import { paypalHeaders } from "../support/paypal-agency";
import { fakePaypalSubscriptions, saleCompletedEvent, saleRefundedEvent, subscriptionEvent, type FakePaypalSubscriptions } from "../support/paypal-subscriptions";

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const today = () => todayIn(new Date(), "UTC");
const plus = (n: number) => addDays(today(), n) as string;

let pp: FakePaypalSubscriptions;
let adapter: ReturnType<typeof createPaypalAdapter>;
let superAdmin: ReturnType<typeof agencyUser>;
const deps = () => ({ paypal: { http: pp.http } });

/** Turns automatic payments on the way a Super Admin does, with the live-payment review recorded. */
const enableRecurring = () => withSystem((db) => db.query(
  "update agency_billing_settings set recurring_billing_enabled = true, live_payments_review_at = now(), usd_php_rate = 58, fx_source = 'test fixture', fx_updated_at = now(), auto_past_due = false",
));

beforeAll(async () => {
  resetEnvCache();
  await setAgencyTimezone("UTC");
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
});

beforeEach(async () => {
  // Plans and agreements of earlier cases belong to earlier PayPal stand-ins: end them so one case cannot read another's.
  await withSystem(async (db) => {
    await db.query("update maintenance_agreements set status = 'cancelled', cancelled_at = now() where status in ('approval_pending', 'approved', 'active', 'suspended', 'abandoned')");
    await db.query("update maintenance_subscriptions set status = 'cancelled', cancelled_at = now() where status in ('requested', 'active', 'past_due', 'cancel_requested')");
  });
  await enableRecurring();
  pp = fakePaypalSubscriptions();
  adapter = createPaypalAdapter({ wire: pp.wire });
});

/** A client whose core system is activated and setup fee cleared, with a plan in the given state. */
async function client(status: "active" | "requested" | "past_due" | "expired", paidThroughDelta: number | null) {
  const o = await crmOrg();
  await markActivated(o.org.id);
  await clearSetupPayment(o.org.id);
  const plan = await planRow(o, { status, paidThroughOn: paidThroughDelta === null ? null : plus(paidThroughDelta) });
  return { o, plan, org: o.org, ctx: ctxFor(o.people.owner, o.org, "owner") };
}
type Client = Awaited<ReturnType<typeof client>>;

/** PayPal's signed notice, delivered to the real provider webhook handler. */
const deliver = (body: string) => handleProviderWebhook(adapter, { rawBody: body, headers: paypalHeaders() });
const planFacts = async (plan: string) => (await rows<{ status: string; paid_through_on: string | null; past_due_since: Date | null; grace_ends_at: Date | null }>(
  "select status, paid_through_on::text, past_due_since, grace_ends_at from maintenance_subscriptions where id = $1", [plan],
))[0];
const agreementOf = async (plan: string) => (await rows<{ id: string; status: string; hold: string | null; failed_payments: number; provider_agreement_id: string | null; reference_number: string }>(
  "select id, status, hold, failed_payments, provider_agreement_id, reference_number from maintenance_agreements where subscription_id = $1 order by created_at desc limit 1", [plan],
))[0];

/** Opens the agreement and has the buyer approve it on the stand-in's page, then returns through the product's own return step. Nothing is paid yet. */
async function live(c: Client) {
  const started = await startMaintenanceAgreement(c.ctx, deps());
  const sub = pp.byReference(started.reference);
  if (!sub) throw new Error("the stand-in has no subscription for the reference");
  pp.approve(sub.id);
  await completeAgreementReturn(c.ctx, started.reference, deps());
  return { ...started, sub, agreementId: sub.id };
}

describe("the optional maintenance plan runs on PayPal subscriptions", () => {
  it("extends the paid-through day on a verified charge, keeps the workspace working through a failed renewal and a refund hold, and cancels at PayPal first", async () => {
    // 1. A client on an active plan, paid through in ten days, with one Automation Studio workflow and one core CRM workflow switched on. The premium workflow only
    // exists because the plan entitles it; the core one is never touched by the plan.
    const c = await client("active", 10);
    const studio = await studioWorkflowFor(c.o);
    const core = await coreWorkflowFor(c.o);
    expect(await withSystem((db) => studioEntitlement(db, c.org.id, new Date()))).toMatchObject({ entitled: true });

    // 2. The owner turns automatic payments on. The agreement grants nothing by itself: after the buyer approves it and the return step reads PayPal's own record,
    // the agreement is active and the plan is exactly where it was. Only a completed charge moves it.
    const l = await live(c);
    expect(await agreementOf(c.plan)).toMatchObject({ status: "active", hold: null, provider_agreement_id: l.sub.id });
    expect(await planFacts(c.plan)).toMatchObject({ status: "active", paid_through_on: plus(10) });

    // 3. PayPal collects the first period and reports the completed sale. This is the only fact that pays a period, and it goes through the same transition a
    // payment recorded by hand uses. The plan is extended from the day it was already paid through, keeping those days.
    const firstSale = `SALE-${uid()}`;
    expect(await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: firstSale }))).toMatchObject({ outcome: "processed" });
    const renewed = await planFacts(c.plan);
    expect(renewed.status).toBe("active");
    expect(renewed.paid_through_on).toBe(nextPaidThrough({ status: "active", paidThroughOn: plus(10), today: today(), months: 1 }));
    expect(new Date(renewed.paid_through_on as string).getTime()).toBeGreaterThan(new Date(plus(10)).getTime());
    const [payment] = await rows<{ status: string; provider: string; provider_payment_id: string; covers_months: number; livemode: boolean }>(
      "select status, provider, provider_payment_id, covers_months, livemode from payments where maintenance_subscription_id = $1 order by created_at", [c.plan],
    );
    expect(payment).toMatchObject({ status: "paid", provider: "paypal", provider_payment_id: firstSale, covers_months: 1 });
    expect((await auditOf(c.org.id, "maintenance.payment_verified"))[0]).toMatchObject({ actor_kind: "system" });

    // 4. The next period's charge fails. The paid period has ended (the database is nudged to the day before, standing in for time passing), so the plan goes past
    // due with a seven-day grace window. The right entitlements during that window: Automation Studio is still entitled and its workflow still runs, and the core
    // workflow is untouched. A second failure neither restarts nor extends the window.
    await withSystem((db) => db.query("update maintenance_subscriptions set paid_through_on = $2 where id = $1", [c.plan, plus(-1)]));
    pp.failPayment(l.sub.id);
    const failed = subscriptionEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: l.sub.id, status: "ACTIVE", custom_id: l.reference, failedPayments: 1 }, { id: `WH-FAIL-${uid()}` });
    expect(await deliver(failed)).toMatchObject({ outcome: "processed" });
    const grace = await planFacts(c.plan);
    expect(grace.status).toBe("past_due");
    expect(new Date(grace.grace_ends_at as Date).getTime() - new Date(grace.past_due_since as Date).getTime()).toBe(7 * DAY);
    expect(await withSystem((db) => studioEntitlement(db, c.org.id, new Date()))).toMatchObject({ entitled: true, state: "past_due" });
    expect(await workflowRow(studio)).toMatchObject({ status: "active", entitlement_paused_at: null });
    expect(await workflowRow(core)).toMatchObject({ status: "active" });
    expect((await noticesOf(c.org.id, "maintenance_update", "client")).some((n) => n.title === "A payment for your maintenance plan didn't go through")).toBe(true);
    await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: l.sub.id, status: "ACTIVE", failedPayments: 2, createTime: new Date(Date.now() + 2000).toISOString() }));
    expect((await planFacts(c.plan)).grace_ends_at).toEqual(grace.grace_ends_at);

    // 5. PayPal reports a refund on the charge it had collected. Nothing already paid is taken away: the plan's facts are exactly as they were. Automatic payments
    // are put on hold for a person to review, and the team is told in PayPal's name. The workspace itself keeps working: the studio workflow is not paused (this is
    // not a lapse) and the core one is untouched.
    await deliver(saleRefundedEvent({ saleId: firstSale }));
    expect(await planFacts(c.plan)).toEqual(grace);
    expect(await agreementOf(c.plan)).toMatchObject({ hold: "refunded" });
    expect((await noticesOf(c.org.id, "billing_reconciliation", "agency")).some((n) => n.severity === "critical" && n.title === "An automatic payment is on hold")).toBe(true);
    expect(await workflowRow(studio)).toMatchObject({ status: "active" });
    expect(await workflowRow(core)).toMatchObject({ status: "active" });

    // 6. A month later PayPal collects the next period. While the agreement is held the money is recorded but not added to the plan, and the owner is told it is
    // being reviewed. (The earlier charge is moved out of the recent-charge window, as that month passing would.)
    const agreementId = (await agreementOf(c.plan)).id;
    await withSystem((db) => db.query("update maintenance_agreement_charges set created_at = created_at - interval '30 days' where agreement_id = $1", [agreementId]));
    const heldSale = `SALE-${uid()}`;
    expect(await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: heldSale }))).toMatchObject({ outcome: "processed" });
    expect(await planFacts(c.plan)).toEqual(grace);
    expect((await noticesOf(c.org.id, "billing_payment_received", "client")).some((n) => /being reviewed/.test(n.title))).toBe(true);

    // 7. A person at iAcquire releases the hold with a reason. The held charge is applied through the usual transition: the plan comes back to active and the
    // period is added. Nothing was destroyed while it waited.
    expect(await releaseAgreementHold(superAdmin, (await agreementOf(c.plan)).id, "Refund was a goodwill gesture; the plan stands")).toEqual({ applied: 1, refused: 0 });
    expect(await agreementOf(c.plan)).toMatchObject({ hold: null });
    const back = await planFacts(c.plan);
    expect(back).toMatchObject({ status: "active", past_due_since: null, grace_ends_at: null });
    expect(back.paid_through_on).toBe(nextPaidThrough({ status: "past_due", paidThroughOn: plus(-1), today: today(), months: 1 }));
    expect((await auditOf(c.org.id, "maintenance.agreement_hold_released"))[0]).toMatchObject({ actor_kind: "agency" });

    // 8. The owner cancels the plan. The subscription is cancelled at PayPal first and only then recorded as cancelled here, and the days already paid for are kept.
    // The workspace is still there, with its core workflow, exactly as before.
    await requestMaintenanceCancellation(c.ctx, "Closing the business at the end of the month", deps());
    expect(pp.subscriptions.get(l.sub.id)?.status).toBe("CANCELLED");
    expect(await agreementOf(c.plan)).toMatchObject({ status: "cancelled" });
    expect(await planFacts(c.plan)).toMatchObject({ status: "cancel_requested", paid_through_on: back.paid_through_on });
    expect(await workflowRow(core)).toMatchObject({ status: "active" });
    expect((await rows<{ status: string }>("select status from organizations where id = $1", [c.org.id]))[0].status).toBe("active");
    expect((await noticesOf(c.org.id, "maintenance_update", "agency")).some((n) => /requested to cancel managed maintenance/.test(n.title))).toBe(true);
  });

  it("ends the grace window by pausing only the premium workflows, leaving the core workflow and the workspace alone", async () => {
    // The other end of a failed renewal: when the grace window runs out, the plan expires and ONLY workflows built in Automation Studio are paused. The core CRM
    // workflow, the CRM itself, the AI employees and the inbox are not selected, and nothing is deleted. A verified charge afterwards brings the plan back, but the
    // paused workflow waits for a person to switch it on again.
    const c = await client("active", 20);
    const studio = await studioWorkflowFor(c.o);
    const core = await coreWorkflowFor(c.o);
    const l = await live(c);
    await withSystem((db) => db.query("update maintenance_subscriptions set paid_through_on = $2 where id = $1", [c.plan, plus(-1)]));
    pp.failPayment(l.sub.id);
    await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: l.sub.id, status: "ACTIVE", custom_id: l.reference, failedPayments: 1 }));

    await sweepStudioEntitlements(new Date(Date.now() + 8 * DAY));
    expect((await planFacts(c.plan)).status).toBe("expired");
    expect(await workflowRow(studio)).toMatchObject({ status: "paused" });
    expect((await workflowRow(studio)).entitlement_paused_at).not.toBeNull();
    expect(await workflowRow(core)).toMatchObject({ status: "active", entitlement_paused_at: null });
    expect((await rows<{ status: string }>("select status from organizations where id = $1", [c.org.id]))[0].status).toBe("active");

    // PayPal reports a completed charge for the next period. The plan comes back and the money is applied, but the paused workflow is not switched back on by the
    // plan: a person turns each one on.
    expect(await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: `SALE-${uid()}` }))).toMatchObject({ outcome: "processed" });
    expect(await planFacts(c.plan)).toMatchObject({ status: "active", past_due_since: null, grace_ends_at: null });
    expect(await workflowRow(studio)).toMatchObject({ status: "paused" });
    expect((await noticesOf(c.org.id, "maintenance_update", "client")).some((n) => n.title === "Your maintenance plan is active again")).toBe(true);
  });
});
