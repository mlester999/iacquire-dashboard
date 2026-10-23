// AI help with social posts. The language model is ALWAYS a stub here: these tests prove the boundaries around the model (what it is shown, what is kept, what
// becomes of its output), not how good a real model is. No real model has been evaluated.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import type { LlmConfig } from "@/server/llm/client";
import { createDraftFromOption, extractJson, suggestCaptions, suggestIdeas, unsupportedClaims } from "@/server/social/ai";
import { decide, schedulePost, submitForApproval } from "@/server/social/posts";
import { saveSocialSettings } from "@/server/social/settings";
import { connect, LATER, NOW, rows, socialOrg, type SocialOrg } from "./support/social";

const CONFIG: LlmConfig = { baseUrl: "https://llm.example.test/v1", format: "openai", model: "stub", apiKey: "stub-key", source: "environment" };

function model(text: string | ((system: string, user: string) => string)) {
  const calls: Array<{ system: string; user: string }> = [];
  const complete = async (_c: LlmConfig, input: { system: string; user: string }) => {
    calls.push({ system: input.system, user: input.user });
    return { ok: true as const, text: typeof text === "function" ? text(input.system, input.user) : text };
  };
  return { deps: { complete: complete as never, config: async () => CONFIG }, calls };
}

const knowledge = (s: SocialOrg, section: string, content: string, over: { review_status?: string; risk?: string[] } = {}) =>
  withSystem((db) => db.query(
    `insert into company_knowledge (org_id, section, content, review_status, risk_flags) values ($1, $2, $3, $4, $5)
     on conflict (org_id, section) do update set content = excluded.content, review_status = excluded.review_status, risk_flags = excluded.risk_flags`,
    [s.m.org.id, section, content, over.review_status ?? "approved", over.risk ?? []],
  ));

describe("what the model is shown", () => {
  it("sees only approved, unflagged knowledge, and is told not to invent anything", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await knowledge(s, "business_description", "Harbor Home Services repairs heating and cooling systems in Austin.");
    await knowledge(s, "faq", "SECRET-DRAFT-ANSWER we always beat every price", { review_status: "pending_agency_review" });
    await knowledge(s, "policies", "RISKY-POLICY text", { risk: ["legal"] });
    const m = model('{"ideas":[{"title":"Spring tune-up reminder","angle":"A seasonal nudge to book a visit.","kind":"text","callToAction":"Book a visit."}]}');
    const r = await suggestIdeas(s.sales, { accountId: acc.id }, m.deps);
    expect(r.ideas).toHaveLength(1);
    const shown = `${m.calls[0].system}\n${m.calls[0].user}`;
    expect(shown).toContain("repairs heating and cooling systems in Austin");
    expect(shown).not.toContain("SECRET-DRAFT-ANSWER");
    expect(shown).not.toContain("RISKY-POLICY");
    expect(m.calls[0].system).toMatch(/Never invent a testimonial, review, customer result/);
    expect(m.calls[0].system).toMatch(/Do not write web addresses/);
  });

  it("records what was asked and what came back", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const m = model('{"ideas":[{"title":"A","angle":"B","kind":"text","callToAction":"C"}]}');
    const { runId } = await suggestIdeas(s.sales, { accountId: acc.id, topic: "Spring" }, m.deps);
    const [run] = await rows<{ kind: string; status: string; brief: { topic: string }; user_id: string }>("select kind, status, brief, user_id from social_ai_runs where id = $1", [runId]);
    expect(run).toMatchObject({ kind: "ideas", status: "succeeded", brief: { topic: "Spring" }, user_id: s.m.people.sales.id });
  });
});

describe("what is kept", () => {
  it("drops a suggestion that invents a testimonial, a price, a percentage or an offer, and keeps the rest", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await knowledge(s, "products_services", "We repair air conditioners and furnaces. Tune-ups start at $89.");
    const m = model(JSON.stringify({ options: [
      { caption: "Our customers love us: five-star service every time!", hashtags: ["hvac"] },
      { caption: "Book a tune-up from $89 and stay comfortable.", hashtags: ["#HVAC", "hvac", "Austin"] },
      { caption: "Get a tune-up for just $49 this week only!", hashtags: [] },
      { caption: "Save 20% on any repair.", hashtags: [] },
      { caption: "Spring is here. Is your air conditioner ready?", hashtags: ["spring"] },
    ] }));
    const r = await suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "tune-ups", count: 3 }, m.deps);
    expect(r.options.map((o) => o.caption)).toEqual(["Book a tune-up from $89 and stay comfortable.", "Spring is here. Is your air conditioner ready?"]);
    expect(r.options[0].hashtags).toEqual(["HVAC", "Austin"]); // tidy and de-duplicated
  });

  it("allows a claim the business's own approved text makes", () => {
    expect(unsupportedClaims("We offer a free estimate on every job.", "We offer a free estimate on every job. Call us.")).toEqual([]);
    expect(unsupportedClaims("We offer a free estimate.", "We repair furnaces.")).toEqual(["free estimate"]);
    expect(unsupportedClaims("Money-back guarantee!", "").length).toBeGreaterThan(0);
    expect(unsupportedClaims("Tune-ups from $89.", "Tune-ups from $89.")).toEqual([]);
    expect(unsupportedClaims("Tune-ups from $79.", "Tune-ups from $89.")).toEqual(["$79"]);
    expect(unsupportedClaims("Spring maintenance keeps your system running well.", "")).toEqual([]);
  });

  it("removes any web address the model wrote", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const m = model('{"options":[{"caption":"Book at https://evil.example/x or www.evil.example now.","hashtags":[]}]}');
    const r = await suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "booking" }, m.deps);
    expect(r.options[0].caption).not.toMatch(/https?:|www\./);
  });

  it("refuses, saying why, when everything it wrote made unsupported claims", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const m = model('{"options":[{"caption":"Voted number one in town, guaranteed.","hashtags":[]}]}');
    await expect(suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "us" }, m.deps)).rejects.toThrow(/not in your approved business knowledge/);
    const runs = await rows<{ status: string }>("select status from social_ai_runs where org_id = $1", [s.m.org.id]);
    expect(runs.map((r) => r.status)).toEqual(["failed"]);
  });

  it("reads an answer wrapped in prose or a code fence, and refuses one that is not JSON", async () => {
    expect(extractJson('Sure! ```json\n{"a": [1, 2]}\n``` Hope that helps.')).toEqual({ a: [1, 2] });
    expect(extractJson("no json here")).toBeNull();
    const s = await socialOrg();
    const acc = await connect(s);
    await expect(suggestIdeas(s.sales, { accountId: acc.id }, model("I cannot help with that.").deps)).rejects.toThrow(/did not return usable ideas/);
  });
});

