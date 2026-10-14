import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { setAgentMode, setClientPause } from "@/server/automation/controls";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { parseReply, respondToConversation, respondToPending, withDisclosure, type ReplyGenerator } from "@/server/messaging/responder";
import { takeOverConversation } from "@/server/messaging/handoff";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

let m: MessagingOrg;
let mock: MockHermes;
const KEY = "k".repeat(40);

beforeAll(async () => {
  m = await messagingOrg({ name: "Responder Co" });
  mock = await startMockHermes({
    "c-responder-sales-assistant": {
      key: KEY,
      respond: (input) =>
        /custom pricing/i.test(input)
          ? { steps: [{ delta: '{"escalate":"sensitive_negotiation","summary":"Customer wants custom pricing."}' }], output: '{"escalate":"sensitive_negotiation","summary":"Customer wants custom pricing."}' }
          : { steps: [{ delta: "We have room on Thursday at 10am." }], output: "We have room on Thursday at 10am." },
    },
  });
});
afterAll(async () => {
  await mock.close();
});

const stub = (outcome: Awaited<ReturnType<ReplyGenerator>>) => {
  const calls: Array<Parameters<ReplyGenerator>[0]> = [];
  const generate: ReplyGenerator = async (ctx) => {
    calls.push(ctx);
    return outcome;
  };
  return { generate, calls };
};
const messages = async (conversationId: string) => (await withSystem((db) => db.query<{ direction: string; status: string; body: string; blocked_reason: string | null }>("select direction, status, body, blocked_reason from conversation_messages where conversation_id = $1 and direction <> 'inbound' order by created_at, id", [conversationId]))).rows;

describe("reading the model's answer", () => {
  it("accepts plain text and a valid escalation, and never lets a broken escalation reach a customer", () => {
    expect(parseReply("  We open at nine.  ")).toEqual({ kind: "reply", text: "We open at nine." });
    expect(parseReply('{"escalate":"complaint","summary":"Upset about a late visit."}')).toEqual({ kind: "escalate", category: "complaint", summary: "Upset about a late visit." });
    expect(parseReply('```json\n{"escalate":"human_requested","summary":"Wants a person."}\n```')).toMatchObject({ kind: "escalate", category: "human_requested" });
    expect(parseReply('{"escalate":"made_up","summary":"x"}')).toMatchObject({ kind: "unavailable" });
    expect(parseReply('{"escalate":"complaint"')).toMatchObject({ kind: "unavailable" });
    expect(parseReply('{"escalate":"complaint","summary":""}')).toMatchObject({ kind: "unavailable" });
    expect(parseReply("   ")).toMatchObject({ kind: "unavailable" });
  });

  it("states that it is an AI on the first AI message only, whatever the model wrote", () => {
    const d = "I'm an AI assistant for {business}.";
    expect(withDisclosure("We open at nine.", d, "Lakeside Dental", true)).toBe("I'm an AI assistant for Lakeside Dental. We open at nine.");
    expect(withDisclosure("Hi, I'm the AI assistant for Lakeside.", d, "Lakeside Dental", true)).toBe("Hi, I'm the AI assistant for Lakeside.");
    expect(withDisclosure("We open at nine.", d, "Lakeside Dental", false)).toBe("We open at nine.");
  });
});

