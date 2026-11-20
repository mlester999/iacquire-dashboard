import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { createResearchRequest, retryResearchRequest } from "@/server/leads/service";
import { createScheduledResearchJob } from "@/server/leads/scheduled-research";
import { createGrowthPartnerOnlyTenant, createLegacySixRoleTenant } from "./support/growth-partner-tenant";

vi.mock("@/server/workforce/work-kick", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/workforce/work-kick")>()),
  kickWorkJob: vi.fn(),
}));

async function researchRequest(ctx: Parameters<typeof createResearchRequest>[0], prompt = "Find 3 independent dental clinics in Singapore", options: Parameters<typeof createResearchRequest>[2] = {}) {
  return createResearchRequest(ctx, { prompt, campaignType: "business" }, { deferKick: true, ...options });
}

describe("lead research routing in Partner-only workspaces", () => {
  it("queues the default research request on the bound Growth Partner runtime", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Partner Research Default" });
    const created = await researchRequest(tenant.ownerCtx);
    expect(created).toMatchObject({ status: "queued", jobId: expect.any(String) });
    const rows = await withSystem((db) => db.query<{ agent_instance_id: string; agent_role: string; status: string }>(
      `select j.agent_instance_id, r.agent_role, r.status
         from lead_research_requests r join ai_work_jobs j on j.id = r.work_job_id and j.org_id = r.org_id
        where r.id = $1 and r.org_id = $2`,
      [created.requestId, tenant.org.id],
    ));
    expect(rows.rows[0]).toEqual({ agent_instance_id: tenant.runtimeAgentId, agent_role: AI_GROWTH_PARTNER_ROLE_KEY, status: "queued" });
  }, 120000);

  it("recovers an older Partner-only request saved under the legacy Lead Hunter default", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Partner Research Retry" });
    const saved = await researchRequest(tenant.ownerCtx, "Find 2 roofing contractors in Austin", { agentRole: "lead_hunter" });
    expect(saved).toMatchObject({ status: "waiting_for_agent", jobId: null });

    await retryResearchRequest(tenant.ownerCtx, saved.requestId);

    const rows = await withSystem((db) => db.query<{ agent_role: string; request_status: string; agent_instance_id: string; job_status: string }>(
      `select r.agent_role, r.status as request_status, j.agent_instance_id, j.status as job_status
         from lead_research_requests r join ai_work_jobs j on j.id = r.work_job_id and j.org_id = r.org_id
        where r.id = $1 and r.org_id = $2`,
      [saved.requestId, tenant.org.id],
    ));
    expect(rows.rows[0]).toEqual({ agent_role: AI_GROWTH_PARTNER_ROLE_KEY, request_status: "queued", agent_instance_id: tenant.runtimeAgentId, job_status: "queued" });
  }, 120000);

  it("persists the scheduled runtime role and retries a failed scheduled Partner job", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Scheduled Partner Research" });
    const scheduled = await withSystem((db) => createScheduledResearchJob(db, {
      orgId: tenant.org.id,
      agentId: tenant.runtimeAgentId,
      requestedBy: tenant.owner.id,
      scheduleId: crypto.randomUUID(),
      slot: new Date().toISOString(),
      payload: { prompt: "Find 3 independent dental clinics in Singapore" },
    }));
    expect(scheduled).toMatchObject({ jobId: expect.any(String), requestId: expect.any(String), created: true });
    if ("skipped" in scheduled) throw new Error(`Scheduled research was skipped: ${scheduled.skipped}`);
    const created = await withSystem((db) => db.query<{ agent_role: string; agent_instance_id: string }>(
      `select r.agent_role, j.agent_instance_id
         from lead_research_requests r join ai_work_jobs j on j.id = r.work_job_id and j.org_id = r.org_id
        where r.id = $1 and r.org_id = $2`,
      [scheduled.requestId, tenant.org.id],
    ));
    expect(created.rows[0]).toEqual({ agent_role: AI_GROWTH_PARTNER_ROLE_KEY, agent_instance_id: tenant.runtimeAgentId });

    await withSystem(async (db) => {
      await db.query("update ai_work_jobs set status = 'failed', stage = 'failed', failure_code = 'test_failure', finished_at = now() where id = $1 and org_id = $2", [scheduled.jobId, tenant.org.id]);
      await db.query("update lead_research_requests set status = 'failed', failure_reason = 'Synthetic failed schedule' where id = $1 and org_id = $2", [scheduled.requestId, tenant.org.id]);
    });
    await retryResearchRequest(tenant.ownerCtx, scheduled.requestId);
    const retried = await withSystem((db) => db.query<{ agent_role: string; request_status: string; agent_instance_id: string; job_status: string }>(
      `select r.agent_role, r.status as request_status, j.agent_instance_id, j.status as job_status
         from lead_research_requests r join ai_work_jobs j on j.id = r.work_job_id and j.org_id = r.org_id
        where r.id = $1 and r.org_id = $2`,
      [scheduled.requestId, tenant.org.id],
    ));
    expect(retried.rows[0]).toEqual({ agent_role: AI_GROWTH_PARTNER_ROLE_KEY, request_status: "queued", agent_instance_id: tenant.runtimeAgentId, job_status: "queued" });
  }, 120000);

  it("preserves the six-role Lead Hunter behavior", async () => {
    const tenant = await createLegacySixRoleTenant({ name: "Legacy Lead Research" });
    const created = await researchRequest(tenant.ownerCtx);
    expect(created).toMatchObject({ status: "waiting_for_agent", jobId: null });
    const rows = await withSystem((db) => db.query<{ agent_role: string; status: string }>(
      "select agent_role, status from lead_research_requests where id = $1 and org_id = $2",
      [created.requestId, tenant.org.id],
    ));
    expect(rows.rows[0]).toEqual({ agent_role: "lead_hunter", status: "waiting_for_agent" });
  }, 120000);

  it("bounds submissions while the Partner is unavailable without queuing work or charging research usage", async () => {
    const tenant = await createGrowthPartnerOnlyTenant({ name: "Unavailable Partner Research", runtime: "setup_required" });
    const created = await researchRequest(tenant.ownerCtx);
    expect(created).toMatchObject({ status: "waiting_for_agent", jobId: null });
    await expect(retryResearchRequest(tenant.ownerCtx, created.requestId)).rejects.toMatchObject({ code: "agent_unavailable" });

    for (let i = 1; i < RATE_LIMITS.researchByOrg.limit; i++) {
      expect(await researchRequest(tenant.ownerCtx)).toMatchObject({ status: "waiting_for_agent", jobId: null });
    }
    await expect(researchRequest(tenant.ownerCtx)).rejects.toMatchObject({ code: "rate_limited" });

    const { rows } = await withSystem((db) => db.query(
      `select (select count(*)::int from lead_research_requests where org_id = $1 and status = 'waiting_for_agent' and work_job_id is null) as waiting,
              (select count(*)::int from ai_work_jobs where org_id = $1 and capability = 'lead_research') as jobs,
              (select count(*)::int from agent_runs where org_id = $1 and purpose = 'lead_research') as runs,
              (select count(*)::int from usage_events where org_id = $1 and kind = 'lead_research') as usage,
              (select count(*)::int from lead_research_source_usage where org_id = $1) as source_reservations`,
      [tenant.org.id],
    ));
    expect(rows).toEqual([{ waiting: RATE_LIMITS.researchByOrg.limit, jobs: 0, runs: 0, usage: 0, source_reservations: 0 }]);
  }, 120000);
});
