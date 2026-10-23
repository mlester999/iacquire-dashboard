// The batch job: an approved batch starts, its customers are asked at the batch's pace through the same checks as one review request, and anything that changes what the owner
// approved stops it. Synthetic workspaces on embedded Postgres; the provider is a recorder, nothing is sent anywhere.
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { adjustCredits } from "@/server/billing/ledger";
import { setClientPause } from "@/server/automation/controls";
import { setContactConsent } from "@/server/crm/contacts";
import { approveTemplate, updateTemplate } from "@/server/crm/message-templates";
import { loadReviewPage, requestReview } from "@/server/crm/reviews";
import { suppressAddress } from "@/server/messaging/contacts";
import { dispatchDue } from "@/server/messaging/send";
import { activeJobs, JOBS, runScheduledJobs } from "@/server/ops/tick";
import { approveBatch, cancelBatch, createBatch, getBatch, listBatchPeople, pauseBatch, previewBatch, requestBatchApproval, resumeBatch } from "@/server/reputation/batches";
import { advanceBatch, processReviewBatches } from "@/server/reputation/batch-job";
import { BATCH_STATUS_LABELS } from "@/lib/reputation/batches";
import { recordingProvider } from "./support/messaging";
import { all, attend, batchInput, count, one, reputationShop, setBatches, setSurveys, shopCustomer, type ReputationShop } from "./support/reputation";

// A test here makes up to 25 customers with visits before it starts, and the whole suite is run with many other files at once.
vi.setConfig({ testTimeout: 120_000 });

const T = new Date();
const secs = (s: number) => new Date(T.getTime() + s * 1000);

async function readyBatch(shop: ReputationShop, n: number, over: Parameters<typeof batchInput>[1] = {}) {
  await setBatches(shop.m.org.id, true);
  const contacts: string[] = [];
  const visits = new Map<string, string>();
  for (let i = 0; i < n; i += 1) {
    const c = await shopCustomer(shop, { firstName: `Pat${i}` });
    contacts.push(c);
    visits.set(c, await attend(shop, c));
  }
  const { id } = await createBatch(shop.owner, batchInput(shop, over));
  const p = await previewBatch(shop.owner, id);
  expect(p.problems, "the batch should be ready to approve").toEqual([]);
  await approveBatch(shop.owner, id, { fingerprint: p.fingerprint! });
  return { id, contacts, visits, org: shop.m.org.id };
}

const items = (id: string) => all<{ contact_id: string; status: string; reason: string | null; request_id: string | null; appointment_id: string | null; queued_at: Date | null }>(
  "select contact_id, status, reason, request_id, appointment_id, queued_at from review_request_batch_items where batch_id = $1 order by contact_id", [id],
);
const itemOf = (id: string, contactId: string) => one<{ status: string; reason: string | null; request_id: string | null }>("select status, reason, request_id from review_request_batch_items where batch_id = $1 and contact_id = $2", [id, contactId]);
const batchStatus = (id: string) => one<{ status: string; started_at: Date | null; completed_at: Date | null }>("select status, started_at, completed_at from review_request_batches where id = $1", [id]);
const statusCounts = async (id: string) => Object.fromEntries((await all<{ status: string; n: string }>("select status, count(*)::text as n from review_request_batch_items where batch_id = $1 group by status", [id])).map((r) => [r.status, Number(r.n)]));
const reasonsOf = async (id: string) => Object.fromEntries((await all<{ reason: string; n: string }>("select reason, count(*)::text as n from review_request_batch_items where batch_id = $1 and reason is not null group by reason", [id])).map((r) => [r.reason, Number(r.n)]));
const messageFor = (orgId: string, contactId: string) => one<{ id: string; status: string; body: string; scope: string; purpose: string; dedupe_key: string; send_after: Date; blocked_reason: string | null; status_detail: string | null }>(
  `select m.id, m.status, m.body, m.scope, m.purpose, m.dedupe_key, m.send_after, m.blocked_reason, m.status_detail from conversation_messages m join conversations c on c.id = m.conversation_id where m.org_id = $1 and c.contact_id = $2`, [orgId, contactId],
);
const requestsFor = (id: string) => all<{ id: string; contact_id: string; status: string; requested_via: string; kind: string; scale: string; appointment_id: string | null; requested_by: string | null; message_id: string | null; batch_id: string | null }>(
  "select id, contact_id, status, requested_via, kind, scale, appointment_id, requested_by, message_id, batch_id from crm_review_requests where batch_id = $1", [id],
);
/** The sends the recorder saw for this batch's messages. (The dispatcher takes every due message in the database, so a recorder also sees other tests' leftovers.) */
async function sentBy(rec: ReturnType<typeof recordingProvider>, batchId: string) {
  const ids = new Set((await requestsFor(batchId)).map((r) => r.message_id));
  return rec.calls.filter((c) => ids.has(c.messageId));
}
const audits = (orgId: string, action: string) => count("select count(*)::text as n from audit_logs where org_id = $1 and action = $2", [orgId, action]);
const phoneOf = async (id: string) => (await one<{ phone: string }>("select phone from contacts where id = $1", [id])).phone;

/**
 * processReviewBatches works on every approved batch in the database, and the other tests in this file leave some behind. A test that runs it as a whole first puts those
 * aside (paused), so what it counts is its own.
 */
