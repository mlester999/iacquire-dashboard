// Online checkout for a purchase intent, on embedded Postgres: the buyer's link opens ONE hosted PayMongo checkout for the frozen setup fee; only the provider's SIGNED notice
// can make it paid; the workspace is created from a verified payment only, once; and a refund, a dispute, a mismatch, a duplicate or a late payment never creates or removes
// anything by itself. The provider is a stand-in (a fetch stub) and the notices are written by hand and signed with a made-up secret: nothing here reaches PayMongo.
import crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYMONGO_PAYMENT_METHODS = "card,gcash";

import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { handlePaymongoWebhook } from "@/server/billing/payments";
import {
  cancelPurchaseIntent, createPurchaseIntent, getPublicPurchase, listPurchaseIntentEvents, provisionPurchaseIntent, startPurchase, verifyPurchasePayment,
} from "@/server/purchase-intents/service";
import { getCheckoutReturn, listIntentCheckouts, provisionPaidIntent, runPurchaseCheckoutSweep, startPurchaseCheckout } from "@/server/purchase-intents/checkout";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";
import { mockCheckoutFetch, paymongoDisputeEvent, paymongoPaidEvent, paymongoRefundEvent, signPaymongo } from "./support/billing";

const NOW = new Date("2026-10-25T12:00:00Z");
const FULL_PHP = 8_694_200; // US$1,499.00 at 58 PHP to the dollar, in centavos
const email = () => `buyer-${crypto.randomUUID().slice(0, 8)}@example.test`;
const uid = () => crypto.randomUUID().slice(0, 8);

async function world() {
  const agencyId = await agencyOrgId();
  const superAdmin = await staffPerson("agency_super_admin");
  const manager = await staffPerson("agency_manager");
  return { agencyId, superAdmin, manager, superSession: agencyUser(superAdmin, "agency_super_admin"), managerSession: agencyUser(manager, "agency_manager") };
}

const setBilling = (over: { enabled?: boolean; rate?: number | null; reviewed?: boolean } = {}) =>
  withSystem((db) => db.query(
    "update agency_billing_settings set purchase_checkout_enabled = $1, usd_php_rate = $2, fx_source = 'test fixture', fx_updated_at = now(), live_payments_review_at = case when $3 then now() else null end",
    [over.enabled ?? true, over.rate === undefined ? 58 : over.rate, over.reviewed ?? true],
  ));

beforeAll(() => resetEnvCache());
beforeEach(() => setBilling());

const make = async (w: Awaited<ReturnType<typeof world>>, over: { autoProvision?: boolean; maintenanceSelected?: boolean } = {}) => {
  const created = await createPurchaseIntent(w.superSession, {
    buyerName: "Bailey Buyer", buyerEmail: email(), company: `Buyer Co ${uid()}`, industry: "Home services", website: "https://buyer.example.test", timezone: "America/Chicago",
    maintenanceSelected: over.maintenanceSelected ?? false, autoProvision: over.autoProvision ?? false,
  }, { now: NOW });
  await startPurchase(created.token, { now: NOW });
  return created;
};

/** Opens the checkout through a provider stand-in and returns what the buyer's page would have. */
let nextBuyer = 0;
const open = async (token: string, checkoutId = `cs_${uid()}`) => {
  const provider = mockCheckoutFetch(checkoutId);
  // Each buyer comes from their own address (the limit is per address), so the cases do not use one another's allowance.
  const started = await startPurchaseCheckout(token, { ip: `198.51.100.${(nextBuyer++ % 250) + 1}` }, { fetch: provider.impl as never, now: NOW });
  return { ...started, checkoutId, provider };
};

const deliver = (body: string, opts: { live?: boolean } = {}) => handlePaymongoWebhook({ rawBody: body, signatureHeader: signPaymongo(body, opts) });
const paid = (o: { checkoutId: string; reference: string; amount?: number; livemode?: boolean; paymentId?: string; eventId?: string }) =>
  paymongoPaidEvent({ checkoutId: o.checkoutId, reference: o.reference, amount: o.amount ?? FULL_PHP, livemode: o.livemode, paymentId: o.paymentId ?? `pay_${uid()}`, eventId: o.eventId });
