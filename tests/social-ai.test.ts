// AI help with social posts. The language model is ALWAYS a stub here: these tests prove the boundaries around the model (what it is shown, what is kept, what
// becomes of its output), not how good a real model is. No real model has been evaluated.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { currentRate, getBalance } from "@/server/billing/ledger";
import { publishUnitRate } from "@/server/billing/service";
import { applyMarkup } from "@/lib/billing";
import type { LlmConfig } from "@/server/llm/client";
import { createDraftFromOption, extractJson, SOCIAL_AI_LIMITS, suggestCaptions, suggestIdeas, unsupportedClaims } from "@/server/social/ai";
import { unsupportedHashtags } from "@/server/social/claims";
import { decide, schedulePost, submitForApproval } from "@/server/social/posts";
import { saveSocialSettings } from "@/server/social/settings";
import { connect, LATER, NOW, rows, socialOrg, type SocialOrg } from "./support/social";

const CONFIG: LlmConfig = { baseUrl: "https://llm.example.test/v1", format: "openai", model: "stub", apiKey: "stub-key", source: "environment" };

function model(text: string | ((system: string, user: string) => string), usage?: { inputTokens: number | null; outputTokens: number | null }) {
  const calls: Array<{ system: string; user: string }> = [];
  const complete = async (_c: LlmConfig, input: { system: string; user: string }) => {
    calls.push({ system: input.system, user: input.user });
    return { ok: true as const, text: typeof text === "function" ? text(input.system, input.user) : text, ...(usage ? { usage } : {}) };
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

// What the business has approved to say. None of the claims below is in it.
const KNOWLEDGE = "Harbor Home Services repairs heating and cooling systems in Austin. Open Monday to Friday, 9am-5pm. Tune-ups start at $120. Established 2012.";

describe("claims the knowledge does not back", () => {
  it("catches an invented price that a number elsewhere in the knowledge used to hide", () => {
    expect(unsupportedClaims("Tune-ups for just $20 this month.", KNOWLEDGE)).toEqual(["$20"]); // 20 is inside 120 and 2012
    expect(unsupportedClaims("Get $5 off your first visit.", KNOWLEDGE)).toEqual(["$5"]); // 5 is inside 5pm
    expect(unsupportedClaims("Tune-ups from $12.", KNOWLEDGE)).toEqual(["$12"]);
    expect(unsupportedClaims("Tune-ups start at $120.", KNOWLEDGE)).toEqual([]);
  });

  it.each([
    "Over 500 happy customers trust us.",
    "Trusted by 1,200 local families.",
    "Rated 4.9 stars by homeowners.",
    "Our clients love us.",
    "Half off all repairs this weekend only.",
    "Save 50 percent on your next service.",
    "Free shipping on all parts.",
    "Book now and get a free gift.",
    "Voted Best HVAC company 2025.",
    "9 out of 10 customers recommend us.",
    "Two-for-one tune-ups this week.",
    "Serving Austin since 2008.",
    "We are licensed and insured.",
    "20 years of experience you can trust.",
    "Call 512-555-0199 to book.",
    "Write to hello@harborhome.example.",
    "A lifetime warranty on every repair.",
    "No hidden fees, ever.",
    "We are the best in the business.",
    "Save $50 on your next visit.",
    "Get 15% off this month.",
  ])("drops: %s", (text) => {
    expect(unsupportedClaims(text, KNOWLEDGE).length).toBeGreaterThan(0);
  });

  it.each([
    "Spring is here. Is your air conditioner ready?",
    "Replace your air filter every 3 months.",
    "3 tips to get your furnace ready for winter.",
    "Free time this weekend? Spend 10 minutes checking your thermostat.",
    "Carefree comfort starts with a tune-up.",
    "Rely on us for your next repair.",
    "Save energy this summer with a quick tune-up.",
    "Our team is ready to help you stay comfortable.",
    "Our 2026 projects are booking up. Book early.",
    "Check your warranty before you book a repair.",
    "Tune-ups start at $120. Open Monday to Friday, 9am-5pm.",
    "Established 2012 and still fixing furnaces.",
    "Is your thermostat set to 68 degrees?",
  ])("keeps: %s", (text) => {
    expect(unsupportedClaims(text, KNOWLEDGE)).toEqual([]);
  });

  it("allows each of them once the business's own approved text says so", () => {
    const stated = "We offer a free estimate on every job. We are licensed and insured. 20 years of experience. Call 512-555-0199 or email hello@harborhome.example. Seniors save 5% on Tuesdays. Over 500 customers served. Established 2012. Lifetime warranty on repairs.";
    for (const text of ["Ask for a free estimate.", "We are licensed and insured.", "20 years of experience you can trust.", "Call 512-555-0199 to book.", "Write to hello@harborhome.example.", "Seniors save 5%.", "Over 500 happy customers served.", "Serving Austin since 2012.", "A lifetime warranty on every repair."]) {
      expect(unsupportedClaims(text, stated), text).toEqual([]);
    }
    // A percentage is grounded only by the same percentage: 5% is not 15%.
    expect(unsupportedClaims("Seniors save 5%.", "Seniors save 15% on Tuesdays.")).toContain("5%");
  });

  it("checks the hashtags too, in either capitalisation", () => {
    for (const tags of [["AwardWinning"], ["BestInTown"], ["FreeQuote"], ["50PercentOff"], ["awardwinning"], ["freequote"], ["bestintown"], ["50percentoff"], ["Voted2025"]]) {
      expect(unsupportedHashtags(tags, KNOWLEDGE).length, tags.join()).toBeGreaterThan(0);
    }
    expect(unsupportedHashtags(["HVAC", "Austin", "SpringTuneUp", "freedom", "carefree"], KNOWLEDGE)).toEqual([]);
    expect(unsupportedHashtags(["FreeEstimate"], "We offer a free estimate on every job.")).toEqual([]);
  });

  it("drops an option whose hashtags make a claim, keeping the rest", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await knowledge(s, "business_description", KNOWLEDGE);
    const m = model(JSON.stringify({ options: [
      { caption: "Spring tune-ups are open for booking.", hashtags: ["hvac", "AwardWinning"] },
      { caption: "Keep your home cool this season.", hashtags: ["50PercentOff"] },
      { caption: "Stay comfortable this spring.", hashtags: ["freequote"] },
      { caption: "Stay comfortable all summer.", hashtags: ["Austin", "HVAC"] },
    ] }));
    const r = await suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "tune-ups", count: 3 }, m.deps);
    expect(r.options.map((o) => o.caption)).toEqual(["Stay comfortable all summer."]);
  });

  it("removes bare web addresses, and drops an email address or phone number the knowledge does not give", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const m = model(JSON.stringify({ options: [
      { caption: "Book at bit.ly/x or acme-hvac.com/book or ACME.io today.", hashtags: [] },
      { caption: "Email hello@acme-hvac.com to book.", hashtags: [] },
      { caption: "Call (512) 555-0100 to book.", hashtags: [] },
    ] }));
    const r = await suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "booking", count: 3 }, m.deps);
    expect(r.options).toHaveLength(1);
    expect(r.options[0].caption).not.toMatch(/bit\.ly|acme-hvac|acme\.io/i);
    expect(r.options[0].caption).toMatch(/^Book at\b/);
  });
});