const putOthersAside = () => withSystem((db) => db.query("update review_request_batches set status = 'paused' where status in ('approved', 'sending')"));

/** Runs the job and the dispatcher the way a tick does, once per simulated minute, until the batch stops moving. Returns the recorder. */
async function drain(id: string, orgId: string, rec: ReturnType<typeof recordingProvider>, opts: { from?: number; max?: number } = {}) {
  for (let i = opts.from ?? 0; i < (opts.from ?? 0) + (opts.max ?? 12); i += 1) {
    await advanceBatch(id, orgId, secs(i * 61));
    await dispatchDue({ transport: rec.transport, now: secs(i * 61), limit: 200 });
    const st = (await batchStatus(id)).status;
    if (["completed", "stopped", "cancelled", "paused"].includes(st)) break;
  }
  return rec;
}

describe("starting and pacing", () => {
  it("starts an approved batch and asks at most its pace in any minute, each customer once, through the ordinary send path", async () => {
    const s = await reputationShop("Pace Shop");
    const b = await readyBatch(s, 25, { ratePerMinute: 10 });
    expect(await items(b.id)).toEqual([]);

    const first = await advanceBatch(b.id, b.org, T);
    expect(first).toMatchObject({ started: 1, queued: 10 });
    expect(await batchStatus(b.id)).toMatchObject({ status: "sending" });
    expect(await statusCounts(b.id)).toEqual({ pending: 15, queued: 10 });
    expect((await getBatch(s.owner, b.id)).counts).toMatchObject({ total: 25, pending: 15, queued: 10, excluded: 0, failed: 0 });

    // The same minute again, or half a minute later: the pace holds.
    expect(await advanceBatch(b.id, b.org, T)).toMatchObject({ started: 0, queued: 0 });
    expect(await advanceBatch(b.id, b.org, secs(30))).toMatchObject({ queued: 0 });
    expect(await statusCounts(b.id)).toEqual({ pending: 15, queued: 10 });
    // Messages that haven't gone yet count against the pace too, so a slow dispatcher can't pile them up.
    expect(await advanceBatch(b.id, b.org, secs(61))).toMatchObject({ queued: 0 });

    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: secs(61), limit: 100 });
    expect(await sentBy(rec, b.id)).toHaveLength(10);
    expect(await advanceBatch(b.id, b.org, secs(61))).toMatchObject({ queued: 10 });
    await dispatchDue({ transport: rec.transport, now: secs(122), limit: 100 });
    expect(await advanceBatch(b.id, b.org, secs(122))).toMatchObject({ queued: 5, completed: 1 });
    await dispatchDue({ transport: rec.transport, now: secs(183), limit: 100 });
    const sent = await sentBy(rec, b.id);
    expect(sent).toHaveLength(25);
    expect(new Set(sent.map((c) => c.to)).size).toBe(25);

    const done = await batchStatus(b.id);
    expect(done.status).toBe("completed");
    expect(done.completed_at).not.toBeNull();
    expect(await statusCounts(b.id)).toEqual({ queued: 25 });
    expect(await advanceBatch(b.id, b.org, secs(300))).toMatchObject({ started: 0, queued: 0 });
    expect(await audits(b.org, "reputation.batch_started")).toBe(1);
    expect(await audits(b.org, "reputation.batch_completed")).toBe(1);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'system' and title like '%finished%'", [b.org])).toBe(2);
  });

  it("makes an ordinary review request for each customer: the batch, the visit, the owner, the placeholder instead of a link, and a link only the customer's own", async () => {
    const s = await reputationShop("Request Shop");
    const b = await readyBatch(s, 3, { ratePerMinute: 5 });
    const rec = recordingProvider("twilio");
    await drain(b.id, b.org, rec);
    const requests = await requestsFor(b.id);
    expect(requests).toHaveLength(3);
    for (const r of requests) {
      expect(r).toMatchObject({ requested_via: "batch", kind: "review", scale: "csat5", requested_by: s.m.people.owner.id, batch_id: b.id });
      expect(r.appointment_id).toBe(b.visits.get(r.contact_id));
      const m = await messageFor(b.org, r.contact_id);
      expect(m).toMatchObject({ scope: "retention", purpose: "service", dedupe_key: `batch:${b.id}:${r.contact_id}`, id: r.message_id });
      expect(m.body).toContain("{{review.link}}");
      expect(m.body).not.toContain("/r/");
    }
    // What the provider got carries a link that opens that customer's own page.
    const sent = await sentBy(rec, b.id);
    expect(sent).toHaveLength(3);
    const tokens = new Set<string>();
    for (const call of sent) {
      const token = /\/r\/([A-Za-z0-9_-]{43})/.exec(call.body)?.[1];
      expect(token, call.body).toBeTruthy();
      tokens.add(token!);
      const page = await loadReviewPage(token!);
      expect(page.kind).toBe("review");
    }
    expect(tokens.size).toBe(3);
    // The people list says what became of each: sent, until a customer opens their page.
    const list = await listBatchPeople(s.owner, b.id);
    expect(list.total).toBe(3);
    expect(list.rows.every((r) => r.status === "queued" && r.delivery === "opened")).toBe(true);
    expect((await getBatch(s.owner, b.id)).results).toEqual({ sent: 3, opened: 3, undelivered: 0 });
  });

  it("says a message went, or didn't, from the message itself", async () => {
    const s = await reputationShop("Delivery Shop");
    const b = await readyBatch(s, 3, { ratePerMinute: 5 });
    await advanceBatch(b.id, b.org, T);
    const waiting = await listBatchPeople(s.owner, b.id);
    expect(waiting.rows.map((r) => r.delivery)).toEqual(["waiting", "waiting", "waiting"]);
    const rec = recordingProvider("twilio", (_req, n) => (n === 1 ? { ok: false, retryable: false, error: "The carrier refused it." } : { ok: true, providerMessageId: `pm_${n}` }));
    await dispatchDue({ transport: rec.transport, now: secs(1), limit: 100 });
    const mine = await sentBy(rec, b.id);
    expect(mine).toHaveLength(3);
    const after = await listBatchPeople(s.owner, b.id);
    expect(after.rows.map((r) => r.delivery).sort()).toEqual(["failed", "sent", "sent"]);
    expect((await getBatch(s.owner, b.id)).results).toMatchObject({ sent: 2, undelivered: 1 });
  });

  it("asks about the most recent visit when a customer has had several", async () => {
    const s = await reputationShop("Recent Visit Shop");
    await setBatches(s.m.org.id, true);
    const c = await shopCustomer(s);
    const older = await attend(s, c, { daysAgo: 10 });
    const newer = await attend(s, c, { daysAgo: 2 });
    const { id } = await createBatch(s.owner, batchInput(s));
    const p = await previewBatch(s.owner, id);
    expect(p.audience).toMatchObject({ total: 1, eligible: 1 });
    await approveBatch(s.owner, id, { fingerprint: p.fingerprint! });
    await advanceBatch(id, s.m.org.id, T);
    expect((await items(id))[0].appointment_id).toBe(newer);
    expect((await requestsFor(id))[0].appointment_id).toBe(newer);
    expect((await items(id))[0].appointment_id).not.toBe(older);
  });

  it("sends a survey batch as surveys on the chosen scale", async () => {
    const s = await reputationShop("Survey Batch Shop");
    const b = await readyBatch(s, 2, { kind: "survey", scale: "nps10", name: "NPS" });
    await drain(b.id, b.org, recordingProvider("twilio"));
    const requests = await requestsFor(b.id);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.kind === "survey" && r.scale === "nps10" && r.requested_via === "batch")).toBe(true);
  });
});

