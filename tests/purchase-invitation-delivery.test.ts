// Purchase invitations by email, on embedded Postgres with the email provider replaced by a stand-in fetch: nothing here reaches Resend or sends a real message. What is proved:
// an invitation is created and emailed in one step; the buyer's link reaches the provider but no table, log or audit row ever holds it; the delivery record says what really
// happened (sent is never "delivered"; a provider that is off, unconfigured, refusing or down leaves the invitation created with the link to share by hand); a double press, a retried
// request and a resend never make two invitations, two links or two emails; and only a Super Admin can do any of it.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { getPublicPurchase, getPurchaseIntent, listPurchaseIntentDeliveries, listPurchaseIntentEvents, listPurchaseIntents, createPurchaseIntent, rotatePurchaseLink } from "@/server/purchase-intents/service";
import { inviteBuyer, resendInvitation } from "@/server/purchase-intents/invitations";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";

const NOW = new Date("2026-10-25T12:00:00Z");
const email = () => `buyer-${crypto.randomUUID().slice(0, 8)}@example.test`;
const key = () => crypto.randomUUID();

const READY = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_not_a_real_key_123", EMAIL_FROM: "iAcquire <no-reply@iacquire.online>", APP_URL: "https://www.iacquire.online" } as const;
const SAVED: Record<string, string | undefined> = {};
const setEnv = (over: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(over)) {
    if (!(name in SAVED)) SAVED[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetEnvCache();
};

/** A stand-in for Resend's API: records every request and answers as told. */
function stubResend(answer: "ok" | "refused" | "down" = "ok") {
  const calls: Array<{ url: string; body: { to: string[]; subject: string; text: string; html: string; from: string; tags?: Array<{ name: string; value: string }> } }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (answer === "down") throw new Error("connect ECONNREFUSED 203.0.113.9:443");
    if (answer === "refused") return new Response(JSON.stringify({ message: "The iacquire.online domain is not verified." }), { status: 403 });
    return new Response(JSON.stringify({ id: `em_${calls.length}_provider1` }), { status: 200 });
  }));
  return calls;
}

const tokenIn = (text: string) => /\/purchase\/([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? null;

async function world() {
  const agencyId = await agencyOrgId();
  const superAdmin = await staffPerson("agency_super_admin");
  const manager = await staffPerson("agency_manager");
  const staff = await staffPerson("agency_staff");
  return { agencyId, superSession: agencyUser(superAdmin, "agency_super_admin"), managerSession: agencyUser(manager, "agency_manager"), staffSession: agencyUser(staff, "agency_staff") };
}

const input = (over: Record<string, unknown> = {}) => ({
  buyerName: "Bailey Buyer", buyerEmail: email(), company: `Buyer Co ${crypto.randomUUID().slice(0, 6)}`, industry: "Home services", website: "https://buyer.example.test",
  timezone: "America/Chicago", maintenanceSelected: true, ...over,
});

const LEAK_TABLES = ["email_outbox", "purchase_intents", "purchase_intent_events", "purchase_intent_deliveries", "audit_logs", "rate_limit_buckets"] as const;
/** Every ordinary table that could be asked to remember a link, read as text: the token must be in none of them. */
async function tablesHolding(needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const table of LEAK_TABLES) {
    const all = await rows<{ t: string }>(`select to_jsonb(x)::text as t from ${table} x`);
    if (all.some((r) => r.t.includes(needle))) found.push(table);
  }
  return found;
}

beforeEach(() => setEnv({ ...READY }));
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetEnvCache();
});

