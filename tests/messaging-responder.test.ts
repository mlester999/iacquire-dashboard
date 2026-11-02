import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { setAgentMode, setClientPause } from "@/server/automation/controls";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { bookingReplyText, parseReply, replyClaimProblems, respondToConversation, respondToPending, restrictedTopicsFor, withDisclosure, type ReplyGenerator } from "@/server/messaging/responder";
import { takeOverConversation } from "@/server/messaging/handoff";
import { suggestReply } from "@/server/messaging/inbox-ai";
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

// ---------------------------------------------------------------------------
// Customer-facing honesty: the claims net, and the client's own "a person handles these" topics
// ---------------------------------------------------------------------------

const approve = (orgId: string, rows: Array<[string, string]>) =>
  withSystem(async (db) => {
    for (const [section, content] of rows) await db.query("insert into company_knowledge (org_id, section, content, review_status) values ($1, $2, $3, 'approved')", [orgId, section, content]);
  });
const answer = (orgId: string, questionId: string, value: unknown, over: { skipped?: boolean; needsConfirmation?: boolean } = {}) =>
  withSystem((db) =>
    db.query("insert into onboarding_answers (org_id, question_id, value, skipped, source, needs_confirmation) values ($1, $2, $3::jsonb, $4, 'user', $5)", [orgId, questionId, JSON.stringify(value), over.skipped ?? false, over.needsConfirmation ?? false]),
  );
const escalations = async (conversationId: string) =>
  (await withSystem((db) => db.query<{ category: string; status: string; summary: string }>("select category, status, summary from human_escalations where conversation_id = $1", [conversationId]))).rows;
const heldAudits = async (orgId: string) =>
  (await withSystem((db) => db.query<{ metadata: { reason: string; topic?: string; channel: string } }>("select metadata from audit_logs where org_id = $1 and action = 'messaging.reply_held' order by created_at", [orgId]))).rows.map((r) => r.metadata);
const approvalCount = async (orgId: string) => Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from approval_requests where org_id = $1", [orgId]))).rows[0].n);
const channelInbound = (orgId: string, channel: "sms" | "whatsapp" | "email", body: string) =>
  inbound(orgId, channel === "email" ? { channel, address: `buyer-${Math.random().toString(36).slice(2, 10)}@example.test`, body } : { channel, body });