describe("only an approved batch moves, in a workspace that has batches", () => {
  it("leaves drafts, batches waiting for the owner, paused batches and cancelled ones alone", async () => {
    await putOthersAside();
    const s = await reputationShop("Idle Shop");
    await setBatches(s.m.org.id, true);
    const c = await shopCustomer(s);
    await attend(s, c);
    const draft = await createBatch(s.owner, batchInput(s, { name: "Draft" }));
    const waiting = await createBatch(s.manager, batchInput(s, { name: "Waiting" }));
    await requestBatchApproval(s.manager, waiting.id, { fingerprint: (await previewBatch(s.manager, waiting.id)).fingerprint! });
    const paused = await createBatch(s.owner, batchInput(s, { name: "Paused" }));
    await approveBatch(s.owner, paused.id, { fingerprint: (await previewBatch(s.owner, paused.id)).fingerprint! });
    await pauseBatch(s.owner, paused.id);
    const cancelled = await createBatch(s.owner, batchInput(s, { name: "Cancelled" }));
    await cancelBatch(s.owner, cancelled.id);

    const ran = await processReviewBatches({ now: T });
    expect(ran).toMatchObject({ started: 0, queued: 0, excluded: 0, stopped: 0, completed: 0 });
    for (const [id, status] of [[draft.id, "draft"], [waiting.id, "awaiting_approval"], [paused.id, "paused"], [cancelled.id, "cancelled"]] as const) {
      expect((await batchStatus(id)).status, status).toBe(status);
      expect(await items(id), status).toEqual([]);
    }
    expect(await count("select count(*)::text as n from crm_review_requests where org_id = $1", [s.m.org.id])).toBe(0);
    // Calling the batch directly changes nothing either.
    expect(await advanceBatch(draft.id, s.m.org.id, T)).toMatchObject({ started: 0, queued: 0 });
    expect(await advanceBatch(waiting.id, s.m.org.id, T)).toMatchObject({ started: 0, queued: 0 });
    expect(await advanceBatch(paused.id, s.m.org.id, T)).toMatchObject({ started: 0, queued: 0 });
  });

  it("leaves an approved batch exactly as it is while batches are switched off for the workspace, and carries on when they are switched back on", async () => {
    await putOthersAside();
    const s = await reputationShop("Switch Shop");
    const b = await readyBatch(s, 3);
    await setBatches(b.org, false);
    expect(await processReviewBatches({ now: T })).toMatchObject({ started: 0, queued: 0 });
    expect(await advanceBatch(b.id, b.org, T)).toMatchObject({ started: 0, queued: 0 });
    expect(await batchStatus(b.id)).toMatchObject({ status: "approved", started_at: null });
    expect(await items(b.id)).toEqual([]);
    await setBatches(b.org, true);
    expect(await processReviewBatches({ now: T })).toMatchObject({ started: 1 });
    expect((await batchStatus(b.id)).status).not.toBe("approved");
    expect((await items(b.id)).length).toBe(3);
  });

  it("leaves a batch alone in a workspace that is suspended", async () => {
    await putOthersAside();
    const s = await reputationShop("Suspended Shop");
    const b = await readyBatch(s, 2);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [b.org]));
    expect(await processReviewBatches({ now: T })).toMatchObject({ started: 0, queued: 0 });
    expect(await batchStatus(b.id)).toMatchObject({ status: "approved" });
  });
});

