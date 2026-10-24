import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const afterState = vi.hoisted(() => ({
  callbacks: [] as Array<() => void | Promise<void>>,
  autoRun: true,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => void | Promise<void>) => {
    if (afterState.autoRun) void Promise.resolve().then(callback);
    else afterState.callbacks.push(callback);
  },
}));
import { withSystem } from "@/server/db";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { recommendedSettings } from "@/lib/role-playbooks";
import { createResearchRequest, listLeads } from "@/server/leads/service";
import { cancelWorkJob, createWorkJob, getWorkJobView, recoverExpiredWorkJobs, retryWorkJobForUser } from "@/server/workforce/jobs";
import { runWorkJob } from "@/server/workforce/work-runner";
import { kickWorkJob } from "@/server/workforce/work-kick";
import { sendChatMessage } from "@/server/chat/service";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { startMockHermes, type MockHermes, type MockScript } from "./support/mock-hermes";

const KEY = "r".repeat(40);
const PROFILE = "c-research-lead-hunter";

const researchPayload = {
  leads: [
    {
      business_name: "Alpha Dental Studio",
      website: "https://alpha-dental.example",
      industry: "Dental",
      location: "Miami, FL",
      evidence: [{ url: "https://alpha-dental.example/about", observed_at: "2026-10-21T00:00:00Z", summary: "The practice lists two locations and an online booking page." }],
      buying_signals: ["Online booking page"],
      qualification_summary: "Independent dental practice with a public booking page; fits the stated category and area.",
      public_contact: { name: "Jordan Lee", role: "Practice manager", email: "hello@alpha-dental.example", source_url: "https://alpha-dental.example/contact" },
      score: { service_fit: 25, problem_evidence: 18, buying_intent: 12, market_fit: 13, source_quality: 9 },
    },
    {
      business_name: "Existing Dental Group",
      website: "https://existing-dental.example",
      industry: "Dental",
      location: "Miami, FL",
      evidence: [{ url: "https://existing-dental.example", observed_at: "2026-10-21T00:00:00Z", summary: "Public site is live." }],
      buying_signals: [],
      qualification_summary: "Matches the category and area.",
      score: { service_fit: 20, problem_evidence: 10, buying_intent: 5, market_fit: 10, source_quality: 8 },
    },
    {
      business_name: "Gamma Smiles",
      website: "https://gamma-smiles.example",
      industry: "Dental",
      location: "Miami, FL",
      evidence: [],
      buying_signals: [],
      qualification_summary: "Website observed but no citable source page was read.",
      score: { service_fit: 20, problem_evidence: 25, buying_intent: 20, market_fit: 10, source_quality: 10 },
    },
  ],
};

function researchScript(): MockScript {
  const output = `\`\`\`json\n${JSON.stringify(researchPayload)}\n\`\`\``;
  return { steps: [{ tool: "web_search", ms: 5 }, { tool: "web_extract", ms: 5 }, { tool: "web_extract", ms: 5 }, { delta: output }], output };
}

let mock: MockHermes;
let script: () => MockScript;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let admin: { id: string };
let hunterId: string;