describe("a reply stating something the approved knowledge does not back", () => {
  it.each(["sms", "whatsapp", "email"] as const)("is held as an escalation on %s: nothing is queued, and a person is asked", async (channel) => {
    const o = await messagingOrg({ name: `Claims Net ${channel} Co` });
    const c = await channelInbound(o.org.id, channel, "What would a gutter clean run me this week?");
    const g = stub({ kind: "reply", text: "A gutter clean is $99 this week." });
    const out = await respondToConversation(o.org.id, c.conversationId, { generate: g.generate });
    expect(out.status).toBe("escalated");
    expect(g.calls).toHaveLength(1);
    expect(await messages(c.conversationId)).toHaveLength(0);
    const [e] = await escalations(c.conversationId);
    expect(e).toMatchObject({ category: "unsafe_or_uncertain", status: "awaiting_owner" });
    // The summary is for staff: it names the AI's own amount, never the customer's words.
    expect(e.summary).toContain("$99");
    expect(e.summary).toContain("approved knowledge");
    expect(e.summary).not.toContain("gutter clean run me");
    expect(await heldAudits(o.org.id)).toEqual([{ reason: "unbacked_claim", channel }]);
  });

  it("holds an offer the business never approved ('10% off') and lets an approved one through", async () => {
    const held = await messagingOrg({ name: "Claims Net Offer Co" });
    const a = await inbound(held.org.id, { body: "Any deals right now?" });
    const out = await respondToConversation(held.org.id, a.conversationId, { generate: stub({ kind: "reply", text: "Yes, we can do 10% off this week." }).generate });
    expect(out.status).toBe("escalated");
    expect(await messages(a.conversationId)).toHaveLength(0);

    const backed = await messagingOrg({ name: "Claims Net Offer Backed Co" });
    await approve(backed.org.id, [["policies", "Spring offer: 10% off gutter cleaning until the end of May."]]);
    const b = await inbound(backed.org.id, { body: "Any deals right now?" });
    const ok = await respondToConversation(backed.org.id, b.conversationId, { generate: stub({ kind: "reply", text: "Yes, our spring offer is 10% off gutter cleaning." }).generate });
    expect(ok.status).toBe("queued");
    expect((await messages(b.conversationId))[0]).toMatchObject({ status: "queued", body: expect.stringContaining("10% off gutter cleaning") });
    expect(await heldAudits(backed.org.id)).toEqual([]);
  });

  it("lets a price through when the approved knowledge states it, and holds a different one", async () => {
    const o = await messagingOrg({ name: "Claims Net Price Co" });
    await approve(o.org.id, [["approved_pricing", "Gutter cleaning: $99. Roof inspection: free."]]);
    const same = await inbound(o.org.id, { body: "How much is a gutter clean?" });
    expect((await respondToConversation(o.org.id, same.conversationId, { generate: stub({ kind: "reply", text: "A gutter clean is $99." }).generate })).status).toBe("queued");
    const other = await inbound(o.org.id, { body: "And a roof repair?" });
    expect((await respondToConversation(o.org.id, other.conversationId, { generate: stub({ kind: "reply", text: "A roof repair is $450." }).generate })).status).toBe("escalated");
    expect(await messages(other.conversationId)).toHaveLength(0);
  });

  it("never uses another workspace's knowledge to back a claim", async () => {
    const mine = await messagingOrg({ name: "Claims Net Mine Co" });
    const theirs = await messagingOrg({ name: "Claims Net Theirs Co" });
    await approve(theirs.org.id, [["approved_pricing", "Gutter cleaning: $99."]]);
    const c = await inbound(mine.org.id, { body: "How much is a gutter clean?" });
    expect((await respondToConversation(mine.org.id, c.conversationId, { generate: stub({ kind: "reply", text: "A gutter clean is $99." }).generate })).status).toBe("escalated");
    expect(await replyClaimProblems(mine.org.id, "A gutter clean is $99.", "")).toHaveLength(1);
    expect(await replyClaimProblems(theirs.org.id, "A gutter clean is $99.", "")).toEqual([]);
  });

  it("stays inside the approval policy: an employee that needs approval leaves no draft and no approval request for a held reply", async () => {
    const o = await messagingOrg({ name: "Claims Net Approval Co", autonomous: false });
    const c = await inbound(o.org.id, { body: "How much?" });
    const before = await approvalCount(o.org.id);
    expect((await respondToConversation(o.org.id, c.conversationId, { generate: stub({ kind: "reply", text: "It is $75 today only." }).generate })).status).toBe("escalated");
    expect(await messages(c.conversationId)).toHaveLength(0);
    expect(await approvalCount(o.org.id)).toBe(before);
    // The same employee, with a reply that stays inside the knowledge, still only drafts.
    const fine = await inbound(o.org.id, { body: "Are you open Saturday?" });
    expect(await respondToConversation(o.org.id, fine.conversationId, { generate: stub({ kind: "reply", text: "Let me check with the team." }).generate })).toMatchObject({ status: "draft" });
  });

  it("leaves a reply with nothing to check alone", async () => {
    const o = await messagingOrg({ name: "Claims Net Untouched Co" });
    const c = await inbound(o.org.id, { body: "Hello?" });
    expect((await respondToConversation(o.org.id, c.conversationId, { generate: stub({ kind: "reply", text: "Hello! How can I help?" }).generate })).status).toBe("queued");
    expect(await heldAudits(o.org.id)).toEqual([]);
  });
});

