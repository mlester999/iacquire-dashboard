// A person's hold on automatic messages (contacts.retention_paused, set during a dispute, say) must stop an automatic review ask that is already queued, not only one that
// has not been made yet; a person pressing Send is never stopped by it. Embedded Postgres; the provider is a recorder, nothing is sent anywhere.
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { requestReview } from "@/server/crm/reviews";
import { dispatchDue } from "@/server/messaging/send";
import { setRetentionPaused } from "@/server/retention/service";
import { approveBatch, createBatch, getBatch, previewBatch } from "@/server/reputation/batches";
import { advanceBatch } from "@/server/reputation/batch-job";
import { BLOCK_REASON_LABELS } from "@/lib/messaging";
import { recordingProvider } from "./support/messaging";
import { attend, batchInput, count, one, reputationShop, setBatches, shopCustomer, type ReputationShop } from "./support/reputation";

vi.setConfig({ testTimeout: 120_000 });

const T = new Date();

async function readyBatch(shop: ReputationShop, n: number) {
  await setBatches(shop.m.org.id, true);
  const contacts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const c = await shopCustomer(shop, { firstName: `Hold${i}` });
    contacts.push(c);
    await attend(shop, c);
  }
  const { id } = await createBatch(shop.owner, batchInput(shop, { ratePerMinute: 30 }));
  const p = await previewBatch(shop.owner, id);
  expect(p.problems).toEqual([]);
  await approveBatch(shop.owner, id, { fingerprint: p.fingerprint! });
  return { id, contacts, org: shop.m.org.id };
}

/** Business hours that are open for half an hour a day, starting six hours from now: every ask made now waits for the window. Returns a moment inside the window. */
async function windowOpensLater(org: string) {
  const h = (T.getUTCHours() + 6) % 24;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [[`${pad(h)}:00`, `${pad(h)}:30`]]]));
  await withSystem((db) => db.query("update messaging_settings set business_hours = $2::jsonb where org_id = $1", [org, JSON.stringify(hours)]));
  const opens = new Date(T);
  opens.setUTCHours(h, 10, 0, 0);
  if (opens.getTime() <= T.getTime() + 3600_000) opens.setUTCDate(opens.getUTCDate() + 1);
  return opens;
}

const requestOf = (batchId: string, contactId: string) => one<{ id: string; status: string; message_id: string }>("select id, status, message_id from crm_review_requests where batch_id = $1 and contact_id = $2", [batchId, contactId]);
const messageOf = (id: string) => one<{ status: string; blocked_reason: string | null; status_detail: string | null; reservation_id: string | null; send_after: Date }>("select status, blocked_reason, status_detail, reservation_id, send_after from conversation_messages where id = $1", [id]);
const itemOf = (batchId: string, contactId: string) => one<{ status: string; reason: string | null }>("select status, reason from review_request_batch_items where batch_id = $1 and contact_id = $2", [batchId, contactId]);
const reservation = (id: string) => one<{ status: string }>("select status from usage_reservations where id = $1", [id]);

describe("a hold placed after an automatic review ask is queued", () => {
  it("withdraws the ask that is waiting for the sending window: stopped, its credit given back, its link dead, and the batch counts it as held; everyone else's still goes", async () => {
    const s = await reputationShop("Hold After Queue Shop");
    const b = await readyBatch(s, 3);
    const opens = await windowOpensLater(b.org);
    await advanceBatch(b.id, b.org, T);
    const [held, other1, other2] = b.contacts;
    const ask = await requestOf(b.id, held);
    const before = await messageOf(ask.message_id);
    expect(before.status).toBe("queued");
    expect(before.send_after.getTime()).toBeGreaterThan(T.getTime() + 3600_000);
    expect(before.reservation_id).not.toBeNull();

    await setRetentionPaused(s.m.ctx("owner"), held, true, "Dispute about the work");

    expect(await requestOf(b.id, held)).toMatchObject({ status: "cancelled" });
    expect(await messageOf(ask.message_id)).toMatchObject({ status: "blocked", blocked_reason: "held_by_person" });
    expect((await reservation(before.reservation_id!)).status).not.toBe("held");
    expect(await itemOf(b.id, held)).toEqual({ status: "excluded", reason: "held_by_person" });
    expect((await getBatch(s.owner, b.id)).counts).toMatchObject({ queued: 2, excluded: 1, reasons: { held_by_person: 1 } });
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'crm.review_request_held' and target_id = $2", [b.org, held])).toBe(1);
    expect(BLOCK_REASON_LABELS.held_by_person).toMatch(/excluded this customer from automatic messages/);

    // When the window opens, only the others are asked.
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: opens, limit: 100 });
    const ids = new Set([(await requestOf(b.id, held)).message_id, (await requestOf(b.id, other1)).message_id, (await requestOf(b.id, other2)).message_id]);
    const sent = rec.calls.filter((c) => ids.has(c.messageId));
    expect(sent).toHaveLength(2);
    expect(await one<{ phone: string }>("select phone from contacts where id = $1", [held]).then((r) => sent.some((c) => c.to === r.phone))).toBe(false);
  });

  it("leaves a person's own ask alone, and a hold that is lifted again does not bring a withdrawn ask back", async () => {
    const s = await reputationShop("Hold Own Ask Shop");
    const c = await shopCustomer(s);
    const own = await requestReview(s.owner, { contactId: c, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, businessHoursOnly: false });
    await setRetentionPaused(s.m.ctx("owner"), c, true, "Dispute");
    expect(await messageOf(own.messageId)).toMatchObject({ status: "queued", blocked_reason: null });
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: new Date(T.getTime() + 60_000), limit: 100 });
    expect(rec.calls.filter((x) => x.messageId === own.messageId)).toHaveLength(1);

    const b = await readyBatch(s, 1);
    await withSystem((db) => db.query("update contacts set retention_paused = false where id = $1", [b.contacts[0]]));
    await advanceBatch(b.id, b.org, T);
    const ask = await requestOf(b.id, b.contacts[0]);
    await setRetentionPaused(s.m.ctx("owner"), b.contacts[0], true, "Dispute");
    await setRetentionPaused(s.m.ctx("owner"), b.contacts[0], false);
    expect(await messageOf(ask.message_id)).toMatchObject({ status: "blocked", blocked_reason: "held_by_person" });
    expect((await requestOf(b.id, b.contacts[0])).status).toBe("cancelled");
  });
});

describe("the dispatcher checks the hold too", () => {
  it("refuses an automatic ask for a held customer when it is about to send it, whoever set the hold and however it was set", async () => {
    const s = await reputationShop("Hold At Dispatch Shop");
    const b = await readyBatch(s, 2);
    await advanceBatch(b.id, b.org, T);
    const [held, fine] = b.contacts;
    const ask = await requestOf(b.id, held);
    // Set behind the service's back (an older writer, a manual fix): only the dispatch-time check can still stop it.
    await withSystem((db) => db.query("update contacts set retention_paused = true where id = $1", [held]));
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: new Date(T.getTime() + 60_000), limit: 100 });
    const sentTo = new Set(rec.calls.map((c) => c.messageId));
    expect(sentTo.has(ask.message_id)).toBe(false);
    expect(sentTo.has((await requestOf(b.id, fine)).message_id)).toBe(true);
    expect(await messageOf(ask.message_id)).toMatchObject({ status: "blocked", blocked_reason: "held_by_person" });
    expect((await requestOf(b.id, held)).status).toBe("cancelled");
    expect(await itemOf(b.id, held)).toEqual({ status: "excluded", reason: "held_by_person" });
  });
});