describe("the business's industry", () => {
  it("is given to the model as context, and never grounds a claim", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await withSystem((db) => db.query("update organizations set industry = $2 where id = $1", [s.m.org.id, "Roofing and gutter cleaning"]));
    await knowledge(s, "business_description", "Harbor Home Services repairs roofs in Austin.");
    const m = model(JSON.stringify({ options: [{ caption: "Free estimates on every roof.", hashtags: [] }, { caption: "Gutters need a look before the rainy season.", hashtags: [] }] }));
    const r = await suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "roofs", count: 2 }, m.deps);
    expect(m.calls[0].system).toMatch(/## Industry \(context only\)\nRoofing and gutter cleaning\./);
    expect(m.calls[0].system).toMatch(/not a source of facts/);
    expect(r.options.map((o) => o.caption)).toEqual(["Gutters need a look before the rainy season."]); // the industry does not make "free estimates" true
    const ideas = await suggestIdeas(s.sales, { accountId: acc.id }, model('{"ideas":[{"title":"Roof check","angle":"A seasonal reminder.","kind":"text","callToAction":"Book a visit."}]}').deps);
    expect(ideas.ideas).toHaveLength(1);
  });

  it("is left out of the prompt when the workspace has none", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await withSystem((db) => db.query("update organizations set industry = null where id = $1", [s.m.org.id]));
    const m = model('{"ideas":[{"title":"A","angle":"B","kind":"text","callToAction":"C"}]}');
    await suggestIdeas(s.sales, { accountId: acc.id }, m.deps);
    expect(m.calls[0].system).not.toMatch(/Industry \(context only\)/);
  });
});

