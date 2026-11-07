import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { emptyBusinessBrain } from "@/lib/ai-growth-partner";
import { getGrowthPartnerConversationPage, searchGrowthPartnerConversation } from "@/server/ai-growth-partner/service";
import { parseGrowthPartnerMemoryCommand } from "@/lib/ai-growth-partner-memory";
import { growthPartnerMemoryPromptContext } from "@/server/ai-growth-partner/memory";
import { decideApproval } from "@/server/approvals/service";
import { addMember, createUser, ctxFor } from "./support/fixtures";
import { createCompanyWebsiteFetchPolicy } from "@/server/leads/company-website-source";
import { analyzeWebsite, type PageFetcher, type WebsiteAnalysis } from "@/server/onboarding/website";
import { searchOpenStreetMap, type OpenStreetMapSourceConfig } from "@/server/leads/openstreetmap-source";
import { runLeadResearchJob } from "@/server/leads/research-job";
import { getWorkJobView } from "@/server/workforce/jobs";
import { listWorkBoardJobs } from "@/server/workforce/work-board";
import { registerWorkHandler } from "@/server/workforce/work-runner";
import { connectHermesProfile, createConfigVersion, ensureGrowthPartnerRuntime, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { listLeads, requestCrmImport, reviewLeads, saveTargeting } from "@/server/leads/service";
import { saveResearchSourcePolicy } from "@/server/leads/research-source-policy";
import { sendChatMessage } from "@/server/chat/service";
import { startMockHermes, type MockHermes, type MockScript } from "./support/mock-hermes";

const fixtureState = vi.hoisted(() => ({ notificationAttempts: 0 }));
vi.mock("@/server/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications")>()),
  // The fixture run records but never delivers tenant notifications.
  notifyOrgRoles: async () => { fixtureState.notificationAttempts += 1; },
}));

const PROFILE = "c-growth-partner-fixture-acceptance";
const KEY = "g".repeat(40);
const TENANT_NAME = "Growth Partner Acceptance - Roofing";
const TENANT_SLUG = "growth-partner-acceptance-roofing";
const TEST_REGION = "Orlando metropolitan area, Florida, USA";
const EXACT_DOMAINS = [
  "orlando-roofing-alpha.test",
  "winter-park-roofing.test",
  "kissimmee-roofing.test",
  "orlando-plumbing-control.test",
] as const;
const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/ai-growth-partner-acceptance/", import.meta.url));
const BUDGET = { perJobSpendCapUsd: 0, perDaySpendCapUsd: 0 } as const;
const OSM_CONFIG: OpenStreetMapSourceConfig = {
  enabled: true,
  endpoint: "https://overpass-api.de/api/interpreter",
  approvedEndpointHosts: ["overpass-api.de"],
  userAgent: "iAcquireOS-fixture-acceptance/1.0",
  providerFeeUsdPerRequest: 0,
  perJobSpendCapUsd: BUDGET.perJobSpendCapUsd,
  maxResults: 10,
};

type DiscoveryFixture = {
  synthetic: boolean;
  sourceLabel: string;
  osm3s: { timestamp_osm_base: string };
  preexistingCrmCompany: { name: string; domain: string };
  elements: unknown[];
};

let mock: MockHermes;
let owner: { id: string; email: string };
let agencyAdmin: { id: string; email: string };
let org: { id: string; name: string; slug: string; agentId: string; partnerId: string; conversationId: string };
let context: ReturnType<typeof ctxFor>;
let fixtureLeads: Array<Record<string, unknown>>;
let webPagesReviewed = 0;
let osmFixtureCalls = 0;
let localPageReads = 0;
let notificationAttemptsBeforeMainRun = 0;

