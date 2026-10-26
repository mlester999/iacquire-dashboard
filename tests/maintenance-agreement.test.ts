// The optional automatic monthly payment for the US$299 maintenance plan (a PayPal subscription), on embedded Postgres. An agreement only asks PayPal to collect; a period is paid ONLY
// when PayPal reports a COMPLETED charge for it, and that charge goes through the same transition a payment recorded by hand uses. Failed renewals walk the plan through past due and
// grace to the premium pause (the core system, the CRM and the AI employees are never touched), a verified charge brings it back, and a refund or a dispute never re-enables or revokes
// anything by itself: it holds the agreement for a person. PayPal is a stand-in written from the documentation (tests/support/paypal-subscriptions.ts): nothing here reaches PayPal.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYPAL_CLIENT_ID = "AaTestClientIdNotReal0123456789";
process.env.PAYPAL_CLIENT_SECRET = "EkTestSecretNotReal0123456789abc";
process.env.PAYPAL_WEBHOOK_ID = "WH-TEST-0123456789";
process.env.PAYPAL_ENVIRONMENT = "sandbox";
process.env.PAYPAL_MAINTENANCE_PLAN_ID = "P-5ML4271244454362WXNWU5NQ";

import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { handleProviderWebhook, recordAndApply } from "@/server/billing/payments";
import { createPaypalAdapter } from "@/server/billing/providers/paypal";
import { requestMaintenanceCancellation } from "@/server/maintenance/service";
import {
  agreementForPlan, cancelAgreementAsAgency, cancelAgreementAsOwner, completeAgreementReturn, recurringAvailability, releaseAgreementHold, runAgreementReconcile, setRecurringBillingEnabled,
  startMaintenanceAgreement,
} from "@/server/maintenance/agreement-service";
import { runMaintenanceRenewalSweep } from "@/server/maintenance/renewal";
import { sweepStudioEntitlements } from "@/server/automation-studio/lifecycle";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { nextPaidThrough, addDays } from "@/lib/billing-renewal";
import { todayIn } from "@/lib/invoices/state";
import { agencyUser, addMember, createUser, ctxFor, uid } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { clearSetupPayment, markActivated } from "./support/billing";
import { DAY, auditOf, coreWorkflowFor, noticesOf, planRow, setAgencyTimezone, studioWorkflowFor, workflowRow } from "./support/billing-plan";
import { paypalHeaders, captureCompletedEvent } from "./support/paypal-agency";
import { fakePaypalSubscriptions, saleCompletedEvent, saleRefundedEvent, saleReversedEvent, subscriptionEvent, TEST_PLAN_ID, type FakePaypalSubscriptions } from "./support/paypal-subscriptions";

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const today = () => todayIn(new Date(), "UTC");
const plus = (n: number) => addDays(today(), n) as string;

let pp: FakePaypalSubscriptions;
let adapter: ReturnType<typeof createPaypalAdapter>;
let superAdmin: ReturnType<typeof agencyUser>;
const deps = () => ({ paypal: { http: pp.http } });

async function setSwitch(on: boolean) {
  await withSystem((db) => db.query("update agency_billing_settings set recurring_billing_enabled = $1, live_payments_review_at = now(), purchase_checkout_enabled = true, usd_php_rate = 58, fx_source = 'test', fx_updated_at = now()", [on]));
}

beforeAll(async () => {
  resetEnvCache();
  await setAgencyTimezone("UTC");
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
});

beforeEach(async () => {
  // Agreements and plans of earlier cases belong to earlier PayPal stand-ins.
  await withSystem(async (db) => {
    await db.query("update maintenance_agreements set status = 'cancelled', cancelled_at = now() where status in ('approval_pending', 'approved', 'active', 'suspended')");
    await db.query("update maintenance_agreements set status = 'cancelled', cancelled_at = now() where status = 'abandoned'");
    await db.query("update maintenance_subscriptions set status = 'cancelled', cancelled_at = now() where status in ('requested', 'active', 'past_due', 'cancel_requested')");
    await db.query("update agency_billing_settings set auto_past_due = false");
  });
  await setSwitch(true);
  pp = fakePaypalSubscriptions();
  adapter = createPaypalAdapter({ wire: pp.wire });
});

/** A client whose core system is activated and setup fee cleared, with a plan in the given state. */
type PlanStatus = NonNullable<NonNullable<Parameters<typeof planRow>[1]>["status"]>;
async function client(status: PlanStatus, paidThroughDelta: number | null = null) {
  const o = await crmOrg();
  await markActivated(o.org.id);
  await clearSetupPayment(o.org.id);
  const plan = await planRow(o, { status, paidThroughOn: paidThroughDelta === null ? null : plus(paidThroughDelta) });
  return { o, plan, org: o.org, ctx: ctxFor(o.people.owner, o.org, "owner") };
}
type Client = Awaited<ReturnType<typeof client>>;

const deliver = (body: string) => handleProviderWebhook(adapter, { rawBody: body, headers: paypalHeaders() });
const facts = async (plan: string) => (await rows<{ status: string; paid_through_on: string | null; billing_start_on: string | null; past_due_since: Date | null; grace_ends_at: Date | null; last_payment_id: string | null }>(
  "select status, paid_through_on::text, billing_start_on::text, past_due_since, grace_ends_at, last_payment_id from maintenance_subscriptions where id = $1", [plan]))[0];
const agreement = async (plan: string) => (await rows<{ id: string; status: string; hold: string | null; failed_payments: number; provider_agreement_id: string | null; reference_number: string; next_billing_at: Date | null }>(
  "select id, status, hold, failed_payments, provider_agreement_id, reference_number, next_billing_at from maintenance_agreements where subscription_id = $1 order by created_at desc limit 1", [plan]))[0];
const charges = (agreementId: string) => rows<{ provider_charge_id: string; outcome: string; payment_id: string | null; detail: string | null }>(
  "select provider_charge_id, outcome, payment_id, detail from maintenance_agreement_charges where agreement_id = $1 order by created_at, id", [agreementId]);
const paymentsOf = (plan: string) => rows<{ id: string; status: string; provider: string; provider_payment_id: string | null; covers_months: number; charged_currency: string; charged_amount_minor: string; usd_amount_micros: string; maintenance_agreement_id: string | null; livemode: boolean }>(
  "select id, status, provider, provider_payment_id, covers_months, charged_currency, charged_amount_minor, usd_amount_micros, maintenance_agreement_id, livemode from payments where maintenance_subscription_id = $1 order by created_at, id", [plan]);

