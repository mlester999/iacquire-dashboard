import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { createClientTenant } from "@/server/admin/tenants";
import { resetEnvCache } from "@/server/env";
import * as manualBilling from "@/server/billing/manual";
import {
  createPurchaseIntent,
  provisionPurchaseIntent,
  startPurchase,
  verifyPurchasePayment,
} from "@/server/purchase-intents/service";
import { agencyUser, createOrg, uid } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson, splitStatements } from "./support/staff-messages";

const UP = readFileSync("supabase/migrations/0141_organization_creation_key.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0141_organization_creation_key.down.sql", "utf8");
const TENANT_CREATION_SOURCE = readFileSync("src/server/admin/tenants.ts", "utf8");
const PURCHASE_PROVISION_SOURCE = readFileSync("src/server/purchase-intents/service.ts", "utf8");
const NOW = new Date("2026-10-25T12:00:00Z");
const TODAY = "2026-10-25";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
});

async function admin() {
  await agencyOrgId();
  return agencyUser(await staffPerson("agency_super_admin"), "agency_super_admin");
}

function tenantInput(ownerEmail: string, name = `Idempotent Co ${uid()}`) {
  return { name, ownerEmail, industry: "Home services", timezone: "America/Chicago", enabledRoles: ["growth_partner" as const] };
}

async function verifiedPurchase(user: Awaited<ReturnType<typeof admin>>) {
  const created = await createPurchaseIntent(user, {
    buyerName: "Bailey Buyer",
    buyerEmail: `buyer-${uid()}@example.test`,
    company: `Purchase Co ${uid()}`,
    industry: "Home services",
    website: "https://buyer.example.test",
    timezone: "America/Chicago",
    maintenanceSelected: false,
  }, { now: NOW });
  await startPurchase(created.token, { now: NOW });
  await verifyPurchasePayment(user, created.id, {
    amount: "1499.00",
    method: "bank_transfer",
    externalReference: `BANK-${uid()}`,
    paidOn: TODAY,
    note: "Synthetic payment fixture.",
  }, { now: NOW });
  return created;
}

async function tenantCounts(orgId: string, email: string) {
  const [identity] = await rows<{ n: number }>("select count(*)::int as n from ai_growth_partners where org_id = $1", [orgId]);
  const [runtime] = await rows<{ n: number }>("select count(*)::int as n from agent_instances where org_id = $1 and role_key = 'growth_partner'", [orgId]);
  const [invitation] = await rows<{ n: number }>("select count(*)::int as n from invitations where org_id = $1 and role = 'owner'", [orgId]);
  const [emailCount] = await rows<{ n: number }>("select count(*)::int as n from email_outbox where to_email = $1 and template = 'invitation'", [email]);
  return { identity: identity.n, runtime: runtime.n, invitation: invitation.n, email: emailCount.n };
}

describe("organization creation key migration 0141", () => {
  it("applies the additive column and index in isolation", async () => {
    const rollback = new Error("rollback migration test transaction");
    await expect(withSystem(async (db) => {
      // The test database has already applied 0141 from the migration directory. Drop and reapply it inside this transaction, then roll the transaction back.
      for (const sql of splitStatements(DOWN)) await db.query(sql);
      for (const sql of splitStatements(UP)) await db.query(sql);
      const column = await db.query<{ data_type: string }>("select data_type from information_schema.columns where table_name = 'organizations' and column_name = 'creation_key'");
      const index = await db.query<{ exists: boolean }>("select to_regclass('public.organizations_creation_key_unique') is not null as exists");
      expect(column.rows[0]?.data_type).toBe("text");
      expect(index.rows[0]?.exists).toBe(true);
      throw rollback;
    })).rejects.toBe(rollback);
    const columnAfterRollback = await rows("select 1 from information_schema.columns where table_name = 'organizations' and column_name = 'creation_key'");
    expect(columnAfterRollback).toHaveLength(1);
  });

  it("allows a clean rollback and refuses to remove a key already in use", async () => {
    const rollback = new Error("rollback successful down migration test transaction");
    await expect(withSystem(async (db) => {
      for (const sql of splitStatements(DOWN)) await db.query(sql);
      for (const sql of splitStatements(UP)) await db.query(sql);
      for (const sql of splitStatements(DOWN)) await db.query(sql);
      const column = await db.query("select 1 from information_schema.columns where table_name = 'organizations' and column_name = 'creation_key'");
      expect(column.rows).toHaveLength(0);
      throw rollback;
    })).rejects.toBe(rollback);

    const agency = await createOrg({ name: `Rollback Guard ${uid()}`, kind: "agency" });
    await expect(withSystem(async (db) => {
      for (const sql of splitStatements(DOWN)) await db.query(sql);
      for (const sql of splitStatements(UP)) await db.query(sql);
      await db.query("update organizations set creation_key = 'rollback-refusal-key' where id = $1", [agency.id]);
      for (const sql of splitStatements(DOWN)) await db.query(sql);
    })).rejects.toThrow(/Rollback refused: tenant creation keys exist/);
    expect(await rows("select creation_key from organizations where id = $1", [agency.id])).toEqual([{ creation_key: null }]);
  });
});

