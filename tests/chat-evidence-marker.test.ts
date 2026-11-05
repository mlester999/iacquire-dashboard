// What each stored chat reply says it is. A language model's reply carries the areas it was really handed; a refusal, a clarification, a redirect and a job acknowledgement are
// system notices; a preview is a proposal; a saved schedule is an approved write; a booking that lands waiting for approval is NOT a completed action; and no server-composed reply
// is ever a model response. The Hermes server is a local stand-in, so this proves the plumbing and the stored data, not any model's behaviour.
import crypto from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { parseEvidenceMarker, type EvidenceMarker } from "@/lib/evidence-class";
import type { EmployeeEvidence } from "@/lib/employee-evidence";
import { getConversation, sendChatMessage } from "@/server/chat/service";
import { subscribe, type ChatStreamEvent } from "@/server/chat/hub";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "m".repeat(40);
const PROFILE = Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [role, `c-marker-${role.replaceAll("_", "-")}`])) as Record<AgentRoleKey, string>;

let mock: MockHermes;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
const agents = {} as Record<AgentRoleKey, string>;

interface StoredMessage {
  id: string; role: string; content: string; status: string; run_id: string | null; work_job_id: string | null; evidence: EvidenceMarker | null;
}
const stored = async (id: string) => (await withSystem((db) => db.query<StoredMessage>(
  "select id, role, content, status, run_id, work_job_id, evidence from chat_messages where id = $1 and org_id = $2", [id, org.id],
))).rows[0];

async function resetRateLimit(userId: string) {
  await withSystem((db) => db.query("delete from rate_limit_buckets where bucket_key = $1", [`${RATE_LIMITS.agentMessageByUser.name}:${userId}`]));
}
async function say(user: typeof owner, role: "owner" | "member", agentRole: AgentRoleKey, content: string, conversationId?: string | null, ctxEdit?: (ctx: ReturnType<typeof ctxFor>) => ReturnType<typeof ctxFor>) {
  await resetRateLimit(user.id);
  const base = ctxFor(user, org, role);
  return sendChatMessage(ctxEdit ? ctxEdit(base) : base, { agentRole, content, conversationId: conversationId ?? undefined, clientMessageId: crypto.randomUUID() });
}
async function waitForMessage(id: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await stored(id);
    if (row && row.status !== "streaming") return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("assistant message did not finish");
}
async function waitForJob(jobId: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where id = $1 and org_id = $2", [jobId, org.id]));
    if (rows[0] && ["completed", "blocked", "failed", "cancelled"].includes(rows[0].status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("work job did not settle");
}
function evidenceIn(instructions: string): EmployeeEvidence {
  const open = "<verified_workspace_evidence>";
  const start = instructions.indexOf(open);
  const end = instructions.indexOf("</verified_workspace_evidence>");
  expect(start, "the run carried no workspace evidence").toBeGreaterThan(-1);
  return JSON.parse(instructions.slice(start + open.length, end).trim()) as EmployeeEvidence;
}

beforeAll(async () => {
  mock = await startMockHermes(Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [PROFILE[role], { key: KEY }])));
  org = await createOrg({ name: "Evidence Marker Co" });
  owner = await createUser({ name: "Marker Owner" });
  admin = await createUser({ platformRole: "agency_super_admin", name: "Test Workforce Admin" });
  member = await createUser({ name: "Marker Member" });
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, member.id, "member");
  for (const role of AGENT_ROLE_KEYS) {
    const id = await agentId(org.id, role);
    agents[role] = id;
    await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: owner.id, apply: true }));
    await connectHermesProfile({ agentId: id, baseUrl: mock.url, profile: PROFILE[role], apiKey: KEY, agencyUserId: admin.id });
    expect(await runHealthCheck(id, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  }
  await withSystem(async (db) => {
    const calendar = await db.query<{ id: string }>(
      "insert into crm_calendars (org_id, name, slug, is_default, public, created_by) values ($1, 'Marker Calendar', 'marker-calendar', true, true, $2) returning id",
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
      await db.query("insert into crm_availability_rules (org_id, user_id, weekday, start_minute, end_minute) values ($1, $2, $3, 540, 1020)", [org.id, owner.id, weekday]);
    }
  });
}, 120_000);

