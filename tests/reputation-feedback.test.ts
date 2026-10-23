// Low private feedback and what follows it: the follow-up task, the notice, the inbox escalation, the stopped program messages, the event, acknowledging and resolving, and
// the rules that keep it all private and tenant-bound. Synthetic workspaces on embedded Postgres: messages are queued, never dispatched, and nothing contacts a provider.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const emailLog = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/email", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/email")>();
  return {
    ...orig,
    sendEmail: vi.fn(async (...args: Parameters<typeof orig.sendEmail>) => {
      if (emailLog.fail) throw new Error("the mail provider is down");
      return orig.sendEmail(...args);
    }),
  };
});

import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { agencyActor, startSupportSession, systemActor } from "@/server/crm/actor";
import { setTaskStatus } from "@/server/crm/tasks";
import { getReviewStats, listFeedback, loadReviewPage, queueReviewRequestInTx, requestReview, setFeedbackFollowUp, submitReviewFeedback } from "@/server/crm/reviews";
import { sendEmail } from "@/server/email";
import { getRetention } from "@/server/queries/business";
import { getContactReputation } from "@/server/reputation/feedback";
import { saveReputationSettings } from "@/server/reputation/settings";
import { enrollEligible } from "@/server/retention/engine";
import { markCustomer, setProgramEnabled, setRetentionPaused } from "@/server/retention/service";
import { agencyPeople, eventsFor } from "./support/crm";
import { ask, all, count, giveFeedback, one, reputationShop, shopCustomer, tokenOf, type ReputationShop } from "./support/reputation";

const expectError = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (message) expect((err as AppError).message).toMatch(message);
};

const feedbackRow = (id: string) =>
  one<{
    rating: number | null; comment: string | null; scale: string; low_score: boolean; follow_up_status: string; escalated_task_id: string | null; escalation_id: string | null;
    acknowledged_at: Date | null; acknowledged_by: string | null; resolved_at: Date | null; resolved_by: string | null; resolution_note: string | null; contact_id: string | null;
  }>("select * from customer_feedback where id = $1", [id]);

let a: ReputationShop;
let b: ReputationShop;
beforeAll(async () => {
  a = await reputationShop("Follow-up Shop");
  b = await reputationShop("Other Follow-up Shop");
});
afterAll(() => {
  emailLog.fail = false;
});