describe("how much AI drafting one person and one workspace can ask for", () => {
  const bucket = (rule: { name: string; windowSeconds: number }, key: string) => ({ key: `${rule.name}:${key}`, start: new Date(Math.floor(Date.now() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000) });
  const fill = (rule: { name: string; windowSeconds: number }, key: string, hits: number) => {
    const b = bucket(rule, key);
    return withSystem((db) => db.query("insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, $3) on conflict (bucket_key, window_start) do update set hits = $3", [b.key, b.start, hits]));
  };
  const hitsOf = async (rule: { name: string; windowSeconds: number }, key: string) => {
    const b = bucket(rule, key);
    return (await rows<{ hits: number }>("select hits from rate_limit_buckets where bucket_key = $1 and window_start = $2", [b.key, b.start]))[0]?.hits ?? 0;
  };
  const ideas = '{"ideas":[{"title":"A","angle":"B","kind":"text","callToAction":"C"}]}';

  it("stops a person past their hourly limit, before the model is asked, and says when to try again", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const m = model(ideas);
    await fill(SOCIAL_AI_LIMITS.byUser, s.m.people.sales.id, SOCIAL_AI_LIMITS.byUser.limit);
    const err = await suggestIdeas(s.sales, { accountId: acc.id }, m.deps).catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limited" });
    expect(err.message).toMatch(/Try again in about (a minute|\d+ minutes|\d+ hours)/);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(m.calls).toHaveLength(0);
    // Someone else in the same workspace is not held back by it.
    await expect(suggestIdeas(s.owner, { accountId: acc.id }, m.deps)).resolves.toBeDefined();
    await expect(suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "x" }, m.deps)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("stops a workspace past its daily limit", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const m = model(ideas);
    await fill(SOCIAL_AI_LIMITS.byOrg, s.m.org.id, SOCIAL_AI_LIMITS.byOrg.limit);
    const err = await suggestIdeas(s.owner, { accountId: acc.id }, m.deps).catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limited" });
    expect(err.message).toMatch(/workspace has used today's allowance of \d+ AI drafting requests\. It renews in about/);
    expect(m.calls).toHaveLength(0);
  });

  it("counts each request, and counts nothing for one that was refused before the model", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const m = model('{"options":[{"caption":"A fair caption.","hashtags":[]}]}');
    await expect(suggestCaptions(s.sales, { accountId: acc.id, kind: "text" }, m.deps)).rejects.toThrow(/Say what the post is about/);
    await saveSocialSettings(s.owner, { aiDraftsEnabled: false }, 0);
    await expect(suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "x" }, m.deps)).rejects.toThrow(/switched off/);
    expect(await hitsOf(SOCIAL_AI_LIMITS.byUser, s.m.people.sales.id)).toBe(0);
    await saveSocialSettings(s.owner, { aiDraftsEnabled: true }, 1);
    await suggestCaptions(s.sales, { accountId: acc.id, kind: "text", topic: "x" }, m.deps);
    expect(await hitsOf(SOCIAL_AI_LIMITS.byUser, s.m.people.sales.id)).toBe(1);
    expect(await hitsOf(SOCIAL_AI_LIMITS.byOrg, s.m.org.id)).toBe(1);
  });

  // Replaces the earlier test that recorded each drafting request as a "help request" and stopped at the monthly help allowance. That was a stand-in for metering the
  // model: drafting is now metered like every other model call (src/server/llm/meter.ts), and no longer draws on the allowance the help assistant and the inbox's AI share.
  it("meters each answered request as model usage, bounded by the hourly and daily limits and the credit balance, not by the help allowance", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const withUsage = (usage = { inputTokens: 700, outputTokens: 250 }) => model(ideas, usage);
    await withSystem((db) => db.query("insert into usage_limits (org_id, monthly_help_requests, hard_stop) values ($1, 1, true) on conflict (org_id) do update set monthly_help_requests = 1, hard_stop = true", [s.m.org.id]));
    await suggestIdeas(s.sales, { accountId: acc.id }, withUsage().deps);
    await suggestCaptions(s.owner, { accountId: acc.id, kind: "text", topic: "x" }, model('{"options":[{"caption":"A fair caption.","hashtags":[]}]}', { inputTokens: 300, outputTokens: 120 }).deps);
    // The help allowance is not used up by it, whatever it is set to.
    await suggestIdeas(s.sales, { accountId: acc.id }, withUsage().deps);
    expect(await rows("select 1 from usage_events where org_id = $1", [s.m.org.id])).toHaveLength(0);
    const lines = await rows<{ unit_type: string; quantity: string; job_reference: string; provider_reference: string }>("select unit_type, quantity::text, job_reference, provider_reference from metered_usage_events where org_id = $1 order by id", [s.m.org.id]);
    expect(lines).toHaveLength(6);
    expect(lines.every((l) => l.job_reference === "ai:social_ai" && (l.provider_reference.startsWith(`ai:social_ai:${s.m.people.sales.id}`) || l.provider_reference.startsWith(`ai:social_ai:${s.m.people.owner.id}`)))).toBe(true);
    expect(new Set(lines.map((l) => l.provider_reference)).size).toBe(6); // one reference per call and unit
    expect(lines.map((l) => `${l.unit_type} ${l.quantity}`).sort()).toEqual([
      "ai_tokens_in 300.000000", "ai_tokens_in 700.000000", "ai_tokens_in 700.000000", "ai_tokens_out 120.000000", "ai_tokens_out 250.000000", "ai_tokens_out 250.000000",
    ]);
  });

  it("meters a call that came back unusable (the tokens were spent) and records nothing for a model that never answered", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const empty = { complete: (async () => ({ ok: false, status: 0, usage: { inputTokens: 90, outputTokens: 0 } })) as never, config: async () => CONFIG };
    await expect(suggestIdeas(s.sales, { accountId: acc.id }, empty)).rejects.toThrow(/did not answer/);
    const silent = { complete: (async () => ({ ok: false, status: 500 })) as never, config: async () => CONFIG };
    await expect(suggestIdeas(s.sales, { accountId: acc.id }, silent)).rejects.toThrow(/did not answer/);
    const lines = await rows<{ unit_type: string; quantity: string }>("select unit_type, quantity::text from metered_usage_events where org_id = $1", [s.m.org.id]);
    expect(lines).toEqual([{ unit_type: "ai_tokens_in", quantity: "90.000000" }]);
  });

  it("charges the workspace's credits for the tokens once an AI usage rate is published, and stops when they run out", async () => {
    const s = await socialOrg({ credits: 20 });
    const acc = await connect(s);
    await publishUnitRate(s.m.superAdmin, { provider: "llm", unitType: "ai_tokens_in", wholesaleMicrosPerUnit: 3_000 });
    await publishUnitRate(s.m.superAdmin, { provider: "llm", unitType: "ai_tokens_out", wholesaleMicrosPerUnit: 9_000 });
    const bps = (await withSystem((db) => currentRate(db))).markupBps;
    const expected = applyMarkup(Math.ceil((3_000 * 2000) / 1000), bps) + applyMarkup(Math.ceil((9_000 * 500) / 1000), bps);
    const before = (await withSystem((db) => getBalance(db, s.m.org.id))).availableMicros;
    await suggestIdeas(s.sales, { accountId: acc.id }, model(ideas, { inputTokens: 2000, outputTokens: 500 }).deps);
    expect(before - (await withSystem((db) => getBalance(db, s.m.org.id))).availableMicros).toBe(expected);
    // Out of credits: refused before the model is asked.
    const broke = await socialOrg({ credits: 0 });
    const brokeAcc = await connect(broke);
    const m = model(ideas, { inputTokens: 1, outputTokens: 1 });
    await expect(suggestIdeas(broke.sales, { accountId: brokeAcc.id }, m.deps)).rejects.toThrow(/credits have run out/);
    expect(m.calls).toHaveLength(0);
  });
});
