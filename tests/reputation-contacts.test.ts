// Merging two contacts and erasing one on request must reach private feedback, review requests, survey answers and customer programs. Regression tests for the gaps the audit
// found (feedback and calls stayed on the merged record, a comment survived erasure, the reference list named tables that do not exist). Synthetic workspaces, embedded Postgres.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { mergeContacts, MOVED_CONTACT_TABLES, redactContact } from "@/server/messaging/contacts";
import { getReviewStats, listFeedback, loadReviewPage } from "@/server/crm/reviews";
import { getContactReputation } from "@/server/reputation/feedback";
import { enrollEligible } from "@/server/retention/engine";
import { markCustomer, setProgramEnabled } from "@/server/retention/service";
import { dispatchMessage } from "@/server/messaging/send";
import { recordingProvider } from "./support/messaging";
import { ask, all, count, giveFeedback, one, reputationShop, shopCustomer, type ReputationShop } from "./support/reputation";

const expectError = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
};

let s: ReputationShop;
let other: ReputationShop;
beforeAll(async () => {
  s = await reputationShop("Merge Shop");
  other = await reputationShop("Other Merge Shop");
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = any($1::uuid[]) and role_key = 'crm_manager'", [[s.m.org.id, other.m.org.id]]));
});

describe("the list of things a merge moves", () => {
  it("names only real tables with a contact reference, and the ones the audit found missing", async () => {
    const rows = await all<{ table_name: string; col: string }>(
      `select table_name, column_name as col from information_schema.columns
       where table_schema = 'public' and table_name = any($1::text[]) and column_name in ('contact_id', 'org_id')`,
      [[...MOVED_CONTACT_TABLES]],
    );
    for (const t of MOVED_CONTACT_TABLES) expect(rows.filter((r) => r.table_name === t).map((r) => r.col).sort(), t).toEqual(["contact_id", "org_id"]);
    for (const needed of ["customer_feedback", "crm_call_records", "crm_review_requests"]) expect(MOVED_CONTACT_TABLES as readonly string[]).toContain(needed);
    // The names that never existed in any migration are gone (a merge never silently skipped them, but the list said it handled them).
    for (const stale of ["crm_bookings", "crm_call_logs", "crm_sequence_enrollments"]) expect(MOVED_CONTACT_TABLES as readonly string[]).not.toContain(stale);
  });
});

