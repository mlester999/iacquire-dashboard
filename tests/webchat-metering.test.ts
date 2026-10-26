// What the public website chat costs and how that is controlled: every AI reply is metered (recorded, and charged where a rate is published), and each workspace has
// a daily allowance of AI replies that is taken before the model is asked. The language model is ALWAYS a stub here. No real model has been evaluated.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/billing/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/billing/ledger")>();
  return { ...actual, chargeUsage: vi.fn(actual.chargeUsage) };
});

import { withSystem } from "@/server/db";
import { env, resetEnvCache } from "@/server/env";
import { chargeUsage, currentRate, getBalance } from "@/server/billing/ledger";
import { publishUnitRate } from "@/server/billing/service";
import { applyMarkup } from "@/lib/billing";
import { chatHealth } from "@/server/webchat/analytics";
import { createWebChatGenerator } from "@/server/webchat/generator";
import { dailyAiReplyRule, takeDailyAiReply } from "@/server/webchat/switch";
import type { LlmConfig, LlmUsage } from "@/server/llm/client";
import { bodyOf, chatOrg, clientId, embedCall, start, viewOf, type ChatOrg } from "./support/webchat";

const CONFIG: LlmConfig = { baseUrl: "https://llm.example.test/v1", format: "openai", model: "stub", apiKey: "stub-key", source: "environment" };
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const savedCap = process.env.WEBCHAT_DAILY_AI_REPLIES;

afterEach(() => {
  if (savedCap === undefined) delete process.env.WEBCHAT_DAILY_AI_REPLIES;
  else process.env.WEBCHAT_DAILY_AI_REPLIES = savedCap;
  resetEnvCache();
  vi.mocked(chargeUsage).mockClear();
});

/** A model that answers with fixed text, reports the given usage, and records what it was asked. */
function model(text: string, usage: LlmUsage | null = { inputTokens: 900, outputTokens: 120 }) {
  const calls: Array<{ system: string; user: string }> = [];
  const complete = async (_c: LlmConfig, input: { system: string; user: string }) => {
    calls.push({ system: input.system, user: input.user });
    return usage ? { ok: true as const, text, usage } : { ok: true as const, text };
  };
  return { calls, generator: createWebChatGenerator({ complete, config: async () => CONFIG }) };
}
const failingModel = () => {
  const calls: unknown[] = [];
  return { calls, generator: createWebChatGenerator({ complete: async () => (calls.push(1), { ok: false as const, status: 500 }), config: async () => CONFIG }) };
};

const say = (c: ChatOrg, token: string, text: string, generate: ReturnType<typeof model>["generator"]) =>
  embedCall(c, { action: "send", token, body: { text, clientMessageId: clientId() }, generate });
const lines = (orgId: string) => rows<{ unit_type: string; quantity: string; charged_micros: string; job_reference: string }>("select unit_type, quantity::text, charged_micros::text, job_reference from metered_usage_events where org_id = $1 and provider = 'llm' order by unit_type, quantity", [orgId]);
const available = async (c: ChatOrg) => (await withSystem((db) => getBalance(db, c.m.org.id))).availableMicros;
const incidents = (key: string) => rows<{ occurrences: number; status: string }>("select occurrences, status from incidents where dedupe_key = $1", [key]);

let c: ChatOrg;
beforeAll(async () => {
  c = await chatOrg();
});