describe("low private feedback opens a follow-up for the team", () => {
  it("creates a task, a notice, an inbox escalation, an event and a timeline entry, in one go, without repeating the customer's words anywhere but the task", async () => {
    const contactId = await shopCustomer(a, { firstName: "Lena", ownerId: a.m.people.sales.id });
    const asked = await ask(a, contactId);
    const emailsBefore = vi.mocked(sendEmail).mock.calls.length;
    const now = new Date(Date.now() + 5 * 60_000);
    const r = await submitReviewFeedback(asked.token, { rating: "1", comment: "The wait was far too long and the room was cold." }, { now });
    expect(r).toMatchObject({ outcome: "saved", escalated: true });
    const f = await feedbackRow(r.feedbackId!);
    expect(f).toMatchObject({ rating: 1, scale: "csat5", low_score: true, follow_up_status: "escalated", contact_id: contactId, acknowledged_at: null, resolved_at: null });
    expect(f.escalated_task_id).toBeTruthy();
    expect(f.escalation_id).toBeTruthy();

    // The task: high priority, for the contact's owner, due when the acknowledgement time (24 hours) ends, with the customer's words in it (tasks are read inside the portal).
    const task = await one<{ title: string; priority: string; assigned_user_id: string; due_at: Date; description: string; source: string; category: string }>("select title, priority, assigned_user_id, due_at, description, source, category from tasks where id = $1", [f.escalated_task_id]);
    expect(task).toMatchObject({ priority: "high", assigned_user_id: a.m.people.sales.id, source: "system" });
    expect(task.title).toMatch(/Follow up on Lena .*feedback \(1 of 5\)/);
    expect(new Date(task.due_at).toISOString()).toBe(new Date(now.getTime() + 24 * 3_600_000).toISOString());
    expect(task.description).toContain("The wait was far too long");

    // The inbox escalation: a complaint, urgent, in the conversation the request lives in, whose summary has the score and none of the customer's words.
    const conv = await one<{ conversation_id: string; contact_id: string }>("select conversation_id, (select contact_id from conversations c where c.id = m.conversation_id) as contact_id from conversation_messages m where m.id = $1", [asked.messageId]);
    const esc = await one<{ category: string; urgency: string; summary: string; conversation_id: string; contact_id: string; status: string }>("select category, urgency, summary, conversation_id, contact_id, status from human_escalations where id = $1", [f.escalation_id]);
    expect(esc).toMatchObject({ category: "complaint", urgency: "urgent", conversation_id: conv.conversation_id, contact_id: contactId });
    expect(["awaiting_owner", "open"]).toContain(esc.status);
    expect(esc.summary).toContain("1 of 5");
    expect(esc.summary).not.toMatch(/wait|cold|room/i);
    const handoff = await all<{ kind: string }>("select kind from conversation_events where conversation_id = $1 and kind = 'handoff_requested'", [conv.conversation_id]);
    expect(handoff).toHaveLength(1);

    // The notice to the owner and managers names the customer and the score, never what they wrote.
    const notes = await all<{ user_id: string; title: string; body: string; kind: string; link: string }>("select user_id, title, body, kind, link from notifications where org_id = $1 and dedupe_key = $2 order by user_id", [a.m.org.id, `feedback-low:${r.feedbackId}`]);
    expect(notes.map((n) => n.user_id).sort()).toEqual([a.m.people.owner.id, a.m.people.manager.id].sort());
    for (const n of notes) {
      expect(n).toMatchObject({ kind: "retention_attention", link: `/crm/contacts/${contactId}` });
      expect(n.title).toMatch(/Low feedback from Lena .* \(1 of 5\)/);
      expect(`${n.title} ${n.body}`).not.toMatch(/wait|cold|room/i);
    }

    // The event: one, with ids and a yes or no, and neither the rating nor the comment.
    const ev = (await eventsFor(a.m.org.id, "feedback.escalated")).filter((e) => e.entity_id === r.feedbackId);
    expect(ev).toHaveLength(1);
    expect(ev[0].contact_id).toBe(contactId);
    expect(Object.keys(ev[0].payload).sort()).toEqual(["escalationId", "feedbackId", "programMessagesStopped", "reviewRequestId", "taskId"]);
    expect(JSON.stringify(ev[0].payload)).not.toMatch(/wait|cold|"rating"|"comment"/i);
    expect(await count("select count(*)::text as n from crm_activities where org_id = $1 and kind = 'feedback.escalated' and ref_id = $2", [a.m.org.id, r.feedbackId])).toBe(1);

    // The emails the escalation produced were sent after it committed, and carry a category and a link only.
    const sent = vi.mocked(sendEmail).mock.calls.slice(emailsBefore).map((c) => c[0]);
    expect(sent.length).toBeGreaterThan(0);
    for (const e of sent) {
      expect(e.template).toBe("escalation_alert");
      expect(`${e.subject} ${e.text}`).not.toMatch(/wait|cold|room/i);
    }
  });

  it("treats a rating at the workspace's level as low and one above it as not: nothing is created for it", async () => {
    for (const [rating, low] of [[2, true], [3, false], [4, false], [5, false]] as const) {
      const contactId = await shopCustomer(a);
      const g = await giveFeedback(a, contactId, { rating });
      expect(g.result, `rating ${rating}`).toMatchObject({ outcome: "saved", escalated: low });
      const f = await feedbackRow(g.result.feedbackId!);
      expect(f.low_score, `rating ${rating}`).toBe(low);
      expect(f.follow_up_status).toBe(low ? "escalated" : "new");
      expect(Boolean(f.escalated_task_id)).toBe(low);
      expect(Boolean(f.escalation_id)).toBe(low);
      expect(await count("select count(*)::text as n from human_escalations where contact_id = $1", [contactId])).toBe(low ? 1 : 0);
      expect(await count("select count(*)::text as n from crm_events where org_id = $1 and type = 'feedback.escalated' and contact_id = $2", [a.m.org.id, contactId])).toBe(low ? 1 : 0);
      expect(await count("select count(*)::text as n from notifications where org_id = $1 and dedupe_key = $2", [a.m.org.id, `feedback-low:${g.result.feedbackId}`])).toBe(low ? 2 : 0);
    }
  });

  it("raises a follow-up for a complaint written with no rating, and for nothing else a rating-less comment says", async () => {
    const angry = await shopCustomer(a, { firstName: "Rosa" });
    const g = await giveFeedback(a, angry, { comment: "Honestly this was unacceptable. I want to make a complaint." });
    expect(g.result).toMatchObject({ outcome: "saved", escalated: true });
    const f = await feedbackRow(g.result.feedbackId!);
    expect(f).toMatchObject({ rating: null, low_score: true, follow_up_status: "escalated" });
    const task = await one<{ title: string; description: string }>("select title, description from tasks where id = $1", [f.escalated_task_id]);
    expect(task.title).toBe(`Follow up on ${(await one<{ display_name: string }>("select display_name from contacts where id = $1", [angry])).display_name}'s feedback`);
    expect(task.description).toMatch(/left private feedback/);
    expect((await one<{ category: string }>("select category from human_escalations where id = $1", [f.escalation_id])).category).toBe("complaint");

    // A refund request names its own category; "no complaints" and a friendly note raise nothing.
    const refund = await giveFeedback(a, await shopCustomer(a), { comment: "I would like my money back." });
    expect((await one<{ category: string }>("select category from human_escalations where id = (select escalation_id from customer_feedback where id = $1)", [refund.result.feedbackId])).category).toBe("refund_concern");
    for (const text of ["No complaints at all, thank you!", "Lovely staff and a quick visit.", "Not a single complaint from us."]) {
      const calm = await giveFeedback(a, await shopCustomer(a), { comment: text });
      expect(calm.result, text).toMatchObject({ outcome: "saved", escalated: false });
      expect(await feedbackRow(calm.result.feedbackId!), text).toMatchObject({ low_score: false, follow_up_status: "new", escalated_task_id: null, escalation_id: null });
    }
    // A comment beside a rating is judged by the rating alone: five stars with the word "complaint" in it is not low.
    const five = await giveFeedback(a, await shopCustomer(a), { rating: 5, comment: "Great, though I did have a complaint about parking last year." });
    expect(five.result).toMatchObject({ outcome: "saved", escalated: false });
  });

  it("joins the escalation already open in that conversation instead of making another, and reopens a conversation that was resolved or archived", async () => {
    const contactId = await shopCustomer(a);
    const first = await giveFeedback(a, contactId, { rating: 1 });
    const f1 = await feedbackRow(first.result.feedbackId!);
    // A second request to the same person is refused for 30 days; age the first so a new one can be made, in the same conversation.
    await withSystem((db) => db.query("update crm_review_requests set created_at = now() - interval '40 days' where id = $1", [first.requestId]));
    const second = await giveFeedback(a, contactId, { rating: 2 });
    const f2 = await feedbackRow(second.result.feedbackId!);
    expect(f2.escalation_id).toBe(f1.escalation_id);
    expect(await count("select count(*)::text as n from human_escalations where contact_id = $1", [contactId])).toBe(1);
    expect(f2.escalated_task_id).not.toBe(f1.escalated_task_id);

    const other = await shopCustomer(a);
    const asked = await ask(a, other);
    const convId = (await one<{ conversation_id: string }>("select conversation_id from conversation_messages where id = $1", [asked.messageId])).conversation_id;
    await withSystem((db) => db.query("update conversations set status = 'closed', outcome = 'answered', archived_at = now() where id = $1", [convId]));
    const r = await submitReviewFeedback(asked.token, { rating: "1" });
    expect(r.escalated).toBe(true);
    expect(await one("select status, archived_at, outcome from conversations where id = $1", [convId])).toEqual({ status: "open", archived_at: null, outcome: null });
    expect(await count("select count(*)::text as n from conversation_events where conversation_id = $1 and kind = 'status_changed'", [convId])).toBe(1);
  });

  it("never lets a replay make a second task, escalation, event or notice", async () => {
    const contactId = await shopCustomer(a);
    const g = await giveFeedback(a, contactId, { rating: "1", comment: "Cold room." });
    expect(await submitReviewFeedback(g.token, { rating: "1", comment: "Cold room." })).toEqual({ outcome: "already" });
    expect(await submitReviewFeedback(g.token, { rating: "5" })).toEqual({ outcome: "already" });
    expect(await count("select count(*)::text as n from tasks where contact_id = $1", [contactId])).toBe(1);
    expect(await count("select count(*)::text as n from human_escalations where contact_id = $1", [contactId])).toBe(1);
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and type = 'feedback.escalated' and contact_id = $2", [a.m.org.id, contactId])).toBe(1);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and dedupe_key = $2", [a.m.org.id, `feedback-low:${g.result.feedbackId}`])).toBe(2);
  });

  it("keeps the task, the notice and the feedback when the escalation itself cannot be raised, and says so in the audit trail", async () => {
    await withSystem((db) => db.query("alter table human_escalations add constraint zz_test_refuse check (false) not valid"));
    try {
      const contactId = await shopCustomer(a);
      const g = await giveFeedback(a, contactId, { rating: "1", comment: "Rude." });
      expect(g.result).toMatchObject({ outcome: "saved", escalated: true });
      const f = await feedbackRow(g.result.feedbackId!);
      expect(f).toMatchObject({ low_score: true, follow_up_status: "escalated", escalation_id: null });
      expect(f.escalated_task_id).toBeTruthy();
      expect(await count("select count(*)::text as n from notifications where org_id = $1 and dedupe_key = $2", [a.m.org.id, `feedback-low:${g.result.feedbackId}`])).toBe(2);
      expect(await count("select count(*)::text as n from human_escalations where contact_id = $1", [contactId])).toBe(0);
      expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'crm.feedback_escalation_failed' and target_id = $2 and result = 'failure'", [a.m.org.id, g.result.feedbackId])).toBe(1);
      // The event still says what happened: no escalation.
      const ev = (await eventsFor(a.m.org.id, "feedback.escalated")).find((e) => e.entity_id === g.result.feedbackId);
      expect(ev?.payload.escalationId).toBeNull();
    } finally {
      await withSystem((db) => db.query("alter table human_escalations drop constraint zz_test_refuse"));
    }
  });

  it("saves the customer's feedback even when the mail provider is down", async () => {
    emailLog.fail = true;
    try {
      const g = await giveFeedback(a, await shopCustomer(a), { rating: "1" });
      expect(g.result).toMatchObject({ outcome: "saved", escalated: true });
      expect((await feedbackRow(g.result.feedbackId!)).escalation_id).toBeTruthy();
    } finally {
      emailLog.fail = false;
    }
  });
});

