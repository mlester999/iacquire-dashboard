// The per-use AI features a person in a workspace starts (the inbox's AI help, request help, the help assistant) and the lead-scoring model are metered like every other
// model call: the provider's token counts are recorded against the workspace, tagged with the feature, whatever becomes of the answer. The provider is a stub.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm/client")>();
  return { ...actual, resolveLlmConfig: vi.fn(), llmComplete: vi.fn() };
});

import { withSystem } from "@/server/db";
import { llmComplete, resolveLlmConfig, type LlmConfig } from "@/server/llm/client";
import { summarizeConversation, suggestReply, type Complete } from "@/server/messaging/inbox-ai";
import { extractSignals } from "@/server/lead-scoring/ai";
import { improveRequestDraft } from "@/server/support/ai";
import { askHelp } from "@/server/help/service";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";
import { resetRateLimits, supportWorld, type SupportWorld } from "./support/support-world";

const CONFIG: LlmConfig = { baseUrl: "https://llm.example.test/v1", format: "openai", model: "test-model", apiKey: "test-key", source: "portal" };
const GOOD = "SUMMARY:\nCarla wants a quote for a heat pump.\nNEXT STEPS:\n- Ask which room it is for\nHUMAN REVIEW:\nNONE\nCONFIDENCE: medium";

