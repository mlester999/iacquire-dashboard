// A public survey form knows who someone is only by the email or phone they typed, and anyone can type anyone's. So an answer that matches an EXISTING customer only by what was
// typed is not that customer's own: it is stored with no customer and the possible match beside it, and nothing happens about the customer (no timeline entry, no event, no stop to
// their programs, no named count, no task in their name) until a person confirms the match. An address the business has verified for the customer, and a customer the submission
// itself created, are attributed as before. Synthetic workspaces on embedded Postgres.
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} }),
  usePathname: () => "/crm/forms",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

import { withSystem } from "@/server/db";
import { emptyDraft, type FormDraft, type FormQuestion } from "@/lib/crm/forms/spec";
import { createForm, getForm, publishForm, saveFormDraft, updateFormSettings } from "@/server/crm/forms/definitions";
import { processFormSubmissions } from "@/server/crm/forms/process";
import { handleHostedSubmit, hostedFormToken, type PublicRequestMeta } from "@/server/crm/forms/public";
import type { RawFields } from "@/lib/crm/forms/logic";
import { listFeedback } from "@/server/crm/reviews";
import { mergeContacts, redactContact } from "@/server/messaging/contacts";
import { confirmSurveyMatch, dismissSurveyMatch } from "@/server/reputation/survey-feedback";
import { getSatisfaction } from "@/server/reputation/analytics";
import { answersIn } from "@/lib/reputation/satisfaction";
import { enrollEligible } from "@/server/retention/engine";
import { markCustomer, setProgramEnabled } from "@/server/retention/service";
import { eventsFor } from "./support/crm";
import { all, one, reputationShop, shopCustomer, type ReputationShop } from "./support/reputation";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = new Date();
const CONSENT = "I agree to be contacted by email, phone or text message about my enquiry.";
const q = (key: string, over: Partial<FormQuestion> & Pick<FormQuestion, "type">): FormQuestion => ({ key, label: key.replace(/_/g, " "), required: false, ...over });
const raw = (o: Record<string, string>): RawFields => new Map(Object.entries(o).map(([k, v]) => [k, [v]]));
let ipN = 0;
const visitor = (): PublicRequestMeta => ({ origin: "https://app.example.test", host: "app.example.test", secFetchSite: "same-origin", ip: `198.51.100.${(ipN = (ipN % 250) + 1)}`, now: NOW });
const surveyDraft = (): FormDraft => ({
  ...emptyDraft("survey"),
  questions: [
    q("score", { type: "number", label: "How would you rate us?", required: true, validation: { min: 1, max: 5, integer: true }, map: "feedback.rating" }),
    q("comment", { type: "long_text", label: "Anything else?", map: "feedback.comment" }),
    q("email", { type: "email", label: "Your email, if you'd like a reply", map: "contact.email" }),
  ],
  consent: { text: CONSENT, marketing: { enabled: false, text: "" } },
});

let s: ReputationShop;
let other: ReputationShop;
let survey: { id: string; key: string };
let nth = 0;

async function liveSurvey(shop: ReputationShop, name: string) {
  const f = await createForm(shop.owner, { name, kind: "survey" });
  const cur = await getForm(shop.owner, f.id);
  await saveFormDraft(shop.owner, f.id, { draft: surveyDraft(), expectedRevision: cur.draftRevision });
  await updateFormSettings(shop.owner, f.id, { hosted: true });
  await publishForm(shop.owner, f.id);
  return f;
}
async function submit(shop: ReputationShop, key: string, answers: Record<string, string>) {
  nth += 1;
  const r = await handleHostedSubmit(visitor(), raw({ org: shop.m.org.slug, key, t: hostedFormToken(shop.m.org.slug, key, NOW.getTime() - 10_000 - nth), consent: "yes", ...answers }));
  expect(r).toMatchObject({ ok: true });
  await processFormSubmissions({ now: NOW, limit: 50 });
}
const feedbackFor = (formId: string, comment: string) =>
  one<{ id: string; contact_id: string | null; possible_contact_id: string | null; low_score: boolean; follow_up_status: string; escalated_task_id: string | null; rating: number | null; comment: string | null }>(
    "select f.* from customer_feedback f join crm_form_submissions s on s.id = f.form_submission_id where s.form_id = $1 and f.comment = $2", [formId, comment],
  );
