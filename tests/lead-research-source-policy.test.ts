import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { claimWorkJob, createWorkJob, requestWorkJobCancel } from "@/server/workforce/jobs";
import {
  reserveResearchSourceRequest,
  saveResearchSourcePolicy,
  finishResearchSourceRequest,
  getResearchSourceHealth,
  getResearchSourcePolicy,
} from "@/server/leads/research-source-policy";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

const OSM = {
  endpoint: "https://overpass-api.de/api/interpreter",
  approvedEndpointHosts: ["overpass-api.de"],
  userAgent: "iAcquireOS-policy-test/1.0",
  bounds: { south: 28.1, west: -81.6, north: 28.8, east: -81.1 },
  maxResults: 10,
  timeoutSeconds: 20,
};

async function createResearchWork(org: { id: string }, user: { id: string }) {
  const agent = await agentId(org.id, "lead_hunter");
  return withSystem(async (db) => {
    const job = await createWorkJob(db, {
      orgId: org.id,
      agentId: agent,
      requestedBy: user.id,
      capability: "lead_research",
      title: "Source budget test",
      idempotencyKey: `source-budget:${crypto.randomUUID()}`,
      input: {},
    });
    const { rows } = await db.query<{ id: string }>(
      `insert into lead_research_requests (org_id, requested_by, prompt, status, work_job_id, agent_role)
      values ($1, $2, 'Find synthetic roofing companies', 'queued', $3, 'lead_hunter') returning id`,
      [org.id, user.id, job.id],
    );
    return { jobId: job.id, requestId: rows[0].id };
  });
}

