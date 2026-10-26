// A refund or a dispute that PayMongo reports (Phase 7, M2): it is recorded for a person and never applied. Nothing about a payment, the setup fee, a plan, a workflow or a
// workspace changes because a notice arrived; the team is told, and a person records the refund or answers the dispute. Embedded Postgres; the PayMongo bodies are written by
// hand (their shape was never seen from a PayMongo account), and no provider is called.
import { beforeAll, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYMONGO_PAYMENT_METHODS = "card,gcash";

import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { handlePaymongoWebhook } from "@/server/billing/payments";
import { recordRefundAction } from "@/server/billing/manual";
import { getAgencyBillingOverview } from "@/server/billing/service";
import { normalizePaymongoEvent } from "@/server/billing/providers/paymongo";
import { parseEvent } from "@/server/billing/paymongo";
import { maintenanceEligibility } from "@/server/maintenance/service";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { agencyUser, createUser, uid } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { markActivated, onboardedClient, paymongoDisputeEvent, paymongoPaidEvent, paymongoPaymentRefundedEvent, paymongoRefundEvent, provisioningJobs, setupStatus, signPaymongo } from "./support/billing";
import { auditOf, coreWorkflowFor, planRow, planStatus, studioWorkflowFor, workflowRow } from "./support/billing-plan";

const FULL_PHP = 8_694_200;
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const deliver = (body: string, headers: { signature?: string | null } = {}) => handlePaymongoWebhook({ rawBody: body, signatureHeader: headers.signature === undefined ? signPaymongo(body) : headers.signature });

let superAdmin: ReturnType<typeof agencyUser>;
beforeAll(async () => {
  resetEnvCache();
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
});

/** A setup-fee payment that PayMongo confirmed through the real handler, so it carries the provider payment id a later notice names. */
async function paidSetup(org?: { id: string }) {
  const c = org ? { org, owner: null } : await onboardedClient();
  const reference = `IAQ-RPT${uid().toUpperCase()}`;
  const checkoutId = `cs_${uid()}`;
  const providerPaymentId = `pay_${uid()}`;
  const payment = (await rows<{ id: string }>(
    `insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number, provider_checkout_id)
     values ($1, 'setup_fee', 'Setup', 1499000000, 'PHP', $4, false, 'paymongo', $2, $3) returning id`, [c.org.id, reference, checkoutId, FULL_PHP]))[0];
  const outcome = await deliver(paymongoPaidEvent({ checkoutId, reference, amount: FULL_PHP, paymentId: providerPaymentId }));
  expect(outcome).toMatchObject({ outcome: "processed" });
  return { ...c, reference, paymentId: payment.id, providerPaymentId };
}

type Paid = Awaited<ReturnType<typeof paidSetup>>;

/** Everything a notice must leave exactly as it was. */
async function stateOf(p: Paid) {
  return {
    payment: (await rows("select status, refunded_micros::text, provider_payment_id, paid_at, failure_reason from payments where id = $1", [p.paymentId]))[0],
    setup: await setupStatus(p.org.id),
    jobs: await provisioningJobs(p.org.id),
    org: (await rows("select status from organizations where id = $1", [p.org.id]))[0],
    activation: (await rows("select activation_status from billing_accounts where org_id = $1", [p.org.id]))[0],
    employees: await rows("select id, status, enabled from agent_instances where org_id = $1 order by id", [p.org.id]),
  };
}

const reportsOf = (userId: string, orgId: string | null) =>
  rows<{ title: string; body: string; severity: string; link: string | null; dedupe_key: string }>(
    "select title, body, severity, link, dedupe_key from notifications where user_id = $1 and kind = 'billing_reconciliation' and ($2::uuid is null or org_id = $2) and dedupe_key like 'provider-%' order by created_at, id",
    [userId, orgId]);

describe("a refund PayMongo reports", () => {
  it("is recorded and shown to the team, and changes nothing about the payment, the fee, the workspace or its employees", async () => {
    const p = await paidSetup();
    expect(p.org.id).toBeTruthy();
    expect(await provisioningJobs(p.org.id)).toBe(6);
    const before = await stateOf(p);

    const body = paymongoRefundEvent({ eventId: `evt_${uid()}`, paymentId: p.providerPaymentId, refundId: "ref_one", amount: FULL_PHP });
    expect(await deliver(body)).toMatchObject({ httpStatus: 200, outcome: "processed" });
    expect(await stateOf(p)).toEqual(before);
    expect(before.payment).toMatchObject({ status: "paid", refunded_micros: "0" });
    expect(before.setup.setup_payment_status).toBe("paid");

    const [told] = await reportsOf(superAdmin.id, p.org.id);
    expect(told).toMatchObject({ title: "PayMongo reports a refund", severity: "warning", link: `/admin/clients/${p.org.id}?tab=billing` });
    expect(told.body).toContain(p.reference);
    expect(told.body).toContain("PayMongo reports a refund of PHP 86,942.00.");
    expect(told.body).toMatch(/Nothing was changed/);
    expect(told.body).toMatch(/Access and AI employees are not affected/);
    // It never says a payment or a refund was applied, only that the provider reported one.
    expect(told.body).not.toMatch(/refunded the|was refunded|has been refunded/i);

    const audit = await auditOf(p.org.id, "billing.provider_refund_reported");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: "system", actor_user_id: null, metadata: { reference: p.reference, event: "payment.refund.updated", status: "succeeded", amountMinor: FULL_PHP, currency: "PHP" } });
    const ledger = await rows<{ outcome: string; payment_id: string; detail: string }>("select outcome, payment_id, detail from payment_webhook_events where event_type = 'payment.refund.updated' and payment_id = $1", [p.paymentId]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe("processed");
    expect(ledger[0].detail).toMatch(/nothing was changed/);
  });

  it("is told once however often PayMongo repeats it", async () => {
    const p = await paidSetup();
    const body = paymongoRefundEvent({ eventId: `evt_${uid()}`, paymentId: p.providerPaymentId, amount: 1000 });
    expect(await deliver(body)).toMatchObject({ outcome: "processed" });
    for (let i = 0; i < 3; i += 1) expect(await deliver(body)).toMatchObject({ httpStatus: 200, outcome: "duplicate" });
    expect(await reportsOf(superAdmin.id, p.org.id)).toHaveLength(1);
    expect(await auditOf(p.org.id, "billing.provider_refund_reported")).toHaveLength(1);
    // A second, different notice for the same payment is a second line for the team.
    expect(await deliver(paymongoRefundEvent({ eventId: `evt_${uid()}`, paymentId: p.providerPaymentId, amount: 500 }))).toMatchObject({ outcome: "processed" });
    expect(await reportsOf(superAdmin.id, p.org.id)).toHaveLength(2);
  });

  it("reads the newest refund when the notice is the payment listing its refunds, and says only what the notice states", async () => {
    const p = await paidSetup();
    const listing = paymongoPaymentRefundedEvent({
      eventId: `evt_${uid()}`, paymentId: p.providerPaymentId,
      refunds: [{ id: "ref_old", amount: 1000, status: "succeeded", createdAt: 1700000100 }, { id: "ref_new", amount: 250000, status: "pending", createdAt: 1700000900 }],
    });
    expect(await deliver(listing)).toMatchObject({ outcome: "processed" });
    const [told] = await reportsOf(superAdmin.id, p.org.id);
    expect(told.body).toContain("PayMongo reports a refund of PHP 2,500.00 that is still being processed.");

    const failed = await paidSetup();
    await deliver(paymongoRefundEvent({ paymentId: failed.providerPaymentId, amount: 4000, status: "failed" }));
    expect((await reportsOf(superAdmin.id, failed.org.id))[0].body).toContain("PayMongo reports a refund of PHP 40.00 that could not be completed.");

    // No amount in the notice: no amount in the sentence, and a status word nobody knows is not repeated as a fact.
    const bare = await paidSetup();
    await deliver(paymongoRefundEvent({ paymentId: bare.providerPaymentId, status: "unheard_of" }));
    const bareBody = (await reportsOf(superAdmin.id, bare.org.id))[0].body;
    expect(bareBody).toContain("PayMongo sent a refund notice.");
    expect(bareBody).not.toMatch(/PHP|unheard_of/);

    // A listing with no refund in it is still a refund notice, with nothing invented.
    const empty = await paidSetup();
    await deliver(paymongoPaymentRefundedEvent({ paymentId: empty.providerPaymentId, refunds: [] }));
    expect((await reportsOf(superAdmin.id, empty.org.id))[0].body).toContain("PayMongo sent a refund notice.");
  });

  it("does not count a refund twice when a Super Admin already recorded it", async () => {
    const p = await paidSetup();
    await recordRefundAction(superAdmin, p.paymentId, { amount: "10.00", reason: "Part refunded in the PayMongo dashboard" });
    const recorded = await stateOf(p);
    expect(recorded.payment).toMatchObject({ status: "partially_refunded", refunded_micros: "10000000" });
    expect(await deliver(paymongoRefundEvent({ paymentId: p.providerPaymentId, amount: 58_000 }))).toMatchObject({ outcome: "processed" });
    expect(await stateOf(p)).toEqual(recorded);
    expect((await reportsOf(superAdmin.id, p.org.id))[0].body).toMatch(/if you already recorded it, nothing more is needed/);
  });
});