async function waitForJob(jobId: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) =>
      db.query<{ status: string; stage: string | null; result_count: number; progress: Record<string, unknown>; result: Record<string, unknown>; attempts: number; failure_message: string | null }>(
        "select status, stage, result_count, progress, result, attempts, failure_message from ai_work_jobs where id = $1",
        [jobId],
      ),
    );
    if (rows[0] && ["completed", "failed", "cancelled", "blocked"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("work job did not settle");
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition did not become true");
}

beforeAll(async () => {
  mock = await startMockHermes({ [PROFILE]: { key: KEY, respond: () => script() } });
  org = await createOrg({ name: "Research Co" });
  owner = await createUser();
  admin = await createUser({ platformRole: "agency_super_admin" });
  await addMember(org.id, owner.id, "owner");
  hunterId = await agentId(org.id, "lead_hunter");
  await withSystem((db) =>
    createConfigVersion(db, { orgId: org.id, agentId: hunterId, settings: recommendedSettings("lead_hunter"), source: "onboarding", userId: owner.id, apply: true }),
  );
  await connectHermesProfile({ agentId: hunterId, baseUrl: mock.url, profile: PROFILE, apiKey: KEY, agencyUserId: admin.id });
  const health = await runHealthCheck(hunterId, { userId: null, kind: "system" });
  expect(health).toMatchObject({ ok: true, status: "online" });
  await withSystem((db) =>
    db.query(
      "insert into crm_companies (org_id, name, domain, created_by) values ($1, $2, $3, $4)",
      [org.id, "Existing Dental Group", "existing-dental.example", owner.id],
    ),
  );
}, 60000);

afterAll(() => mock.close());

beforeEach(() => {
  script = researchScript;
  afterState.callbacks.splice(0);
  afterState.autoRun = true;
});

describe("Lead Hunter durable research", () => {
  it("keeps a request-triggered job attached to Next's after-response lifecycle", async () => {
    const created = await withSystem((db) => createWorkJob(db, {
      orgId: org.id,
      agentId: hunterId,
      requestedBy: owner.id,
      capability: "unregistered_handler",
      title: "Check after-response worker scheduling",
      idempotencyKey: `after-response:${crypto.randomUUID()}`,
    }));
    vi.stubEnv("NODE_ENV", "production");
    afterState.autoRun = false;
    try {
      kickWorkJob(created.id);
      expect(afterState.callbacks).toHaveLength(1);
      const before = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where id = $1", [created.id]));
      expect(before.rows[0]?.status).toBe("queued");

      const callback = afterState.callbacks.shift();
      await callback?.();
      const after = await withSystem((db) => db.query<{ status: string; failure_code: string | null }>("select status, failure_code from ai_work_jobs where id = $1", [created.id]));
      expect(after.rows[0]).toMatchObject({ status: "blocked", failure_code: "capability_unavailable" });
    } finally {
      afterState.autoRun = true;
      vi.unstubAllEnvs();
    }
  });

  it("executes a real research job, records genuine stages and prepares source-backed leads", async () => {
    const created = await createResearchRequest(ctxFor(owner, org, "owner"), {
      prompt: "Find 3 dental practices in Miami that may need appointment automation.",
      campaignType: "business",
    });
    expect(created.jobId).toBeTruthy();
    const job = await waitForJob(created.jobId!);
    expect(job.status).toBe("completed");
    expect(job.result_count).toBe(3);
    expect(Number(job.progress.searches)).toBe(1);
    expect(Number(job.progress.pagesReviewed)).toBe(2);
    expect(Number(job.progress.evidenceBacked)).toBe(1);
    expect(Number(job.progress.duplicates)).toBe(1);
    expect(Number(job.progress.needsEvidence)).toBe(1);

    const { rows: events } = await withSystem((db) =>
      db.query<{ kind: string; stage: string | null; message: string }>("select kind, stage, message from ai_work_events where job_id = $1 order by id", [created.jobId]),
    );
    const stages = events.map((event) => event.stage).filter(Boolean);
    expect(stages).toContain("searching");
    expect(stages).toContain("extracting");
    expect(stages).toContain("qualifying");
    expect(stages).toContain("checking_duplicates");
    expect(stages).toContain("preparing_results");
    expect(stages).toContain("completed");
    expect(events.some((event) => /1 candidate.*1 duplicate/i.test(event.message) || /3 candidates extracted/i.test(event.message))).toBe(true);

    const leads = await listLeads(ctxFor(owner, org, "owner"), "all");
    const alpha = leads.find((lead) => lead.business_name === "Alpha Dental Studio");
    const existing = leads.find((lead) => lead.business_name === "Existing Dental Group");
    const gamma = leads.find((lead) => lead.business_name === "Gamma Smiles");
    expect(alpha).toBeTruthy();
    expect(alpha!.evidence).toHaveLength(1);
    expect(alpha!.public_contact.email).toBe("hello@alpha-dental.example");
    expect(existing!.duplicate_status).toBe("duplicate");
    expect(existing!.duplicate_matches?.[0]?.kind).toBe("crm_company");
    expect(gamma!.evidence).toHaveLength(0);
    expect(gamma!.score_breakdown.problem_evidence).toBe(0);
  }, 30000);

  it("lets a Lead Hunter chat turn start the same durable job instead of answering generically", async () => {
    const result = await sendChatMessage(ctxFor(owner, org, "owner"), {
      agentRole: "lead_hunter",
      content: "Find 3 dental practices in Miami that could benefit from our AI automation services. Research them, check duplicates and prepare them for my review.",
      clientMessageId: crypto.randomUUID(),
    });
    expect(result.runId).toBeNull();
    expect(result.jobId).toBeTruthy();
    const { rows } = await withSystem((db) =>
      db.query<{ content: string; work_job_id: string | null }>(
        "select content, work_job_id from chat_messages where id = $1",
        [result.assistantMessageId],
      ),
    );
    expect(rows[0].work_job_id).toBe(result.jobId);
    expect(rows[0].content).toMatch(/started a research job/i);
    const job = await waitForJob(result.jobId!);
    expect(job.status).toBe("completed");
  }, 30000);

  it("asks only for missing research details instead of inventing them", async () => {
    const result = await sendChatMessage(ctxFor(owner, org, "owner"), {
      agentRole: "lead_hunter",
      content: "Find dental practices near me",
      clientMessageId: crypto.randomUUID(),
    });
    expect(result.runId).toBeNull();
    expect(result.jobId).toBeNull();
    const { rows } = await withSystem((db) =>
      db.query<{ content: string }>("select content from chat_messages where id = $1", [result.assistantMessageId]),
    );
    expect(rows[0].content).toMatch(/number of qualified leads/i);
    expect(rows[0].content).toMatch(/city or area/i);
  }, 30000);

  it("cancels a running job at the next safe point and records the real state", async () => {
    script = () => ({ steps: [{ tool: "web_search" }, { wait: 3000 }, { delta: "{\"leads\":[]}" }], output: '{"leads":[]}' });
    const created = await createResearchRequest(ctxFor(owner, org, "owner"), {
      prompt: "Find 3 dental practices in Miami.",
      campaignType: "business",
    });
    await waitFor(async () => {
      const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where id = $1", [created.jobId]));
      return rows[0]?.status === "running";
    });
    const outcome = await cancelWorkJob(ctxFor(owner, org, "owner"), created.jobId!);
    expect(["cancelled", "cancel_requested"]).toContain(outcome);
    const job = await waitForJob(created.jobId!, 12000);
    expect(job.status).toBe("cancelled");
    const { rows: request } = await withSystem((db) =>
      db.query<{ status: string }>("select status from lead_research_requests where id = $1", [created.requestId]),
    );
    expect(request[0].status).toBe("cancelled");
    const { rows: leads } = await withSystem((db) =>
      db.query<{ n: number }>("select count(*)::int as n from leads where research_request_id = $1", [created.requestId]),
    );
    expect(leads[0].n).toBe(0);
  }, 30000);

  it("retries a failed job and completes it on the next attempt", async () => {
    script = () => ({ steps: [{ tool: "web_search" }, { fail: "provider failed" }] });
    const created = await createResearchRequest(ctxFor(owner, org, "owner"), {
      prompt: "Find 3 dental practices in Miami.",
      campaignType: "business",
    });
    const failed = await waitForJob(created.jobId!);
    expect(failed.status).toBe("failed");
    script = researchScript;
    await retryWorkJobForUser(ctxFor(owner, org, "owner"), created.jobId!);
    const completed = await waitForJob(created.jobId!, 12000);
    expect(completed.status).toBe("completed");
    expect(completed.attempts).toBe(2);
  }, 30000);

  it("keeps jobs tenant-scoped and never exposes another workspace's work", async () => {
    const otherOrg = await createOrg({ name: "Other Co" });
    const outsider = await createUser();
    await addMember(otherOrg.id, outsider.id, "owner");
    const created = await withSystem((db) =>
      createWorkJob(db, {
        orgId: org.id,
        agentId: hunterId,
        requestedBy: owner.id,
        capability: "lead_research",
        title: "Tenant isolation check",
        idempotencyKey: `tenant-${crypto.randomUUID()}`,
        input: {},
      }),
    );
    const ownView = await getWorkJobView(ctxFor(owner, org, "owner"), created.id);
    expect(ownView?.title).toBe("Tenant isolation check");
    const view = await getWorkJobView(ctxFor(outsider, otherOrg, "owner"), created.id);
    expect(view).toBeNull();
  }, 30000);

  it("is idempotent for a repeated request key", async () => {
    const first = await withSystem((db) =>
      createWorkJob(db, {
        orgId: org.id,
        agentId: hunterId,
        requestedBy: owner.id,
        capability: "lead_research",
        title: "Idempotency check",
        idempotencyKey: `idem-${crypto.randomUUID()}`,
        input: {},
      }),
    );
    const second = await withSystem((db) =>
      createWorkJob(db, {
        orgId: org.id,
        agentId: hunterId,
        requestedBy: owner.id,
        capability: "lead_research",
        title: "Idempotency check",
        idempotencyKey: `idem-${crypto.randomUUID()}`,
        input: {},
      }),
    );
    expect(first.id).not.toBe(second.id);
    const sameKey = `idem-same-${crypto.randomUUID()}`;
    const a = await withSystem((db) => createWorkJob(db, { orgId: org.id, agentId: hunterId, requestedBy: owner.id, capability: "lead_research", title: "Same", idempotencyKey: sameKey, input: {} }));
    const b = await withSystem((db) => createWorkJob(db, { orgId: org.id, agentId: hunterId, requestedBy: owner.id, capability: "lead_research", title: "Same", idempotencyKey: sameKey, input: {} }));
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
  });

  it("rejects a capability with no reviewed handler instead of executing it", async () => {
    const created = await withSystem((db) =>
      createWorkJob(db, {
        orgId: org.id,
        agentId: hunterId,
        requestedBy: owner.id,
        capability: "unknown_capability",
        title: "Unreviewed capability",
        idempotencyKey: `unknown-${crypto.randomUUID()}`,
        input: {},
      }),
    );
    expect(await runWorkJob(created.id)).toBe(true);
    const { rows } = await withSystem((db) => db.query<{ status: string; failure_code: string | null }>(
      "select status, failure_code from ai_work_jobs where id=$1",
      [created.id],
    ));
    expect(rows[0]).toMatchObject({ status: "blocked", failure_code: "capability_unavailable" });
    const { rows: events } = await withSystem((db) => db.query<{ message: string }>(
      "select message from ai_work_events where job_id=$1 order by id",
      [created.id],
    ));
    expect(events.some((event) => /No reviewed handler/i.test(event.message))).toBe(true);
  });

  it("refuses cancellation by a member who neither requested the work nor can review leads", async () => {
    const member = await createUser();
    await addMember(org.id, member.id, "member");
    const created = await withSystem((db) =>
      createWorkJob(db, {
        orgId: org.id,
        agentId: hunterId,
        requestedBy: owner.id,
        capability: "lead_research",
        title: "Member cannot stop this",
        idempotencyKey: `member-cancel-${crypto.randomUUID()}`,
        input: {},
      }),
    );
    await expect(cancelWorkJob(ctxFor(member, org, "member"), created.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("recovers a job whose worker lease expired instead of leaving it busy", async () => {
    const created = await withSystem((db) =>
      createWorkJob(db, {
        orgId: org.id,
        agentId: hunterId,
        requestedBy: owner.id,
        capability: "lead_research",
        title: "Recovery check",
        idempotencyKey: `recovery-${crypto.randomUUID()}`,
        input: { requestId: crypto.randomUUID() },
      }),
    );
    await withSystem((db) =>
      db.query(
        `update ai_work_jobs set status='running', stage='preparing', attempts=1, lease_owner='dead-worker', lease_expires_at=now() - interval '1 minute' where id=$1`,
        [created.id],
      ),
    );
    const recovered = await recoverExpiredWorkJobs();
    expect(recovered.retried).toBeGreaterThanOrEqual(1);
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where id=$1", [created.id]));
    expect(rows[0].status).toBe("queued");
  }, 30000);

  it("recovers running jobs with no lease owner or expiry while preserving a live lease", async () => {
    const [ownerless, expiryless, live] = await Promise.all([
      withSystem((db) => createWorkJob(db, {
        orgId: org.id,
        agentId: hunterId,
        requestedBy: owner.id,
        capability: "proactive_review",
        title: "Ownerless running job",
        idempotencyKey: `ownerless-recovery-${crypto.randomUUID()}`,
        input: {},
      })),
      withSystem((db) => createWorkJob(db, {
        orgId: org.id,
        agentId: hunterId,
        requestedBy: owner.id,
        capability: "proactive_review",
        title: "Expiryless running job",
        idempotencyKey: `expiryless-recovery-${crypto.randomUUID()}`,
        input: {},
      })),
      withSystem((db) => createWorkJob(db, {
        orgId: org.id,
        agentId: hunterId,
        requestedBy: owner.id,
        capability: "proactive_review",
        title: "Live lease must remain running",
        idempotencyKey: `live-lease-preserved-${crypto.randomUUID()}`,
        input: {},
      })),
    ]);
    await withSystem(async (db) => {
      await db.query(
        `update ai_work_jobs set status='running', attempts=1, lease_owner=null, lease_expires_at=now() + interval '10 minutes' where id=$1`,
        [ownerless.id],
      );
      await db.query(
        `update ai_work_jobs set status='running', attempts=1, lease_owner='orphaned-worker', lease_expires_at=null where id=$1`,
        [expiryless.id],
      );
      await db.query(
        `update ai_work_jobs set status='running', attempts=1, lease_owner='live-worker', lease_expires_at=now() + interval '10 minutes' where id=$1`,
        [live.id],
      );
    });

    const recovered = await recoverExpiredWorkJobs();
    const { rows } = await withSystem((db) => db.query<{ id: string; status: string }>(
      "select id, status from ai_work_jobs where id = any($1::uuid[])",
      [[ownerless.id, expiryless.id, live.id]],
    ));
    const status = Object.fromEntries(rows.map((row) => [row.id, row.status]));

    expect(recovered.retried).toBeGreaterThanOrEqual(2);
    expect(status).toMatchObject({
      [ownerless.id]: "queued",
      [expiryless.id]: "queued",
      [live.id]: "running",
    });
  }, 30000);

  it("marks a running job without an active lease as recovery pending in its authorized view", async () => {
    const created = await withSystem((db) =>
      createWorkJob(db, {
        orgId: org.id,
        agentId: hunterId,
        requestedBy: owner.id,
        capability: "lead_research",
        title: "Lost lease view check",
        idempotencyKey: `lost-lease-view-${crypto.randomUUID()}`,
        input: {},
      }),
    );
    await withSystem((db) => db.query(
      `update ai_work_jobs set status='running', stage='reviewing', lease_owner=null, lease_expires_at=now() - interval '1 minute' where id=$1`,
      [created.id],
    ));

    const view = await getWorkJobView(ctxFor(owner, org, "owner"), created.id);
    expect(view).toMatchObject({ status: "running", statusLabel: "Recovery pending", recoveryPending: true });
  }, 30000);
});