async function loadFixtureLeadData() {
  const fixture = JSON.parse(await readFile(join(FIXTURE_ROOT, "discovery.json"), "utf8")) as DiscoveryFixture;
  expect(fixture.synthetic).toBe(true);
  const websiteHtml = new Map<string, Record<string, string>>();
  for (const domain of EXACT_DOMAINS) websiteHtml.set(domain, {});
  for (const [domain, file] of [
    [EXACT_DOMAINS[0], "orlando-roofing-alpha.html"],
    [EXACT_DOMAINS[0], "orlando-roofing-alpha-careers.html"],
    [EXACT_DOMAINS[1], "winter-park-roofing.html"],
    [EXACT_DOMAINS[2], "kissimmee-roofing.html"],
    [EXACT_DOMAINS[3], "orlando-plumbing-control.html"],
  ] as const) {
    const html = await readFile(join(FIXTURE_ROOT, "websites", file), "utf8");
    const path = file.endsWith("-careers.html") ? "/careers/" : "/";
    websiteHtml.get(domain)![path] = html;
  }

  const discovery = await searchOpenStreetMap(OSM_CONFIG, {
    south: 28.1,
    west: -81.6,
    north: 28.8,
    east: -81.1,
  }, async (_url, init) => {
    osmFixtureCalls += 1;
    expect(init.method).toBe("POST");
    return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  expect(discovery.usage.providerFeeUsd).toBe(0);
  expect(discovery.candidates).toHaveLength(4);

  const analyses = new Map<string, WebsiteAnalysis>();
  const localPageFetcher: PageFetcher = async (url) => {
    if (url.pathname === "/robots.txt") {
      return { url: url.toString(), status: 200, contentType: "text/plain", body: "User-agent: *\nAllow: /" };
    }
    const body = websiteHtml.get(url.hostname)?.[url.pathname];
    return body
      ? { url: url.toString(), status: 200, contentType: "text/html", body }
      : { url: url.toString(), status: 404, contentType: "text/html", body: "" };
  };
  for (const candidate of discovery.candidates) {
    const domain = new URL(candidate.websiteUrl!).hostname;
    const approvedDomains = EXACT_DOMAINS.filter((item) => item === domain);
    const policy = createCompanyWebsiteFetchPolicy(
      { enabled: true, approvedDomains, maxRequests: 4 },
      domain,
      { now: () => 10_000, wait: async () => undefined },
    );
    const fetcher: PageFetcher = async (url) => {
      localPageReads += 1;
      await policy.beforeRequest?.(url);
      if (!policy.allowUrl?.(url)) throw new Error("Fixture page escaped its exact approved domain.");
      return localPageFetcher(url);
    };
    const analysis = await analyzeWebsite(candidate.websiteUrl!, fetcher, { robotsFailureMode: "fail_closed" });
    expect(analysis.unverified).toBe(true);
    analyses.set(domain, analysis);
  }
  webPagesReviewed = [...analyses.values()].reduce((count, analysis) => count + analysis.pages.length, 0);

  return {
    fixture,
    localPageFetcher,
    fixtureLeads: discovery.candidates.map((candidate) => {
      const domain = new URL(candidate.websiteUrl!).hostname;
      const analysis = analyses.get(domain)!;
      const pageEvidence = analysis.pages.map((page) => ({
        url: page.url,
        summary: [page.title, page.description, ...page.paragraphs].filter(Boolean).join(" ").slice(0, 480),
      }));
      const allPageText = analysis.pages.flatMap((page) => [page.title, page.description, ...page.headings, ...page.paragraphs]).join(" ");
      const isPlumbing = candidate.category === "plumber";
      const isMissingInformation = domain === "kissimmee-roofing.test";
      const signalPage = analysis.pages.find((page) => page.paragraphs.some((paragraph) => /hiring|expanding/i.test(paragraph)));
      const signalText = signalPage?.paragraphs.find((paragraph) => /hiring|expanding/i.test(paragraph)) ?? null;
      const discoveryEvidence = {
        url: candidate.evidenceUrl,
        summary: `${fixture.sourceLabel}. Object ${candidate.osmType}/${candidate.osmId} lists ${candidate.businessName} as ${candidate.category ?? "a local business"} in ${candidate.location ?? "the Orlando metro"}. Dataset timestamp ${fixture.osm3s.timestamp_osm_base}.`,
      };
      const evidence = isMissingInformation ? [discoveryEvidence] : [discoveryEvidence, ...pageEvidence];
      return {
        business_name: candidate.businessName,
        website: candidate.websiteUrl,
        industry: isPlumbing ? "Plumbing contractor" : "Roofing contractor",
        location: candidate.location,
        evidence,
        buying_signals: signalText && signalPage ? [{
          signal: signalText.slice(0, 200),
          evidence_url: signalPage.url,
          confidence: 0.82,
          client_fit: "The cited hiring notice may indicate a need to coordinate incoming roofing estimates.",
        }] : [],
        qualification_summary: isMissingInformation
          ? null
          : isPlumbing
            ? "The cited company page describes plumbing services and identifies Orlando as its service area."
            : `The cited company page confirms roofing services in ${candidate.location ?? "the Orlando metro"}.`,
        disqualification_reason: isPlumbing && /does not provide roofing services/i.test(allPageText)
          ? "The company identifies as a plumbing and drain business and states that it does not provide roofing services, outside the client's roofing-only targeting."
          : null,
        disqualification_evidence_url: isPlumbing ? analysis.pages[0]?.url : null,
        score: {
          service_fit: isPlumbing || isMissingInformation ? 0 : 26,
          problem_evidence: signalText ? 18 : isMissingInformation ? 0 : 10,
          buying_intent: signalText ? 14 : isMissingInformation ? 0 : 4,
          market_fit: isMissingInformation ? 0 : 13,
          source_quality: isMissingInformation ? 0 : evidence.length ? 9 : 0,
        },
      };
    }),
  };
}

async function createIsolatedTenant(name: string, slug: string, withPartner: boolean) {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into organizations (name, slug, kind, status) values ($1, $2, 'client', 'active') returning id",
      [name, slug],
    );
    const orgId = rows[0].id;
    await db.query(
      `insert into company_profiles (org_id, description, services, ideal_customers, operating_area)
       values ($1, $2, $3, $4, $5)`,
      [orgId, "Synthetic acceptance workspace for roofing acquisition workflows.", "Fictional lead qualification and appointment coordination for roofing companies.", "Roofing contractors in the Orlando metropolitan area.", TEST_REGION],
    );
    await db.query("insert into usage_limits (org_id) values ($1)", [orgId]);
    await db.query("insert into billing_accounts (org_id) values ($1)", [orgId]);
    const agentId = withPartner ? await ensureGrowthPartnerRuntime(orgId, db) : null;
    return { id: orgId, name, slug, agentId };
  });
}