describe("the workspace decides what is low, and a decision is kept with the feedback", () => {
  it("uses the level the workspace chose at the moment the feedback arrived, and never rewrites history", async () => {
    const s = await reputationShop("Level Shop");
    const before = await giveFeedback(s, await shopCustomer(s), { rating: 3 });
    expect((await feedbackRow(before.result.feedbackId!)).low_score).toBe(false);

    const saved = await saveReputationSettings(s.owner, { escalateAtOrBelow: 3 }, 0);
    expect(saved).toMatchObject({ escalateAtOrBelow: 3, version: 1, isDefault: false });
    const atThree = await giveFeedback(s, await shopCustomer(s), { rating: 3 });
    expect(atThree.result.escalated).toBe(true);
    expect((await feedbackRow(atThree.result.feedbackId!)).low_score).toBe(true);

    await saveReputationSettings(s.owner, { escalateAtOrBelow: 1 }, 1);
    const atTwo = await giveFeedback(s, await shopCustomer(s), { rating: 2 });
    expect(atTwo.result.escalated).toBe(false);
    // The earlier answers keep the decision made when they arrived.
    expect((await feedbackRow(before.result.feedbackId!)).low_score).toBe(false);
    expect((await feedbackRow(atThree.result.feedbackId!)).low_score).toBe(true);
    // The lists and counts follow the stored decision.
    const low = await listFeedback(s.viewer, { filter: "low" });
    expect(low.rows.map((r) => r.id)).toEqual([atThree.result.feedbackId]);
    expect((await getReviewStats(s.viewer)).feedback).toMatchObject({ count: 3, low: 1 });

    // Another workspace is not affected by this one's level.
    const elsewhere = await giveFeedback(b, await shopCustomer(b), { rating: 3 });
    expect(elsewhere.result.escalated).toBe(false);
  });

  it("gives the task its due time from the workspace's acknowledgement time", async () => {
    const s = await reputationShop("Slow Shop");
    await saveReputationSettings(s.owner, { acknowledgeWithinHours: 4 }, 0);
    const asked = await ask(s, await shopCustomer(s));
    const now = new Date(Date.now() + 60_000);
    const r = await submitReviewFeedback(asked.token, { rating: "1" }, { now });
    const f = await feedbackRow(r.feedbackId!);
    const task = await one<{ due_at: Date }>("select due_at from tasks where id = $1", [f.escalated_task_id]);
    expect(new Date(task.due_at).toISOString()).toBe(new Date(now.getTime() + 4 * 3_600_000).toISOString());
  });
});