describe("merging two contacts", () => {
  it("brings the merged contact's private feedback, review requests, follow-up tasks, call records and finished programs to the kept contact, and stops its running programs", async () => {
    await setProgramEnabled(s.m.ctx("owner"), "onboarding_checkin", true);
    const kept = await shopCustomer(s, { firstName: "Kept" });
    const merged = await shopCustomer(s, { firstName: "Merged" });
    await markCustomer(s.m.ctx("sales"), kept);
    await markCustomer(s.m.ctx("sales"), merged);
    await enrollEligible();
    // Both qualify for the same program for the same cause, which is unique per program, contact and cause: the merged one's must not collide with the kept one's.
    const welcome = await one<{ id: string }>("select id from retention_programs where org_id = $1 and kind = 'welcome'", [s.m.org.id]);
    await withSystem((db) => db.query("insert into retention_enrollments (org_id, program_id, contact_id, trigger_ref, status, closed_at) values ($1, $2, $3, 'customer', 'completed', now())", [s.m.org.id, welcome.id, merged]));

    const g = await giveFeedback(s, merged, { rating: "1", comment: "Cold room." });
    await withSystem((db) => db.query("insert into crm_call_records (org_id, provider, direction, status, contact_id) values ($1, 'manual', 'inbound', 'completed', $2)", [s.m.org.id, merged]));
    const taskId = (await one<{ escalated_task_id: string }>("select escalated_task_id from customer_feedback where id = $1", [g.result.feedbackId])).escalated_task_id;
    // (The low feedback just stopped the merged contact's running program already; the merge must cope with that too.)

    await expectError(mergeContacts(s.viewer, { keptId: kept, mergedId: merged, reason: "Same person" }), "forbidden");
    await mergeContacts(s.owner, { keptId: kept, mergedId: merged, reason: "Same person, two sign-ups" });

    expect(await one("select contact_id from customer_feedback where id = $1", [g.result.feedbackId])).toEqual({ contact_id: kept });
    expect(await one("select contact_id from crm_review_requests where id = $1", [g.requestId])).toEqual({ contact_id: kept });
    expect(await one("select contact_id from tasks where id = $1", [taskId])).toEqual({ contact_id: kept });
    expect(await count("select count(*)::text as n from crm_call_records where org_id = $1 and contact_id = $2", [s.m.org.id, kept])).toBe(1);
    expect(await count("select count(*)::text as n from crm_call_records where org_id = $1 and contact_id = $2", [s.m.org.id, merged])).toBe(0);

    // The kept contact's card and the Reviews list now show the feedback with a contact, instead of a row with nobody on it.
    const card = await getContactReputation(s.owner, kept);
    expect(card.total).toBe(1);
    expect(card.open?.id).toBe(g.result.feedbackId);
    const row = (await listFeedback(s.owner, { filter: "all", pageSize: 100 })).rows.find((r) => r.id === g.result.feedbackId);
    expect(row?.contact?.id).toBe(kept);

    // Programs: the finished enrollment moved; the merged contact's own running program is cancelled (the kept contact keeps its own), and the one that would have collided stayed behind.
    const enr = (id: string) => all<{ status: string; cancel_reason: string | null; kind: string }>(
      "select e.status, e.cancel_reason, p.kind from retention_enrollments e join retention_programs p on p.id = e.program_id where e.contact_id = $1 order by p.kind", [id]);
    expect(await enr(kept)).toEqual([{ status: "active", cancel_reason: null, kind: "onboarding_checkin" }, { status: "completed", cancel_reason: null, kind: "welcome" }]);
    expect(await enr(merged)).toEqual([{ status: "cancelled", cancel_reason: expect.stringMatching(/negative_feedback|contact_merged/), kind: "onboarding_checkin" }]);
  });

  it("stops a merged contact's still-running program with the merge as the reason", async () => {
    const kept = await shopCustomer(s);
    const merged = await shopCustomer(s);
    await markCustomer(s.m.ctx("sales"), merged);
    await enrollEligible();
    expect(await count("select count(*)::text as n from retention_enrollments where contact_id = $1 and status = 'active'", [merged])).toBe(1);
    await mergeContacts(s.owner, { keptId: kept, mergedId: merged, reason: "Same person, two sign-ups" });
    // Nothing active is left on either record: the merged record's program was cancelled first and then moved to the kept record with the rest of its history.
    expect(await count("select count(*)::text as n from retention_enrollments where contact_id in ($1, $2) and status = 'active'", [merged, kept])).toBe(0);
    expect(await all<{ cancel_reason: string }>("select cancel_reason from retention_enrollments where contact_id = $1", [kept])).toEqual([{ cancel_reason: "contact_merged" }]);
    expect(await count("select count(*)::text as n from retention_steps where org_id = $1 and enrollment_id in (select id from retention_enrollments where contact_id = $2) and status = 'scheduled'", [s.m.org.id, kept])).toBe(0);
  });

  it("does not move another workspace's records, and refuses a contact from another workspace", async () => {
    const theirs = await shopCustomer(other);
    const g = await giveFeedback(other, theirs, { rating: "1" });
    const kept = await shopCustomer(s);
    const merged = await shopCustomer(s);
    await expectError(mergeContacts(s.owner, { keptId: kept, mergedId: theirs, reason: "Not the same person at all" }), "not_found");
    await mergeContacts(s.owner, { keptId: kept, mergedId: merged, reason: "Same person, two sign-ups" });
    expect(await one("select contact_id from customer_feedback where id = $1", [g.result.feedbackId])).toEqual({ contact_id: theirs });
  });
});

