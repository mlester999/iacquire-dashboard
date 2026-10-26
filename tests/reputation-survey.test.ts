// Satisfaction surveys on the customer's page: a request is a review request or a survey, on a one-to-five or a zero-to-ten scale. The request decides the scale, never the form.
// One answer per link, the same low-feedback follow-up for either scale, the same public links, and no offers in the wording. Synthetic workspaces on embedded Postgres: messages
// are queued, never dispatched, and nothing contacts a provider.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/r/token",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("not found");
  },
  redirect: () => {
    throw new Error("redirect");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath() {} }));

import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { createTemplate, approveTemplate } from "@/server/crm/message-templates";
import { getReviewStats, listFeedback, listReviewDestinations, listReviewRequests, loadReviewPage, previewReviewRequest, requestReview, setReviewDestinationActive, submitReviewFeedback } from "@/server/crm/reviews";
import { getReputationSettings, saveReputationSettings } from "@/server/reputation/settings";
import { POST as feedbackRoute } from "@/app/api/public/reviews/feedback/route";
import ReviewRequestPage from "@/app/r/[token]/page";
import { eventsFor } from "./support/crm";
import { ask, askSurvey, all, count, giveSurveyFeedback, one, reputationShop, shopCustomer, tokenOf, type ReputationShop } from "./support/reputation";

const render = async (token: string, r?: string) => renderToStaticMarkup(await ReviewRequestPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(r ? { r } : {}) }));
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&apos;|&#x27;/g, "'").replace(/\s+/g, " ").trim();
const feedbackRow = (id: string) => one<{ rating: number | null; nps_score: number | null; scale: string; low_score: boolean; follow_up_status: string; escalated_task_id: string | null; comment: string | null }>("select * from customer_feedback where id = $1", [id]);
const expectError = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (message) expect((err as AppError).message).toMatch(message);
};

let s: ReputationShop;
beforeAll(async () => {
  s = await reputationShop("Survey Shop");
});

describe("a request is a review request or a survey", () => {
  it("records its kind and scale, defaults to a review request on the one-to-five scale, and says so in the list, the event and the timeline", async () => {
    const plain = await ask(s, await shopCustomer(s));
    expect(await one("select kind, scale from crm_review_requests where id = $1", [plain.requestId])).toEqual({ kind: "review", scale: "csat5" });
    const csat = await askSurvey(s, await shopCustomer(s), "csat5");
    const nps = await askSurvey(s, await shopCustomer(s), "nps10");
    expect(await one("select kind, scale from crm_review_requests where id = $1", [csat.requestId])).toEqual({ kind: "survey", scale: "csat5" });
    expect(await one("select kind, scale, requested_via from crm_review_requests where id = $1", [nps.requestId])).toEqual({ kind: "survey", scale: "nps10", requested_via: "manual" });

    const listed = (await listReviewRequests(s.owner, { pageSize: 100 })).rows;
    expect(listed.find((r) => r.id === nps.requestId)).toMatchObject({ kind: "survey", scale: "nps10" });
    expect(listed.find((r) => r.id === plain.requestId)).toMatchObject({ kind: "review", scale: "csat5" });
    const ev = (await eventsFor(s.m.org.id, "review.requested")).find((e) => e.entity_id === nps.requestId)!;
    expect(ev.payload).toMatchObject({ kind: "survey", scale: "nps10", via: "manual" });
    expect(await one<{ summary: string }>("select summary from crm_activities where org_id = $1 and ref_id = $2 and kind = 'review.requested'", [s.m.org.id, nps.requestId])).toEqual({ summary: "Survey requested by SMS" });
    expect(await one<{ summary: string }>("select summary from crm_activities where org_id = $1 and ref_id = $2 and kind = 'review.requested'", [s.m.org.id, plain.requestId])).toEqual({ summary: "Review requested by SMS" });
  });

  it("refuses a kind or scale that does not exist, before anything is created", async () => {
    const contactId = await shopCustomer(s);
    const bad = (extra: Record<string, unknown>) => requestReview(s.owner, { contactId, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, ...extra } as never);
    await expectError(bad({ kind: "poll" }), "invalid_input", /review request or a survey/);
    await expectError(bad({ kind: "survey", scale: "stars" }), "invalid_input", /scale/);
    expect(await count("select count(*)::text as n from crm_review_requests where contact_id = $1", [contactId])).toBe(0);
  });

  it("only an owner or manager of the client's workspace can send one, a survey as well as a review request", async () => {
    const contactId = await shopCustomer(s);
    await expectError(requestReview(s.sales, { contactId, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, kind: "survey" }), "forbidden");
    await expectError(requestReview(s.viewer, { contactId, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, kind: "survey" }), "forbidden");
    expect((await requestReview(s.manager, { contactId, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, kind: "survey", scale: "nps10" })).requestId).toBeTruthy();
  });

  it("shares one cool-down across both kinds: a customer who was sent a survey is not also sent a review request that month", async () => {
    const contactId = await shopCustomer(s);
    await askSurvey(s, contactId);
    await expectError(ask(s, contactId), "conflict", /already asked/);
    await expectError(askSurvey(s, contactId, "nps10"), "conflict", /already asked/);
  });
});

