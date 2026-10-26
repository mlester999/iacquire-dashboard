import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";
import {
  cancelPurchaseIntent, createPurchaseIntent, getPublicPurchase, getPurchaseIntent, listPurchaseIntentEvents, listPurchaseIntents,
  provisionPurchaseIntent, rotatePurchaseLink, startPurchase, verifyPurchasePayment,
} from "@/server/purchase-intents/service";

// Purchase intents on embedded Postgres: the frozen price, the public bearer link, the buyer's confirmation, a Super Admin's verified payment and the one workspace
// that can follow. Nothing here calls a provider or sends a real invitation: the test environment captures the email the existing client service would send.

const NOW = new Date("2026-10-25T12:00:00Z");
const TODAY = "2026-10-25";
const email = () => `buyer-${crypto.randomUUID().slice(0, 8)}@example.test`;

async function world() {
  const agencyId = await agencyOrgId();
  const superAdmin = await staffPerson("agency_super_admin");
  const manager = await staffPerson("agency_manager");
  const staff = await staffPerson("agency_staff");
  return { agencyId, superAdmin, manager, staff, superSession: agencyUser(superAdmin, "agency_super_admin"), managerSession: agencyUser(manager, "agency_manager"), staffSession: agencyUser(staff, "agency_staff") };
}

const input = (over: Partial<Parameters<typeof createPurchaseIntent>[1]> = {}) => ({
  buyerName: "Bailey Buyer",
  buyerEmail: email(),
  company: `Buyer Co ${crypto.randomUUID().slice(0, 6)}`,
  industry: "Home services",
  website: "https://buyer.example.test",
  timezone: "America/Chicago",
  maintenanceSelected: true,
  ...over,
});

const payment = (over: Partial<Parameters<typeof verifyPurchasePayment>[2]> = {}) => ({
  amount: "1499.00",
  method: "bank_transfer",
  externalReference: `BANK-${crypto.randomUUID().slice(0, 8)}`,
  paidOn: TODAY,
  note: "Saw the transfer on the business bank statement.",
  ...over,
});

const purchaseRows = async (id: string) =>
  rows<{ status: string; token_hash: string; reference: string; client_org_id: string | null; payment_id: string | null; setup_fee_cents: number; maintenance_monthly_cents: number; maintenance_selected: boolean; product_version: string; payment_reference: string | null }>(
    "select status, token_hash, reference, client_org_id, payment_id, setup_fee_cents, maintenance_monthly_cents, maintenance_selected, product_version, payment_reference from purchase_intents where id = $1",
    [id],
  );