describe("metering the assistant's replies", () => {
  it("records the tokens of each reply as zero-cost usage lines while no rate is published, and still answers", async () => {
    const m = model("We repair roofs.");
    const r = await say(c, await start(c), "What do you do?", m.generator);
    expect(viewOf(r).messages.map((x) => x.role)).toEqual(["visitor", "assistant"]);
    expect(await lines(c.m.org.id)).toEqual([
      { unit_type: "ai_tokens_in", quantity: "900.000000", charged_micros: "0", job_reference: "ai:webchat_reply" },
      { unit_type: "ai_tokens_out", quantity: "120.000000", charged_micros: "0", job_reference: "ai:webchat_reply" },
    ]);
  });

  it("records nothing, and still answers, when the model reports no usage", async () => {
    const before = (await lines(c.m.org.id)).length;
    const r = await say(c, await start(c), "Hello", model("Hi there.", null).generator);
    expect(viewOf(r).messages.at(-1)?.text).toMatch(/Hi there/);
    expect((await lines(c.m.org.id)).length).toBe(before);
  });

  it("charges the workspace once per reply when a rate is published, not twice by the reply path", async () => {
    await publishUnitRate(c.m.superAdmin, { provider: "llm", unitType: "ai_tokens_in", wholesaleMicrosPerUnit: 2_000 });
    await publishUnitRate(c.m.superAdmin, { provider: "llm", unitType: "ai_tokens_out", wholesaleMicrosPerUnit: 6_000 });
    const bps = (await withSystem((db) => currentRate(db))).markupBps;
    const charge = applyMarkup(Math.ceil((2_000 * 1000) / 1000), bps) + applyMarkup(Math.ceil((6_000 * 200) / 1000), bps);
    const before = await available(c);
    const linesBefore = (await lines(c.m.org.id)).length;
    const r = await say(c, await start(c), "How long does a roof last?", model("About twenty years.", { inputTokens: 1000, outputTokens: 200 }).generator);
    expect(viewOf(r).messages.at(-1)?.role).toBe("assistant");
    expect(before - (await available(c))).toBe(charge);
    expect((await lines(c.m.org.id)).length - linesBefore).toBe(2);
    expect(await rows("select 1 from metered_usage_events where org_id = $1 and provider_reference like 'reply:%'", [c.m.org.id])).toHaveLength(0);
  });

  it("meters a reply that the guards refuse, because the model was paid for anyway", async () => {
    const before = (await lines(c.m.org.id)).length;
    const liar = model("A new roof is only $1,200 this week!", { inputTokens: 500, outputTokens: 40 });
    const r = await say(c, await start(c), "How much is a new roof?", liar.generator);
    expect(viewOf(r).messages.map((x) => x.role)).toEqual(["visitor", "system"]);
    expect((await lines(c.m.org.id)).length - before).toBe(2);
  });

  it("meters nothing for a call that failed without reporting usage, and falls back to a person", async () => {
    const before = (await lines(c.m.org.id)).length;
    const f = failingModel();
    const r = await say(c, await start(c), "Hi", f.generator);
    expect(f.calls).toHaveLength(1);
    expect(viewOf(r).messages.map((x) => x.role)).toEqual(["visitor", "system"]);
    expect((await lines(c.m.org.id)).length).toBe(before);
  });

  it("never blocks the visitor's reply on a metering failure: the reply is delivered, the failure is logged without detail, and an incident is opened", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      vi.mocked(chargeUsage).mockRejectedValueOnce(new Error("ledger unavailable: secret row values"));
      const before = (await lines(c.m.org.id)).length;
      const r = await say(c, await start(c), "Do you work weekends?", model("Yes, on request.", { inputTokens: 300, outputTokens: 30 }).generator);
      expect(viewOf(r).messages.map((x) => x.role)).toEqual(["visitor", "assistant"]);
      expect(viewOf(r).messages.at(-1)?.text).toMatch(/Yes, on request/);
      expect((await lines(c.m.org.id)).length).toBe(before); // rolled back: not half-recorded
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret row values/);
      expect((await incidents("metering:failed:webchat_reply"))[0]).toMatchObject({ status: "open" });
    } finally {
      log.mockRestore();
    }
  });

  it("stops the assistant when the workspace is out of credits after metering, with the existing honest fallback", async () => {
    const broke = await chatOrg({}, { credits: 0 });
    const m = model("never", { inputTokens: 10, outputTokens: 10 });
    const r = await say(broke, await start(broke), "Hello", m.generator);
    expect(m.calls).toHaveLength(0);
    expect(viewOf(r).messages.map((x) => x.role)).toEqual(["visitor", "system"]);
  });
});