describe("answering on the zero-to-ten scale", () => {
  it("stores the score as a recommend score with no star rating, and treats a zero as an answer", async () => {
    const g = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { rating: "9", comment: "Would tell my sister." });
    expect(g.result).toMatchObject({ outcome: "saved", escalated: false });
    expect(await feedbackRow(g.result.feedbackId!)).toMatchObject({ rating: null, nps_score: 9, scale: "nps10", low_score: false, follow_up_status: "new", comment: "Would tell my sister." });
    // A zero is the lowest answer, not "nothing chosen".
    const zero = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { rating: "0" });
    expect(zero.result).toMatchObject({ outcome: "saved", escalated: true });
    expect(await feedbackRow(zero.result.feedbackId!)).toMatchObject({ rating: null, nps_score: 0, low_score: true });
    // Neither a score nor a word is nothing.
    const empty = await askSurvey(s, await shopCustomer(s), "nps10");
    expect(await submitReviewFeedback(empty.token, {})).toEqual({ outcome: "empty" });
    expect(await submitReviewFeedback(empty.token, { rating: "" })).toEqual({ outcome: "empty" });
  });

  it("takes the scale from the request, never from the form: a number that does not exist on that scale is refused and nothing is saved", async () => {
    const stars = await askSurvey(s, await shopCustomer(s), "csat5");
    const tenths = await askSurvey(s, await shopCustomer(s), "nps10");
    for (const bad of ["0", "6", "7", "10", "-1", "2.5", "abc"]) expect(await submitReviewFeedback(stars.token, { rating: bad }), `1 to 5 got ${bad}`).toEqual({ outcome: "invalid" });
    for (const bad of ["11", "-1", "2.5", "abc", "100"]) expect(await submitReviewFeedback(tenths.token, { rating: bad }), `0 to 10 got ${bad}`).toEqual({ outcome: "invalid" });
    expect(await count("select count(*)::text as n from customer_feedback where review_request_id = any($1::uuid[])", [[stars.requestId, tenths.requestId]])).toBe(0);
    // The same numbers are fine where they belong, once each.
    expect(await submitReviewFeedback(stars.token, { rating: "5" })).toMatchObject({ outcome: "saved" });
    expect(await submitReviewFeedback(tenths.token, { rating: "10" })).toMatchObject({ outcome: "saved" });
    expect(await feedbackRow((await one<{ id: string }>("select id from customer_feedback where review_request_id = $1", [stars.requestId])).id)).toMatchObject({ rating: 5, nps_score: null, scale: "csat5" });
  });

  it("takes one answer per link, and nothing after the link expired or was cancelled", async () => {
    const a = await askSurvey(s, await shopCustomer(s), "nps10");
    expect(await submitReviewFeedback(a.token, { rating: "8" })).toMatchObject({ outcome: "saved" });
    expect(await submitReviewFeedback(a.token, { rating: "2" })).toEqual({ outcome: "already" });
    expect(await count("select count(*)::text as n from customer_feedback where review_request_id = $1", [a.requestId])).toBe(1);
    const old = await askSurvey(s, await shopCustomer(s), "nps10");
    await withSystem((db) => db.query("update crm_review_requests set expires_at = now() - interval '1 minute' where id = $1", [old.requestId]));
    expect(await submitReviewFeedback(old.token, { rating: "8" })).toEqual({ outcome: "closed" });
  });

  it("limits how often one link takes an answer, wrong ones included", async () => {
    // A 7 is a number the form may post, but not one a one-to-five request accepts: each try is refused, and counted.
    const a = await askSurvey(s, await shopCustomer(s), "csat5");
    const results = [];
    for (let i = 0; i < 12; i += 1) results.push((await submitReviewFeedback(a.token, { rating: "7" })).outcome);
    expect(results.slice(0, 10).every((o) => o === "invalid")).toBe(true);
    expect(results.slice(10)).toEqual(["rate_limited", "rate_limited"]);
  });

  it("judges a comment with no score on either scale by what it says", async () => {
    const angry = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { comment: "This was unacceptable. I want to complain." });
    expect(angry.result).toMatchObject({ outcome: "saved", escalated: true });
    expect(await feedbackRow(angry.result.feedbackId!)).toMatchObject({ rating: null, nps_score: null, scale: "nps10", low_score: true });
    const fine = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { comment: "No complaints at all, thank you." });
    expect(fine.result).toMatchObject({ outcome: "saved", escalated: false });
  });
});