afterAll(async () => {
  await mock.close();
});

describe("a model turn", () => {
  let turn: Awaited<ReturnType<typeof sendChatMessage>>;
  let instructions: string;

  it("stores model_response with the verified areas it was handed, and nothing it was not", async () => {
    turn = await say(owner, "owner", "operations_manager", "What operational tasks or issues currently need attention?");
    expect(turn.runId).toEqual(expect.any(String));
    const message = await waitForMessage(turn.assistantMessageId);
    expect(message).toMatchObject({ role: "assistant", status: "complete" });
    expect(message.run_id).toBe(turn.runId);
    expect(message.evidence?.class).toBe("model_response");
    expect(message.evidence?.ledger).toBeUndefined();

    const { rows } = await withSystem((db) => db.query<{ hermes_run_id: string }>("select hermes_run_id from agent_runs where id = $1", [turn.runId]));
    instructions = String(mock.runs.get(rows[0].hermes_run_id)!.body.instructions);
    const handed = evidenceIn(instructions);
    const read = handed.sections.filter((s) => ["ready", "empty", "not_configured"].includes(s.state));
    expect(read.length).toBeGreaterThan(0);
    // Exactly the areas of the snapshot that were really read, with the same states, and the time the snapshot was taken.
    expect(message.evidence?.records?.areas).toEqual(read.map((s) => ({ id: s.id, state: s.state })));
    expect(message.evidence?.records?.readAt).toBe(handed.generatedAt);
    for (const s of handed.sections.filter((x) => !["ready", "empty", "not_configured"].includes(x.state))) {
      expect(message.evidence?.records?.areas.map((a) => a.id), `${s.id} was ${s.state}, so it was not read`).not.toContain(s.id);
    }
  });

  it("sends the same marker in the ready event, so the streaming bubble shows its chip", async () => {
    const events: ChatStreamEvent[] = [];
    const off = subscribe(turn.runId!, owner.id, (event) => events.push(event));
    expect(off).not.toBeNull();
    const ready = events.find((event) => event.type === "ready");
    expect(ready).toBeDefined();
    const message = await stored(turn.assistantMessageId);
    expect(ready && ready.type === "ready" ? ready.evidence : undefined).toEqual(message.evidence);
    // Another person cannot attach to the run to read it.
    expect(subscribe(turn.runId!, member.id, () => undefined)).toBeNull();
  });

  it("hands the page the parsed marker when the conversation is read back", async () => {
    const convo = await getConversation(ctxFor(owner, org, "owner"), turn.conversationId);
    const reply = convo!.messages.find((m) => m.id === turn.assistantMessageId)!;
    const user = convo!.messages.find((m) => m.id === turn.userMessageId)!;
    expect(reply.evidence).toEqual((await stored(turn.assistantMessageId)).evidence);
    expect(reply.evidence?.class).toBe("model_response");
    expect(user.evidence).toBeNull();
  });

  it("stamps a regenerated reply too, and the superseded one is no longer shown", async () => {
    await resetRateLimit(owner.id);
    const again = await sendChatMessage(ctxFor(owner, org, "owner"), { agentRole: "operations_manager", regenerateMessageId: turn.assistantMessageId, clientMessageId: crypto.randomUUID() });
    expect(again.runId).toEqual(expect.any(String));
    const message = await waitForMessage(again.assistantMessageId);
    expect(message.evidence?.class).toBe("model_response");
    expect(message.run_id).toBe(again.runId);
  });
});