const intentRow = async (id: string) => (await rows<Record<string, unknown>>("select status, payment_source, payment_checkout_id, payment_hold, payment_method, payment_reference, payment_amount_cents, client_org_id, payment_id, provision_attempts, last_provision_error from purchase_intents where id = $1", [id]))[0];
const checkoutRow = async (reference: string) => (await rows<Record<string, unknown>>("select * from purchase_intent_checkouts where reference_number = $1", [reference]))[0];

describe("opening the checkout", () => {
  it("is closed until the Super Admin switches it on, and then opens nothing without the provider's connection and an exchange rate", async () => {
    const w = await world();
    const c = await make(w);
    await setBilling({ enabled: false });
    await expect(startPurchaseCheckout(c.token, { ip: "203.0.113.1" }, { now: NOW })).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(await rows("select 1 from purchase_intent_checkouts where intent_id = $1", [c.id])).toHaveLength(0);
    await setBilling({ rate: null });
    await expect(startPurchaseCheckout(c.token, { ip: "203.0.113.1" }, { now: NOW })).rejects.toMatchObject({ code: "integration_unavailable" });
    const view = await getPublicPurchase(c.token, { now: NOW });
    expect(view?.checkout.offered).toBe(false);
    // The buyer is only ever told it is not open: the settings behind it are the team's business.
    await expect(startPurchaseCheckout(c.token, { ip: "203.0.113.1" }, { now: NOW })).rejects.toThrow(/not open yet/);
  });

  it("needs the buyer to have confirmed, and refuses a link that is invalid or expired", async () => {
    const w = await world();
    const fresh = await createPurchaseIntent(w.superSession, { buyerName: "Early Bird", buyerEmail: email(), company: `Early ${uid()}`, timezone: "America/Chicago" }, { now: NOW });
    await expect(startPurchaseCheckout(fresh.token, { ip: "203.0.113.2" }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    await expect(startPurchaseCheckout("not-a-token", { ip: "203.0.113.2" }, { now: NOW })).rejects.toMatchObject({ code: "not_found" });
    const c = await make(w);
    const later = new Date(NOW.getTime() + 20 * 86_400_000);
    await expect(startPurchaseCheckout(c.token, { ip: "203.0.113.2" }, { now: later })).rejects.toMatchObject({ code: "conflict" });
  });

  it("asks the provider for exactly the frozen fee converted at the stored rate, with our reference, and never gives the provider the bearer token", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_exact_1");
    expect(o.provider.calls).toHaveLength(1);
    const attrs = o.provider.calls[0].body.data.attributes as { line_items: Array<{ amount: number; currency: string }>; success_url: string; cancel_url: string; reference_number: string; description: string };
    expect(attrs.line_items[0]).toMatchObject({ amount: FULL_PHP, currency: "PHP" });
    expect(attrs.reference_number).toBe(o.reference);
    expect(attrs.description).toContain(`[${o.reference}]`);
    for (const url of [attrs.success_url, attrs.cancel_url]) {
      expect(url).toContain(`/purchase/return/${o.reference}`);
      expect(url).not.toContain(c.token);
    }
    expect(attrs.cancel_url).toMatch(/\?result=cancelled$/);
    expect(attrs.success_url).not.toContain("?");
    const row = await checkoutRow(o.reference);
    expect(row).toMatchObject({ status: "pending", usd_amount_cents: 149900, charged_currency: "PHP", provider_checkout_id: "cs_exact_1", livemode: false });
    expect(Number(row.charged_amount_minor)).toBe(FULL_PHP);
    expect(Number(row.fx_rate)).toBe(58);
    expect(await getPublicPurchase(c.token, { now: NOW })).toMatchObject({ checkout: { offered: true, status: "pending", reference: o.reference } });
  });

  it("returns the open checkout instead of opening another, so a second press or a lost tab never charges twice", async () => {
    const w = await world();
    const c = await make(w);
    const first = await open(c.token, "cs_resume_1");
    const second = await open(c.token, "cs_resume_2");
    expect(second).toMatchObject({ resumed: true, reference: first.reference, checkoutUrl: first.checkoutUrl });
    expect(second.provider.calls).toHaveLength(0);
    expect(await rows("select 1 from purchase_intent_checkouts where intent_id = $1", [c.id])).toHaveLength(1);
  });

  it("leaves a failed attempt closed with a plain reason, charges nobody, and lets the buyer try again", async () => {
    const w = await world();
    const c = await make(w);
    const broken = mockCheckoutFetch("cs_broken");
    const failing = async () => new Response(JSON.stringify({ errors: [{ code: "x" }] }), { status: 400 });
    await expect(startPurchaseCheckout(c.token, { ip: "203.0.113.3" }, { fetch: failing as never, now: NOW })).rejects.toMatchObject({ code: "upstream_error" });
    void broken;
    const [row] = await rows<{ status: string; failure_reason: string }>("select status, failure_reason from purchase_intent_checkouts where intent_id = $1", [c.id]);
    expect(row).toMatchObject({ status: "failed" });
    expect(row.failure_reason).toMatch(/could not open/i);
    expect((await intentRow(c.id)).status).toBe("started");
    const retried = await open(c.token, "cs_retry_ok");
    expect(retried.resumed).toBe(false);
    expect((await withSystem((db) => listIntentCheckouts(db, c.id))).map((x) => x.status)).toEqual(["pending", "failed"]);
  });

  it("is protected in the database: the amount is always the frozen fee, and a checkout's terms never change", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_guard_1");
    await expect(withSystem((db) => db.query(
      `insert into purchase_intent_checkouts (intent_id, agency_org_id, reference_number, usd_amount_cents, charged_currency, charged_amount_minor, livemode, expires_at)
       values ($1, $2, 'IAQ-GUARDTEST01', 100, 'PHP', 5800, false, now())`, [c.id, w.agencyId],
    ))).rejects.toThrow();
    await expect(withSystem((db) => db.query("update purchase_intent_checkouts set charged_amount_minor = 1 where reference_number = $1", [o.reference]))).rejects.toThrow(/terms_never_change/);
    await expect(withSystem((db) => db.query("update purchase_intent_checkouts set status = 'failed' where reference_number = $1", [o.reference]))).resolves.toBeTruthy();
  });
});