describe("a dispute PayMongo reports", () => {
  it("is raised as critical for a person, and the payment keeps counting as received until a person records what happened", async () => {
    const p = await paidSetup();
    const before = await stateOf(p);
    const totalsBefore = (await getAgencyBillingOverview(superAdmin)).totals;

    expect(await deliver(paymongoDisputeEvent({ eventId: `evt_${uid()}`, paymentId: p.providerPaymentId }))).toMatchObject({ httpStatus: 200, outcome: "processed" });
    expect(await stateOf(p)).toEqual(before);
    expect(before.payment.status).toBe("paid");
    const overview = await getAgencyBillingOverview(superAdmin);
    expect(overview.totals).toEqual(totalsBefore);
    expect(overview.unmatchedEvents.some((e) => e.eventType === "payment.dispute.created")).toBe(true);

    const [told] = await reportsOf(superAdmin.id, p.org.id);
    expect(told).toMatchObject({ title: "A payment is disputed at PayMongo", severity: "critical" });
    expect(told.body).toContain(p.reference);
    expect(told.body).toMatch(/still counts as received until you record what happened/);
    expect(told.body).toMatch(/Respond to the dispute in PayMongo/);
    expect(told.body).toMatch(/Access and AI employees are not affected/);
    expect((await auditOf(p.org.id, "billing.provider_dispute_reported"))[0].metadata).toMatchObject({ reference: p.reference, event: "payment.dispute.created" });
  });

  it("reads any event named dispute or chargeback the same careful way, and each is its own line", async () => {
    const p = await paidSetup();
    for (const type of ["payment.dispute.created", "payment.dispute.updated", "chargeback.opened"]) {
      expect(await deliver(paymongoDisputeEvent({ paymentId: p.providerPaymentId, type }))).toMatchObject({ outcome: "processed" });
    }
    expect(await reportsOf(superAdmin.id, p.org.id)).toHaveLength(3);
    expect((await rows("select status from payments where id = $1", [p.paymentId]))[0].status).toBe("paid");
  });
});