describe("a customer program stops when the customer gives low feedback", () => {
  it("cancels the rest of their automatic program messages, with the reason, and leaves other customers' programs running", async () => {
    const s = await reputationShop("Program Shop");
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'crm_manager'", [s.m.org.id]));
    await setProgramEnabled(s.m.ctx("owner"), "onboarding_checkin", true);
    const unhappy = await shopCustomer(s);
    const happy = await shopCustomer(s);
    await markCustomer(s.m.ctx("sales"), unhappy);
    await markCustomer(s.m.ctx("sales"), happy);
    await enrollEligible();
    const enrollments = (id: string) => all<{ status: string; cancel_reason: string | null }>("select status, cancel_reason from retention_enrollments where contact_id = $1", [id]);
    expect(await enrollments(unhappy)).toEqual([{ status: "active", cancel_reason: null }]);
    expect(await enrollments(happy)).toEqual([{ status: "active", cancel_reason: null }]);

    await giveFeedback(s, happy, { rating: 5 });
    expect(await enrollments(happy)).toEqual([{ status: "active", cancel_reason: null }]);

    const g = await giveFeedback(s, unhappy, { rating: 1 });
    expect(await enrollments(unhappy)).toEqual([{ status: "cancelled", cancel_reason: "negative_feedback" }]);
    expect(await all("select status, reason from retention_steps where enrollment_id in (select id from retention_enrollments where contact_id = $1) order by step_key", [unhappy]))
      .toEqual([{ status: "cancelled", reason: "negative_feedback" }, { status: "cancelled", reason: "negative_feedback" }]);
    const ev = (await eventsFor(s.m.org.id, "feedback.escalated")).find((e) => e.entity_id === g.result.feedbackId);
    expect(ev?.payload.programMessagesStopped).toBe(true);
    // Stopping program messages is all it does: the public review links and the customer's page are unchanged (see tests/reputation-page.test.ts).
    expect((await loadReviewPage(g.token)).destinations.map((d) => d.id)).toEqual([s.google, s.facebook]);
  });
});

