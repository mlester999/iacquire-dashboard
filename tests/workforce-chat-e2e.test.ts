Warning: truncated output (original token count: 25796)
Total output lines: 1677

import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import type { AgentRoleKey } from "@/lib/agents";
import { sendChatMessage } from "@/server/chat/service";
import { decideApproval } from "@/server/approvals/service";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { buildRunInstructions, connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { emptyBusinessBrain } from "@/lib/ai-growth-partner";
import { activateGrowthPartnerBusinessBrainVersion, saveGrowthPartnerBusinessBrainFactDraft } from "@/server/ai-growth-partner/service";
import { growthPartnerGoalPromptContext } from "@/server/ai-growth-partner/goals";
import { getTargeting, saveTargeting } from "@/server/leads/service";
import { runDueSchedules, setScheduleEnabled } from "@/server/workforce/schedules";
import { getControlState } from "@/server/automation/controls";
import { memberActor } from "@/server/crm/actor";
import { updateAppointmentType } from "@/server/calendars/setup";
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
const GROWTH_PARTNER_PROFILE = "c-chat-e2e-growth-partner";

let mock: MockHermes;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
const agents = {} as Record<AgentRoleKey, string>;
let growthPartnerAgentId: string;
let growthPartnerConversationId: string;

async function waitForWorkJob(jobId: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<{ status: string; stage: string; result_summary: string | null; failure_message: string | null }>(
      "select status, stage, result_summary, failure_message from ai_work_jobs where id = $1 and org_id = $2",
      [jobId, org.id],
    ));
    const job = rows[0];
    if (job && ["completed", "blocked", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`work job ${jobId} did not settle`);
}

async function resetAgentMessageRateLimit(userId: string) {
  await withSystem((db) => db.query("delete from rate_limit_buckets where bucket_key = $1", [`${RATE_LIMITS.agentMessageByUser.name}:${userId}`]));
}

beforeAll(async () => {
  mock = await startMockHermes({
    ...Object.fromEntries(ROLES.map((role) => [PROFILE[role], { key: KEY }])),
    [GROWTH_PARTNER_PROFILE]: { key: KEY },
  });
  org = await createOrg({ name: "Six Employee Chat E2E" });
  owner = await createUser({ name: "Workflow Owner" });
  admin = await createUser({ platformRole: "agency_super_admin", name: "Test Workforce Admin" });
  member = await createUser({ name: "Schedule Permission Member" });
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, member.id, "member");

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

  growthPartnerAgentId = await withSystem(async (db) => (await db.query<{ id: string }>(
    "insert into agent_instances (org_id, role_key, display_name) values ($1, 'growth_partner', 'AI Growth Partner') returning id",
    [org.id],
  )).rows[0].id);
  await withSystem((db) => createConfigVersion(db, {
    orgId: org.id,
    agentId: growthPartnerAgentId,
    settings: defaultSettings("growth_partner"),
    source: "onboarding",
    userId: owner.id,
    apply: true,
  }));
  await connectHermesProfile({ agentId: growthPartnerAgentId, baseUrl: mock.url, profile: GROWTH_PARTNER_PROFILE, apiKey: KEY, agencyUserId: admin.id });
  const partnerId = await withSystem(async (db) => {
    const partner = (await db.query<{ id: string }>(
      "insert into ai_growth_partners (org_id, runtime_agent_instance_id) values ($1, $2) returning id",
      [org.id, growthPartnerAgentId],
    )).rows[0].id;
    await db.query(
      `insert into ai_growth_partner_versions (partner_id, org_id, version, business_brain, source, created_by)
       values ($1, $2, 1, $3::jsonb, 'onboarding', $4)`,
      [partner, org.id, JSON.stringify(emptyBusinessBrain()), owner.id],
    );
    await db.query("update ai_growth_partners set current_version = 1 where id = $1 and org_id = $2", [partner, org.id]);
    return partner;
  });
  const growthPartnerHealth = await runHealthCheck(growthPartnerAgentId, { userId: admin.id, kind: "agency" });
  expect(growthPartnerHealth).toMatchObject({ ok: true, status: "online" });
  growthPartnerConversationId = (await withSystem((db) => db.query<{ id: string }>(
    "select id from chat_conversations where org_id = $1 and growth_partner_id = $2",
    [org.id, partnerId],
  ))).rows[0].id;

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

describe("AI Growth Partner chat to native workflow", () => {
  it("routes direct client requests for retained roles through the permanent Growth Partner conversation", async () => {
    await resetAgentMessageRateLimit(owner.id);
    const ctx = ctxFor(owner, org, "owner");
    const previousTargeting = await getTargeting(ctx);
    const before = Number((await withSystem((db) => db.query<{ count: number }>(
      `select count(*)::int as count from chat_conversations
       where org_id = $1 and agent_instance_id = $2 and growth_partner_id is null and deleted_at is null`,
      [org.id, agents.lead_hunter],
    ))).rows[0].count);
    const requestStart = mock.requests.length;
    try {
      const result = await sendChatMessage(ctx, {
        agentRole: "lead_hunter",
        content: "Only look for synthetic cabinet makers in Winter Park.",
        clientMessageId: crypto.randomUUID(),
      });
      expect(result).toMatchObject({ conversationId: growthPartnerConversationId, runId: null, jobId: null });
      expect(await getTargeting(ctx)).toMatchObject({ industries: ["synthetic cabinet makers"], regions: ["Winter Park"] });
      const after = Number((await withSystem((db) => db.query<{ count: number }>(
        `select count(*)::int as count from chat_conversations
         where org_id = $1 and agent_instance_id = $2 and growth_partner_id is null and deleted_at is null`,
        [org.id, agents.lead_hunter],
      ))).rows[0].count);
      expect(after).toBe(before);
      expect(mock.requests.slice(requestStart).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
    } finally {
      await saveTargeting(ctx, previousTargeting);
      await resetAgentMessageRateLimit(owner.id);
    }
  });

  it("saves lead targeting and updates one real Growth Partner schedule through the permanent chat", async () => {
    await resetAgentMessageRateLimit(owner.id);
    const ctx = ctxFor(owner, org, "owner");
    const previousTargeting = await getTargeting(ctx);
    const scheduleSwitchBefore = process.env.WORKFORCE_SCHEDULES_ENABLED;
    process.env.WORKFORCE_SCHEDULES_ENABLED = "false";
    try {
      const targetingUpdate = await sendChatMessage(ctx, {
        agentRole: "growth_partner",
        content: "Only look for dental clinics in Florida.",
        clientMessageId: crypto.randomUUID(),
      });
      expect(targetingUpdate).toMatchObject({ conversationId: growthPartnerConversationId, runId: null, jobId: null });
      const targetingReply = (await withSystem((db) => db.query<{ content: string }>(
        "select content from chat_messages where id = $1 and org_id = $2",
        [targetingUpdate.assistantMessageId, org.id],
      ))).rows[0].content;
      expect(targetingReply).toContain("Saved lead targeting");
      expect(await getTargeting(ctx)).toMatchObject({ industries: ["dental clinics"], regions: ["Florida"] });
      expect((await withSystem((db) => db.query<{ metadata: Record<string, unknown> }>(
        "select metadata from audit_logs where org_id = $1 and action = 'leads.targeting_saved' order by created_at desc limit 1",
        [org.id],
      ))).rows[0].metadata).toMatchObject({ changedKeys: expect.arrayContaining(["industries", "regions"]) });

      const schedulePreview = await sendChatMessage(ctx, {
        agentRole: "growth_partner",
        content: "Research 10 dental clinics in Florida every weekday at 9 AM",
        clientMessageId: crypto.randomUUID(),
      });
      const previewText = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1", [schedulePreview.assistantMessageId]))).rows[0].content;
      expect(previewText).toContain("Schedule preview");
      expect(schedulePreview.conversationId).toBe(growthPartnerConversationId);
      await sendChatMessage(ctx, {
        agentRole: "growth_partner", conversationId: growthPartnerConversationId,
        content: "confirm schedule", clientMessageId: crypto.randomUUID(),
      });
      const created = (await withSystem((db) => db.query<{ id: string; enabled: boolean; recurrence_rule: Record<string, unknown>; payload: Record<string, unknown> }>(
        "select id, enabled, recurrence_rule, payload from ai_work_schedules where org_id = $1 and agent_instance_id = $2 and capability = 'lead_research'",
        [org.id, growthPartnerAgentId],
      ))).rows[0];
      expect(created).toMatchObject({ enabled: false, recurrence_rule: { kind: "weekly", localTime: "09:00" }, payload: { target: "dental clinics", location: "Florida", quantity: 10 } });
      await setScheduleEnabled(ctx, created.id, true);

      const changePreview = await sendChatMessage(ctx, {
        agentRole: "growth_partner",
        content: "Move our lead hunting to 2 PM–5 PM",
        clientMessageId: crypto.randomUUID(),
      });
      const changeText = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1", [changePreview.assistantMessageId]))).rows[0].content;
      expect(changeText).toContain("updated in place");
      expect(changeText).toContain("remain enabled");
      expect(changeText).toContain("2:00 PM–5:00 PM");
      expect(changeText).toContain("one run at 2:00 PM");
      const changeConfirm = await sendChatMessage(ctx, {
        agentRole: "growth_partner", conversationId: growthPartnerConversationId,
        content: "confirm schedule", clientMessageId: crypto.randomUUID(),
      });
      const changed = (await withSystem((db) => db.query<{ id: string; enabled: boolean; recurrence_rule: Record<string, unknown>; business_hours: Record<string, unknown>; payload: Record<string, unknown>; next_run_at: Date }>(
        "select id, enabled, recurrence_rule, business_hours, payload, next_run_at from ai_work_schedules where org_id = $1 and agent_instance_id = $2 and capability = 'lead_research'",
        [org.id, growthPartnerAgentId],
      ))).rows[0];
      expect(changed).toMatchObject({
        id: created.id,
        enabled: true,
        recurrence_rule: { kind: "weekly", localTime: "14:00", weekdays: ["mon", "tue", "wed", "thu", "fri"] },
        business_hours: {
          mon: [["14:00", "17:00"]], tue: [["14:00", "17:00"]], wed: [["14:00", "17:00"]],
          thu: [["14:00", "17:00"]], fri: [["14:00", "17:00"]],
        },
        payload: created.payload,
      });
      expect(new Date(changed.next_run_at).getTime()).toBeGreaterThan(Date.now());
      expect((await withSystem((db) => db.query(
        "select id from ai_work_schedules where org_id = $1 and agent_instance_id = $2 and capability = 'lead_research'",
        [org.id, growthPartnerAgentId],
      ))).rows).toHaveLength(1);
      const confirmText = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1", [changeConfirm.assistantMessageId]))).rows[0].content;
      expect(confirmText).toContain("Updated Lead research");
      expect(confirmText).toContain("2:00 PM–5:00 PM");
      expect(confirmText).toContain("still enabled");
      expect((await withSystem((db) => db.query(
        "select id from ai_work_schedules where org_id = $1 and agent_instance_id = $2 and capability = 'lead_research'",
        [org.id, growthPartnerAgentId],
      ))).rows).toHaveLength(1);

      const stalePausePreview = await sendChatMessage(ctx, {
        agentRole: "growth_partner", conversationId: growthPartnerConversationId,
        content: "Pause my lead research schedule", clientMessageId: crypto.randomUUID(),
      });
      await setScheduleEnabled(ctx, created.id, false);
      const stalePauseConfirm = await sendChatMessage(ctx, {
        agentRole: "growth_partner", conversationId: growthPartnerConversationId,
        content: "confirm schedule", clientMessageId: crypto.randomUUID(),
      });
      expect((await withSystem((db) => db.query<{ content: string }>(
        "select content from chat_messages where id = $1 and org_id = $2", [stalePauseConfirm.assistantMessageId, org.id],
      ))).rows[0].content).toContain("schedule changed after this preview");
      expect((await withSystem((db) => db.query<{ pending_workforce_schedule: Record<string, unknown>; enabled: boolean }>(
        `select c.pending_workforce_schedule, s.enabled
           from chat_conversations c join ai_work_schedules s on s.org_id = c.org_id
          where c.id = $1 and s.id = $2`, [stalePausePreview.conversationId, created.id],
      ))).rows[0]).toMatchObject({ pending_workforce_schedule: { status: "expired" }, enabled: false });
      await setScheduleEnabled(ctx, created.id, true);

      const pauseAuditBefore = Number((await withSystem((db) => db.query<{ count: string }>(
        "select count(*)::text as count from audit_logs where org_id = $1 and target_id = $2 and action = 'workforce.schedule_disabled'",
        [org.id, created.id],
      ))).rows[0].count);
      const pausePreview = await sendChatMessage(ctx, {
        agentRole: "growth_partner", conversationId: growthPartnerConversationId,
        content: "Pause my lead research schedule", clientMessageId: crypto.randomUUID(),
      });
      const pausePreviewText = (await withSystem((db) => db.query<{ content: string }>(
        "select content from chat_messages where id = $1 and org_id = $2", [pausePreview.assistantMessageId, org.id],
      ))).rows[0].content;
      expect(pausePreviewText).toMatch(/Pause preview.*currently enabled.*paused/i);
      expect((await withSystem((db) => db.query<{ enabled: boolean }>(
        "select enabled from ai_work_schedules where id = $1 and org_id = $2", [created.id, org.id],
      ))).rows[0].enabled).toBe(true);
      const pauseState = (await withSystem((db) => db.query<{ pending_workforce_schedule: Record<string, unknown> }>(
        "select pending_workforce_schedule from chat_conversations where id = $1 and org_id = $2", [growthPartnerConversationId, org.id],
      ))).rows[0].pending_workforce_schedule;
      expect(pauseState).toMatchObject({ status: "pending", setEnabledOnly: true, enabledAfterSave: false, expectedExistingSchedule: { id: created.id } });

      const memberPause = await sendChatMessage(ctxFor(member, org, "member"), {
        agentRole: "growth_partner", conversationId: growthPartnerConversationId,
        content: "Pause my lead research schedule", clientMessageId: crypto.randomUUID(),
      });
      const memberPauseText = (await withSystem((db) => db.query<{ content: string }>(
        "select content from chat_messages where id = $1 and org_id = $2", [memberPause.assistantMessageId, org.id],
      ))).rows[0].content;
      expect(memberPauseText).toContain("can't manage this AI schedule");
      expect((await withSystem((db) => db.query<{ enabled: boolean }>(
        "select enabled from ai_work_schedules where id = $1 and org_id = $2", [created.id, org.id],
      ))).rows[0].enabled).toBe(true);

      const pauseConfirm = await sendChatMessage(ctx, {
        agentRole: "growth_partner", conversationId: growthPartnerConversationId,
        content: "confirm schedule", clientMessageId: crypto.randomUUID(),
      });
      const pauseResult = (await withSystem((db) => db.query<{ id: string; enabled: boolean; payload: Record<string, unknown> }>(
        "select id, enabled, payload from ai_work_schedules where org_id = $1 and agent_instance_id = $2 and capability = 'lead_research'",
        [org.id, growthPartnerAgentId],
      ))).rows[0];
      expect(pauseResult).toMatchObject({ id: created.id, enabled: false, payload: created.payload });
      const pauseReply = (await withSystem((db) => db.query<{ content: string }>(
        "select content from chat_messages where id = $1 and org_id = $2", [pauseConfirm.assistantMessageId, org.id],
      ))).rows[0].content;
      expect(pauseReply).toMatch(/Paused Lead research.*No future scheduled jobs.*already created remains on the Work Board/i);
      const pauseAuditCount = (await withSystem((db) => db.query<{ count: string }>(
        "select count(*)::text as count from audit_logs where org_id = $1 and target_id = $2 and action = 'workforce.schedule_disabled'",
        [org.id, created.id],
      ))).rows[0].count;
      expect(Number(pauseAuditCount)).toBe(pauseAuditBefore + 1);

      const resumePreview = await sendChatMessage(ctx, {
        agentRole: "growth_partner", conversationId: growthPartnerConversationId,
        content: "Resume my lead research schedule", clientMessageId: crypto.randomUUID(),
      });
      expect((await withSystem((db) => db.query<{ content: string }>(
        "select content from chat_messages where id = $1 and org_id = $2", [resumePreview.assistantMessageId, org.id],
      ))).rows[0].content).toMatch(/Resume preview.*currently paused.*workspace schedule automation/i);
      const resumeConfirm = await sendChatMessage(ctx, {
        agentRole: "growth_partner", conversationId: growthPartnerConversationId,
        content: "confirm schedule", clientMessageId: crypto.randomUUID(),
      });
      expect((await withSystem((db) => db.query<{ enabled: boolean; payload: Record<string, unknown> }>(
        "select enabled, payload from ai_work_schedules where id = $1 and org_id = $2", [created.id, org.id],
      ))).rows[0]).toMatchObject({ enabled: true, payload: created.payload });
      expect((await withSystem((db) => db.query<{ content: string }>(
        "select content from chat_messages where id = $1 and org_id = $2", [resumeConfirm.assistantMessageId, org.id],
      ))).rows[0].content).toMatch(/Resumed Lead research.*next planned time/i);

      await withSystem((db) => db.query(
        "update ai_work_schedules set next_run_at = now() - interval '1 minute' where id = $1 and org_id = $2", [created.id, org.id],
      ));
      const jobsBeforeBlockedTick = (await withSystem((db) => db.query<{ count: string }>(
        "select count(*)::text as count from ai_work_jobs where org_id = $1 and capability = 'lead_research'", [org.id],
      ))).rows[0].count;
      expect(await runDueSchedules()).toMatchObject({ operatorEnabled: false, created: 0 });
      const jobsAfterBlockedTick = (await withSystem((db) => db.query<{ count: string }>(
        "select count(*)::text as count from ai_work_jobs where org_id = $1 and capability = 'lead_research'", [org.id],
      ))).rows[0].count;
      expect(jobsAfterBlockedTick).toBe(jobsBeforeBlockedTick);
      expect(process.env.WORKFORCE_SCHEDULES_ENABLED).toBe("false");
    } finally {
      if (scheduleSwitchBefore === undefined) delete process.env.WORKFORCE_SCHEDULES_ENABLED;
      else process.env.WORKFORCE_SCHEDULES_ENABLED = scheduleSwitchBefore;
      await saveTargeting(ctx, previousTargeting);
      await withSystem((db) => db.query("delete from ai_work_schedules where org_id = $1 and agent_instance_id = $2 and capability = 'lead_research'", [org.id, growthPartnerAgentId]));
      await resetAgentMessageRateLimit(owner.id);
    }
  });

  it("pauses and resumes tenant outbound actions through the permanent Growth Partner conversation", async () => {
    const requestStart = mock.requests.length;
    await resetAgentMessageRateLimit(owner.id);
    await resetAgentMessageRateLimit(member.id);
    await withSystem((db) => db.query("delete from automation_pauses where org_id = $1 and scope = 'outbound'", [org.id]));
    try {
      const paused = await sendChatMessage(ctxFor(owner, org, "owner"), {
        agentRole: "growth_partner",
        content: "Pause outbound campaigns.",
        clientMessageId: crypto.randomUUID(),
      });
      expect(paused).toMatchObject({ conversationId:…13796 tokens truncated… chat_messages where id = $1 and org_id = $2",
      [preview.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(previewReply).toContain("Appointment preview");
    expect(previewReply).toContain("does not hold or book the slot");
    const proposal = (await withSystem((db) => db.query<{ pending_workforce_booking: Record<string, unknown> }>(
      "select pending_workforce_booking from chat_conversations where id = $1 and org_id = $2",
      [preview.conversationId, org.id],
    ))).rows[0].pending_workforce_booking;
    expect(proposal).toMatchObject({ status: "pending", contactId: contact.rows[0].id, requestedBy: owner.id, agentInstanceId: growthPartnerAgentId });
    expect((await withSystem((db) => db.query("select id from appointment_bookings where org_id = $1 and contact_id = $2", [org.id, contact.rows[0].id]))).rows).toHaveLength(0);

    const confirm = await sendChatMessage(ctxFor(owner, org, "owner"), {
      agentRole: "appointment_setter",
      conversationId: preview.conversationId,
      content: "confirm booking",
      clientMessageId: crypto.randomUUID(),
    });
    const booking = (await withSystem((db) => db.query<{
      id: string; status: string; requested_by_kind: string; requested_by_user: string | null; agent_id: string | null; conversation_id: string | null;
    }>(
      "select id, status, requested_by_kind, requested_by_user, agent_id, conversation_id from appointment_bookings where org_id = $1 and contact_id = $2",
      [org.id, contact.rows[0].id],
    ))).rows[0];
    expect(booking).toMatchObject({ status: "awaiting_approval", requested_by_kind: "ai", requested_by_user: owner.id, agent_id: growthPartnerAgentId, conversation_id: null });
    const confirmationReply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2",
      [confirm.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(confirmationReply).toContain("not booked yet");
    expect(confirmationReply).toContain("/approvals");
    const approval = (await withSystem((db) => db.query<{ id: string; reason: string; expected_effect: string }>(
      "select id, reason, expected_effect from approval_requests where org_id = $1 and kind = 'appointment_booking' and target_id = $2",
      [org.id, booking.id],
    ))).rows[0];
    expect(approval.reason).toContain("team member selected and explicitly confirmed");
    expect(approval.reason).not.toContain("customer asked");
    expect(approval.expected_effect).toContain("calendar provider's settings");

    const repeat = await sendChatMessage(ctxFor(owner, org, "owner"), {
      agentRole: "appointment_setter",
      conversationId: preview.conversationId,
      content: "confirm booking",
      clientMessageId: crypto.randomUUID(),
    });
    const repeatReply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2",
      [repeat.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(repeatReply).toContain("already waiting");
    expect((await withSystem((db) => db.query("select id from appointment_bookings where org_id = $1 and contact_id = $2", [org.id, contact.rows[0].id]))).rows).toHaveLength(1);

    const ownerContext = ctxFor(owner, org, "owner");
    const noBookingPermission = { ...ownerContext, can: (permission: Parameters<typeof ownerContext.can>[0]) => permission !== "appointments.book" && ownerContext.can(permission) };
    const denied = await sendChatMessage(noBookingPermission, {
      agentRole: "appointment_setter",
      conversationId: preview.conversationId,
      content: `Book an appointment with Chat Booking E2E Contact at ${startAt.toISOString().slice(0, 16)}Z`,
      clientMessageId: crypto.randomUUID(),
    });
    const deniedReply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2",
      [denied.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(deniedReply).toContain("needs permission");
    expect((await withSystem((db) => db.query("select id from appointment_bookings where org_id = $1 and contact_id = $2", [org.id, contact.rows[0].id]))).rows).toHaveLength(1);
    expect(mock.requests.slice(requestStart).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
    await resetAgentMessageRateLimit(owner.id);
  });

  it("routes Appointment Setter cancellation through an owner approval before changing the calendar", async () => {
    await resetAgentMessageRateLimit(member.id);
    const contact = await withSystem((db) => db.query<{ id: string }>(
      "insert into contacts (org_id, display_name, timezone) values ($1, 'Chat Change E2E Contact', 'UTC') returning id",
      [org.id],
    ));
    const startAt = new Date(Date.now() + 5 * 86_400_000);
    startAt.setUTCHours(10, 0, 0, 0);
    const appointment = await withSystem((db) => db.query<{ id: string }>(
      `insert into appointment_refs (org_id, provider, calendar_ref, appointment_type_id, title, status, start_at, end_at, timezone, contact_id, booked_via, origin, created_by)
       select $1, 'native', c.id, t.id, 'Approved change appointment', 'confirmed', $3, $4, 'UTC', $5, 'staff', 'portal_staff', $6
         from crm_calendars c join crm_appointment_types t on t.org_id = c.org_id and t.calendar_id = c.id
        where c.org_id = $1 and c.slug = $2 order by t.position limit 1
       returning id`,
      [org.id, "workflow-calendar", startAt.toISOString(), new Date(startAt.getTime() + 30 * 60_000).toISOString(), contact.rows[0].id, owner.id],
    ));
    expect(appointment.rows).toHaveLength(1);
    const appointmentId = appointment.rows[0].id;
    const memberContext = ctxFor(member, org, "member");
    expect(memberContext.can("appointments.book")).toBe(true);
    expect(memberContext.can("appointments.manage")).toBe(false);
    const requestStart = mock.requests.length;

    const preview = await sendChatMessage(memberContext, {
      agentRole: "appointment_setter",
      content: `Cancel the appointment for Chat Change E2E Contact at ${startAt.toISOString().slice(0, 16)}Z`,
      clientMessageId: crypto.randomUUID(),
    });
    const previewReply = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1", [preview.assistantMessageId]))).rows[0].content;
    expect(previewReply).toContain("Cancellation preview");
    expect(previewReply).toContain("owner or admin approval");
    expect((await withSystem((db) => db.query("select id from approval_requests where org_id = $1 and kind = 'appointment_change' and target_id = $2", [org.id, appointmentId]))).rows).toHaveLength(0);
    expect((await withSystem((db) => db.query<{ status: string }>("select status from appointment_refs where id = $1 and org_id = $2", [appointmentId, org.id]))).rows[0].status).toBe("confirmed");

    const confirm = await sendChatMessage(memberContext, {
      agentRole: "appointment_setter",
      conversationId: preview.conversationId,
      content: "confirm appointment change",
      clientMessageId: crypto.randomUUID(),
    });
    const confirmReply = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1", [confirm.assistantMessageId]))).rows[0].content;
    expect(confirmReply).toContain("not changed yet");
    const approval = (await withSystem((db) => db.query<{ id: string; reason: string; expected_effect: string; status: string }>(
      "select id, reason, expected_effect, status from approval_requests where org_id = $1 and kind = 'appointment_change' and target_id = $2",
      [org.id, appointmentId],
    ))).rows[0];
    expect(approval).toMatchObject({ status: "pending" });
    expect(approval.reason).toContain("explicitly confirmed");
    expect(approval.expected_effect).toContain("No customer message will be sent");
    expect((await withSystem((db) => db.query<{ status: string }>("select status from appointment_refs where id = $1 and org_id = $2", [appointmentId, org.id]))).rows[0].status).toBe("confirmed");
    expect(mock.requests.slice(requestStart).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);

    const decision = await decideApproval(ctxFor(owner, org, "owner"), approval.id, "approve");
    expect(decision.outcome).toMatchObject({ status: "succeeded" });
    expect((await withSystem((db) => db.query<{ status: string }>("select status from appointment_refs where id = $1 and org_id = $2", [appointmentId, org.id]))).rows[0].status).toBe("cancelled");
    await resetAgentMessageRateLimit(member.id);
  });

  it("rechecks and executes an approved Appointment Setter reschedule through the native calendar service", async () => {
    await resetAgentMessageRateLimit(member.id);
    const contact = await withSystem((db) => db.query<{ id: string }>(
      "insert into contacts (org_id, display_name, timezone) values ($1, 'Chat Reschedule E2E Contact', 'UTC') returning id",
      [org.id],
    ));
    const startAt = new Date(Date.now() + 5 * 86_400_000);
    startAt.setUTCHours(10, 0, 0, 0);
    const replacementAt = new Date(startAt.getTime() + 60 * 60_000);
    const appointment = await withSystem((db) => db.query<{ id: string }>(
      `insert into appointment_refs (org_id, provider, calendar_ref, appointment_type_id, title, status, start_at, end_at, timezone, contact_id, assigned_user_id, booked_via, origin, created_by)
       select $1, 'native', c.id, t.id, 'Approved reschedule appointment', 'confirmed', $3, $4, 'UTC', $5, $6, 'staff', 'portal_staff', $6
         from crm_calendars c join crm_appointment_types t on t.org_id = c.org_id and t.calendar_id = c.id
        where c.org_id = $1 and c.slug = $2 order by t.position limit 1
       returning id`,
      [org.id, "workflow-calendar", startAt.toISOString(), new Date(startAt.getTime() + 30 * 60_000).toISOString(), contact.rows[0].id, owner.id],
    ));
    expect(appointment.rows).toHaveLength(1);
    const appointmentId = appointment.rows[0].id;
    await withSystem((db) => db.query("insert into crm_appointment_hosts (org_id, appointment_id, user_id) values ($1, $2, $3)", [org.id, appointmentId, owner.id]));
    const memberContext = ctxFor(member, org, "member");

    const preview = await sendChatMessage(memberContext, {
      agentRole: "appointment_setter",
      content: `Reschedule the appointment for Chat Reschedule E2E Contact from ${startAt.toISOString().slice(0, 16)}Z to ${replacementAt.toISOString().slice(0, 16)}Z`,
      clientMessageId: crypto.randomUUID(),
    });
    const previewReply = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1", [preview.assistantMessageId]))).rows[0].content;
    expect(previewReply).toContain("Reschedule preview");
    expect(previewReply).toContain("replacement time is not held");
    expect((await withSystem((db) => db.query<{ start_at: Date }>("select start_at from appointment_refs where id = $1", [appointmentId]))).rows[0].start_at.toISOString()).toBe(startAt.toISOString());

    const confirm = await sendChatMessage(memberContext, {
      agentRole: "appointment_setter",
      conversationId: preview.conversationId,
      content: "confirm appointment change",
      clientMessageId: crypto.randomUUID(),
    });
    const confirmReply = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1", [confirm.assistantMessageId]))).rows[0].content;
    expect(confirmReply).toContain("not changed yet");
    const approval = (await withSystem((db) => db.query<{ id: string }>(
      "select id from approval_requests where org_id = $1 and kind = 'appointment_change' and target_id = $2",
      [org.id, appointmentId],
    ))).rows[0];
    const decision = await decideApproval(ctxFor(owner, org, "owner"), approval.id, "approve");
    expect(decision.outcome).toMatchObject({ status: "succeeded" });
    const moved = (await withSystem((db) => db.query<{ start_at: Date; status: string }>("select start_at, status from appointment_refs where id = $1 and org_id = $2", [appointmentId, org.id]))).rows[0];
    expect(moved.status).toBe("confirmed");
    expect(moved.start_at.toISOString()).toBe(replacementAt.toISOString());
    await resetAgentMessageRateLimit(member.id);
  });

  it("requires a live preview at confirmation time", async () => {
    const preview = await sendChatMessage(ctxFor(owner, org, "owner"), {
      agentRole: "performance_analyst",
      content: "Prepare a performance report daily at 9 AM",
      clientMessageId: crypto.randomUUID(),
    });
    await withSystem((db) => db.query(
      "update chat_conversations set pending_workforce_schedule = jsonb_set(pending_workforce_schedule, '{expiresAt}', to_jsonb($2::text)) where id = $1",
      [preview.conversationId, new Date(Date.now() - 60_000).toISOString()],
    ));
    const confirm = await sendChatMessage(ctxFor(owner, org, "owner"), {
      agentRole: "performance_analyst",
      conversationId: preview.conversationId,
      content: "confirm schedule",
      clientMessageId: crypto.randomUUID(),
    });
    const reply = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1", [confirm.assistantMessageId]))).rows[0].content;
    expect(reply).toContain("preview has expired");
    expect((await withSystem((db) => db.query("select id from ai_work_schedules where org_id = $1 and agent_instance_id = $2 and capability = 'performance_snapshot'", [org.id, growthPartnerAgentId]))).rows).toHaveLength(0);
  });

  it("sets and verifies a measured Growth Partner goal through the permanent conversation", async () => {
    await resetAgentMessageRateLimit(owner.id);
    const ctx = ctxFor(owner, org, "owner");
    const malformed = await sendChatMessage(ctx, {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Set our goal to 20 per week.",
      clientMessageId: crypto.randomUUID(),
    });
    const malformedReply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2", [malformed.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(malformedReply).toContain("specify one target and period");
    expect((await withSystem((db) => db.query("select id from ai_growth_partner_goals where org_id = $1", [org.id]))).rows).toHaveLength(0);

    const requestStart = mock.requests.length;
    const result = await sendChatMessage(ctx, {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Set a goal of 20 qualified leads per week.",
      clientMessageId: crypto.randomUUID(),
    });
    expect(result).toMatchObject({ conversationId: growthPartnerConversationId, runId: null, jobId: null });
    const reply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2", [result.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(reply).toContain("Saved the leads approved goal: 20 per week");
    expect(reply).toContain("target, not a guarantee");
    expect((await withSystem((db) => db.query<{ metric_key: string; cadence: string; target_value: number; enabled: boolean; revision: number }>(
      "select metric_key, cadence, target_value, enabled, revision from ai_growth_partner_goals where org_id = $1 and partner_id = (select id from ai_growth_partners where org_id = $1)", [org.id],
    ))).rows).toEqual([{ metric_key: "leads_approved", cadence: "weekly", target_value: 20, enabled: true, revision: 1 }]);
    expect(await withSystem((db) => growthPartnerGoalPromptContext(db, org.id, growthPartnerAgentId))).toContain("Leads approved: 20 per week");
    expect((await withSystem((db) => db.query<{ action: string; metadata: Record<string, unknown> }>(
      "select action, metadata from audit_logs where org_id = $1 and action = 'ai_growth_partner.goal_created' order by created_at desc limit 1", [org.id],
    ))).rows[0]).toMatchObject({
      action: "ai_growth_partner.goal_created",
      metadata: { metric: "leads_approved", cadence: "weekly", targetValue: 20, revision: 1 },
    });
    const repeated = await sendChatMessage(ctx, {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Set a goal of 20 qualified leads per week.",
      clientMessageId: crypto.randomUUID(),
    });
    const repeatedReply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2", [repeated.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(repeatedReply).toContain("already set to 20 per week");
    expect((await withSystem((db) => db.query<{ revision: number }>(
      "select revision from ai_growth_partner_goals where org_id = $1 and metric_key = 'leads_approved' and cadence = 'weekly'", [org.id],
    ))).rows[0].revision).toBe(1);
    expect(mock.requests.slice(requestStart).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);

    await resetAgentMessageRateLimit(member.id);
    const denied = await sendChatMessage(ctxFor(member, org, "member"), {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Change our qualified leads target to 25 per week.",
      clientMessageId: crypto.randomUUID(),
    });
    const deniedReply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2", [denied.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(deniedReply).toContain("Only a workspace owner or admin");
    expect((await withSystem((db) => db.query<{ target_value: number; revision: number }>(
      "select target_value, revision from ai_growth_partner_goals where org_id = $1 and metric_key = 'leads_approved' and cadence = 'weekly'", [org.id],
    ))).rows[0]).toEqual({ target_value: 20, revision: 1 });
    await resetAgentMessageRateLimit(owner.id);
    await resetAgentMessageRateLimit(member.id);
  });

  it("saves bounded persistent preferences from the permanent chat on the Growth Partner only", async () => {
    await resetAgentMessageRateLimit(owner.id);
    const ctx = ctxFor(owner, org, "owner");
    const legacyBefore = (await withSystem((db) => db.query<{ settings: Record<string, unknown>; version: number }>(
      `select v.settings, v.version from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 and a.role_key = 'lead_hunter'`, [org.id],
    ))).rows[0];
    const partnerVersionBefore = (await withSystem((db) => db.query<{ version: number }>(
      "select v.version from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id where a.org_id = $1 and a.role_key = 'growth_partner'",
      [org.id],
    ))).rows[0].version;

    const invalid = await sendChatMessage(ctx, {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Set your tone to neon from now on.",
      clientMessageId: crypto.randomUUID(),
    });
    const invalidReply = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1 and org_id = $2", [invalid.assistantMessageId, org.id]))).rows[0].content;
    expect(invalidReply).toContain("Choose friendly, professional, casual, or premium");
    expect((await withSystem((db) => db.query<{ version: number }>(
      "select v.version from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id where a.org_id = $1 and a.role_key = 'growth_partner'",
      [org.id],
    ))).rows[0].version).toBe(partnerVersionBefore);

    const result = await sendChatMessage(ctx, {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Set your tone to premium and reply in Spanish from now on.",
      clientMessageId: crypto.randomUUID(),
    });
    expect(result.conversationId).toBe(growthPartnerConversationId);
    const reply = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1 and org_id = $2", [result.assistantMessageId, org.id]))).rows[0].content;
    expect(reply).toContain("Saved and applied premium tone, Spanish replies for future conversations.");

    const partnerSettings = (await withSystem((db) => db.query<{ settings: Record<string, unknown> }>(
      `select v.settings from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 and a.role_key = 'growth_partner'`, [org.id],
    ))).rows[0].settings;
    expect(partnerSettings).toMatchObject({ tone: "premium", language: "Spanish" });
    expect((await withSystem((db) => db.query<{ ai_preferences: Record<string, unknown> }>(
      "select ai_preferences from company_profiles where org_id = $1", [org.id],
    ))).rows[0].ai_preferences).toMatchObject({ tone: "premium", language: "Spanish" });
    expect((await withSystem((db) => db.query<{ settings: Record<string, unknown>; version: number }>(
      `select v.settings, v.version from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 and a.role_key = 'lead_hunter'`, [org.id],
    ))).rows[0]).toEqual(legacyBefore);
    expect((await withSystem((db) => db.query<{ apply: boolean }>(
      "select (metadata->>'applyToEmployees')::boolean as apply from audit_logs where org_id = $1 and action = 'settings.ai_preferences_updated' order by created_at desc limit 1",
      [org.id],
    ))).rows[0].apply).toBe(true);

    const viewer = await createUser({ name: "Preference Viewer" });
    await addMember(org.id, viewer.id, "viewer");
    await expect(sendChatMessage(ctxFor(viewer, org, "viewer"), {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Change your tone to casual from now on.",
      clientMessageId: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "forbidden" });
    expect((await withSystem((db) => db.query<{ settings: Record<string, unknown> }>(
      `select v.settings from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 and a.role_key = 'growth_partner'`, [org.id],
    ))).rows[0].settings).toMatchObject({ tone: "premium", language: "Spanish" });
  });

  it("uses a reviewed Business Brain version in the next real Growth Partner run instructions", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const before = await withSystem((db) => buildRunInstructions(db, org.id, growthPartnerAgentId));
    expect(before.instructions).toContain("(No confirmed Business Brain facts are available yet.)");

    const draft = await saveGrowthPartnerBusinessBrainFactDraft(ctx, {
      baseVersion: 1,
      section: "policies",
      key: "customerPolicies",
      valueText: "Consultations are paid; do not offer free consultations.",
    });
    const beforeActivation = await withSystem((db) => buildRunInstructions(db, org.id, growthPartnerAgentId));
    expect(beforeActivation.instructions).not.toContain("Consultations are paid");

    await activateGrowthPartnerBusinessBrainVersion(ctx, { expectedCurrentVersion: 1, version: draft.version });
    const afterActivation = await withSystem((db) => buildRunInstructions(db, org.id, growthPartnerAgentId));
    expect(afterActivation.instructions).toContain("policies.customerPolicies: Consultations are paid; do not offer free consultations.");
    expect(afterActivation.instructions).toContain("Active Business Brain (version 2)");
  });
});