describe("customers left out", () => {
  it("those who opted out, withdrew consent, were just asked, are held by a person, or are gone by the time it starts are left out with the reason, and the rest are asked", async () => {
    const s = await reputationShop("Left Out Shop");
    const b = await readyBatch(s, 8, { ratePerMinute: 30 });
    const [optedOut, withdrew, asked, held, archived, removed, fine1, fine2] = b.contacts;
    const phone = await phoneOf(optedOut);
    await withSystem((db) => suppressAddress(db, { orgId: b.org, channel: "sms", address: phone, reason: "opt_out", source: "test" }));
    await setContactConsent(s.owner, withdrew, { channel: "sms", purpose: "service", status: "revoked", evidence: "Said no at the desk" });
    await requestReview(s.owner, { contactId: asked, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, businessHoursOnly: false });
    await withSystem((db) => db.query("update contacts set retention_paused = true where id = $1", [held]));
    await withSystem((db) => db.query("update contacts set archived_at = now() where id = $1", [archived]));
    await withSystem((db) => db.query("update contacts set deleted_at = now() where id = $1", [removed]));

    await advanceBatch(b.id, b.org, T);
    expect(await itemOf(b.id, fine1)).toMatchObject({ status: "queued", reason: null });
    expect(await itemOf(b.id, fine2)).toMatchObject({ status: "queued", reason: null });
    expect(await reasonsOf(b.id)).toEqual({ suppressed: 1, consent_withdrawn: 1, recently_requested: 1, held_by_person: 1 });
    // An archived or removed contact isn't in the batch at all, as on the Contacts screen.
    expect(await items(b.id).then((x) => x.map((i) => i.contact_id))).not.toContain(archived);
    expect(await items(b.id).then((x) => x.map((i) => i.contact_id))).not.toContain(removed);
    expect(await statusCounts(b.id)).toEqual({ queued: 2, excluded: 4 });
    expect((await getBatch(s.owner, b.id)).counts).toMatchObject({ total: 6, queued: 2, excluded: 4, reasons: { suppressed: 1, consent_withdrawn: 1, recently_requested: 1, held_by_person: 1 } });
    // Nobody left out got a message from the batch.
    expect((await requestsFor(b.id)).map((r) => r.contact_id).sort()).toEqual([fine1, fine2].sort());
    const people = await listBatchPeople(s.viewer, b.id, { filter: "left_out" });
    expect(people.rows.map((r) => r.reasonText).sort()).toEqual(["Already asked in the last 30 days", "Held back by a person on your team", "Opted out or bounced", "Withdrew consent to these messages"]);
  });

  it("a customer who changes between the start and their turn is checked at their turn, by the real send path", async () => {
    const s = await reputationShop("Turn Shop");
    const b = await readyBatch(s, 8, { ratePerMinute: 2 });
    await advanceBatch(b.id, b.org, T);
    const waiting = (await items(b.id)).filter((i) => i.status === "pending").map((i) => i.contact_id);
    expect(waiting).toHaveLength(6);
    const [optedOut, held, asked, archived, removed, ...rest] = waiting;
    const phone = await phoneOf(optedOut);
    await withSystem((db) => suppressAddress(db, { orgId: b.org, channel: "sms", address: phone, reason: "opt_out", source: "test" }));
    await withSystem((db) => db.query("update contacts set retention_paused = true where id = $1", [held]));
    await requestReview(s.owner, { contactId: asked, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, businessHoursOnly: false });
    await withSystem((db) => db.query("update contacts set archived_at = now() where id = $1", [archived]));
    await withSystem((db) => db.query("update contacts set deleted_at = now() where id = $1", [removed]));
    expect(rest).toHaveLength(1);
    await drain(b.id, b.org, recordingProvider("twilio"), { from: 1 });
    expect(await itemOf(b.id, optedOut)).toMatchObject({ status: "excluded", reason: "suppressed" });
    expect(await itemOf(b.id, held)).toMatchObject({ status: "excluded", reason: "held_by_person" });
    expect(await itemOf(b.id, asked)).toMatchObject({ status: "excluded", reason: "recently_requested" });
    expect(await itemOf(b.id, archived)).toMatchObject({ status: "excluded", reason: "archived" });
    expect(await itemOf(b.id, removed)).toMatchObject({ status: "excluded", reason: "deleted" });
    expect(await itemOf(b.id, rest[0])).toMatchObject({ status: "queued" });
    expect((await batchStatus(b.id)).status).toBe("completed");
    expect(await count("select count(*)::text as n from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = any($1::uuid[]) and m.dedupe_key like 'batch:%'", [[optedOut, held, asked, archived, removed]])).toBe(0);
  });

  it("a person's hold on automatic messages stops the batch's ask, is audited with its reason and counted, and never stops a person pressing Send", async () => {
    const s = await reputationShop("Hold Shop");
    const b = await readyBatch(s, 3, { ratePerMinute: 30 });
    const held = b.contacts[0];
    await withSystem((db) => db.query("update contacts set retention_paused = true where id = $1", [held]));
    await advanceBatch(b.id, b.org, T);
    expect(await itemOf(b.id, held)).toMatchObject({ status: "excluded", reason: "held_by_person" });
    const audit = await one<{ metadata: Record<string, unknown>; result: string }>("select metadata, result from audit_logs where org_id = $1 and action = 'crm.review_request_held' and target_id = $2", [b.org, held]);
    expect(audit).toMatchObject({ result: "denied", metadata: { via: "batch", reason: "held_by_person" } });
    expect((await getBatch(s.owner, b.id)).counts.reasons).toEqual({ held_by_person: 1 });
    // The same customer can still be asked by a person: the hold is for automatic messages.
    const hand = await requestReview(s.owner, { contactId: held, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, businessHoursOnly: false });
    expect(hand.requestId).toBeTruthy();
  });
});