describe("creating an invitation emails the buyer, and only the buyer's email carries the link", () => {
  it("creates the invitation, sends one branded email through the provider and records it as sent, not delivered", async () => {
    const w = await world();
    const calls = stubResend("ok");
    const data = input({ buyerName: "Pat Prospect", maintenanceSelected: true });
    const made = await inviteBuyer(w.superSession, { ...data, idempotencyKey: key() }, { now: NOW });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    const sent = calls[0].body;
    expect(sent.to).toEqual([data.buyerEmail]);
    expect(sent.from).toBe("iAcquire <no-reply@iacquire.online>");
    expect(sent.subject).toContain(data.company);
    // The plain-text part and the branded HTML both carry the buyer's own link, on the site's own address, with the token this answer returned.
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenIn(sent.text)).toBe(made.token);
    expect(sent.html).toContain(`href="https://www.iacquire.online/purchase/${made.token}"`);
    // The offer, as promised: the buyer's name, company, price, the optional plan, the reference and the expiry in the buyer's zone.
    expect(sent.text).toContain("Hi Pat,");
    expect(sent.text).toContain(`Company: ${data.company}`);
    expect(sent.text).toContain("One-time setup: $1,499");
    expect(sent.text).toContain("$299/month");
    expect(sent.text).toContain(`Reference: ${made.intent.reference}`);
    expect(sent.text).toMatch(/Link expires: .*(CST|CDT|GMT-[56])/);

    expect(made.replayed).toBe(false);
    expect(made.delivery).toMatchObject({ kind: "invitation", status: "sent", statusText: "Sent to the email provider", recipient: data.buyerEmail, provider: "resend", reason: null });
    expect(made.delivery?.sentence).toMatch(/does not mean|not that it reached the inbox/i);
    expect(JSON.stringify(made.delivery)).not.toMatch(/delivered/i);
    // The purchase and its page work with the emailed link.
    expect(await getPublicPurchase(made.token, { now: NOW })).toMatchObject({ reference: made.intent.reference, canConfirm: true });
    // The list and the detail read the same delivery, at once.
    const listed = (await listPurchaseIntents(w.superSession, { now: NOW })).find((i) => i.id === made.intent.id);
    expect(listed?.delivery?.status).toBe("sent");
    expect((await getPurchaseIntent(w.superSession, made.intent.id, { now: NOW })).delivery).toMatchObject({ id: made.delivery?.id, status: "sent" });
    const deliveryRows = await rows<{ status: string; provider_message_id: string | null; outbox_id: string | null; attempts: number; idempotency_key: string | null }>("select status, provider_message_id, outbox_id, attempts, idempotency_key from purchase_intent_deliveries where intent_id = $1", [made.intent.id]);
    expect(deliveryRows).toEqual([{ status: "sent", provider_message_id: "em_1_provider1", outbox_id: expect.any(String), attempts: 1, idempotency_key: expect.any(String) }]);
    // The timeline and the audit trail say the same thing in fixed words.
    const events = await listPurchaseIntentEvents(w.superSession, made.intent.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "invitation_email"]);
    expect(events[1].detail).toMatchObject({ kind: "invitation", status: "sent" });
    const audit = await rows<{ action: string; result: string }>("select action, result from audit_logs where target_id = $1 order by created_at, id", [made.intent.id]);
    expect(audit.map((a) => a.action)).toEqual(["purchase_intent.created", "purchase_intent.invitation_sent"]);
  });

  it("never stores the link: the outbox keeps the email with the link cut out, and no table, event or audit row holds the token", async () => {
    const w = await world();
    const calls = stubResend("ok");
    const made = await inviteBuyer(w.superSession, input(), { now: NOW });
    const token = made.token as string;
    expect(tokenIn(calls[0].body.text)).toBe(token);
    const outbox = await rows<{ template: string; body_text: string; status: string; subject: string }>("select template, body_text, status, subject from email_outbox where to_email = $1", [made.intent.buyerEmail]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ template: "purchase_invitation", status: "sent" });
    expect(outbox[0].body_text).toContain("[secure link not stored]");
    expect(outbox[0].body_text).not.toContain(token);
    expect(outbox[0].body_text).toContain("Company:");
    expect(await tablesHolding(token)).toEqual([]);
    // Only a hash exists on the purchase, as before.
    const [row] = await rows<{ token_hash: string }>("select token_hash from purchase_intents where id = $1", [made.intent.id]);
    expect(row.token_hash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    // And the provider's request was tagged with the outbox row, never with the link.
    expect(calls[0].body.tags?.[0].name).toBe("outbox");
    expect(JSON.stringify(calls[0].body.tags)).not.toContain(token);
  });

  it("still creates the invitation when email is switched off, and says manual sharing is required (nothing is sent)", async () => {
    const w = await world();
    const calls = stubResend("ok");
    setEnv({ EMAIL_PROVIDER: "capture" });
    const made = await inviteBuyer(w.superSession, input(), { now: NOW });
    expect(calls).toHaveLength(0);
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.delivery).toMatchObject({ status: "manual", statusText: "Manual sharing required", reason: "email_off", provider: "capture" });
    expect(made.delivery?.sentence).toMatch(/No email was sent/);
    expect(await getPublicPurchase(made.token, { now: NOW })).toMatchObject({ canConfirm: true });
    expect((await rows("select 1 from email_outbox where to_email = $1", [made.intent.buyerEmail]))).toHaveLength(0);
    expect((await listPurchaseIntentEvents(w.superSession, made.intent.id)).map((e) => e.kind)).toEqual(["created", "invitation_email"]);
  });

  it.each([
    ["no provider key", { RESEND_API_KEY: undefined }, "email_not_configured"],
    ["a placeholder sender address", { EMAIL_FROM: "iAcquire <no-reply@iacquire.local>" }, "sender_not_ready"],
  ])("does not try to send with %s: manual sharing, with the reason", async (_name, over, reason) => {
    const w = await world();
    const calls = stubResend("ok");
    setEnv(over);
    const made = await inviteBuyer(w.superSession, input(), { now: NOW });
    expect(calls).toHaveLength(0);
    expect(made.delivery).toMatchObject({ status: "manual", reason });
  });

  it("makes the invitation without email when the Super Admin unticks it, and records that it was their choice", async () => {
    const w = await world();
    const calls = stubResend("ok");
    const made = await inviteBuyer(w.superSession, input({ sendEmail: false }), { now: NOW });
    expect(calls).toHaveLength(0);
    expect(made.delivery).toMatchObject({ status: "manual", reason: "chosen", provider: "none" });
    expect(made.token).not.toBeNull();
  });

  it("reports a provider that refuses the sender as failed (with its words), keeps the invitation and hands over the link", async () => {
    const w = await world();
    const calls = stubResend("refused");
    const made = await inviteBuyer(w.superSession, input(), { now: NOW });
    expect(calls).toHaveLength(1);
    expect(made.delivery).toMatchObject({ status: "failed", statusText: "Failed", reason: "provider_refused" });
    expect(made.delivery?.error).toMatch(/403.*not verified/);
    expect(made.token).not.toBeNull();
    expect(await getPublicPurchase(made.token, { now: NOW })).toMatchObject({ canConfirm: true });
    const audit = await rows<{ action: string; result: string }>("select action, result from audit_logs where action like 'purchase_intent.invitation_%' and target_id = $1", [made.intent.id]);
    expect(audit).toEqual([{ action: "purchase_intent.invitation_failed", result: "failure" }]);
  });

  it("reports an unreachable provider as failed, then a retry with a new link succeeds and kills the old link", async () => {
    const w = await world();
    stubResend("down");
    const made = await inviteBuyer(w.superSession, input(), { now: NOW });
    expect(made.delivery).toMatchObject({ status: "failed", reason: "provider_unreachable" });
    const firstToken = made.token as string;

    const calls = stubResend("ok");
    const again = await resendInvitation(w.superSession, made.intent.id, { email: true, idempotencyKey: key() }, { now: new Date(NOW.getTime() + 120_000) });
    expect(again.delivery).toMatchObject({ kind: "resend", status: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.subject).toMatch(/new iAcquireOS purchase link/);
    expect(calls[0].body.text).toMatch(/replaces the link we emailed earlier/);
    expect(tokenIn(calls[0].body.text)).toBe(again.token);
    expect(await getPublicPurchase(firstToken, { now: NOW })).toBeNull();
    expect(await getPublicPurchase(again.token, { now: NOW })).toMatchObject({ canConfirm: true });
    expect(await tablesHolding(again.token as string)).toEqual([]);
    expect((await listPurchaseIntentDeliveries(w.superSession, made.intent.id, { now: NOW })).map((d) => d.status)).toEqual(["sent", "failed"]);
    expect((await getPurchaseIntent(w.superSession, made.intent.id, { now: NOW })).delivery).toMatchObject({ kind: "resend", status: "sent" });
  });
});