describe("when the AI is not available", () => {
  it("says so instead of making something up", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await expect(suggestIdeas(s.sales, { accountId: acc.id }, { complete: (async () => ({ ok: true, text: "{}" })) as never, config: async () => null })).rejects.toThrow(/not connected/);
    const failing = { complete: (async () => ({ ok: false })) as never, config: async () => CONFIG };
    await expect(suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "x" }, failing)).rejects.toThrow(/did not answer/);
  });

  it("stops when the owner switched AI drafting off, and for a role that cannot write posts", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const m = model('{"ideas":[{"title":"A","angle":"B","kind":"text","callToAction":"C"}]}');
    await expect(suggestIdeas(s.viewer, { accountId: acc.id }, m.deps)).rejects.toThrow(/can't write/);
    await saveSocialSettings(s.owner, { aiDraftsEnabled: false }, 0);
    await expect(suggestIdeas(s.sales, { accountId: acc.id }, m.deps)).rejects.toThrow(/switched off/);
    expect(m.calls).toHaveLength(0);
  });

  it("stops when the workspace has no service credits", async () => {
    const s = await socialOrg({ credits: 0 });
    const acc = await connect(s);
    const m = model('{"ideas":[{"title":"A","angle":"B","kind":"text","callToAction":"C"}]}');
    await expect(suggestIdeas(s.sales, { accountId: acc.id }, m.deps)).rejects.toThrow(/credits have run out/);
    expect(m.calls).toHaveLength(0);
  });
});

describe("what becomes of what it wrote", () => {
  it("is an editable draft marked as AI-written, which cannot be scheduled without a person's approval", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const m = model('{"options":[{"caption":"Spring is here. Is your air conditioner ready?","hashtags":["spring"]}]}');
    const { runId } = await suggestCaptions(s.owner, { accountId: acc.id, kind: "text", topic: "spring" }, m.deps);
    const draft = await createDraftFromOption(s.owner, runId, 0, { accountId: acc.id, kind: "text" });
    expect(draft).toMatchObject({ status: "draft", origin: "ai", caption: "Spring is here. Is your air conditioner ready?" });
    expect(draft.hashtags).toEqual(["spring"]);
    // The owner could publish their own posts, but not an AI draft: it needs the approval step.
    await expect(schedulePost(s.owner, draft.id, { at: LATER }, { now: NOW })).rejects.toThrow(/needs to be approved/);
    const pending = await submitForApproval(s.owner, draft.id);
    const approved = await decide(s.manager, pending.id, { decision: "approve", version: pending.version });
    expect(approved.status).toBe("approved");
    const events = (await rows<{ kind: string; actor_kind: string }>("select kind, actor_kind from social_post_events where post_id = $1 order by id", [draft.id])).map((e) => `${e.kind}:${e.actor_kind}`);
    expect(events.slice(0, 2)).toEqual(["ai_drafted:ai", "ai_option_chosen:user"]);
  });

  it("refuses a suggestion that does not exist or belongs to another workspace", async () => {
    const a = await socialOrg();
    const b = await socialOrg();
    const acc = await connect(a);
    const m = model('{"options":[{"caption":"A fair caption.","hashtags":[]}]}');
    const { runId } = await suggestCaptions(a.sales, { accountId: acc.id, kind: "text", topic: "x" }, m.deps);
    await expect(createDraftFromOption(a.sales, runId, 5, { accountId: acc.id, kind: "text" })).rejects.toThrow(/Choose one of the suggestions/);
    await expect(createDraftFromOption(b.sales, runId, 0, { accountId: acc.id, kind: "text" })).rejects.toThrow(/not found/);
  });

  it("adds the workspace's default hashtags to the draft", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await saveSocialSettings(s.owner, { defaultHashtags: ["HarborHome"] }, 0);
    const { runId } = await suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "x" }, model('{"options":[{"caption":"A fair caption.","hashtags":["hvac"]}]}').deps);
    const draft = await createDraftFromOption(s.sales, runId, 0, { accountId: acc.id, kind: "text" });
    expect(draft.hashtags).toEqual(["hvac", "HarborHome"]);
  });
});