describe("what stops a batch", () => {
  /** A batch with three of six asked, so there is something queued and something waiting when it stops. */
  async function halfway(name: string) {
    const s = await reputationShop(name);
    const b = await readyBatch(s, 6, { ratePerMinute: 3 });
    await advanceBatch(b.id, b.org, T);
    expect(await statusCounts(b.id)).toEqual({ pending: 3, queued: 3 });
    return { s, b };
  }

  async function expectStopped(s: ReputationShop, b: { id: string; org: string }, detail: RegExp, code: string) {
    const out = await advanceBatch(b.id, b.org, secs(61));
    expect(out).toMatchObject({ stopped: 1, queued: 0 });
    expect(await batchStatus(b.id)).toMatchObject({ status: "stopped" });
    const view = await getBatch(s.owner, b.id);
    expect(view.counts.notice).toMatchObject({ code });
    expect(view.counts.notice?.detail).toMatch(detail);
    // Nobody waiting is asked, what was queued and not sent is stopped, and no customer receives a link from a batch that no longer stands.
    expect(await statusCounts(b.id)).toEqual({ excluded: 6 });
    expect(await reasonsOf(b.id)).toEqual({ batch_stopped: 3, withdrawn: 3 });
    const requests = await requestsFor(b.id);
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.status === "cancelled")).toBe(true);
    for (const r of requests) expect(await messageFor(b.org, r.contact_id)).toMatchObject({ status: "blocked", blocked_reason: "batch_stopped" });
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: secs(200), limit: 100 });
    expect(await sentBy(rec, b.id)).toHaveLength(0);
    expect(await one<{ status: string }>("select a.status from approval_requests a join review_request_batches b on b.approval_id = a.id where b.id = $1", [b.id])).toEqual({ status: "cancelled" });
    expect(await audits(b.org, "reputation.batch_stopped")).toBe(1);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'message_blocked' and title like '%stopped%'", [b.org])).toBe(2);
    // Later ticks do nothing, and it can't be resumed or approved again.
    expect(await advanceBatch(b.id, b.org, secs(300))).toMatchObject({ queued: 0, stopped: 0 });
    await expect(resumeBatch(s.owner, b.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(pauseBatch(s.owner, b.id)).rejects.toMatchObject({ code: "conflict" });
    expect(BATCH_STATUS_LABELS[view.status]).toBe("Stopped");
  }

  it("stops when the template's wording was changed and approved again after the owner approved the batch", async () => {
    const { s, b } = await halfway("Reworded Shop");
    await updateTemplate(s.owner, s.smsTemplate.id, { body: "Hi {{contact.first_name}}, brand new words. {{review.link}}" });
    const v = await one<{ current_version: number; content_hash: string }>("select t.current_version, v.content_hash from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.version = t.current_version where t.id = $1", [s.smsTemplate.id]);
    await approveTemplate(s.owner, s.smsTemplate.id, { version: v.current_version, contentHash: v.content_hash });
    await expectStopped(s, b, /The message changed after the owner approved this batch/, "template_changed");
  });

  it("stops when the template is edited and not yet approved again (nothing unapproved is ever sent)", async () => {
    const { s, b } = await halfway("Unapproved Edit Shop");
    await updateTemplate(s.owner, s.smsTemplate.id, { body: "Hi {{contact.first_name}}, a draft nobody approved. {{review.link}}" });
    await expectStopped(s, b, /The message changed after the owner approved this batch/, "template_changed");
  });

  it("stops when a business detail the wording uses changed", async () => {
    const { s, b } = await halfway("Renamed Shop");
    await withSystem((db) => db.query("update organizations set name = 'Renamed Shop Ltd' where id = $1", [b.org]));
    await expectStopped(s, b, /changed after the owner approved this batch/, "approval_void");
  });

  it("stops when the person who approved it is no longer an owner", async () => {
    const { s, b } = await halfway("Demoted Shop");
    await withSystem((db) => db.query("update organization_memberships set role = 'admin' where org_id = $1 and user_id = $2", [b.org, s.m.people.owner.id]));
    await expectStopped(s, b, /no longer an owner/, "approval_void");
  });

  it("stops when the owner's approval was withdrawn", async () => {
    const { s, b } = await halfway("Withdrawn Shop");
    await withSystem((db) => db.query("update approval_requests set status = 'cancelled', execution_status = 'blocked', execution_detail = 'Withdrawn in the test' where id = (select approval_id from review_request_batches where id = $1)", [b.id]));
    // The approval is already cancelled, so stopping it leaves it that way.
    const out = await advanceBatch(b.id, b.org, secs(61));
    expect(out).toMatchObject({ stopped: 1 });
    expect((await getBatch(s.owner, b.id)).counts.notice).toMatchObject({ code: "approval_void", detail: expect.stringContaining("no longer stands") });
    expect(await reasonsOf(b.id)).toEqual({ batch_stopped: 3, withdrawn: 3 });
  });

  it("stops when the approval has lapsed (14 days)", async () => {
    const { s, b } = await halfway("Lapsed Shop");
    const out = await advanceBatch(b.id, b.org, secs(15 * 86_400));
    expect(out).toMatchObject({ stopped: 1, queued: 0 });
    expect((await getBatch(s.owner, b.id)).counts.notice).toMatchObject({ code: "approval_expired", detail: expect.stringContaining("lapsed after 14 days") });
  });

  it("stops when who it is for, the channel or the pace was changed behind the owner's back", async () => {
    for (const [what, sql, re] of [
      ["the people", `update review_request_batches set criteria = jsonb_set(criteria, '{from}', to_jsonb((current_date - 40)::text)) where id = $1`, /who it is for/i],
      ["the pace", "update review_request_batches set rate_per_minute = 60 where id = $1", /the sending pace/i],
      ["the kind", "update review_request_batches set kind = 'survey' where id = $1", /what the message asks for/i],
    ] as const) {
      const { s, b } = await halfway(`Tampered Shop ${what}`);
      await withSystem((db) => db.query(sql, [b.id]));
      await expectStopped(s, b, re, "approval_void");
    }
  });

  it("can't have feeling-shaped criteria written to its row at all: the database refuses", async () => {
    const s = await reputationShop("Constraint Shop");
    const b = await readyBatch(s, 1);
    for (const key of ["rating", "nps", "score", "sentiment", "feedback", "escalated", "tag"]) {
      await expect(withSystem((db) => db.query("update review_request_batches set criteria = criteria || jsonb_build_object($2::text, 5) where id = $1", [b.id, key])), key).rejects.toThrow(/check/);
    }
  });
});

