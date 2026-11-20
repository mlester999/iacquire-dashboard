// The shared Growth-Partner-only tenant fixture: one growth_partner runtime row, one bound partner row, no legacy six-role rows.
// Everything is local and synthetic; no Hermes profile or provider call is involved.
import { describe, expect, it } from "vitest";
import { AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { permissionsFor } from "@/lib/permissions";
import { withSystem } from "@/server/db";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import {
  createGrowthPartnerOnlyTenant,
  createLegacySixRoleTenant,
  expectNoLegacyEmployeeRows,
  type GrowthPartnerOnlyTenantOptions,
} from "./support/growth-partner-tenant";

async function agentRows(orgId: string) {
  return (await withSystem((db) => db.query<{ id: string; role_key: string; status: string; mode: string; enabled: boolean; active_config_version_id: string | null }>(
    "select id, role_key, status, mode, enabled, active_config_version_id from agent_instances where org_id = $1",
    [orgId],
  ))).rows;
}

async function partnerRows(orgId: string) {
  return (await withSystem((db) => db.query<{ id: string; runtime_agent_instance_id: string | null; current_version: number | null; status: string }>(
    "select id, runtime_agent_instance_id, current_version, status from ai_growth_partners where org_id = $1",
    [orgId],
  ))).rows;
}

async function conversationRows(orgId: string) {
  return (await withSystem((db) => db.query<{ id: string; agent_instance_id: string; growth_partner_id: string | null; user_id: string | null }>(
    "select id, agent_instance_id, growth_partner_id, user_id from chat_conversations where org_id = $1 and deleted_at is null",
    [orgId],
  ))).rows;
}

const COMBINATIONS: Array<Required<Pick<GrowthPartnerOnlyTenantOptions, "runtime" | "brain" | "conversation">>> = [];
for (const runtime of ["setup_required", "online"] as const) {
  for (const brain of ["none", "active"] as const) {
    for (const conversation of ["none", "direct"] as const) COMBINATIONS.push({ runtime, brain, conversation });
  }
}

describe("Growth-Partner-only tenant fixture", () => {
  it("creates exactly one growth_partner row, one bound partner and zero legacy rows with the defaults", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Fixture Defaults" });

    const agents = await agentRows(tenant.org.id);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: tenant.runtimeAgentId, role_key: AI_GROWTH_PARTNER_ROLE_KEY, status: "online", mode: "approval_required", enabled: true });
    expect(agents[0].active_config_version_id).not.toBeNull();

    const partners = await partnerRows(tenant.org.id);
    expect(partners).toHaveLength(1);
    expect(partners[0].id).toBe(tenant.partnerId);
    expect(partners[0].runtime_agent_instance_id).toBe(tenant.runtimeAgentId);
    expect(partners[0].current_version).toBe(1);
    expect(partners[0].status).toBe("configured");

    const conversations = await conversationRows(tenant.org.id);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ id: tenant.conversationId, agent_instance_id: tenant.runtimeAgentId, growth_partner_id: tenant.partnerId, user_id: null });

    expect(await tenant.legacyAgentRowCount()).toBe(0);
    await expectNoLegacyEmployeeRows(tenant.org.id);

    const base = await withSystem((db) => db.query<{ kind: string; status: string; timezone: string; profiles: number; limits: number; billing: number; onboarding: number }>(
      `select o.kind, o.status, o.timezone,
              (select count(*)::int from company_profiles where org_id = o.id) as profiles,
              (select count(*)::int from usage_limits where org_id = o.id) as limits,
              (select count(*)::int from billing_accounts where org_id = o.id) as billing,
              (select count(*)::int from onboarding_responses where org_id = o.id) as onboarding
         from organizations o where o.id = $1`,
      [tenant.org.id],
    ));
    expect(base.rows[0]).toMatchObject({ kind: "client", status: "active", timezone: "UTC", profiles: 1, limits: 1, billing: 1, onboarding: 1 });
  });

  it.each(COMBINATIONS)("keeps one partner row and no legacy rows for runtime=$runtime brain=$brain conversation=$conversation", async (combo) => {
    const tenant = await createGrowthPartnerOnlyTenant(combo);

    const agents = await agentRows(tenant.org.id);
    expect(agents).toHaveLength(1);
    expect(agents[0].role_key).toBe(AI_GROWTH_PARTNER_ROLE_KEY);
    expect(agents[0].status).toBe(combo.runtime === "online" ? "online" : "setup_required");
    expect(Boolean(agents[0].active_config_version_id)).toBe(combo.runtime === "online");

    const partners = await partnerRows(tenant.org.id);
    expect(partners).toHaveLength(1);
    expect(partners[0].runtime_agent_instance_id).toBe(tenant.runtimeAgentId);
    expect(partners[0].current_version).toBe(combo.brain === "active" ? 1 : null);
    expect(partners[0].status).toBe(combo.brain === "active" && combo.conversation === "direct" ? "configured" : "setup_required");

    const conversations = await conversationRows(tenant.org.id);
    expect(conversations).toHaveLength(combo.conversation === "direct" ? 1 : 0);
    expect(tenant.conversationId === null).toBe(combo.conversation === "none");

    expect(await tenant.legacyAgentRowCount()).toBe(0);
    await expectNoLegacyEmployeeRows(tenant.org.id);
  });

  it.each(["approval_required", "autonomous", "paused"] as const)("stores the %s mode on the one runtime row", async (mode) => {
    const online = await createGrowthPartnerOnlyTenant({ mode });
    expect((await agentRows(online.org.id))[0].mode).toBe(mode);
    const fresh = await createGrowthPartnerOnlyTenant({ mode, runtime: "setup_required" });
    const rows = await agentRows(fresh.org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode, status: "setup_required" });
    expect(await online.legacyAgentRowCount()).toBe(0);
    expect(await fresh.legacyAgentRowCount()).toBe(0);
  });

  it("lets an online runtime pass the real capability dispatcher without a legacy row", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Fixture Dispatch" });
    const result = await dispatchCapabilityJob(tenant.ownerCtx, {
      agentRole: AI_GROWTH_PARTNER_ROLE_KEY,
      capability: "performance_snapshot",
      deferKick: true,
      title: "Review acquisition results",
      idempotencyKey: "fixture-performance-snapshot",
    });
    expect(result.agentId).toBe(tenant.runtimeAgentId);
    const job = (await withSystem((db) => db.query<{ agent_instance_id: string; capability: string; status: string }>(
      "select agent_instance_id, capability, status from ai_work_jobs where id = $1 and org_id = $2",
      [result.jobId, tenant.org.id],
    ))).rows[0];
    expect(job).toEqual({ agent_instance_id: tenant.runtimeAgentId, capability: "performance_snapshot", status: "queued" });
    expect(await tenant.legacyAgentRowCount()).toBe(0);
  });

  it("refuses dispatch honestly while the runtime is still setup_required", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ runtime: "setup_required" });
    await expect(dispatchCapabilityJob(tenant.ownerCtx, {
      agentRole: AI_GROWTH_PARTNER_ROLE_KEY,
      capability: "performance_snapshot",
      deferKick: true,
      title: "Review acquisition results",
    })).rejects.toMatchObject({ code: "agent_unavailable" });
    const jobs = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from ai_work_jobs where org_id = $1", [tenant.org.id]));
    expect(Number(jobs.rows[0].n)).toBe(0);
  });

  it("gives member() contexts the right role and a real membership row", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Fixture Members" });
    expect(tenant.ownerCtx.role).toBe("owner");
    expect(tenant.ownerCtx.org.orgId).toBe(tenant.org.id);
    expect(tenant.ownerCtx.user.id).toBe(tenant.owner.id);

    for (const role of ["admin", "member", "viewer", "support"] as const) {
      const { user, ctx } = await tenant.member(role, { name: `Fixture ${role}` });
      expect(ctx.role).toBe(role);
      expect(ctx.org.orgId).toBe(tenant.org.id);
      expect(ctx.user.id).toBe(user.id);
      expect(ctx.permissions).toEqual(permissionsFor(role));
      expect(ctx.can("agents.configure")).toBe(role === "admin");
      const row = (await withSystem((db) => db.query<{ role: string; status: string }>(
        "select role, status from organization_memberships where org_id = $1 and user_id = $2",
        [tenant.org.id, user.id],
      ))).rows;
      expect(row).toEqual([{ role, status: "active" }]);
    }
    expect(await tenant.legacyAgentRowCount()).toBe(0);
  });

  it("applies the timezone to the organization and every context", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ timezone: "Asia/Manila" });
    const stored = (await withSystem((db) => db.query<{ timezone: string }>("select timezone from organizations where id = $1", [tenant.org.id]))).rows[0];
    expect(stored.timezone).toBe("Asia/Manila");
    expect(tenant.ownerCtx.org.timezone).toBe("Asia/Manila");
    expect((await tenant.member("member")).ctx.org.timezone).toBe("Asia/Manila");
  });

  it("keeps two fixture tenants separate and createLegacySixRoleTenant on the legacy shape", async () => {
    const first = await createGrowthPartnerOnlyTenant();
    const second = await createGrowthPartnerOnlyTenant();
    expect(first.org.id).not.toBe(second.org.id);
    expect(first.runtimeAgentId).not.toBe(second.runtimeAgentId);
    expect(first.partnerId).not.toBe(second.partnerId);

    const legacy = await createLegacySixRoleTenant({ name: "Fixture Legacy Shape" });
    const legacyAgents = await agentRows(legacy.org.id);
    expect(legacyAgents.map((row) => row.role_key).sort()).toEqual([
      "appointment_setter", "crm_manager", "lead_hunter", "operations_manager", "performance_analyst", "sales_assistant",
    ]);
    expect(await partnerRows(legacy.org.id)).toHaveLength(0);
    expect(legacy.ownerCtx.role).toBe("owner");
    await expect(expectNoLegacyEmployeeRows(legacy.org.id)).rejects.toThrow();
  });
});