describe("a notice that cannot be trusted or matched changes nothing", () => {
  it("is refused when its signature is wrong, stale or missing, and leaves no ledger line", async () => {
    const p = await paidSetup();
    const before = await stateOf(p);
    const body = paymongoRefundEvent({ eventId: `evt_forged_${uid()}`, paymentId: p.providerPaymentId, amount: 100 });
    expect(await deliver(body, { signature: signPaymongo(body, { secret: "not_the_secret" }) })).toMatchObject({ httpStatus: 401, outcome: "rejected" });
    expect(await deliver(body, { signature: signPaymongo(body, { t: 1_600_000_000 }) })).toMatchObject({ httpStatus: 401, outcome: "rejected" });
    expect(await deliver(body, { signature: null })).toMatchObject({ httpStatus: 401, outcome: "rejected" });
    expect(await rows("select 1 from payment_webhook_events where provider_event_id like 'evt_forged_%'")).toHaveLength(0);
    expect(await stateOf(p)).toEqual(before);
    expect(await reportsOf(superAdmin.id, p.org.id)).toHaveLength(0);
  });

  it("names no payment we have: ignored, shown on the unmatched list, and the person who watches security is told", async () => {
    for (const body of [
      paymongoRefundEvent({ eventId: `evt_${uid()}`, paymentId: `pay_not_ours_${uid()}`, amount: 100 }),
      paymongoDisputeEvent({ eventId: `evt_${uid()}`, paymentId: `pay_not_ours_${uid()}` }),
    ]) {
      expect(await deliver(body)).toMatchObject({ httpStatus: 200, outcome: "ignored", detail: expect.stringMatching(/for a payment we have no record of/) });
    }
    const mine = await reportsOf(superAdmin.id, null);
    const unmatched = mine.filter((n) => /could not be matched/.test(n.title));
    expect(unmatched.length).toBeGreaterThanOrEqual(2);
    expect(unmatched[0]).toMatchObject({ severity: "warning", link: "/admin/billing?tab=rates" });
    expect(unmatched[0].body).toMatch(/names no payment we have a record of, so nothing was changed/);
    const overview = await getAgencyBillingOverview(superAdmin);
    expect(overview.unmatchedEvents.filter((e) => e.outcome === "ignored" && /refund|dispute/.test(e.eventType)).length).toBeGreaterThanOrEqual(2);

    // A notice with no payment id at all (a resource that is not a payment) cannot be matched either.
    const noId = JSON.stringify({ data: { id: `evt_${uid()}`, type: "event", attributes: { type: "payment.refund.updated", livemode: false, data: { id: "thing_1", type: "thing", attributes: { amount: 5 } } } } });
    expect(await deliver(noId)).toMatchObject({ outcome: "ignored" });
  });

  it("refuses a notice whose mode is not the payment's, and an event of the other mode never reaches the payment at all", async () => {
    const p = await paidSetup();
    // A payment taken in live mode, a test-mode notice that names it: the modes disagree, so it is refused.
    const live = (await rows<{ id: string }>(
      `insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number, provider_checkout_id, provider_payment_id, status, paid_at)
       values ($1, 'other', 'Live', 10000000, 'PHP', 58000, true, 'paymongo', $2, $3, $4, 'paid', now()) returning id`, [p.org.id, `IAQ-LIVE${uid().toUpperCase()}`, `cs_${uid()}`, `pay_live_${uid()}`]))[0];
    const livePayment = (await rows<{ provider_payment_id: string }>("select provider_payment_id from payments where id = $1", [live.id]))[0];
    expect(await deliver(paymongoRefundEvent({ paymentId: livePayment.provider_payment_id, amount: 100 }))).toMatchObject({ outcome: "rejected", detail: "Payment mode mismatch." });
    expect((await rows("select status from payments where id = $1", [live.id]))[0].status).toBe("paid");
    // A live-signed notice in a test environment is ignored before any payment is looked at.
    const liveBody = paymongoRefundEvent({ paymentId: p.providerPaymentId, amount: 100, livemode: true });
    expect(await deliver(liveBody, { signature: signPaymongo(liveBody, { live: true }) })).toMatchObject({ outcome: "ignored", detail: "Event mode differs from this environment." });
    expect(await reportsOf(superAdmin.id, p.org.id)).toHaveLength(0);
  });

  it("tells only the people who may see the workspace the payment belongs to, and touches no other workspace", async () => {
    const a = await paidSetup();
    const b = await paidSetup();
    const staffA = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [a.org.id, staffA.id]));
    const beforeA = await stateOf(a);
    expect(await deliver(paymongoRefundEvent({ paymentId: b.providerPaymentId, amount: 100 }))).toMatchObject({ outcome: "processed" });
    expect(await deliver(paymongoDisputeEvent({ paymentId: b.providerPaymentId }))).toMatchObject({ outcome: "processed" });
    expect(await stateOf(a)).toEqual(beforeA);
    expect(await reportsOf(staffA.id, null)).toHaveLength(0);
    expect(await reportsOf(superAdmin.id, a.org.id)).toHaveLength(0);
    expect(await reportsOf(superAdmin.id, b.org.id)).toHaveLength(2);
    // The client's own people are not told by a provider notice (the agency decides what a client hears).
    expect(await rows("select 1 from notifications where org_id = $1 and audience = 'client' and kind = 'billing_reconciliation'", [b.org.id])).toHaveLength(0);
  });
});