describe("what pauses a batch for a person", () => {
  it("a person's pause holds what was queued and not sent, nothing more is asked, and resuming lets it go and carries on", async () => {
    await putOthersAside();
    const s = await reputationShop("Pause Shop");
    const b = await readyBatch(s, 6, { ratePerMinute: 3 });
    await advanceBatch(b.id, b.org, T);
    const { held } = await pauseBatch(s.owner, b.id);
    expect(held).toBe(3);
    for (const r of await requestsFor(b.id)) expect(await messageFor(b.org, r.contact_id)).toMatchObject({ status: "queued", status_detail: "Held: the batch is paused." });
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: secs(120), limit: 100 });
    expect(await sentBy(rec, b.id)).toHaveLength(0);
    expect(await processReviewBatches({ now: secs(120) })).toMatchObject({ queued: 0 });
    expect(await statusCounts(b.id)).toEqual({ pending: 3, queued: 3 });

    expect(await resumeBatch(s.owner, b.id)).toEqual({ released: 3 });
    expect((await batchStatus(b.id)).status).toBe("sending");
    await dispatchDue({ transport: rec.transport, now: secs(121), limit: 100 });
    expect(await sentBy(rec, b.id)).toHaveLength(3);
    await drain(b.id, b.org, rec, { from: 3 });
    expect((await batchStatus(b.id)).status).toBe("completed");
    expect(await sentBy(rec, b.id)).toHaveLength(6);
  });

  it("running out of credits pauses it with the reason and tells the owner; nothing is half-done, and it carries on when credits are back", async () => {
    await putOthersAside();
    const s = await reputationShop("Credits Shop", { credits: 0.02 });
    const b = await readyBatch(s, 6, { ratePerMinute: 30 });
    const out = await advanceBatch(b.id, b.org, T);
    expect(out.paused).toBe(1);
    expect(out.queued).toBeGreaterThanOrEqual(1);
    expect(out.queued).toBeLessThan(6);
    const view = await getBatch(s.owner, b.id);
    expect(view.status).toBe("paused");
    expect(view.counts.notice).toMatchObject({ code: "credits", detail: expect.stringContaining("Service credits ran out") });
    const counts = await statusCounts(b.id);
    expect(counts.queued).toBe(out.queued);
    expect(counts.pending).toBe(6 - out.queued);
    // The customer who hit the wall has no request, no message, and is still waiting (not left out for the batch's problem).
    expect(await count("select count(*)::text as n from crm_review_requests where batch_id = $1", [b.id])).toBe(out.queued);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'billing_credits_exhausted'", [b.org])).toBe(2);
    // A paused batch isn't worked on, and credits alone don't resume it.
    expect(await processReviewBatches({ now: secs(61) })).toMatchObject({ queued: 0 });
    await withSystem((db) => adjustCredits(db, { orgId: b.org, deltaMicros: 20_000_000, reason: "Top up for the test", userId: s.m.people.owner.id }));
    await resumeBatch(s.owner, b.id);
    await drain(b.id, b.org, recordingProvider("twilio"), { from: 1 });
    expect((await batchStatus(b.id)).status).toBe("completed");
    expect(await statusCounts(b.id)).toEqual({ queued: 6 });
  });

  it("a missing public review link pauses a review batch, and adding one lets it continue", async () => {
    const s = await reputationShop("Links Shop");
    const b = await readyBatch(s, 4, { ratePerMinute: 2 });
    await advanceBatch(b.id, b.org, T);
    await withSystem((db) => db.query("update crm_review_destinations set active = false where org_id = $1", [b.org]));
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: secs(61), limit: 100 });
    expect(await advanceBatch(b.id, b.org, secs(61))).toMatchObject({ paused: 1, queued: 0 });
    expect((await getBatch(s.owner, b.id)).counts.notice).toMatchObject({ code: "no_links", detail: expect.stringContaining("no public review link") });
    expect(await statusCounts(b.id)).toEqual({ pending: 2, queued: 2 });
    await withSystem((db) => db.query("update crm_review_destinations set active = true where org_id = $1", [b.org]));
    await resumeBatch(s.owner, b.id);
    await drain(b.id, b.org, rec, { from: 2 });
    expect((await batchStatus(b.id)).status).toBe("completed");
  });

  it("surveys switched off after approval pause a survey batch, and switching them back on lets it continue", async () => {
    const s = await reputationShop("Survey Off Shop");
    const b = await readyBatch(s, 3, { kind: "survey", scale: "csat5", ratePerMinute: 30 });
    await setSurveys(b.org, false);
    expect(await advanceBatch(b.id, b.org, T)).toMatchObject({ started: 1, paused: 1, queued: 0 });
    expect((await getBatch(s.owner, b.id)).counts.notice).toMatchObject({ code: "surveys_not_enabled" });
    expect(await statusCounts(b.id)).toEqual({ pending: 3 });
    await setSurveys(b.org, true);
    await resumeBatch(s.owner, b.id);
    await drain(b.id, b.org, recordingProvider("twilio"), { from: 1 });
    expect(await statusCounts(b.id)).toEqual({ queued: 3 });
  });

  it("a paused workspace holds the batch and what it queued, and it carries on by itself when the pause is lifted", async () => {
    await putOthersAside();
    const s = await reputationShop("Paused Workspace Shop");
    const b = await readyBatch(s, 4, { ratePerMinute: 2 });
    await advanceBatch(b.id, b.org, T);
    await setClientPause(s.m.ctx("owner"), { scope: "messaging", paused: true, reason: "test" });
    expect(await advanceBatch(b.id, b.org, secs(61))).toMatchObject({ waiting: 1, queued: 0 });
    expect((await getBatch(s.owner, b.id)).counts.notice).toMatchObject({ code: "workspace_paused" });
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: secs(62), limit: 100 });
    expect(await sentBy(rec, b.id)).toHaveLength(0);
    // Looked at again before the wait is over: still nothing.
    expect(await processReviewBatches({ now: secs(62) })).toMatchObject({ queued: 0 });
    await setClientPause(s.m.ctx("owner"), { scope: "messaging", paused: false });
    await advanceBatch(b.id, b.org, secs(400));
    expect((await getBatch(s.owner, b.id)).counts.notice).toBeNull();
    await drain(b.id, b.org, rec, { from: 7 });
    expect((await batchStatus(b.id)).status).toBe("completed");
    expect(await sentBy(rec, b.id)).toHaveLength(4);
  });
});