describe("acknowledging, resolving and finishing the follow-up task", () => {
  it("lets owners, managers and the person the task is assigned to move it forward, records who and when, and turns everyone else away", async () => {
    const s = await reputationShop("Ack Shop");
    const contactId = await shopCustomer(s, { ownerId: s.m.people.sales.id });
    const g = await giveFeedback(s, contactId, { rating: "1", comment: "Cold room." });
    const id = g.result.feedbackId!;

    await expectError(setFeedbackFollowUp(s.viewer, id, "acknowledged"), "forbidden");
    await expectError(setFeedbackFollowUp(s.support, id, "acknowledged"), "forbidden");
    await expectError(setFeedbackFollowUp(s.sales, "not-a-uuid", "acknowledged"), "not_found");
    await expectError(setFeedbackFollowUp(s.sales, id, "escalated" as never), "invalid_input");

    // The assignee (sales) acknowledges: recorded with who and when; the status leaves "escalated".
    await setFeedbackFollowUp(s.sales, id, "acknowledged");
    let f = await feedbackRow(id);
    expect(f).toMatchObject({ follow_up_status: "acknowledged", acknowledged_by: s.m.people.sales.id, resolved_at: null });
    expect(f.acknowledged_at).not.toBeNull();
    const firstAck = f.acknowledged_at;

    // A manager resolves it with a note; the first acknowledgement is kept.
    await setFeedbackFollowUp(s.manager, id, "resolved", "  Called Lena back;   refunded the booking fee.  ");
    f = await feedbackRow(id);
    expect(f).toMatchObject({ follow_up_status: "resolved", resolved_by: s.m.people.manager.id, resolution_note: "Called Lena back; refunded the booking fee.", acknowledged_by: s.m.people.sales.id });
    expect(f.resolved_at).not.toBeNull();
    expect(new Date(f.acknowledged_at!).getTime()).toBe(new Date(firstAck!).getTime());

    // Setting it back to new clears the acknowledgement and the resolution; a note on anything but a resolution is dropped.
    await setFeedbackFollowUp(s.owner, id, "new", "ignored");
    f = await feedbackRow(id);
    expect(f).toMatchObject({ follow_up_status: "new", acknowledged_at: null, acknowledged_by: null, resolved_at: null, resolved_by: null, resolution_note: null });
    await expectError(setFeedbackFollowUp(s.owner, id, "resolved", "x".repeat(601)), "invalid_input", /600/);
    expect((await feedbackRow(id)).follow_up_status).toBe("new");

    const audits = await all<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = 'crm.feedback_follow_up' and target_id = $2 order by id", [s.m.org.id, id]);
    expect(audits.map((x) => x.metadata.to)).toEqual(["acknowledged", "resolved", "new"]);
    expect(audits[0].metadata.asAssignee).toBe(true);
    expect(audits[1].metadata.asAssignee).toBe(false);

    // Somebody else's follow-up is not the sales person's to move.
    const theirs = await giveFeedback(s, await shopCustomer(s), { rating: "1" });
    await expectError(setFeedbackFollowUp(s.sales, theirs.result.feedbackId!, "acknowledged"), "forbidden");
  });

  it("is refused to an iAcquire support session that can only look, and allowed to one that can write", async () => {
    const s = await reputationShop("Support Session Shop");
    const g = await giveFeedback(s, await shopCustomer(s), { rating: "1" });
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, s.m.org.id, { mode: "read", reason: "Looking at feedback" });
    await expectError(setFeedbackFollowUp(await agencyActor(superAdmin, s.m.org.id), g.result.feedbackId!, "acknowledged"), "forbidden");
    await startSupportSession(superAdmin, s.m.org.id, { mode: "write", reason: "Helping with a follow-up" });
    await setFeedbackFollowUp(await agencyActor(superAdmin, s.m.org.id), g.result.feedbackId!, "acknowledged");
    expect((await feedbackRow(g.result.feedbackId!)).follow_up_status).toBe("acknowledged");
  });

  it("resolves the feedback when its follow-up task is finished, and only then", async () => {
    const s = await reputationShop("Task Shop");
    const contactId = await shopCustomer(s, { ownerId: s.m.people.sales.id });
    const g = await giveFeedback(s, contactId, { rating: "1" });
    const f = await feedbackRow(g.result.feedbackId!);

    // Cancelling the task is not following up.
    await setTaskStatus(s.sales, f.escalated_task_id!, "cancelled");
    expect((await feedbackRow(g.result.feedbackId!)).follow_up_status).toBe("escalated");
    await setTaskStatus(s.sales, f.escalated_task_id!, "open");
    // Finishing some other task changes nothing.
    const other = await one<{ id: string }>("insert into tasks (org_id, title, category, status, source, contact_id) values ($1, 'Unrelated', 'crm', 'open', 'user', $2) returning id", [s.m.org.id, contactId]);
    await setTaskStatus(s.sales, other.id, "done");
    expect((await feedbackRow(g.result.feedbackId!)).follow_up_status).toBe("escalated");

    await setTaskStatus(s.sales, f.escalated_task_id!, "done");
    const done = await feedbackRow(g.result.feedbackId!);
    expect(done).toMatchObject({ follow_up_status: "resolved", resolved_by: s.m.people.sales.id, acknowledged_by: s.m.people.sales.id });
    expect(done.resolved_at).not.toBeNull();
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'crm.feedback_follow_up' and target_id = $2 and metadata->>'via' = 'task_completed'", [s.m.org.id, g.result.feedbackId])).toBe(1);

    // An already resolved item keeps its own resolution when the task is finished again later.
    await setFeedbackFollowUp(s.manager, g.result.feedbackId!, "resolved", "Handled by phone.");
    const resolvedAt = (await feedbackRow(g.result.feedbackId!)).resolved_at;
    await setTaskStatus(s.sales, f.escalated_task_id!, "open");
    await setTaskStatus(s.sales, f.escalated_task_id!, "done");
    expect((await feedbackRow(g.result.feedbackId!)).resolved_at).toEqual(resolvedAt);
  });
});