describe("the client's own 'a person handles these' answers", () => {
  it("send a customer asking about a picked topic to a person BEFORE the model is called", async () => {
    const o = await messagingOrg({ name: "Topic Refunds Co" });
    await answer(o.org.id, "c.sensitive_topics", ["refunds", "legal"]);
    const c = await inbound(o.org.id, { body: "You charged twice for my SECRETWORD visit" });
    expect(c.escalationId).toBeNull(); // the blunt ingest net does not catch this phrasing; the client's answer does
    const g = stub({ kind: "reply", text: "should never be written" });
    const out = await respondToConversation(o.org.id, c.conversationId, { generate: g.generate });
    expect(out.status).toBe("escalated");
    expect(g.calls).toHaveLength(0); // no model call, no cost
    expect(await messages(c.conversationId)).toHaveLength(0);
    const [e] = await escalations(c.conversationId);
    expect(e).toMatchObject({ category: "refund_concern", status: "awaiting_owner" });
    expect(e.summary).toContain("refunds and billing disputes");
    expect(e.summary).not.toContain("SECRETWORD");
    expect(await heldAudits(o.org.id)).toEqual([{ reason: "restricted_topic", topic: "refunds", channel: "sms" }]);
    // Asked again (a webhook retry): the open escalation holds it, still no model call.
    expect(await respondToConversation(o.org.id, c.conversationId, { generate: g.generate })).toEqual({ status: "skipped", reason: "escalation_pending" });
    expect(g.calls).toHaveLength(0);
  });

  it("make 'May your AI share prices? No' a real rule: pricing goes to a person, and a client who allows prices is answered", async () => {
    const never = await messagingOrg({ name: "Topic Pricing Never Co" });
    await answer(never.org.id, "d.pricing_policy", "never");
    const a = await inbound(never.org.id, { body: "What is the price for a full roof?" });
    const g = stub({ kind: "reply", text: "unused" });
    expect((await respondToConversation(never.org.id, a.conversationId, { generate: g.generate })).status).toBe("escalated");
    expect(g.calls).toHaveLength(0);
    expect((await escalations(a.conversationId))[0].category).toBe("sensitive_negotiation");

    const exact = await messagingOrg({ name: "Topic Pricing Exact Co" });
    await answer(exact.org.id, "d.pricing_policy", "exact");
    await approve(exact.org.id, [["approved_pricing", "Full roof: $9000."]]);
    const b = await inbound(exact.org.id, { body: "What is the price for a full roof?" });
    const g2 = stub({ kind: "reply", text: "A full roof is $9000." });
    expect((await respondToConversation(exact.org.id, b.conversationId, { generate: g2.generate })).status).toBe("queued");
    expect(g2.calls).toHaveLength(1);
  });

  it("apply only to the topics that were picked", async () => {
    const o = await messagingOrg({ name: "Topic Unpicked Co" });
    await answer(o.org.id, "c.sensitive_topics", ["legal"]);
    const c = await inbound(o.org.id, { body: "How much is a gutter clean?" });
    const g = stub({ kind: "reply", text: "Let me check with the team." });
    expect((await respondToConversation(o.org.id, c.conversationId, { generate: g.generate })).status).toBe("queued");
    expect(g.calls).toHaveLength(1);
  });

  it("are the client's decision only once confirmed: a skipped answer, or one still waiting for confirmation, restricts nothing", async () => {
    const o = await messagingOrg({ name: "Topic Unconfirmed Co" });
    await answer(o.org.id, "c.sensitive_topics", ["pricing"], { needsConfirmation: true });
    await answer(o.org.id, "d.pricing_policy", "never", { skipped: true });
    expect(await withSystem((db) => restrictedTopicsFor(db, o.org.id))).toEqual([]);
    const c = await inbound(o.org.id, { body: "How much is a gutter clean?" });
    const g = stub({ kind: "reply", text: "Let me check with the team." });
    expect((await respondToConversation(o.org.id, c.conversationId, { generate: g.generate })).status).toBe("queued");
    expect(g.calls).toHaveLength(1);
  });

  it("never cross workspaces: one client's topics do not apply to another, whose own answers are read for it", async () => {
    const strict = await messagingOrg({ name: "Topic Strict Co" });
    const relaxed = await messagingOrg({ name: "Topic Relaxed Co" });
    await answer(strict.org.id, "c.sensitive_topics", ["pricing", "warranty"]);
    await answer(relaxed.org.id, "c.sensitive_topics", ["medical"]);
    expect(await withSystem((db) => restrictedTopicsFor(db, strict.org.id))).toEqual(["pricing", "warranty"]);
    expect(await withSystem((db) => restrictedTopicsFor(db, relaxed.org.id))).toEqual(["medical"]);
    const c = await inbound(relaxed.org.id, { body: "How much is a gutter clean? Is it under warranty?" });
    const g = stub({ kind: "reply", text: "Let me check with the team." });
    expect((await respondToConversation(relaxed.org.id, c.conversationId, { generate: g.generate })).status).toBe("queued");
    expect(g.calls).toHaveLength(1);
    const s = await inbound(strict.org.id, { body: "How much is a gutter clean? Is it under warranty?" });
    expect((await respondToConversation(strict.org.id, s.conversationId, { generate: g.generate })).status).toBe("escalated");
    expect(g.calls).toHaveLength(1); // the strict client's message never reached the model
  });

  it("stay inside the approval policy: an employee that needs approval leaves no draft and no approval request", async () => {
    const o = await messagingOrg({ name: "Topic Approval Co", autonomous: false });
    await answer(o.org.id, "c.sensitive_topics", ["warranty"]);
    const c = await inbound(o.org.id, { body: "Is the roof work under warranty?" });
    const before = await approvalCount(o.org.id);
    const g = stub({ kind: "reply", text: "unused" });
    expect((await respondToConversation(o.org.id, c.conversationId, { generate: g.generate })).status).toBe("escalated");
    expect(await messages(c.conversationId)).toHaveLength(0);
    expect(await approvalCount(o.org.id)).toBe(before);
    expect(g.calls).toHaveLength(0);
  });
});

