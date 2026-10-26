// Journey 1, the edges: who is refused, who cannot see it, what a repeat does, what is written down, and what the buyer is told.
//
// journey-1-purchase-to-client.test.ts follows the purchase from invitation to a workspace with six employees waiting for setup. This file asks the questions that file does not:
//   * denied access: only a Super Admin invites a buyer; a manager, a member of staff and a client member are each refused, and a refusal leaves no invitation behind;
//   * tenant isolation: the finished workspace's payment, billing record and employees are invisible to a member of another workspace (row-level security, as the application role),
//     and one buyer's link shows nothing of another buyer's purchase;
//   * duplicates and replays: the paid notice delivered again, and an unsigned one, change nothing;
//   * audit: every step the agency took is in the audit log with who did it and which purchase, and no secret (the link's token, the webhook secret) is in any of it;
//   * what the buyer is told: the words on the return page for a finished purchase and for a reference nobody knows.
//
// The only simulated boundary is PayMongo, exactly as in journey 1: tests/support/billing.ts mockCheckoutFetch and a hand-signed notice. Nothing reaches a provider.
import crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYMONGO_PAYMENT_METHODS = "card,gcash";

import { resetEnvCache } from "@/server/env";
import { withSystem, withUser } from "@/server/db";
import { handlePaymongoWebhook } from "@/server/billing/payments";
import { createPurchaseIntent, getPublicPurchase, listPurchaseIntentEvents, startPurchase } from "@/server/purchase-intents/service";
import { getCheckoutReturn, startPurchaseCheckout } from "@/server/purchase-intents/checkout";
import { addMember, agencyUser, createOrg, createUser } from "../support/fixtures";
import { agencyOrgId, rows, staffPerson } from "../support/staff-messages";
import { mockCheckoutFetch, paymongoPaidEvent, signPaymongo } from "../support/billing";

const NOW = new Date("2026-10-25T12:00:00Z");
const uid = () => crypto.randomUUID().slice(0, 8);
/** A signed-in person who is not on the agency side at all: the same session shape with no platform role. */
const notAgency = (user: Parameters<typeof agencyUser>[0]) => ({ ...agencyUser(user, "agency_staff"), platformRole: "none" as const });
const buyerEmail = () => `journey1b-${uid()}@example.test`;
const invite = (company: string) => ({ buyerName: "Bailey Buyer", buyerEmail: buyerEmail(), company, industry: "Home services", timezone: "America/Chicago", maintenanceSelected: false, autoProvision: true });

const setBilling = () =>
  withSystem((db) => db.query(
    "update agency_billing_settings set purchase_checkout_enabled = true, usd_php_rate = 58, fx_source = 'test fixture', fx_updated_at = now(), live_payments_review_at = now()"));

beforeAll(async () => {
  resetEnvCache();
  await agencyOrgId();
});
beforeEach(() => setBilling());

/** A purchase taken all the way to a provisioned workspace, the way journey 1 does it. */
async function provisioned() {
  const superAdmin = await staffPerson("agency_super_admin");
  const session = agencyUser(superAdmin, "agency_super_admin");
  const company = `Journey One Edge ${uid()}`;
  const created = await createPurchaseIntent(session, invite(company), { now: NOW });
  await startPurchase(created.token, { now: NOW });
  const providerCheckoutId = `cs_journey1b_${uid()}`;
  const checkout = await startPurchaseCheckout(created.token, { ip: "198.51.100.21" }, { fetch: mockCheckoutFetch(providerCheckoutId).impl as never, now: NOW });
  const [row] = await rows<{ charged_amount_minor: string }>("select charged_amount_minor::text from purchase_intent_checkouts where reference_number = $1", [checkout.reference]);
  const body = paymongoPaidEvent({ checkoutId: providerCheckoutId, reference: checkout.reference, amount: Number(row.charged_amount_minor), paymentId: `pay_journey1b_${uid()}`, eventId: `evt_journey1b_${uid()}` });
  expect(await handlePaymongoWebhook({ rawBody: body, signatureHeader: signPaymongo(body) })).toMatchObject({ httpStatus: 200, outcome: "processed" });
  const [intent] = await rows<{ client_org_id: string }>("select client_org_id from purchase_intents where id = $1", [created.id]);
  return { session, created, company, checkout, body, clientOrgId: intent.client_org_id };
}

