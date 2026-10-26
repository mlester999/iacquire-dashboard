// An AI reply to a customer used to start a model run and write no usage row: invisible to the workspace's usage, to fair use and to /admin/usage, and capped by nothing but the credit
// balance. Now each prepared reply is recorded (with the model's token counts when it reports them), a failed run is recorded as a failed run, and the agency may set an optional
// monthly cap that stops further model calls and asks a person to answer. No cap is set unless someone sets one. Embedded Postgres; the reply generator is a stub.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { respondToConversation, type ReplyGenerator } from "@/server/messaging/responder";
import { takeOverConversation } from "@/server/messaging/handoff";
import { customerReplyCapReached, getLimits, usageSummary } from "@/server/usage";
import { measureOrg } from "@/server/fairuse/service";
import { updateUsageLimits } from "@/server/admin/tenants";
import { listUsageByTenant } from "@/server/admin/queries";
import { agencyUser, createUser } from "./support/fixtures";
import { inbound, messagingOrg } from "./support/messaging";
import { splitStatements } from "./support/staff-messages";

const stub = (outcome: Awaited<ReturnType<ReplyGenerator>>) => {
  const calls: unknown[] = [];
  const generate: ReplyGenerator = async (ctx) => {
    calls.push(ctx);
    return outcome;
  };
  return { generate, calls };
};
const usage = (orgId: string, kind: string) =>
  withSystem((db) => db.query<{ quantity: number; input_tokens: number | null; output_tokens: number | null }>("select quantity, input_tokens, output_tokens from usage_events where org_id = $1 and kind = $2 order by id", [orgId, kind])).then((r) => r.rows);
const setCap = (orgId: string, cap: number | null, hardStop = true) =>
  withSystem((db) => db.query("insert into usage_limits (org_id, monthly_customer_replies, hard_stop) values ($1, $2, $3) on conflict (org_id) do update set monthly_customer_replies = $2, hard_stop = $3", [orgId, cap, hardStop]));

describe("recording what a reply cost", () => {
  it("records one customer reply with the model's token counts, and shows it in usage, fair use and the agency's usage list", async () => {
    const m = await messagingOrg({ name: "Reply Usage Co" });
    const c = await inbound(m.org.id, { body: "Do you have room Thursday?" });
    const g = stub({ kind: "reply", text: "Yes, 10am is open.", usage: { inputTokens: 120, outputTokens: 40 } });
    expect(await respondToConversation(m.org.id, c.conversationId, { generate: g.generate })).toMatchObject({ status: "queued" });
    expect(await usage(m.org.id, "customer_reply")).toEqual([{ quantity: 1, input_tokens: 120, output_tokens: 40 }]);

    const s = await withSystem((db) => usageSummary(db, m.org.id));
    expect(s.customerReplies).toBe(1);
    expect(s.tokens).toBe(160);
    expect(s.limits.monthly_customer_replies).toBeNull();
    // Fair use counts it among the AI runs of the last 30 days.
    expect((await withSystem((db) => measureOrg(db, m.org.id))).ai_runs_30d).toBe(1);
    // The agency's per-client list carries the number.
    const viewer = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const row = (await listUsageByTenant(viewer)).find((r) => r.org_id === m.org.id);
    expect(row).toMatchObject({ replies: 1, tokens: 160 });
  });

  it("records an escalation as a reply too (the model ran), and a failed run as a failed run, not a reply", async () => {
    const m = await messagingOrg({ name: "Reply Usage Escalation Co" });
    const e = await inbound(m.org.id, { body: "Can we talk about custom pricing for ten units?" });
    await respondToConversation(m.org.id, e.conversationId, { generate: stub({ kind: "escalate", category: "sensitive_negotiation", summary: "Wants custom pricing." }).generate });
    const f = await inbound(m.org.id, { body: "Anyone there?" });
    await respondToConversation(m.org.id, f.conversationId, { generate: stub({ kind: "unavailable", reason: "Hermes did not respond in time." }).generate });
    expect((await usage(m.org.id, "customer_reply")).length).toBe(1);
    expect((await usage(m.org.id, "agent_run_failed")).length).toBe(1);
    const s = await withSystem((db) => usageSummary(db, m.org.id));
    expect(s).toMatchObject({ customerReplies: 1, failedRuns: 1 });
  });

  it("does not record anything for a message that is not answered at all (a person owns the chat, automation is stopped)", async () => {
    const m = await messagingOrg({ name: "Reply Usage Skip Co" });
    const c = await inbound(m.org.id);
    await takeOverConversation(m.ctx("manager"), c.conversationId);
    const g = stub({ kind: "reply", text: "never" });
    expect(await respondToConversation(m.org.id, c.conversationId, { generate: g.generate })).toMatchObject({ status: "skipped" });
    expect(g.calls).toHaveLength(0);
    expect(await usage(m.org.id, "customer_reply")).toEqual([]);
  });
});