describe("low recommend scores open the same follow-up as low ratings", () => {
  it("treats 0 to 6 as low by default and 7 as fine, and says the score in the task, the notice and the escalation without repeating what the customer wrote", async () => {
    for (const [score, low] of [[0, true], [6, true], [7, false], [10, false]] as const) {
      const g = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { rating: score, comment: score === 6 ? "The secret waiting room story." : undefined });
      expect(g.result, `score ${score}`).toMatchObject({ outcome: "saved", escalated: low });
      const f = await feedbackRow(g.result.feedbackId!);
      expect(f.low_score, `score ${score}`).toBe(low);
      expect(Boolean(f.escalated_task_id), `score ${score}`).toBe(low);
      if (score !== 6) continue;
      const task = await one<{ title: string; description: string; priority: string }>("select title, description, priority from tasks where id = $1", [f.escalated_task_id]);
      expect(task.title).toMatch(/feedback \(6 of 10\)/);
      expect(task.priority).toBe("high");
      expect(task.description).toContain("6 of 10");
      expect(task.description).toContain("secret waiting room story");
      const notes = await all<{ title: string; body: string }>("select title, body from notifications where org_id = $1 and dedupe_key = $2", [s.m.org.id, `feedback-low:${g.result.feedbackId}`]);
      expect(notes).toHaveLength(2);
      for (const n of notes) expect(`${n.title} ${n.body}`).not.toMatch(/secret waiting room/);
      expect(notes[0].title).toContain("(6 of 10)");
      const esc = await one<{ summary: string; category: string }>("select e.summary, e.category from human_escalations e join customer_feedback f on f.escalation_id = e.id where f.id = $1", [g.result.feedbackId]);
      expect(esc).toMatchObject({ category: "complaint" });
      expect(esc.summary).toContain("6 of 10");
      expect(esc.summary).not.toMatch(/secret/);
      const ev = (await eventsFor(s.m.org.id, "feedback.escalated")).find((e) => e.entity_id === g.result.feedbackId)!;
      expect(JSON.stringify(ev.payload)).not.toMatch(/"rating"|"comment"|"npsScore"|secret/);
    }
  });

  it("uses the workspace's own detractor level when it was chosen, and keeps the decision made when each answer arrived", async () => {
    const before = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { rating: 6 });
    expect((await feedbackRow(before.result.feedbackId!)).low_score).toBe(true);
    const cur = await getReputationSettings(s.owner);
    await saveReputationSettings(s.owner, { npsDetractorMax: 4 }, cur.version);
    const after = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { rating: 6 });
    expect(after.result).toMatchObject({ outcome: "saved", escalated: false });
    expect((await feedbackRow(after.result.feedbackId!)).low_score).toBe(false);
    const four = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { rating: 4 });
    expect(four.result.escalated).toBe(true);
    // The earlier answer is still low: a changed threshold never rewrites history.
    expect((await feedbackRow(before.result.feedbackId!)).low_score).toBe(true);
    await saveReputationSettings(s.owner, { npsDetractorMax: 6 }, (await getReputationSettings(s.owner)).version);
  });

  it("lists the answer on either scale with its score, and counts both in the numbers", async () => {
    const stats = await getReviewStats(s.owner);
    expect(stats.feedback.npsAnswers).toBeGreaterThan(0);
    expect(stats.feedback.count).toBeGreaterThanOrEqual(stats.feedback.rated + stats.feedback.npsAnswers);
    const all =(await listFeedback(s.owner, { filter: "all", pageSize: 100 })).rows;
    expect(all.some((f) => f.scale === "nps10" && f.npsScore === 9 && f.rating === null)).toBe(true);
    expect(all.some((f) => f.scale === "csat5" && f.rating === 5 && f.npsScore === null)).toBe(true);
  });
});

