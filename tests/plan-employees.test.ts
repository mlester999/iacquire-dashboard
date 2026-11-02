// Which employees a purchase includes is ONE reviewed table (src/lib/plan-employees.ts). Today every entry is all six, so nothing changes; the mechanism is proven here with a synthetic
// five-role table used inside this test only, never in the table itself. An unknown product gets the full team and the audit trail says which key. Embedded Postgres; nothing here
// calls a provider.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { PRODUCT_VERSION } from "@/lib/purchase-intents/rules";
import { KNOWN_PLAN_KEYS, PLAN_EMPLOYEES, rolesForPlan } from "@/lib/plan-employees";
import { planScope } from "@/lib/onboarding/engine";
import { withSystem } from "@/server/db";
import { createPurchaseIntent, provisionPurchaseIntent, startPurchase, verifyPurchasePayment } from "@/server/purchase-intents/service";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";

const NOW = new Date("2026-10-25T12:00:00Z");
const TODAY = "2026-10-25";

describe("the plan-to-employees table", () => {
  it("lists exactly the products the purchase catalogue knows, and every one of them is all six employees today", () => {
    expect([...KNOWN_PLAN_KEYS]).toEqual([PRODUCT_VERSION]);
    for (const [key, roles] of Object.entries(PLAN_EMPLOYEES)) expect([...roles], key).toEqual([...AGENT_ROLE_KEYS]);
    for (const key of KNOWN_PLAN_KEYS) expect(rolesForPlan(key), key).toEqual({ roles: [...AGENT_ROLE_KEYS], defaulted: false });
  });

  it("gives an unknown or missing product the full team and says it did", () => {
    for (const key of [undefined, null, "", "launch-2099-01", "__proto__", "constructor", "toString"]) {
      expect(rolesForPlan(key as string | null | undefined), String(key)).toEqual({ roles: [...AGENT_ROLE_KEYS], defaulted: true });
    }
  });

  it("proves the mechanism with a five-role plan, kept in the product's own order and free of repeats", () => {
    // A five-role plan exists ONLY here. It is never added to the real table: its contents are the founder's decision.
    const five: AgentRoleKey[] = AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant");
    const table = { "five-role-test-plan": [...five].reverse().concat(five[0]) };
    expect(rolesForPlan("five-role-test-plan", table)).toEqual({ roles: five, defaulted: false });
    expect(rolesForPlan("launch-2026-10", table)).toEqual({ roles: [...AGENT_ROLE_KEYS], defaulted: true });
    // An entry that names no real employee is as unusable as no entry.
    expect(rolesForPlan("empty", { empty: [] })).toEqual({ roles: [...AGENT_ROLE_KEYS], defaulted: true });
    expect(rolesForPlan("junk", { junk: ["not_a_role"] as unknown as AgentRoleKey[] })).toEqual({ roles: [...AGENT_ROLE_KEYS], defaulted: true });
  });

  it("is what the questionnaire's plan awareness reads: the roles of the plan are its scope", () => {
    const five = rolesForPlan("five-role-test-plan", { "five-role-test-plan": AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant") }).roles;
    expect(planScope(five)).toEqual({ roles: five });
    expect(planScope(five)?.roles).not.toContain("sales_assistant");
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

describe("a purchase creates the employees its plan includes", () => {
  it("creates exactly the same six enabled employees as before for the product the catalogue knows, and records nothing about a default", async () => {
    const bought = await purchase();
    const made = await employees(bought.orgId);
    expect(made.map((e) => e.role_key).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    expect(made.every((e) => e.enabled)).toBe(true);
    expect(await defaultedRows(bought.w.agencyId, bought.intentId)).toHaveLength(0);
  });

  it("gives a product it does not list the full team and writes one audit row that names only the key", async () => {
    const bought = await purchase({ productVersion: "launch-2099-01" });
    expect((await employees(bought.orgId)).every((e) => e.enabled)).toBe(true);
    const audit = await defaultedRows(bought.w.agencyId, bought.intentId);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ planKey: "launch-2099-01" });
  });

  it("with a five-role plan (in this test only) creates five enabled employees and the sixth registered but switched off", async () => {
    const table = PLAN_EMPLOYEES as Record<string, readonly AgentRoleKey[]>;
    const original = table[PRODUCT_VERSION];
    table[PRODUCT_VERSION] = AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant");
    try {
      const bought = await purchase();
      const made = await employees(bought.orgId);
      expect(made).toHaveLength(6);
      expect(made.filter((e) => e.enabled).map((e) => e.role_key).sort()).toEqual(AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant").sort());
      expect(made.find((e) => e.role_key === "sales_assistant")).toMatchObject({ enabled: false });
      expect(await defaultedRows(bought.w.agencyId, bought.intentId)).toHaveLength(0);
    } finally {
      table[PRODUCT_VERSION] = original;
    }
    expect([...PLAN_EMPLOYEES[PRODUCT_VERSION]]).toEqual([...AGENT_ROLE_KEYS]);
  });
});