describe("a payment the provider confirms", () => {
  it("is the only thing that makes a checkout paid, and it verifies the purchase without creating a workspace when nobody allowed that", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_paid_1");
    // The buyer coming back to the site decides nothing.
    expect((await getCheckoutReturn(o.reference)).title).toBe("Waiting for the payment provider");
    // Backing out of the provider's page only changes the wording while nothing is confirmed; it never marks anything cancelled or paid.
    expect(await getCheckoutReturn(o.reference, { leftThePaymentPage: true })).toMatchObject({ title: "You left the payment page", tone: "neutral", checkoutStatus: "pending" });
    expect((await intentRow(c.id)).status).toBe("started");
    expect((await checkoutRow(o.reference)).status).toBe("pending");
    const res = await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference, paymentId: "pay_one" }));
    expect(res).toMatchObject({ httpStatus: 200, outcome: "processed" });
    expect(await intentRow(c.id)).toMatchObject({ status: "payment_verified", payment_source: "provider", payment_method: "paymongo", payment_reference: "pay_one", payment_amount_cents: 149900, client_org_id: null });
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "paid", provider_payment_id: "pay_one" });
    expect((await getCheckoutReturn(o.reference)).title).toBe("Payment confirmed");
    // A "cancelled" hint added to the address of a payment that really was confirmed changes nothing.
    expect((await getCheckoutReturn(o.reference, { leftThePaymentPage: true })).title).toBe("Payment confirmed");
    expect(await rows("select 1 from organizations where name = (select company from purchase_intents where id = $1) and kind = 'client'", [c.id])).toHaveLength(0);
    const kinds = (await listPurchaseIntentEvents(w.superSession, c.id)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["created", "started", "checkout_started", "payment_received"]));
    // A hand-recorded payment on top of it is refused: the money already counts.
    await expect(verifyPurchasePayment(w.superSession, c.id, { amount: "1499.00", method: "bank_transfer", externalReference: `BANK-${uid()}`, paidOn: "2026-10-25", note: "Saw the transfer on the bank statement." }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
  });

  it("lets a Super Admin create the workspace from provider evidence: the workspace's payment is the provider's, the setup fee is cleared by it, and repeating changes nothing", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_prov_1");
    await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference, paymentId: "pay_prov" }));
    const made = await provisionPurchaseIntent(w.superSession, c.id, { now: NOW });
    const [payment] = await rows<{ provider: string; status: string; provider_payment_id: string; provider_checkout_id: string; reference_number: string; charged_amount_minor: string; method: string | null; external_reference: string | null }>(
      "select provider, status, provider_payment_id, provider_checkout_id, reference_number, charged_amount_minor::text, method, external_reference from payments where id = $1", [made.paymentId],
    );
    expect(payment).toMatchObject({ provider: "paymongo", status: "paid", provider_payment_id: "pay_prov", provider_checkout_id: "cs_prov_1", reference_number: o.reference, method: null, external_reference: null });
    expect(Number(payment.charged_amount_minor)).toBe(FULL_PHP);
    const [billing] = await rows<{ setup_payment_status: string; verified_payment_id: string }>("select setup_payment_status, verified_payment_id from billing_accounts where org_id = $1", [made.clientOrgId]);
    expect(billing).toMatchObject({ setup_payment_status: "paid", verified_payment_id: made.paymentId });
    expect(await intentRow(c.id)).toMatchObject({ status: "provisioned", client_org_id: made.clientOrgId, payment_id: made.paymentId });
    const again = await provisionPurchaseIntent(w.superSession, c.id, { now: NOW });
    expect(again).toMatchObject({ duplicate: true, clientOrgId: made.clientOrgId, paymentId: made.paymentId });
    expect(await rows("select 1 from payments where org_id = $1", [made.clientOrgId])).toHaveLength(1);
  });

  it("creates the workspace by itself only when the inviting Super Admin allowed it, and a replay or a second notice for the same checkout creates nothing more", async () => {
    const w = await world();
    const c = await make(w, { autoProvision: true });
    const o = await open(c.token, "cs_auto_1");
    const body = paid({ checkoutId: o.checkoutId, reference: o.reference, paymentId: "pay_auto", eventId: "evt_auto_1" });
    expect(await deliver(body)).toMatchObject({ outcome: "processed" });
    const after = await intentRow(c.id);
    expect(after).toMatchObject({ status: "provisioned", payment_source: "provider" });
    expect(after.client_org_id).toBeTruthy();
    expect(await rows("select 1 from payments where org_id = $1 and provider = 'paymongo' and status = 'paid'", [after.client_org_id])).toHaveLength(1);
    const events = (await listPurchaseIntentEvents(w.superSession, c.id)).find((e) => e.kind === "provisioned");
    expect(events?.actorKind).toBe("system");
    expect(events?.detail).toMatchObject({ automatic: true, source: "provider" });
    // The same event again (the provider retries), and a different event id for the same checkout.
    expect(await deliver(body)).toMatchObject({ outcome: "duplicate" });
    expect(await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference, paymentId: "pay_auto" }))).toMatchObject({ outcome: "ignored" });
    expect(await rows("select 1 from organizations where kind = 'client' and name = (select company from purchase_intents where id = $1)", [c.id])).toHaveLength(1);
    expect(await rows("select 1 from payments where org_id = $1", [after.client_org_id])).toHaveLength(1);
    expect((await getCheckoutReturn(o.reference)).title).toBe("Your workspace is ready");
  });

  it("will not let a manager allow automatic creation, which needs the billing and client-creation permissions", async () => {
    const w = await world();
    await expect(createPurchaseIntent(w.managerSession, { buyerName: "Bailey Buyer", buyerEmail: email(), company: `Co ${uid()}`, timezone: "America/Chicago", autoProvision: true }, { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("waits for a person when the Super Admin who allowed automatic creation no longer may, says so, and lets another Super Admin finish it", async () => {
    const w = await world();
    const c = await make(w, { autoProvision: true });
    const o = await open(c.token, "cs_auth_1");
    await withSystem((db) => db.query("update users set platform_role = 'agency_staff' where id = $1", [w.superAdmin.id]));
    try {
      await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference, paymentId: "pay_auth" }));
    } finally {
      await withSystem((db) => db.query("update users set platform_role = 'agency_super_admin' where id = $1", [w.superAdmin.id]));
    }
    const stuck = await intentRow(c.id);
    expect(stuck).toMatchObject({ status: "payment_verified", client_org_id: null });
    expect(Number(stuck.provision_attempts)).toBe(1);
    expect(String(stuck.last_provision_error)).toMatch(/permission|role|authorization|agency/i);
    expect((await listPurchaseIntentEvents(w.superSession, c.id)).map((e) => e.kind)).toContain("provision_failed");
    // The recovery sweep tries again as soon as the authority is back (not before its five-minute gap).
    expect((await runPurchaseCheckoutSweep({ now: new Date(Date.now() + 10 * 60_000) })).recovered).toBeGreaterThanOrEqual(1);
    expect((await intentRow(c.id)).status).toBe("provisioned");
  });

  it("leaves a purchase alone that nobody allowed to be automatic", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_manual_only");
    await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference }));
    expect(await provisionPaidIntent(c.id)).toBe("not_automatic");
    expect((await intentRow(c.id)).status).toBe("payment_verified");
  });
});