describe("a person's hold on automatic messages (rule R8)", () => {
  const automaticAsk = (s: ReputationShop, contactId: string, via: "workflow" | "api" | "program" | "batch") =>
    withSystem((db) => queueReviewRequestInTx(db, systemActor({ id: s.m.org.id, name: "Hold Shop", timezone: "UTC" }), { contactId, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, businessHoursOnly: false }, { via, requestedBy: null }));

  it("stops every automatic review ask for that customer, audited and counted, and never a person pressing Send", async () => {
    const s = await reputationShop("Hold Shop");
    const held = await shopCustomer(s);
    await setRetentionPaused(s.m.ctx("owner"), held, true, "Billing dispute with the customer");
    for (const via of ["workflow", "api", "program", "batch"] as const) {
      const r = await automaticAsk(s, held, via);
      expect(r, via).toMatchObject({ status: "blocked", reason: "held_by_person" });
      expect(r.status === "blocked" && r.detail, via).toMatch(/excluded from automatic messages by a person on your team/);
    }
    // Nothing was created for them: no request, no conversation, no message.
    expect(await count("select count(*)::text as n from crm_review_requests where contact_id = $1", [held])).toBe(0);
    expect(await count("select count(*)::text as n from conversations where contact_id = $1", [held])).toBe(0);
    const audits = await all<{ result: string; metadata: Record<string, unknown> }>("select result, metadata from audit_logs where org_id = $1 and action = 'crm.review_request_held' and target_id = $2 order by id", [s.m.org.id, held]);
    expect(audits).toEqual(["workflow", "api", "program", "batch"].map((via) => ({ result: "denied", metadata: { via, reason: "held_by_person" } })));
    // The Reviews numbers show the pattern, in this workspace only.
    expect((await getReviewStats(s.viewer)).heldByPerson).toBe(4);
    expect((await getReviewStats(b.viewer)).heldByPerson).toBe(0);
    // A person pressing Send is not stopped by it: the exclusion is about automatic messages.
    const manual = await requestReview(s.owner, { contactId: held, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, businessHoursOnly: false });
    expect(manual.requestId).toBeTruthy();
    expect(await one("select requested_via from crm_review_requests where id = $1", [manual.requestId])).toEqual({ requested_via: "manual" });
  });

  it("lets the automatic ask through again once the person includes the customer", async () => {
    const s = await reputationShop("Hold Again Shop");
    const contactId = await shopCustomer(s);
    await setRetentionPaused(s.m.ctx("owner"), contactId, true, "Waiting for a refund to clear");
    expect(await automaticAsk(s, contactId, "workflow")).toMatchObject({ status: "blocked", reason: "held_by_person" });
    await setRetentionPaused(s.m.ctx("owner"), contactId, false);
    expect(await automaticAsk(s, contactId, "workflow")).toMatchObject({ status: "queued" });
    expect(await one("select requested_via from crm_review_requests where contact_id = $1", [contactId])).toEqual({ requested_via: "workflow" });
  });

  it("is only ever set by a person, with a reason that stays in the audit trail, and never by a rating, a complaint or an escalation", async () => {
    const s = await reputationShop("Hold Reason Shop");
    const unhappy = await shopCustomer(s);
    const g = await giveFeedback(s, unhappy, { rating: "1", comment: "This was unacceptable." });
    expect(g.result.escalated).toBe(true);
    expect(await one("select retention_paused from contacts where id = $1", [unhappy])).toEqual({ retention_paused: false });
    // Low feedback stops program messages once; it does not exclude the person from future asks or programs.
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action in ('contact.retention_paused', 'crm.review_request_held')", [s.m.org.id])).toBe(0);

    const other = await shopCustomer(s);
    await expectError(setRetentionPaused(s.m.ctx("viewer"), other, true, "Not allowed"), "forbidden");
    await expectError(setRetentionPaused(s.m.ctx("owner"), other, true, "x".repeat(201)), "invalid_input");
    await setRetentionPaused(s.m.ctx("sales"), other, true, "  Customer asked us\n to stop   writing  ");
    await setRetentionPaused(s.m.ctx("sales"), other, false);
    const rows = await all<{ action: string; actor_user_id: string; metadata: Record<string, unknown> }>(
      "select action, actor_user_id, metadata from audit_logs where org_id = $1 and action like 'contact.retention_%' and target_id = $2 order by id", [s.m.org.id, other]);
    expect(rows).toEqual([
      { action: "contact.retention_paused", actor_user_id: s.m.people.sales.id, metadata: { reason: "Customer asked us to stop writing" } },
      { action: "contact.retention_resumed", actor_user_id: s.m.people.sales.id, metadata: {} },
    ]);
  });
});