describe("tenant-scoped lead research source budgets", () => {
  it("starts disabled, requires explicit activation, and reserves budget atomically before a request", async () => {
    const org = await createOrg({ name: "Source budget acceptance" });
    const owner = await createUser({ name: "Source budget owner" });
    await addMember(org.id, owner.id, "owner");
    const ctx = ctxFor(owner, org, "owner");
    const work = await createResearchWork(org, owner);

    await expect(reserveResearchSourceRequest({
      orgId: org.id,
      jobId: work.jobId,
      requestId: work.requestId,
      source: "openstreetmap",
      requestUrl: OSM.endpoint,
    })).rejects.toThrow(/not configured/);

    const policy = {
      enabled: true,
      providerFeeUsdPerRequest: 0,
      perJobRequestCap: 1,
      perDayRequestCap: 1,
      perJobSpendCapUsd: 0,
      perDaySpendCapUsd: 0,
      sourceConfig: OSM,
    } as const;
    await expect(saveResearchSourcePolicy(ctx, "openstreetmap", policy)).rejects.toThrow(/Confirm/);
    await saveResearchSourcePolicy(ctx, "openstreetmap", { ...policy, activationAcknowledged: true });

    const otherWork = await createResearchWork(org, owner);
    const workerId = "local-acquisition-worker";
    await expect(reserveResearchSourceRequest({ orgId: org.id, ...work, workerId, source: "openstreetmap", requestUrl: OSM.endpoint })).rejects.toThrow(/lease is no longer active/);
    await expect(reserveResearchSourceRequest({ orgId: org.id, ...work, requestId: otherWork.requestId, source: "openstreetmap", requestUrl: OSM.endpoint })).rejects.toThrow(/different research job/);
    await withSystem((db) => claimWorkJob(db, { orgId: org.id, jobId: work.jobId, workerId, leaseSeconds: 180 }));
    const reservations = await Promise.allSettled([
      reserveResearchSourceRequest({ orgId: org.id, ...work, workerId, source: "openstreetmap", requestUrl: OSM.endpoint }),
      reserveResearchSourceRequest({ orgId: org.id, ...otherWork, source: "openstreetmap", requestUrl: OSM.endpoint }),
    ]);
    await withSystem((db) => requestWorkJobCancel(db, { orgId: org.id, jobId: work.jobId }));
    await expect(reserveResearchSourceRequest({ orgId: org.id, ...work, workerId, source: "openstreetmap", requestUrl: OSM.endpoint })).rejects.toThrow(/lease is no longer active/);
    const granted = reservations.filter((result) => result.status === "fulfilled");
    const denied = reservations.filter((result) => result.status === "rejected");
    expect(granted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    if (granted[0]?.status !== "fulfilled") throw new Error("No source budget reservation was granted.");

    await finishResearchSourceRequest({
      orgId: org.id,
      usageId: granted[0].value.usageId,
      responseReceived: true,
      httpStatus: 200,
      metadata: { candidateCount: 4 },
    });
    const { rows } = await withSystem((db) => db.query<{
      source: string; sequence: number; status: string; provider_fee_usd: string; http_status: number; policy_snapshot: Record<string, unknown>;
    }>(
      `select source, sequence, status, provider_fee_usd, http_status, policy_snapshot
         from lead_research_source_usage where org_id = $1`,
      [org.id],
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "openstreetmap", sequence: 1, status: "responded", provider_fee_usd: "0.000000", http_status: 200 });
    expect(rows[0]?.policy_snapshot).toMatchObject({
      providerFeeUsdPerRequest: 0,
      perJobRequestCap: 1,
      perDayRequestCap: 1,
      approvedBy: owner.id,
    });
  });

  it("does not expose one tenant's source settings or usage to another tenant", async () => {
    const first = await createOrg({ name: "First source policy tenant" });
    const second = await createOrg({ name: "Second source policy tenant" });
    const firstOwner = await createUser({ name: "First source owner" });
    const secondOwner = await createUser({ name: "Second source owner" });
    await addMember(first.id, firstOwner.id, "owner");
    await addMember(second.id, secondOwner.id, "owner");
    await saveResearchSourcePolicy(ctxFor(firstOwner, first, "owner"), "company_website", {
      enabled: false,
      providerFeeUsdPerRequest: 0,
      perJobRequestCap: 0,
      perDayRequestCap: 0,
      perJobSpendCapUsd: 0,
      perDaySpendCapUsd: 0,
      sourceConfig: { approvedDomains: ["fixture-company.example"], maxRequests: 4 },
    });

    const visible = await withUser(secondOwner.id, (db) => db.query(
      "select org_id, source from lead_research_source_settings where org_id = $1",
      [first.id],
    ));
    expect(visible.rows).toEqual([]);
  });

  it("uses current-approval response evidence and excludes fixture and older ledger rows from source health", async () => {
    const org = await createOrg();
    const owner = await createUser();
    const otherTenantOwner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const ctx = ctxFor(owner, org, "owner");
    const settings = {
      enabled: true, activationAcknowledged: true, providerFeeUsdPerRequest: 0, perJobRequestCap: 10, perDayRequestCap: 10,
      perJobSpendCapUsd: 0, perDaySpendCapUsd: 0, sourceConfig: OSM,
    };
    await saveResearchSourcePolicy(ctx, "openstreetmap", settings);

    async function ledger(transport: "approved_source" | "synthetic_fixture" | undefined, httpStatus: number | null, date: string, completedRun = false) {
      const work = await createResearchWork(org, owner);
      const { usageId } = await reserveResearchSourceRequest({
        orgId: org.id, ...work, source: "openstreetmap", requestUrl: OSM.endpoint, transport,
      });
      await finishResearchSourceRequest({ orgId: org.id, usageId, responseReceived: httpStatus !== null, httpStatus });
      await withSystem(async (db) => {
        await db.query("update lead_research_source_usage set completed_at = $2 where id = $1 and org_id = $3", [usageId, date, org.id]);
        if (completedRun) {
          await db.query("update ai_work_jobs set status = 'completed', finished_at = $2 where id = $1 and org_id = $3", [work.jobId, date, org.id]);
        }
      });
    }

    const policy = (await withUser(owner.id, (db) => getResearchSourcePolicy(db, org.id, "openstreetmap")))!;
    const empty = { lastResponseAt: null, lastCompletedRunAt: null, lastError: null };
    await ledger("synthetic_fixture", 200, "2026-11-18T00:00:00Z", true);
    await ledger(undefined, 429, "2026-11-18T00:00:00Z");
    expect(await withUser(owner.id, (db) => getResearchSourceHealth(db, policy))).toEqual(empty);

    // Synthetic database records exercise the trust filter. No transport is called by this test.
    await ledger("approved_source", 200, "2026-11-17T00:00:00Z", true);
    await ledger("approved_source", 429, "2026-11-17T00:10:00Z");
    expect(await withUser(owner.id, (db) => getResearchSourceHealth(db, policy))).toEqual({
      lastResponseAt: "2026-11-17T00:00:00.000Z",
      lastCompletedRunAt: "2026-11-17T00:00:00.000Z",
      lastError: { at: "2026-11-17T00:10:00.000Z", httpStatus: 429 },
    });
    expect(await withUser(otherTenantOwner.id, (db) => getResearchSourceHealth(db, policy))).toEqual(empty);
    expect(await withUser(owner.id, (db) => getResearchSourceHealth(db, { ...policy, approvedAt: new Date(policy.approvedAt!.getTime() + 1000) }))).toEqual(empty);
  });
});
