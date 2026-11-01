// Two guards on what a chat reply may be. (1) "Regenerate" asks the model again, so it is allowed only for a reply a model wrote (it has a run) and it re-runs the same deterministic
// guards a new message goes through: a refusal or a preview starts no run and the model is never called. (2) A client employee's model reply that says an action was done
// ("I've booked Jane for 2pm") gets a plain correction line, a flagged marker and one audit row naming only the kind of claim. The Hermes server is a local stand-in, so this
// proves the plumbing, the stored rows and the audit, not any model's behaviour.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import type { AgentRoleKey } from "@/lib/agents";
import { ACTION_CLAIM_CORRECTION } from "@/lib/action-claims";
import { parseEvidenceMarker, type EvidenceMarker } from "@/lib/evidence-class";
import { sendChatMessage } from "@/server/chat/service";
import { subscribe, type ChatStreamEvent } from "@/server/chat/hub";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { loadCapabilityActivity } from "@/server/workforce/capability-status";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "r".repeat(40);
const ROLES: readonly AgentRoleKey[] = ["operations_manager", "sales_assistant", "appointment_setter"];
const PROFILE = Object.fromEntries(ROLES.map((role) => [role, `c-regen-${role.replaceAll("_", "-")}`])) as Record<AgentRoleKey, string>;
const PLAIN = "What operational tasks or issues currently need attention?";
const PLAIN_SALES = "What can you help me with this week?";

/** What the stand-in model says, chosen by a tag in the question, so each test controls the reply without touching the guards. */
const SAID: Record<string, string> = {
  "[claims-booking]": "I've booked Jane Cruz for 2pm tomorrow and emailed her the details.",
  "[claims-negated]": "I haven't booked anything yet, and I can't send messages from this chat.",
  "[claims-plain]": "Your open items are the two overdue tasks and one approval waiting for a decision.",
  "[claims-failed]": "I've booked Jane Cruz for 2pm tomorrow.",
};
const respond = (input: string) => {
  const tag = Object.keys(SAID).find((key) => input.includes(key));
  const text = tag ? SAID[tag] : `Here is what I can see from your workspace. (${input.slice(0, 40)})`;
  // A run that says it booked something and then fails: its partial text is not a finished reply.
  if (tag === "[claims-failed]") return { steps: [{ delta: text }, { fail: "run_failed" }], output: text };
  return { steps: [{ delta: text }], output: text };
};

let mock: MockHermes;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;
const agents = {} as Record<AgentRoleKey, string>;