/** Opens an agreement and has the buyer approve it on the stand-in's page, then returns through the product's own return step. Nothing is paid yet. */
async function live(c: Client) {
  const started = await startMaintenanceAgreement(c.ctx, deps());
  const sub = pp.byReference(started.reference)!;
  pp.approve(sub.id);
  await completeAgreementReturn(c.ctx, started.reference, deps());
  return { ...started, sub, agreementId: sub.id };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Whether it can be offered at all
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("automatic payments are offered only when they can be taken and confirmed", () => {
  it("is off until a Super Admin switches it on, and a closed switch never reaches PayPal", async () => {
    await setSwitch(false);
    const c = await client("active", 10);
    const a = await withSystem((db) => recurringAvailability(db));
    expect(a).toMatchObject({ enabled: false, available: false });
    expect(a.reason).toMatch(/switched off/);
    await expect(startMaintenanceAgreement(c.ctx, deps())).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(pp.calls).toHaveLength(0);
    expect(await rows("select 1 from maintenance_agreements where subscription_id = $1", [c.plan])).toHaveLength(0);
  });

  it("only a Super Admin can switch it, the switch is audited, and closing it leaves an open agreement alone", async () => {
    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    await expect(setRecurringBillingEnabled(staff, true)).rejects.toMatchObject({ code: "forbidden" });
    await setSwitch(false);
    expect((await setRecurringBillingEnabled(superAdmin, true)).enabled).toBe(true);
    const audit = await rows<{ action: string }>("select action from audit_logs where action in ('recurring_billing.enabled', 'recurring_billing.disabled') order by created_at desc limit 1");
    expect(audit[0]?.action).toBe("recurring_billing.enabled");
    const c = await client("active", 10);
    const started = await live(c);
    expect((await setRecurringBillingEnabled(superAdmin, false)).enabled).toBe(false);
    expect((await agreement(c.plan)).status).toBe("active");
    expect(started.sub.status).toBe("ACTIVE");
  });

  it("is not offered without the PayPal billing plan id or while PayPal is not connected", async () => {
    const was = process.env.PAYPAL_MAINTENANCE_PLAN_ID;
    delete process.env.PAYPAL_MAINTENANCE_PLAN_ID;
    resetEnvCache();
    try {
      const a = await withSystem((db) => recurringAvailability(db));
      expect(a.available).toBe(false);
      expect(a.reason).toMatch(/PAYPAL_MAINTENANCE_PLAN_ID/);
    } finally {
      process.env.PAYPAL_MAINTENANCE_PLAN_ID = was;
      resetEnvCache();
    }
    const wasId = process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_ID;
    resetEnvCache();
    try {
      expect((await withSystem((db) => recurringAvailability(db))).available).toBe(false);
      expect(await runAgreementReconcile({ deps: deps() })).toMatchObject({ checked: 0, skipped: "PayPal is not connected." });
    } finally {
      process.env.PAYPAL_CLIENT_ID = wasId;
      resetEnvCache();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Opening an agreement
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("opening an agreement", () => {
  it("asks PayPal for the plan's own price on PayPal's own plan, defers the first charge past the day already paid, and changes nothing about the plan", async () => {
    const c = await client("active", 10);
    const started = await startMaintenanceAgreement(c.ctx, deps());
    expect(started).toMatchObject({ resumed: false });
    expect(new URL(started.approvalUrl).hostname).toMatch(/(^|\.)paypal\.com$/);
    const create = pp.calls.find((x) => x.path === "/v1/billing/subscriptions" && x.method === "POST")!;
    const body = create.body as { plan_id: string; custom_id: string; start_time?: string; application_context: Record<string, unknown> };
    expect(body).toMatchObject({ plan_id: TEST_PLAN_ID, custom_id: started.reference });
    expect(body.start_time).toBe(`${plus(11)}T00:00:00Z`);
    expect(body.application_context.return_url).toContain(`/maintenance?agreement=${started.reference}&return=success`);
    expect(body.application_context.cancel_url).toContain(`return=cancelled`);
    expect(JSON.stringify(create.body)).not.toMatch(/amount|price|299/); // the price is PayPal's plan's, proved equal first; the request carries none
    const row = await agreement(c.plan);
    expect(row).toMatchObject({ status: "approval_pending", hold: null, failed_payments: 0 });
    expect(row.provider_agreement_id).toBe(pp.byReference(started.reference)?.id);
    expect(await rows("select 1 from payments where maintenance_subscription_id = $1", [c.plan])).toHaveLength(0);
    expect(await facts(c.plan)).toMatchObject({ status: "active", paid_through_on: plus(10) });
    expect(await auditOf(c.org.id, "maintenance.agreement_started")).toHaveLength(1);
  });

  it("starts the first charge at approval when the plan is not paid beyond today", async () => {
    const c = await client("past_due", -3);
    await startMaintenanceAgreement(c.ctx, deps());
    const create = pp.calls.find((x) => x.path === "/v1/billing/subscriptions" && x.method === "POST")!;
    expect((create.body as { start_time?: string }).start_time).toBeUndefined();
  });

  it("returns the approval that is already waiting instead of opening a second subscription", async () => {
    const c = await client("active", 10);
    const first = await startMaintenanceAgreement(c.ctx, deps());
    const again = await startMaintenanceAgreement(c.ctx, deps());
    expect(again).toMatchObject({ resumed: true, approvalUrl: first.approvalUrl, reference: first.reference });
    expect(pp.subscriptions.size).toBe(1);
    expect(await rows("select 1 from maintenance_agreements where subscription_id = $1", [c.plan])).toHaveLength(1);
  });

  it("refuses a PayPal plan that is not the plan we priced, whichever way it differs, and tells the team", async () => {
    const c = await client("active", 10);
    for (const over of [{ value: "399.00" }, { value: "29.90" }, { currency: "EUR" }, { interval: "YEAR" }, { status: "INACTIVE" }, { trial: true }, { cycles: 12 }, { setup: "50.00" }] as const) {
      pp.state.plan = { ...over };
      await expect(startMaintenanceAgreement(c.ctx, deps()), JSON.stringify(over)).rejects.toMatchObject({ code: "integration_unavailable" });
    }
    pp.state.plan = {};
    expect(pp.calls.filter((x) => x.path === "/v1/billing/subscriptions" && x.method === "POST")).toHaveLength(0);
    expect(await rows("select 1 from maintenance_agreements where subscription_id = $1", [c.plan])).toHaveLength(0);
    const told = await rows<{ title: string; body: string }>("select title, body from notifications where kind = 'billing_reconciliation' and title like 'Automatic payments are blocked%'");
    expect(told.length).toBeGreaterThan(0);
    // A missing plan is refused the same way.
    pp.state.planMissing = true;
    await expect(startMaintenanceAgreement(c.ctx, deps())).rejects.toMatchObject({ code: "integration_unavailable" });
  });

  it("closes the attempt and charges nobody when PayPal cannot be reached", async () => {
    const c = await client("active", 10);
    pp.state.down = true;
    await expect(startMaintenanceAgreement(c.ctx, deps())).rejects.toMatchObject({ code: "integration_unavailable" });
    pp.state.down = false;
    expect(await rows("select 1 from maintenance_agreements where subscription_id = $1 and status in ('approval_pending', 'approved', 'active')", [c.plan])).toHaveLength(0);
    // Trying again later works.
    expect((await startMaintenanceAgreement(c.ctx, deps())).resumed).toBe(false);
  });

  it("belongs to the owner: a viewer cannot open one, another workspace cannot return for it, and a plan that cannot take a payment cannot have one", async () => {
    const c = await client("active", 10);
    const viewer = await createUser();
    await addMember(c.org.id, viewer.id, "viewer");
    await expect(startMaintenanceAgreement(ctxFor(viewer, c.org, "viewer"), deps())).rejects.toMatchObject({ code: "forbidden" });
    const started = await startMaintenanceAgreement(c.ctx, deps());
    const other = await client("active", 10);
    expect(await completeAgreementReturn(other.ctx, started.reference, deps())).toBeNull();
    expect(await completeAgreementReturn(c.ctx, "not-a-reference", deps())).toBeNull();
    const gone = await client("cancelled");
    await expect(startMaintenanceAgreement(gone.ctx, deps())).rejects.toMatchObject({ code: "not_found" });
    const leaving = await client("cancel_requested", 10);
    await expect(startMaintenanceAgreement(leaving.ctx, deps())).rejects.toMatchObject({ code: "conflict" });
  });

  it("will not open one for a plan that has not started until its core system is activated and its setup fee confirmed", async () => {
    const o = await crmOrg();
    await planRow(o, { status: "requested" });
    await expect(startMaintenanceAgreement(ctxFor(o.people.owner, o.org, "owner"), deps())).rejects.toMatchObject({ code: "conflict" });
    expect(pp.calls.filter((x) => x.path === "/v1/billing/subscriptions" && x.method === "POST")).toHaveLength(0);
  });

  it("is held to one open agreement per plan by the database as well", async () => {
    const c = await client("active", 10);
    await startMaintenanceAgreement(c.ctx, deps());
    await expect(withSystem((db) => db.query(
      "insert into maintenance_agreements (org_id, subscription_id, reference_number, livemode, amount_minor, currency) values ($1, $2, 'IAQ-DUPLICATE0001', false, 29900, 'USD')", [c.org.id, c.plan],
    ))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Approval grants nothing; a completed charge is what pays
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("an agreement grants nothing by itself", () => {
  it("leaves a requested plan requested after the buyer approves, until PayPal confirms a charge", async () => {
    const c = await client("requested");
    const l = await live(c);
    expect((await agreement(c.plan)).status).toBe("active");
    expect(await facts(c.plan)).toMatchObject({ status: "requested", paid_through_on: null });
    expect(await rows("select 1 from payments where maintenance_subscription_id = $1", [c.plan])).toHaveLength(0);
    // A status notice saying ACTIVE changes nothing about the plan either.
    await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", { id: l.sub.id, status: "ACTIVE", custom_id: l.reference }));
    expect(await facts(c.plan)).toMatchObject({ status: "requested" });
  });

  it("starts a requested plan on the first completed charge, through the same transition as a payment recorded by hand", async () => {
    const c = await client("requested");
    const l = await live(c);
    const out = await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-FIRST-1" }));
    expect(out).toMatchObject({ outcome: "processed" });
    const f = await facts(c.plan);
    expect(f).toMatchObject({ status: "active", billing_start_on: today() });
    expect(f.paid_through_on).toBe(nextPaidThrough({ status: "requested", paidThroughOn: null, today: today(), months: 1 }));
    const [p] = await paymentsOf(c.plan);
    expect(p).toMatchObject({ status: "paid", provider: "paypal", provider_payment_id: "SALE-FIRST-1", covers_months: 1, charged_currency: "USD", livemode: false });
    expect(Number(p.charged_amount_minor)).toBe(29_900);
    expect(Number(p.usd_amount_micros)).toBe(299_000_000);
    expect(p.maintenance_agreement_id).toBe((await agreement(c.plan)).id);
    expect(f.last_payment_id).toBe(p.id);
    expect(await charges((await agreement(c.plan)).id)).toEqual([expect.objectContaining({ provider_charge_id: "SALE-FIRST-1", outcome: "applied", payment_id: p.id })]);
    const audit = await auditOf(c.org.id, "maintenance.activated");
    expect(audit[0]).toMatchObject({ actor_kind: "system" });
    expect(new Set((await noticesOf(c.org.id, "billing_payment_received", "client")).map((n) => n.dedupe_key)).size).toBe(1);
  });

  it("renews an active plan from the day it was paid through, keeping the days already paid for", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-RENEW-1" }));
    const f = await facts(c.plan);
    expect(f.status).toBe("active");
    expect(f.paid_through_on).toBe(nextPaidThrough({ status: "active", paidThroughOn: plus(10), today: today(), months: 1 }));
    expect(f.paid_through_on! > plus(10)).toBe(true);
    expect((await auditOf(c.org.id, "maintenance.payment_verified"))[0]).toMatchObject({ actor_kind: "system" });
  });

  it("is applied once: a replayed notice, the same charge under a new notice, and the hourly list all change nothing more", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    const body = saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-ONCE-1", id: "WH-REPLAY-1" });
    expect(await deliver(body)).toMatchObject({ outcome: "processed" });
    const once = await facts(c.plan);
    expect(await deliver(body)).toMatchObject({ outcome: "duplicate" });
    expect(await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-ONCE-1" }))).toMatchObject({ outcome: "ignored" });
    pp.collect(l.sub.id, { id: "SALE-ONCE-1" });
    await runAgreementReconcile({ deps: deps() });
    await runAgreementReconcile({ deps: deps() });
    expect(await facts(c.plan)).toEqual(once);
    expect(await paymentsOf(c.plan)).toHaveLength(1);
    expect(await charges((await agreement(c.plan)).id)).toHaveLength(1);
  });

  it("does not trust a charge that is not what the agreement asked for, in either direction", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    const before = await facts(c.plan);
    for (const [i, over] of ([{ total: "298.00" }, { total: "598.00" }, { total: "299.00", currency: "PHP" }, { total: "0.00" }] as const).entries()) {
      const out = await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: `SALE-BAD-${i}`, ...over }));
      expect(out.outcome, JSON.stringify(over)).toMatch(/rejected|ignored/);
    }
    expect(await facts(c.plan)).toEqual(before);
    expect(await paymentsOf(c.plan)).toHaveLength(0);
    const kinds = (await charges((await agreement(c.plan)).id)).map((x) => x.outcome);
    expect(kinds.every((k) => k === "mismatch")).toBe(true);
    expect((await noticesOf(c.org.id, "billing_reconciliation", "agency")).some((n) => n.severity === "critical" && /did not match/.test(n.title))).toBe(true);
  });

  it("ignores a sale that is not completed, a sale of no subscription and a charge for a subscription it has never heard of", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    expect(await deliver(saleCompletedEvent({ agreementId: l.sub.id, state: "pending" }))).toMatchObject({ outcome: "ignored" });
    expect(await deliver(saleCompletedEvent({ agreementId: l.sub.id, omitAgreement: true }))).toMatchObject({ outcome: "ignored" });
    expect(await deliver(saleCompletedEvent({ agreementId: "I-NOSUCHSUBSCRIPTION" }))).toMatchObject({ outcome: "ignored" });
    expect(await paymentsOf(c.plan)).toHaveLength(0);
    expect((await facts(c.plan)).paid_through_on).toBe(plus(10));
  });

  it("refuses a delivery whose signature PayPal does not verify, and an event from the other mode", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    pp.state.signaturesValid = false;
    expect(await deliver(saleCompletedEvent({ agreementId: l.sub.id }))).toMatchObject({ httpStatus: 401, outcome: "rejected" });
    pp.state.signaturesValid = true;
    const event = createPaypalAdapter({ wire: pp.wire }).parse(saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-LIVE-1" }))!;
    expect(await recordAndApply(adapter, { ...event, livemode: true })).toMatchObject({ outcome: "ignored" });
    expect(await paymentsOf(c.plan)).toHaveLength(0);
  });

  it("does not take a charge for another workspace's agreement, and a corrupted read-back is not an answer", async () => {
    const a = await client("active", 10);
    const b = await client("active", 10);
    const la = await live(a);
    await live(b);
    await deliver(saleCompletedEvent({ agreementId: la.sub.id, saleId: "SALE-A-1" }));
    expect((await paymentsOf(a.plan)).map((p) => p.provider_payment_id)).toEqual(["SALE-A-1"]);
    expect(await paymentsOf(b.plan)).toHaveLength(0);
    pp.state.wrongIdOnRead = true;
    await expect(completeAgreementReturn(a.ctx, la.reference, deps())).resolves.toMatchObject({ status: "active" });
    pp.state.wrongIdOnRead = false;
  });

  it("treats two charges within days as one charge under two ids: the second is recorded and held, never added", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-TWICE-1" }));
    const once = await facts(c.plan);
    await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-TWICE-2" }));
    expect(await facts(c.plan)).toEqual(once);
    const list = await charges((await agreement(c.plan)).id);
    expect(list.map((x) => x.outcome)).toEqual(["applied", "held"]);
    expect(list[1].detail).toMatch(/not the same charge twice/);
    expect(await paymentsOf(c.plan)).toHaveLength(2);
    expect((await noticesOf(c.org.id, "billing_reconciliation", "agency")).some((n) => n.severity === "critical" && /arrived on a held/.test(n.title))).toBe(true);
  });

  it("keeps the money recorded but changes nothing when the plan cannot take it (a cancelled plan)", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'cancelled', cancelled_at = now() where id = $1", [c.plan]));
    const out = await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-LATE-1" }));
    expect(out).toMatchObject({ outcome: "processed" });
    expect((await facts(c.plan)).status).toBe("cancelled");
    expect((await paymentsOf(c.plan))[0]).toMatchObject({ status: "paid" });
    expect((await charges((await agreement(c.plan)).id))[0]).toMatchObject({ outcome: "held" });
    expect((await noticesOf(c.org.id, "billing_reconciliation", "agency")).some((n) => /could not be applied|plan could not take|the plan refused/i.test(`${n.title} ${n.body}`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Status news arrives late, twice and out of order
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("status news from PayPal", () => {
  it("follows the status, remembers the next charge, and tells the owner once", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    expect(await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.SUSPENDED", { id: l.sub.id, status: "SUSPENDED", custom_id: l.reference, failedPayments: 2, createTime: new Date(Date.now() + 1000).toISOString() }))).toMatchObject({ outcome: "processed" });
    const a = await agreement(c.plan);
    expect(a).toMatchObject({ status: "suspended", failed_payments: 2 });
    expect(new Set((await noticesOf(c.org.id, "maintenance_update", "client")).filter((n) => n.title === "Automatic payments are paused").map((n) => n.dedupe_key)).size).toBe(1);
    // The plan itself was not touched by a pause.
    expect(await facts(c.plan)).toMatchObject({ status: "active", paid_through_on: plus(10) });
    const later = new Date(Date.now() + 5000).toISOString();
    await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", { id: l.sub.id, status: "ACTIVE", custom_id: l.reference, nextBilling: later, createTime: later }));
    expect(await agreement(c.plan)).toMatchObject({ status: "active" });
  });

  it("ignores news dated before news already applied, and an earlier stage after a later one", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    const t0 = Date.now();
    await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.SUSPENDED", { id: l.sub.id, status: "SUSPENDED", createTime: new Date(t0 + 10_000).toISOString() }));
    // An ACTIVATED dated before the suspension arrives late: stale.
    expect(await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", { id: l.sub.id, status: "ACTIVE", createTime: new Date(t0 + 5_000).toISOString() }))).toMatchObject({ outcome: "ignored" });
    expect((await agreement(c.plan)).status).toBe("suspended");
    // An approval stage after a later one is old news.
    expect(await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.UPDATED", { id: l.sub.id, status: "APPROVAL_PENDING", createTime: new Date(t0 + 20_000).toISOString() }))).toMatchObject({ outcome: "ignored" });
    expect((await agreement(c.plan)).status).toBe("suspended");
  });

  it("never brings an ended agreement back, and the same event twice is one event", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    const cancelled = subscriptionEvent("BILLING.SUBSCRIPTION.CANCELLED", { id: l.sub.id, status: "CANCELLED", createTime: new Date(Date.now() + 1000).toISOString() }, { id: "WH-CANCEL-1" });
    expect(await deliver(cancelled)).toMatchObject({ outcome: "processed" });
    expect(await deliver(cancelled)).toMatchObject({ outcome: "duplicate" });
    expect(await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", { id: l.sub.id, status: "ACTIVE", createTime: new Date(Date.now() + 9000).toISOString() }))).toMatchObject({ outcome: "ignored" });
    expect(await agreement(c.plan)).toMatchObject({ status: "cancelled" });
    // The plan is unchanged: automatic payments ended, the paid period did not.
    expect(await facts(c.plan)).toMatchObject({ status: "active", paid_through_on: plus(10) });
    expect(new Set((await noticesOf(c.org.id, "maintenance_update", "client")).filter((n) => n.title === "Automatic payments have ended").map((n) => n.dedupe_key)).size).toBe(1);
    // The database says the same, whatever the application does.
    const endedId = (await agreement(c.plan)).id;
    await expect(withSystem((db) => db.query("update maintenance_agreements set status = 'active' where id = $1", [endedId]))).rejects.toThrow(/does not come back/);
  });

  it("adopts the provider id by our own reference when the notice beats the answer that carried it", async () => {
    const c = await client("active", 10);
    const started = await startMaintenanceAgreement(c.ctx, deps());
    const sub = pp.byReference(started.reference)!;
    // Simulate the process dying after PayPal opened the subscription and before its id was stored.
    await withSystem((db) => db.query("alter table maintenance_agreements disable trigger maintenance_agreements_guard"));
    await withSystem((db) => db.query("update maintenance_agreements set provider_agreement_id = null where reference_number = $1", [started.reference]));
    await withSystem((db) => db.query("alter table maintenance_agreements enable trigger maintenance_agreements_guard"));
    pp.approve(sub.id);
    await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", { id: sub.id, status: "ACTIVE", custom_id: started.reference }));
    expect(await agreement(c.plan)).toMatchObject({ status: "active", provider_agreement_id: sub.id });
    // Only an agreement with no id yet can be adopted, and only once.
    expect(await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-OTHERSUBSCRIPTION", status: "ACTIVE", custom_id: started.reference }))).toMatchObject({ outcome: "ignored" });
    expect((await agreement(c.plan)).provider_agreement_id).toBe(sub.id);
  });

  it("the database keeps the terms an agreement was opened with", async () => {
    const c = await client("active", 10);
    await startMaintenanceAgreement(c.ctx, deps());
    const id = (await agreement(c.plan)).id;
    await expect(withSystem((db) => db.query("update maintenance_agreements set amount_minor = 1 where id = $1", [id]))).rejects.toThrow(/never change/);
    await expect(withSystem((db) => db.query("update maintenance_agreements set livemode = true where id = $1", [id]))).rejects.toThrow(/never change/);
    await expect(withSystem((db) => db.query("update maintenance_agreements set provider_agreement_id = 'I-OTHER123' where id = $1", [id]))).rejects.toThrow(/set once/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Failed renewals: past due, grace, the premium pause, and a verified reactivation
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("a failed renewal", () => {
  it("walks the plan through past due and the grace period to the premium pause, never touching the core system, and a verified charge brings it back", async () => {
    const c = await client("active", 20);
    const studio = await studioWorkflowFor(c.o);
    const core = await coreWorkflowFor(c.o);
    const l = await live(c);
    // The paid period ends; PayPal's charge for the next one fails.
    await withSystem((db) => db.query("update maintenance_subscriptions set paid_through_on = $2 where id = $1", [c.plan, plus(-1)]));
    pp.failPayment(l.sub.id);
    const failed = subscriptionEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: l.sub.id, status: "ACTIVE", custom_id: l.reference, failedPayments: 1 }, { id: "WH-FAIL-1" });
    expect(await deliver(failed)).toMatchObject({ outcome: "processed" });
    const f = await facts(c.plan);
    expect(f.status).toBe("past_due");
    expect(new Date(f.grace_ends_at as Date).getTime() - new Date(f.past_due_since as Date).getTime()).toBe(7 * DAY);
    expect((await auditOf(c.org.id, "maintenance.payment_failed"))[0]).toMatchObject({ actor_kind: "system" });
    // The same notice twice, and a second failed attempt, do not restart or extend the grace period.
    expect(await deliver(failed)).toMatchObject({ outcome: "duplicate" });
    await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: l.sub.id, status: "ACTIVE", failedPayments: 2, createTime: new Date(Date.now() + 2000).toISOString() }));
    expect((await facts(c.plan)).grace_ends_at).toEqual(f.grace_ends_at);
    expect(await agreement(c.plan)).toMatchObject({ failed_payments: 2 });
    // Automation Studio keeps working through the grace period.
    expect(await withSystem((db) => studioEntitlement(db, c.org.id, new Date()))).toMatchObject({ entitled: true, state: "past_due" });
    expect(await workflowRow(studio)).toMatchObject({ status: "active", entitlement_paused_at: null });

    // The grace period ends: the plan expires and ONLY the premium workflows are paused. The core workflow is not touched.
    await sweepStudioEntitlements(new Date(Date.now() + 8 * DAY));
    expect((await facts(c.plan)).status).toBe("expired");
    expect(await workflowRow(studio)).toMatchObject({ status: "paused" });
    expect((await workflowRow(studio)).entitlement_paused_at).not.toBeNull();
    expect(await workflowRow(core)).toMatchObject({ status: "active", entitlement_paused_at: null });

    // A refund or a dispute reported now re-enables nothing (and revokes nothing).
    // Verified reactivation: PayPal reports a COMPLETED charge for the agreement.
    expect(await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-BACK-1" }))).toMatchObject({ outcome: "processed" });
    const back = await facts(c.plan);
    expect(back).toMatchObject({ status: "active", past_due_since: null, grace_ends_at: null });
    expect(back.paid_through_on).toBe(nextPaidThrough({ status: "expired", paidThroughOn: plus(-1), today: today(), months: 1 }));
    expect((await agreement(c.plan)).failed_payments).toBe(0);
    // Nothing switches itself back on: the paused workflow waits for a person.
    expect(await workflowRow(studio)).toMatchObject({ status: "paused" });
    expect((await noticesOf(c.org.id, "maintenance_update", "client")).map((n) => n.title)).toContain("Your maintenance plan is active again");
  });

  it("does not start the grace period while the plan is still paid through a later day, and tells the owner so", async () => {
    const c = await client("active", 10);
    const studio = await studioWorkflowFor(c.o);
    const l = await live(c);
    await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: l.sub.id, status: "ACTIVE", failedPayments: 1 }));
    expect(await facts(c.plan)).toMatchObject({ status: "active", past_due_since: null, paid_through_on: plus(10) });
    expect(await workflowRow(studio)).toMatchObject({ status: "active" });
    const told = (await noticesOf(c.org.id, "billing_payment_failed", "client"))[0];
    expect(told.body).toContain(`paid through ${plus(10)}`);
    expect(told.body).toMatch(/not affected/);
    // When the day passes with the failure still on record, the renewal sweep starts the grace period without the team's automatic switch (a reported failure is a fact).
    await withSystem((db) => db.query("update maintenance_subscriptions set paid_through_on = $2 where id = $1", [c.plan, plus(-1)]));
    expect(await runMaintenanceRenewalSweep({ now: new Date() })).toMatchObject({ pastDue: 1 });
    expect((await facts(c.plan)).status).toBe("past_due");
    expect((await noticesOf(c.org.id, "billing_renewal_due", "agency")).some((n) => /PayPal reported that the automatic payment failed/.test(n.body ?? ""))).toBe(true);
  });

  it("does not mark a plan past due for a period nobody has failed to pay: with no failure on record the old rule holds", async () => {
    const c = await client("active", 20);
    await live(c);
    await withSystem((db) => db.query("update maintenance_subscriptions set paid_through_on = $2 where id = $1", [c.plan, plus(-5)]));
    expect(await runMaintenanceRenewalSweep({ now: new Date() })).toMatchObject({ overdue: 1, pastDue: 0 });
    expect((await facts(c.plan)).status).toBe("active");
  });

  it("dates a failure by the event, not by the subscription's old status time, so a failure after a collected charge is applied", async () => {
    // PayPal's subscription resource carries status_update_time, which moves only when the STATUS moves. A failed charge leaves a subscription ACTIVE, so by the third renewal that
    // time is months old. Dating the failure by it would make it look older than the charge collected last month and drop it as stale, silently, every time.
    const c = await client("active", 10);
    const l = await live(c);
    const t0 = Date.now();
    await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: `SALE-${uid()}`, createTime: new Date(t0 - 3_600_000).toISOString() }));
    const failure = subscriptionEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", {
      id: l.sub.id, status: "ACTIVE", failedPayments: 1, createTime: new Date(t0).toISOString(), statusUpdatedAt: new Date(t0 - 30 * 86_400_000).toISOString(),
    });
    expect(await deliver(failure)).toMatchObject({ outcome: "processed" });
    expect((await agreement(c.plan)).failed_payments).toBe(1);
    expect((await noticesOf(c.org.id, "billing_payment_failed", "client")).length).toBeGreaterThan(0);
    // The same event again is the same event.
    expect(await deliver(failure)).toMatchObject({ outcome: "duplicate" });
    // A failure that PayPal dates by the event but that happened BEFORE the collected charge is still old news.
    const old = subscriptionEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: l.sub.id, status: "ACTIVE", failedPayments: 2, createTime: new Date(t0 - 2 * 3_600_000).toISOString(), statusUpdatedAt: new Date(t0 - 30 * 86_400_000).toISOString() });
    expect(await deliver(old)).toMatchObject({ outcome: "ignored" });
    expect((await agreement(c.plan)).failed_payments).toBe(1);
  });

  it("ignores a failure dated before a newer success (a retry that succeeded)", async () => {
    const c = await client("active", 20);
    const l = await live(c);
    await withSystem((db) => db.query("update maintenance_subscriptions set paid_through_on = $2 where id = $1", [c.plan, plus(-1)]));
    const t0 = Date.now();
    await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-RETRY-1", createTime: new Date(t0 + 10_000).toISOString() }));
    const after = await facts(c.plan);
    expect(await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: l.sub.id, status: "ACTIVE", failedPayments: 1, createTime: new Date(t0 + 1000).toISOString() }))).toMatchObject({ outcome: "ignored" });
    expect(await facts(c.plan)).toEqual(after);
    expect(after.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Refunds and disputes hold the agreement for a person
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("a refund or a dispute", () => {
  async function paidAgreement() {
    const c = await client("active", 10);
    const l = await live(c);
    // Provider payment ids are unique across the whole database, so each case has its own.
    const sale = `SALE-${uid()}`;
    await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: sale }));
    return { c, l, sale, afterFirst: await facts(c.plan) };
  }
  /** Moves the recorded charge out of the recent-charge window, as a month passing would. */
  const aMonthLater = (agreementId: string) => withSystem((db) => db.query("update maintenance_agreement_charges set created_at = created_at - interval '30 days' where agreement_id = $1", [agreementId]));

  it("is reported to the team as PayPal's, holds the agreement, and takes nothing away", async () => {
    const { c, sale, afterFirst } = await paidAgreement();
    const out = await deliver(saleRefundedEvent({ saleId: sale }));
    expect(out).toMatchObject({ outcome: "processed" });
    expect(await facts(c.plan)).toEqual(afterFirst);
    expect(afterFirst.last_payment_id).not.toBeNull();
    expect((await paymentsOf(c.plan))[0].status).toBe("paid");
    expect(await agreement(c.plan)).toMatchObject({ status: "active", hold: "refunded" });
    const told = (await noticesOf(c.org.id, "billing_reconciliation", "agency")).filter((n) => /PayPal reports a refund/.test(n.title));
    expect(told).toHaveLength(1);
    expect(told[0].body).toMatch(/PayPal reports a refund of USD 299\.00\./);
    expect(told[0].body).not.toMatch(/PayMongo/);
    expect((await noticesOf(c.org.id, "billing_reconciliation", "agency")).some((n) => n.severity === "critical" && n.title === "An automatic payment is on hold")).toBe(true);
    expect(await auditOf(c.org.id, "maintenance.agreement_held")).toHaveLength(1);
  });

  it("records a further charge but does not add it to the plan until a person releases the hold, and then applies it once", async () => {
    const { c, l, sale, afterFirst } = await paidAgreement();
    await deliver(saleRefundedEvent({ saleId: sale }));
    await aMonthLater((await agreement(c.plan)).id);
    const second = `${sale}-NEXT`;
    expect(await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: second }))).toMatchObject({ outcome: "processed" });
    // The money is recorded; the plan did not move.
    expect(await facts(c.plan)).toEqual(afterFirst);
    expect((await paymentsOf(c.plan)).map((p) => [p.provider_payment_id, p.status])).toEqual([[sale, "paid"], [second, "paid"]]);
    expect((await charges((await agreement(c.plan)).id)).map((x) => x.outcome)).toEqual(["applied", "held"]);
    expect((await noticesOf(c.org.id, "billing_payment_received", "client")).some((n) => /being reviewed/.test(n.title))).toBe(true);

    // Releasing needs a reason; it applies the held charge through the usual transition.
    const id = (await agreement(c.plan)).id;
    await expect(releaseAgreementHold(superAdmin, id, "ok")).rejects.toMatchObject({ code: "invalid_input" });
    expect(await releaseAgreementHold(superAdmin, id, "Refund was a goodwill gesture; the plan stands")).toEqual({ applied: 1, refused: 0 });
    expect(await agreement(c.plan)).toMatchObject({ hold: null });
    const f = await facts(c.plan);
    expect(f.paid_through_on).toBe(nextPaidThrough({ status: "active", paidThroughOn: afterFirst.paid_through_on, today: today(), months: 1 }));
    expect((await charges(id)).map((x) => x.outcome)).toEqual(["applied", "applied"]);
    expect((await auditOf(c.org.id, "maintenance.agreement_hold_released"))[0].actor_kind).toBe("agency");
    // A second release has nothing to release.
    await expect(releaseAgreementHold(superAdmin, id, "Nothing left to do here")).rejects.toMatchObject({ code: "conflict" });
  });

  it("holds the agreement for a dispute, never downgrades it to a refund, and a reversal is a dispute too", async () => {
    const { c, sale } = await paidAgreement();
    await deliver(saleReversedEvent({ saleId: sale }));
    expect(await agreement(c.plan)).toMatchObject({ hold: "disputed" });
    await deliver(saleRefundedEvent({ saleId: sale }));
    expect(await agreement(c.plan)).toMatchObject({ hold: "disputed" });
    expect((await noticesOf(c.org.id, "billing_reconciliation", "agency")).some((n) => /disputed at PayPal/.test(n.title))).toBe(true);
  });

  it("a refund that did not go through is not a refund, and a refund for a sale we have no record of changes nothing", async () => {
    const { c, sale, afterFirst } = await paidAgreement();
    await deliver(saleRefundedEvent({ saleId: sale, state: "failed" }));
    expect((await agreement(c.plan)).hold).toBeNull();
    expect(await deliver(saleRefundedEvent({ saleId: "SALE-UNKNOWN" }))).toMatchObject({ outcome: "ignored" });
    expect(await facts(c.plan)).toEqual(afterFirst);
  });

  it("never re-enables an expired plan, and never revokes an active one", async () => {
    const { c, l, sale } = await paidAgreement();
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'expired', expired_at = now(), past_due_since = null, grace_ends_at = null where id = $1", [c.plan]));
    await deliver(saleRefundedEvent({ saleId: sale }));
    await deliver(saleReversedEvent({ saleId: sale }));
    expect((await facts(c.plan)).status).toBe("expired");
    // A charge on the held agreement is recorded and does NOT bring the expired plan back.
    await aMonthLater((await agreement(c.plan)).id);
    await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: `${sale}-NEXT` }));
    expect((await facts(c.plan)).status).toBe("expired");
    expect((await charges((await agreement(c.plan)).id)).at(-1)).toMatchObject({ outcome: "held" });
  });

  it("is released only by someone who may manage the client's maintenance", async () => {
    const { c, sale } = await paidAgreement();
    await deliver(saleRefundedEvent({ saleId: sale }));
    const client = agencyUser(await createUser(), "agency_staff");
    await expect(releaseAgreementHold({ ...client, platformRole: "none" }, (await agreement(c.plan)).id, "I would like to release this")).rejects.toMatchObject({ code: "forbidden" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Ending it
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("stopping automatic payments", () => {
  it("cancels at PayPal first, leaves the plan exactly as paid, and still records a charge that was already on its way", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    await cancelAgreementAsOwner(c.ctx, deps());
    expect(pp.calls.some((x) => x.path.endsWith(`/${l.sub.id}/cancel`) && x.method === "POST")).toBe(true);
    expect(await agreement(c.plan)).toMatchObject({ status: "cancelled" });
    expect(pp.subscriptions.get(l.sub.id)?.status).toBe("CANCELLED");
    expect(await facts(c.plan)).toMatchObject({ status: "active", paid_through_on: plus(10) });
    expect((await auditOf(c.org.id, "maintenance.agreement_cancelled"))[0]).toMatchObject({ actor_kind: "user" });
    // A charge that completed after the cancellation was money: recorded and applied like any other.
    expect(await deliver(saleCompletedEvent({ agreementId: l.sub.id, saleId: "SALE-LAST-1" }))).toMatchObject({ outcome: "processed" });
    expect((await facts(c.plan)).paid_through_on! > plus(10)).toBe(true);
    // Stopping twice is not an error to be shown and not a second cancel.
    await expect(cancelAgreementAsOwner(c.ctx, deps())).rejects.toMatchObject({ code: "not_found" });
  });

  it("is not recorded as stopped when PayPal cannot be reached: the agreement stays on, the team is told, and trying again works", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    pp.state.cancelDown = true;
    await expect(cancelAgreementAsOwner(c.ctx, deps())).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(await agreement(c.plan)).toMatchObject({ status: "active" });
    expect((await noticesOf(c.org.id, "billing_reconciliation", "agency")).some((n) => n.severity === "critical" && /could not be cancelled at PayPal/.test(n.title))).toBe(true);
    expect((await auditOf(c.org.id, "maintenance.agreement_cancel_failed"))[0].actor_kind).toBe("user");
    pp.state.cancelDown = false;
    await cancelAgreementAsOwner(c.ctx, deps());
    expect(await agreement(c.plan)).toMatchObject({ status: "cancelled" });
    expect(pp.subscriptions.get(l.sub.id)?.status).toBe("CANCELLED");
  });

  it("is stopped with the plan when the owner asks to cancel it, so nothing is collected for a plan that is going", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    await requestMaintenanceCancellation(c.ctx, "Closing the business", deps());
    expect(pp.subscriptions.get(l.sub.id)?.status).toBe("CANCELLED");
    expect(await agreement(c.plan)).toMatchObject({ status: "cancelled" });
    expect(await facts(c.plan)).toMatchObject({ status: "cancel_requested", paid_through_on: plus(10) });
  });

  it("can be stopped by the team for a client they may see, not by someone else, and an already-ended subscription is recorded as ended", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    const stranger = agencyUser(await createUser(), "agency_staff");
    await expect(cancelAgreementAsAgency({ ...stranger, platformRole: "none" }, (await agreement(c.plan)).id, deps())).rejects.toMatchObject({ code: "forbidden" });
    // PayPal already cancelled it (the buyer did, in PayPal): the cancel answers "already ended" and the record follows.
    pp.setStatus(l.sub.id, "CANCELLED");
    await cancelAgreementAsAgency(superAdmin, (await agreement(c.plan)).id, deps());
    expect(await agreement(c.plan)).toMatchObject({ status: "cancelled" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The hourly check
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("the hourly check of PayPal's own record", () => {
  it("lands a status and a charge whose notices never arrived, once", async () => {
    const c = await client("past_due", -3);
    const started = await startMaintenanceAgreement(c.ctx, deps());
    const sub = pp.byReference(started.reference)!;
    pp.approve(sub.id);
    pp.collect(sub.id, { id: "SALE-LOST-1" });
    const first = await runAgreementReconcile({ deps: deps() });
    expect(first).toMatchObject({ failed: 0, skipped: null });
    expect(first.charges).toBe(1);
    expect(await agreement(c.plan)).toMatchObject({ status: "active" });
    expect((await paymentsOf(c.plan)).map((p) => p.provider_payment_id)).toEqual(["SALE-LOST-1"]);
    expect(await facts(c.plan)).toMatchObject({ status: "active" });
    const second = await runAgreementReconcile({ deps: deps() });
    expect(second.charges).toBe(0);
    expect(await paymentsOf(c.plan)).toHaveLength(1);
  });

  it("applies only charges PayPal lists as COMPLETED", async () => {
    const c = await client("active", 10);
    const l = await live(c);
    pp.collect(l.sub.id, { id: "SALE-DECLINED", status: "DECLINED" });
    pp.collect(l.sub.id, { id: "SALE-PENDING", status: "PENDING" });
    await runAgreementReconcile({ deps: deps() });
    expect(await paymentsOf(c.plan)).toHaveLength(0);
    expect((await facts(c.plan)).paid_through_on).toBe(plus(10));
  });

  it("closes an approval nobody gave, and cancels at PayPal one that is approved after it was closed", async () => {
    const c = await client("active", 10);
    const started = await startMaintenanceAgreement(c.ctx, deps());
    const sub = pp.byReference(started.reference)!;
    await withSystem((db) => db.query("update maintenance_agreements set created_at = now() - interval '4 days' where reference_number = $1", [started.reference]));
    const closed = await runAgreementReconcile({ deps: deps() });
    expect(closed.abandoned).toBe(1);
    expect(await agreement(c.plan)).toMatchObject({ status: "abandoned" });
    expect((await auditOf(c.org.id, "maintenance.agreement_abandoned")).length).toBe(1);
    // The buyer approves the old link after all. PayPal would now charge; the check cancels it and the product treats it as ended.
    pp.approve(sub.id);
    const late = await runAgreementReconcile({ deps: deps() });
    expect(late.cancelledLate).toBe(1);
    expect(pp.subscriptions.get(sub.id)?.status).toBe("CANCELLED");
    expect(await agreement(c.plan)).toMatchObject({ status: "cancelled" });
    // A notice about the late approval reaches the team at once.
    const c2 = await client("active", 10);
    const s2 = await startMaintenanceAgreement(c2.ctx, deps());
    const sub2 = pp.byReference(s2.reference)!;
    await withSystem((db) => db.query("update maintenance_agreements set status = 'abandoned' where reference_number = $1", [s2.reference]));
    pp.approve(sub2.id);
    expect(await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", { id: sub2.id, status: "ACTIVE", custom_id: s2.reference }))).toMatchObject({ outcome: "processed" });
    expect((await noticesOf(c2.org.id, "billing_reconciliation", "agency")).some((n) => n.severity === "critical" && /late approval/i.test(n.title))).toBe(true);
    expect((await agreement(c2.plan)).status).toBe("abandoned");
  });

  it("counts a PayPal outage as a failure to try again, and changes nothing", async () => {
    const c = await client("active", 10);
    await live(c);
    pp.state.down = true;
    const r = await runAgreementReconcile({ deps: deps() });
    expect(r).toMatchObject({ checked: 1, failed: 1, charges: 0 });
    pp.state.down = false;
    expect((await agreement(c.plan)).status).toBe("active");
  });

  it("is also what finishes the buyer's return when the notice has not arrived yet", async () => {
    const c = await client("requested");
    const started = await startMaintenanceAgreement(c.ctx, deps());
    const sub = pp.byReference(started.reference)!;
    pp.approve(sub.id);
    pp.collect(sub.id, { id: "SALE-RETURN-1" });
    expect(await completeAgreementReturn(c.ctx, started.reference, deps())).toEqual({ status: "active" });
    expect(await facts(c.plan)).toMatchObject({ status: "active", billing_start_on: today() });
    expect((await paymentsOf(c.plan)).map((p) => p.provider_payment_id)).toEqual(["SALE-RETURN-1"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The existing paths are untouched
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("the other ways to pay are unchanged", () => {
  it("a plan with no agreement is still paid by hand or online, and PayPal sale notices for charges of no agreement of ours do nothing", async () => {
    const c = await client("active", 10);
    expect(await withSystem((db) => agreementForPlan(db, c.plan))).toBeNull();
    expect(await deliver(saleCompletedEvent({ agreementId: "I-SOMEONEELSES" }))).toMatchObject({ outcome: "ignored" });
    // A purchase checkout's capture notice is not a subscription charge and is not routed here.
    expect(await deliver(captureCompletedEvent({ orderId: "ORD1", reference: "IAQ-NOPE00000001" }))).toMatchObject({ outcome: "ignored" });
    expect(await facts(c.plan)).toMatchObject({ status: "active", paid_through_on: plus(10) });
  });

  it("the plan view tells the truth about how it is paid", async () => {
    const c = await client("active", 10);
    expect(await withSystem((db) => agreementForPlan(db, c.plan))).toBeNull();
    const l = await live(c);
    const view = await withSystem((db) => agreementForPlan(db, c.plan));
    expect(view).toMatchObject({ status: "active", provider: "paypal", amountMinor: 29_900, currency: "USD", hold: null, reference: l.reference });
    expect(view?.approvalUrl).toBeNull();
    const waiting = await client("active", 10);
    const s = await startMaintenanceAgreement(waiting.ctx, deps());
    expect((await withSystem((db) => agreementForPlan(db, waiting.plan, { withApproval: true })))?.approvalUrl).toBe(s.approvalUrl);
    expect((await withSystem((db) => agreementForPlan(db, waiting.plan)))?.approvalUrl).toBeNull();
  });
});