describe("access is never revoked by a notice", () => {
  it("leaves the plan, the Automation Studio workflow, a core workflow, the activated setup and plan eligibility exactly as they were", async () => {
    const o = await crmOrg();
    await markActivated(o.org.id);
    const plan = await planRow(o, { status: "active", paidThroughOn: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10) });
    const studio = await studioWorkflowFor(o);
    const core = await coreWorkflowFor(o);
    const p = await paidSetup(o.org);
    expect((await maintenanceEligibility(o.org.id)).eligible).toBe(true);
    const before = await stateOf(p);

    await deliver(paymongoRefundEvent({ paymentId: p.providerPaymentId, amount: FULL_PHP }));
    await deliver(paymongoDisputeEvent({ paymentId: p.providerPaymentId }));
    await deliver(paymongoPaymentRefundedEvent({ paymentId: p.providerPaymentId, refunds: [{ id: "ref_x", amount: FULL_PHP, status: "succeeded", createdAt: 1700000000 }] }));

    expect(await stateOf(p)).toEqual(before);
    expect((await planStatus(plan)).status).toBe("active");
    expect((await withSystem((db) => studioEntitlement(db, o.org.id))).entitled).toBe(true);
    expect(await workflowRow(studio)).toMatchObject({ status: "active", entitlement_paused_at: null });
    expect(await workflowRow(core)).toMatchObject({ status: "active", entitlement_paused_at: null });
    expect((await maintenanceEligibility(o.org.id)).eligible).toBe(true);
    expect((await rows("select state from client_setup_instances where org_id = $1", [o.org.id]))[0].state).toBe("activated");
  });
});