interface StoredMessage { id: string; role: string; content: string; status: string; run_id: string | null; evidence: EvidenceMarker | null }
const stored = async (id: string) => (await withSystem((db) => db.query<StoredMessage>("select id, role, content, status, run_id, evidence from chat_messages where id = $1 and org_id = $2", [id, org.id]))).rows[0];
const runCount = async () => Number((await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from agent_runs where org_id = $1", [org.id]))).rows[0].n);
const modelRequests = () => mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/runs").length;

async function say(role: AgentRoleKey, content: string, conversationId?: string | null) {
  await withSystem((db) => db.query("delete from rate_limit_buckets where bucket_key = $1", [`${RATE_LIMITS.agentMessageByUser.name}:${owner.id}`]));
  return sendChatMessage(ctxFor(owner, org, "owner"), { agentRole: role, content, conversationId: conversationId ?? undefined, clientMessageId: crypto.randomUUID() });
}
async function regenerate(role: AgentRoleKey, messageId: string) {
  await withSystem((db) => db.query("delete from rate_limit_buckets where bucket_key = $1", [`${RATE_LIMITS.agentMessageByUser.name}:${owner.id}`]));
  return sendChatMessage(ctxFor(owner, org, "owner"), { agentRole: role, regenerateMessageId: messageId, clientMessageId: crypto.randomUUID() });
}
async function finished(id: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await stored(id);
    if (row && row.status !== "streaming") return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("assistant message did not finish");
}
async function jobSettled(jobId: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where id = $1 and org_id = $2", [jobId, org.id]));
    if (rows[0] && ["completed", "blocked", "failed", "cancelled"].includes(rows[0].status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("work job did not settle");
}
const claimAudits = async (runId: string) => (await withSystem((db) => db.query<{ metadata: Record<string, unknown>; result: string; agent_instance_id: string }>(
  "select metadata, result, agent_instance_id from audit_logs where org_id = $1 and action = 'workforce.chat_unbacked_claim' and target_id = $2", [org.id, runId],
))).rows;

beforeAll(async () => {
  mock = await startMockHermes(Object.fromEntries(ROLES.map((role) => [PROFILE[role], { key: KEY, respond }])));
  org = await createOrg({ name: "Regenerate Guards Co" });
  owner = await createUser({ name: "Guard Owner" });
  admin = await createUser({ platformRole: "agency_super_admin", name: "Test Workforce Admin" });
  await addMember(org.id, owner.id, "owner");
  for (const role of ROLES) {
    const id = await agentId(org.id, role);
    agents[role] = id;
    await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: owner.id, apply: true }));
    await connectHermesProfile({ agentId: id, baseUrl: mock.url, profile: PROFILE[role], apiKey: KEY, agencyUserId: admin.id });
    expect(await runHealthCheck(id, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  }
  await withSystem(async (db) => {
    const calendar = await db.query<{ id: string }>(
      "insert into crm_calendars (org_id, name, slug, is_default, public, created_by) values ($1, 'Guard Calendar', 'guard-calendar', true, true, $2) returning id",
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
    await db.query("insert into contacts (org_id, display_name, timezone) values ($1, 'Guard Booking Contact', 'UTC')", [org.id]);
  });
}, 120_000);

afterAll(async () => {
  await mock.close();
});

describe("Regenerate", () => {
  it("still works on a reply a model wrote: a new run answers and the old reply is superseded", async () => {
    const first = await say("operations_manager", PLAIN);
    const original = await finished(first.assistantMessageId);
    expect(original.run_id).toBe(first.runId);
    const runsBefore = await runCount();
    const requestsBefore = modelRequests();

    const again = await regenerate("operations_manager", first.assistantMessageId);
    expect(again.runId).toEqual(expect.any(String));
    expect(again.runId).not.toBe(first.runId);
    const answered = await finished(again.assistantMessageId);
    expect(answered).toMatchObject({ role: "assistant", status: "complete", run_id: again.runId });
    expect(answered.evidence?.class).toBe("model_response");
    expect((await stored(first.assistantMessageId)).status).toBe("superseded");
    expect(await runCount()).toBe(runsBefore + 1);
    expect(modelRequests()).toBe(requestsBefore + 1);
  });

  it("answers again for a failed reply and a cancelled one ('Try again'), and supersedes the old row", async () => {
    const failedSend = await say("operations_manager", `${PLAIN} [claims-failed]`);
    const failedReply = await finished(failedSend.assistantMessageId);
    expect(failedReply).toMatchObject({ status: "failed", run_id: failedSend.runId });
    const retried = await regenerate("operations_manager", failedSend.assistantMessageId);
    expect(retried.runId).toEqual(expect.any(String));
    expect(retried.runId).not.toBe(failedSend.runId);
    await finished(retried.assistantMessageId);
    expect((await stored(failedSend.assistantMessageId)).status).toBe("superseded");

    const cancelledSend = await say("operations_manager", PLAIN);
    await finished(cancelledSend.assistantMessageId);
    await withSystem((db) => db.query("update chat_messages set status = 'cancelled' where id = $1", [cancelledSend.assistantMessageId]));
    const requestsBefore = modelRequests();
    const again = await regenerate("operations_manager", cancelledSend.assistantMessageId);
    expect(again.runId).not.toBe(cancelledSend.runId);
    expect(await finished(again.assistantMessageId)).toMatchObject({ role: "assistant", status: "complete", run_id: again.runId });
    expect((await stored(cancelledSend.assistantMessageId)).status).toBe("superseded");
    expect(modelRequests()).toBe(requestsBefore + 1);
  });

  it("refuses a refusal row: no run starts, the model is never called, and the refusal stays as it was", async () => {
    const sent = await say("sales_assistant", "Send an email to these prospects about our offer");
    const refusal = await stored(sent.assistantMessageId);
    expect(refusal).toMatchObject({ run_id: null, status: "complete", evidence: { class: "system_notice" } });
    const runsBefore = await runCount();
    const requestsBefore = modelRequests();

    await expect(regenerate("sales_assistant", sent.assistantMessageId)).rejects.toThrow(/can't be regenerated/);
    expect(await runCount()).toBe(runsBefore);
    expect(modelRequests()).toBe(requestsBefore);
    expect(await stored(sent.assistantMessageId)).toEqual(refusal);
  });

  it("refuses a schedule preview row, and the pending preview survives", async () => {
    const preview = await say("operations_manager", "Review unresolved operational tasks every weekday at 9 AM");
    const row = await stored(preview.assistantMessageId);
    expect(row.content).toContain("Schedule preview");
    expect(row).toMatchObject({ run_id: null, evidence: { class: "proposed_change" } });
    const runsBefore = await runCount();
    const requestsBefore = modelRequests();

    await expect(regenerate("operations_manager", preview.assistantMessageId)).rejects.toThrow(/can't be regenerated/);
    expect(await runCount()).toBe(runsBefore);
    expect(modelRequests()).toBe(requestsBefore);
    expect((await stored(preview.assistantMessageId)).status).toBe("complete");

    // The preview can still be confirmed: asking again did not hide or break it.
    const confirm = await say("operations_manager", "confirm schedule", preview.conversationId);
    expect((await stored(confirm.assistantMessageId)).content).toContain("Saved");
  });

  it("refuses a booking preview row", async () => {
    const startAt = new Date(Date.now() + 3 * 86_400_000);
    startAt.setUTCHours(10, 0, 0, 0);
    const preview = await say("appointment_setter", `Book an appointment with Guard Booking Contact at ${startAt.toISOString().slice(0, 16)}Z`);
    const row = await stored(preview.assistantMessageId);
    expect(row.content).toContain("Appointment preview");
    expect(row.run_id).toBeNull();
    const runsBefore = await runCount();
    const requestsBefore = modelRequests();
    await expect(regenerate("appointment_setter", preview.assistantMessageId)).rejects.toThrow(/can't be regenerated/);
    expect(await runCount()).toBe(runsBefore);
    expect(modelRequests()).toBe(requestsBefore);
    expect((await stored(preview.assistantMessageId)).status).toBe("complete");
  });

  it("refuses a job acknowledgement and a message that is still streaming or already superseded", async () => {
    const job = await say("operations_manager", "Review our current operations, identify blocked work and tell me what needs my attention");
    expect(job.runId).toBeNull();
    await expect(regenerate("operations_manager", job.assistantMessageId)).rejects.toThrow(/can't be regenerated/);
    await jobSettled(job.jobId!);

    const model = await say("operations_manager", PLAIN);
    await finished(model.assistantMessageId);
    await withSystem((db) => db.query("update chat_messages set status = 'superseded' where id = $1", [model.assistantMessageId]));
    await expect(regenerate("operations_manager", model.assistantMessageId)).rejects.toThrow(/can't be regenerated/);
    await withSystem((db) => db.query("update chat_messages set status = 'streaming' where id = $1", [model.assistantMessageId]));
    await expect(regenerate("operations_manager", model.assistantMessageId)).rejects.toThrow(/can't be regenerated/);
  });

  it("does not reach into another workspace: a message id of someone else's chat is not found", async () => {
    const other = await createOrg({ name: "Other Regenerate Co" });
    const otherAgent = await agentId(other.id, "operations_manager");
    const person = await createUser();
    const foreign = await withSystem(async (db) => {
      const conversation = await db.query<{ id: string }>("insert into chat_conversations (org_id, agent_instance_id, user_id, hermes_session_id) values ($1, $2, $3, $4) returning id", [other.id, otherAgent, person.id, `s-${crypto.randomUUID()}`]);
      const run = await db.query<{ id: string }>("insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, conversation_id) values ($1, $2, $3, 'chat', $4, 'completed', $5) returning id", [other.id, otherAgent, person.id, `foreign-${crypto.randomUUID()}`, conversation.rows[0].id]);
      await db.query("insert into chat_messages (conversation_id, org_id, role, content, status) values ($1, $2, 'user', 'Hello', 'complete')", [conversation.rows[0].id, other.id]);
      const message = await db.query<{ id: string }>("insert into chat_messages (conversation_id, org_id, role, content, status, run_id) values ($1, $2, 'assistant', 'Hi', 'complete', $3) returning id", [conversation.rows[0].id, other.id, run.rows[0].id]);
      return message.rows[0].id;
    });
    const runsBefore = await runCount();
    await expect(regenerate("operations_manager", foreign)).rejects.toThrow(/can't be regenerated/);
    expect(await runCount()).toBe(runsBefore);
  });

  it("re-runs the guards: a model reply whose question a reviewed step now owns starts no run and is not superseded", async () => {
    const first = await say("sales_assistant", PLAIN_SALES);
    const reply = await finished(first.assistantMessageId);
    // The question as stored is now one the refusal guard handles (as if the rule had been added after the reply was written).
    await withSystem((db) => db.query("update chat_messages set content = 'Send an email to these prospects about our offer' where id = $1 and org_id = $2", [first.userMessageId, org.id]));
    const runsBefore = await runCount();
    const requestsBefore = modelRequests();

    const result = await regenerate("sales_assistant", first.assistantMessageId);
    expect(result).toMatchObject({ runId: null, jobId: null, userMessageId: null });
    const notice = await stored(result.assistantMessageId);
    expect(notice.content).toBe("That request is handled by a reviewed step. Send it again as a new message.");
    expect(notice).toMatchObject({ run_id: null, status: "complete", evidence: { v: 1, class: "system_notice" } });
    expect(await runCount()).toBe(runsBefore);
    expect(modelRequests()).toBe(requestsBefore);
    expect(await stored(first.assistantMessageId)).toEqual(reply);
  });
});

describe("a model reply that claims an action", () => {
  it("gets the correction line, a flagged marker and one audit row with the kinds of claim and no text", async () => {
    const sent = await say("operations_manager", `${PLAIN} [claims-booking]`);
    const message = await finished(sent.assistantMessageId);
    expect(message.status).toBe("complete");
    // The model's own words are kept, and the line that says what is true follows them.
    expect(message.content).toContain("I've booked Jane Cruz for 2pm tomorrow");
    expect(message.content.endsWith(ACTION_CLAIM_CORRECTION)).toBe(true);
    expect(message.content.split(ACTION_CLAIM_CORRECTION)).toHaveLength(2);

    const marker = parseEvidenceMarker(message.evidence);
    expect(marker).toMatchObject({ class: "model_response", claims: "unbacked_action_claim" });
    // The records that were handed to the model are still on the marker: flagging a claim does not erase what was read.
    expect(marker?.records?.areas.length).toBeGreaterThan(0);

    const audits = await claimAudits(sent.runId!);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ result: "denied", agent_instance_id: agents.operations_manager });
    expect(audits[0].metadata).toMatchObject({ role: "operations_manager", messageId: sent.assistantMessageId, categories: ["book", "send"] });
    expect(JSON.stringify(audits[0].metadata)).not.toMatch(/Jane|Cruz|2pm|booked|emailed/);
  });

  it("sends the correction in the finished event the open chat receives", async () => {
    const sent = await say("operations_manager", `${PLAIN} [claims-booking]`);
    await finished(sent.assistantMessageId);
    const events: ChatStreamEvent[] = [];
    expect(subscribe(sent.runId!, owner.id, (event) => events.push(event))).not.toBeNull();
    const done = events.find((event) => event.type === "done");
    expect(done && done.type === "done" ? done.content : "").toContain(ACTION_CLAIM_CORRECTION);
  });

  it("leaves a plain answer and a negated one alone: no line, no flag, no audit row", async () => {
    for (const tag of ["[claims-plain]", "[claims-negated]"]) {
      const sent = await say("operations_manager", `${PLAIN} ${tag}`);
      const message = await finished(sent.assistantMessageId);
      expect(message.content, tag).toBe(SAID[tag]);
      const marker = parseEvidenceMarker(message.evidence);
      expect(marker?.class, tag).toBe("model_response");
      expect(marker?.claims, tag).toBeUndefined();
      expect(await claimAudits(sent.runId!), tag).toHaveLength(0);
    }
  });

  it("does not flag a reply that failed: only a finished reply is checked", async () => {
    const sent = await say("operations_manager", `${PLAIN} [claims-failed]`);
    const message = await finished(sent.assistantMessageId);
    expect(message.status).toBe("failed");
    expect(message.content).not.toContain(ACTION_CLAIM_CORRECTION);
    expect(parseEvidenceMarker(message.evidence)?.claims).toBeUndefined();
    expect(await claimAudits(sent.runId!)).toHaveLength(0);
  });
});

describe("the evidence read is tied to the run, the reply and the configuration version", () => {
  it("writes workforce.employee_evidence_attached for the run, with the areas and states and no record content", async () => {
    const sent = await say("operations_manager", PLAIN);
    const message = await finished(sent.assistantMessageId);
    const { rows } = await withSystem((db) => db.query<{ target_type: string; target_id: string; result: string; agent_instance_id: string; metadata: Record<string, unknown> }>(
      "select target_type, target_id, result, agent_instance_id, metadata from audit_logs where org_id = $1 and action = 'workforce.employee_evidence_attached' and target_id = $2", [org.id, sent.runId],
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_type: "agent_run", target_id: sent.runId, result: "success", agent_instance_id: agents.operations_manager });
    const run = (await withSystem((db) => db.query<{ config_version_id: string }>("select config_version_id from agent_runs where id = $1", [sent.runId]))).rows[0];
    expect(rows[0].metadata).toMatchObject({ role: "operations_manager", messageId: sent.assistantMessageId, configVersionId: run.config_version_id });
    // The same area names and states the reply's marker lists as read.
    const sections = rows[0].metadata.sections as Record<string, string>;
    for (const area of message.evidence?.records?.areas ?? []) expect(sections[area.id]).toBe(area.state);
    expect(JSON.stringify(rows[0].metadata)).not.toMatch(/Guard Booking Contact/);
  });

  it("is preferred by the capability status over a newer plain read, and only when its run completed", async () => {
    const lonely = await createOrg({ name: "Attached Evidence Co" });
    const agent = await agentId(lonely.id, "crm_manager");
    const person = await createUser();
    const at = (iso: string, action: string, targetType: string, targetId: string | null, result: string, sections: Record<string, string>) => withSystem((db) => db.query(
      "insert into audit_logs (org_id, actor_kind, agent_instance_id, action, target_type, target_id, result, metadata, created_at) values ($1, 'agent', $2, $3, $4, $5, $6, $7, $8)",
      [lonely.id, agent, action, targetType, targetId, result, JSON.stringify({ role: "crm_manager", sections }), iso],
    ));
    const run = async (status: string) => withSystem(async (db) => {
      const conversation = await db.query<{ id: string }>("insert into chat_conversations (org_id, agent_instance_id, user_id, hermes_session_id) values ($1, $2, $3, $4) returning id", [lonely.id, agent, person.id, `s-${crypto.randomUUID()}`]);
      return (await db.query<{ id: string }>("insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, conversation_id) values ($1, $2, $3, 'chat', $4, $5, $6) returning id", [lonely.id, agent, person.id, `a-${crypto.randomUUID()}`, status, conversation.rows[0].id])).rows[0].id;
    });
    const completed = await run("completed");
    const failed = await run("failed");
    await at("2026-10-27T10:00:00Z", "workforce.employee_evidence_attached", "agent_run", completed, "success", { crm: "ready" });
    // Newer and attached, but its run failed: not proof, so it is skipped.
    await at("2026-10-28T08:00:00Z", "workforce.employee_evidence_attached", "agent_run", failed, "success", { crm: "ready" });
    // Newer plain read that could not read the CRM: the attached row still wins.
    await at("2026-10-28T09:00:00Z", "workforce.employee_evidence_read", "workspace_evidence", lonely.id, "failure", { crm: "unavailable" });
    const preferred = await loadCapabilityActivity(lonely.id, [agent]);
    expect(preferred.get(agent)!.lastEvidenceRead).toMatchObject({ at: "2026-10-27T10:00:00.000Z", ok: true, unavailableAreas: [] });

    // With no attached row at all, the plain read is used as before.
    const bare = await createOrg({ name: "Plain Read Only Co" });
    const bareAgent = await agentId(bare.id, "crm_manager");
    await withSystem((db) => db.query(
      "insert into audit_logs (org_id, actor_kind, agent_instance_id, action, target_type, result, metadata, created_at) values ($1, 'agent', $2, 'workforce.employee_evidence_read', 'workspace_evidence', 'failure', $3, '2026-10-28T09:00:00Z')",
      [bare.id, bareAgent, JSON.stringify({ role: "crm_manager", sections: { crm: "unavailable" } })],
    ));
    expect((await loadCapabilityActivity(bare.id, [bareAgent])).get(bareAgent)!.lastEvidenceRead).toMatchObject({ ok: false, unavailableAreas: ["crm"] });

    // An attached row of another workspace's run is never counted.
    const stranger = await createOrg({ name: "Stranger Attached Co" });
    const strangerAgent = await agentId(stranger.id, "crm_manager");
    await withSystem((db) => db.query(
      "insert into audit_logs (org_id, actor_kind, agent_instance_id, action, target_type, target_id, result, metadata) values ($1, 'agent', $2, 'workforce.employee_evidence_attached', 'agent_run', $3, 'success', $4)",
      [stranger.id, strangerAgent, completed, JSON.stringify({ role: "crm_manager", sections: { crm: "ready" } })],
    ));
    expect((await loadCapabilityActivity(stranger.id, [strangerAgent])).get(strangerAgent)!.lastEvidenceRead).toBeNull();
  });
});
