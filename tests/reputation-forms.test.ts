// Surveys built as forms can save an answer as private feedback: a rating from 1 to 5, a recommend score from 0 to 10, and a comment. An answer from someone the survey knew goes through
// the same follow-up as an answer given through a link; an answer from someone it did not know stays anonymous and is reported apart. Synthetic workspaces on embedded Postgres.
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
import { draftSchema, emptyDraft, FEEDBACK_TARGETS, isFeedbackTarget, validateDraft, type FormDraft, type FormQuestion } from "@/lib/crm/forms/spec";
import { mapSubmission } from "@/lib/crm/forms/mapping";
import { createForm, getForm, publishForm, saveFormDraft, updateFormSettings } from "@/server/crm/forms/definitions";
import { processFormSubmissions } from "@/server/crm/forms/process";
import { handleHostedSubmit, hostedFormToken, type PublicRequestMeta } from "@/server/crm/forms/public";
import type { RawFields } from "@/lib/crm/forms/logic";
import { createContact } from "@/server/crm/contacts";
import { listFeedback } from "@/server/crm/reviews";
import { redactContact } from "@/server/messaging/contacts";
import { saveSurveyFeedback } from "@/server/reputation/survey-feedback";
import { crmOrg, eventsFor, type CrmOrg } from "./support/crm";
import { setSurveys } from "./support/reputation";