async function waitForJob(jobId: string, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<{ status: string; stage: string | null }>(
      "select status, stage from ai_work_jobs where id = $1 and org_id = $2",
      [jobId, org.id],
    ));
    if (rows[0] && ["completed", "failed", "blocked", "cancelled"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Synthetic Growth Partner research job did not settle.");
}

async function waitForAssistantMessage(messageId: string, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = (await withSystem((db) => db.query<{ status: string }>(
      "select status from chat_messages where id = $1",
      [messageId],
    ))).rows[0];
    if (row?.status === "complete") return;
    if (row && ["failed", "cancelled"].includes(row.status)) throw new Error(`Follow-up chat ended as ${row.status}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Growth Partner follow-up did not finish.");
}
beforeAll(async () => {
  const { fixture, fixtureLeads: leads, localPageFetcher } = await loadFixtureLeadData();
  fixtureLeads = leads;
  const serialized = `\`\`\`json\n${JSON.stringify({ leads })}\n\`\`\``;
  const script: MockScript = {
    steps: [{ delta: serialized }],
    output: serialized,
  };
  mock = await startMockHermes({ [PROFILE]: { key: KEY, runToolScopeNoTools: true, respond: () => script } });

  owner = await createUser({ name: "Synthetic Roofing Workspace Owner" });
  agencyAdmin = await createUser({ platformRole: "agency_super_admin", name: "Fixture Runtime Admin" });
  const tenant = await createIsolatedTenant(TENANT_NAME, TENANT_SLUG, true);
  if (!tenant.agentId) throw new Error("The synthetic tenant has no Growth Partner runtime.");
  org = { ...tenant, agentId: tenant.agentId, partnerId: "", conversationId: "" };
  context = ctxFor(owner, org, "owner");
  await addMember(org.id, owner.id, "owner");
  await withSystem((db) => createConfigVersion(db, {
    orgId: org.id,
    agentId: org.agentId,
    settings: defaultSettings("growth_partner"),
    source: "onboarding",
    userId: owner.id,
    apply: true,
  }));
  await saveResearchSourcePolicy(context, "openstreetmap", {
    enabled: true,
    providerFeeUsdPerRequest: 0,
    perJobRequestCap: 1,
    perDayRequestCap: 1,
    perJobSpendCapUsd: BUDGET.perJobSpendCapUsd,
    perDaySpendCapUsd: BUDGET.perDaySpendCapUsd,
    sourceConfig: {
      endpoint: OSM_CONFIG.endpoint,
      approvedEndpointHosts: OSM_CONFIG.approvedEndpointHosts,
      userAgent: OSM_CONFIG.userAgent,
      bounds: { south: 28.1, west: -81.6, north: 28.8, east: -81.1 },
      maxResults: OSM_CONFIG.maxResults,
      timeoutSeconds: 20,
    },
    activationAcknowledged: true,
  });
  await saveResearchSourcePolicy(context, "company_website", {
    enabled: true,
    providerFeeUsdPerRequest: 0,
    perJobRequestCap: 100,
    perDayRequestCap: 100,
    perJobSpendCapUsd: BUDGET.perJobSpendCapUsd,
    perDaySpendCapUsd: BUDGET.perDaySpendCapUsd,
    sourceConfig: { approvedDomains: [...EXACT_DOMAINS], maxRequests: 4 },
    activationAcknowledged: true,
  });
  registerWorkHandler("lead_research", (job, workerContext) => runLeadResearchJob(job, workerContext, {
    researchSources: {
      openStreetMapFetcher: async (_url, init) => {
        osmFixtureCalls += 1;
        expect(init.method).toBe("POST");
        return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      companyWebsitePageFetcher: async (url) => {
        localPageReads += 1;
        return localPageFetcher(url);
      },
      now: () => 10_000,
      wait: async () => undefined,
      syntheticSourceLabel: fixture.sourceLabel,
    },
  }));
  await connectHermesProfile({ agentId: org.agentId, baseUrl: mock.url, profile: PROFILE, apiKey: KEY, agencyUserId: agencyAdmin.id });
  expect(await runHealthCheck(org.agentId, { userId: agencyAdmin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  await withSystem(async (db) => {
    const partner = (await db.query<{ id: string }>("select id from ai_growth_partners where org_id = $1 and runtime_agent_instance_id = $2", [org.id, org.agentId])).rows[0];
    if (!partner) throw new Error("The logical Growth Partner identity was not created.");
    org.partnerId = partner.id;
    await db.query(
      `insert into ai_growth_partner_versions (partner_id, org_id, version, business_brain, source, created_by)
       values ($1, $2, 1, $3::jsonb, 'onboarding', $4)`,
      [partner.id, org.id, JSON.stringify(emptyBusinessBrain()), owner.id],
    );
    await db.query("update ai_growth_partners set current_version = 1 where id = $1 and org_id = $2", [partner.id, org.id]);
  });
  // The health check provisions the canonical thread only after a partner version exists.
  expect(await runHealthCheck(org.agentId, { userId: agencyAdmin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  await withSystem(async (db) => {
    const partner = (await db.query<{ id: string }>("select id from ai_growth_partners where org_id = $1 and runtime_agent_instance_id = $2", [org.id, org.agentId])).rows[0];
    if (!partner) throw new Error("The logical Growth Partner identity was not created.");
    org.partnerId = partner.id;
    org.conversationId = (await db.query<{ id: string }>(
      "select id from chat_conversations where org_id = $1 and growth_partner_id = $2 and agent_instance_id = $3 and deleted_at is null",
      [org.id, partner.id, org.agentId],
    )).rows[0]?.id ?? "";
  });
  if (!org.conversationId) throw new Error("The canonical Growth Partner conversation was not provisioned.");
  await saveTargeting(context, {
    industries: ["roofing contractors"],
    countries: ["United States"],
    regions: ["Orlando", "Winter Park", "Kissimmee", "Orlando metropolitan area, Florida"],
    businessSize: "any",
    servicesNeeded: [],
    keywords: ["roofing"],
    customerType: "b2b",
    buyingSignals: ["hiring for field estimating or appointment coordination"],
    excluded: ["non-roofing trades"],
    minimumCriteria: "Include active roofing contractors in the Orlando metro. Exclude other trades only when a cited company page directly identifies the different service.",
    influencer: { enabled: false, platform: "instagram", niche: "", region: "", minFollowers: 0, engagementCriteria: "", objective: "" },
  });

  await withSystem((db) => db.query(
    "insert into crm_companies (org_id, name, domain, created_by) values ($1, $2, $3, $4)",
    [org.id, fixture.preexistingCrmCompany.name, fixture.preexistingCrmCompany.domain, owner.id],
  ));
  fixtureState.notificationAttempts = 0;
}, 120_000);

afterAll(async () => {
  await mock?.close();
  registerWorkHandler("lead_research", runLeadResearchJob);
});

describe("AI Growth Partner synthetic fixture acceptance", () => {
  it("blocks before source access when Hermes cannot verify the no-tools run boundary", async () => {
    mock.setRunToolScopeNoTools(PROFILE, false);
    const requestsBefore = osmFixtureCalls;
    const pagesBefore = localPageReads;
    try {
      const sent = await sendChatMessage(context, {
        agentRole: "growth_partner",
        conversationId: org.conversationId,
        content: "Find 4 roofing contractors in the Orlando metropolitan area including Orlando, Winter Park and Kissimmee. Use only this synthetic fixture dataset; do not contact anyone.",
        clientMessageId: crypto.randomUUID(),
      });
      expect(sent).toMatchObject({ conversationId: org.conversationId, runId: null, jobId: expect.any(String) });
      expect(await waitForJob(sent.jobId!)).toMatchObject({ status: "blocked" });
      expect(osmFixtureCalls).toBe(requestsBefore);
      expect(localPageReads).toBe(pagesBefore);
      expect(mock.runs.size).toBe(0);
      expect(mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/runs")).toHaveLength(0);
    } finally {
      mock.setRunToolScopeNoTools(PROFILE, true);
    }
    notificationAttemptsBeforeMainRun = fixtureState.notificationAttempts;
  }, 120_000);

  it("handles explicit persistent-memory commands inside the one Partner conversation without a Hermes call", async () => {
    const requestCount = mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/runs").length;
    const memoryText = "We prefer a concise weekly report focused on qualified roofing estimates.";
    const first = await sendChatMessage(context, {
      agentRole: "growth_partner",
      conversationId: org.conversationId,
      content: "Remember: " + memoryText,
      clientMessageId: crypto.randomUUID(),
    });
    expect(first).toMatchObject({ conversationId: org.conversationId, runId: null, jobId: null, userMessageId: expect.any(String) });
    const stored = (await withSystem((db) => db.query<{ id: string; source_message_id: string; kind: string }>(
      "select id, source_message_id, kind from ai_growth_partner_memories where org_id = $1 and partner_id = $2",
      [org.id, org.partnerId],
    ))).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ source_message_id: first.userMessageId, kind: "working_context" });

    const contextBlock = await withSystem((db) => growthPartnerMemoryPromptContext(db, org.id, org.agentId, "How are qualified roofing estimates progressing?"));
    expect(contextBlock).toContain(JSON.stringify(memoryText));
    expect(contextBlock).toContain("never override current verified records");

    const repeated = await sendChatMessage(context, {
      agentRole: "growth_partner",
      conversationId: org.conversationId,
      content: "Remember: " + memoryText,
      clientMessageId: crypto.randomUUID(),
    });
    expect(repeated).toMatchObject({ runId: null, jobId: null });
    expect((await withSystem((db) => db.query(
      "select id from ai_growth_partner_memories where org_id = $1 and partner_id = $2",
      [org.id, org.partnerId],
    ))).rows).toHaveLength(1);

    const forgotten = await sendChatMessage(context, {
      agentRole: "growth_partner",
      conversationId: org.conversationId,
      content: "Forget: " + memoryText,
      clientMessageId: crypto.randomUUID(),
    });
    expect(forgotten).toMatchObject({ runId: null, jobId: null });
    expect((await withSystem((db) => db.query(
      "select id from ai_growth_partner_memories where org_id = $1 and partner_id = $2",
      [org.id, org.partnerId],
    ))).rows).toEqual([]);
    const history = await getGrowthPartnerConversationPage(context);
    expect(history?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.userMessageId, role: "user", content: "Remember: " + memoryText }),
      expect.objectContaining({ id: forgotten.userMessageId, role: "user", content: "Forget: " + memoryText }),
    ]));
    const followUp = await sendChatMessage(context, {
      agentRole: "growth_partner",
      conversationId: org.conversationId,
      content: "What should I focus on next?",
      clientMessageId: crypto.randomUUID(),
    });
    expect(followUp.runId).toBeTruthy();
    await waitForAssistantMessage(followUp.assistantMessageId);
    const { rows: runRows } = await withSystem((db) => db.query<{ hermes_run_id: string }>(
      "select hermes_run_id from agent_runs where id = $1",
      [followUp.runId],
    ));
    const followUpRun = mock.runs.get(runRows[0]!.hermes_run_id);
    const promptHistory = followUpRun?.body.conversation_history as Array<{ role: string; content: string }>;
    expect(promptHistory.some((turn) => turn.content.includes(memoryText))).toBe(false);
    expect(followUpRun).toBeTruthy();
    expect(promptHistory.some((turn) => turn.role === "user" && parseGrowthPartnerMemoryCommand(turn.content).kind !== "none")).toBe(false);
    expect(mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/runs")).toHaveLength(requestCount + 1);
  }, 120_000);

  it("blocks direct Partner research requests when all approved discovery sources are disabled", async () => {
    await saveResearchSourcePolicy(context, "openstreetmap", {
      enabled: false,
      providerFeeUsdPerRequest: 0,
      perJobRequestCap: 0,
      perDayRequestCap: 0,
      perJobSpendCapUsd: 0,
      perDaySpendCapUsd: 0,
      sourceConfig: {
        endpoint: OSM_CONFIG.endpoint,
        approvedEndpointHosts: OSM_CONFIG.approvedEndpointHosts,
        userAgent: OSM_CONFIG.userAgent,
        bounds: { south: 28.1, west: -81.6, north: 28.8, east: -81.1 },
        maxResults: OSM_CONFIG.maxResults,
        timeoutSeconds: 20,
      },
    });
    await saveResearchSourcePolicy(context, "company_website", {
      enabled: false,
      providerFeeUsdPerRequest: 0,
      perJobRequestCap: 0,
      perDayRequestCap: 0,
      perJobSpendCapUsd: 0,
      perDaySpendCapUsd: 0,
      sourceConfig: { approvedDomains: [...EXACT_DOMAINS], maxRequests: 4 },
    });
    const osmCallsBefore = osmFixtureCalls;
    const pageReadsBefore = localPageReads;
    const modelRunsBefore = mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/runs").length;
    try {
      const sent = await sendChatMessage(context, {
        agentRole: "growth_partner",
        conversationId: org.conversationId,
        content: "Find 4 roofing contractors in the Orlando metropolitan area including Orlando, Winter Park and Kissimmee. Use only this synthetic fixture dataset; do not contact anyone.",
        clientMessageId: crypto.randomUUID(),
      });

      expect(sent).toMatchObject({ conversationId: org.conversationId, runId: null, jobId: expect.any(String) });
      expect(await waitForJob(sent.jobId!)).toMatchObject({ status: "blocked", stage: "blocked" });
      const blockedJob = await getWorkJobView(context, sent.jobId!);
      expect(blockedJob?.failureMessage).toMatch(/No approved discovery source is enabled/);
      expect(blockedJob?.failureCode).toBe("source_policy_required");
      expect(osmFixtureCalls).toBe(osmCallsBefore);
      expect(localPageReads).toBe(pageReadsBefore);
      expect(mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/runs")).toHaveLength(modelRunsBefore);
    } finally {
      await saveResearchSourcePolicy(context, "openstreetmap", {
        enabled: true,
        providerFeeUsdPerRequest: 0,
        perJobRequestCap: 1,
        perDayRequestCap: 1,
        perJobSpendCapUsd: BUDGET.perJobSpendCapUsd,
        perDaySpendCapUsd: BUDGET.perDaySpendCapUsd,
        activationAcknowledged: true,
        sourceConfig: {
          endpoint: OSM_CONFIG.endpoint,
          approvedEndpointHosts: OSM_CONFIG.approvedEndpointHosts,
          userAgent: OSM_CONFIG.userAgent,
          bounds: { south: 28.1, west: -81.6, north: 28.8, east: -81.1 },
          maxResults: OSM_CONFIG.maxResults,
          timeoutSeconds: 20,
        },
      });
      await saveResearchSourcePolicy(context, "company_website", {
        enabled: true,
        providerFeeUsdPerRequest: 0,
        perJobRequestCap: 100,
        perDayRequestCap: 100,
        perJobSpendCapUsd: BUDGET.perJobSpendCapUsd,
        perDaySpendCapUsd: BUDGET.perDaySpendCapUsd,
        activationAcknowledged: true,
        sourceConfig: { approvedDomains: [...EXACT_DOMAINS], maxRequests: 4 },
      });
    }
  }, 120_000);

  it("persists fixture research, qualification, CRM review and the report in one isolated partner thread", async () => {
    expect(fixtureLeads).toHaveLength(4);
    expect(EXACT_DOMAINS).toEqual([
      "orlando-roofing-alpha.test",
      "winter-park-roofing.test",
      "kissimmee-roofing.test",
      "orlando-plumbing-control.test",
    ]);
    expect(BUDGET).toEqual({ perJobSpendCapUsd: 0, perDaySpendCapUsd: 0 });
    expect(osmFixtureCalls).toBe(1);
    expect(localPageReads).toBeGreaterThan(0);

    const { rows: identity } = await withSystem((db) => db.query<{ partners: string; runtimes: string; allProfiles: string; conversations: string }>(
      `select
        (select count(*)::text from ai_growth_partners where org_id = $1) as partners,
        (select count(*)::text from agent_instances where org_id = $1 and role_key = 'growth_partner' and enabled) as runtimes,
        (select count(*)::text from agent_instances where org_id = $1) as "allProfiles",
        (select count(*)::text from chat_conversations where org_id = $1 and growth_partner_id = $2 and deleted_at is null) as conversations`,
      [org.id, org.partnerId],
    ));
    expect(identity[0]).toEqual({ partners: "1", runtimes: "1", allProfiles: "1", conversations: "1" });

    const sent = await sendChatMessage(context, {
      agentRole: "growth_partner",
      conversationId: org.conversationId,
      content: "Find 4 roofing contractors in the Orlando metropolitan area including Orlando, Winter Park and Kissimmee. Use only this synthetic fixture dataset; do not contact anyone.",
      clientMessageId: crypto.randomUUID(),
    });
    expect(sent).toMatchObject({ conversationId: org.conversationId, runId: null, jobId: expect.any(String) });
    const settled = await waitForJob(sent.jobId!);
    expect(settled).toMatchObject({ status: "completed", stage: "completed" });
    expect(osmFixtureCalls).toBe(2);

    const job = await getWorkJobView(context, sent.jobId!);
    expect(job).toMatchObject({
      capability: "lead_research",
      status: "completed",
      resultCount: 4,
      conversationId: org.conversationId,
      result: { evidenceBacked: 1, disqualified: 1, duplicates: 1, needsEvidence: 1, searches: 1, pagesReviewed: webPagesReviewed },
    });
    expect(job?.resultSummary).toContain("1 evidence-backed, 1 disqualified, 1 duplicate, and 1 needing more evidence");
    expect(job?.result).toMatchObject({
      sourceUsage: [
        { source: "openstreetmap", requests: 1, providerFeeUsd: 0, reserved: 0, transportFailed: 0 },
        { source: "company_website", requests: 9, providerFeeUsd: 0, reserved: 0, transportFailed: 0 },
      ],
      sourceWarnings: [],
    });
    expect(job?.events.map((event) => event.stage)).toEqual(expect.arrayContaining(["searching", "reviewing", "extracting", "qualifying", "checking_duplicates", "preparing_results", "completed"]));

    const leads = await listLeads(context, "all");
    expect(leads).toHaveLength(4);
    const alpha = leads.find((lead) => lead.domain === "orlando-roofing-alpha.test");
    const winter = leads.find((lead) => lead.domain === "winter-park-roofing.test");
    const kissimmee = leads.find((lead) => lead.domain === "kissimmee-roofing.test");
    const plumbing = leads.find((lead) => lead.domain === "orlando-plumbing-control.test");
    expect(alpha).toMatchObject({ qualification_state: "evidence_backed", score: 80, duplicate_status: "no_match" });
    expect(alpha?.signal_records).toEqual([expect.objectContaining({ source: "orlando-roofing-alpha.test", confidence: 0.82 })]);
    expect(alpha?.signal_records[0]?.evidence_url).toMatch(/^https:\/\/orlando-roofing-alpha\.test\/careers\//);
    expect(winter).toMatchObject({ qualification_state: "duplicate", duplicate_status: "duplicate" });
    expect(winter?.duplicate_matches[0]).toMatchObject({ kind: "crm_company", domain: "winter-park-roofing.test" });
    expect(kissimmee).toMatchObject({ qualification_state: "needs_evidence", score: 0 });
    expect(kissimmee?.evidence[0]).toMatchObject({
      url: "https://www.openstreetmap.org/node/990003",
      observed_at: expect.any(String),
      summary: expect.stringContaining("Dataset timestamp: 2026-11-05T00:00:00.000Z"),
    });
    expect(kissimmee?.qualification_reasons).toContain("No qualification reasoning was provided.");
    expect(plumbing).toMatchObject({ qualification_state: "disqualified", score: 0, duplicate_status: "no_match" });
    expect(plumbing?.qualification_reasons[0]).toMatch(/does not provide roofing services/i);

    await expect(reviewLeads(context, [plumbing!.id], "approve")).rejects.toThrow(/disqualified/);
    expect(await reviewLeads(context, [alpha!.id], "approve")).toBe(1);
    const approvalId = await requestCrmImport(context, [alpha!.id]);
    const { rows: approval } = await withSystem((db) => db.query<{ status: string; kind: string }>(
      "select status, kind from approval_requests where id = $1 and org_id = $2",
      [approvalId, org.id],
    ));
    expect(approval[0]).toEqual({ status: "pending", kind: "lead_import" });
    expect((await listLeads(context, "all")).find((lead) => lead.id === alpha!.id)?.crm_sync_status).toBe("awaiting_approval");

    const { rows: workJob } = await withSystem((db) => db.query<{ id: string }>(
      "select action->>'workJobId' as id from approval_requests where id = $1 and org_id = $2",
      [approvalId, org.id],
    ));
    const importJobId = workJob[0]?.id;
    expect(importJobId).toBeTruthy();
    const waitingJob = await getWorkJobView(context, importJobId!);
    expect(waitingJob).toMatchObject({
      capability: "crm_lead_import",
      status: "waiting_for_approval",
      statusLabel: "Waiting for approval",
      evidence: { class: "proposed_change", ledger: { kind: "work_job", id: importJobId } },
      canCancel: false,
      canRetry: false,
    });
    expect((await listWorkBoardJobs(context, "active")).find((job) => job.id === importJobId)).toMatchObject({
      status: "waiting_for_approval",
      employeeRole: "growth_partner",
      conversationId: org.conversationId,
    });

    const decision = await decideApproval(context, approvalId, "approve");
    expect(decision.outcome).toMatchObject({ status: "succeeded", detail: expect.stringContaining("native CRM") });
    const { rows: imported } = await withSystem((db) => db.query<{
      business_name: string; domain: string; website: string; review_status: string; crm_sync_status: string;
      crm_company_id: string; crm_contact_id: string | null; crm_imported_by: string; crm_imported_at: Date;
      company_name: string; company_domain: string; company_city: string | null; company_region: string | null; company_country: string | null; created_via: string;
    }>(
      `select l.business_name, l.domain, l.website, l.review_status, l.crm_sync_status, l.crm_company_id, l.crm_contact_id,
              l.crm_imported_by, l.crm_imported_at, c.name as company_name, c.domain as company_domain,
              c.city as company_city, c.region as company_region, c.country as company_country, c.created_via
         from leads l join crm_companies c on c.id = l.crm_company_id and c.org_id = l.org_id
        where l.id = $1 and l.org_id = $2`,
      [alpha!.id, org.id],
    ));
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      business_name: "Orlando Roofing Alpha",
      domain: "orlando-roofing-alpha.test",
      website: "https://orlando-roofing-alpha.test/",
      review_status: "approved",
      crm_sync_status: "synced",
      crm_contact_id: null,
      crm_imported_by: owner.id,
      company_name: "Orlando Roofing Alpha",
      company_domain: "orlando-roofing-alpha.test",
      created_via: "import",
    });
    expect(imported[0]?.crm_company_id).toBeTruthy();
    expect(imported[0]?.crm_imported_at).toBeInstanceOf(Date);
    const nativeCompanyCount = await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from crm_companies where org_id = $1 and domain = 'orlando-roofing-alpha.test' and deleted_at is null",
      [org.id],
    ));
    expect(nativeCompanyCount.rows[0]?.count).toBe(1);

    const completedJob = await getWorkJobView(context, importJobId!);
    expect(completedJob).toMatchObject({
      status: "completed",
      statusLabel: "Imported to CRM",
      resultCount: 1,
      result: { approvalId, imported: 1, publicContactsCreated: 0, companiesReused: 0 },
      evidence: { class: "approved_write", ledger: { kind: "work_job", id: importJobId } },
      canCancel: false,
      canRetry: false,
    });
    expect((await listWorkBoardJobs(context, "completed")).find((job) => job.id === importJobId)).toMatchObject({
      status: "completed",
      statusLabel: "Imported to CRM",
      conversationId: org.conversationId,
    });
    const { rows: audit } = await withSystem((db) => db.query<{ action: string; actor_user_id: string; target_id: string; approval_id: string; result: string }>(
      "select action, actor_user_id, target_id, approval_id, result from audit_logs where org_id = $1 and action = 'leads.crm_imported' and approval_id = $2",
      [org.id, approvalId],
    ));
    expect(audit).toEqual([expect.objectContaining({ action: "leads.crm_imported", actor_user_id: owner.id, target_id: alpha!.id, approval_id: approvalId, result: "success" })]);
    const { rows: approvalEvents } = await withSystem((db) => db.query<{ event: string }>(
      "select event from approval_events where org_id = $1 and approval_id = $2 order by created_at, id",
      [org.id, approvalId],
    ));
    expect(approvalEvents.map((event) => event.event)).toEqual(expect.arrayContaining(["created", "approved", "execution_started", "execution_succeeded"]));
    await expect(requestCrmImport(context, [alpha!.id])).rejects.toThrow(/haven't been imported|haven't been sent|duplicate/i);
    await expect(decideApproval(context, approvalId, "approve")).rejects.toThrow(/already decided/);
    await reviewLeads(context, [winter!.id], "approve");
    await expect(requestCrmImport(context, [winter!.id])).rejects.toThrow(/duplicate match/);

    const page = await getGrowthPartnerConversationPage(context);
    expect(page?.conversation.id).toBe(org.conversationId);
    const report = page?.messages.find((message) => message.role === "notice" && message.workJobId === sent.jobId);
    expect(report?.content).toBe("Research finished. 4 candidate records were saved: 1 evidence-backed, 1 disqualified, 1 duplicate, and 1 needing more evidence. Sources: synthetic OpenStreetMap fixture and synthetic company website fixtures (10 requests, $0.00 provider spend). No outreach was sent.");
    expect(report?.evidence).toMatchObject({ class: "record_retrieval", ledger: { kind: "work_job", id: sent.jobId } });
    expect(page?.messages).toEqual(expect.arrayContaining([expect.objectContaining({
      role: "notice",
      workJobId: importJobId,
      content: expect.stringContaining("CRM import approved and completed"),
      evidence: { v: 1, class: "approved_write", ledger: { kind: "work_job", id: importJobId } },
    })]));
    expect(page?.messages.find((message) => message.id === sent.assistantMessageId)?.workJobId).toBe(sent.jobId);
    expect(await searchGrowthPartnerConversation(context, "Kissimmee" )).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user" })]));

    const mockRuns = [...mock.runs.values()];
    expect(mockRuns).toHaveLength(2);
    const restrictedRun = mockRuns.find((run) => run.body.iacquire_tool_scope === "no_tools");
    expect(restrictedRun).toBeTruthy();
    expect(restrictedRun?.headers["x-iacquire-tool-scope"]).toBe("no_tools");
    expect(restrictedRun?.body.iacquire_tool_scope).toBe("no_tools");
    expect(restrictedRun?.headers["x-hermes-session-key"]).toBe(`iaq:${org.id}:growth_partner`);
    expect(mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/runs")).toHaveLength(2);
    expect(fixtureState.notificationAttempts - notificationAttemptsBeforeMainRun).toBe(1);

    const controlOwner = await createUser({ name: "Synthetic Isolation Control Owner" });
    const controlOrg = await createIsolatedTenant("Growth Partner Acceptance Control", "growth-partner-acceptance-control", false);
    await addMember(controlOrg.id, controlOwner.id, "owner");
    const controlContext = ctxFor(controlOwner, controlOrg, "owner");
    const foreignCompany = await withUser(controlOwner.id, (db) => db.query(
      "select id from crm_companies where domain = 'orlando-roofing-alpha.test'",
    ));
    expect(foreignCompany.rows).toEqual([]);
    expect(await getWorkJobView(controlContext, sent.jobId!)).toBeNull();
    expect(await getWorkJobView(controlContext, importJobId!)).toBeNull();
    expect(await listLeads(controlContext, "all")).toEqual([]);
    expect(await getGrowthPartnerConversationPage(controlContext)).toBeNull();
    expect(await withSystem((db) => import("@/server/leads/research-contract").then(({ findLeadDuplicates }) => findLeadDuplicates(db, controlOrg.id, {
      business_name: "Winter Park Roofing",
      website: "https://winter-park-roofing.test/",
    })))).toEqual({ status: "no_match", matches: [] });
    expect((globalThis as { __noNetworkBlocked?: string[] }).__noNetworkBlocked).toEqual([]);
  }, 120_000);
});
