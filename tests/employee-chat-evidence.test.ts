// The six acceptance questions through the real chat service. The Hermes server is a local stand-in that records exactly what each run was sent, so this proves
// the plumbing (what the employee is given, and that the reply is stored) and not any model's behaviour.
// Real-model behaviour is checked separately in the release package's acceptance run.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { sendChatMessage } from "@/server/chat/service";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { findInternalIdentifiers, type EmployeeEvidence } from "@/lib/employee-evidence";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { memberActor } from "@/server/crm/actor";
import { getWorkspace } from "@/server/crm/workspace";
import { listPipelines } from "@/server/crm/pipelines";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "e".repeat(40);
const PROFILE = Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [role, `c-evidence-${role.replaceAll("_", "-")}`])) as Record<AgentRoleKey, string>;

const QUESTIONS: Record<AgentRoleKey, string> = {
  operations_manager: "What operational tasks or issues currently need attention?",
  lead_hunter: "How many researched leads do we currently have, and what is their status?",
  appointment_setter: "What appointments do I have this week?",
  sales_assistant: "How's our sales pipeline looking?",
  crm_manager: "How's our CRM right now?",
  performance_analyst: "What can you tell me about our business performance?",
};

/** What the sections each role must be handed, by id. */
const EXPECTED_SECTIONS: Record<AgentRoleKey, string[]> = {
  operations_manager: ["work_board", "schedules", "operations", "handoffs"],
  lead_hunter: ["leads", "targeting"],
  appointment_setter: ["calendar", "appointments", "booking_requests"],
  sales_assistant: ["pipeline"],
  crm_manager: ["crm", "crm_quality", "pipeline"],
  performance_analyst: ["performance", "crm", "pipeline", "calendar"],
};

function evidenceIn(instructions: string): EmployeeEvidence {
  const open = "<verified_workspace_evidence>";
  const start = instructions.indexOf(open);
  const end = instructions.indexOf("</verified_workspace_evidence>");
  expect(start, "the run carried no workspace evidence").toBeGreaterThan(-1);
  return JSON.parse(instructions.slice(start + open.length, end).trim()) as EmployeeEvidence;
}

let mock: MockHermes;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;

async function waitForMessage(id: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<{ content: string; status: string }>("select content, status from chat_messages where id = $1", [id]));
    if (rows[0] && rows[0].status !== "streaming") return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("assistant message did not finish");
}

async function ask(role: AgentRoleKey) {
  await withSystem((db) => db.query("delete from rate_limit_buckets where bucket_key = $1", [`${RATE_LIMITS.agentMessageByUser.name}:${owner.id}`]));
  const ctx = ctxFor(owner, org, "owner");
  ctx.org.timezone = "Asia/Manila";
  const sent = await sendChatMessage(ctx, { agentRole: role, content: QUESTIONS[role], clientMessageId: crypto.randomUUID() });
  expect(sent.runId, `${role} should be answered by its Hermes run, not queued as background work`).toEqual(expect.any(String));
  const message = await waitForMessage(sent.assistantMessageId);
  const { rows } = await withSystem((db) => db.query<{ hermes_run_id: string; status: string }>("select hermes_run_id, status from agent_runs where id = $1", [sent.runId]));
  const run = mock.runs.get(rows[0].hermes_run_id)!;
  return { sent, message, run, runStatus: rows[0].status, instructions: String(run.body.instructions), evidence: evidenceIn(String(run.body.instructions)) };
}

beforeAll(async () => {
  mock = await startMockHermes(Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [PROFILE[role], { key: KEY }])));
  org = await createOrg({ name: "Evidence Chat Co" });
  owner = await createUser({ name: "Evidence Owner" });
  admin = await createUser({ platformRole: "agency_super_admin", name: "Test Workforce Admin" });
  await addMember(org.id, owner.id, "owner");
  await withSystem((db) => db.query("update organizations set timezone = 'Asia/Manila' where id = $1", [org.id]));
  const ctx = ctxFor(owner, org, "owner");
  const actor = memberActor(ctx);
  await getWorkspace(actor);
  await listPipelines(actor, { ensureDefault: true });
  await withSystem((db) => db.query("insert into leads (org_id, business_name, review_status) values ($1, 'Chat Evidence Lead', 'pending'), ($1, 'Second Evidence Lead', 'approved')", [org.id]));

  for (const role of AGENT_ROLE_KEYS) {
    const id = await agentId(org.id, role);
    await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: owner.id, apply: true }));
    await connectHermesProfile({ agentId: id, baseUrl: mock.url, profile: PROFILE[role], apiKey: KEY, agencyUserId: admin.id });
    expect(await runHealthCheck(id, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  }
}, 120_000);

