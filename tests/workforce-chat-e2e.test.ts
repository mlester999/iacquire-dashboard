import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import type { AgentRoleKey } from "@/lib/agents";
import { sendChatMessage } from "@/server/chat/service";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "w".repeat(40);
const ROLES: readonly AgentRoleKey[] = [
  "operations_manager",
  "lead_hunter",
  "appointment_setter",
  "sales_assistant",
  "crm_manager",
  "performance_analyst",
];
const PROFILE: Record<AgentRoleKey, string> = {
  operations_manager: "c-chat-e2e-operations-manager",
  lead_hunter: "c-chat-e2e-lead-hunter",
  appointment_setter: "c-chat-e2e-appointment-setter",
  sales_assistant: "c-chat-e2e-sales-assistant",
  crm_manager: "c-chat-e2e-crm-manager",
  performance_analyst: "c-chat-e2e-performance-analyst",
};

let mock: MockHermes;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;
const agents = {} as Record<AgentRoleKey, string>;

async function waitForWorkJob(jobId: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<{ status: string; stage: string; result_summary: string | null }>(
      "select status, stage, result_summary from ai_work_jobs where id = $1 and org_id = $2",
      [jobId, org.id],
    ));
    const job = rows[0];
    if (job && ["completed", "blocked", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`work job ${jobId} did not settle`);
}

beforeAll(async () => {
  mock = await startMockHermes(Object.fromEntries(ROLES.map((role) => [PROFILE[role], { key: KEY }])));
  org = await createOrg({ name: "Six Employee Chat E2E" });
  owner = await createUser({ name: "Workflow Owner" });
  admin = await createUser({ platformRole: "agency_super_admin", name: "Test Workforce Admin" });
  await addMember(org.id, owner.id, "owner");

  for (const role of ROLES) {
    const id = await agentId(org.id, role);
    agents[role] = id;
    await withSystem((db) => createConfigVersion(db, {
      orgId: org.id,
      agentId: id,
      settings: defaultSettings(role),
      source: "onboarding",
      userId: owner.id,
      apply: true,
    }));
    await connectHermesProfile({ agentId: id, baseUrl: mock.url, profile: PROFILE[role], apiKey: KEY, agencyUserId: admin.id });
    const health = await runHealthCheck(id, { userId: admin.id, kind: "agency" });
    expect(health).toMatchObject({ ok: true, status: "online" });
  }

  await withSystem(async (db) => {
    await db.query(
      `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at)
       values ($1, $2, $3, 'chat', $4, 'failed', now() - interval '2 hours')`,
      [org.id, agents.operations_manager, owner.id, `chat-e2e-failed-${crypto.randomUUID()}`],
    );
    await db.query("insert into leads (org_id, business_name, review_status) values ($1, 'Workflow Evidence Lead', 'pending')", [org.id]);
    await db.query(
      `insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, stage_entered_at, updated_at, created_at)
       values ($1, $2, 'Workflow Evidence Deal', 'open', 'ghl', now() - interval '30 days', now() - interval '30 days', now() - interval '35 days')`,
      [org.id, `chat-e2e-${crypto.randomUUID().slice(0, 12)}`],
    );
    await db.query("insert into contacts (org_id, display_name) values ($1, 'Workflow Incomplete Contact')", [org.id]);

    const calendar = await db.query<{ id: string }>(
      "insert into crm_calendars (org_id, name, slug, is_default, public, created_by) values ($1, 'Workflow Calendar', 'workflow-calendar', true, true, $2) returning id",
      [org.id, owner.id],
    );
    await db.query(
      `insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, slot_interval_minutes, min_notice_minutes, max_days_ahead, location_kind, public)
       values ($1, $2, 'Discovery Call', 'discovery-call', 30, 30, 0, 60, 'none', true)`,
      [org.id, calendar.rows[0].id],
    );
    await db.query("insert into crm_calendar_members (org_id, calendar_id, user_id, priority) values ($1, $2, $3, 50)", [org.id, calendar.rows[0].id, owner.id]);
    await db.query("insert into crm_host_settings (org_id, user_id, timezone, accepting) values ($1, $2, 'UTC', true)", [org.id, owner.id]);
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      await db.query(
        "insert into crm_availability_rules (org_id, user_id, weekday, start_minute, end_minute) values ($1, $2, $3, 540, 1020)",
        [org.id, owner.id, weekday],
      );
    }
  });
}, 120000);

afterAll(async () => {
  await mock.close();
});

describe("six employee chat to native workflow", () => {
  it.each([
    ["operations_manager", "Review our operations, identify problems and tell me what needs my attention today", "proactive_review"],
    ["lead_hunter", "Review our lead generation pipeline and current coverage", "lead_generation_review"],
    ["appointment_setter", "Check the calendar and show available appointment slots", "appointment_availability"],
    ["sales_assistant", "Review our sales pipeline and prepare follow-ups for opportunities that need attention", "pipeline_review"],
    ["crm_manager", "Check our CRM for duplicates and incomplete records, then prepare corrections", "crm_quality_review"],
    ["performance_analyst", "Analyze this month's performance and tell me what improved", "performance_snapshot"],
  ] as const)("persists and completes %s work through chat and its role-scoped handler", async (role, content, capability) => {
    const requestStart = mock.requests.length;
    const sent = await sendChatMessage(ctxFor(owner, org, "owner"), {
      agentRole: role,
      content,
      clientMessageId: crypto.randomUUID(),
    });
    expect(sent).toMatchObject({ runId: null, jobId: expect.any(String) });

    const assistant = (await withSystem((db) => db.query<{ content: string; work_job_id: string | null }>(
      "select content, work_job_id from chat_messages where id = $1 and org_id = $2",
      [sent.assistantMessageId, org.id],
    ))).rows[0];
    expect(assistant.work_job_id).toBe(sent.jobId);
    expect(assistant.content.length).toBeGreaterThan(20);

    expect(await waitForWorkJob(sent.jobId!)).toMatchObject({ status: "completed", stage: "completed" });
    const job = (await withSystem((db) => db.query<{
      capability: string; result: Record<string, unknown>; result_count: number; started_at: Date; finished_at: Date;
    }>(
      "select capability, result, result_count, started_at, finished_at from ai_work_jobs where id = $1 and org_id = $2",
      [sent.jobId, org.id],
    ))).rows[0];
    expect(job.capability).toBe(capability);
    expect(job.result).toBeTruthy();
    expect(new Date(job.finished_at).getTime()).toBeGreaterThanOrEqual(new Date(job.started_at).getTime());

    const events = (await withSystem((db) => db.query<{ stage: string; kind: string }>(
      "select stage, kind from ai_work_events where job_id = $1 and org_id = $2 order by created_at, id",
      [sent.jobId, org.id],
    ))).rows;
    expect(events.map((event) => event.stage)).toEqual(expect.arrayContaining(["preparing", "scanning", "analyzing", "preparing_results", "completed"]));
    expect((await withSystem((db) => db.query("select id from ai_work_reports where job_id = $1 and org_id = $2", [sent.jobId, org.id]))).rows).toHaveLength(1);
    expect(mock.requests.slice(requestStart).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
  });
});