describe("a repeated request is one invitation, one link and one email", () => {
  it("answers the same invitation for the same key, with no second email and no way to show the link again", async () => {
    const w = await world();
    const calls = stubResend("ok");
    const data = input();
    const idempotencyKey = key();
    const first = await inviteBuyer(w.superSession, { ...data, idempotencyKey }, { now: NOW });
    const second = await inviteBuyer(w.superSession, { ...data, idempotencyKey }, { now: NOW });
    expect(second.replayed).toBe(true);
    expect(second.token).toBeNull();
    expect(second.intent.id).toBe(first.intent.id);
    expect(second.delivery?.id).toBe(first.delivery?.id);
    expect(calls).toHaveLength(1);
    expect(await rows("select 1 from purchase_intents where buyer_email = $1", [data.buyerEmail])).toHaveLength(1);
    // The link the first answer showed is still the only one, and still works.
    expect(await getPublicPurchase(first.token, { now: NOW })).toMatchObject({ canConfirm: true });
  });

  it("makes one invitation and sends one email when two requests with one key arrive together", async () => {
    const w = await world();
    const calls = stubResend("ok");
    const data = input();
    const idempotencyKey = key();
    const both = await Promise.all([inviteBuyer(w.superSession, { ...data, idempotencyKey }, { now: NOW }), inviteBuyer(w.superSession, { ...data, idempotencyKey }, { now: NOW })]);
    expect(both.filter((r) => r.replayed)).toHaveLength(1);
    expect(new Set(both.map((r) => r.intent.id)).size).toBe(1);
    expect(calls).toHaveLength(1);
    expect(await rows("select 1 from purchase_intents where buyer_email = $1", [data.buyerEmail])).toHaveLength(1);
  });

  it("refuses a key that was already used for a different buyer, and a second open invitation for the same buyer", async () => {
    const w = await world();
    stubResend("ok");
    const idempotencyKey = key();
    await inviteBuyer(w.superSession, { ...input(), idempotencyKey }, { now: NOW });
    await expect(inviteBuyer(w.superSession, { ...input(), idempotencyKey }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    const same = input();
    await inviteBuyer(w.superSession, { ...same, idempotencyKey: key() }, { now: NOW });
    await expect(inviteBuyer(w.superSession, { ...same, idempotencyKey: key() }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
  });

  it("makes one new link for one resend key: a double press cannot kill the link that was just emailed", async () => {
    const w = await world();
    stubResend("ok");
    const made = await inviteBuyer(w.superSession, input(), { now: NOW });
    const calls = stubResend("ok");
    const later = new Date(NOW.getTime() + 120_000);
    const pressKey = key();
    const a = await resendInvitation(w.superSession, made.intent.id, { email: true, idempotencyKey: pressKey }, { now: later });
    const b = await resendInvitation(w.superSession, made.intent.id, { email: true, idempotencyKey: pressKey }, { now: later });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.token).toBeNull();
    expect(calls).toHaveLength(1);
    expect(await getPublicPurchase(a.token, { now: later })).toMatchObject({ canConfirm: true });
  });

  it("allows one new link a minute and six a day for one purchase", async () => {
    const w = await world();
    stubResend("ok");
    const made = await inviteBuyer(w.superSession, input(), { now: NOW });
    const at = (n: number) => new Date(NOW.getTime() + n * 61_000);
    await resendInvitation(w.superSession, made.intent.id, { email: true, idempotencyKey: key() }, { now: at(1) });
    await expect(resendInvitation(w.superSession, made.intent.id, { email: true, idempotencyKey: key() }, { now: new Date(at(1).getTime() + 10_000) })).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: expect.any(Number) });
    for (let n = 2; n <= 6; n++) await rotatePurchaseLink(w.superSession, made.intent.id, { now: at(n) });
    await expect(rotatePurchaseLink(w.superSession, made.intent.id, { now: at(7) })).rejects.toMatchObject({ code: "rate_limited", message: expect.stringMatching(/6 links/) });
    // A day later it is allowed again.
    await expect(rotatePurchaseLink(w.superSession, made.intent.id, { now: new Date(at(1).getTime() + 25 * 3_600_000) })).resolves.toMatchObject({ token: expect.any(String) });
  });
});

describe("who may do it, and what a hand-shared link records", () => {
  it("lets only a Super Admin create, resend or rotate, and a manager or staff member none of them", async () => {
    const w = await world();
    stubResend("ok");
    await expect(inviteBuyer(w.managerSession, input(), { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(inviteBuyer(w.staffSession, input(), { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    const made = await inviteBuyer(w.superSession, input(), { now: NOW });
    await expect(resendInvitation(w.managerSession, made.intent.id, { email: true }, { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(rotatePurchaseLink(w.staffSession, made.intent.id, { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    // A manager can still read the delivery.
    expect((await getPurchaseIntent(w.managerSession, made.intent.id, { now: NOW })).delivery?.status).toBe("sent");
  });

  it("records a link made for hand sharing as a rotation delivery, and refuses a resend once the payment is verified or the purchase is cancelled", async () => {
    const w = await world();
    stubResend("ok");
    const made = await inviteBuyer(w.superSession, input(), { now: NOW });
    const hand = await resendInvitation(w.superSession, made.intent.id, { email: false, idempotencyKey: key() }, { now: new Date(NOW.getTime() + 90_000) });
    expect(hand.delivery).toMatchObject({ kind: "rotation", status: "manual", reason: "chosen" });
    expect(hand.token).not.toBeNull();
    const { cancelPurchaseIntent } = await import("@/server/purchase-intents/service");
    await cancelPurchaseIntent(w.superSession, made.intent.id, "The buyer changed their mind.", { now: NOW });
    await expect(resendInvitation(w.superSession, made.intent.id, { email: true }, { now: new Date(NOW.getTime() + 600_000) })).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps the older no-email path working: createPurchaseIntent still returns the link and writes no delivery", async () => {
    const w = await world();
    const calls = stubResend("ok");
    const created = await createPurchaseIntent(w.superSession, input(), { now: NOW });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls).toHaveLength(0);
    expect(await rows("select 1 from purchase_intent_deliveries where intent_id = $1", [created.id])).toHaveLength(0);
    expect((await getPurchaseIntent(w.superSession, created.id, { now: NOW })).delivery).toBeNull();
  });

  it("shows a delivery that never settled as pending with no result recorded, and offers sending again", async () => {
    const w = await world();
    stubResend("ok");
    const made = await inviteBuyer(w.superSession, input({ sendEmail: false }), { now: NOW });
    // Simulate a request that died before the provider answered: a pending delivery with no completion.
    await withSystem((db) => db.query("update purchase_intent_deliveries set status = 'pending', reason = null, completed_at = null where id = $1", [made.delivery?.id]));
    const soon = await getPurchaseIntent(w.superSession, made.intent.id, { now: new Date(NOW.getTime() + 60_000) });
    expect(soon.delivery).toMatchObject({ status: "pending", statusText: "Pending", stale: false });
    const later = await getPurchaseIntent(w.superSession, made.intent.id, { now: new Date(NOW.getTime() + 10 * 60_000) });
    expect(later.delivery).toMatchObject({ status: "pending", statusText: "Pending, no result recorded", stale: true });
    expect(later.delivery?.sentence).toMatch(/Treat it as not sent/);
    expect(later.can.rotate).toBe(true);
  });
});