describe("creating and confirming a purchase intent", () => {
  it("freezes the approved price and gives the raw link only once; the stored row holds its hash", async () => {
    const w = await world();
    const created = await createPurchaseIntent(w.superSession, input({ buyerName: "Pat Prospect", maintenanceSelected: true }), { now: NOW });
    expect(created.reference).toMatch(/^PUR-[A-Z0-9]+$/);
    const [row] = await purchaseRows(created.id);
    expect(row).toMatchObject({ status: "invited", setup_fee_cents: 149900, maintenance_monthly_cents: 29900, maintenance_selected: true, product_version: "launch-2026-10" });
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(created.token);
    const view = await getPurchaseIntent(w.superSession, created.id, { now: NOW });
    expect(view).toMatchObject({ buyerName: "Pat Prospect", setupFeeCents: 149900, status: "invited", can: expect.objectContaining({ start: true, verify: false, provision: false, cancel: true }) });
    const publicView = await getPublicPurchase(created.token, { now: NOW });
    expect(publicView).toMatchObject({ buyerName: "Pat Prospect", setupFeeCents: 149900, maintenanceSelected: true, canConfirm: true, problem: null });
  });

  it("refuses another open purchase for the same email and refuses a manager who may not manage the funnel", async () => {
    const w = await world();
    const one = input({ buyerEmail: email() });
    await createPurchaseIntent(w.superSession, one, { now: NOW });
    await expect(createPurchaseIntent(w.superSession, one, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    await expect(createPurchaseIntent(w.managerSession, input(), { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(listPurchaseIntents(w.staffSession)).rejects.toMatchObject({ code: "forbidden" });
    const managerList = await listPurchaseIntents(w.managerSession, { now: NOW });
    expect(managerList.length).toBeGreaterThanOrEqual(1);
  });

  it("confirms once, is idempotent, creates no workspace, and refuses an expired or unknown link", async () => {
    const w = await world();
    const created = await createPurchaseIntent(w.superSession, input(), { now: NOW });
    const first = await startPurchase(created.token, { now: NOW });
    expect(first.status).toBe("started");
    const second = await startPurchase(created.token, { now: NOW });
    expect(second.status).toBe("started");
    expect((await listPurchaseIntentEvents(w.superSession, created.id)).filter((e) => e.kind === "started")).toHaveLength(1);
    expect(await rows("select 1 from organizations where created_by = $1 and kind = 'client'", [w.superAdmin.id])).toEqual([]);

    const old = await createPurchaseIntent(w.superSession, input(), { now: new Date(NOW.getTime() - 20 * 86_400_000) });
    expect(await getPublicPurchase(old.token, { now: NOW })).toMatchObject({ status: "expired", canConfirm: false });
    await expect(startPurchase(old.token, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    expect(await getPublicPurchase("x".repeat(43), { now: NOW })).toBeNull();
    expect(await getPublicPurchase("not-a-token", { now: NOW })).toBeNull();
  });

  it("rotates a link so the old one stops working and the new one opens the same purchase", async () => {
    const w = await world();
    const created = await createPurchaseIntent(w.superSession, input(), { now: NOW });
    const rotated = await rotatePurchaseLink(w.superSession, created.id, { now: new Date(NOW.getTime() + 86_400_000) });
    expect(await getPublicPurchase(created.token, { now: NOW })).toBeNull();
    expect(await getPublicPurchase(rotated.token, { now: NOW })).toMatchObject({ reference: created.reference, canConfirm: true });
  });
});

describe("verified payment and the one workspace", () => {
  it("refuses payment before confirmation and a wrong amount, then records the exact fee and creates one workspace idempotently", async () => {
    const w = await world();
    const created = await createPurchaseIntent(w.superSession, input(), { now: NOW });
    await expect(verifyPurchasePayment(w.superSession, created.id, payment(), { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    await startPurchase(created.token, { now: NOW });
    await expect(verifyPurchasePayment(w.managerSession, created.id, payment(), { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(verifyPurchasePayment(w.superSession, created.id, payment({ amount: "1499.01" }), { now: NOW })).rejects.toMatchObject({ code: "invalid_input" });
    const verified = await verifyPurchasePayment(w.superSession, created.id, payment(), { now: NOW });
    expect(verified).toMatchObject({ status: "payment_verified", can: expect.objectContaining({ provision: true, verify: false }) });
    expect(await rows("select 1 from organizations where created_by = $1 and kind = 'client'", [w.superAdmin.id])).toEqual([]);

    const made = await provisionPurchaseIntent(w.superSession, created.id, { now: NOW });
    expect(made.duplicate).toBe(false);
    const [row] = await purchaseRows(created.id);
    expect(row).toMatchObject({ status: "provisioned", client_org_id: made.clientOrgId, payment_id: made.paymentId, payment_reference: expect.any(String) });
    const [org] = await rows<{ kind: string; name: string; status: string }>("select kind, name, status from organizations where id = $1", [made.clientOrgId]);
    expect(org).toMatchObject({ kind: "client", status: "invited" });
    const [billing] = await rows<{ setup_payment_status: string; verified_payment_id: string | null }>("select setup_payment_status, verified_payment_id from billing_accounts where org_id = $1", [made.clientOrgId]);
    expect(billing).toMatchObject({ setup_payment_status: "paid", verified_payment_id: made.paymentId });
    const [canonical] = await rows<{ kind: string; status: string; usd_amount_micros: string; provider: string }>("select kind, status, usd_amount_micros::text, provider from payments where id = $1", [made.paymentId]);
    expect(canonical).toMatchObject({ kind: "setup_fee", provider: "manual" });
    expect(Number(canonical.usd_amount_micros)).toBe(1_499_000_000);
    const events = await listPurchaseIntentEvents(w.superSession, created.id);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["created", "started", "payment_verified", "workspace_created", "provisioned"]));

    const again = await provisionPurchaseIntent(w.superSession, created.id, { now: NOW });
    expect(again).toMatchObject({ duplicate: true, clientOrgId: made.clientOrgId, paymentId: made.paymentId });
    expect(await rows("select 1 from organizations where kind = 'client' and name = $1", [org.name])).toHaveLength(1);
    expect(await rows("select 1 from payments where org_id = $1", [made.clientOrgId])).toHaveLength(1);
  });

  it("cancels an unpaid purchase and will not reopen it through a new link", async () => {
    const w = await world();
    const created = await createPurchaseIntent(w.superSession, input(), { now: NOW });
    await startPurchase(created.token, { now: NOW });
    const cancelled = await cancelPurchaseIntent(w.superSession, created.id, "Buyer chose to wait until next quarter.", { now: NOW });
    expect(cancelled.status).toBe("cancelled");
    expect(await getPublicPurchase(created.token, { now: NOW })).toMatchObject({ status: "cancelled", canConfirm: false });
    await expect(rotatePurchaseLink(w.superSession, created.id, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    await expect(cancelPurchaseIntent(w.superSession, created.id, "A second cancellation with a reason.", { now: NOW })).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps one agency's purchases out of another caller's list, and records no raw token in the timeline", async () => {
    const w = await world();
    const created = await createPurchaseIntent(w.superSession, input(), { now: NOW });
    const managerList = await listPurchaseIntents(w.managerSession, { now: NOW });
    expect(managerList.map((i) => i.id)).toContain(created.id);
    await expect(getPurchaseIntent(w.staffSession, created.id, { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    const events = await withSystem((db) => db.query<{ detail: unknown }>("select detail from purchase_intent_events where intent_id = $1", [created.id])).then((r) => r.rows);
    expect(JSON.stringify(events)).not.toContain(created.token);
    expect(await rows("select 1 from purchase_intents where agency_org_id <> $1", [w.agencyId])).toEqual([]);
  });
});