describe("what a customer is told after the employee asks to book", () => {
  it("never says 'booked' for a booking that still waits for a person to confirm it", () => {
    const waiting = bookingReplyText({ status: "booked", bookingId: "b", appointmentId: "a", appointmentStatus: "new" }, "Tue 10:00");
    expect(waiting).toContain("We've reserved Tue 10:00 for you. The team will confirm it shortly");
    expect(waiting).not.toMatch(/booked|confirmed/i);
    expect(bookingReplyText({ status: "booked", bookingId: "b", appointmentId: "a", appointmentStatus: "confirmed" }, "Tue 10:00")).toBe("You're booked for Tue 10:00.");
    expect(bookingReplyText({ status: "booked", bookingId: "b", appointmentId: "a" }, "Tue 10:00")).toBe("You're booked for Tue 10:00.");
  });
});

describe("a draft the AI suggests inside the inbox", () => {
  const fake = (text: string) => ({ complete: async () => ({ ok: true as const, text }) });

  it("is annotated, not blocked, when it states an amount or offer the approved knowledge does not back", async () => {
    const o = await messagingOrg({ name: "Inbox Draft Claims Co" });
    const c = await inbound(o.org.id, { name: "Carla Reyes", body: "What does the heat pump install cost?" });
    const out = await suggestReply(o.ctx("manager"), c.conversationId, fake("Hi Carla, the install is $2,400 and we are running 15% off this week."));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Still a draft the person can edit and send: the text is untouched.
    expect(out.data.text).toContain("$2,400");
    expect(out.data.warnings.join(" ")).toMatch(/amount \(\$2,400\)/);
    expect(out.data.warnings.join(" ")).toMatch(/15%/);
    expect(out.data.warnings.every((w) => w.length > 10)).toBe(true);
  });

  it("carries no such warning when the approved knowledge states the amount, and never uses another workspace's knowledge", async () => {
    const backed = await messagingOrg({ name: "Inbox Draft Backed Co" });
    await approve(backed.org.id, [["approved_pricing", "Heat pump install: $2,400."]]);
    const a = await inbound(backed.org.id, { body: "What does the heat pump install cost?" });
    const ok = await suggestReply(backed.ctx("manager"), a.conversationId, fake("Hi, the heat pump install is $2,400."));
    expect(ok.ok && ok.data.warnings.filter((w) => /approved company knowledge/.test(w))).toEqual([]);

    const other = await messagingOrg({ name: "Inbox Draft Other Co" });
    const b = await inbound(other.org.id, { body: "What does the heat pump install cost?" });
    const held = await suggestReply(other.ctx("manager"), b.conversationId, fake("Hi, the heat pump install is $2,400."));
    expect(held.ok && held.data.warnings.join(" ")).toMatch(/amount \(\$2,400\)/);
  });

  it("repeats the customer's own contact detail without a warning, and sends nothing", async () => {
    const o = await messagingOrg({ name: "Inbox Draft Own Detail Co" });
    const c = await inbound(o.org.id, { body: "Please email me at carla.reyes@example.test about the quote" });
    const before = (await messages2(o.org.id));
    const out = await suggestReply(o.ctx("manager"), c.conversationId, fake("Thanks, we will email you at carla.reyes@example.test."));
    expect(out.ok && out.data.warnings.filter((w) => /approved company knowledge/.test(w))).toEqual([]);
    expect(await messages2(o.org.id)).toBe(before);
  });
});

async function messages2(orgId: string) {
  return Number((await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1 and direction <> 'inbound'", [orgId]))).rows[0].n);
}