describe("erasing a contact on request", () => {
  it("removes what the customer wrote and the link to them, keeps the score for the counts, and closes the follow-up", async () => {
    const contactId = await shopCustomer(s, { firstName: "Erased", ownerId: s.m.people.sales.id });
    const g = await giveFeedback(s, contactId, { rating: "1", comment: "My email is erased@example.test and the dentist was rude." });
    const f = await one<{ escalated_task_id: string }>("select escalated_task_id from customer_feedback where id = $1", [g.result.feedbackId]);
    // A program that is running for them when the request comes in (it started after the low feedback, which had already stopped any earlier one).
    await setProgramEnabled(s.m.ctx("owner"), "onboarding_checkin", true);
    await markCustomer(s.m.ctx("sales"), contactId);
    await enrollEligible();
    expect(await count("select count(*)::text as n from retention_enrollments where contact_id = $1 and status = 'active'", [contactId])).toBe(1);
    const bystander = await giveFeedback(s, await shopCustomer(s), { rating: "5", comment: "Lovely, thank you." });
    // What a form survey would have stored.
    const form = await one<{ id: string }>("insert into crm_forms (org_id, key, name, kind, purpose) values ($1, $2, 'Survey', 'survey', 'survey') returning id", [s.m.org.id, `survey-${Date.now()}`]);
    const version = await one<{ id: string }>("insert into crm_form_versions (org_id, form_id, version, fields, content_hash) values ($1, $2, 1, '[]'::jsonb, repeat('a', 64)) returning id", [s.m.org.id, form.id]);
    await withSystem((db) => db.query(
      `insert into crm_form_submissions (org_id, form_id, version_id, source, answers, consent_text, ip_hash, dedupe_key, contact_id)
       values ($1, $2, $3, 'hosted', '{"name":"Erased Person","comment":"Rude"}'::jsonb, 'I agree', repeat('b', 64), $4, $5)`,
      [s.m.org.id, form.id, version.id, `erase-${Date.now()}-aaa`, contactId]));
    const before = (await getReviewStats(s.owner)).feedback.count;

    await expectError(redactContact(s.support, contactId, "Privacy request received 12 Oct"), "forbidden");
    await redactContact(s.owner, contactId, "Privacy request received 12 Oct");

    // The words, and the link to the person, are gone; the rating stays as a count with nobody attached; the follow-up is closed.
    expect(await one("select rating, comment, contact_id, follow_up_status, resolution_note from customer_feedback where id = $1", [g.result.feedbackId]))
      .toEqual({ rating: 1, comment: null, contact_id: null, follow_up_status: "resolved", resolution_note: "The contact was removed on request." });
    expect((await getReviewStats(s.owner)).feedback.count).toBe(before);
    const row = (await listFeedback(s.owner, { filter: "all", pageSize: 100 })).rows.find((r) => r.id === g.result.feedbackId);
    expect(row).toMatchObject({ rating: 1, comment: null, contact: null });
    // The task and the notices that named them are blanked, and the task is no longer waiting for anyone.
    expect(await one("select title, description, contact_id, status from tasks where id = $1", [f.escalated_task_id])).toEqual({ title: "Follow-up on removed feedback", description: null, contact_id: null, status: "cancelled" });
    const notes = await all<{ title: string; body: string | null }>("select title, body from notifications where org_id = $1 and dedupe_key = $2", [s.m.org.id, `feedback-low:${g.result.feedbackId}`]);
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n).toEqual({ title: "Low feedback (details removed on request)", body: null });
    expect(JSON.stringify(await all("select title, description from tasks where org_id = $1 and id = $2", [s.m.org.id, f.escalated_task_id]))).not.toMatch(/Erased|rude|dentist/i);
    // What they typed into a form is gone; the submission stays as a count.
    expect(await one("select answers, consent_text, ip_hash from crm_form_submissions where contact_id = $1 or (org_id = $2 and dedupe_key like 'erase-%')", [contactId, s.m.org.id])).toEqual({ answers: {}, consent_text: null, ip_hash: null });
    // Their running customer program is stopped.
    expect(await all("select status, cancel_reason from retention_enrollments where contact_id = $1", [contactId])).toEqual([{ status: "cancelled", cancel_reason: "contact_removed" }]);
    // Nobody else was touched.
    expect(await one("select comment, contact_id from customer_feedback where id = $1", [bystander.result.feedbackId])).toMatchObject({ comment: "Lovely, thank you." });
    expect(JSON.stringify(await all("select * from customer_feedback where org_id = $1", [s.m.org.id]))).not.toContain("erased@example.test");
  });

  it("cancels a review request that has not been answered, stops its message if it has not gone out, and leaves the public links on the page", async () => {
    const contactId = await shopCustomer(s);
    const asked = await ask(s, contactId);
    const hold = await one<{ reservation_id: string }>("select reservation_id from conversation_messages where id = $1", [asked.messageId]);
    expect(hold.reservation_id).toBeTruthy();
    await redactContact(s.owner, contactId, "Privacy request received 12 Oct");
    expect(await one("select status from crm_review_requests where id = $1", [asked.requestId])).toEqual({ status: "cancelled" });
    expect(await one("select status, blocked_reason from conversation_messages where id = $1", [asked.messageId])).toEqual({ status: "blocked", blocked_reason: "privacy_request" });
    expect(await one("select status from usage_reservations where id = $1", [hold.reservation_id])).toEqual({ status: "released" });
    // The link no longer takes feedback, so nothing can be stored against a person who asked to be forgotten, but the business's review links are still there (rule R1).
    const page = await loadReviewPage(asked.token);
    expect(page).toMatchObject({ state: "closed", closedReason: "cancelled" });
    expect(page.destinations.map((d) => d.id)).toEqual([s.google, s.facebook]);
    // A message the dispatcher picks up afterwards is not sent.
    const rec = recordingProvider("twilio");
    expect(await dispatchMessage(asked.messageId, { transport: rec.transport })).not.toEqual({ status: "sent" });
    expect(rec.calls).toHaveLength(0);
  });

  it("does not touch another workspace's feedback when it erases a contact", async () => {
    const mine = await shopCustomer(s);
    const theirs = await shopCustomer(other);
    const g = await giveFeedback(other, theirs, { rating: "1", comment: "Keep this." });
    await giveFeedback(s, mine, { rating: "1", comment: "Remove this." });
    await redactContact(s.owner, mine, "Privacy request received 12 Oct");
    expect(await one("select comment, contact_id from customer_feedback where id = $1", [g.result.feedbackId])).toEqual({ comment: "Keep this.", contact_id: theirs });
  });
});