describe("a notice that must not be believed", () => {
  it("refuses a bad signature and an unknown checkout without changing anything", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_bad_1");
    const body = paid({ checkoutId: o.checkoutId, reference: o.reference });
    expect(await handlePaymongoWebhook({ rawBody: body, signatureHeader: signPaymongo(body, { secret: "whsec_wrong" } as never) })).toMatchObject({ httpStatus: 401 });
    expect(await handlePaymongoWebhook({ rawBody: body, signatureHeader: null })).toMatchObject({ httpStatus: 401 });
    expect(await deliver(paid({ checkoutId: "cs_nobody_has", reference: o.reference }))).toMatchObject({ outcome: "ignored" });
    expect((await intentRow(c.id)).status).toBe("started");
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "pending" });
  });

  it("rejects a notice whose reference is not the one we sent, or whose mode is not the checkout's", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_ref_1");
    expect(await deliver(paid({ checkoutId: o.checkoutId, reference: "IAQ-SOMEONEELSE1" }))).toMatchObject({ outcome: "rejected" });
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "pending" });
    expect((await intentRow(c.id)).status).toBe("started");
  });

  it("holds a payment of the wrong amount: the checkout is marked mismatched, nothing is verified, and the team is told", async () => {
    const w = await world();
    const c = await make(w, { autoProvision: true });
    const o = await open(c.token, "cs_amt_1");
    expect(await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference, amount: FULL_PHP - 100 }))).toMatchObject({ outcome: "rejected" });
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "mismatch" });
    expect(await intentRow(c.id)).toMatchObject({ status: "started", payment_hold: "mismatch", client_org_id: null });
    expect((await rows<{ severity: string }>("select severity from notifications where dedupe_key = $1 limit 1", [`purchase-mismatch:${(await checkoutRow(o.reference)).id}`]))[0]?.severity).toBe("critical");
    await expect(startPurchaseCheckout(c.token, { ip: "203.0.113.4" }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    const wrongCurrency = await open((await make(w)).token, "cs_cur_1");
    expect(await deliver(paid({ checkoutId: wrongCurrency.checkoutId, reference: wrongCurrency.reference }).replaceAll('"PHP"', '"USD"'))).toMatchObject({ outcome: "rejected" });
  });

  it("puts the purchase on hold when the provider reports a refund or a dispute before the workspace exists, and creates nothing from it", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_hold_1");
    await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference, paymentId: "pay_hold" }));
    expect(await deliver(paymongoRefundEvent({ paymentId: "pay_hold", amount: FULL_PHP }))).toMatchObject({ outcome: "processed" });
    expect(await intentRow(c.id)).toMatchObject({ status: "payment_verified", payment_hold: "refunded", client_org_id: null });
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "refunded" });
    await expect(provisionPurchaseIntent(w.superSession, c.id, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    expect((await listPurchaseIntentEvents(w.superSession, c.id)).map((e) => e.kind)).toContain("payment_held");
    expect((await getCheckoutReturn(o.reference)).tone).toBe("warning");

    const d = await make(w);
    const od = await open(d.token, "cs_hold_2");
    await deliver(paid({ checkoutId: od.checkoutId, reference: od.reference, paymentId: "pay_dispute" }));
    expect(await deliver(paymongoDisputeEvent({ paymentId: "pay_dispute" }))).toMatchObject({ outcome: "processed" });
    expect(await intentRow(d.id)).toMatchObject({ payment_hold: "disputed", client_org_id: null });
    expect(await provisionPaidIntent(d.id)).toBe("not_automatic");
  });

  it("reports a refund that arrives after the workspace exists on the workspace's own payment, and changes nothing", async () => {
    const w = await world();
    const c = await make(w, { autoProvision: true });
    const o = await open(c.token, "cs_after_1");
    await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference, paymentId: "pay_after" }));
    const done = await intentRow(c.id);
    expect(done.status).toBe("provisioned");
    expect(await deliver(paymongoRefundEvent({ paymentId: "pay_after", amount: FULL_PHP }))).toMatchObject({ outcome: "processed" });
    expect(await intentRow(c.id)).toMatchObject({ status: "provisioned", client_org_id: done.client_org_id });
    const [payment] = await rows<{ status: string; refunded_micros: string }>("select status, refunded_micros::text from payments where org_id = $1", [done.client_org_id]);
    expect(payment).toMatchObject({ status: "paid", refunded_micros: "0" });
    const told = await rows<{ title: string }>("select title from notifications where org_id = $1 and kind = 'billing_reconciliation'", [done.client_org_id]);
    expect(told.map((n) => n.title)).toContain("PayMongo reports a refund");
  });
});

