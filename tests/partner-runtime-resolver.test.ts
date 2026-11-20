// The one derivation of "which agent acts for this workspace": the bound Growth Partner runtime first, the legacy role row only for a
// workspace that never had a Partner bound. Four tenant shapes, plus the disabled-Partner and cross-tenant rules.
import { describe, expect, it } from "vitest";
import { AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { boundPartnerRuntime, partnerFirstAgentSql, resolveActorAgent } from "@/server/workforce/partner-runtime";
import { ensureGrowthPartnerRuntime } from "@/server/workforce/service";
import { agentId, createOrg } from "./support/fixtures";
import { createGrowthPartnerOnlyTenant } from "./support/growth-partner-tenant";

async function createBareOrg(name: string) {
  return withSystem(async (db) => {
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await db.query<{ id: string }>("insert into organizations (name, slug, kind, status) values ($1, $2, 'client', 'active') returning id", [name, slug]);
    return rows[0].id;
  });
}

const resolve = (orgId: string, role: Parameters<typeof resolveActorAgent>[2]) => withSystem((db) => resolveActorAgent(db, orgId, role));
const bound = (orgId: string) => withSystem((db) => boundPartnerRuntime(db, orgId));

describe("partner-first agent resolver", () => {
  it("Partner-only workspace: resolves to the Partner runtime for any legacy role", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Resolver Partner Only" });
    for (const role of ["sales_assistant", "appointment_setter", "operations_manager", "lead_hunter", "crm_manager", "performance_analyst"] as const) {
      expect(await resolve(tenant.org.id, role)).toEqual({
        agentId: tenant.runtimeAgentId,
        roleKey: AI_GROWTH_PARTNER_ROLE_KEY,
        viaPartner: true,
        enabled: true,
        status: "online",
        activeConfigVersionId: expect.any(String),
      });
    }
    expect(await resolve(tenant.org.id, AI_GROWTH_PARTNER_ROLE_KEY)).toMatchObject({ agentId: tenant.runtimeAgentId, viaPartner: true });
    expect(await bound(tenant.org.id)).toMatchObject({ agentId: tenant.runtimeAgentId, viaPartner: true });
  });

  it("Partner-only workspace that is not set up yet still resolves to the Partner, reporting its real state", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ runtime: "setup_required", brain: "none", conversation: "none" });
    expect(await resolve(tenant.org.id, "sales_assistant")).toEqual({
      agentId: tenant.runtimeAgentId,
      roleKey: AI_GROWTH_PARTNER_ROLE_KEY,
      viaPartner: true,
      enabled: true,
      status: "setup_required",
      activeConfigVersionId: null,
    });
  });

  it("legacy six-role workspace: resolves to the requested legacy role row", async () => {
    const org = await createOrg({ name: "Resolver Legacy Six" });
    expect(await bound(org.id)).toBeNull();
    for (const role of ["sales_assistant", "appointment_setter", "operations_manager", "lead_hunter", "crm_manager", "performance_analyst"] as const) {
      const resolved = await resolve(org.id, role);
      expect(resolved).toMatchObject({ agentId: await agentId(org.id, role), roleKey: role, viaPartner: false, enabled: true });
    }
    // The legacy rows are never confused with each other.
    expect((await resolve(org.id, "sales_assistant"))?.agentId).not.toBe((await resolve(org.id, "appointment_setter"))?.agentId);
  });

  it("workspace with both a legacy role and a bound Partner: the Partner wins", async () => {
    const org = await createOrg({ name: "Resolver Both" });
    const legacySales = await agentId(org.id, "sales_assistant");
    const partnerRuntime = await withSystem((db) => ensureGrowthPartnerRuntime(org.id, db));
    expect(partnerRuntime).not.toBe(legacySales);

    expect(await resolve(org.id, "sales_assistant")).toMatchObject({ agentId: partnerRuntime, roleKey: AI_GROWTH_PARTNER_ROLE_KEY, viaPartner: true });
    expect(await resolve(org.id, "appointment_setter")).toMatchObject({ agentId: partnerRuntime, viaPartner: true });
    expect(await bound(org.id)).toMatchObject({ agentId: partnerRuntime });
  });

  it("neither shape: a workspace with no agent rows resolves to null", async () => {
    const orgId = await createBareOrg("Resolver Neither");
    expect(await bound(orgId)).toBeNull();
    expect(await resolve(orgId, "sales_assistant")).toBeNull();
    expect(await resolve(orgId, AI_GROWTH_PARTNER_ROLE_KEY)).toBeNull();
  });

  it("an unbound identity row is not a bound Partner runtime", async () => {
    const org = await createOrg({ name: "Resolver Unbound Identity" });
    await withSystem((db) => db.query("insert into ai_growth_partners (org_id) values ($1)", [org.id]));
    expect(await bound(org.id)).toBeNull();
    expect(await resolve(org.id, "sales_assistant")).toMatchObject({ agentId: await agentId(org.id, "sales_assistant"), viaPartner: false });
  });

  it("a bound but disabled Partner does not fall back to the legacy role", async () => {
    const org = await createOrg({ name: "Resolver Disabled Partner" });
    const legacySales = await agentId(org.id, "sales_assistant");
    const partnerRuntime = await withSystem((db) => ensureGrowthPartnerRuntime(org.id, db));
    await withSystem((db) => db.query("update agent_instances set enabled = false where id = $1 and org_id = $2", [partnerRuntime, org.id]));

    const resolved = await resolve(org.id, "sales_assistant");
    expect(resolved).toMatchObject({ agentId: partnerRuntime, viaPartner: true, enabled: false, status: "setup_required" });
    expect(resolved?.agentId).not.toBe(legacySales);
    expect(await bound(org.id)).toMatchObject({ agentId: partnerRuntime, enabled: false });
  });

  it("a bound Partner that is paused or not ready is returned as it is, not replaced", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ mode: "paused" });
    await withSystem((db) => db.query("update agent_instances set status = 'offline' where id = $1 and org_id = $2", [tenant.runtimeAgentId, tenant.org.id]));
    expect(await resolve(tenant.org.id, "sales_assistant")).toMatchObject({ agentId: tenant.runtimeAgentId, viaPartner: true, status: "offline" });
  });

  it("never crosses workspaces", async () => {
    const partnerTenant = await createGrowthPartnerOnlyTenant({ name: "Resolver Cross A" });
    const legacyOrg = await createOrg({ name: "Resolver Cross B" });
    const emptyOrg = await createBareOrg("Resolver Cross C");

    const forLegacy = await resolve(legacyOrg.id, "sales_assistant");
    expect(forLegacy?.agentId).toBe(await agentId(legacyOrg.id, "sales_assistant"));
    expect(forLegacy?.agentId).not.toBe(partnerTenant.runtimeAgentId);
    expect(forLegacy?.viaPartner).toBe(false);

    expect((await resolve(partnerTenant.org.id, "sales_assistant"))?.agentId).toBe(partnerTenant.runtimeAgentId);
    expect(await resolve(emptyOrg, "sales_assistant")).toBeNull();
    expect(await bound(legacyOrg.id)).toBeNull();
    expect(await bound(emptyOrg)).toBeNull();
  });

  it("does not trust a binding that points at another workspace's runtime row", async () => {
    const owner = await createGrowthPartnerOnlyTenant({ name: "Resolver Binding Owner" });
    const other = await createOrg({ name: "Resolver Binding Other" });
    const otherPartner = await withSystem((db) => db.query<{ id: string }>("insert into ai_growth_partners (org_id) values ($1) returning id", [other.id]));
    expect(otherPartner.rows).toHaveLength(1);
    // The composite foreign key keeps a partner from being bound to a row of another workspace.
    await expect(withSystem((db) => db.query(
      "update ai_growth_partners set runtime_agent_instance_id = $2 where org_id = $1",
      [other.id, owner.runtimeAgentId],
    ))).rejects.toThrow();
    expect(await bound(other.id)).toBeNull();
  });
});