describe("journey 1: who may start it, who can see it, and what is written down", () => {
  it("is refused to a manager, a member of staff and a client member, and a refusal leaves no invitation behind", async () => {
    const company = `Journey One Refused ${uid()}`;
    for (const role of ["agency_manager", "agency_staff"] as const) {
      const person = await staffPerson(role);
      await expect(createPurchaseIntent(agencyUser(person, role), invite(company), { now: NOW }), role).rejects.toMatchObject({ code: "forbidden" });
    }
    const clientMember = await createUser();
    const org = await createOrg({ name: `Journey One Member Workspace ${uid()}` });
    await addMember(org.id, clientMember.id, "owner");
    await expect(createPurchaseIntent(notAgency(clientMember), invite(company), { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    expect(await rows("select 1 from purchase_intents where company = $1", [company])).toHaveLength(0);
    // Reading the timeline of someone else's purchase is also the agency's alone.
    const superAdmin = agencyUser(await staffPerson("agency_super_admin"), "agency_super_admin");
    const created = await createPurchaseIntent(superAdmin, invite(`Journey One Timeline ${uid()}`), { now: NOW });
    await expect(listPurchaseIntentEvents(notAgency(clientMember), created.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps the finished workspace away from another workspace, and one buyer's link away from another buyer's purchase", async () => {
    const { clientOrgId, created, company } = await provisioned();
    const outsiderOrg = await createOrg({ name: `Journey One Outsider ${uid()}` });
    const outsider = await createUser();
    await addMember(outsiderOrg.id, outsider.id, "owner");
    const seenBy = (userId: string, table: string, column = "org_id") =>
      withUser(userId, async (db) => (await db.query(`select 1 from ${table} where ${column} = $1`, [clientOrgId])).rows.length);
    // The workspace exists and the system sees its rows (a positive control), but a member of another workspace sees none of them as the application role.
    for (const table of ["payments", "billing_accounts", "agent_instances"]) {
      expect((await rows(`select 1 from ${table} where org_id = $1`, [clientOrgId])).length, `${table} exists`).toBeGreaterThan(0);
      expect(await seenBy(outsider.id, table), `${table} seen by an outsider`).toBe(0);
    }
    expect(await seenBy(outsider.id, "organizations", "id")).toBe(0);
    // The purchase itself is the agency's record: no client member can read it.
    expect(await withUser(outsider.id, async (db) => (await db.query("select 1 from purchase_intents where id = $1", [created.id])).rows.length)).toBe(0);

    // A second buyer's link opens the second buyer's offer and nothing of the first.
    const other = await createPurchaseIntent(agencyUser(await staffPerson("agency_super_admin"), "agency_super_admin"), invite(`Journey One Other Buyer ${uid()}`), { now: NOW });
    const view = await getPublicPurchase(other.token, { now: NOW });
    expect(view?.company).not.toBe(company);
    expect(JSON.stringify(view)).not.toContain(created.reference);
    expect(JSON.stringify(view)).not.toContain(created.token);
    expect(await getPublicPurchase(created.token.slice(0, -1) + (created.token.endsWith("a") ? "b" : "a"), { now: NOW })).toBeNull();
  });

  it("changes nothing when the paid notice is delivered again, or arrives unsigned or signed with another secret", async () => {
    const { clientOrgId, body, company } = await provisioned();
    const before = {
      workspaces: (await rows("select 1 from organizations where kind = 'client' and name = $1", [company])).length,
      payments: (await rows("select 1 from payments where org_id = $1", [clientOrgId])).length,
      employees: (await rows("select 1 from agent_instances where org_id = $1", [clientOrgId])).length,
      receipts: (await rows("select 1 from payment_webhook_events")).length,
    };
    expect(await handlePaymongoWebhook({ rawBody: body, signatureHeader: signPaymongo(body) })).toMatchObject({ outcome: "duplicate" });
    expect(await handlePaymongoWebhook({ rawBody: body, signatureHeader: signPaymongo(body, { secret: "whsec_someone_else" }) })).toMatchObject({ httpStatus: 401 });
    expect(await handlePaymongoWebhook({ rawBody: body, signatureHeader: "" })).toMatchObject({ httpStatus: 401 });
    expect({
      workspaces: (await rows("select 1 from organizations where kind = 'client' and name = $1", [company])).length,
      payments: (await rows("select 1 from payments where org_id = $1", [clientOrgId])).length,
      employees: (await rows("select 1 from agent_instances where org_id = $1", [clientOrgId])).length,
      receipts: (await rows("select 1 from payment_webhook_events")).length,
    }).toEqual(before);
  });

  it("writes every agency step to the audit log with who did it and which purchase, and keeps the link and the secrets out of it", async () => {
    const { created, session, clientOrgId } = await provisioned();
    const audit = await rows<{ action: string; actor_user_id: string | null; actor_kind: string; target_id: string; result: string; metadata: unknown }>(
      "select action, actor_user_id, actor_kind, target_id, result, metadata from audit_logs where target_type = 'purchase_intent' and target_id = $1 order by created_at, id", [created.id]);
    const actions = audit.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["purchase_intent.created", "purchase_intent.started", "purchase_intent.provisioned"]));
    const createdRow = audit.find((a) => a.action === "purchase_intent.created");
    expect(createdRow).toMatchObject({ actor_user_id: session.id, actor_kind: "agency", result: "success" });
    // The buyer's own step is attributed to the system, not to a person who did not do it.
    expect(audit.find((a) => a.action === "purchase_intent.started")).toMatchObject({ actor_user_id: null, actor_kind: "system" });
    const everything = JSON.stringify(audit) + JSON.stringify(await listPurchaseIntentEvents(session, created.id));
    expect(everything).not.toContain(created.token);
    expect(everything).not.toContain("whsec_test_only_not_a_real_secret");
    expect(everything).not.toContain("sk_test_notarealkey123");
    // The workspace the purchase created is named in the record, so the agency can find it from the purchase.
    expect(everything).toContain(clientOrgId);
  });

  it("tells the buyer plainly when the workspace is ready, and says nothing about a reference nobody knows", async () => {
    const { checkout } = await provisioned();
    expect((await getCheckoutReturn(checkout.reference)).title).toBe("Your workspace is ready");
    const unknown = await getCheckoutReturn("IAQ-DOESNOTEXIST1");
    expect(JSON.stringify(unknown)).not.toMatch(/workspace is ready|Payment confirmed/i);
    expect(JSON.stringify(unknown)).not.toContain(checkout.reference);
  });
});
