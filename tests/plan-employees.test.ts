// New purchases provision one Growth Partner identity while preserving the existing product terms. Unknown product keys still fail safe to the same identity and leave an audit row.
// Embedded Postgres; nothing here calls a provider.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { AI_GROWTH_PARTNER_ROLE_KEY, type WorkforceRoleKey } from "@/lib/agents";
import { PRODUCT_VERSION } from "@/lib/purchase-intents/rules";
import { KNOWN_PLAN_KEYS, PLAN_EMPLOYEES, rolesForPlan } from "@/lib/plan-employees";
import { withSystem } from "@/server/db";
import { createPurchaseIntent, provisionPurchaseIntent, startPurchase, verifyPurchasePayment } from "@/server/purchase-intents/service";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";

const NOW = new Date("2026-10-25T12:00:00Z");
const TODAY = "2026-10-25";

describe("the purchase-to-runtime identity table", () => {
  it("lists the product the purchase catalogue knows and gives it one Growth Partner", () => {
    expect([...KNOWN_PLAN_KEYS]).toEqual([PRODUCT_VERSION]);
    expect(PLAN_EMPLOYEES[PRODUCT_VERSION]).toEqual([AI_GROWTH_PARTNER_ROLE_KEY]);
    expect(rolesForPlan(PRODUCT_VERSION)).toEqual({ roles: [AI_GROWTH_PARTNER_ROLE_KEY], defaulted: false });
  });

  it("gives an unknown or missing product one Growth Partner and says it did", () => {
    for (const key of [undefined, null, "", "launch-2099-01", "__proto__", "constructor", "toString"]) {
      expect(rolesForPlan(key as string | null | undefined), String(key)).toEqual({ roles: [AI_GROWTH_PARTNER_ROLE_KEY], defaulted: true });
    }
  });

  it("keeps identity mapping unique and falls back safely for empty or invalid entries", () => {
    const table: Readonly<Record<string, readonly WorkforceRoleKey[]>> = {
      "partner-plan": [AI_GROWTH_PARTNER_ROLE_KEY, AI_GROWTH_PARTNER_ROLE_KEY],
      empty: [],
      junk: ["not_a_role" as WorkforceRoleKey],
    };
    expect(rolesForPlan("partner-plan", table)).toEqual({ roles: [AI_GROWTH_PARTNER_ROLE_KEY], defaulted: false });
    expect(rolesForPlan("empty", table)).toEqual({ roles: [AI_GROWTH_PARTNER_ROLE_KEY], defaulted: true });
    expect(rolesForPlan("junk", table)).toEqual({ roles: [AI_GROWTH_PARTNER_ROLE_KEY], defaulted: true });
  });
});

async function world() {
  const agencyId = await agencyOrgId();
  const superAdmin = await staffPerson("agency_super_admin");
  return { agencyId, superAdmin, session: agencyUser(superAdmin, "agency_super_admin") };
}
const buyer = () => ({
  buyerName: "Bailey Buyer", buyerEmail: `buyer-${crypto.randomUUID().slice(0, 8)}@example.test`, company: `Plan Co ${crypto.randomUUID().slice(0, 6)}`,
  industry: "Home services", website: "https://buyer.example.test", timezone: "America/Chicago", maintenanceSelected: false,
});

/** A purchase taken through the real flow to a provisioned workspace. */
async function purchase(over: { productVersion?: string } = {}) {
  const w = await world();
  const created = await createPurchaseIntent(w.session, buyer(), { now: NOW });
  if (over.productVersion) await withSystem((db) => db.query("update purchase_intents set product_version = $2 where id = $1", [created.id, over.productVersion]));
  await startPurchase(created.token, { now: NOW });
  await verifyPurchasePayment(w.session, created.id, { amount: "1499.00", method: "bank_transfer", externalReference: `BANK-${crypto.randomUUID().slice(0, 8)}`, paidOn: TODAY, note: "Saw the transfer on the business bank statement." }, { now: NOW });
  const made = await provisionPurchaseIntent(w.session, created.id, { now: NOW });
  return { w, intentId: created.id, orgId: made.clientOrgId };
}
const employees = (orgId: string) => rows<{ role_key: string; enabled: boolean }>("select role_key, enabled from agent_instances where org_id = $1 order by role_key", [orgId]);
const defaultedRows = (agencyId: string, intentId: string) => rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = 'purchase.plan_roles_defaulted' and target_id = $2", [agencyId, intentId]);

describe("a purchase creates one Growth Partner runtime", () => {
  it("creates one enabled Growth Partner for the product the catalogue knows, and records nothing about a default", async () => {
    const bought = await purchase();
    const made = await employees(bought.orgId);
    expect(made).toEqual([{ role_key: AI_GROWTH_PARTNER_ROLE_KEY, enabled: true }]);
    expect(await defaultedRows(bought.w.agencyId, bought.intentId)).toHaveLength(0);
  });

  it("gives an unlisted product one Growth Partner and writes one audit row that names only the key", async () => {
    const bought = await purchase({ productVersion: "launch-2099-01" });
    expect(await employees(bought.orgId)).toEqual([{ role_key: AI_GROWTH_PARTNER_ROLE_KEY, enabled: true }]);
    const audit = await defaultedRows(bought.w.agencyId, bought.intentId);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ planKey: "launch-2099-01" });
  });
});