const NOW = new Date("2026-10-20T02:00:00Z");
const CONSENT = "I agree to be contacted by email, phone or text message about my enquiry.";
const q = (key: string, over: Partial<FormQuestion> & Pick<FormQuestion, "type">): FormQuestion => ({ key, label: key.replace(/_/g, " "), required: false, ...over });
const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows[0] as T;
const all = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows as T[];
const raw = (o: Record<string, string | string[]>): RawFields => new Map(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
let ipN = 0;
const visitor = (): PublicRequestMeta => ({ origin: "https://app.example.test", host: "app.example.test", secFetchSite: "same-origin", ip: `198.51.100.${(ipN = (ipN % 250) + 1)}`, now: NOW });

/** The survey most tests use: a 1 to 5 number, a comment, and an optional email. */
const starsDraft = (over: Partial<FormDraft> = {}): FormDraft => ({
  ...emptyDraft("survey"),
  questions: [
    q("score", { type: "number", label: "How would you rate us?", required: true, validation: { min: 1, max: 5, integer: true }, map: "feedback.rating" }),
    q("comment", { type: "long_text", label: "Anything else?", map: "feedback.comment" }),
    q("email", { type: "email", label: "Your email, if you'd like a reply", map: "contact.email" }),
  ],
  consent: { text: CONSENT, marketing: { enabled: false, text: "" } },
  ...over,
});
const tenScore = () => q("score", { type: "single_choice", label: "How likely are you to recommend us?", required: true, display: "radio", options: Array.from({ length: 11 }, (_, n) => ({ value: String(n), label: String(n) })), map: "feedback.nps" });
const tenDraft = (): FormDraft => starsDraft({ questions: [tenScore(), q("email", { type: "email", label: "Your email", map: "contact.email" })] });
/** A survey that asks for no email or phone: it can't know who answered, so it asks for no consent either. (A form that does ask for one requires one.) */
const anonymous = (questions: FormQuestion[]): FormDraft => starsDraft({ questions, consent: { text: "", marketing: { enabled: false, text: "" } } });

describe("survey questions saved as private feedback (rules)", () => {
  const errors = (d: unknown, kind: "form" | "survey" = "survey") => validateDraft(d, null, { kind }).filter((i) => i.level === "error");
  const codes = (d: unknown, kind: "form" | "survey" = "survey") => errors(d, kind).map((i) => i.code);

  it("names three targets and nothing else", () => {
    expect(Object.keys(FEEDBACK_TARGETS)).toEqual(["feedback.rating", "feedback.nps", "feedback.comment"]);
    expect(isFeedbackTarget("feedback.rating")).toBe(true);
    expect(isFeedbackTarget("feedback.score")).toBe(false);
    expect(isFeedbackTarget("contact.email")).toBe(false);
    expect(draftSchema.safeParse(starsDraft()).success).toBe(true);
  });

  it("accepts a survey with a bounded number, numbered choices and a comment", () => {
    expect(errors(starsDraft())).toEqual([]);
    expect(errors(tenDraft())).toEqual([]);
    expect(errors(starsDraft({ questions: [q("score", { type: "single_choice", label: "Rate", display: "radio", options: [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} stars` })), map: "feedback.rating" })] }))).toEqual([]);
  });

  it("refuses feedback targets on a form that is not a survey", () => {
    expect(codes(starsDraft(), "form")).toContain("invalid_map");
    expect(errors(starsDraft(), "form")[0].message).toMatch(/only a survey/);
  });

  it("requires the number to accept exactly the scale's whole numbers, and the choices to be those numbers", () => {
    const withScore = (qs: FormQuestion) => starsDraft({ questions: [qs] });
    for (const validation of [undefined, { min: 1, max: 5 }, { min: 0, max: 5, integer: true }, { min: 1, max: 10, integer: true }, { integer: true }]) {
      const e = errors(withScore(q("score", { type: "number", validation, map: "feedback.rating" })));
      expect(e.map((i) => i.code), JSON.stringify(validation)).toEqual(["invalid_map"]);
      expect(e[0].message).toMatch(/whole numbers from 1 to 5/);
    }
    expect(errors(withScore(q("score", { type: "number", validation: { min: 0, max: 10, integer: true }, map: "feedback.nps" })))).toEqual([]);
    const words = errors(withScore(q("score", { type: "single_choice", options: [{ value: "great", label: "Great" }, { value: "poor", label: "Poor" }], map: "feedback.rating" })));
    expect(words[0].message).toMatch(/each choice needs a stored value that is a whole number from 1 to 5. “Great” has “great”/);
    expect(errors(withScore(q("score", { type: "single_choice", options: [{ value: "6", label: "Six" }], map: "feedback.rating" })))[0].message).toMatch(/“Six” has “6”/);
    expect(errors(withScore(q("score", { type: "single_choice", options: [{ value: "11", label: "Eleven" }], map: "feedback.nps" })))[0].message).toMatch(/0 to 10/);
  });

  it("refuses a type that can't hold the answer, two scores at once, and the same target twice", () => {
    expect(codes(starsDraft({ questions: [q("score", { type: "checkbox", map: "feedback.rating" })] }))).toContain("invalid_map");
    expect(codes(starsDraft({ questions: [q("c", { type: "number", validation: { min: 1, max: 5, integer: true }, map: "feedback.comment" })] }))).toContain("invalid_map");
    const both = starsDraft({ questions: [
      q("a", { type: "number", validation: { min: 1, max: 5, integer: true }, map: "feedback.rating" }),
      q("b", { type: "number", validation: { min: 0, max: 10, integer: true }, map: "feedback.nps" }),
    ] });
    expect(errors(both).map((i) => i.message)).toContain("A survey saves one score as private feedback: choose either the rating from 1 to 5 or the recommend score from 0 to 10.");
    const twice = starsDraft({ questions: [
      q("a", { type: "number", validation: { min: 1, max: 5, integer: true }, map: "feedback.rating" }),
      q("b", { type: "number", validation: { min: 1, max: 5, integer: true }, map: "feedback.rating" }),
    ] });
    expect(codes(twice)).toContain("duplicate_map");
  });

  it("maps answers to feedback and says why an answer could not be used", () => {
    const qs = starsDraft().questions;
    expect(mapSubmission(qs, { score: 4, comment: "  Lovely.  ", email: "a@b.test" }).feedback).toEqual({ scale: "csat5", score: 4, comment: "Lovely.", rejected: [] });
    expect(mapSubmission(qs, { comment: "Only words" }).feedback).toEqual({ scale: null, score: null, comment: "Only words", rejected: [] });
    expect(mapSubmission(qs, { email: "a@b.test" }).feedback).toBeNull();
    const bad = mapSubmission(qs, { score: 9 }).feedback!;
    expect(bad).toMatchObject({ score: null, scale: null });
    expect(bad.rejected).toEqual([{ question: "How would you rate us?", why: "it must be a whole number from 1 to 5" }]);
    expect(mapSubmission(tenDraft().questions, { score: "10" }).feedback).toMatchObject({ scale: "nps10", score: 10 });
    expect(mapSubmission(tenDraft().questions, { score: "0" }).feedback).toMatchObject({ scale: "nps10", score: 0 });
    // A score that is not a number at all is not a score.
    expect(mapSubmission(qs, { score: "great" }).feedback!.rejected).toHaveLength(1);
    // Nothing maps to feedback on a form that has no such question.
    expect(mapSubmission(emptyDraft("form").questions, { first_name: "A", email: "a@b.test" }).feedback).toBeNull();
  });
});

let c: CrmOrg;
let d: CrmOrg;
beforeAll(async () => {
  c = await crmOrg({ name: "Survey Forms Co" });
  d = await crmOrg({ name: "Other Survey Forms Co" });
  await setSurveys(c.org.id, true);
  await setSurveys(d.org.id, true);
});

async function liveSurvey(org: CrmOrg, name: string, draft: FormDraft) {
  const owner = org.actor("owner");
  const f = await createForm(owner, { name, kind: "survey" });
  const cur = await getForm(owner, f.id);
  await saveFormDraft(owner, f.id, { draft, expectedRevision: cur.draftRevision });
  await updateFormSettings(owner, f.id, { hosted: true });
  await publishForm(owner, f.id);
  return f;
}
let nth = 0;
async function submit(org: CrmOrg, key: string, answers: Record<string, string>) {
  nth += 1;
  const r = await handleHostedSubmit(visitor(), raw({ org: org.org.slug, key, t: hostedFormToken(org.org.slug, key, NOW.getTime() - 10_000 - nth), consent: "yes", ...answers }));
  expect(r).toMatchObject({ ok: true });
  await processFormSubmissions({ now: NOW, limit: 50 });
}
const feedbackFor = (formId: string) =>
  all<{ id: string; rating: number | null; nps_score: number | null; scale: string; comment: string | null; contact_id: string | null; source: string; low_score: boolean; follow_up_status: string; escalated_task_id: string | null; escalation_id: string | null; form_submission_id: string; review_request_id: string | null }>(
    "select f.* from customer_feedback f join crm_form_submissions s on s.id = f.form_submission_id where s.form_id = $1 order by f.received_at, f.id", [formId],
  );

describe("a survey's answers become private feedback", () => {
  let survey: { id: string; key: string };
  let anon: { id: string; key: string };
  beforeAll(async () => {
    survey = await liveSurvey(c, "How did we do", starsDraft());
    anon = await liveSurvey(c, "How did we do, anonymously", anonymous(starsDraft().questions.slice(0, 2)));
  });

  it("attributes an answer to the contact the survey knew, keeps its link to the submission, and tells workflows as for any private feedback", async () => {
    await submit(c, survey.key, { "q.score": "5", "q.comment": "Quick and friendly.", "q.email": "named.high@example.test" });
    const rows = await feedbackFor(survey.id);
    expect(rows).toHaveLength(1);
    const contact = await one<{ id: string }>("select id from contacts where org_id = $1 and email = 'named.high@example.test'", [c.org.id]);
    expect(rows[0]).toMatchObject({ rating: 5, nps_score: null, scale: "csat5", comment: "Quick and friendly.", contact_id: contact.id, source: "survey", low_score: false, follow_up_status: "new", review_request_id: null });
    const sub = await one<{ id: string; status: string; error: string | null }>("select id, status, error from crm_form_submissions where form_id = $1", [survey.id]);
    expect(rows[0].form_submission_id).toBe(sub.id);
    expect(sub).toMatchObject({ status: "processed", error: null });
    const ev = (await eventsFor(c.org.id, "feedback.received")).find((e) => e.entity_id === rows[0].id)!;
    expect(ev.contact_id).toBe(contact.id);
    expect(ev.payload).toMatchObject({ rating: 5, scale: "csat5", source: "survey", submissionId: sub.id, hasComment: true });
    expect(await one("select summary from crm_activities where org_id = $1 and ref_id = $2 and kind = 'feedback.received'", [c.org.id, rows[0].id])).toEqual({ summary: "Left private feedback in a survey: 5 of 5" });
    // No follow-up for a good answer.
    expect((await eventsFor(c.org.id, "feedback.escalated")).filter((e) => e.entity_id === rows[0].id)).toEqual([]);
  });

  it("opens the usual follow-up for a low answer from a known person, without an inbox escalation, and tells the team to check it is really them", async () => {
    await submit(c, survey.key, { "q.score": "1", "q.comment": "The wait was far too long.", "q.email": "named.low@example.test" });
    const f = (await feedbackFor(survey.id)).find((r) => r.comment === "The wait was far too long.")!;
    expect(f).toMatchObject({ rating: 1, low_score: true, follow_up_status: "escalated", escalation_id: null });
    expect(f.escalated_task_id).toBeTruthy();
    const task = await one<{ title: string; description: string; priority: string }>("select title, description, priority from tasks where id = $1", [f.escalated_task_id]);
    expect(task.title).toMatch(/feedback \(1 of 5\)/);
    expect(task.priority).toBe("high");
    expect(task.description).toContain("in the survey “How did we do”");
    expect(task.description).toContain("The wait was far too long.");
    expect(task.description).toMatch(/check it is really them/);
    expect(task.description).not.toMatch(/public review links were shown/);
    const notes = await all<{ title: string; body: string }>("select title, body from notifications where org_id = $1 and dedupe_key = $2", [c.org.id, `feedback-low:${f.id}`]);
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.title).toMatch(/Low feedback from .* \(1 of 5\)/);
      expect(`${n.title} ${n.body}`).not.toMatch(/wait was far/);
      expect(n.body).toBe("A follow-up task was created. Open the contact to read what they wrote.");
    }
    const ev = (await eventsFor(c.org.id, "feedback.escalated")).find((e) => e.entity_id === f.id)!;
    expect(ev.payload).toMatchObject({ feedbackId: f.id, reviewRequestId: null, escalationId: null });
    expect(JSON.stringify(ev.payload)).not.toMatch(/"rating"|"comment"|wait was far/);
  });

  it("keeps an answer from someone the survey did not know anonymous: stored, counted and flagged, with nobody to follow up with", async () => {
    await submit(c, anon.key, { "q.score": "2", "q.comment": "Not impressed, and I won't say who I am." });
    const f = (await feedbackFor(anon.id))[0];
    expect(f).toMatchObject({ rating: 2, contact_id: null, source: "survey", low_score: true, follow_up_status: "new", escalated_task_id: null, escalation_id: null });
    expect(await all("select 1 from notifications where org_id = $1 and dedupe_key = $2", [c.org.id, `feedback-low:${f.id}`])).toEqual([]);
    expect((await eventsFor(c.org.id, "feedback.escalated")).filter((e) => e.entity_id === f.id)).toEqual([]);
    expect((await eventsFor(c.org.id, "feedback.received")).filter((e) => e.entity_id === f.id)).toEqual([]);
    // It is in the team's list, marked low, with no name attached.
    const row = (await listFeedback(c.actor("owner"), { filter: "all", pageSize: 100 })).rows.find((r) => r.id === f.id)!;
    expect(row).toMatchObject({ contact: null, source: "survey", lowScore: true, rating: 2 });
    expect((await listFeedback(c.actor("owner"), { filter: "low", pageSize: 100 })).rows.map((r) => r.id)).toContain(f.id);
  });

  it("saves a comment with no score by what it says, and nothing at all for a submission that gave neither", async () => {
    const commentOnly = await liveSurvey(c, "Comment only", starsDraft({ questions: [q("comment", { type: "long_text", label: "Tell us", required: true, map: "feedback.comment" }), q("email", { type: "email", label: "Email", map: "contact.email" })] }));
    await submit(c, commentOnly.key, { "q.comment": "No complaints at all, thank you.", "q.email": "comment.fine@example.test" });
    await submit(c, commentOnly.key, { "q.comment": "This was unacceptable and I want to complain.", "q.email": "comment.angry@example.test" });
    const rows = await feedbackFor(commentOnly.id);
    expect(rows.map((r) => [r.comment?.slice(0, 12), r.low_score, r.rating])).toEqual([["No complaint", false, null], ["This was una", true, null]]);
    const empty = await liveSurvey(c, "Optional only", starsDraft({ questions: [q("comment", { type: "long_text", label: "Tell us", map: "feedback.comment" }), q("email", { type: "email", label: "Email", map: "contact.email" })] }));
    await submit(c, empty.key, { "q.email": "nothing.said@example.test" });
    expect(await feedbackFor(empty.id)).toEqual([]);
    expect(await one("select status from crm_form_submissions where form_id = $1", [empty.id])).toEqual({ status: "processed" });
  });

  it("saves a recommend score on its own scale, and treats 0 to 6 as low", async () => {
    const nps = await liveSurvey(c, "Would you recommend us", tenDraft());
    const npsAnon = await liveSurvey(c, "Would you recommend us, anonymously", anonymous([tenScore()]));
    await submit(c, nps.key, { "q.score": "9", "q.email": "nps.nine@example.test" });
    await submit(c, nps.key, { "q.score": "0", "q.email": "nps.zero@example.test" });
    await submit(c, npsAnon.key, { "q.score": "6" });
    const rows = [...(await feedbackFor(nps.id)), ...(await feedbackFor(npsAnon.id))];
    expect(rows.map((r) => [r.nps_score, r.rating, r.scale, r.low_score, r.contact_id !== null])).toEqual([[9, null, "nps10", false, true], [0, null, "nps10", true, true], [6, null, "nps10", true, false]]);
  });

  it("saves each submission's feedback once, however often it is processed or saved", async () => {
    const before = (await feedbackFor(survey.id)).length;
    await processFormSubmissions({ now: NOW, limit: 50 });
    expect((await feedbackFor(survey.id)).length).toBe(before);
    // Saving the same submission's feedback again, directly, changes nothing: a unique key allows one answer per submission.
    const sub = await one<{ id: string; contact_id: string | null }>("select id, contact_id from crm_form_submissions where form_id = $1 and contact_id is not null order by created_at limit 1", [survey.id]);
    const again = await withSystem((db) => saveSurveyFeedback(db, c.system, {
      submissionId: sub.id, formName: "How did we do", contactId: sub.contact_id, feedback: { scale: "csat5", score: 1, comment: null, rejected: [] }, receivedAt: NOW, now: NOW,
    }));
    expect(again).toMatchObject({ feedbackId: null });
    expect((await feedbackFor(survey.id)).length).toBe(before);
  });

  it("attributes it to an existing contact with the same email without changing that contact's addresses, and says the person is unverified", async () => {
    const existing = await createContact(c.actor("owner"), { firstName: "Elena", lastName: "Existing", email: "existing.person@example.test", phone: "+15555550177" });
    await submit(c, survey.key, { "q.score": "2", "q.email": "existing.person@example.test" });
    const f = (await feedbackFor(survey.id)).find((r) => r.contact_id === existing.id)!;
    expect(f).toMatchObject({ rating: 2, low_score: true });
    expect(await one("select email::text as email, phone from contacts where id = $1", [existing.id])).toEqual({ email: "existing.person@example.test", phone: "+15555550177" });
    expect((await one<{ description: string }>("select description from tasks where id = $1", [f.escalated_task_id])).description).toMatch(/only from the email address or phone number they typed/);
  });

  it("erases a person's survey answers on request but keeps the score for the counts, and leaves anonymous answers alone", async () => {
    await submit(c, survey.key, { "q.score": "1", "q.comment": "My email is erase.me@example.test and I was unhappy.", "q.email": "erase.me@example.test" });
    const contact = await one<{ id: string }>("select id from contacts where org_id = $1 and email = 'erase.me@example.test'", [c.org.id]);
    const f = (await feedbackFor(survey.id)).find((r) => r.contact_id === contact.id)!;
    await submit(c, anon.key, { "q.score": "3", "q.comment": "Middling, and anonymous." });
    const anonRow = (await feedbackFor(anon.id)).find((r) => r.comment?.startsWith("Middling"))!;
    await redactContact(c.actor("owner"), contact.id, "Privacy request received 14 Oct");
    expect(await one("select rating, comment, contact_id, follow_up_status from customer_feedback where id = $1", [f.id])).toEqual({ rating: 1, comment: null, contact_id: null, follow_up_status: "resolved" });
    expect(await one("select answers from crm_form_submissions where id = $1", [f.form_submission_id])).toEqual({ answers: {} });
    expect(await one("select comment, rating from customer_feedback where id = $1", [anonRow.id])).toEqual({ comment: "Middling, and anonymous.", rating: 3 });
  });
});

describe("a form that is not a survey can't save feedback", () => {
  it("refuses to publish it", async () => {
    const owner = c.actor("owner");
    const f = await createForm(owner, { name: "Contact us" });
    const cur = await getForm(owner, f.id);
    await saveFormDraft(owner, f.id, { draft: { ...cur.draft, questions: [...cur.draft.questions, q("score", { type: "number", validation: { min: 1, max: 5, integer: true }, map: "feedback.rating" })] }, expectedRevision: cur.draftRevision });
    await expect(publishForm(owner, f.id)).rejects.toThrow(/only a survey/);
  });
});

describe("tenant isolation", () => {
  it("keeps one workspace's survey answers, links and follow-ups out of another's", async () => {
    const mine = await liveSurvey(c, "Isolation survey", starsDraft());
    const theirs = await liveSurvey(d, "Isolation survey", starsDraft());
    await submit(c, mine.key, { "q.score": "1", "q.comment": "Mine alone.", "q.email": "iso.mine@example.test" });
    await submit(d, theirs.key, { "q.score": "1", "q.comment": "Theirs alone.", "q.email": "iso.theirs@example.test" });
    const mineRows = (await listFeedback(c.actor("owner"), { filter: "all", pageSize: 100 })).rows;
    const theirRows = (await listFeedback(d.actor("owner"), { filter: "all", pageSize: 100 })).rows;
    expect(mineRows.some((r) => r.comment === "Mine alone.")).toBe(true);
    expect(mineRows.some((r) => r.comment === "Theirs alone.")).toBe(false);
    expect(theirRows.some((r) => r.comment === "Theirs alone.")).toBe(true);
    expect(theirRows.some((r) => r.comment === "Mine alone.")).toBe(false);
    expect(await all("select 1 from tasks where org_id = $1 and description like '%Mine alone%'", [d.org.id])).toEqual([]);
    expect(await all("select 1 from customer_feedback f join crm_form_submissions s on s.id = f.form_submission_id where f.org_id = $1 and s.org_id <> f.org_id", [c.org.id])).toEqual([]);
  });
});
