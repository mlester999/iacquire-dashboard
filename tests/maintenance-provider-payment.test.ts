// The US$299/month plan paid online, on embedded Postgres. The owner opens a hosted checkout for the plan's own price and months; the plan's paid-through day moves ONLY when
// the provider's signed notice confirms the payment, through the same transition a payment recorded by hand uses. Failed, refunded, disputed, late, duplicate and mismatched
// payments never change a plan by themselves, and nothing here reaches PayMongo (a fetch stub and hand-signed notices).
import { beforeAll, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYMONGO_PAYMENT_METHODS = "card,gcash";

import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { handlePaymongoWebhook } from "@/server/billing/payments";
import { startMaintenancePayment } from "@/server/maintenance/service";
import { addDays, nextPaidThrough } from "@/lib/billing-renewal";
import { todayIn } from "@/lib/invoices/state";
import { addMember, createUser, ctxFor, uid } from "./support/fixtures";
import { clearSetupPayment, markActivated, mockCheckoutFetch, onboardedClient, paymongoDisputeEvent, paymongoPaidEvent, paymongoRefundEvent, signPaymongo } from "./support/billing";
import { planRow, planStatus } from "./support/billing-plan";

const PHP_PER_MONTH = 1_734_200; // US$299.00 at 58 PHP to the dollar, in centavos
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const deliver = (body: string) => handlePaymongoWebhook({ rawBody: body, signatureHeader: signPaymongo(body) });

beforeAll(async () => {
  resetEnvCache();
  await withSystem((db) => db.query("update agency_billing_settings set usd_php_rate = 58, fx_source = 'test fixture', fx_updated_at = now(), live_payments_review_at = now()"));
  // Someone on the agency side to be told (a notice needs a recipient).
  await createUser({ platformRole: "agency_super_admin" });
});

/** A client whose core system is activated and setup fee cleared, with a plan in the given state. */
async function client(status: NonNullable<NonNullable<Parameters<typeof planRow>[1]>["status"]>, paidThroughOn: string | null = null) {
  const { org, owner } = await onboardedClient();
  await markActivated(org.id);
  await clearSetupPayment(org.id);
  const plan = await planRow({ org, people: { owner } }, { status, paidThroughOn });
  return { org, owner, plan, ctx: ctxFor(owner, org, "owner") };
}

/** Opens the plan's checkout through a stand-in and returns what the provider was asked and what was stored. */
async function checkout(c: Awaited<ReturnType<typeof client>>, months = 1) {
  const checkoutId = `cs_${uid()}`;
  const provider = mockCheckoutFetch(checkoutId);
  const started = await startMaintenancePayment(c.ctx, months, { fetch: provider.impl as never });
  const [payment] = await rows<{ id: string; status: string; charged_amount_minor: string; usd_amount_micros: string; maintenance_subscription_id: string; covers_months: number; reference_number: string }>(
    "select id, status, charged_amount_minor::text, usd_amount_micros::text, maintenance_subscription_id, covers_months, reference_number from payments where id = $1", [started.paymentId],
  );
  return { ...started, checkoutId, provider, payment };
}

const paid = (o: { checkoutId: string; reference: string; amount: number; paymentId?: string; eventId?: string }) => paymongoPaidEvent({ ...o, paymentId: o.paymentId ?? `pay_${uid()}` });
const tz = async () => (await rows<{ timezone: string }>("select timezone from organizations where kind = 'agency' limit 1"))[0]?.timezone ?? "UTC";
const today = async () => todayIn(new Date(), await tz());
const planFacts = async (id: string) => (await rows<{ status: string; paid_through_on: string | null; billing_start_on: string | null; past_due_since: Date | null; last_payment_id: string | null }>(
  "select status, paid_through_on::text, billing_start_on::text, past_due_since, last_payment_id from maintenance_subscriptions where id = $1", [id]))[0];

describe("paying the plan online", () => {
  it("opens a checkout for the plan's own price and the months chosen, and nothing about the plan changes until the provider confirms", async () => {
    const c = await client("active", addDays(await today(), 10));
    const k = await checkout(c, 1);
    expect(k.provider.calls).toHaveLength(1);
    const line = (k.provider.calls[0].body.data.attributes as { line_items: Array<{ amount: number; currency: string }> }).line_items[0];
    expect(line).toMatchObject({ amount: PHP_PER_MONTH, currency: "PHP" });
    expect(k.payment).toMatchObject({ status: "pending", maintenance_subscription_id: c.plan, covers_months: 1, usd_amount_micros: "299000000" });
    expect(k.checkoutUrl).toMatch(/^https:\/\/checkout\.paymongo\.com\//);
    const before = await planFacts(c.plan);
    expect(before.paid_through_on).toBe(addDays(await today(), 10));
    // The same plan cannot have two open payments. Pressing again for the same months (after backing out of the provider's page) reopens the checkout that is already open: no second
    // provider session, no second row, no second charge.
    const again = mockCheckoutFetch("cs_second");
    const resumed = await startMaintenancePayment(c.ctx, 1, { fetch: again.impl as never });
    expect(resumed).toMatchObject({ paymentId: k.paymentId, checkoutUrl: k.checkoutUrl, referenceNumber: k.referenceNumber });
    expect(again.calls).toHaveLength(0);
    expect(await rows("select 1 from payments where maintenance_subscription_id = $1 and kind = 'maintenance'", [c.plan])).toHaveLength(1);
    // A different number of months cannot reuse it (the provider's session holds its amount), and the person is told how to carry on.
    const other = mockCheckoutFetch("cs_third");
    await expect(startMaintenancePayment(c.ctx, 3, { fetch: other.impl as never })).rejects.toThrow(/payment for 1 month is already open.*Choose 1 month to continue it/);
    expect(other.calls).toHaveLength(0);
    expect(await rows("select 1 from payments where maintenance_subscription_id = $1 and kind = 'maintenance'", [c.plan])).toHaveLength(1);
  });

  it("takes the amount from the plan whatever the months are, refuses a person who may not pay, and a plan that cannot take a payment", async () => {
    const c = await client("active", addDays(await today(), 3));
    const three = await checkout(c, 3);
    expect(three.payment).toMatchObject({ covers_months: 3, usd_amount_micros: "897000000" });
    expect(Number(three.payment.charged_amount_minor)).toBe(PHP_PER_MONTH * 3);
    await expect(startMaintenancePayment(c.ctx, 0)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(startMaintenancePayment(c.ctx, 13)).rejects.toMatchObject({ code: "invalid_input" });
    const other = await client("active", addDays(await today(), 3));
    const viewer = await createUser();
    await addMember(other.org.id, viewer.id, "viewer");
    await expect(startMaintenancePayment(ctxFor(viewer, other.org, "viewer"), 1)).rejects.toMatchObject({ code: "forbidden" });
    const gone = await client("cancelled");
    await expect(startMaintenancePayment(gone.ctx, 1)).rejects.toMatchObject({ code: "not_found" });
  });

  it("will not take money for a plan that has not started until its core system is activated and its setup fee confirmed", async () => {
    const { org, owner } = await onboardedClient();
    const plan = await planRow({ org, people: { owner } }, { status: "requested" });
    void plan;
    const ctx = ctxFor(owner, org, "owner");
    const provider = mockCheckoutFetch("cs_never");
    await expect(startMaintenancePayment(ctx, 1, { fetch: provider.impl as never })).rejects.toThrow(/Nothing was charged/);
    expect(provider.calls).toHaveLength(0);
    expect(await rows("select 1 from payments where org_id = $1", [org.id])).toHaveLength(0);
  });
});

describe("a plan payment the provider confirms", () => {
  it("renews an active plan from the day it was paid through, keeping the days already paid for", async () => {
    const through = addDays(await today(), 10) as string;
    const c = await client("active", through);
    const k = await checkout(c, 1);
    expect(await deliver(paid({ checkoutId: k.checkoutId, reference: k.referenceNumber, amount: PHP_PER_MONTH }))).toMatchObject({ outcome: "processed" });
    const after = await planFacts(c.plan);
    expect(after.status).toBe("active");
    expect(after.paid_through_on).toBe(nextPaidThrough({ status: "active", paidThroughOn: through, today: await today(), months: 1 }));
    expect(after.paid_through_on! > through).toBe(true);
    expect(after.last_payment_id).toBe(k.paymentId);
    expect((await rows<{ status: string; paid_at: Date | null }>("select status, paid_at from payments where id = $1", [k.paymentId]))[0]).toMatchObject({ status: "paid" });
    expect((await planStatus(c.plan)).last_payment_verified_by).toBeNull();
    const audit = await rows<{ actor_kind: string }>("select actor_kind from audit_logs where target_id = $1 and action = 'maintenance.payment_verified'", [c.plan]);
    expect(audit[0]?.actor_kind).toBe("system");
  });

  it("brings a past-due or an expired plan back to active, starting the new period today", async () => {
    for (const status of ["past_due", "expired"] as const) {
      const c = await client(status, addDays(await today(), -5));
      const k = await checkout(c, 2);
      await deliver(paid({ checkoutId: k.checkoutId, reference: k.referenceNumber, amount: PHP_PER_MONTH * 2 }));
      const after = await planFacts(c.plan);
      expect(after.status, status).toBe("active");
      expect(after.past_due_since, status).toBeNull();
      expect(after.paid_through_on, status).toBe(nextPaidThrough({ status, paidThroughOn: null, today: await today(), months: 2 }));
      const told = await rows<{ title: string }>("select title from notifications where org_id = $1 and kind = 'maintenance_update'", [c.org.id]);
      expect(told.map((n) => n.title)).toContain("Your maintenance plan is active again");
    }
  });

  it("starts a requested plan once its core system is activated and the setup fee is confirmed", async () => {
    const c = await client("requested");
    const k = await checkout(c, 1);
    await deliver(paid({ checkoutId: k.checkoutId, reference: k.referenceNumber, amount: PHP_PER_MONTH }));
    const after = await planFacts(c.plan);
    expect(after).toMatchObject({ status: "active", billing_start_on: await today() });
    expect(after.paid_through_on).toBe(nextPaidThrough({ status: "requested", paidThroughOn: null, today: await today(), months: 1 }));
  });

  it("is applied once: a replay, and a second notice for the same checkout, change nothing more", async () => {
    const through = addDays(await today(), 5);
    const c = await client("active", through);
    const k = await checkout(c, 1);
    const body = paid({ checkoutId: k.checkoutId, reference: k.referenceNumber, amount: PHP_PER_MONTH, paymentId: "pay_once", eventId: `evt_${uid()}` });
    await deliver(body);
    const once = await planFacts(c.plan);
    expect(await deliver(body)).toMatchObject({ outcome: "duplicate" });
    expect(await deliver(paid({ checkoutId: k.checkoutId, reference: k.referenceNumber, amount: PHP_PER_MONTH, paymentId: "pay_once" }))).toMatchObject({ outcome: "ignored" });
    expect(await planFacts(c.plan)).toEqual(once);
  });

  it("records a payment of the wrong amount as a mismatch and leaves the plan alone", async () => {
    const through = addDays(await today(), 5);
    const c = await client("past_due", through);
    const k = await checkout(c, 1);
    expect(await deliver(paid({ checkoutId: k.checkoutId, reference: k.referenceNumber, amount: PHP_PER_MONTH - 1 }))).toMatchObject({ outcome: "rejected" });
    expect((await rows<{ status: string }>("select status from payments where id = $1", [k.paymentId]))[0].status).toBe("mismatch");
    expect((await planFacts(c.plan)).status).toBe("past_due");
  });

  it("keeps the money recorded but tells a person when the plan cannot take it, instead of changing a cancelled plan", async () => {
    const c = await client("active", addDays(await today(), 5));
    const k = await checkout(c, 1);
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'cancelled', cancelled_at = now() where id = $1", [c.plan]));
    expect(await deliver(paid({ checkoutId: k.checkoutId, reference: k.referenceNumber, amount: PHP_PER_MONTH }))).toMatchObject({ outcome: "processed" });
    expect((await planFacts(c.plan)).status).toBe("cancelled");
    expect((await rows<{ status: string }>("select status from payments where id = $1", [k.paymentId]))[0].status).toBe("paid");
    const told = await rows<{ title: string; severity: string }>("select title, severity from notifications where dedupe_key = $1", [`maintenance-unapplied:${k.paymentId}`]);
    expect(told[0]).toMatchObject({ title: "A maintenance payment could not be applied to the plan", severity: "warning" });
  });

  it("reports a refund or a dispute on a plan payment for a person to act on, and never takes a plan or a workflow away", async () => {
    const through = addDays(await today(), 5);
    const c = await client("active", through);
    const k = await checkout(c, 1);
    await deliver(paid({ checkoutId: k.checkoutId, reference: k.referenceNumber, amount: PHP_PER_MONTH, paymentId: "pay_plan_ref" }));
    const settled = await planFacts(c.plan);
    expect(await deliver(paymongoRefundEvent({ paymentId: "pay_plan_ref", amount: PHP_PER_MONTH }))).toMatchObject({ outcome: "processed" });
    expect(await deliver(paymongoDisputeEvent({ paymentId: "pay_plan_ref" }))).toMatchObject({ outcome: "processed" });
    expect(await planFacts(c.plan)).toEqual(settled);
    expect((await rows<{ status: string; refunded_micros: string }>("select status, refunded_micros::text from payments where id = $1", [k.paymentId]))[0]).toMatchObject({ status: "paid", refunded_micros: "0" });
  });
});

describe("the period arithmetic", () => {
  it("continues from the paid-through day, starts today after a lapse, clamps short months, and refuses nonsense", () => {
    expect(nextPaidThrough({ status: "active", paidThroughOn: "2026-11-10", today: "2026-11-01", months: 1 })).toBe("2026-12-10");
    expect(nextPaidThrough({ status: "active", paidThroughOn: "2026-10-20", today: "2026-11-01", months: 1 })).toBe("2026-11-30");
    expect(nextPaidThrough({ status: "past_due", paidThroughOn: "2026-11-10", today: "2026-11-01", months: 1 })).toBe("2026-11-30");
    expect(nextPaidThrough({ status: "requested", paidThroughOn: null, today: "2026-01-31", months: 1 })).toBe("2026-02-27");
    expect(nextPaidThrough({ status: "expired", paidThroughOn: null, today: "2026-12-15", months: 12 })).toBe("2027-12-14");
    expect(nextPaidThrough({ status: "active", paidThroughOn: "2026-02-28", today: "2026-02-20", months: 1 })).toBe("2026-03-31");
    for (const months of [0, 13, 1.5, Number.NaN]) expect(nextPaidThrough({ status: "active", paidThroughOn: "2026-11-10", today: "2026-11-01", months })).toBeNull();
    expect(nextPaidThrough({ status: "active", paidThroughOn: "2026-11-10", today: "not-a-day", months: 1 })).toBeNull();
  });
});