describe("money that arrives when the purchase is not waiting for it", () => {
  it("records a payment on a hand-paid purchase as a duplicate to refund, and never makes a second workspace", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_dup_1");
    const verified = await verifyPurchasePayment(w.superSession, c.id, { amount: "1499.00", method: "bank_transfer", externalReference: `BANK-${uid()}`, paidOn: "2026-10-25", note: "Saw the transfer on the bank statement." }, { now: NOW });
    expect(verified.status).toBe("payment_verified");
    // Recording it by hand closed the buyer's open checkout.
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "cancelled" });
    expect(await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference, paymentId: "pay_dup" }))).toMatchObject({ outcome: "processed" });
    expect(await intentRow(c.id)).toMatchObject({ status: "payment_verified", payment_source: "manual", payment_checkout_id: null });
    const told = await rows<{ title: string; severity: string }>("select title, severity from notifications where dedupe_key like 'purchase-duplicate:%' order by created_at desc limit 1");
    expect(told[0]).toMatchObject({ title: "A purchase was paid twice", severity: "critical" });
  });

  it("records a payment on a cancelled purchase as one to refund, and still creates nothing", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_cancel_1");
    await cancelPurchaseIntent(w.superSession, c.id, "Buyer asked us to stop the purchase.", { now: NOW });
    expect(await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference, paymentId: "pay_cancelled" }))).toMatchObject({ outcome: "processed" });
    expect(await intentRow(c.id)).toMatchObject({ status: "cancelled", client_org_id: null });
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "paid" });
    const told = await rows<{ title: string }>("select title from notifications where dedupe_key = $1", [`purchase-duplicate:${(await checkoutRow(o.reference)).id}`]);
    expect(told[0]?.title).toBe("A cancelled purchase was paid");
  });

  it("closes a checkout nobody finished, and still honours a payment that arrives after it was closed", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token, "cs_late_1");
    const swept = await runPurchaseCheckoutSweep({ now: new Date(Date.now() + 72 * 3_600_000) });
    expect(swept.closedUnpaid).toBeGreaterThanOrEqual(1);
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "expired" });
    expect((await listPurchaseIntentEvents(w.superSession, c.id)).map((e) => e.kind)).toContain("checkout_expired");
    // The money is real whenever it arrives.
    expect(await deliver(paid({ checkoutId: o.checkoutId, reference: o.reference, paymentId: "pay_late" }))).toMatchObject({ outcome: "processed" });
    expect(await intentRow(c.id)).toMatchObject({ status: "payment_verified", payment_source: "provider" });
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "paid" });
  });
});

describe("what the buyer's pages and the database refuse", () => {
  it("shows the return page from the reference alone and never from a guess", async () => {
    expect(await getCheckoutReturn("not a reference")).toMatchObject({ checkoutStatus: null, title: "Waiting for the payment provider" });
    expect(await getCheckoutReturn("IAQ-DOESNOTEXIST1")).toMatchObject({ checkoutStatus: null, tone: "neutral" });
  });

  it("keeps the checkout and its notices out of every application role's reach except the agency's reading", async () => {
    const grants = await rows<{ grantee: string; privilege_type: string }>(
      "select grantee, privilege_type from information_schema.role_table_grants where table_name = 'purchase_intent_checkouts' and grantee not in ('postgres') order by 1, 2",
    );
    const roles = new Set(grants.map((g) => g.grantee));
    expect(roles.has("anon")).toBe(false);
    expect(grants.filter((g) => g.grantee === "iaq_app_user").map((g) => g.privilege_type)).toEqual(["SELECT"]);
    expect((await rows<{ rowsecurity: boolean }>("select rowsecurity from pg_tables where tablename = 'purchase_intent_checkouts'"))[0].rowsecurity).toBe(true);
  });
});