describe("the Retention page keeps hand-recorded feedback apart from what customers send", () => {
  it("lists only feedback recorded on a customer there, and points to the low feedback that still waits in Reviews", async () => {
    const s = await reputationShop("Retention Page Shop");
    const account = await one<{ id: string }>("insert into retention_accounts (org_id, customer_name) values ($1, 'Acme Dental') returning id", [s.m.org.id]);
    await withSystem((db) => db.query("insert into customer_feedback (org_id, account_id, rating, comment) values ($1, $2, 5, 'Handwritten note')", [s.m.org.id, account.id]));
    const low = await giveFeedback(s, await shopCustomer(s), { rating: "1", comment: "Cold room." });
    await giveFeedback(s, await shopCustomer(s), { rating: "5", comment: "Lovely." });

    // Before: every row showed here, customers' private answers as anonymous "Customer" cards, averaged with the hand-recorded ones.
    const data = await getRetention(s.m.ctx("owner"));
    expect(data.feedback.map((f) => ({ name: f.customer_name, rating: f.rating, comment: f.comment }))).toEqual([{ name: "Acme Dental", rating: 5, comment: "Handwritten note" }]);
    expect(data.lowFeedbackOpen).toBe(1);
    await setFeedbackFollowUp(s.manager, low.result.feedbackId!, "acknowledged");
    expect((await getRetention(s.m.ctx("owner"))).lowFeedbackOpen).toBe(0);

    // Another workspace sees neither the rows nor the count.
    const theirs = await getRetention(b.m.ctx("owner"));
    expect(theirs.feedback.some((f) => f.comment === "Handwritten note")).toBe(false);
    expect(theirs.lowFeedbackOpen).toBe(0);
  });
});