describe("the optional monthly cap", () => {
  it("is not set by default, and then caps nothing", async () => {
    const m = await messagingOrg({ name: "Reply Cap Default Co" });
    const limits = await withSystem((db) => getLimits(db, m.org.id));
    expect(limits.monthly_customer_replies).toBeNull();
    for (let i = 0; i < 3; i++) {
      const c = await inbound(m.org.id);
      expect(await respondToConversation(m.org.id, c.conversationId, { generate: stub({ kind: "reply", text: `Reply ${i}` }).generate })).toMatchObject({ status: "queued" });
    }
    expect((await usage(m.org.id, "customer_reply")).length).toBe(3);
  });

  it("stops the model call once reached, leaves a note, asks a person to reply, and resumes when the cap is lifted", async () => {
    const m = await messagingOrg({ name: "Reply Cap Co" });
    await setCap(m.org.id, 2);
    for (let i = 0; i < 2; i++) {
      const c = await inbound(m.org.id);
      expect(await respondToConversation(m.org.id, c.conversationId, { generate: stub({ kind: "reply", text: `Reply ${i}` }).generate })).toMatchObject({ status: "queued" });
    }
    const third = await inbound(m.org.id, { body: "One more question" });
    const g = stub({ kind: "reply", text: "should never be generated" });
    expect(await respondToConversation(m.org.id, third.conversationId, { generate: g.generate })).toEqual({ status: "skipped", reason: "usage_limit" });
    expect(g.calls).toHaveLength(0);
    expect((await usage(m.org.id, "customer_reply")).length).toBe(2);
    const note = await withSystem((db) => db.query<{ body: string; status_detail: string }>("select body, status_detail from conversation_messages where conversation_id = $1 and direction = 'internal'", [third.conversationId]));
    expect(note.rows[0]).toMatchObject({ status_detail: "ai_usage_limit", body: expect.stringMatching(/monthly limit on AI replies/) });
    const esc = await withSystem((db) => db.query<{ category: string; status: string }>("select category, status from human_escalations where conversation_id = $1", [third.conversationId]));
    expect(esc.rows[0]).toEqual({ category: "unanswered_question", status: "awaiting_owner" });
    expect(customerReplyCapReached(await withSystem((db) => usageSummary(db, m.org.id)))).toBe(true);

    // The agency lifts the cap: a new message is answered again.
    await setCap(m.org.id, null);
    const fourth = await inbound(m.org.id);
    expect(await respondToConversation(m.org.id, fourth.conversationId, { generate: stub({ kind: "reply", text: "Back again." }).generate })).toMatchObject({ status: "queued" });
  });

  it("is advisory when the workspace's limits are advisory (hard stop off): replies still go and are still counted", async () => {
    const m = await messagingOrg({ name: "Reply Cap Advisory Co" });
    await setCap(m.org.id, 1, false);
    for (let i = 0; i < 2; i++) {
      const c = await inbound(m.org.id);
      expect(await respondToConversation(m.org.id, c.conversationId, { generate: stub({ kind: "reply", text: `Advisory ${i}` }).generate })).toMatchObject({ status: "queued" });
    }
    const s = await withSystem((db) => usageSummary(db, m.org.id));
    expect(s.customerReplies).toBe(2);
    expect(customerReplyCapReached(s)).toBe(false);
  });

  it("is set, kept and cleared by a Super Admin only, and a blank means no cap", async () => {
    const m = await messagingOrg({ name: "Reply Cap Setting Co" });
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    const base = { monthlyAgentMessages: 1500, monthlyTokens: "", dailyLeadResearch: 5, monthlyHelpRequests: 500, warnAtPercent: 80, hardStop: true, fairUseNote: "" } as const;
    await expect(updateUsageLimits(staff, m.org.id, { ...base, monthlyCustomerReplies: 50 })).rejects.toMatchObject({ code: "forbidden" });
    await updateUsageLimits(admin, m.org.id, { ...base, monthlyCustomerReplies: 50 });
    expect((await withSystem((db) => getLimits(db, m.org.id))).monthly_customer_replies).toBe(50);
    await updateUsageLimits(admin, m.org.id, { ...base, monthlyCustomerReplies: "" });
    expect((await withSystem((db) => getLimits(db, m.org.id))).monthly_customer_replies).toBeNull();
    await updateUsageLimits(admin, m.org.id, { ...base });
    expect((await withSystem((db) => getLimits(db, m.org.id))).monthly_customer_replies).toBeNull();
    await expect(updateUsageLimits(admin, m.org.id, { ...base, monthlyCustomerReplies: -1 })).rejects.toThrow();
  });
});

describe("the migration", () => {
  it("allows the new usage kind, refuses an unknown one, and its rollback refuses while a reply or a cap exists", async () => {
    const down = readFileSync("supabase/rollbacks/0104_customer_reply_usage.down.sql", "utf8");
    const m = await messagingOrg({ name: "Reply Migration Co" });
    await withSystem((db) => db.query("insert into usage_events (org_id, kind) values ($1, 'customer_reply')", [m.org.id]));
    await expect(withSystem((db) => db.query("insert into usage_events (org_id, kind) values ($1, 'made_up')", [m.org.id]))).rejects.toThrow();
    // Every statement of the rollback file runs in one transaction, which the refusal aborts, so nothing is left changed.
    const runDown = () => withSystem(async (db) => {
      for (const stmt of splitStatements(down)) await db.query(stmt);
    });
    await expect(runDown()).rejects.toThrow(/Rollback refused: customer reply usage was recorded/);
    // (Earlier cases in this file recorded replies for other workspaces; the cap's own refusal needs none to exist.)
    await withSystem((db) => db.query("delete from usage_events where kind = 'customer_reply'"));
    await setCap(m.org.id, 10);
    await expect(runDown()).rejects.toThrow(/Rollback refused: a workspace has a monthly customer reply cap/);
    expect((await withSystem((db) => getLimits(db, m.org.id))).monthly_customer_replies).toBe(10);
  });
});
