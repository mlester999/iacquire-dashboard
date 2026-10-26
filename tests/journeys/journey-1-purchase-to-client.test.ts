// Journey 1: a purchase becomes an operational client, across four services instead of inside one module.
//
// A Super Admin invites a buyer (the purchase-intents service), the buyer opens their public link and confirms (the same service, as the buyer), the online checkout
// opens against PayMongo (the checkout service and its provider adapter), the provider's signed "paid" notice arrives at the billing webhook, and the workspace the
// buyer was promised is created once with its six AI employees waiting for setup.
//
// The external boundary is PayMongo. It is simulated on purpose and only here:
//   * opening a checkout: tests/support/billing.ts mockCheckoutFetch answers with a made-up checkout id and records what was asked; no socket is opened;
//   * the payment notice: tests/support/billing.ts paymongoPaidEvent writes the body by hand and signPaymongo signs it with a made-up webhook secret.
// Nothing in this file reaches a payment provider, and the tests assert what the product does with those stands-in answers.
import crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYMONGO_PAYMENT_METHODS = "card,gcash";

import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { handlePaymongoWebhook } from "@/server/billing/payments";
import { createPurchaseIntent, getPublicPurchase, listPurchaseIntentEvents, startPurchase } from "@/server/purchase-intents/service";
import { getCheckoutReturn, startPurchaseCheckout } from "@/server/purchase-intents/checkout";
import { AGENT_ROLE_KEYS, SETUP_REQUIRED_LABEL } from "@/lib/agents";
import { agencyUser } from "../support/fixtures";
import { agencyOrgId, rows, staffPerson } from "../support/staff-messages";
import { mockCheckoutFetch, paymongoPaidEvent, signPaymongo } from "../support/billing";

const NOW = new Date("2026-10-25T12:00:00Z");
const buyerEmail = () => `journey1-${crypto.randomUUID().slice(0, 8)}@example.test`;
const uid = () => crypto.randomUUID().slice(0, 8);

/** The agency's billing switches: online checkout open, an exchange rate stored, the live-payment review recorded (all set the way the agency screens leave them). */
const setBilling = (over: { enabled?: boolean; rate?: number | null; reviewed?: boolean } = {}) =>
  withSystem((db) => db.query(
    "update agency_billing_settings set purchase_checkout_enabled = $1, usd_php_rate = $2, fx_source = 'test fixture', fx_updated_at = now(), live_payments_review_at = case when $3 then now() else null end",
    [over.enabled ?? true, over.rate === undefined ? 58 : over.rate, over.reviewed ?? true],
  ));

beforeAll(() => resetEnvCache());
beforeEach(() => setBilling());