const customer = async (email: string, firstName = "Elena") => ({ id: await shopCustomer(s, { firstName, email }), email });
const eventsOn = async (type: string, contactId: string) => (await eventsFor(s.m.org.id, type)).filter((e) => e.contact_id === contactId);
const activities = (contactId: string) => all<{ kind: string }>("select kind from crm_activities where org_id = $1 and contact_id = $2 and kind in ('feedback.received', 'feedback.escalated')", [s.m.org.id, contactId]);
const tasksFor = (contactId: string) => all<{ id: string }>("select id from tasks where org_id = $1 and contact_id = $2 and title like 'Follow up on%'", [s.m.org.id, contactId]);
const matchNotes = (feedbackId: string) => all<{ title: string; body: string; kind: string; link: string }>("select title, body, kind, link from notifications where org_id = $1 and dedupe_key = $2", [s.m.org.id, `feedback-match:${feedbackId}`]);
const enrollments = (contactId: string) => all<{ status: string; cancel_reason: string | null }>("select status, cancel_reason from retention_enrollments where contact_id = $1", [contactId]);
const verify = (contactId: string) => withSystem((db) => db.query("update contact_identities set verified = true, verified_via = 'staff_confirmed' where contact_id = $1 and kind = 'email'", [contactId]));
async function enrolled(email: string) {
  const c = await customer(email);
  await markCustomer(s.m.ctx("sales"), c.id);
  await enrollEligible();
  expect(await enrollments(c.id)).toEqual([{ status: "active", cancel_reason: null }]);
  return c;
}

beforeAll(async () => {
  s = await reputationShop("Survey Match Shop");
  other = await reputationShop("Other Survey Match Shop");
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'crm_manager'", [s.m.org.id]));
  await setProgramEnabled(s.m.ctx("owner"), "onboarding_checkin", true);
  survey = await liveSurvey(s, "How did we do");
});

describe("an answer typed next to an existing customer's unverified address", () => {
  it("is stored with no customer and the possible match beside it, and does nothing at all about that customer", async () => {
    const c = await enrolled("unverified.low@example.test");
    await submit(s, survey.key, { "q.score": "1", "q.comment": "Forged: the wait was far too long.", "q.email": c.email });
    const f = await feedbackFor(survey.id, "Forged: the wait was far too long.");
    expect(f).toMatchObject({ contact_id: null, possible_contact_id: c.id, rating: 1, low_score: true, follow_up_status: "new", escalated_task_id: null });
    // Nothing about the customer: no event by them, no timeline line, no task in their name, and their program keeps running.
    expect(await eventsOn("feedback.received", c.id)).toEqual([]);
    expect(await eventsOn("feedback.escalated", c.id)).toEqual([]);
    expect(await activities(c.id)).toEqual([]);
    expect(await tasksFor(c.id)).toEqual([]);
    expect(await enrollments(c.id)).toEqual([{ status: "active", cancel_reason: null }]);
    expect(await all("select 1 from notifications where org_id = $1 and dedupe_key = $2", [s.m.org.id, `feedback-low:${f.id}`])).toEqual([]);
    // The team is asked to check, without the customer's words, and the customer's own details are untouched.
    const notes = await matchNotes(f.id);
    expect(notes.length).toBeGreaterThanOrEqual(2); // the owner and a manager
    for (const n of notes) {
      expect(n).toMatchObject({ kind: "retention_attention", link: "/crm/reviews?tab=feedback" });
      expect(n.title).toMatch(/A low survey answer may be from Elena .* \(1 of 5\)/);
      expect(`${n.title} ${n.body}`).not.toMatch(/Forged|wait was far/);
      expect(n.body).toMatch(/nobody has confirmed/);
    }
    expect(await one("select email::text as email from contacts where id = $1", [c.id])).toEqual({ email: c.email });
  });

  it("does not count as the customer's own answer in the numbers: it is reported with the answers that knew nobody", async () => {
    const before = await getSatisfaction(s.owner, { days: 30 });
    const c = await customer("unverified.count@example.test");
    await submit(s, survey.key, { "q.score": "2", "q.comment": "Counted apart.", "q.email": c.email });
    const after = await getSatisfaction(s.owner, { days: 30 });
    expect(answersIn(after.named)).toBe(answersIn(before.named));
    expect(answersIn(after.anonymous)).toBe(answersIn(before.anonymous) + 1);
  });

  it("is shown to the team as a possible match, with the customer's name, until a person decides", async () => {
    const c = await customer("unverified.list@example.test", "Marisol");
    await submit(s, survey.key, { "q.score": "3", "q.comment": "Listed with a possible match.", "q.email": c.email });
    const f = await feedbackFor(survey.id, "Listed with a possible match.");
    const row = (await listFeedback(s.owner, { filter: "all", pageSize: 100 })).rows.find((r) => r.id === f.id)!;
    expect(row).toMatchObject({ contact: null, source: "survey", possibleContact: { id: c.id, name: expect.stringContaining("Marisol") } });
  });

  it("stores a good answer the same way, and tells nobody, because there is nothing to follow up", async () => {
    const c = await customer("unverified.high@example.test");
    await submit(s, survey.key, { "q.score": "5", "q.comment": "Lovely, quiet and quick.", "q.email": c.email });
    const f = await feedbackFor(survey.id, "Lovely, quiet and quick.");
    expect(f).toMatchObject({ contact_id: null, possible_contact_id: c.id, low_score: false });
    expect(await matchNotes(f.id)).toEqual([]);
    expect(await eventsOn("feedback.received", c.id)).toEqual([]);
    expect(await activities(c.id)).toEqual([]);
  });
});