describe("the PayMongo adapter reads the refund and dispute shapes", () => {
  const read = (body: string) => normalizePaymongoEvent(parseEvent(body)!);

  it("takes the payment from the notice, the refund from its resource or its listing, and numbers only when they are numbers", () => {
    expect(read(paymongoRefundEvent({ eventId: "evt_a_refund", paymentId: "pay_1", refundId: "ref_9", amount: 700, status: "succeeded" }))).toMatchObject({
      kind: "payment_refunded", providerPaymentId: "pay_1", checkoutId: null, paidPayments: [], refund: { id: "ref_9", amountMinor: 700, currency: "PHP", status: "succeeded" },
    });
    const stringAmount = JSON.parse(paymongoRefundEvent({ paymentId: "pay_2", amount: 700 }));
    stringAmount.data.attributes.data.attributes.amount = "700";
    expect(read(JSON.stringify(stringAmount)).refund).toMatchObject({ amountMinor: null });
    expect(read(paymongoPaymentRefundedEvent({ paymentId: "pay_3", refunds: [{ id: "r1", amount: 5, status: "succeeded", createdAt: 1 }, { id: "r2", amount: 9, status: "pending", createdAt: 7 }] }))).toMatchObject({
      kind: "payment_refunded", providerPaymentId: "pay_3", refund: { id: "r2", amountMinor: 9, status: "pending" },
    });
    expect(read(paymongoDisputeEvent({ paymentId: "pay_4", type: "chargeback.opened" }))).toMatchObject({ kind: "payment_disputed", providerPaymentId: "pay_4", refund: null });
  });

  it("leaves every other event alone, and a name that merely contains a word is read by its type, not its payload", () => {
    const other = JSON.stringify({ data: { id: "evt_other_1", type: "event", attributes: { type: "source.chargeable", livemode: false, data: { id: "src_1", type: "source", attributes: { payment_id: "pay_x" } } } } });
    expect(read(other)).toMatchObject({ kind: "other", providerPaymentId: null, refund: null });
    const paid = JSON.parse(paymongoPaidEvent({ checkoutId: "cs_z", reference: "IAQ-Z0000001", amount: 1 }));
    paid.data.attributes.data.attributes.description = "a refund and a dispute were mentioned here";
    expect(read(JSON.stringify(paid)).kind).toBe("payment_paid");
  });

  it("does not slow down on an event name of 20,000 characters", () => {
    const long = JSON.stringify({ data: { id: "evt_long_1", type: "event", attributes: { type: `payment.${"refund".repeat(4000)}`, livemode: false, data: { id: "pay_long", type: "payment", attributes: {} } } } });
    const started = Date.now();
    expect(read(long).kind).toBe("payment_refunded");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