describe("a purchase becomes an operational client", () => {
  it("goes from an invitation, through a signed provider payment, to one workspace with six employees waiting for setup", async () => {
    const agencyId = await agencyOrgId();
    const superAdmin = await staffPerson("agency_super_admin");
    const session = agencyUser(superAdmin, "agency_super_admin");

    // 1. The Super Admin invites a buyer. The buyer is allowed to let the payment create the workspace by itself, which is a decision about billing and client
    // creation as well as about the buyer; the frozen setup fee is what the buyer will be asked to pay.
    const company = `Journey One Roofing ${uid()}`;
    const created = await createPurchaseIntent(session, {
      buyerName: "Bailey Buyer",
      buyerEmail: buyerEmail(),
      company,
      industry: "Home services",
      website: "https://buyer.example.test",
      timezone: "America/Chicago",
      maintenanceSelected: false,
      autoProvision: true,
    }, { now: NOW });
    // The reference is the purchase's public name: the buyer comes back by it, and it is what the provider is given. It is not the bearer token.
    expect(created.reference).toMatch(/^[A-Z]+-[A-Z0-9]+$/);
    expect(created.reference).not.toBe(created.token);

    // 2. The buyer opens the public link. It shows the offer and asks them to confirm; no checkout is offered until they do, and the raw token is the only
    // thing that opens it (the page carries the company and the price, never an id the agency's own screens use).
    const invited = await getPublicPurchase(created.token, { now: NOW });
    expect(invited).toMatchObject({ company, buyerName: "Bailey Buyer", status: "invited", canConfirm: true, checkout: { offered: false } });
    expect(invited?.setupFeeCents).toBeGreaterThan(0);
    expect(await getPublicPurchase("not-a-token", { now: NOW })).toBeNull();

    // 3. The buyer confirms. That is all the confirmation does: it moves the purchase to "started" and offers the online checkout.
    const started = await startPurchase(created.token, { now: NOW });
    expect(started).toMatchObject({ status: "started" });
    const offered = await getPublicPurchase(created.token, { now: NOW });
    expect(offered?.checkout).toMatchObject({ offered: true, status: null });

    // 4. The buyer presses Pay. The provider stand-in answers; the checkout is opened for exactly the frozen fee converted at the stored rate, and our own
    // reference (never the buyer's bearer token) is what travels to the provider and comes back on the notice.
    const providerCheckoutId = `cs_journey1_${uid()}`;
    const provider = mockCheckoutFetch(providerCheckoutId);
    const checkout = await startPurchaseCheckout(created.token, { ip: "198.51.100.11" }, { fetch: provider.impl as never, now: NOW });
    expect(checkout.resumed).toBe(false);
    expect(provider.calls).toHaveLength(1);
    const sent = provider.calls[0].body.data.attributes as { line_items: Array<{ amount: number; currency: string }>; reference_number: string; success_url: string };
    expect(sent.reference_number).toBe(checkout.reference);
    expect(sent.line_items[0].currency).toBe("PHP");
    expect(sent.success_url).not.toContain(created.token);

    const [checkoutRow] = await rows<{ charged_amount_minor: string; usd_amount_cents: number; status: string }>(
      "select charged_amount_minor::text, usd_amount_cents, status from purchase_intent_checkouts where reference_number = $1", [checkout.reference],
    );
    expect(checkoutRow.status).toBe("pending");
    // The buyer is charged the frozen fee: the dollar price frozen on the invitation, converted once and stored on the checkout.
    expect(Number(checkoutRow.usd_amount_cents)).toBe(invited?.setupFeeCents);
    const chargedMinor = Number(checkoutRow.charged_amount_minor);
    expect(chargedMinor).toBeGreaterThan(0);

    // 5. A notice nobody signed is refused, and it changes nothing: the signature is what makes a payment real.
    const paidBody = paymongoPaidEvent({
      checkoutId: providerCheckoutId,
      reference: checkout.reference,
      amount: chargedMinor,
      paymentId: `pay_journey1_${uid()}`,
      eventId: `evt_journey1_${uid()}`,
    });
    expect(await handlePaymongoWebhook({ rawBody: paidBody, signatureHeader: signPaymongo(paidBody, { secret: "whsec_wrong" }) })).toMatchObject({ httpStatus: 401 });
    expect((await rows<{ status: string }>("select status from purchase_intents where id = $1", [created.id]))[0].status).toBe("started");
    expect(await rows("select 1 from organizations where kind = 'client' and name = $1", [company])).toHaveLength(0);

    // 6. The correctly signed notice is believed. Because the inviting Super Admin allowed it, the verified payment creates the workspace by itself: the buyer
    // never talks to anyone, and the purchase is paid, verified and provisioned from the provider's evidence alone.
    const delivered = await handlePaymongoWebhook({ rawBody: paidBody, signatureHeader: signPaymongo(paidBody) });
    expect(delivered).toMatchObject({ httpStatus: 200, outcome: "processed" });
    const paidIntent = (await rows<{ status: string; payment_source: string; client_org_id: string | null }>("select status, payment_source, client_org_id from purchase_intents where id = $1", [created.id]))[0];
    expect(paidIntent).toMatchObject({ status: "provisioned", payment_source: "provider" });
    expect(paidIntent.client_org_id).toBeTruthy();
    const clientOrgId = paidIntent.client_org_id as string;

    // 7. The workspace is the one the buyer was promised, it belongs to the agency's purchase, and it exists exactly once.
    const org = (await rows<{ name: string; kind: string; status: string }>("select name, kind, status from organizations where id = $1", [clientOrgId]))[0];
    expect(org).toMatchObject({ name: company, kind: "client" });
    expect(await rows("select 1 from organizations where name = $1 and kind = 'client'", [company])).toHaveLength(1);
    const [billing] = await rows<{ setup_payment_status: string; verified_payment_id: string }>("select setup_payment_status, verified_payment_id from billing_accounts where org_id = $1", [clientOrgId]);
    expect(billing.setup_payment_status).toBe("paid");
    expect(await rows("select 1 from payments where org_id = $1 and provider = 'paymongo' and status = 'paid'", [clientOrgId])).toHaveLength(1);
    // The agency's own record ties the client workspace to this purchase, and the buyer sees the finished page.
    expect((await rows<{ agency_org_id: string; status: string; client_org_id: string }>("select agency_org_id, status, client_org_id from purchase_intents where id = $1", [created.id]))[0]).toMatchObject({ agency_org_id: agencyId, client_org_id: clientOrgId });
    expect((await getCheckoutReturn(checkout.reference)).title).toBe("Your workspace is ready");

    // 8. All six AI employees came with the workspace, switched on and waiting for setup. "Setup required" is the product's own wording for an employee whose
    // dedicated profile has not been connected yet; none of them is left out, and none is pretending to be working.
    const agents = await rows<{ role_key: string; status: string; enabled: boolean; display_name: string }>(
      "select role_key, status, enabled, display_name from agent_instances where org_id = $1 order by role_key", [clientOrgId],
    );
    expect(agents.map((a) => a.role_key).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    expect(agents).toHaveLength(6);
    expect(SETUP_REQUIRED_LABEL).toBe("Setup required");
    for (const agent of agents) {
      expect(agent).toMatchObject({ status: "setup_required", enabled: true });
      expect(agent.display_name.length).toBeGreaterThan(0);
    }

    // 9. The provider retries its notice (the same event id) and then sends another one for the same checkout. Neither creates a second workspace, a second
    // payment, or a second set of employees, and neither adds a second "provisioned" line to the purchase's timeline.
    expect(await handlePaymongoWebhook({ rawBody: paidBody, signatureHeader: signPaymongo(paidBody) })).toMatchObject({ outcome: "duplicate" });
    const otherEvent = paymongoPaidEvent({
      checkoutId: providerCheckoutId,
      reference: checkout.reference,
      amount: chargedMinor,
      paymentId: `pay_journey1_${uid()}`,
    });
    expect(await handlePaymongoWebhook({ rawBody: otherEvent, signatureHeader: signPaymongo(otherEvent) })).toMatchObject({ outcome: "ignored" });
    expect(await rows("select 1 from organizations where kind = 'client' and name = $1", [company])).toHaveLength(1);
    expect(await rows("select 1 from payments where org_id = $1", [clientOrgId])).toHaveLength(1);
    expect(await rows("select 1 from agent_instances where org_id = $1", [clientOrgId])).toHaveLength(6);

    // The purchase's timeline is the agency's account of what happened, one line per real step.
    const events = (await listPurchaseIntentEvents(session, created.id)).map((e) => e.kind);
    expect(events.filter((k) => k === "provisioned")).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining(["created", "started", "checkout_started", "payment_received", "workspace_created", "provisioned"]));
  });

  it("creates no workspace from a payment the buyer never confirmed, so the invitation is not a sale", async () => {
    // The same journey stopped one step earlier: the buyer opened the link but confirmed nothing, so pressing Pay is refused and no money, workspace or
    // employee exists afterwards. This is the guard that keeps a link from being treated as a sale.
    const superAdmin = await staffPerson("agency_super_admin");
    const session = agencyUser(superAdmin, "agency_super_admin");
    const company = `Journey One Unconfirmed ${uid()}`;
    const created = await createPurchaseIntent(session, {
      buyerName: "Early Bird", buyerEmail: buyerEmail(), company, timezone: "America/Chicago", maintenanceSelected: false, autoProvision: true,
    }, { now: NOW });
    const unconfirmed = await getPublicPurchase(created.token, { now: NOW });
    expect(unconfirmed).toMatchObject({ status: "invited", canConfirm: true, checkout: { offered: false } });
    await expect(startPurchaseCheckout(created.token, { ip: "198.51.100.12" }, { fetch: mockCheckoutFetch("cs_journey1_unconfirmed").impl as never, now: NOW }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await rows("select 1 from purchase_intent_checkouts where intent_id = $1", [created.id])).toHaveLength(0);
    expect(await rows("select 1 from organizations where kind = 'client' and name = $1", [company])).toHaveLength(0);
  });
});