describe("the daily allowance of AI replies", () => {
  it("is 500 by default, can be set with WEBCHAT_DAILY_AI_REPLIES, and is read as a number of replies per day", () => {
    delete process.env.WEBCHAT_DAILY_AI_REPLIES;
    resetEnvCache();
    expect(env().WEBCHAT_DAILY_AI_REPLIES).toBe(500);
    expect(dailyAiReplyRule()).toEqual({ name: "webchat:ai:daily", limit: 500, windowSeconds: 86_400 });
    for (const [value, expected] of [["", 500], ["   ", 500], ["25", 25], ["0", 0], ["100000", 100_000]] as const) {
      process.env.WEBCHAT_DAILY_AI_REPLIES = value;
      resetEnvCache();
      expect(env().WEBCHAT_DAILY_AI_REPLIES, value).toBe(expected);
    }
    for (const bad of ["lots", "-1", "1.5", "100001"]) {
      process.env.WEBCHAT_DAILY_AI_REPLIES = bad;
      resetEnvCache();
      expect(() => env(), bad).toThrow(/WEBCHAT_DAILY_AI_REPLIES/);
    }
  });

  it("stops the assistant at the allowance before the model is asked, tells the visitor a team member will follow up and offers the details form, and asks a person to reply", async () => {
    process.env.WEBCHAT_DAILY_AI_REPLIES = "2";
    resetEnvCache();
    const d = await chatOrg();
    const m = model("Happy to help.");
    const token = await start(d);
    await say(d, token, "one", m.generator);
    await say(d, token, "two", m.generator);
    expect(m.calls).toHaveLength(2);
    const creditsBefore = await available(d);
    const linesBefore = (await lines(d.m.org.id)).length;

    const third = viewOf(await say(d, token, "three", m.generator));
    expect(m.calls).toHaveLength(2); // the model was not asked
    expect(third.messages.map((x) => x.role)).toEqual(["visitor", "assistant", "visitor", "assistant", "visitor", "system"]);
    expect(third.messages.at(-1)?.text).toMatch(/asked a team member to follow up/);
    expect(third.messages.at(-1)?.text).toMatch(/leave your details/);
    expect(await available(d)).toBe(creditsBefore);
    expect((await lines(d.m.org.id)).length).toBe(linesBefore);

    // Staff are told why, once, and a person is asked to reply; the next message does not raise it again.
    const note = await rows<{ body: string }>("select m.body from conversation_messages m join conversations c on c.id = m.conversation_id where c.org_id = $1 and m.direction = 'internal' and m.status_detail = 'ai_unavailable'", [d.m.org.id]);
    expect(note).toHaveLength(1);
    expect(note[0].body).toMatch(/limit of 2 replies/);
    expect(await rows("select 1 from human_escalations where org_id = $1", [d.m.org.id])).toHaveLength(1);
    await say(d, token, "four", m.generator);
    expect(m.calls).toHaveLength(2);
    expect(await rows("select 1 from human_escalations where org_id = $1", [d.m.org.id])).toHaveLength(1);

    // The owners hear once that the assistant stopped for the day.
    const notices = await rows<{ user_id: string }>("select user_id from notifications where org_id = $1 and kind = 'usage_limit_approaching' and dedupe_key like 'webchat-ai-cap:%'", [d.m.org.id]);
    expect(notices.length).toBeGreaterThan(0);
    expect(new Set(notices.map((n) => n.user_id)).size).toBe(notices.length);
  });

  it("is a workspace's own count: another workspace is not held back by it, and two visitors in the same workspace share it", async () => {
    process.env.WEBCHAT_DAILY_AI_REPLIES = "2";
    resetEnvCache();
    const a = await chatOrg();
    const b = await chatOrg();
    const ma = model("From A.");
    const mb = model("From B.");
    await say(a, await start(a), "hi", ma.generator);
    await say(a, await start(a), "hi", ma.generator); // a different visitor, the same workspace
    const blocked = viewOf(await say(a, await start(a), "hi", ma.generator));
    expect(ma.calls).toHaveLength(2);
    expect(blocked.messages.at(-1)?.role).toBe("system");
    const fine = viewOf(await say(b, await start(b), "hi", mb.generator));
    expect(mb.calls).toHaveLength(1);
    expect(fine.messages.at(-1)?.role).toBe("assistant");
    expect(fine.messages.at(-1)?.text).toContain("From B.");
  });

  it("counts the attempt, not the success: a model that keeps failing still uses the allowance", async () => {
    process.env.WEBCHAT_DAILY_AI_REPLIES = "2";
    resetEnvCache();
    const d = await chatOrg();
    const f = failingModel();
    await say(d, await start(d), "one", f.generator);
    await say(d, await start(d), "two", f.generator);
    await say(d, await start(d), "three", f.generator);
    expect(f.calls).toHaveLength(2);
  });

  it("with an allowance of 0 the assistant never replies, and the chat still takes the visitor's message and asks a person", async () => {
    process.env.WEBCHAT_DAILY_AI_REPLIES = "0";
    resetEnvCache();
    const d = await chatOrg();
    const m = model("never");
    const r = await say(d, await start(d), "hello", m.generator);
    expect(m.calls).toHaveLength(0);
    expect(viewOf(r).messages.map((x) => x.role)).toEqual(["visitor", "system"]);
    expect(await rows("select 1 from human_escalations where org_id = $1", [d.m.org.id])).toHaveLength(1);
  });

  it("tells the widget the assistant is not answering once the allowance is used, so it puts the details form first", async () => {
    process.env.WEBCHAT_DAILY_AI_REPLIES = "1";
    resetEnvCache();
    const d = await chatOrg();
    const before = bodyOf<{ config: { aiAvailable: boolean } }>(await embedCall(d, { action: "config" })).config;
    expect(before.aiAvailable).toBe(true);
    await say(d, await start(d), "hello", model("Hi").generator);
    expect(bodyOf<{ config: { aiAvailable: boolean } }>(await embedCall(d, { action: "config" })).config.aiAvailable).toBe(false);
    // A workspace whose assistant is switched off says so for its own reason, not the allowance's.
    const quiet = await chatOrg({ aiEnabled: false });
    expect(bodyOf<{ config: { aiAvailable: boolean } }>(await embedCall(quiet, { action: "config" })).config.aiAvailable).toBe(false);
  });

  it("shows the owner the allowance was reached, in the chat's own checks", async () => {
    process.env.WEBCHAT_DAILY_AI_REPLIES = "1";
    resetEnvCache();
    const d = await chatOrg();
    expect((await chatHealth(d.m.ctx("owner"))).map((h) => h.key)).not.toContain("daily");
    await say(d, await start(d), "hello", model("Hi").generator);
    const daily = (await chatHealth(d.m.ctx("owner"))).find((h) => h.key === "daily");
    expect(daily).toMatchObject({ state: "attention" });
    expect(daily?.detail).toMatch(/at most 1 reply a day/);
  });

  it("renews with the next UTC day", async () => {
    process.env.WEBCHAT_DAILY_AI_REPLIES = "1";
    resetEnvCache();
    const org = (await chatOrg()).m.org.id;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2031-03-04T10:00:00Z"));
      expect((await takeDailyAiReply(org)).allowed).toBe(true);
      const refused = await takeDailyAiReply(org);
      expect(refused.allowed).toBe(false);
      expect(refused.cap).toBe(1);
      expect(refused.retryAfterSeconds).toBe(14 * 3600);
      vi.setSystemTime(new Date("2031-03-05T00:00:05Z"));
      expect((await takeDailyAiReply(org)).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