describe("cancelling a batch under way", () => {
  it("stops what hasn't gone, leaves what was sent, and asks nobody else", async () => {
    const s = await reputationShop("Cancel Shop");
    const b = await readyBatch(s, 9, { ratePerMinute: 3 });
    await advanceBatch(b.id, b.org, T);
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: secs(1), limit: 100 });
    expect(await sentBy(rec, b.id)).toHaveLength(3);
    await advanceBatch(b.id, b.org, secs(61));
    expect(await statusCounts(b.id)).toEqual({ pending: 3, queued: 6 });
    // Three more are queued and waiting for the dispatcher, and three are still waiting their turn, when the owner cancels.
    const stopped = await cancelBatch(s.owner, b.id);
    expect(stopped.stopped).toBe(3);
    expect((await batchStatus(b.id)).status).toBe("cancelled");
    await dispatchDue({ transport: rec.transport, now: secs(200), limit: 100 });
    expect(await sentBy(rec, b.id)).toHaveLength(3);
    const requests = await requestsFor(b.id);
    expect(requests.filter((r) => r.status === "cancelled")).toHaveLength(3);
    expect(requests.filter((r) => r.status !== "cancelled")).toHaveLength(3);
    expect(await reasonsOf(b.id)).toEqual({ withdrawn: 3, batch_cancelled: 3 });
    expect(await statusCounts(b.id)).toEqual({ queued: 3, excluded: 6 });
    expect(await advanceBatch(b.id, b.org, secs(300))).toMatchObject({ queued: 0 });
  });

  it("takes the people still waiting out of a batch that was cancelled before it asked anyone else", async () => {
    const s = await reputationShop("Cancel Early Shop");
    const b = await readyBatch(s, 5, { ratePerMinute: 2 });
    await advanceBatch(b.id, b.org, T);
    await cancelBatch(s.owner, b.id);
    expect(await statusCounts(b.id)).toEqual({ excluded: 5 });
    expect(await reasonsOf(b.id)).toEqual({ batch_cancelled: 3, withdrawn: 2 });
    const page = await listBatchPeople(s.owner, b.id);
    expect(page.rows.map((r) => r.reasonText).sort()).toEqual(["The batch was cancelled", "The batch was cancelled", "The batch was cancelled", "Withdrawn before it was sent", "Withdrawn before it was sent"]);
  });
});

