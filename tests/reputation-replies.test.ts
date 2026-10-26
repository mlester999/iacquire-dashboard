// Replies to public reviews: who may write, approve and post one; that an approval is of one version and is checked again, against the review and the words, at the moment of
// posting; that a reply is written down as "sending" before the request leaves and is never sent twice when the answer is lost; that a person can say what happened; and that one
// workspace never sees or changes another's replies. The review site is the in-process simulated one; nothing reaches a real service.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { simulatedReviewProvider, simulatedReviews } from "@/server/reputation/providers/simulated";
import { ProviderError } from "@/server/reputation/providers/types";
import { replyApprovalHash, reviewFingerprint } from "@/server/reputation/reply-hash";
import {
  RECONCILE_GIVE_UP_HOURS, RECONCILE_GRACE_MINUTES, cancelReply, decideReply, editReply, postReply, reconcileDueReplies, reconcileReply, resolveReply, startReply, submitReply,
} from "@/server/reputation/replies";
import { syncConnection } from "@/server/reputation/sync";
import { agencyPeople } from "./support/crm";
import { all, CALM_REPLY, connectSim, count, mirrored, one, replyEvents, replyOf, reviewsShop, setReviews, simReview, type ReputationShop } from "./support/reputation";
import type { ConnectionView } from "@/server/reputation/connections";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

async function expectError(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; message?: string });
  expect(err, "expected a refusal").not.toBeNull();
  expect(err?.code).toBe(code);
  if (message) expect(err?.message).toMatch(message);
}

const T0 = new Date();
let s: ReputationShop;
let other: ReputationShop;
let c: ConnectionView;
let cOther: ConnectionView;
let used = 0;

beforeAll(async () => {
  simulatedReviews.reset();
  s = await reviewsShop("Replies Shop");
  other = await reviewsShop("Other Replies Shop");
  const seed = (label: string) => Array.from({ length: 120 }, (_, i) => simReview(`${label}${String(i).padStart(2, "0")}`, { rating: 1 + (i % 5), daysAgo: 2 + i / 10 }));
  c = await connectSim(s, "google", seed("rv"));
  cOther = await connectSim(other, "google", seed("ov"));
  await syncConnection(c.id, { now: T0 });
  await syncConnection(cOther.id, { now: T0 });
});

/** A review nothing has been done to yet. */
async function fresh(): Promise<{ id: string; providerId: string }> {
  const providerId = `rv${String(used++).padStart(2, "0")}`;
  return { id: (await mirrored(c.id, providerId)).id, providerId };
}
const replyCalls = () => simulatedReviews.replyCalls().length;
const newReply = async (body = CALM_REPLY, who = s.sales) => {
  const r = await fresh();
  const { id } = await startReply(who, r.id, { body });
  return { ...r, replyId: id };
};
const pending = async (body = CALM_REPLY) => {
  const r = await newReply(body);
  await submitReply(s.sales, r.replyId, { version: 1 });
  return r;
};
const approved = async (body = CALM_REPLY) => {
  const r = await pending(body);
  await decideReply(s.owner, r.replyId, { decision: "approve", version: 1 });
  return r;
};
const status = async (replyId: string) => (await one<{ status: string }>("select status from review_replies where id = $1", [replyId])).status;
const notified = (kind: string, orgId = s.m.org.id) => count("select count(*)::text as n from notifications where org_id = $1 and kind = $2", [orgId, kind]);
const audited = (action: string, targetId: string) => count("select count(*)::text as n from audit_logs where org_id = $1 and action = $2 and target_id = $3", [s.m.org.id, action, targetId]);