describe("an answer the survey can attribute", () => {
  it("is attributed to a customer whose typed address the business has verified, with the usual follow-up", async () => {
    const c = await enrolled("verified.low@example.test");
    await verify(c.id);
    await submit(s, survey.key, { "q.score": "1", "q.comment": "Verified address, low score.", "q.email": c.email });
    const f = await feedbackFor(survey.id, "Verified address, low score.");
    expect(f).toMatchObject({ contact_id: c.id, possible_contact_id: null, low_score: true, follow_up_status: "escalated" });
    expect(f.escalated_task_id).toBeTruthy();
    expect(await eventsOn("feedback.received", c.id)).toHaveLength(1);
    expect(await enrollments(c.id)).toEqual([{ status: "cancelled", cancel_reason: "negative_feedback" }]);
    expect(await matchNotes(f.id)).toEqual([]);
  });

  it("is attributed to a customer the submission itself created: there was no one else to mistake it for", async () => {
    await submit(s, survey.key, { "q.score": "1", "q.comment": "Brand new customer.", "q.email": "brand.new.person@example.test" });
    const f = await feedbackFor(survey.id, "Brand new customer.");
    const created = await one<{ id: string }>("select id from contacts where org_id = $1 and email = 'brand.new.person@example.test'", [s.m.org.id]);
    expect(f).toMatchObject({ contact_id: created.id, possible_contact_id: null });
    expect(f.escalated_task_id).toBeTruthy();
  });
});