describe("two turns at once, and two workspaces", () => {
  it("never asks a customer twice when the job runs twice at the same moment", async () => {
    await putOthersAside();
    const s = await reputationShop("Race Shop");
    const b = await readyBatch(s, 12, { ratePerMinute: 6 });
    await Promise.all([advanceBatch(b.id, b.org, T), advanceBatch(b.id, b.org, T), processReviewBatches({ now: T })]);
    // Turns that overlap share one pace: whichever gets the room uses it, and the other finds none left.
    const queued = await count("select count(*)::text as n from review_request_batch_items where batch_id = $1 and status = 'queued'", [b.id]);
    expect(queued).toBe(6);
    expect(await count("select count(*)::text as n from crm_review_requests where batch_id = $1", [b.id])).toBe(queued);
    expect(await count("select count(*)::text as n from conversation_messages where org_id = $1 and dedupe_key like $2", [b.org, `batch:${b.id}:%`])).toBe(queued);
    expect(await count("select count(*)::text as n from (select dedupe_key from conversation_messages where org_id = $1 and dedupe_key like 'batch:%' group by 1 having count(*) > 1) d", [b.org])).toBe(0);
    await drain(b.id, b.org, recordingProvider("twilio"), { from: 1 });
    expect(await statusCounts(b.id)).toEqual({ queued: 12 });
    expect(await count("select count(*)::text as n from crm_review_requests where batch_id = $1", [b.id])).toBe(12);
  });

  it("works each workspace's batch on its own customers, never another's, and a workspace without the switch is left alone", async () => {
    await putOthersAside();
    const a = await reputationShop("Neighbours A");
    const c = await reputationShop("Neighbours B");
    const off = await reputationShop("Neighbours Off");
    const ba = await readyBatch(a, 4, { ratePerMinute: 30 });
    const bc = await readyBatch(c, 3, { ratePerMinute: 30 });
    const bo = await readyBatch(off, 2, { ratePerMinute: 30 });
    await setBatches(off.m.org.id, false);
    await processReviewBatches({ now: T, limit: 20 });
    expect(await statusCounts(ba.id)).toEqual({ queued: 4 });
    expect(await statusCounts(bc.id)).toEqual({ queued: 3 });
    expect(await items(bo.id)).toEqual([]);
    for (const [b, own] of [[ba, a], [bc, c]] as const) {
      const theirs = await all<{ org_id: string }>("select r.org_id from crm_review_requests r where r.batch_id = $1", [b.id]);
      expect(theirs).toHaveLength((await items(b.id)).length);
      expect(theirs.every((r) => r.org_id === own.m.org.id)).toBe(true);
      const contactOrgs = await all<{ org_id: string }>("select distinct c.org_id from review_request_batch_items i join contacts c on c.id = i.contact_id where i.batch_id = $1", [b.id]);
      expect(contactOrgs).toEqual([{ org_id: own.m.org.id }]);
      // The other workspace's customers got nothing from this batch.
      const other = own === a ? bc : ba;
      const crossed = await count("select count(*)::text as n from conversation_messages where org_id = $1 and dedupe_key like $2", [own.m.org.id, `batch:${other.id}:%`]);
      expect(crossed).toBe(0);
    }
  });
});

describe("the scheduler", () => {
  it("registers one job, on every tick, before the dispatcher so what it queues goes out in the same run, and a staged start can name it", async () => {
    const names = JOBS.map((j) => j.name);
    expect(names.filter((n) => n === "reviewRequestBatches")).toHaveLength(1);
    expect(JOBS.find((j) => j.name === "reviewRequestBatches")?.everyMinutes).toBeUndefined();
    expect(names.indexOf("reviewRequestBatches")).toBeLessThan(names.indexOf("messagesDispatched"));
    expect(names.indexOf("reviewRequestBatches")).toBeGreaterThan(names.indexOf("feedbackSla"));
    expect(activeJobs(JOBS, "reviewRequestBatches").map((j) => j.name)).toEqual(["reviewRequestBatches"]);
    expect(() => activeJobs(JOBS, "reviewRequestBatch")).toThrow(/does not exist/);
    const only = await runScheduledJobs(secs(0), activeJobs(JOBS, "reviewRequestBatches"));
    expect(Object.keys(only)).toEqual(["reviewRequestBatches"]);
    expect(typeof only.reviewRequestBatches).toBe("number");
  });
});
