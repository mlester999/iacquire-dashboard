import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/server/tenancy/context";
import { CAPABILITY_KEYS, WORKFORCE_CAPABILITIES } from "@/lib/workforce-capabilities";

const state = vi.hoisted(() => ({ ctx: null as OrgContext | null }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/workforce/workspace-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/workforce/workspace-access")>();
  const { AppError } = await import("@/server/errors");
  return {
    ...actual,
    requireWorkforceContextOrThrow: async () => {
      if (!state.ctx) throw new AppError("unauthenticated", "Sign in to continue.");
      return state.ctx;
    },
  };
});
vi.mock("@/server/workforce/work-kick", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/workforce/work-kick")>()),
  kickWorkJob: vi.fn(),
}));

import { AI_GROWTH_PARTNER_ROLE_KEY, type WorkforceRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { startReviewAction } from "@/app/actions/work";
import { createGrowthPartnerOnlyTenant, createLegacySixRoleTenant } from "./support/growth-partner-tenant";

beforeEach(() => {
  state.ctx = null;
});

describe("Work Board Start review in Partner-only workspaces", () => {
  it("dispatches every Work Board review to the bound Growth Partner runtime", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Partner Start Review" });
    state.ctx = tenant.ownerCtx;
    const definitions = CAPABILITY_KEYS
      .map((key) => WORKFORCE_CAPABILITIES[key])
      .filter((definition) => definition.workBoardAction);

    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      expect(definition.allowedRoles).toContain(AI_GROWTH_PARTNER_ROLE_KEY);
      const result = await startReviewAction(definition.key);
      if (!result.ok) throw new Error(`Start review for ${definition.key} failed: ${result.error}`);
      expect(result.data.agentId).toBe(tenant.runtimeAgentId);
      const job = await withSystem((db) => db.query<{ agent_instance_id: string; capability: string }>(
        "select agent_instance_id, capability from ai_work_jobs where id = $1 and org_id = $2",
        [result.data.jobId, tenant.org.id],
      ));
      expect(job.rows[0]).toEqual({ agent_instance_id: tenant.runtimeAgentId, capability: definition.key });
    }
  }, 120000);

  it("keeps the legacy six-role route on allowedRoles[0]", async () => {
    const tenant = await createLegacySixRoleTenant({ name: "Legacy Start Review" });
    const definition = WORKFORCE_CAPABILITIES.lead_generation_review;
    const role = definition.allowedRoles[0] as WorkforceRoleKey;
    const agent = await withSystem(async (db) => {
      const row = await db.query<{ id: string }>(
        "select id from agent_instances where org_id = $1 and role_key = $2",
        [tenant.org.id, role],
      );
      if (!row.rows[0]) throw new Error(`Missing legacy ${role} fixture row.`);
      await createConfigVersion(db, {
        orgId: tenant.org.id,
        agentId: row.rows[0].id,
        settings: defaultSettings(role),
        source: "onboarding",
        userId: tenant.owner.id,
        apply: true,
      });
      await db.query("update agent_instances set status = 'online', mode = 'approval_required' where id = $1 and org_id = $2", [row.rows[0].id, tenant.org.id]);
      return row.rows[0].id;
    });
    state.ctx = tenant.ownerCtx;

    const result = await startReviewAction(definition.key);
    if (!result.ok) throw new Error(`Legacy Start review failed: ${result.error}`);
    expect(result.data.agentId).toBe(agent);
    const job = await withSystem((db) => db.query<{ agent_instance_id: string }>(
      "select agent_instance_id from ai_work_jobs where id = $1 and org_id = $2",
      [result.data.jobId, tenant.org.id],
    ));
    expect(job.rows[0]?.agent_instance_id).toBe(agent);
  }, 120000);

  it("returns the readable unavailable error when the bound Partner is paused", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Paused Partner Start Review", mode: "paused" });
    state.ctx = tenant.ownerCtx;

    const result = await startReviewAction("performance_snapshot");

    expect(result).toMatchObject({ ok: false, code: "agent_unavailable" });
    if (result.ok) throw new Error("A paused Partner unexpectedly accepted a review.");
    expect(result.error).toMatch(/paused/i);
  }, 120000);
});