describe("idempotent workspace creation", () => {
  it("uses transaction-scoped advisory locks for keyed and normalized admin submissions", () => {
    expect(TENANT_CREATION_SOURCE).toContain("organization-creation:");
    expect(TENANT_CREATION_SOURCE).toContain("organization-submit:");
    expect(TENANT_CREATION_SOURCE).toMatch(/pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/);
    expect(PURCHASE_PROVISION_SOURCE).toContain("purchaseTenantKey(current.id)");
    expect(PURCHASE_PROVISION_SOURCE).toContain("client_org_id is null returning client_org_id");
  });

  it("returns one keyed workspace and sends only one owner invitation", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "capture");
    resetEnvCache();
    const user = await admin();
    const key = `test-key-${uid()}`;
    const firstEmail = `first-${uid()}@example.test`;
    const secondEmail = `second-${uid()}@example.test`;
    const first = await createClientTenant(user, tenantInput(firstEmail), { idempotencyKey: key });
    const second = await createClientTenant(user, tenantInput(secondEmail), { idempotencyKey: key });

    expect(first).toMatchObject({ duplicate: false, emailDelivery: { status: "captured" } });
    expect(second).toMatchObject({ duplicate: true, orgId: first.orgId, inviteLink: null, emailDelivery: null, blueprint: null });
    expect(await tenantCounts(first.orgId, firstEmail)).toEqual({ identity: 1, runtime: 1, invitation: 1, email: 1 });
    expect(await rows("select 1 from email_outbox where to_email = $1", [secondEmail])).toHaveLength(0);
  });

  it("refuses a same-admin double submit after normalizing company name and owner email", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "capture");
    resetEnvCache();
    const user = await admin();
    const email = `Owner-${uid()}@Example.Test`;
    const first = await createClientTenant(user, tenantInput(email, "  Acme   Home Services  "));

    await expect(createClientTenant(user, tenantInput(email.toLowerCase(), "acme home services"))).rejects.toMatchObject({
      code: "conflict",
      message: "A workspace with this name and owner was just created. Open it from Clients instead of creating it again.",
    });

    expect(await rows(
      `select o.id from organizations o join invitations i on i.org_id = o.id and i.role = 'owner'
       where o.created_by = $1 and lower(regexp_replace(btrim(o.name), '[[:space:]]+', ' ', 'g')) = $2 and lower(i.email::text) = $3`,
      [user.id, "acme home services", email.toLowerCase()],
    )).toEqual([{ id: first.orgId }]);
    expect(await rows("select 1 from email_outbox where to_email = $1 and template = 'invitation'", [email.toLowerCase()])).toHaveLength(1);
  });

  it("rolls the whole tenant and invitation back when the in-transaction claim is lost", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "capture");
    resetEnvCache();
    const user = await admin();
    const key = `claim-key-${uid()}`;
    const email = `loser-${uid()}@example.test`;
    await expect(createClientTenant(user, tenantInput(email), {
      idempotencyKey: key,
      claim: async () => false,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(await rows("select 1 from organizations where creation_key = $1", [key])).toHaveLength(0);
    expect(await rows("select 1 from invitations where email = $1", [email])).toHaveLength(0);
    expect(await rows("select 1 from email_outbox where to_email = $1", [email])).toHaveLength(0);
  });

  it("recovers after the workspace commits but payment adoption fails", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "capture");
    resetEnvCache();
    const user = await admin();
    const intent = await verifiedPurchase(user);
    const first = vi.spyOn(manualBilling, "recordManualPayment").mockRejectedValueOnce(new Error("simulated interruption after workspace commit"));

    await expect(provisionPurchaseIntent(user, intent.id, { now: NOW })).rejects.toThrow(/simulated interruption/);
    first.mockRestore();
    const [reserved] = await rows<{ client_org_id: string | null; status: string }>("select client_org_id, status from purchase_intents where id = $1", [intent.id]);
    expect(reserved.client_org_id).toBeTruthy();
    expect(reserved.status).toBe("payment_verified");
    // The purchase buyer address is checked below from the canonical intent, rather than predicting a second invitation.
    const [purchase] = await rows<{ buyer_email: string }>("select buyer_email from purchase_intents where id = $1", [intent.id]);
    const made = await provisionPurchaseIntent(user, intent.id, { now: NOW });
    expect(made).toMatchObject({ duplicate: false, clientOrgId: reserved.client_org_id });
    const counts = await tenantCounts(made.clientOrgId, purchase.buyer_email);
    expect(counts).toEqual({ identity: 1, runtime: 1, invitation: 1, email: 1 });
  });

  it("serializes two simultaneous provisions to one tenant, payment, invitation and completion event", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "capture");
    resetEnvCache();
    const user = await admin();
    const intent = await verifiedPurchase(user);
    // PGlite serializes calls through its embedded connection, so this proves parallel-call idempotency here, not advisory-lock contention on separate PostgreSQL backends. The source assertion above verifies both transaction-scoped lock paths remain present.
    const results = await Promise.all([
      provisionPurchaseIntent(user, intent.id, { now: NOW }),
      provisionPurchaseIntent(user, intent.id, { now: NOW }),
    ]);
    const orgIds = [...new Set(results.map((result) => result.clientOrgId))];
    const paymentIds = [...new Set(results.map((result) => result.paymentId))];
    expect(orgIds).toHaveLength(1);
    expect(paymentIds).toHaveLength(1);
    const [purchase] = await rows<{ buyer_email: string }>("select buyer_email from purchase_intents where id = $1", [intent.id]);
    expect(await tenantCounts(orgIds[0], purchase.buyer_email)).toEqual({ identity: 1, runtime: 1, invitation: 1, email: 1 });
    expect(await rows("select 1 from payments where org_id = $1 and kind = 'setup_fee'", [orgIds[0]])).toHaveLength(1);
    expect(await rows("select 1 from purchase_intent_events where intent_id = $1 and kind = 'workspace_created'", [intent.id])).toHaveLength(1);
    expect(await rows("select 1 from purchase_intent_events where intent_id = $1 and kind = 'provisioned'", [intent.id])).toHaveLength(1);
    expect(await rows("select 1 from organizations where creation_key = $1", [`purchase:${intent.id}`])).toHaveLength(1);
  });
});