describe("the customer's page", () => {
  it("asks the one-to-five question on a one-to-five request and the recommend question on a zero-to-ten one, as plain radio buttons that post without JavaScript", async () => {
    const stars = await askSurvey(s, await shopCustomer(s), "csat5");
    const tenths = await askSurvey(s, await shopCustomer(s), "nps10");
    const starsHtml = await render(stars.token);
    const tenthsHtml = await render(tenths.token);
    expect(starsHtml).toContain("How was your experience?");
    expect(starsHtml).not.toContain("recommend");
    const radios = (html: string) => [...html.matchAll(/<input[^>]*name="rating"[^>]*>/g)].map((m) => ({ type: m[0].match(/type="(\w+)"/)?.[1], value: m[0].match(/value="(\d+)"/)?.[1] }));
    expect(radios(starsHtml)).toEqual(["1", "2", "3", "4", "5"].map((value) => ({ type: "radio", value })));
    expect(textOf(tenthsHtml)).toContain("How likely are you to recommend Survey Shop to a friend or colleague?");
    expect(tenthsHtml).not.toContain("How was your experience?");
    expect(radios(tenthsHtml)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].map((value) => ({ type: "radio", value })));
    expect(textOf(tenthsHtml)).toContain("0 is not at all likely");
    expect(textOf(tenthsHtml)).toContain("10 is extremely likely");
    // Both forms post to the same address with the token, and a comment box; the answer works with no script.
    for (const html of [starsHtml, tenthsHtml]) {
      expect(html).toContain('action="/api/public/reviews/feedback" method="post"');
      expect(html).toContain('name="t"');
      expect(html).toContain('name="comment"');
      expect(html).not.toContain("<script");
    }
  });

  it("saves an answer posted from the form, sends the customer back to their page, and refuses a number outside the request's scale", async () => {
    const form = (fields: Record<string, string>) => ({ method: "POST", body: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    const a = await askSurvey(s, await shopCustomer(s), "nps10");
    const bad = await feedbackRoute(new Request("http://localhost/api/public/reviews/feedback", form({ t: a.token, rating: "11" })));
    expect(bad.headers.get("location")).toBe(`/r/${a.token}?r=invalid`);
    const saved = await feedbackRoute(new Request("http://localhost/api/public/reviews/feedback", form({ t: a.token, rating: "9", comment: "Great." })));
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/r/${a.token}?r=saved`);
    expect(await one("select nps_score, rating, comment, scale from customer_feedback where review_request_id = $1", [a.requestId])).toEqual({ nps_score: 9, rating: null, comment: "Great.", scale: "nps10" });
  });

  it("shows the same public review links on a survey as on a review request, and the survey's private question only to someone who has not answered", async () => {
    const want = (await listReviewDestinations(s.owner)).filter((d) => d.active).map((d) => d.label);
    expect(want.length).toBeGreaterThan(1);
    const review = await ask(s, await shopCustomer(s));
    const survey = await askSurvey(s, await shopCustomer(s), "nps10");
    const answered = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { rating: 2 });
    const panel = (html: string, token: string) => html.replaceAll(token, "TOKEN").match(/<section aria-labelledby="public-reviews"[\s\S]*?<\/section>/)?.[0];
    const a = panel(await render(review.token), review.token);
    expect(a).toBeTruthy();
    expect(panel(await render(survey.token), survey.token)).toBe(a);
    expect(panel(await render(answered.token, "saved"), answered.token)).toBe(a);
    for (const label of want) expect(a).toContain(label);
    expect((await loadReviewPage(survey.token)).destinations.map((d) => d.label)).toEqual(want);
    expect(await render(answered.token, "saved")).not.toContain('name="rating"');
  });

  it("tells a recommend score's follow-up in one sentence and nothing else: a 0 and a 10 differ only by that sentence", async () => {
    const zero = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { rating: 0, comment: "Poor." });
    const ten = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { rating: 10, comment: "Lovely." });
    const FOLLOW_UP = " Someone from Survey Shop will also follow up with you privately.";
    for (const r of ["saved", undefined]) {
      const lowHtml = (await render(zero.token, r)).replaceAll(zero.token, "TOKEN");
      const highHtml = (await render(ten.token, r)).replaceAll(ten.token, "TOKEN");
      expect(lowHtml.includes(FOLLOW_UP), `low, r=${r}`).toBe(true);
      expect(highHtml.includes("follow up with you"), `high, r=${r}`).toBe(false);
      expect(lowHtml.replace(FOLLOW_UP, ""), `r=${r}`).toBe(highHtml);
    }
  });
});

describe("a survey for a business with no public review site yet", () => {
  it("can be sent, shows only its question, and a review request still needs the links it is for", async () => {
    const t = await reputationShop("Survey No Links");
    // A review request sent while the links existed keeps its panel when they are all hidden later, and says there are none: only a survey leaves the panel out.
    const early = await ask(t, await shopCustomer(t));
    for (const d of await listReviewDestinations(t.owner)) await setReviewDestinationActive(t.owner, d.id, false);
    const earlyHtml = await render(early.token);
    expect(earlyHtml).toContain("Leave a public review");
    expect(earlyHtml).toContain("hasn&#x27;t added a public review site yet.");
    const contactId = await shopCustomer(t);
    // The preview says what the page will hold and lets a survey through; a review request is refused with the reason.
    const forSurvey = await previewReviewRequest(t.owner, { contactId, templateId: t.smsTemplate.id, kind: "survey" });
    expect(forSurvey.canSend).toBe(true);
    expect(forSurvey.checks.find((c) => c.label === "Public review links")).toMatchObject({ ok: true });
    const forReview = await previewReviewRequest(t.owner, { contactId, templateId: t.smsTemplate.id });
    expect(forReview.canSend).toBe(false);
    expect(forReview.problem).toMatch(/at least one public review link/);
    await expectError(requestReview(t.owner, { contactId, templateId: t.smsTemplate.id, contentHash: t.smsTemplate.contentHash }), "conflict", /public review link/);

    const survey = await askSurvey(t, contactId, "nps10");
    const html = await render(survey.token);
    expect(html).not.toContain("Leave a public review");
    expect(html).not.toContain("hasn&#x27;t added a public review site");
    expect(textOf(html)).toContain("How likely are you to recommend");
    expect(await submitReviewFeedback(survey.token, { rating: "3" })).toMatchObject({ outcome: "saved", escalated: true });
    expect(await render(survey.token, "saved")).not.toContain("Leave a public review");
  });
});

describe("no offers in a review request's wording (rule R4)", () => {
  it("refuses to save a review-request template that offers something, or asks for a rating, and approves a plain one", async () => {
    await expectError(
      createTemplate(s.owner, { name: "Offer", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, leave a review for 10% off your next visit {{review.link}}" }),
      "invalid_input", /Remove “10% off”/,
    );
    await expectError(
      createTemplate(s.owner, { name: "Steer", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, a 5-star review please {{review.link}}" }),
      "invalid_input", /honest review/,
    );
    const ok = await createTemplate(s.owner, { name: "Plain ask", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, feel free to tell us how it went: {{review.link}}" });
    expect((await approveTemplate(s.owner, ok.id, { version: ok.currentVersion, contentHash: ok.contentHash })).status).toBe("approved");
    // The same words are fine in a message that carries no review link.
    expect((await createTemplate(s.owner, { name: "Coupon note", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, your free coffee voucher is at the desk." })).status).toBe("draft");
  });

  it("stops a request from being sent with wording that got in some other way, for a person, a preview and a workflow alike", async () => {
    const t = await createTemplate(s.owner, { name: "Older ask", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, how did we do? {{review.link}}" });
    const approved = await approveTemplate(s.owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    // Wording approved before the rule existed: the stored version is rewritten directly (it is frozen for everyone else).
    await withSystem(async (db) => {
      await db.query("alter table crm_message_template_versions disable trigger crm_message_template_versions_frozen");
      try {
        await db.query("update crm_message_template_versions set body = 'Hi {{contact.first_name}}, review us and get a free gift {{review.link}}' where template_id = $1", [t.id]);
      } finally {
        await db.query("alter table crm_message_template_versions enable trigger crm_message_template_versions_frozen");
      }
    });
    const contactId = await shopCustomer(s);
    const preview = await previewReviewRequest(s.owner, { contactId, templateId: t.id });
    expect(preview.canSend).toBe(false);
    expect(preview.problem).toMatch(/Remove “free”/);
    expect(preview.checks.find((c) => c.label === "Wording")).toMatchObject({ ok: false });
    await expectError(requestReview(s.owner, { contactId, templateId: t.id, contentHash: approved.contentHash }), "conflict", /Remove “free”/);
    expect(await count("select count(*)::text as n from crm_review_requests where contact_id = $1", [contactId])).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("never lets one workspace's link accept, read or change another's answers", async () => {
    const other = await reputationShop("Other Survey Shop");
    const mine = await giveSurveyFeedback(s, await shopCustomer(s), "nps10", { rating: 3 });
    const theirs = await giveSurveyFeedback(other, await shopCustomer(other), "nps10", { rating: 9 });
    expect((await listFeedback(other.owner, { filter: "all", pageSize: 100 })).rows.map((f) => f.id)).not.toContain(mine.result.feedbackId);
    expect((await listFeedback(s.owner, { filter: "all", pageSize: 100 })).rows.map((f) => f.id)).not.toContain(theirs.result.feedbackId);
    expect((await listReviewRequests(other.owner, { pageSize: 100 })).rows.map((r) => r.id)).not.toContain(mine.requestId);
    // A token is the whole authorization, and it belongs to one request in one workspace.
    expect(await tokenOf(mine.requestId)).not.toBe(await tokenOf(theirs.requestId));
    expect(await submitReviewFeedback(theirs.token, { rating: "1" })).toEqual({ outcome: "already" });
    expect(await feedbackRow(mine.result.feedbackId!)).toMatchObject({ nps_score: 3 });
  });
});