afterAll(async () => {
  await mock.close();
});

describe("the six acceptance questions reach a Hermes run that carries verified, role-scoped facts", () => {
  it.each(AGENT_ROLE_KEYS)("%s", async (role) => {
    const { message, runStatus, instructions, evidence } = await ask(role);

    // The employee is given its role's facts, as the signed-in person, for this workspace and no other.
    expect(evidence.role).toBe(role);
    expect(evidence.workspace).toEqual({ name: "Evidence Chat Co", kind: "client" });
    expect(evidence.sections.map((s) => s.id)).toEqual(expect.arrayContaining(EXPECTED_SECTIONS[role]));

    // The misleading list is gone and the protected policy is still there exactly once, after the snapshot.
    expect(instructions).not.toMatch(/Tools you may use|Use only these tools/);
    expect(findInternalIdentifiers(instructions.slice(0, instructions.indexOf("<verified_workspace_evidence>")).replace(/Verified workspace snapshot/g, ""))).toEqual([]);
    expect(instructions.indexOf("<verified_workspace_evidence>")).toBeLessThan(instructions.indexOf("## Agency policy"));
    expect(instructions.split("## Agency policy").length).toBe(2);
    expect(instructions).toContain("How you get information and make changes");

    // The conversation is stored with the employee's reply, and nothing was done on anyone's behalf.
    expect(runStatus).toBe("completed");
    expect(message.status).toBe("complete");
    expect(message.content).toContain(QUESTIONS[role].slice(0, 30));
    expect(findInternalIdentifiers(message.content)).toEqual([]);
  }, 60_000);

  it("Appointment Setter before any calendar is set up: the facts say not set up, with nothing to list", async () => {
    const { evidence } = await ask("appointment_setter");
    const states = Object.fromEntries(evidence.sections.map((s) => [s.id, s.state]));
    expect(states).toMatchObject({ calendar: "not_configured", appointments: "not_configured" });
    expect(evidence.sections.find((s) => s.id === "appointments")!.records).toEqual([]);
  }, 60_000);

  it("CRM Manager with a set-up but empty CRM: the facts say set up and empty, not disconnected", async () => {
    const { evidence } = await ask("crm_manager");
    const crm = evidence.sections.find((s) => s.id === "crm")!;
    expect(crm.state).toBe("empty");
    expect(crm.facts).toMatchObject({ contacts: 0, openDeals: 0 });
  }, 60_000);

  it("Lead Hunter sees only its own workspace's leads and their review status", async () => {
    const { evidence } = await ask("lead_hunter");
    const leads = evidence.sections.find((s) => s.id === "leads")!;
    expect(leads.facts).toMatchObject({ totalLeads: 2, awaitingHumanReview: 1, approved: 1 });
  }, 60_000);

  it("records that the facts were read, without storing their contents", async () => {
    const { rows } = await withSystem((db) => db.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_logs where org_id = $1 and action = 'workforce.employee_evidence_read' order by created_at desc limit 20", [org.id],
    ));
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const roles = new Set(rows.map((r) => r.metadata.role));
    for (const role of AGENT_ROLE_KEYS) expect(roles.has(role), role).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/Chat Evidence Lead|Second Evidence Lead/);
  });

  it("makes no side effects: no booking, message, approval or CRM record is created by asking", async () => {
    const counts = async () => (await withSystem((db) => db.query<Record<string, string>>(
      `select (select count(*) from appointment_bookings where org_id = $1)::text as bookings,
              (select count(*) from approval_requests where org_id = $1)::text as approvals,
              (select count(*) from contacts where org_id = $1)::text as contacts,
              (select count(*) from crm_opportunities where org_id = $1)::text as deals,
              (select count(*) from ai_work_jobs where org_id = $1)::text as jobs`, [org.id],
    ))).rows[0];
    const before = await counts();
    await ask("sales_assistant");
    await ask("appointment_setter");
    expect(await counts()).toEqual(before);
  }, 60_000);
});
