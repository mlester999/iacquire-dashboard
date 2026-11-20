import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { createWorkJob } from "@/server/workforce/jobs";
import { fsaDirectoryRequestUrl, searchFsaDirectory, type FsaDirectoryConfig } from "@/server/leads/fsa-directory-source";
import {
  finishResearchSourceRequest, getResearchSourceHealth, getResearchSourcePolicy, hasApprovedDiscoverySource,
  reserveResearchSourceRequest, saveResearchSourcePolicy,
} from "@/server/leads/research-source-policy";
import { bindResearchOutputToSourceBundle, runApprovedResearchSources } from "@/server/leads/research-source-runner";
import { parseResearchOutput, qualifyCandidate } from "@/server/leads/research-contract";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

const source = "fsa_directory" as const;
const fsaConfig = (): FsaDirectoryConfig => ({
  authorityId: 123, authorityCode: "S99", authorityName: "Synthetic Borough",
  nameKeyword: "Synthetic", maxResults: 10, rightsAcknowledged: true,
  approvalExpiresOn: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
});
const settings = () => ({
  enabled: true, activationAcknowledged: true, providerFeeUsdPerRequest: 0,
  perJobRequestCap: 1, perDayRequestCap: 2, perJobSpendCapUsd: 0, perDaySpendCapUsd: 0, sourceConfig: fsaConfig(),
});
const establishment = {
  FHRSID: 987654321, BusinessName: "Synthetic Test Cafe", BusinessType: "Restaurant/Cafe/Canteen", BusinessTypeID: 1,
  LocalAuthorityCode: "S99", LocalAuthorityName: "Synthetic Borough", PostCode: "AB1 2CD",
  AddressLine1: "Synthetic private value", LocalAuthorityEmailAddress: "excluded@example.test",
  RatingValue: "0", RatingDate: "2026-10-01", RightToReply: "Excluded notes", geocode: { latitude: 51, longitude: 0 },
  links: [{ href: "https://unsafe.example.test/path" }],
};
const emptyHealth = { lastCompletedRunAt: null, lastResponseAt: null, lastError: null };

afterEach(() => vi.unstubAllGlobals());

async function workspace() {
  const org = await createOrg();
  const user = await createUser();
  await addMember(org.id, user.id, "owner");
  const ctx = ctxFor(user, org, "owner");
  const agent = await agentId(org.id, "lead_hunter");
  return {
    ctx, org, user,
    work: () => withSystem(async (db) => {
      const job = await createWorkJob(db, {
        orgId: org.id, agentId: agent, requestedBy: user.id, capability: "lead_research", title: "Synthetic FSA directory",
        idempotencyKey: `fsa-test:${randomUUID()}`, input: {},
      });
      const { rows } = await db.query<{ id: string }>(
        `insert into lead_research_requests (org_id, requested_by, prompt, status, work_job_id, agent_role)
         values ($1, $2, 'Find fictional cafés', 'queued', $3, 'lead_hunter') returning id`,
        [org.id, user.id, job.id],
      );
      return { orgId: org.id, jobId: job.id, requestId: rows[0].id };
    }),
  };
}