describe("a reply the server wrote is never a model response", () => {
  it("stores a refusal as a system notice and starts no run", async () => {
    const before = mock.requests.length;
    const sent = await say(owner, "owner", "sales_assistant", "Send an email to these prospects about our offer");
    const reply = await stored(sent.assistantMessageId);
    expect(reply).toMatchObject({ run_id: null, evidence: { v: 1, class: "system_notice" } });
    expect(reply.content).toContain("No message or campaign was sent or scheduled");
    expect(mock.requests.slice(before).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
  });

  it("stores a clarification as a system notice", async () => {
    const sent = await say(owner, "owner", "lead_hunter", "Find dental practices near me");
    const reply = await stored(sent.assistantMessageId);
    expect(reply.content).toMatch(/number of qualified leads|city or area/i);
    expect(reply).toMatchObject({ run_id: null, evidence: { class: "system_notice" } });
  });

  it("stores a redirect to another employee as a system notice", async () => {
    const sent = await say(owner, "owner", "lead_hunter", "Performance Analyst, prepare our weekly performance report every Friday at 9 AM.");
    const reply = await stored(sent.assistantMessageId);
    expect(reply.content).toContain("/chat/performance-analyst");
    expect(reply).toMatchObject({ run_id: null, evidence: { class: "system_notice" } });
  });

  it("stores a permission denial as a system notice", async () => {
    const sent = await say(member, "member", "lead_hunter", "Operations Manager, review our operations and tell me what needs my attention.");
    const reply = await stored(sent.assistantMessageId);
    expect(reply.content).toContain("does not have permission");
    expect(reply).toMatchObject({ evidence: { class: "system_notice" } });
  });

  it("stores a job acknowledgement as a system notice that points at its job, and does not call it done", async () => {
    const sent = await say(owner, "owner", "crm_manager", "Check our CRM for incomplete records and possible duplicates");
    expect(sent.jobId).toEqual(expect.any(String));
    const reply = await stored(sent.assistantMessageId);
    expect(reply).toMatchObject({ work_job_id: sent.jobId, run_id: null, evidence: { v: 1, class: "system_notice" } });
    expect(reply.evidence?.ledger).toBeUndefined();
    await waitForJob(sent.jobId!);
  });

  it("stores both sides of an employee handoff as system notices", async () => {
    const sent = await say(owner, "owner", "lead_hunter", "CRM Manager, check our CRM for duplicates and incomplete records.");
    expect(sent.jobId).toEqual(expect.any(String));
    expect((await stored(sent.assistantMessageId)).evidence).toEqual({ v: 1, class: "system_notice" });
    const target = (await withSystem((db) => db.query<StoredMessage>(
      `select id, role, content, status, run_id, work_job_id, evidence from chat_messages where org_id = $1 and work_job_id = $2 and role = 'notice'`,
      [org.id, sent.jobId],
    ))).rows[0];
    expect(target.content).toContain("Task routed from Lead Hunter to CRM Manager");
    expect(target.evidence).toEqual({ v: 1, class: "system_notice" });
    await waitForJob(sent.jobId!);
  });
});

describe("a schedule", () => {
  it("is a proposal while it is only a preview, an approved write once saved, and a notice when there is nothing to confirm", async () => {
    const none = await say(owner, "owner", "operations_manager", "confirm schedule");
    expect((await stored(none.assistantMessageId)).evidence).toEqual({ v: 1, class: "system_notice" });
    expect((await stored(none.assistantMessageId)).content).toContain("There is no pending schedule preview to confirm");

    const preview = await say(owner, "owner", "operations_manager", "Review unresolved operational tasks every weekday at 9 AM");
    const previewRow = await stored(preview.assistantMessageId);
    expect(previewRow.content).toContain("Schedule preview");
    expect(previewRow.evidence).toEqual({ v: 1, class: "proposed_change" });
    expect((await withSystem((db) => db.query("select id from ai_work_schedules where org_id = $1", [org.id]))).rows).toHaveLength(0);

    const confirm = await say(owner, "owner", "operations_manager", "confirm schedule", preview.conversationId);
    const schedule = (await withSystem((db) => db.query<{ id: string }>("select id from ai_work_schedules where org_id = $1 and agent_instance_id = $2", [org.id, agents.operations_manager]))).rows;
    expect(schedule).toHaveLength(1);
    const saved = await stored(confirm.assistantMessageId);
    expect(saved.content).toContain("Saved");
    expect(saved.evidence).toEqual({ v: 1, class: "approved_write", ledger: { kind: "schedule", id: schedule[0].id } });

    const repeat = await say(owner, "owner", "operations_manager", "confirm schedule", preview.conversationId);
    expect((await stored(repeat.assistantMessageId)).evidence).toEqual({ v: 1, class: "system_notice" });
  });
});

describe("a booking", () => {
  it("is a proposal as a preview, and still a proposal when the request lands waiting for an owner's approval", async () => {
    const contact = await withSystem((db) => db.query<{ id: string }>("insert into contacts (org_id, display_name, timezone) values ($1, 'Marker Booking Contact', 'UTC') returning id", [org.id]));
    const startAt = new Date(Date.now() + 3 * 86_400_000);
    startAt.setUTCHours(10, 0, 0, 0);
    const preview = await say(owner, "owner", "appointment_setter", `Book an appointment with Marker Booking Contact at ${startAt.toISOString().slice(0, 16)}Z`);
    const previewRow = await stored(preview.assistantMessageId);
    expect(previewRow.content).toContain("Appointment preview");
    expect(previewRow.evidence).toEqual({ v: 1, class: "proposed_change" });

    const confirm = await say(owner, "owner", "appointment_setter", "confirm booking", preview.conversationId);
    const booking = (await withSystem((db) => db.query<{ id: string; status: string; approval_id: string }>("select id, status, approval_id from appointment_bookings where org_id = $1 and contact_id = $2", [org.id, contact.rows[0].id]))).rows[0];
    expect(booking.status).toBe("awaiting_approval");
    const result = await stored(confirm.assistantMessageId);
    expect(result.content).toContain("not booked yet");
    // Waiting for a person is not a completed action; the marker names the approval that holds it.
    expect(result.evidence).toEqual({ v: 1, class: "proposed_change", ledger: { kind: "approval", id: booking.approval_id } });

    const repeat = await say(owner, "owner", "appointment_setter", "confirm booking", preview.conversationId);
    const again = await stored(repeat.assistantMessageId);
    expect(again.content).toContain("already waiting");
    expect(again.evidence?.class).toBe("proposed_change");
    expect(again.evidence?.class).not.toBe("completed_action");
  });

  it("is a completed action only when the calendar really booked it, naming that booking, and the replay of the same confirmation says the same", async () => {
    // The owner has switched on booking by the employee and the employee is autonomous, so the request goes straight in: the one way a chat reply may say a booking is done.
    const priorMode = (await withSystem((db) => db.query<{ mode: string }>("select mode from agent_instances where id = $1", [agents.appointment_setter]))).rows[0].mode;
    await withSystem(async (db) => {
      await db.query("insert into appointment_settings (org_id, ai_booking_enabled) values ($1, true) on conflict (org_id) do update set ai_booking_enabled = true", [org.id]);
      await db.query("update agent_instances set mode = 'autonomous' where id = $1", [agents.appointment_setter]);
    });
    try {
      const contact = await withSystem((db) => db.query<{ id: string }>("insert into contacts (org_id, display_name, timezone) values ($1, 'Marker Booked Contact', 'UTC') returning id", [org.id]));
      const startAt = new Date(Date.now() + 4 * 86_400_000);
      startAt.setUTCHours(11, 0, 0, 0);
      const preview = await say(owner, "owner", "appointment_setter", `Book an appointment with Marker Booked Contact at ${startAt.toISOString().slice(0, 16)}Z`);
      expect((await stored(preview.assistantMessageId)).evidence).toEqual({ v: 1, class: "proposed_change" });

      const confirm = await say(owner, "owner", "appointment_setter", "confirm booking", preview.conversationId);
      const booking = (await withSystem((db) => db.query<{ id: string; status: string }>("select id, status from appointment_bookings where org_id = $1 and contact_id = $2", [org.id, contact.rows[0].id]))).rows[0];
      expect(booking.status).toBe("booked");
      const done = await stored(confirm.assistantMessageId);
      // The marker names the booking row that backs "done", not just the class.
      expect(done.evidence).toEqual({ v: 1, class: "completed_action", ledger: { kind: "appointment_booking", id: booking.id } });

      // Confirming again repeats nothing, and says what is true with the same marker.
      const repeat = await say(owner, "owner", "appointment_setter", "confirm booking", preview.conversationId);
      const again = await stored(repeat.assistantMessageId);
      expect(again.content).toContain("already submitted and the calendar confirmed it");
      expect(again.evidence).toEqual(done.evidence);
      expect((await withSystem((db) => db.query("select 1 from appointment_bookings where org_id = $1 and contact_id = $2", [org.id, contact.rows[0].id]))).rows).toHaveLength(1);
    } finally {
      await withSystem(async (db) => {
        await db.query("update appointment_settings set ai_booking_enabled = false where org_id = $1", [org.id]);
        await db.query("update agent_instances set mode = $2 where id = $1", [agents.appointment_setter, priorMode]);
      });
    }
  });

  it("is a system notice when the person may not book, and when there is no preview to confirm", async () => {
    const denied = await say(owner, "owner", "appointment_setter", "Book an appointment with Marker Booking Contact at 2030-01-01T10:00Z", null,
      (ctx) => ({ ...ctx, can: (permission: Parameters<typeof ctx.can>[0]) => permission !== "appointments.book" && ctx.can(permission) }));
    const deniedRow = await stored(denied.assistantMessageId);
    expect(deniedRow.content).toContain("needs permission");
    expect(deniedRow.evidence).toEqual({ v: 1, class: "system_notice" });

    const nothing = await say(owner, "owner", "appointment_setter", "confirm booking");
    const row = await stored(nothing.assistantMessageId);
    expect(row.content).toContain("no pending appointment preview");
    expect(row.evidence).toEqual({ v: 1, class: "system_notice" });
  });
});

describe("an appointment change", () => {
  it("is only ever a proposal in chat: the appointment changes when an owner approves it", async () => {
    const contact = await withSystem((db) => db.query<{ id: string }>("insert into contacts (org_id, display_name, timezone) values ($1, 'Marker Change Contact', 'UTC') returning id", [org.id]));
    const startAt = new Date(Date.now() + 5 * 86_400_000);
    startAt.setUTCHours(10, 0, 0, 0);
    const appointment = await withSystem((db) => db.query<{ id: string }>(
      `insert into appointment_refs (org_id, provider, calendar_ref, appointment_type_id, title, status, start_at, end_at, timezone, contact_id, booked_via, origin, created_by)
       select $1, 'native', c.id, t.id, 'Marker change appointment', 'confirmed', $3, $4, 'UTC', $5, 'staff', 'portal_staff', $6
         from crm_calendars c join crm_appointment_types t on t.org_id = c.org_id and t.calendar_id = c.id
        where c.org_id = $1 and c.slug = $2 order by t.position limit 1
       returning id`,
      [org.id, "marker-calendar", startAt.toISOString(), new Date(startAt.getTime() + 30 * 60_000).toISOString(), contact.rows[0].id, owner.id],
    ));
    const preview = await say(member, "member", "appointment_setter", `Cancel the appointment for Marker Change Contact at ${startAt.toISOString().slice(0, 16)}Z`);
    const previewRow = await stored(preview.assistantMessageId);
    expect(previewRow.content).toContain("Cancellation preview");
    expect(previewRow.evidence).toEqual({ v: 1, class: "proposed_change" });

    const confirm = await say(member, "member", "appointment_setter", "confirm appointment change", preview.conversationId);
    const approval = (await withSystem((db) => db.query<{ id: string }>("select id from approval_requests where org_id = $1 and kind = 'appointment_change' and target_id = $2", [org.id, appointment.rows[0].id]))).rows[0];
    const submitted = await stored(confirm.assistantMessageId);
    expect(submitted.content).toContain("not changed yet");
    expect(submitted.evidence).toEqual({ v: 1, class: "proposed_change", ledger: { kind: "approval", id: approval.id } });
    expect((await withSystem((db) => db.query<{ status: string }>("select status from appointment_refs where id = $1", [appointment.rows[0].id]))).rows[0].status).toBe("confirmed");
  });
});

describe("a row without a usable marker", () => {
  it("renders none: a legacy row and a damaged marker both read back as null", async () => {
    const other = await createOrg({ name: "Legacy Marker Co" });
    const person = await createUser();
    await addMember(other.id, person.id, "owner");
    const agent = await agentId(other.id, "operations_manager");
    const conversation = (await withSystem((db) => db.query<{ id: string }>(
      "insert into chat_conversations (org_id, agent_instance_id, user_id, title, hermes_session_id) values ($1, $2, $3, 'Old chat', 'iaq-legacy') returning id", [other.id, agent, person.id],
    ))).rows[0].id;
    const add = (content: string, evidence: string | null) => withSystem((db) => db.query<{ id: string }>(
      "insert into chat_messages (conversation_id, org_id, role, content, status, evidence) values ($1, $2, 'assistant', $3, 'complete', $4::jsonb) returning id",
      [conversation, other.id, content, evidence],
    ));
    const legacy = (await add("legacy", null)).rows[0].id;
    // Passes the table's own check, but is not the documented shape (an unknown key), so the strict parser refuses it.
    const damaged = (await add("damaged", JSON.stringify({ v: 1, class: "model_response", note: "extra" }))).rows[0].id;
    const good = (await add("good", JSON.stringify({ v: 1, class: "proposed_change" }))).rows[0].id;
    const convo = await getConversation(ctxFor(person, other, "owner"), conversation);
    const byId = (id: string) => convo!.messages.find((m) => m.id === id)!;
    expect(byId(legacy).evidence).toBeNull();
    expect(byId(damaged).evidence).toBeNull();
    expect(parseEvidenceMarker(byId(good).evidence)).toEqual({ v: 1, class: "proposed_change" });
  });
});

describe("across everything this workspace said", () => {
  it("never labels a server-composed reply as the model, and every model reply as one", async () => {
    const rows = (await withSystem((db) => db.query<{ role: string; run_id: string | null; status: string; evidence: EvidenceMarker | null }>(
      "select role, run_id, status, evidence from chat_messages where org_id = $1", [org.id],
    ))).rows;
    expect(rows.length).toBeGreaterThan(15);
    for (const row of rows) {
      if (row.role === "user") expect(row.evidence, "a person's own message has no marker").toBeNull();
      else {
        expect(parseEvidenceMarker(row.evidence), JSON.stringify(row)).not.toBeNull();
        if (row.role === "notice") expect(row.evidence?.class).toBe("system_notice");
        if (row.role === "assistant" && row.run_id === null) expect(row.evidence?.class, JSON.stringify(row)).not.toBe("model_response");
        if (row.role === "assistant" && row.run_id !== null) expect(row.evidence?.class).toBe("model_response");
      }
    }
    expect(rows.filter((r) => r.evidence?.class === "model_response").length).toBeGreaterThanOrEqual(2);
    // Only the one booking the calendar really made (and the replay that repeats it) may say "done", and each names a booking that is booked in this workspace.
    const completed = (await withSystem((db) => db.query<{ evidence: EvidenceMarker }>("select evidence from chat_messages where org_id = $1 and evidence ->> 'class' = 'completed_action'", [org.id]))).rows;
    expect(completed).toHaveLength(2);
    for (const row of completed) {
      expect(row.evidence.ledger?.kind).toBe("appointment_booking");
      const booked = await withSystem((db) => db.query("select 1 from appointment_bookings where id = $1 and org_id = $2 and status = 'booked'", [row.evidence.ledger?.id, org.id]));
      expect(booked.rows).toHaveLength(1);
    }
  });
});

describe("every place that writes an assistant row stamps a marker", () => {
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const files = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) files(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  };

  it("includes an evidence column in each insert of an assistant or notice message", () => {
    const sites: string[] = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, "utf8");
      let at = text.indexOf("insert into chat_messages");
      while (at !== -1) {
        const statement = text.slice(at, text.indexOf("returning", at) === -1 ? at + 500 : Math.min(text.indexOf("returning", at), at + 600));
        const writesReply = /'assistant'|'notice'/.test(statement);
        if (writesReply) {
          const relative = path.relative(SRC, file).split(path.sep).join("/");
          sites.push(relative);
          expect(statement, `${relative} writes a reply without a marker`).toMatch(/\bevidence\b/);
        }
        at = text.indexOf("insert into chat_messages", at + 10);
      }
    }
    // service.ts: the model placeholder twice, the schedule reply and the general reply; the other writers persist system notices.
    expect(sites.sort()).toEqual([
      "server/approvals/service.ts", "server/chat/service.ts", "server/chat/service.ts", "server/chat/service.ts", "server/chat/service.ts", "server/chat/workforce-handoff.ts", "server/leads/research-job.ts",
    ]);
  });
});