describe("partnerFirstAgentSql", () => {
  it("returns the Partner runtime id, else the legacy id, per workspace, inside UPDATE ... RETURNING", async () => {
    const partnerTenant = await createGrowthPartnerOnlyTenant({ name: "Sql Partner Only" });
    const legacyOrg = await createOrg({ name: "Sql Legacy" });
    const bothOrg = await createOrg({ name: "Sql Both" });
    const bothRuntime = await withSystem((db) => ensureGrowthPartnerRuntime(bothOrg.id, db));
    const emptyOrg = await createBareOrg("Sql Neither");
    const ids = [partnerTenant.org.id, legacyOrg.id, bothOrg.id, emptyOrg];

    const sql = partnerFirstAgentSql("o.id", "sales_assistant");
    const { rows } = await withSystem((db) => db.query<{ id: string; agent_id: string | null }>(
      `select o.id, ${sql} as agent_id from organizations o where o.id = any($1::uuid[])`,
      [ids],
    ));
    const byOrg = new Map(rows.map((row) => [row.id, row.agent_id]));
    expect(byOrg.get(partnerTenant.org.id)).toBe(partnerTenant.runtimeAgentId);
    expect(byOrg.get(legacyOrg.id)).toBe(await agentId(legacyOrg.id, "sales_assistant"));
    expect(byOrg.get(bothOrg.id)).toBe(bothRuntime);
    expect(byOrg.get(emptyOrg)).toBeNull();

    // The same fragment drives a set-based UPDATE ... RETURNING and agrees with resolveActorAgent for every workspace.
    const updated = await withSystem((db) => db.query<{ org_id: string; chosen: string | null }>(
      `update agent_instances x set display_name = x.display_name
        where x.org_id = any($1::uuid[]) and x.role_key = 'sales_assistant'
        returning x.org_id, ${partnerFirstAgentSql("x.org_id", "sales_assistant")} as chosen`,
      [[legacyOrg.id, bothOrg.id]],
    ));
    expect(updated.rows).toHaveLength(2);
    for (const row of updated.rows) expect(row.chosen).toBe((await resolve(row.org_id, "sales_assistant"))?.agentId);
  });

  it("does not fall back to the legacy row while a disabled Partner is bound", async () => {
    const org = await createOrg({ name: "Sql Disabled Partner" });
    const partnerRuntime = await withSystem((db) => ensureGrowthPartnerRuntime(org.id, db));
    await withSystem((db) => db.query("update agent_instances set enabled = false where id = $1 and org_id = $2", [partnerRuntime, org.id]));
    const { rows } = await withSystem((db) => db.query<{ agent_id: string | null }>(`select ${partnerFirstAgentSql("$1", "sales_assistant")} as agent_id`, [org.id]));
    expect(rows[0].agent_id).toBe(partnerRuntime);
  });

  it("accepts a placeholder with a uuid cast", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Sql Placeholder" });
    const { rows } = await withSystem((db) => db.query<{ agent_id: string | null }>(`select ${partnerFirstAgentSql("$1::uuid", "crm_manager")} as agent_id`, [tenant.org.id]));
    expect(rows[0].agent_id).toBe(tenant.runtimeAgentId);
  });

  it("refuses anything but a plain column or placeholder and a known role key", () => {
    expect(() => partnerFirstAgentSql("o.id) or (1=1", "sales_assistant")).toThrow();
    expect(() => partnerFirstAgentSql("'x'", "sales_assistant")).toThrow();
    expect(() => partnerFirstAgentSql("", "sales_assistant")).toThrow();
    expect(() => partnerFirstAgentSql("o.id", "sales_assistant'; drop table agent_instances; --")).toThrow();
    expect(() => partnerFirstAgentSql("o.id", "not_a_role")).toThrow();
    expect(() => partnerFirstAgentSql("o.id", AI_GROWTH_PARTNER_ROLE_KEY)).not.toThrow();
  });
});