let m: MessagingOrg;
let w: SupportWorld;
beforeAll(async () => {
  m = await messagingOrg({ name: "Callers Co" });
  w = await supportWorld();
});
beforeEach(async () => {
  await resetRateLimits();
  vi.mocked(resolveLlmConfig).mockReset().mockResolvedValue(CONFIG);
  vi.mocked(llmComplete).mockReset().mockResolvedValue({ ok: true, text: "A canned answer." });
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const lines = (orgId: string, feature: string) =>
  rows<{ unit_type: string; quantity: string }>("select unit_type, quantity::text from metered_usage_events where org_id = $1 and provider = 'llm' and job_reference = $2 order by unit_type", [orgId, `ai:${feature}`]);
const stub = (text: string, usage?: { inputTokens: number | null; outputTokens: number | null }): Complete => async () => ({ ok: true, text, ...(usage ? { usage } : {}) });

describe("the inbox's AI help", () => {
  it("meters a summary and a suggested reply, tagged inbox_ai, next to the allowance it already counts", async () => {
    const c = await inbound(m.org.id, { name: "Carla Reyes", body: "Hi, I'd like a quote for a heat pump." });
    const before = (await rows("select 1 from usage_events where org_id = $1 and kind = 'help_request'", [m.org.id])).length;
    expect(await summarizeConversation(m.ctx("manager"), c.conversationId, { complete: stub(GOOD, { inputTokens: 640, outputTokens: 95 }) })).toMatchObject({ ok: true });
    expect(await suggestReply(m.ctx("manager"), c.conversationId, { complete: stub("Thanks Carla, we can visit on Thursday.", { inputTokens: 500, outputTokens: 40 }) })).toMatchObject({ ok: true });
    expect((await lines(m.org.id, "inbox_ai")).map((l) => `${l.unit_type} ${l.quantity}`).sort()).toEqual([
      "ai_tokens_in 500.000000", "ai_tokens_in 640.000000", "ai_tokens_out 40.000000", "ai_tokens_out 95.000000",
    ]);
    expect((await rows("select 1 from usage_events where org_id = $1 and kind = 'help_request'", [m.org.id])).length - before).toBe(2);
  });

  it("meters an answer it could not use too (the tokens were spent), and records nothing when the provider reports none", async () => {
    const c = await inbound(m.org.id, { name: "Dev Patel", body: "Can you do Saturday?" });
    const base = (await lines(m.org.id, "inbox_ai")).length;
    expect(await summarizeConversation(m.ctx("manager"), c.conversationId, { complete: stub("not in the right shape", { inputTokens: 100, outputTokens: 10 }) })).toMatchObject({ ok: false });
    expect((await lines(m.org.id, "inbox_ai")).length - base).toBe(2);
    expect(await summarizeConversation(m.ctx("manager"), c.conversationId, { complete: stub(GOOD) })).toMatchObject({ ok: true });
    expect((await lines(m.org.id, "inbox_ai")).length - base).toBe(2);
  });

  it("meters the real provider path: the usage comes from llmComplete's result", async () => {
    const c = await inbound(m.org.id, { name: "Mo Ali", body: "Do you service Cebu?" });
    vi.mocked(llmComplete).mockResolvedValue({ ok: true, text: GOOD, usage: { inputTokens: 222, outputTokens: 33 } });
    const base = (await lines(m.org.id, "inbox_ai")).length;
    expect(await summarizeConversation(m.ctx("manager"), c.conversationId)).toMatchObject({ ok: true });
    expect((await lines(m.org.id, "inbox_ai")).length - base).toBe(2);
  });
});

describe("lead scoring", () => {
  const messages = [{ id: "m1", text: "I want a quote for a kitchen remodel next month." }];
  const limits = { enabled: true, dailyLimit: 5 };
  const now = new Date("2026-10-21T12:00:00Z");

  it("meters each call that came back, including an answer the checks then refuse, and nothing for a call that failed outright", async () => {
    const replies = [
      { ok: false as const, status: 500 }, // first try: a server error, nothing came back
      { ok: true as const, text: "not json at all", usage: { inputTokens: 410, outputTokens: 20 } }, // second try: tokens spent, answer unusable
    ];
    const complete = (async () => replies.shift() ?? { ok: false as const, status: 500 }) as never;
    const out = await extractSignals(m.org.id, messages, limits, now, { resolve: async () => CONFIG, complete, backoffMs: 0 });
    expect(out).toMatchObject({ status: "failed", reason: "not_json" });
    expect((await lines(m.org.id, "lead_scoring")).map((l) => `${l.unit_type} ${l.quantity}`)).toEqual(["ai_tokens_in 410.000000", "ai_tokens_out 20.000000"]);
  });

  it("records nothing when the provider reports no usage, and still scores", async () => {
    const before = (await lines(m.org.id, "lead_scoring")).length;
    const complete = (async () => ({ ok: true as const, text: "still not json" })) as never;
    await extractSignals(m.org.id, messages, limits, now, { resolve: async () => CONFIG, complete, backoffMs: 0 });
    expect((await lines(m.org.id, "lead_scoring")).length).toBe(before);
  });
});

describe("request help", () => {
  it("meters the call against the workspace the request belongs to", async () => {
    vi.mocked(llmComplete).mockResolvedValue({ ok: true, text: "IMPROVED:\nMy calendar stopped syncing on Monday.\nQUESTIONS:\n- Which calendar?", usage: { inputTokens: 300, outputTokens: 60 } });
    const r = await improveRequestDraft(w.ctx.member, { type: "issue", subject: "Calendar sync", text: "my calender stopped syncing monday and i do not know why" });
    expect(r).toMatchObject({ ok: true });
    expect((await lines(w.org.id, "support_ai")).map((l) => `${l.unit_type} ${l.quantity}`).sort()).toEqual(["ai_tokens_in 300.000000", "ai_tokens_out 60.000000"]);
  });

  it("meters a call whose answer was refused as unavailable only when the provider reported tokens", async () => {
    const base = (await lines(w.org.id, "support_ai")).length;
    vi.mocked(llmComplete).mockResolvedValue({ ok: false, status: 500 });
    expect(await improveRequestDraft(w.ctx.member, { type: "issue", subject: "Calendar sync", text: "my calender stopped syncing monday and i do not know why" })).toMatchObject({ ok: false });
    expect((await lines(w.org.id, "support_ai")).length).toBe(base);
  });
});

describe("the help assistant", () => {
  it("meters an AI answer for a signed-in workspace, and nothing for an agency user who has no workspace to charge", async () => {
    vi.mocked(llmComplete).mockResolvedValue({ ok: true, text: "Your six AI employees are in the sidebar.", usage: { inputTokens: 800, outputTokens: 70 } });
    const answer = await askHelp(w.ctx.member, w.people.member.id, "Mia", "What are my six AI employees?");
    expect(answer.mode).toBe("ai");
    expect((await lines(w.org.id, "help_assistant")).map((l) => `${l.unit_type} ${l.quantity}`).sort()).toEqual(["ai_tokens_in 800.000000", "ai_tokens_out 70.000000"]);
    const agencyAnswer = await askHelp(null, w.raw.superAdmin.id, null, "What are my six AI employees?");
    expect(agencyAnswer.mode).toBe("ai");
    expect((await lines(w.org.id, "help_assistant")).length).toBe(2);
  });
});