describe("starting a reply", () => {
  it("is allowed to the people who can write replies, as a draft with its author, and nobody else", async () => {
    for (const who of [s.owner, s.manager, s.sales, s.support]) {
      const r = await fresh();
      const { id } = await startReply(who, r.id, { body: CALM_REPLY });
      expect(await replyOf(r.id)).toMatchObject({ id, status: "draft", version: 1, origin: "human", body: CALM_REPLY, approved_version: null, author_id: who.userId });
      expect((await replyEvents(id)).map((e) => e.kind)).toEqual(["created"]);
      expect(await audited("reputation.reply_created", id)).toBe(1);
    }
    const r = await fresh();
    await expectError(startReply(s.viewer, r.id, { body: CALM_REPLY }), "forbidden", /can't write replies/);
    expect(await count("select count(*)::text as n from review_replies where review_id = $1", [r.id])).toBe(0);
  });

  it("holds the words to the rules for public replies before anything is saved, and names the one to fix", async () => {
    const r = await fresh();
    const cases: Array<[string, RegExp]> = [
      ["Thank you. Call us on 555-123-4567.", /phone/i], ["See https://example.test/help for more.", /web address/i], ["We will refund you in full.", /refund/i],
      ["Please reconsider your review.", /reconsider|review/i], ["We remember you from your appointment.", /customer or patient/i], ["", /Write a reply/],
    ];
    for (const [body, message] of cases) await expectError(startReply(s.sales, r.id, { body }), "invalid_input", message);
    expect(await count("select count(*)::text as n from review_replies where review_id = $1", [r.id])).toBe(0);
  });

  it("allows one reply in progress per review, and a new one once the last is closed", async () => {
    const r = await newReply();
    await expectError(startReply(s.sales, r.id, { body: CALM_REPLY }), "conflict", /already has a reply in progress/);
    await cancelReply(s.sales, r.replyId);
    const again = await startReply(s.sales, r.id, { body: `${CALM_REPLY} We read every review.` });
    expect(again.id).not.toBe(r.replyId);
    expect(await count("select count(*)::text as n from review_replies where review_id = $1", [r.id])).toBe(2);
  });

  it("cannot answer a review that is gone from the site or whose connection needs attention, or one that is another workspace's", async () => {
    const gone = await fresh();
    await withSystem((db) => db.query("update external_reviews set removed_at = now() where id = $1", [gone.id]));
    await expectError(startReply(s.sales, gone.id, { body: CALM_REPLY }), "conflict", /no longer on the review site/);
    const t = await reviewsShop("Needs Attention Shop");
    const tc = await connectSim(t, "google", [simReview("na1")]);
    await syncConnection(tc.id, { now: T0 });
    const review = await mirrored(tc.id, "na1");
    await withSystem((db) => db.query("update review_connections set status = 'needs_reauth' where id = $1", [tc.id]));
    await expectError(startReply(t.sales, review.id, { body: CALM_REPLY }), "conflict", /needs attention/);
    // Another workspace's review looks like no review at all.
    const theirs = await mirrored(cOther.id, "ov00");
    await expectError(startReply(s.sales, theirs.id, { body: CALM_REPLY }), "not_found");
    await expectError(startReply(s.sales, "00000000-0000-4000-8000-000000000000", { body: CALM_REPLY }), "not_found");
  });

  it("is not available where public reviews are off, and stays readable", async () => {
    const t = await reviewsShop("Dormant Replies Shop");
    const tc = await connectSim(t, "google", [simReview("d1")]);
    await syncConnection(tc.id, { now: T0 });
    const review = await mirrored(tc.id, "d1");
    await setReviews(t.m.org.id, false);
    await expectError(startReply(t.sales, review.id, { body: CALM_REPLY }), "not_enabled", /aren't switched on/);
    expect((await mirrored(tc.id, "d1")).rating).toBe(5); // what was read is still there
  });

  it("lets iAcquire support write a reply only in a write session, never approve or post it", async () => {
    const { superAdmin } = await agencyPeople();
    const r = await fresh();
    await startSupportSession(superAdmin, s.m.org.id, { mode: "read", reason: "Looking at replies (read)" });
    await expectError(startReply(await agencyActor(superAdmin, s.m.org.id), r.id, { body: CALM_REPLY }), "forbidden", /write session/);
    await startSupportSession(superAdmin, s.m.org.id, { mode: "write", reason: "Helping with a reply (write)" });
    const agency = await agencyActor(superAdmin, s.m.org.id);
    const { id } = await startReply(agency, r.id, { body: CALM_REPLY });
    expect((await replyOf(r.id)).author_id).toBe(superAdmin.id);
    await submitReply(agency, id, { version: 1 });
    await expectError(decideReply(agency, id, { decision: "approve", version: 1 }), "forbidden", /Only the client's own owner or a manager/);
    await decideReply(s.owner, id, { decision: "approve", version: 1 });
    await expectError(postReply(agency, id), "forbidden", /can't/);
    await expectError(resolveReply(agency, id, { outcome: "posted" }), "forbidden");
    expect(await status(id)).toBe("approved");
  });
});

describe("changing the words", () => {
  it("raises the version and withdraws any approval, so what is approved is always what was read", async () => {
    const r = await approved();
    expect(await replyOf(r.id)).toMatchObject({ status: "approved", approved_version: 1 });
    const out = await editReply(s.sales, r.replyId, { body: `${CALM_REPLY} We read every review.`, expectedVersion: 1 });
    expect(out.version).toBe(2);
    expect(await replyOf(r.id)).toMatchObject({ status: "draft", version: 2, approved_version: null, approved_hash: null, approved_by: null, decision_note: null });
    expect((await replyEvents(r.replyId)).map((e) => e.kind)).toEqual(["created", "submitted", "approved", "edited"]);
    expect(await one("select detail from review_reply_events where reply_id = $1 and kind = 'edited'", [r.replyId])).toMatchObject({ detail: { fromVersion: 1, approvalVoided: true } });
    await expectError(postReply(s.owner, r.replyId), "conflict", /has not been approved/);
  });

  it("changes nothing when the words are the same, and refuses a stale version, rule-breaking words and a stranger's edit", async () => {
    const r = await newReply();
    expect(await editReply(s.sales, r.replyId, { body: `  ${CALM_REPLY}\r\n`, expectedVersion: 1 })).toEqual({ version: 1 });
    await expectError(editReply(s.sales, r.replyId, { body: "New words that are fine, thank you.", expectedVersion: 5 }), "conflict", /Someone changed this reply/);
    await expectError(editReply(s.sales, r.replyId, { body: "Visit www.example.test now.", expectedVersion: 1 }), "invalid_input");
    await expectError(editReply(s.support, r.replyId, { body: "New words that are fine, thank you.", expectedVersion: 1 }), "forbidden", /person who wrote this reply/);
    await expectError(editReply(s.viewer, r.replyId, { body: "New words that are fine, thank you.", expectedVersion: 1 }), "forbidden");
    // The owner may change anyone's.
    expect((await editReply(s.owner, r.replyId, { body: "Thanks for writing. We would like to hear more.", expectedVersion: 1 })).version).toBe(2);
  });

  it("cannot edit a reply that is being sent, is posted, or whose result is unknown", async () => {
    for (const st of ["posting", "posted", "needs_reconciliation"] as const) {
      const r = await approved();
      await withSystem((db) => db.query("update review_replies set status = $2, sending_at = now(), posted_at = case when $2 = 'posted' then now() else null end, posted_via = case when $2 = 'posted' then 'provider' else null end where id = $1", [r.replyId, st]));
      await expectError(editReply(s.owner, r.replyId, { body: "Different words that are fine, thank you.", expectedVersion: 1 }), "conflict");
    }
  });
});

describe("asking for approval", () => {
  it("tells the owner and the managers once for each version, and nobody twice", async () => {
    const before = await notified("review_reply_requested");
    const approvers = await count("select count(*)::text as n from organization_memberships where org_id = $1 and status = 'active' and role in ('owner', 'admin')", [s.m.org.id]);
    expect(approvers).toBeGreaterThanOrEqual(2);
    const r = await newReply();
    await submitReply(s.sales, r.replyId, { version: 1 });
    expect(await status(r.replyId)).toBe("pending_approval");
    expect(await notified("review_reply_requested")).toBe(before + approvers); // the owner and the managers
    await expectError(submitReply(s.sales, r.replyId, { version: 1 }), "conflict", /can't be sent for approval/);
    expect(await notified("review_reply_requested")).toBe(before + approvers);
    const note = await one<{ title: string; body: string | null; link: string | null }>("select title, body, link from notifications where org_id = $1 and kind = 'review_reply_requested' order by created_at desc limit 1", [s.m.org.id]);
    expect(`${note.title} ${note.body}`).not.toContain(CALM_REPLY);
    expect(note.link).toBe(`/crm/reviews?tab=public&review=${r.id}`);
  });

  it("is for the author or the owner and managers, a current version, and words that still pass the rules", async () => {
    const r = await newReply();
    await expectError(submitReply(s.support, r.replyId, { version: 1 }), "forbidden");
    await expectError(submitReply(s.sales, r.replyId, { version: 3 }), "conflict", /Someone changed this reply/);
    await withSystem((db) => db.query("update review_replies set body = 'Thank you, call 555-123-4567 any time.' where id = $1", [r.replyId]));
    await expectError(submitReply(s.sales, r.replyId, { version: 1 }), "invalid_input", /phone/i);
    expect(await status(r.replyId)).toBe("draft");
  });
});

describe("the decision", () => {
  it("is the owner's or a manager's alone, and approving records which version, by whom and a hash of the review and the words", async () => {
    const r = await pending();
    for (const who of [s.sales, s.support, s.viewer]) await expectError(decideReply(who, r.replyId, { decision: "approve", version: 1 }), "forbidden", /owner or a manager/);
    expect(await status(r.replyId)).toBe("pending_approval");
    const before = await notified("review_reply_decided");
    await decideReply(s.manager, r.replyId, { decision: "approve", version: 1, note: "Good." });
    const row = await replyOf(r.id);
    expect(row).toMatchObject({ status: "approved", approved_version: 1, approved_by: s.manager.userId, decision_note: "Good." });
    expect(row.approved_hash).toMatch(/^[0-9a-f]{64}$/);
    const live = await mirrored(c.id, r.providerId);
    expect(row.approved_hash).toBe(replyApprovalHash({ orgId: s.m.org.id, connectionId: c.id, reviewId: r.id, providerReviewId: r.providerId, fingerprint: reviewFingerprint(live), version: 1, body: CALM_REPLY }));
    // The author is told, once. The decision is audited, and the history says who.
    expect(await notified("review_reply_decided")).toBe(before + 1);
    expect(await audited("reputation.reply_approved", r.replyId)).toBe(1);
    expect((await replyEvents(r.replyId)).map((e) => e.kind)).toEqual(["created", "submitted", "approved"]);
  });

  it("asks for changes with a reason, which sends it back to be edited and sent again, or rejects it for good", async () => {
    const r = await pending();
    await expectError(decideReply(s.owner, r.replyId, { decision: "request_changes", version: 1 }), "invalid_input", /Say what should change/);
    await decideReply(s.owner, r.replyId, { decision: "request_changes", version: 1, note: "Take out the second sentence." });
    expect(await replyOf(r.id)).toMatchObject({ status: "changes_requested", decision_note: "Take out the second sentence.", approved_version: null });
    await editReply(s.sales, r.replyId, { body: "Thank you for writing. We would like to hear more.", expectedVersion: 1 });
    await submitReply(s.sales, r.replyId, { version: 2 });
    await decideReply(s.owner, r.replyId, { decision: "reject", version: 2, note: "Not needed." });
    expect(await status(r.replyId)).toBe("rejected");
    await expectError(editReply(s.owner, r.replyId, { body: "Another fine try at this reply.", expectedVersion: 2 }), "conflict");
    await expectError(postReply(s.owner, r.replyId), "conflict");
    // A rejected reply is closed: a new one can be started.
    expect((await startReply(s.sales, r.id, { body: CALM_REPLY })).id).not.toBe(r.replyId);
  });

  it("only decides the version that was read, and only a reply that is waiting", async () => {
    const r = await pending();
    await editReply(s.owner, r.replyId, { body: "Thanks for writing. We would like to hear more.", expectedVersion: 1 }); // back to a draft at version 2
    await expectError(decideReply(s.owner, r.replyId, { decision: "approve", version: 1 }), "conflict", /not waiting for approval/);
    await submitReply(s.owner, r.replyId, { version: 2 });
    await expectError(decideReply(s.owner, r.replyId, { decision: "approve", version: 1 }), "conflict", /changed while you were reading/);
    await decideReply(s.owner, r.replyId, { decision: "approve", version: 2 });
    await expectError(decideReply(s.owner, r.replyId, { decision: "approve", version: 2 }), "conflict", /not waiting for approval/);
  });

  it("lets the owner approve what they wrote themselves: the owner is the business, and the approval is still of those exact words", async () => {
    const r = await newReply(CALM_REPLY, s.owner);
    await submitReply(s.owner, r.replyId, { version: 1 });
    await decideReply(s.owner, r.replyId, { decision: "approve", version: 1 });
    expect(await status(r.replyId)).toBe("approved");
  });

  it("will not approve words that no longer pass the rules, and leaves the reply waiting", async () => {
    const r = await pending();
    await withSystem((db) => db.query("update review_replies set body = 'Thank you, call 555-123-4567 any time.' where id = $1", [r.replyId]));
    await expectError(decideReply(s.owner, r.replyId, { decision: "approve", version: 1 }), "invalid_input", /phone/i);
    expect(await status(r.replyId)).toBe("pending_approval");
    expect(await replyOf(r.id)).toMatchObject({ approved_version: null, approved_hash: null, approved_by: null });
  });

  it("refuses to approve for a review that has gone or whose connection needs attention", async () => {
    const r = await pending();
    await withSystem((db) => db.query("update external_reviews set removed_at = now() where id = $1", [r.id]));
    await expectError(decideReply(s.owner, r.replyId, { decision: "approve", version: 1 }), "conflict", /no longer on the review site/);
    expect(await status(r.replyId)).toBe("pending_approval");
  });
});

describe("posting", () => {
  it("sends exactly the approved words once, records that it did, and keeps the words on the review", async () => {
    const r = await approved();
    const calls = replyCalls();
    const out = await postReply(s.owner, r.replyId, { now: new Date() });
    expect(out.status).toBe("posted");
    expect(replyCalls()).toBe(calls + 1);
    expect(simulatedReviews.replyCalls().at(-1)?.text).toBe(CALM_REPLY);
    expect(simulatedReviews.replyOf(c.externalLocationId, r.providerId)).toBe(CALM_REPLY);
    expect(await replyOf(r.id)).toMatchObject({ status: "posted", posted_via: "provider", failure_code: null });
    expect((await replyOf(r.id)).sending_at).not.toBeNull();
    expect((await replyOf(r.id)).verified_at).not.toBeNull(); // the site was asked and shows it
    expect((await mirrored(c.id, r.providerId)).provider_reply_text).toBe(CALM_REPLY);
    expect((await replyEvents(r.replyId)).map((e) => e.kind)).toEqual(["created", "submitted", "approved", "posting", "posted"]);
    expect(await audited("reputation.reply_posting", r.replyId)).toBe(1);
    expect(await audited("reputation.reply_posted", r.replyId)).toBe(1);
    // A posted reply is closed: it is not posted again, and cannot be.
    await expectError(postReply(s.owner, r.replyId), "conflict", /already posted/);
    expect(replyCalls()).toBe(calls + 1);
  });

  it("is for the owner and managers alone, and only for a reply that was approved", async () => {
    const r = await approved();
    for (const who of [s.sales, s.support, s.viewer]) await expectError(postReply(who, r.replyId), "forbidden", /owner or a manager/);
    const draft = await newReply();
    await expectError(postReply(s.owner, draft.replyId), "conflict", /has not been approved/);
    const waiting = await pending();
    await expectError(postReply(s.owner, waiting.replyId), "conflict", /has not been approved/);
    const calls = replyCalls();
    expect((await postReply(s.manager, r.replyId)).status).toBe("posted");
    expect(replyCalls()).toBe(calls + 1);
  });

  it("is checked again at the moment of posting: words changed behind the approval, or a review edited after it, are not posted", async () => {
    const calls = replyCalls();
    const words = await approved();
    await withSystem((db) => db.query("update review_replies set body = $2 where id = $1", [words.replyId, `${CALM_REPLY} Plus a sentence nobody approved.`]));
    await expectError(postReply(s.owner, words.replyId), "conflict", /changed after it was approved/);
    expect(await status(words.replyId)).toBe("approved");

    const edited = await approved();
    await withSystem((db) => db.query("update external_reviews set comment = 'A different review than the one that was answered.' where id = $1", [edited.id]));
    await expectError(postReply(s.owner, edited.replyId), "conflict", /changed after it was approved/);

    const version = await approved();
    await withSystem((db) => db.query("update review_replies set version = 2 where id = $1", [version.replyId]));
    await expectError(postReply(s.owner, version.replyId), "conflict", /earlier version/);

    const moved = await approved();
    const elsewhere = await fresh();
    await withSystem((db) => db.query("update review_replies set review_id = $2 where id = $1", [moved.replyId, elsewhere.id]));
    await expectError(postReply(s.owner, moved.replyId), "conflict", /changed after it was approved/);
    expect(replyCalls()).toBe(calls);
  });

  it("holds even an approved reply to the rules as they are when it is posted", async () => {
    const calls = replyCalls();
    const r = await approved();
    const bad = "Thank you for writing. Visit www.example.test to claim your discount.";
    const live = await mirrored(c.id, r.providerId);
    // (What a bug or a tampering would have to do: put words that break the rules behind a hash that matches them.)
    const hash = replyApprovalHash({ orgId: s.m.org.id, connectionId: c.id, reviewId: r.id, providerReviewId: r.providerId, fingerprint: reviewFingerprint(live), version: 1, body: bad });
    await withSystem((db) => db.query("update review_replies set body = $2, approved_hash = $3 where id = $1", [r.replyId, bad, hash]));
    await expectError(postReply(s.owner, r.replyId), "invalid_input");
    expect(replyCalls()).toBe(calls);
    expect(await status(r.replyId)).toBe("approved");
  });

  it("sends once however many times Post is pressed at the same moment", async () => {
    const r = await approved();
    const calls = replyCalls();
    const results = await Promise.allSettled([postReply(s.owner, r.replyId), postReply(s.owner, r.replyId), postReply(s.manager, r.replyId)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(replyCalls()).toBe(calls + 1);
    expect(await status(r.replyId)).toBe("posted");
  });

  it("is not offered for a review that is gone or a connection that needs attention, and sends nothing", async () => {
    const calls = replyCalls();
    const gone = await approved();
    await withSystem((db) => db.query("update external_reviews set removed_at = now() where id = $1", [gone.id]));
    await expectError(postReply(s.owner, gone.replyId), "conflict", /no longer on the review site/);
    const t = await reviewsShop("Post Attention Shop");
    const tc = await connectSim(t, "google", [simReview("pa1")]);
    await syncConnection(tc.id, { now: T0 });
    const review = await mirrored(tc.id, "pa1");
    const { id } = await startReply(t.sales, review.id, { body: CALM_REPLY });
    await submitReply(t.sales, id, { version: 1 });
    await decideReply(t.owner, id, { decision: "approve", version: 1 });
    await withSystem((db) => db.query("update review_connections set status = 'needs_reauth' where id = $1", [tc.id]));
    await expectError(postReply(t.owner, id), "conflict", /needs attention/);
    expect(replyCalls()).toBe(calls);
  });

  it("says why posting from here is not available, sends nothing, and lets a person say they posted it themselves", async () => {
    const t = await reviewsShop("No Post Shop");
    const tc = await connectSim(t, "google", [simReview("np1")]);
    await syncConnection(tc.id, { now: T0 });
    const review = await mirrored(tc.id, "np1");
    const { id } = await startReply(t.sales, review.id, { body: CALM_REPLY });
    await submitReply(t.sales, id, { version: 1 });
    await decideReply(t.owner, id, { decision: "approve", version: 1 });
    const calls = replyCalls();
    simulatedReviews.setReplySupport(false);
    await expectError(postReply(t.owner, id), "unavailable", /set not to take replies/);
    expect(await status(id)).toBe("approved");
    await expectError(resolveReply(t.sales, id, { outcome: "posted" }), "forbidden");
    await resolveReply(t.owner, id, { outcome: "posted" });
    simulatedReviews.setReplySupport(true);
    expect(await replyOf(review.id)).toMatchObject({ status: "posted", posted_via: "person", verified_at: null });
    expect(replyCalls()).toBe(calls);
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'reputation.reply_resolved' and target_id = $2", [t.m.org.id, id])).toBe(1);
    // It was the person's word, and the mirror does not pretend the site shows it.
    expect((await mirrored(tc.id, "np1")).provider_reply_text).toBeNull();
  });

  it("does not let a person call an approved reply posted while it can still be posted from here, and sends nothing for the attempt", async () => {
    const r = await approved();
    const calls = replyCalls();
    await expectError(resolveReply(s.owner, r.replyId, { outcome: "posted" }), "conflict", /can't be marked as posted/);
    await expectError(resolveReply(s.owner, r.replyId, { outcome: "not_posted" }), "conflict", /being checked/);
    expect(await status(r.replyId)).toBe("approved");
    expect(replyCalls()).toBe(calls);
  });
});

describe("when the site does not take the reply", () => {
  it("records a refusal as not posted, with the reason, tells the team, and lets the same words be tried again", async () => {
    const r = await approved();
    const before = await notified("review_reply_failed");
    simulatedReviews.failNext("reply", new ProviderError("invalid_content", "The review site refused the reply."));
    expect((await postReply(s.owner, r.replyId)).status).toBe("failed");
    expect(await replyOf(r.id)).toMatchObject({ status: "failed", failure_code: "invalid_content", approved_version: 1 });
    expect((await one<{ failure_message: string }>("select failure_message from review_replies where id = $1", [r.replyId])).failure_message).toBe("The review site refused the reply.");
    expect(await notified("review_reply_failed")).toBeGreaterThan(before);
    expect(simulatedReviews.replyOf(c.externalLocationId, r.providerId)).toBeNull();
    // The approval stands, so a person can press Post again.
    expect((await postReply(s.owner, r.replyId)).status).toBe("posted");
    expect(simulatedReviews.replyOf(c.externalLocationId, r.providerId)).toBe(CALM_REPLY);
    expect((await replyEvents(r.replyId)).map((e) => e.kind)).toEqual(["created", "submitted", "approved", "posting", "failed", "posting", "posted"]);
  });

  it("marks the connection as needing to be reconnected when the site stops accepting the sign-in", async () => {
    const t = await reviewsShop("Reauth Reply Shop");
    const tc = await connectSim(t, "google", [simReview("ra1")]);
    await syncConnection(tc.id, { now: T0 });
    const review = await mirrored(tc.id, "ra1");
    const { id } = await startReply(t.sales, review.id, { body: CALM_REPLY });
    await submitReply(t.sales, id, { version: 1 });
    await decideReply(t.owner, id, { decision: "approve", version: 1 });
    simulatedReviews.failNext("reply", new ProviderError("auth", "The review site no longer accepts this sign-in. Reconnect it.", { needsReauth: true }));
    expect((await postReply(t.owner, id)).status).toBe("failed");
    expect((await one<{ status: string }>("select status from review_connections where id = $1", [tc.id])).status).toBe("needs_reauth");
  });

  it("never sends a reply a second time when the answer was lost: it is checked, and found on the site", async () => {
    const r = await approved();
    const calls = replyCalls();
    simulatedReviews.loseResponseNext("reply");
    const out = await postReply(s.owner, r.replyId);
    expect(out.status).toBe("needs_reconciliation");
    expect(replyCalls()).toBe(calls + 1);
    expect(await replyOf(r.id)).toMatchObject({ status: "needs_reconciliation", failure_code: "unknown_outcome" });
    expect((await replyOf(r.id)).sending_at).not.toBeNull();
    // Nothing can send it again, change it or cancel it while its result is unknown.
    await expectError(postReply(s.owner, r.replyId), "conflict", /sent or checked/);
    await expectError(editReply(s.owner, r.replyId, { body: "Different words that are fine, thank you.", expectedVersion: 1 }), "conflict");
    await expectError(cancelReply(s.owner, r.replyId), "conflict", /sent or checked/);
    expect(replyCalls()).toBe(calls + 1);
    // The check finds it word for word: posted, confirmed, and still sent only once.
    expect(await reconcileReply(s.m.org.id, r.replyId)).toBe("posted");
    expect(await replyOf(r.id)).toMatchObject({ status: "posted", posted_via: "provider", failure_code: null });
    expect((await replyOf(r.id)).verified_at).not.toBeNull();
    expect((await mirrored(c.id, r.providerId)).provider_reply_text).toBe(CALM_REPLY);
    expect(replyCalls()).toBe(calls + 1);
    expect((await replyEvents(r.replyId)).map((e) => e.kind)).toEqual(["created", "submitted", "approved", "posting", "outcome_unknown", "posted_confirmed"]);
  });

  describe("settling a reply whose result is unknown", () => {
    const lost = async () => {
      const r = await approved();
      await withSystem((db) => db.query("update review_replies set status = 'needs_reconciliation', sending_at = $2, failure_code = 'unknown_outcome' where id = $1", [r.replyId, new Date(Date.now() - 30 * 60_000)]));
      return r;
    };

    it("waits while the site might still be catching up, then treats a reply it does not show as not posted", async () => {
      const r = await lost();
      const sent = new Date((await one<{ sending_at: Date }>("select sending_at from review_replies where id = $1", [r.replyId])).sending_at);
      expect(await reconcileReply(s.m.org.id, r.replyId, { now: new Date(sent.getTime() + (RECONCILE_GRACE_MINUTES - 2) * 60_000) })).toBe("waiting");
      expect(await status(r.replyId)).toBe("needs_reconciliation");
      expect(await reconcileReply(s.m.org.id, r.replyId, { now: new Date(sent.getTime() + (RECONCILE_GRACE_MINUTES + 1) * 60_000) })).toBe("failed");
      expect(await replyOf(r.id)).toMatchObject({ status: "failed", failure_code: "not_found_after_send" });
      // The approval stands: it can be tried again.
      expect((await postReply(s.owner, r.replyId)).status).toBe("posted");
    });

    it("does not call a different reply on the site its own, and does not overwrite it", async () => {
      const r = await lost();
      simulatedReviews.setReply(c.externalLocationId, r.providerId, "Someone on the team already answered this.");
      expect(await reconcileReply(s.m.org.id, r.replyId)).toBe("failed");
      expect(await replyOf(r.id)).toMatchObject({ status: "failed", failure_code: "different_reply_on_site" });
      expect(simulatedReviews.replyOf(c.externalLocationId, r.providerId)).toBe("Someone on the team already answered this.");
    });

    it("keeps waiting while the site cannot say, and after a whole day asks the owner and managers to look at the site themselves, once", async () => {
      const r = await lost();
      const sent = new Date((await one<{ sending_at: Date }>("select sending_at from review_replies where id = $1", [r.replyId])).sending_at);
      const cannotSay = { ...simulatedReviewProvider, readReply: async () => ({ state: "uncertain" as const }) };
      const asked = () => count("select count(*)::text as n from notifications where org_id = $1 and dedupe_key like $2", [s.m.org.id, `review-reply-check:${r.replyId}:%`]);
      expect(await reconcileReply(s.m.org.id, r.replyId, { now: new Date(sent.getTime() + 2 * 3_600_000), provider: cannotSay })).toBe("waiting");
      expect(await asked()).toBe(0);
      const day = new Date(sent.getTime() + (RECONCILE_GIVE_UP_HOURS + 1) * 3_600_000);
      expect(await reconcileReply(s.m.org.id, r.replyId, { now: day, provider: cannotSay })).toBe("needs_person");
      const told = await asked();
      expect(told).toBeGreaterThanOrEqual(2);
      expect(await reconcileReply(s.m.org.id, r.replyId, { now: new Date(day.getTime() + 3_600_000), provider: cannotSay })).toBe("needs_person");
      expect(await asked()).toBe(told); // not told again
      expect(await status(r.replyId)).toBe("needs_reconciliation"); // and never sent again on a guess
    });

    it("leaves the reply as it is when the site could not be asked at all", async () => {
      const r = await lost();
      simulatedReviews.failNext("read", new ProviderError("transient", "The review site could not be reached."));
      expect(await reconcileReply(s.m.org.id, r.replyId)).toBe("waiting");
      expect(await status(r.replyId)).toBe("needs_reconciliation");
    });

    it("lets the owner say what happened: posted on their word, or not on the site, and nobody else", async () => {
      const a = await lost();
      const b = await lost();
      await expectError(resolveReply(s.sales, a.replyId, { outcome: "posted" }), "forbidden");
      await resolveReply(s.manager, a.replyId, { outcome: "posted" });
      expect(await replyOf(a.id)).toMatchObject({ status: "posted", posted_via: "person", verified_at: null });
      await resolveReply(s.owner, b.replyId, { outcome: "not_posted" });
      expect(await replyOf(b.id)).toMatchObject({ status: "failed", failure_code: "confirmed_not_posted" });
      await expectError(resolveReply(s.owner, a.replyId, { outcome: "not_posted" }), "conflict", /Only a reply whose result is being checked/);
      const plain = await approved();
      await expectError(resolveReply(s.owner, plain.replyId, { outcome: "not_posted" }), "conflict");
    });

    it("is done by the scheduler for every workspace that is active, and picks up a reply stuck in 'posting' after its worker died", async () => {
      const stuck = await approved();
      await withSystem((db) => db.query("update review_replies set status = 'posting', sending_at = $2 where id = $1", [stuck.replyId, new Date(Date.now() - 20 * 60_000)]));
      simulatedReviews.setReply(c.externalLocationId, stuck.providerId, CALM_REPLY); // it did go out
      const lostOne = await lost();
      const fine = await approved(); // approved, never started: not touched
      const out = await reconcileDueReplies({ limit: 50 });
      expect(out.posted).toBeGreaterThanOrEqual(1);
      expect(await status(stuck.replyId)).toBe("posted");
      expect(await status(fine.replyId)).toBe("approved");
      expect(["failed", "needs_reconciliation"]).toContain(await status(lostOne.replyId));
      expect((await replyEvents(stuck.replyId)).map((e) => e.kind)).toContain("posting_interrupted");
      // A suspended workspace's replies are left alone.
      const parked = await lost();
      await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [s.m.org.id]));
      await reconcileDueReplies({ limit: 50 });
      await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [s.m.org.id]));
      expect(await status(parked.replyId)).toBe("needs_reconciliation");
    });
  });
});

describe("cancelling", () => {
  it("is for the author or the owner and managers, before anything is sent", async () => {
    const r = await newReply();
    await expectError(cancelReply(s.support, r.replyId), "forbidden");
    await cancelReply(s.sales, r.replyId);
    expect(await replyOf(r.id)).toMatchObject({ status: "cancelled", approved_version: null });
    await expectError(cancelReply(s.sales, r.replyId), "conflict");
    const a = await approved();
    await cancelReply(s.manager, a.replyId);
    expect(await status(a.replyId)).toBe("cancelled");
    await expectError(postReply(s.owner, a.replyId), "conflict");
    expect(await audited("reputation.reply_cancelled", a.replyId)).toBe(1);
  });
});

describe("two workspaces never share replies", () => {
  it("cannot read, change, approve or post one another's reply, whatever ids are used", async () => {
    const theirs = await mirrored(cOther.id, "ov05");
    const { id } = await startReply(other.sales, theirs.id, { body: CALM_REPLY });
    await submitReply(other.sales, id, { version: 1 });
    const calls = replyCalls();
    for (const attempt of [
      () => editReply(s.owner, id, { body: "Words that are fine, thank you.", expectedVersion: 1 }),
      () => submitReply(s.owner, id, { version: 1 }),
      () => decideReply(s.owner, id, { decision: "approve", version: 1 }),
      () => postReply(s.owner, id),
      () => cancelReply(s.owner, id),
      () => resolveReply(s.owner, id, { outcome: "posted" }),
    ]) await expectError(attempt(), "not_found");
    expect(await status(id)).toBe("pending_approval");
    expect(replyCalls()).toBe(calls);
    expect(await count("select count(*)::text as n from review_replies where org_id = $1 and id = $2", [s.m.org.id, id])).toBe(0);
    expect(await all("select id from review_replies where org_id = $1 and review_id in (select id from external_reviews where org_id = $2)", [s.m.org.id, other.m.org.id])).toEqual([]);
    // They did approve it themselves, and it carries their workspace's connection, not ours.
    await decideReply(other.owner, id, { decision: "approve", version: 1 });
    expect((await postReply(other.owner, id)).status).toBe("posted");
    expect(simulatedReviews.replyOf(cOther.externalLocationId, "ov05")).toBe(CALM_REPLY);
    expect(simulatedReviews.replyOf(c.externalLocationId, "ov05")).toBeNull();
  });
});
