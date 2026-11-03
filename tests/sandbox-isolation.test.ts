// Money from a payment provider's test mode (PayPal Sandbox, PayMongo test keys) moved nothing real. On the LIVE site it must never clear a setup fee, add credits, extend a plan,
// start an employee's provisioning or create a workspace, and it must not be counted as money received; everywhere else (a developer's machine, a preview, these tests) the same
// payment must go all the way, because that is the isolated place to prove a whole journey. The providers are stand-ins written from their documentation: nothing here reaches them.
import crypto from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYPAL_CLIENT_ID = "AaTestClientIdNotReal0123456789";
process.env.PAYPAL_CLIENT_SECRET = "EkTestSecretNotReal0123456789abc";
process.env.PAYPAL_WEBHOOK_ID = "WH-TEST-0123456789";
process.env.PAYPAL_ENVIRONMENT = "sandbox";

import { resetEnvCache, setLiveDeploymentForTests } from "@/server/env";
import { withSystem } from "@/server/db";
import { handlePaymongoWebhook } from "@/server/billing/payments";
import { getBalance } from "@/server/billing/ledger";
import { setExchangeRate, startTopUp } from "@/server/billing/service";
import { cancelPurchaseIntent, createPurchaseIntent, getPublicPurchase, getPurchaseIntent, provisionPurchaseIntent, startPurchase } from "@/server/purchase-intents/service";
import { completePaypalPurchaseReturn, getCheckoutReturn, provisionPaidIntent, runPurchaseCheckoutSweep, startPurchaseCheckout } from "@/server/purchase-intents/checkout";
import { SANDBOX_PAYMENT_TEXT } from "@/lib/purchase-intents/rules";
import { agencyUser, addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";
import { evt, mockCheckoutFetch, paymongoPaidEvent, signPaymongo } from "./support/billing";
import { fakePaypal, type FakePaypal } from "./support/paypal-agency";

const NOW = new Date();
const uid = () => crypto.randomUUID().slice(0, 8);
const email = () => `buyer-${uid()}@example.test`;

let pp: FakePaypal;
beforeAll(() => resetEnvCache());
beforeEach(async () => {
  await withSystem((db) => db.query(
    "update agency_billing_settings set purchase_checkout_enabled = true, usd_php_rate = 58, fx_source = 'test fixture', fx_updated_at = now(), live_payments_review_at = now()",
  ));
  await withSystem((db) => db.query("update purchase_intent_checkouts set status = 'cancelled', failure_reason = 'test cleanup' where provider = 'paypal' and status in ('creating', 'pending')"));
  pp = fakePaypal();
});
afterEach(() => setLiveDeploymentForTests(null));

async function world() {
  const superAdmin = await staffPerson("agency_super_admin");
  return { agencyId: await agencyOrgId(), superSession: agencyUser(superAdmin, "agency_super_admin") };
}
type World = Awaited<ReturnType<typeof world>>;

let nextBuyer = 0;
const ip = () => `203.0.113.${(nextBuyer++ % 250) + 1}`;
const clientOrgs = async () => Number((await rows<{ n: string }>("select count(*)::text as n from organizations where kind = 'client'"))[0].n);
const intentRow = async (id: string) => (await rows<Record<string, unknown>>("select status, payment_source, client_org_id, payment_id, provision_attempts from purchase_intents where id = $1", [id]))[0];
const checkoutRow = async (reference: string) => (await rows<Record<string, unknown>>("select * from purchase_intent_checkouts where reference_number = $1", [reference]))[0];

/** An invited buyer who confirmed, opened a PayPal order in the sandbox, approved it, and came back: the server captured it. */
async function paidInSandbox(w: World, over: { autoProvision?: boolean } = {}) {
  const created = await createPurchaseIntent(w.superSession, {
    buyerName: "Bailey Buyer", buyerEmail: email(), company: `Sandbox Buyer Co ${uid()}`, industry: "Home services", website: "https://buyer.example.test", timezone: "America/Chicago",
    maintenanceSelected: false, autoProvision: over.autoProvision ?? false,
  }, { now: NOW });
  await startPurchase(created.token, { now: NOW });
  const o = await startPurchaseCheckout(created.token, { ip: ip(), provider: "paypal" }, { now: NOW, paypal: { wire: pp.wire } });
  pp.approve(pp.byReference(o.reference)!.id);
  expect(await completePaypalPurchaseReturn(o.reference, { ip: ip() }, { paypal: { wire: pp.wire } })).toEqual({ state: "paid" });
  return { created, o };
}

describe("a sandbox purchase payment on the live site", () => {
  it("is recorded and labelled as the test it was, and creates nothing, clears nothing and starts nothing", async () => {
    setLiveDeploymentForTests(true);
    const w = await world();
    const before = await clientOrgs();
    const { created, o } = await paidInSandbox(w, { autoProvision: true });
    const checkout = await checkoutRow(o.reference);
    expect(checkout).toMatchObject({ status: "paid", livemode: false });

    // Nothing real: no workspace (even though automatic creation was allowed), no payment row, no attempt to provision.
    expect(await intentRow(created.id)).toMatchObject({ status: "payment_verified", payment_source: "provider", client_org_id: null, payment_id: null, provision_attempts: 0 });
    expect(await clientOrgs()).toBe(before);
    expect(await rows("select 1 from payments where provider = 'paypal' and provider_checkout_id = $1", [checkout.provider_checkout_id])).toHaveLength(0);

    // Labelled everywhere it is read: the team's view, the timeline, the notice, the buyer's page and the page the buyer returns to.
    const view = await getPurchaseIntent(w.superSession, created.id, { now: NOW });
    expect(view).toMatchObject({ sandboxOnLive: true, status: "payment_verified", statusText: "Sandbox payment (test)", statusTone: "neutral", can: expect.objectContaining({ provision: false, cancel: true }) });
    const received = await rows<{ detail: Record<string, unknown> }>("select detail from purchase_intent_events where intent_id = $1 and kind = 'payment_received'", [created.id]);
    expect(received).toHaveLength(1);
    expect(received[0].detail).toMatchObject({ sandbox: true });
    // (The notice goes to every Super Admin, one row each, so it is checked for existing and for being the sandbox one.)
    expect(await rows("select 1 from notifications where dedupe_key = $1 and severity = 'info' and title like 'A SANDBOX purchase payment%'", [`purchase-sandbox:${checkout.id}`])).not.toHaveLength(0);
    expect(await rows("select 1 from notifications where dedupe_key = $1", [`purchase-paid:${checkout.id}`])).toHaveLength(0);
    expect((await getPublicPurchase(created.token, { now: NOW }))?.problem).toMatch(/test payment in the payment provider's sandbox\. No real money moved, and no workspace will be created/);
    expect(await getCheckoutReturn(o.reference)).toMatchObject({ checkoutStatus: "paid", tone: "neutral", title: "Test payment recorded" });
  });

  it("cannot be turned into a workspace by a person, by the automatic route or by the recovery sweep, and can be closed as a test", async () => {
    setLiveDeploymentForTests(true);
    const w = await world();
    const { created } = await paidInSandbox(w, { autoProvision: true });
    const before = await clientOrgs();

    await expect(provisionPurchaseIntent(w.superSession, created.id, { now: NOW })).rejects.toMatchObject({ code: "conflict", message: SANDBOX_PAYMENT_TEXT });
    expect(await provisionPaidIntent(created.id, { now: NOW })).toBe("waiting_for_a_person");
    expect(await runPurchaseCheckoutSweep({ now: NOW, paypal: { wire: pp.wire } })).toMatchObject({ recovered: 0 });
    expect(await clientOrgs()).toBe(before);
    // No attempt is counted or retried, so nothing keeps coming back to the team about it.
    expect(await intentRow(created.id)).toMatchObject({ status: "payment_verified", client_org_id: null, provision_attempts: 0 });

    const closed = await cancelPurchaseIntent(w.superSession, created.id, "A sandbox test purchase: closing it.", { now: NOW });
    expect(closed).toMatchObject({ status: "cancelled", statusText: "Closed: sandbox test", sandboxOnLive: true });
    const audit = await rows<{ action: string; metadata: Record<string, unknown> }>("select action, metadata from audit_logs where target_id = $1 and action = 'purchase_intent.closed_after_payment'", [created.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ sandbox: true });
    expect(await clientOrgs()).toBe(before);
  });
});

describe("the same sandbox payment off the live site: the isolated route for acceptance", () => {
  it("goes all the way, so a whole journey can be proved without touching the live site", async () => {
    setLiveDeploymentForTests(false);
    const w = await world();
    const { created, o } = await paidInSandbox(w);
    const view = await getPurchaseIntent(w.superSession, created.id, { now: NOW });
    expect(view).toMatchObject({ sandboxOnLive: false, statusText: "Payment verified", can: expect.objectContaining({ provision: true }) });
    expect(await getCheckoutReturn(o.reference)).toMatchObject({ title: "Payment confirmed" });
    expect(await rows("select 1 from notifications where dedupe_key = $1 and severity = 'success'", [`purchase-paid:${(await checkoutRow(o.reference)).id}`])).not.toHaveLength(0);

    const done = await provisionPurchaseIntent(w.superSession, created.id, { now: NOW });
    expect(done.clientOrgId).toBeTruthy();
    expect(await rows("select kind, status, livemode from payments where org_id = $1", [done.clientOrgId])).toEqual([{ kind: "setup_fee", status: "paid", livemode: false }]);
    expect(await rows("select setup_payment_status from billing_accounts where org_id = $1", [done.clientOrgId])).toEqual([{ setup_payment_status: "paid" }]);
  });

  it("creates the workspace by itself when the inviting Super Admin allowed it", async () => {
    setLiveDeploymentForTests(false);
    const w = await world();
    const { created } = await paidInSandbox(w, { autoProvision: true });
    expect(await intentRow(created.id)).toMatchObject({ status: "provisioned" });
    expect((await intentRow(created.id)).client_org_id).toBeTruthy();
  });
});

describe("a test-mode payment started inside a client's workspace", () => {
  async function topUp(checkoutId: string) {
    const org = await createOrg({ name: `Sandbox Isolation Co ${uid()}` });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const admin = await createUser({ platformRole: "agency_super_admin" });
    await setExchangeRate({ id: admin.id, platformRole: "agency_super_admin" }, { usdPhpRate: 58, source: "Test fixture rate (not a market rate)" });
    const started = await startTopUp(ctxFor(owner, org, "owner"), 25, { fetch: mockCheckoutFetch(checkoutId).impl });
    const paid = () => {
      const body = paymongoPaidEvent({ eventId: evt(), checkoutId, reference: started.referenceNumber, amount: 145000 });
      return handlePaymongoWebhook({ rawBody: body, signatureHeader: signPaymongo(body) });
    };
    const payment = async () => (await rows<{ status: string; failure_reason: string | null; livemode: boolean }>("select status, failure_reason, livemode from payments where id = $1", [started.paymentId]))[0];
    const balance = async () => (await withSystem((db) => getBalance(db, org.id))).balanceMicros;
    return { org, paid, payment, balance, paymentId: started.paymentId };
  }

  it("grants nothing on the live site, is never marked paid (so no statement counts it as money received), and tells the team", async () => {
    const t = await topUp(`cs_sbx_live_${uid()}`);
    const before = await t.balance();
    setLiveDeploymentForTests(true);
    expect(await t.paid()).toMatchObject({ httpStatus: 200, outcome: "ignored", detail: expect.stringMatching(/test-mode payment on the live site: nothing was applied/) });
    expect(await t.payment()).toMatchObject({ status: "mismatch", livemode: false, failure_reason: expect.stringMatching(/test mode reached the live site/) });
    expect(await t.balance()).toBe(before);
    expect(await rows("select 1 from credit_ledger_entries where org_id = $1 and kind = 'credits_granted'", [t.org.id])).toHaveLength(0);
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'billing.sandbox_payment_not_applied'", [t.org.id])).toHaveLength(1);
    expect(await rows("select 1 from notifications where dedupe_key = $1 and title = 'A TEST-MODE payment reached the live site'", [`sandbox-on-live:${t.paymentId}`])).not.toHaveLength(0);
    // Another notice for the same payment (the provider retries) changes nothing: still not paid, still no credit.
    expect(await t.paid()).toMatchObject({ httpStatus: 200 });
    expect(await t.payment()).toMatchObject({ status: "mismatch" });
    expect(await t.balance()).toBe(before);
  });

  it("grants the credits as before off the live site (the isolated route)", async () => {
    const t = await topUp(`cs_sbx_iso_${uid()}`);
    const before = await t.balance();
    setLiveDeploymentForTests(false);
    expect(await t.paid()).toMatchObject({ httpStatus: 200, outcome: "processed" });
    expect(await t.payment()).toMatchObject({ status: "paid", livemode: false });
    expect((await t.balance()) - before).toBe(25_000_000);
  });
});
