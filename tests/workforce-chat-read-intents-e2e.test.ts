import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zonedDate, zonedToInstant } from "@/lib/calendars/slots";
import { sendChatMessage } from "@/server/chat/service";
import { withSystem } from "@/server/db";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { connectHermesProfile, runHealthCheck } from "@/server/workforce/service";
import { createGrowthPartnerOnlyTenant } from "./support/growth-partner-tenant";
import { createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const PROFILE = "c-chat-read-intents-growth-partner";
const KEY = "r".repeat(40);
const TIME_ZONE = "Asia/Singapore";

let tenant: Awaited<ReturnType<typeof createGrowthPartnerOnlyTenant>>;
let mock: MockHermes;
let agencyAdmin: Awaited<ReturnType<typeof createUser>>;
let appointmentDate: string;
let completedJobId: string;

async function resetMessageLimit(userId: string) {
  await withSystem((db) => db.query("delete from rate_limit_buckets where bucket_key = $1", [`${RATE_LIMITS.agentMessageByUser.name}:${userId}`]));
}

async function ask(ctx: Parameters<typeof sendChatMessage>[0], content: string) {
  await resetMessageLimit(ctx.user.id);
  const result = await sendChatMessage(ctx, {
    agentRole: "growth_partner",
    conversationId: tenant.conversationId,
    content,
    clientMessageId: crypto.randomUUID(),
  });
  const message = await withSystem((db) => db.query<{ content: string; evidence: Record<string, unknown> | null; work_job_id: string | null }>(
    "select content, evidence, work_job_id from chat_messages where id = $1 and org_id = $2",
    [result.assistantMessageId, tenant.org.id],
  ));
  return { result, message: message.rows[0] };
}

beforeAll(async () => {
  tenant = await createGrowthPartnerOnlyTenant({ name: "Read Intent E2E", timezone: TIME_ZONE });
  agencyAdmin = await createUser({ platformRole: "agency_super_admin", name: "Read Intent Test Admin" });
  mock = await startMockHermes({ [PROFILE]: { key: KEY } });
  await connectHermesProfile({ agentId: tenant.runtimeAgentId, baseUrl: mock.url, profile: PROFILE, apiKey: KEY, agencyUserId: agencyAdmin.id });
  const health = await runHealthCheck(tenant.runtimeAgentId, { userId: agencyAdmin.id, kind: "agency" });
  expect(health).toMatchObject({ ok: true, status: "online" });

  appointmentDate = zonedDate(Date.now(), TIME_ZONE);
  const appointmentStart = zonedToInstant(appointmentDate, 15 * 60, TIME_ZONE);
  await withSystem(async (db) => {
    await db.query("insert into leads (org_id, business_name, review_status, created_at) values ($1, 'Read Intent Lead Canary', 'pending', now())", [tenant.org.id]);
    const contact = await db.query<{ id: string }>(
      `insert into contacts (org_id, display_name, priority_label, priority_score, priority_reason, lead_status, created_at, last_activity_at)
       values ($1, 'Read Intent Contact Canary', 'hot', 91, 'Stored priority test data', 'new', now(), now() - interval '20 days') returning id`,
      [tenant.org.id],
    );
    const contactId = contact.rows[0].id;
    const conversation = await db.query<{ id: string }>(
      `insert into conversations (org_id, contact_id, channel, thread_key, created_at)
       values ($1, $2, 'sms', $3, now()) returning id`,
      [tenant.org.id, contactId, `read-intent-${crypto.randomUUID()}`],
    );
    await db.query(
      `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, created_at)
       values ($1, $2, 'inbound', 'contact', 'Inbound read-intent fixture', 'received', now())`,
      [tenant.org.id, conversation.rows[0].id],
    );

    const calendar = await db.query<{ id: string }>(
      `insert into crm_calendars (org_id, name, slug, is_default, public, created_by)
       values ($1, 'Read Intent Calendar', $2, true, true, $3) returning id`,
      [tenant.org.id, `read-intent-${crypto.randomUUID().slice(0, 12)}`, tenant.owner.id],
    );
    await db.query(
      `insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, slot_interval_minutes, min_notice_minutes, max_days_ahead, location_kind, public)
       values ($1, $2, 'Read Intent Call', $3, 30, 30, 0, 60, 'none', true)`,
      [tenant.org.id, calendar.rows[0].id, `read-intent-${crypto.randomUUID().slice(0, 12)}`],
    );
    await db.query(
      `insert into appointment_refs (org_id, provider, calendar_ref, appointment_type_id, title, status, start_at, end_at, timezone, contact_id, booked_via, origin, created_by)
       select $1, 'native', c.id, t.id, 'Read Intent Appointment Canary', 'confirmed', $3, $4, $5, $6, 'staff', 'portal_staff', $7
         from crm_calendars c join crm_appointment_types t on t.org_id = c.org_id and t.calendar_id = c.id
        where c.org_id = $1 and c.id = $2
       returning id`,
      [tenant.org.id, calendar.rows[0].id, new Date(appointmentStart).toISOString(), new Date(appointmentStart + 30 * 60_000).toISOString(), TIME_ZONE, contactId, tenant.owner.id],
    );

    await db.query(
      `insert into approval_requests (org_id, requested_by, kind, title, risk, status, created_at)
       values ($1, $2, 'tool_action', 'Read Intent Pending Approval Canary', 'low', 'pending', now())`,
      [tenant.org.id, tenant.owner.id],
    );
    const job = await db.query<{ id: string }>(
      `insert into ai_work_jobs (org_id, agent_instance_id, requested_by, capability, title, status, idempotency_key, finished_at)
       values ($1, $2, $3, 'performance_snapshot', 'Read Intent Completed Job Canary', 'completed', $4, now()) returning id`,
      [tenant.org.id, tenant.runtimeAgentId, tenant.owner.id, `read-intent-completed-${crypto.randomUUID()}`],
    );
    completedJobId = job.rows[0].id;
    await db.query(
      `insert into approval_requests (org_id, requested_by, kind, title, risk, status, execution_status, action, executed_at, created_at)
       values ($1, $2, 'crm_update', 'Read Intent Executed Approval Canary', 'medium', 'approved', 'succeeded', $3::jsonb, now(), now())`,
      [tenant.org.id, tenant.owner.id, JSON.stringify({ workJobId: completedJobId })],
    );
  });
}, 120000);

afterAll(async () => {
  await mock?.close();
});

describe("Growth Partner read-intent conversation routes", () => {
  it("answers all five read families from persisted tenant records and creates no jobs", async () => {
    const before = await withSystem((db) => db.query<{ count: number }>("select count(*)::int as count from ai_work_jobs where org_id = $1", [tenant.org.id]));
    const owner = tenant.ownerCtx;

    const newLeads = await ask(owner, "show my new leads today");
    expect(newLeads.result).toMatchObject({ runId: null, jobId: null });
    expect(newLeads.message.content).toContain("Read Intent Lead Canary");
    expect(newLeads.message.content).toContain("[Open leads](/leads)");
    expect(newLeads.message.content).toContain("[Open contacts](/crm/contacts)");
    expect(newLeads.message.content).toContain("[Open inbox](/inbox)");
    expect(newLeads.message.content).toContain("1 — Read Intent Contact Canary");
    expect(newLeads.message.evidence).toMatchObject({ class: "record_retrieval" });

    const followups = await ask(owner, "which leads should we follow up on");
    expect(followups.result).toMatchObject({ runId: null, jobId: null });
    expect(followups.message.content).toContain("Read Intent Contact Canary");
    expect(followups.message.content).toContain("1 active lead contact found");
    expect(followups.message.content).toContain("hot priority");
    expect(followups.message.content).toContain("last recorded contact");
    expect(followups.message.content).toContain("0 open deals");
    expect(followups.message.content).toContain("[Open contacts](/crm/contacts)");
    expect(followups.message.evidence).toMatchObject({ class: "record_retrieval" });

    const appointments = await ask(owner, `show appointments on ${appointmentDate}`);
    expect(appointments.result).toMatchObject({ runId: null, jobId: null });
    expect(appointments.message.content).toContain("Read Intent Appointment Canary");
    expect(appointments.message.content).toContain("Appointments on");
    expect(appointments.message.content).toContain("1 found");
    expect(appointments.message.content).toContain("[Open Appointments](/appointments)");
    expect(appointments.message.evidence).toMatchObject({ class: "record_retrieval", ledger: { kind: "schedule" } });

    const approvals = await ask(owner, "which tasks need my approval");
    expect(approvals.result).toMatchObject({ runId: null, jobId: null });
    expect(approvals.message.content).toContain("Read Intent Pending Approval Canary");
    expect(approvals.message.content).toContain("1 approval waiting");
    expect(approvals.message.content).toContain("[Open approvals](/approvals)");
    expect(approvals.message.evidence).toMatchObject({ class: "record_retrieval", ledger: { kind: "approval" } });

    const activity = await ask(owner, "activities you completed this week");
    expect(activity.result).toMatchObject({ runId: null, jobId: null });
    expect(activity.message.content).toContain("Read Intent Completed Job Canary");
    expect(activity.message.content).toContain("Read Intent Executed Approval Canary");
    expect(activity.message.content).toContain("Completed work items: 1");
    expect(activity.message.content).toContain("Approved and executed writes: 1");
    expect(activity.message.content).toContain(`/work?job=${completedJobId}`);
    expect(activity.message.evidence).toMatchObject({ class: "record_retrieval", ledger: { kind: "work_job", id: completedJobId } });

    const after = await withSystem((db) => db.query<{ count: number }>("select count(*)::int as count from ai_work_jobs where org_id = $1", [tenant.org.id]));
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(mock.requests.some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
  }, 120000);

  it("keeps appointment and operations reviews on their existing work-job routes", async () => {
    const appointmentReview = await ask(tenant.ownerCtx, "review my appointments");
    expect(appointmentReview.result.jobId).toEqual(expect.any(String));
    expect((await withSystem((db) => db.query<{ capability: string }>(
      "select capability from ai_work_jobs where id = $1 and org_id = $2",
      [appointmentReview.result.jobId, tenant.org.id],
    ))).rows[0].capability).toBe("appointment_review");

    const operationsReview = await ask(tenant.ownerCtx, "review operations");
    expect(operationsReview.result.jobId).toEqual(expect.any(String));
    expect((await withSystem((db) => db.query<{ capability: string }>(
      "select capability from ai_work_jobs where id = $1 and org_id = $2",
      [operationsReview.result.jobId, tenant.org.id],
    ))).rows[0].capability).toBe("proactive_review");
  }, 120000);

  it("does not read lead or appointment records when the member lacks those permissions", async () => {
    const member = await tenant.member("member", { name: "Restricted Read Intent Member" });
    const restricted = {
      ...member.ctx,
      can: (permission: Parameters<typeof member.ctx.can>[0]) =>
        permission === "leads.view" || permission === "appointments.view" ? false : member.ctx.can(permission),
      permissions: member.ctx.permissions.filter((permission) => permission !== "leads.view" && permission !== "appointments.view"),
    };

    const leads = await ask(restricted, "show my new leads today");
    expect(leads.message.content).toContain("leads.view");
    expect(leads.message.content).not.toContain("Read Intent Lead Canary");
    expect(leads.message.evidence).toMatchObject({ class: "record_retrieval" });

    const appointments = await ask(restricted, `show appointments on ${appointmentDate}`);
    expect(appointments.message.content).toContain("appointments.view");
    expect(appointments.message.content).not.toContain("Read Intent Appointment Canary");
    expect(appointments.message.evidence).toMatchObject({ class: "system_notice" });

    const inboxOnly = {
      ...member.ctx,
      can: (permission: Parameters<typeof member.ctx.can>[0]) => permission === "contacts.view" ? false : member.ctx.can(permission),
      permissions: member.ctx.permissions.filter((permission) => permission !== "contacts.view"),
    };
    const inbound = await ask(inboxOnly, "show my new leads today");
    expect(inbound.message.content).toContain("contacts.view");
    expect(inbound.message.content).toContain("Inbound conversations: Permission `contacts.view` is required");
    expect(inbound.message.content).not.toContain("Read Intent Contact Canary");
  }, 120000);
});