describe("what the contact's card and the lists show", () => {
  it("shows the latest answers and the follow-up still open on the contact, only to people who can see contacts", async () => {
    const s = await reputationShop("Card Shop");
    const contactId = await shopCustomer(s);
    expect(await getContactReputation(s.viewer, contactId)).toEqual({ feedback: [], open: null, total: 0 });
    const low = await giveFeedback(s, contactId, { rating: "1", comment: "Cold room." });
    const card = await getContactReputation(s.viewer, contactId);
    expect(card.total).toBe(1);
    expect(card.open).toMatchObject({ id: low.result.feedbackId, lowScore: true, followUpStatus: "escalated", comment: "Cold room." });
    expect(card.open?.taskId).toBeTruthy();
    expect(card.open?.conversationId).toBe((await one<{ conversation_id: string }>("select conversation_id from conversation_messages where id = $1", [low.messageId])).conversation_id);
    await setFeedbackFollowUp(s.owner, low.result.feedbackId!, "resolved");
    expect((await getContactReputation(s.viewer, contactId)).open).toBeNull();
    await expectError(getContactReputation(s.viewer, "nope"), "not_found");
  });

  it("finds the follow-up still open even when it is older than the latest few answers", async () => {
    const s = await reputationShop("Old Follow-up Shop");
    const contactId = await shopCustomer(s);
    const insert = (rating: number, low: boolean, status: string, daysAgo: number) => withSystem((db) => db.query(
      "insert into customer_feedback (org_id, contact_id, rating, source, low_score, follow_up_status, received_at) values ($1, $2, $3, 'import', $4, $5, now() - make_interval(days => $6::int))",
      [s.m.org.id, contactId, rating, low, status, daysAgo]));
    await insert(1, true, "escalated", 40);
    for (let i = 0; i < 6; i += 1) await insert(5, false, "new", 6 - i);
    const card = await getContactReputation(s.viewer, contactId);
    expect(card.total).toBe(7);
    expect(card.feedback).toHaveLength(5);
    expect(card.feedback.every((f) => f.rating === 5)).toBe(true);
    expect(card.open).toMatchObject({ rating: 1, lowScore: true, followUpStatus: "escalated" });
  });

  it("keeps each workspace's feedback, follow-ups and cards to itself", async () => {
    const s = await reputationShop("Isolated Shop");
    const mine = await giveFeedback(s, await shopCustomer(s), { rating: "1" });
    const contactId = (await feedbackRow(mine.result.feedbackId!)).contact_id!;
    expect((await listFeedback(b.owner, { filter: "all", pageSize: 100 })).rows.some((r) => r.id === mine.result.feedbackId)).toBe(false);
    await expectError(setFeedbackFollowUp(b.owner, mine.result.feedbackId!, "resolved"), "not_found");
    expect(await getContactReputation(b.owner, contactId)).toEqual({ feedback: [], open: null, total: 0 });
    expect((await feedbackRow(mine.result.feedbackId!)).follow_up_status).toBe("escalated");
    // A token only ever reaches its own workspace's page, and a token of another workspace's request cannot be used to find this one's.
    expect(await tokenOf(mine.requestId)).toBe(mine.token);
    expect((await loadReviewPage(mine.token)).business?.name).toBe("Isolated Shop");
  });
});