describe("preparing a reply", () => {
  it("queues the reply through the rule chain, discloses the AI, and answers each customer message once", async () => {
    const c = await inbound(m.org.id, { body: "Do you have room Thursday?" });
    const g = stub({ kind: "reply", text: "Yes, 10am is open." });
    const first = await respondToConversation(m.org.id, c.conversationId, { generate: g.generate });
    expect(first).toMatchObject({ status: "queued" });
    expect((await messages(c.conversationId))[0]).toMatchObject({ direction: "outbound", status: "queued", body: expect.stringMatching(/^I'm an AI assistant for Responder Co\. Yes, 10am is open\.$/) });
    expect(g.calls[0]).toMatchObject({ customerMessage: "Do you have room Thursday?", history: [], channel: "sms" });
    // A webhook retry or the recovery sweep asks again: nothing more is generated or queued.
    expect(await respondToConversation(m.org.id, c.conversationId, { generate: g.generate })).toEqual({ status: "skipped", reason: "already_answered" });
    expect(g.calls).toHaveLength(1);
    expect(await messages(c.conversationId)).toHaveLength(1);
  });

  it("does not start generating when automation is stopped, a person owns the chat, or credits are gone", async () => {
    const g = stub({ kind: "reply", text: "should never be used" });
    const paused = await inbound(m.org.id);
    await setClientPause(m.ctx("manager"), { scope: "messaging", paused: true });
    expect(await respondToConversation(m.org.id, paused.conversationId, { generate: g.generate })).toEqual({ status: "skipped", reason: "messaging_paused" });
    await setClientPause(m.ctx("manager"), { scope: "messaging", paused: false });
    const owned = await inbound(m.org.id);
    await takeOverConversation(m.ctx("manager"), owned.conversationId);
    expect(await respondToConversation(m.org.id, owned.conversationId, { generate: g.generate })).toEqual({ status: "skipped", reason: "human_owner" });
    const broke = await messagingOrg({ name: "Responder Broke Co", credits: 0 });
    const b = await inbound(broke.org.id);
    expect(await respondToConversation(broke.org.id, b.conversationId, { generate: g.generate })).toEqual({ status: "skipped", reason: "credits" });
    expect(g.calls).toHaveLength(0);
  });

  it("makes a draft for approval when the employee needs approval", async () => {
    const org = await messagingOrg({ name: "Responder Approval Co", autonomous: false });
    const c = await inbound(org.org.id);
    const g = stub({ kind: "reply", text: "Happy to help." });
    expect(await respondToConversation(org.org.id, c.conversationId, { generate: g.generate })).toMatchObject({ status: "draft" });
    expect((await messages(c.conversationId))[0]).toMatchObject({ status: "draft", blocked_reason: "needs_approval" });
  });

  it("asks a person instead of answering when the model says a person must take over", async () => {
    // Not a phrase the safety net catches, so the decision really is the model's.
    const c = await inbound(m.org.id, { body: "Can we talk about custom pricing for ten units?" });
    const g = stub({ kind: "escalate", category: "sensitive_negotiation", summary: "Customer wants custom pricing for ten units." });
    const out = await respondToConversation(m.org.id, c.conversationId, { generate: g.generate });
    expect(out.status).toBe("escalated");
    expect(await messages(c.conversationId)).toHaveLength(0);
    const e = await withSystem((db) => db.query<{ category: string; status: string }>("select category, status from human_escalations where conversation_id = $1", [c.conversationId]));
    expect(e.rows[0]).toEqual({ category: "sensitive_negotiation", status: "awaiting_owner" });
  });

  it("never leaves a customer unseen when the AI employee fails: it notes the failure and asks a person", async () => {
    const c = await inbound(m.org.id);
    const out = await respondToConversation(m.org.id, c.conversationId, { generate: stub({ kind: "unavailable", reason: "Hermes did not respond in time." }).generate });
    expect(out).toEqual({ status: "unavailable", reason: "Hermes did not respond in time." });
    const note = await withSystem((db) => db.query<{ body: string; status: string }>("select body, status from conversation_messages where conversation_id = $1 and direction = 'internal'", [c.conversationId]));
    expect(note.rows[0]).toMatchObject({ status: "note", body: expect.stringContaining("Hermes did not respond in time.") });
    const e = await withSystem((db) => db.query<{ category: string }>("select category from human_escalations where conversation_id = $1", [c.conversationId]));
    expect(e.rows[0].category).toBe("unanswered_question");
    expect((await messages(c.conversationId)).filter((x) => x.direction === "outbound")).toHaveLength(0);
  });

  it("drops a generated answer if a person took over while it was being written", async () => {
    const c = await inbound(m.org.id);
    const slow: ReplyGenerator = async () => {
      await takeOverConversation(m.ctx("manager"), c.conversationId);
      return { kind: "reply", text: "Too late." };
    };
    expect(await respondToConversation(m.org.id, c.conversationId, { generate: slow })).toEqual({ status: "skipped", reason: "conversation_changed" });
    expect(await messages(c.conversationId)).toHaveLength(0);
  });

  it("answers messages that were never answered when the worker sweeps, once each", async () => {
    const org = await messagingOrg({ name: "Sweep Co" });
    const a = await inbound(org.org.id);
    const b = await inbound(org.org.id);
    const g = stub({ kind: "reply", text: "Thanks for your message." });
    const first = await respondToPending({ generate: g.generate, olderThanSeconds: 0, limit: 200 });
    expect(first.checked).toBeGreaterThanOrEqual(2);
    expect((await messages(a.conversationId)).length).toBe(1);
    expect((await messages(b.conversationId)).length).toBe(1);
    const callsAfterFirst = g.calls.length;
    await respondToPending({ generate: g.generate, olderThanSeconds: 0, limit: 200 });
    expect((await messages(a.conversationId)).length).toBe(1);
    expect(g.calls.filter((x) => x.orgId === org.org.id)).toHaveLength(g.calls.slice(0, callsAfterFirst).filter((x) => x.orgId === org.org.id).length);
  });
});

describe("through the employee's own Hermes profile", () => {
  beforeAll(async () => {
    await withSystem((db) => createConfigVersion(db, { orgId: m.org.id, agentId: m.salesAgentId, settings: defaultSettings("sales_assistant"), source: "onboarding", userId: m.people.owner.id, apply: true }));
    await connectHermesProfile({ agentId: m.salesAgentId, baseUrl: mock.url, profile: "c-responder-sales-assistant", apiKey: KEY, agencyUserId: m.superAdmin.id });
    // Only a real authenticated health check brings the employee online.
    expect(await runHealthCheck(m.salesAgentId, { userId: m.superAdmin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
    await withSystem((db) => db.query("update agent_instances set mode = 'autonomous' where id = $1", [m.salesAgentId]));
  });

  it("writes a reply with customer-facing instructions, a per-customer memory scope and the conversation history", async () => {
    const one = await inbound(m.org.id, { body: "Do you have time Thursday?" });
    const out = await respondToConversation(m.org.id, one.conversationId);
    expect(out, JSON.stringify(out)).toMatchObject({ status: "queued" });
    expect((await messages(one.conversationId))[0].body).toContain("We have room on Thursday at 10am.");
    const run = [...mock.runs.values()].find((r) => r.body.input === "Do you have time Thursday?");
    expect(String(run?.body.instructions)).toContain("You are replying to a customer");
    expect(String(run?.body.instructions)).toContain("Never invent prices");
    expect(run?.body.instructions).toContain("Agency policy");
    const keyOne = run?.headers["x-hermes-session-key"];
    expect(keyOne).toBe(`iaq:${m.org.id}:contact:${one.contactId}`);

    const two = await inbound(m.org.id, { body: "Is Friday free instead?" });
    await respondToConversation(m.org.id, two.conversationId);
    const run2 = [...mock.runs.values()].find((r) => r.body.input === "Is Friday free instead?");
    expect(run2?.headers["x-hermes-session-key"]).toBe(`iaq:${m.org.id}:contact:${two.contactId}`);
    expect(run2?.headers["x-hermes-session-key"]).not.toBe(keyOne);
  });

  it("turns the model's escalation line into an escalation, not a customer message", async () => {
    const c = await inbound(m.org.id, { body: "Can we talk about custom pricing for a big order?" });
    expect(c.escalationId).toBeNull(); // the safety net does not catch this; the model decides
    const out = await respondToConversation(m.org.id, c.conversationId);
    expect(out.status).toBe("escalated");
    expect((await messages(c.conversationId)).filter((x) => x.direction === "outbound")).toHaveLength(0);
    const e = await withSystem((db) => db.query<{ category: string }>("select category from human_escalations where conversation_id = $1", [c.conversationId]));
    expect(e.rows[0].category).toBe("sensitive_negotiation");
  });

  it("leaves an unmistakable refund request to the safety net, which has already asked a person", async () => {
    const c = await inbound(m.org.id, { body: "Please process a refund of my deposit" });
    expect(c.escalationId).toBeTruthy();
    expect(await respondToConversation(m.org.id, c.conversationId)).toEqual({ status: "skipped", reason: "escalation_pending" });
  });

  it("holds when a paused employee is the only thing in the way", async () => {
    await setAgentMode(m.ctx("manager"), { agentId: m.salesAgentId, mode: "paused" });
    const c = await inbound(m.org.id, { body: "Anyone there?" });
    expect(await respondToConversation(m.org.id, c.conversationId)).toMatchObject({ status: "skipped", reason: "agent_paused" });
    await withSystem((db) => db.query("update agent_instances set mode = 'autonomous' where id = $1", [m.salesAgentId]));
  });
});