describe("approved FSA directory discovery", () => {
  it("keeps the exact API v2 region and restaurant filters and redacts everything except company evidence", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ establishments: [
      establishment, establishment,
      { ...establishment, FHRSID: 3, LocalAuthorityCode: "NEARBY" },
      { ...establishment, FHRSID: 4, LocalAuthorityName: "Nearby Borough" },
      { ...establishment, FHRSID: 5, BusinessTypeID: 2 },
      { ...establishment, FHRSID: 6, BusinessType: "Other catering premises" },
      { ...establishment, FHRSID: 7, PostCode: "AB1" },
      { ...establishment, FHRSID: 8, BusinessName: "Unrelated Test Cafe" },
      { ...establishment, FHRSID: 9, BusinessName: "someone@example.test" },
    ], links: [{ href: "https://unsafe.example.test/next" }] }));
    vi.stubGlobal("fetch", fetcher);
    const usage = { reserveRequest: vi.fn().mockResolvedValue("usage"), finishRequest: vi.fn() };
    const result = await searchFsaDirectory(fsaConfig(), usage);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://api.ratings.food.gov.uk/Establishments");
    expect(Object.fromEntries(url.searchParams)).toEqual({ localAuthorityId: "123", businessTypeId: "1", pageNumber: "1", pageSize: "10", name: "Synthetic" });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store", headers: { "x-api-version": "2" } });
    expect(usage.reserveRequest).toHaveBeenCalledBefore(fetcher);
    expect(usage.finishRequest).toHaveBeenCalledWith("usage", { responseReceived: true, httpStatus: 200, metadata: { validPayload: true } });
    expect(result.candidates).toEqual([{
      businessName: "Synthetic Test Cafe", industry: "Restaurant, café or canteen", location: "Synthetic Borough",
      evidenceUrl: "https://ratings.food.gov.uk/business/987654321",
      summary: expect.stringMatching(/Open Government Licence v3\.0/),
    }]);
    expect(JSON.stringify(result)).not.toMatch(/excluded|AB1 2CD|private value|unsafe|RatingValue|geocode/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("charges declared failures without retrying, and distinguishes invalid payloads from valid empty pages", async () => {
    const usage = { reserveRequest: vi.fn().mockResolvedValue("usage"), finishRequest: vi.fn() };
    const fetcher = vi.fn().mockResolvedValueOnce({ status: 429, text: "{}" })
      .mockResolvedValueOnce({ status: 200, text: '{"establishments":[{}]}' })
      .mockResolvedValueOnce({ status: 200, text: '{"establishments":[]}' })
      .mockRejectedValueOnce(new Error("excluded upstream diagnostics"));
    await expect(searchFsaDirectory(fsaConfig(), usage, fetcher)).rejects.toThrow(/will not be retried/);
    await expect(searchFsaDirectory(fsaConfig(), usage, fetcher)).rejects.toThrow(/usable result/);
    await expect(searchFsaDirectory(fsaConfig(), usage, fetcher)).resolves.toMatchObject({ candidates: [] });
    await expect(searchFsaDirectory(fsaConfig(), usage, fetcher)).rejects.toThrow(/No retry/);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(usage.finishRequest.mock.calls).toEqual([
      ["usage", { responseReceived: true, httpStatus: 429, metadata: { validPayload: false } }],
      ["usage", { responseReceived: true, httpStatus: 200, metadata: { validPayload: false } }],
      ["usage", { responseReceived: true, httpStatus: 200, metadata: { validPayload: true } }],
      ["usage", { responseReceived: false, httpStatus: null }],
    ]);
  });

  it("requires current scope and rights and enforces concurrent, per-job and daily caps in the tenant ledger", async () => {
    const a = await workspace();
    const b = await workspace();
    const cfg = settings();
    const first = await a.work();
    const second = await a.work();
    const third = await a.work();
    const requestUrl = fsaDirectoryRequestUrl(cfg.sourceConfig).href;
    const reserve = (work: typeof first, url = requestUrl) => reserveResearchSourceRequest({ ...work, source, requestUrl: url, transport: "synthetic_fixture" });
    await expect(reserve(first)).rejects.toThrow(/not configured/);
    await expect(saveResearchSourcePolicy(a.ctx, source, { ...cfg, activationAcknowledged: false })).rejects.toThrow(/Confirm/);
    await expect(saveResearchSourcePolicy(a.ctx, source, { ...cfg, sourceConfig: { ...cfg.sourceConfig, rightsAcknowledged: false } })).rejects.toThrow(/terms/);
    await expect(saveResearchSourcePolicy(a.ctx, source, { ...cfg, perDayRequestCap: 13 })).rejects.toThrow(/12 per UTC day/);
    await expect(saveResearchSourcePolicy(a.ctx, source, { ...cfg, sourceConfig: { ...cfg.sourceConfig, approvalExpiresOn: "1990-01-01" } })).rejects.toThrow(/expiry/);
    await expect(saveResearchSourcePolicy(ctxFor(a.user, a.org, "member"), source, cfg)).rejects.toMatchObject({ code: "forbidden" });
    await saveResearchSourcePolicy(a.ctx, source, cfg);
    expect(await withSystem((db) => hasApprovedDiscoverySource(db, a.org.id))).toBe(true);
    expect(await withUser(b.user.id, (db) => getResearchSourcePolicy(db, a.org.id, source))).toBeNull();
    await expect(reserve(await b.work())).rejects.toThrow(/not configured/);
    await expect(reserve({ ...first, requestId: second.requestId })).rejects.toThrow(/different research job/);
    for (const bad of [
      requestUrl.replace("api.ratings.food.gov.uk", "wrong.example.test"),
      requestUrl.replace("localAuthorityId=123", "localAuthorityId=999"),
      requestUrl.replace("businessTypeId=1", "businessTypeId=2"),
      requestUrl.replace("pageNumber=1", "pageNumber=2"),
      `${requestUrl}&token=excluded`,
    ]) {
      await expect(reserve(first, bad)).rejects.toThrow(/does not match/);
    }
    const active = await reserve(first);
    await expect(reserve(second)).rejects.toThrow(/in progress/);
    await finishResearchSourceRequest({ orgId: a.org.id, usageId: active.usageId, responseReceived: false, httpStatus: null });
    await expect(reserve(first)).rejects.toThrow(/per-job request cap/);
    const successful = await reserve(second);
    await finishResearchSourceRequest({ orgId: a.org.id, usageId: successful.usageId, responseReceived: true, httpStatus: 200 });
    await expect(reserve(third)).rejects.toThrow(/per-day request cap/);
    const { rows } = await withSystem((db) => db.query(
      "select request_url, status, policy_snapshot from lead_research_source_usage where org_id = $1 order by sequence", [a.org.id],
    ));
    expect(rows).toMatchObject([
      { request_url: "https://api.ratings.food.gov.uk/Establishments", status: "transport_failed",
        policy_snapshot: { approvedBy: a.user.id, providerFeeUsdPerRequest: 0, transport: "synthetic_fixture" } },
      { request_url: "https://api.ratings.food.gov.uk/Establishments", status: "responded" },
    ]);
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [a.org.id, a.user.id]));
    await expect(reserve(third)).rejects.toThrow(/active workspace owner or admin/);
  });

  it("uses the directory as a standalone discovery source and routes licensed evidence to review with synthetic provenance", async () => {
    const a = await workspace();
    const work = await a.work();
    const fetcher = vi.fn().mockResolvedValue({ status: 200, text: JSON.stringify({ establishments: [establishment, {
      ...establishment, FHRSID: 987654322, BusinessName: "Synthetic Excluded Cafe",
    }] }) });
    const dependencies = { fsaDirectoryFetcher: fetcher };
    await expect(runApprovedResearchSources({ ...work, dependencies })).resolves.toBeNull();
    await saveResearchSourcePolicy(a.ctx, source, settings());
    await expect(runApprovedResearchSources({
      ...work, dependencies, beforeProviderRequest: async () => { throw new Error("No tools isolation unavailable"); },
    })).rejects.toThrow(/isolation unavailable/);
    expect(fetcher).not.toHaveBeenCalled();
    const out = await runApprovedResearchSources({ ...work, dependencies, targeting: { excluded: ["synthetic excluded cafe"] } });
    expect(out?.bundle).toMatchObject({
      requests: 1, discoveryRequests: 1, pagesReviewed: 0, providerFeeUsd: 0, synthetic: true,
      sourceNames: ["synthetic FSA directory fixture"], candidates: [{ website: null, evidence: [{ source }] }],
      warnings: ["1 candidate matched an exact exclusion in the saved targeting rules."],
    });
    expect(out?.promptContext).toContain("Do not call web search");
    expect(out?.promptContext).not.toMatch(/excluded|private value/i);
    const evidenceUrl = out!.bundle.candidates[0].evidence[0].url;
    const invented = parseResearchOutput(JSON.stringify({ leads: [{
      business_name: "Synthetic Test Cafe", website: "https://made-up.example.test", location: "Outside",
      evidence: [{ url: evidenceUrl, summary: "Made up" }], buying_signals: [{ signal: "Wants outreach", evidence_url: evidenceUrl }],
      disqualification_reason: "Bad rating", disqualification_evidence_url: evidenceUrl,
      qualification_summary: "Fake reason", score: { buying_intent: 20 },
    }] })).leads;
    const bound = bindResearchOutputToSourceBundle(invented, out!.bundle);
    expect(bound.leads[0]).toMatchObject({
      website: null, location: "Synthetic Borough", buying_signals: [], signal_records: [], score: {},
      disqualification_reason: null, disqualification_evidence_url: null, evidence: [{ url: evidenceUrl, source }],
    });
    expect(bound.leads[0].qualification_summary).toContain("first-party details");
    expect(qualifyCandidate(bound.leads[0], { status: "no_match", matches: [] })).toMatchObject({ state: "needs_evidence" });
    const health = await withSystem(async (db) => getResearchSourceHealth(db, (await getResearchSourcePolicy(db, a.org.id, source))!));
    expect(health).toEqual(emptyHealth);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("records provider health only for validated current-approval responses and protects approval history from rollback", async () => {
    const a = await workspace();
    const cfg = settings();
    await saveResearchSourcePolicy(a.ctx, source, cfg);
    const snapshotHealth = () => withSystem(async (db) => getResearchSourceHealth(db, (await getResearchSourcePolicy(db, a.org.id, source))!));
    const usage = async (validPayload: boolean) => {
      const work = await a.work();
      const { usageId } = await reserveResearchSourceRequest({
        ...work, source, requestUrl: fsaDirectoryRequestUrl(cfg.sourceConfig).href, transport: "approved_source",
      });
      await finishResearchSourceRequest({ orgId: a.org.id, usageId, responseReceived: true, httpStatus: 200, metadata: { validPayload } });
      return work;
    };
    // Ledger rows exercise the trust filter without calling any transport or impersonating a real run.
    await usage(false);
    expect(await snapshotHealth()).toMatchObject({ ...emptyHealth, lastError: { httpStatus: 200, invalidResponse: true } });
    const good = await usage(true);
    await withSystem((db) => db.query("update ai_work_jobs set status = 'completed', finished_at = now() where org_id = $1 and id = $2", [good.orgId, good.jobId]));
    expect(await snapshotHealth()).toMatchObject({ lastCompletedRunAt: expect.any(String), lastResponseAt: expect.any(String) });
    const down = readFileSync("supabase/rollbacks/0145_fsa_directory_research_source.down.sql", "utf8");
    await expect(withSystem((db) => db.query(down))).rejects.toThrow(/approval or usage records exist/);
    await withSystem((db) => db.query(
      "update lead_research_source_settings set source_config = jsonb_set(source_config, '{approvalExpiresOn}', '\"1990-01-01\"') where org_id = $1",
      [a.org.id],
    ));
    expect(await withSystem((db) => hasApprovedDiscoverySource(db, a.org.id))).toBe(false);
    expect(await snapshotHealth()).toEqual(emptyHealth);
  });
});