describe("a person confirms or dismisses the match", () => {
  it("makes the answer the customer's and only then does what an attributed answer does: event, timeline line, follow-up, and the program stops", async () => {
    const c = await enrolled("confirm.me@example.test");
    await submit(s, survey.key, { "q.score": "1", "q.comment": "Please check it is you.", "q.email": c.email });
    const f = await feedbackFor(survey.id, "Please check it is you.");
    const out = await confirmSurveyMatch(s.owner, f.id);
    expect(out).toEqual({ contactId: c.id });
    expect(await feedbackFor(survey.id, "Please check it is you.")).toMatchObject({ contact_id: c.id, possible_contact_id: null, low_score: true, follow_up_status: "escalated" });
    expect((await eventsOn("feedback.received", c.id)).map((e) => e.payload)).toEqual([expect.objectContaining({ source: "survey", feedbackId: f.id, rating: 1 })]);
    expect((await activities(c.id)).map((a) => a.kind).sort()).toEqual(["feedback.escalated", "feedback.received"]);
    const tasks = await tasksFor(c.id);
    expect(tasks).toHaveLength(1);
    expect((await one<{ description: string }>("select description from tasks where id = $1", [tasks[0].id])).description).toMatch(/in the survey/);
    expect(await enrollments(c.id)).toEqual([{ status: "cancelled", cancel_reason: "negative_feedback" }]);
    expect(await all("select 1 from audit_logs where org_id = $1 and action = 'crm.survey_match_confirmed' and target_id = $2", [s.m.org.id, f.id])).toHaveLength(1);
    // It counts as the customer's own answer from now on, and cannot be confirmed twice.
    const list = (await listFeedback(s.owner, { filter: "all", pageSize: 100 })).rows.find((r) => r.id === f.id)!;
    expect(list).toMatchObject({ contact: { id: c.id }, possibleContact: null });
    await expect(confirmSurveyMatch(s.owner, f.id)).rejects.toMatchObject({ code: "conflict" });
    expect(await eventsOn("feedback.received", c.id)).toHaveLength(1);
  });

  it("keeps an answer anonymous when a person says it is not the customer, and still does nothing about the customer", async () => {
    const c = await enrolled("not.them@example.test");
    await submit(s, survey.key, { "q.score": "2", "q.comment": "Somebody else typed this.", "q.email": c.email });
    const f = await feedbackFor(survey.id, "Somebody else typed this.");
    await dismissSurveyMatch(s.manager, f.id);
    expect(await feedbackFor(survey.id, "Somebody else typed this.")).toMatchObject({ contact_id: null, possible_contact_id: null, low_score: true });
    expect(await eventsOn("feedback.received", c.id)).toEqual([]);
    expect(await activities(c.id)).toEqual([]);
    expect(await enrollments(c.id)).toEqual([{ status: "active", cancel_reason: null }]);
    expect(await all("select 1 from audit_logs where org_id = $1 and action = 'crm.survey_match_dismissed' and target_id = $2", [s.m.org.id, f.id])).toHaveLength(1);
    await expect(dismissSurveyMatch(s.owner, f.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(confirmSurveyMatch(s.owner, f.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("is for the client's owner and managers, and only for their own workspace's answers", async () => {
    const c = await customer("who.may@example.test");
    await submit(s, survey.key, { "q.score": "2", "q.comment": "Who may decide?", "q.email": c.email });
    const f = await feedbackFor(survey.id, "Who may decide?");
    for (const who of [s.sales, s.support, s.viewer]) {
      await expect(confirmSurveyMatch(who, f.id)).rejects.toMatchObject({ code: "forbidden" });
      await expect(dismissSurveyMatch(who, f.id)).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(confirmSurveyMatch(other.owner, f.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(dismissSurveyMatch(other.owner, f.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(confirmSurveyMatch(s.owner, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
    expect(await feedbackFor(survey.id, "Who may decide?")).toMatchObject({ contact_id: null, possible_contact_id: c.id });
    // An answer that was never waiting for anyone is not something to confirm.
    await submit(s, survey.key, { "q.score": "4", "q.comment": "Plain, nobody typed.", "q.email": "plain.new.person@example.test" });
    const plain = await feedbackFor(survey.id, "Plain, nobody typed.");
    await expect(confirmSurveyMatch(s.owner, plain.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("follows the customer into the record they were merged into", async () => {
    const gone = await customer("merged.away@example.test", "Theo");
    const kept = await customer("merged.kept@example.test", "Thea");
    await submit(s, survey.key, { "q.score": "2", "q.comment": "Typed before the merge.", "q.email": gone.email });
    const f = await feedbackFor(survey.id, "Typed before the merge.");
    expect(f.possible_contact_id).toBe(gone.id);
    await mergeContacts(s.owner, { keptId: kept.id, mergedId: gone.id, reason: "Same person, two records." });
    const row = (await listFeedback(s.owner, { filter: "all", pageSize: 100 })).rows.find((r) => r.id === f.id)!;
    expect(row.possibleContact?.id).toBe(kept.id);
    expect(await confirmSurveyMatch(s.owner, f.id)).toEqual({ contactId: kept.id });
    expect(await feedbackFor(survey.id, "Typed before the merge.")).toMatchObject({ contact_id: kept.id, possible_contact_id: null });
  });
});

describe("privacy and tenant isolation", () => {
  it("removes the possible match and the words when the customer's data is erased, and keeps the score for the counts", async () => {
    const c = await customer("erase.possible@example.test");
    await submit(s, survey.key, { "q.score": "1", "q.comment": "My email is erase.possible@example.test and I was unhappy.", "q.email": c.email });
    const f = await feedbackFor(survey.id, "My email is erase.possible@example.test and I was unhappy.");
    await redactContact(s.owner, c.id, "Privacy request received 20 Oct");
    expect(await one("select rating, comment, contact_id, possible_contact_id from customer_feedback where id = $1", [f.id])).toEqual({ rating: 1, comment: null, contact_id: null, possible_contact_id: null });
  });

  it("never lets one workspace's survey answer point at another workspace's customer", async () => {
    const theirs = await shopCustomer(other, { email: "their.customer@example.test" });
    await submit(s, survey.key, { "q.score": "2", "q.comment": "Typed their address in the wrong place.", "q.email": "their.customer@example.test" });
    const f = await feedbackFor(survey.id, "Typed their address in the wrong place.");
    // Here the address is nobody's, so a new customer of this workspace was made; the other workspace's customer is untouched.
    expect(f.possible_contact_id).toBeNull();
    expect((await one<{ org_id: string }>("select org_id from contacts where id = $1", [f.contact_id])).org_id).toBe(s.m.org.id);
    expect(await all("select 1 from customer_feedback where org_id = $1", [other.m.org.id])).toEqual([]);
    await expect(withSystem((db) => db.query("insert into customer_feedback (org_id, possible_contact_id, source, scale, rating) values ($1, $2, 'survey', 'csat5', 3)", [s.m.org.id, theirs]))).rejects.toThrow(/customer_feedback_possible_contact_fk|foreign key/);
  });
});
