import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { capabilitiesForRole, roleMayUseCapability } from "@/lib/workforce-capabilities";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let leadHunterId: string;

async function waitForJob(jobId: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) =>
      db.query<{ status: string; result: Record<string, unknown>; failure_message: string | null }>("select status, result, failure_message from ai_work_jobs where id = $1", [jobId]),
    );
    if (rows[0] && ["completed", "failed", "cancelled", "blocked"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("lead generation review did not settle");
}

beforeAll(async () => {
  org = await createOrg({ name: "Lead Generation Watch Co" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  leadHunterId = await agentId(org.id, "lead_hunter");
  const settings = {
    ...defaultSettings("lead_hunter"),
    targetCustomers: "Independent dental clinics with online booking",
    roleAnswers: {
      targets: "Independent dental clinics",
      qualification: "In Singapore; must have an online booking page",
    },
  };
  await withSystem((db) =>
    createConfigVersion(db, {
      orgId: org.id,
      agentId: leadHunterId,
      settings,
      source: "onboarding",
      userId: owner.id,
      apply: true,
    }),
  );
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]));
  await withSystem(async (db) => {
    await db.query(
      `insert into lead_research_requests (org_id, requested_by, prompt, campaign_type, status, created_at)
       values ($1, $2, 'Find 10 dental clinics in Singapore', 'business', 'queued', now() - interval '20 days')`,
      [org.id, owner.id],
    );
    await db.query(
      `insert into leads (org_id, business_name, review_status, created_at, duplicate_status)
       values ($1, 'Old Research Prospect', 'pending', now() - interval '3 days', 'possible_duplicate'),
              ($1, 'Approved But Unsent', 'approved', now() - interval '2 days', 'no_match'),
              ($1, 'Duplicate One', 'pending', now() - interval '5 days', 'possible_duplicate'),
              ($1, 'Duplicate Two', 'pending', now() - interval '6 days', 'duplicate'),
              ($1, 'Unique Prospect', 'pending', now() - interval '7 days', 'no_match')`,
      [org.id],
    );
    await db.query("update leads set reviewed_at = now() - interval '2 days', crm_sync_status = 'blocked' where org_id = $1 and business_name = 'Approved But Unsent'", [org.id]);
  });
}, 60000);

describe("Lead Hunter proactive generation review", () => {
  it("is a reviewed Lead Hunter-only capability", () => {
    expect(capabilitiesForRole("lead_hunter").map((definition) => definition.key)).toEqual(["lead_research", "lead_generation_review"]);
    expect(roleMayUseCapability("lead_hunter", "lead_generation_review")).toBe(true);
    expect(roleMayUseCapability("operations_manager", "lead_generation_review")).toBe(false);
  });

  it("reports persisted research, review, CRM handoff, coverage and duplicate signals without starting research", async () => {
    const before = await withSystem(async (db) => {
      const request = await db.query<{ status: string }>("select status from lead_research_requests where org_id = $1", [org.id]);
      const runs = await db.query<{ n: number }>("select count(*)::int as n from agent_runs where org_id = $1", [org.id]);
      return { requestStatus: request.rows[0]?.status, runs: Number(runs.rows[0]?.n ?? 0) };
    });
    const dispatched = await dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
      agentRole: "lead_hunter",
      capability: "lead_generation_review",
      title: "Lead generation review",
      input: {},
    });
    const job = await waitForJob(dispatched.jobId);
    expect(job.status, job.failure_message ?? undefined).toBe("completed");
    const findings = (job.result.findings as Array<{ key: string; count: number; recommendedAction: string; detail: string }>) ?? [];
    const keys = findings.map((item) => item.key);
    expect(keys).toEqual(expect.arrayContaining([
      "lead_research_stalled",
      "lead_review_backlog",
      "approved_leads_not_in_crm",
      "lead_research_coverage_gap",
      "lead_duplicate_rate",
    ]));
    const gap = findings.find((item) => item.key === "lead_research_coverage_gap");
    expect(gap?.detail).toContain("Independent dental clinics");
    expect(gap?.recommendedAction).toContain("Singapore");
    expect(findings.every((item) => item.recommendedAction.length > 0)).toBe(true);

    const after = await withSystem(async (db) => {
      const request = await db.query<{ status: string }>("select status from lead_research_requests where org_id = $1", [org.id]);
      const leads = await db.query<{ review_status: string; crm_sync_status: string }>("select review_status, crm_sync_status from leads where org_id = $1 order by business_name", [org.id]);
      const runs = await db.query<{ n: number }>("select count(*)::int as n from agent_runs where org_id = $1", [org.id]);
      const report = await db.query<{ id: string; capability: string; kind: string }>("select id, capability, kind from ai_work_reports where org_id = $1 and job_id = $2", [org.id, dispatched.jobId]);
      return { requestStatus: request.rows[0]?.status, leads: leads.rows, runs: Number(runs.rows[0]?.n ?? 0), report: report.rows[0] };
    });
    expect(after.requestStatus).toBe("queued");
    expect(after.leads).toEqual(expect.arrayContaining([
      expect.objectContaining({ review_status: "pending", crm_sync_status: "not_synced" }),
      expect.objectContaining({ review_status: "approved", crm_sync_status: "blocked" }),
    ]));
    expect(after.runs).toBe(before.runs);
    expect(after.report).toMatchObject({ capability: "lead_generation_review", kind: "alert" });
  }, 30000);

  it("refuses the capability for another employee role before any job is created", async () => {
    await expect(
      dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
        agentRole: "operations_manager",
        capability: "lead_generation_review",
        title: "Wrong role",
        input: {},
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
