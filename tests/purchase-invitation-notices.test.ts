// What the email provider says AFTER it accepted a purchase invitation, on embedded Postgres with the provider replaced by a stand-in fetch and its webhook signed the way Svix signs it.
// Proved: an accepted invitation stays "Sent" until the provider's own signed notice says delivered (and never because a send call returned); a bounce is final and an out-of-order
// "delivered" cannot undo it; a refused or suppressed message is failed with the provider's reason; a replayed, unsigned, tampered or unmatched notice changes nothing; a hand-shared
// link is never moved by any notice; and no notice writes the buyer's link anywhere.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { getPurchaseIntent, listPurchaseIntentEvents } from "@/server/purchase-intents/service";
import { inviteBuyer } from "@/server/purchase-intents/invitations";
import { applyInvitationEmailNotice } from "@/server/purchase-intents/delivery-events";
import { handleResendWebhook, signResendWebhook } from "@/server/messaging/transports/resend";
import { invitationEmailEventText } from "@/lib/purchase-intents/rules";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";

const NOW = new Date("2026-10-25T12:00:00Z");
const SECRET = `whsec_${crypto.randomBytes(24).toString("base64")}`;
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

/** A stand-in for Resend's send API: every message gets its own id, which is what the webhook later names. */
function stubResend(answer: "ok" | "down" = "ok") {
  const sent: Array<{ id: string; to: string; text: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (answer === "down") throw new Error("connect ECONNREFUSED 203.0.113.9:443");
    const body = JSON.parse(String(init.body)) as { to: string[]; text: string };
    const id = `em_${crypto.randomUUID()}`;
    sent.push({ id, to: body.to[0], text: body.text });
    return new Response(JSON.stringify({ id }), { status: 200 });
  }));
  return sent;
}

async function superSession() {
  await agencyOrgId(); // a fresh database has no agency workspace until something asks for it
  return agencyUser(await staffPerson("agency_super_admin"), "agency_super_admin");
}

const invite = async (session: Awaited<ReturnType<typeof superSession>>) =>
  inviteBuyer(session, {
    buyerName: "Bailey Buyer", buyerEmail: `buyer-${crypto.randomUUID().slice(0, 8)}@example.test`, company: `Buyer Co ${crypto.randomUUID().slice(0, 6)}`, industry: "Home services",
    website: "https://buyer.example.test", timezone: "America/Chicago", maintenanceSelected: false, idempotencyKey: crypto.randomUUID(),
  }, { now: NOW });

/** Signs and delivers one provider notice the way Resend (through Svix) does, with the provider's own message id and the tag this app set on the message. */
async function notice(type: string, emailId: string, extra: Record<string, unknown> = {}, opts: { id?: string; secret?: string; tamper?: (raw: string) => string } = {}) {
  const raw = JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: emailId, created_at: new Date().toISOString(), from: "iAcquire <no-reply@iacquire.online>", to: ["buyer@example.test"], subject: "Your iAcquireOS invitation", ...extra } });
  const id = opts.id ?? `msg_${crypto.randomBytes(12).toString("hex")}`;
  const at = Math.floor(Date.now() / 1000);
  const headers = { "svix-id": id, "svix-timestamp": String(at), "svix-signature": signResendWebhook(opts.secret ?? SECRET, id, at, raw), "content-type": "application/json" };
  return handleResendWebhook(opts.tamper ? opts.tamper(raw) : raw, headers, { secret: SECRET });
}

const delivery = async (intentId: string) =>
  (await rows<{ id: string; status: string; reason: string | null; error: string | null; completed_at: string | null; provider_message_id: string | null }>(
    "select id, status, reason, error, completed_at, provider_message_id from purchase_intent_deliveries where intent_id = $1 order by created_at desc, id limit 1", [intentId]))[0];

beforeEach(() => setEnv({ ...READY }));
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetEnvCache();
});

describe("an accepted invitation becomes delivered only when the provider says so", () => {
  it("stays Sent after the send, becomes Delivered on the provider's signed notice, and tells the timeline and the audit trail once", async () => {
    const session = await superSession();
    const sent = stubResend();
    const made = await invite(session);
    expect(made.delivery).toMatchObject({ status: "sent", statusText: "Sent to the email provider" });
    expect((await delivery(made.intent.id)).provider_message_id).toBe(sent[0].id);

    const first = await notice("email.delivered", sent[0].id, { tags: { outbox: crypto.randomUUID() } });
    expect(first).toMatchObject({ status: 200, outcome: "processed" });
    const now = await delivery(made.intent.id);
    expect(now).toMatchObject({ status: "delivered", reason: null, error: null });
    expect(now.completed_at).not.toBeNull();

    // Every screen reads the same delivery: the detail page, in the provider's words and nothing stronger.
    const view = (await getPurchaseIntent(session, made.intent.id, { now: NOW })).delivery;
    expect(view).toMatchObject({ status: "delivered", statusText: "Delivered" });
    expect(view?.sentence).toMatch(/reported the message delivered/);
    expect(view?.sentence).toMatch(/not proof the buyer has read it/);

    const events = await listPurchaseIntentEvents(session, made.intent.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "invitation_email", "invitation_email"]);
    expect(events[2].detail).toMatchObject({ status: "delivered", source: "email_provider_notice", deliveryId: now.id });
    expect(invitationEmailEventText(events[2].detail as Record<string, unknown>)).toBe("Invitation email: the email provider reported it delivered");
    const audit = await rows<{ action: string; result: string; actor_kind: string }>("select action, result, actor_kind from audit_logs where target_id = $1 order by created_at, id", [made.intent.id]);
    expect(audit.map((a) => a.action)).toEqual(["purchase_intent.created", "purchase_intent.invitation_sent", "purchase_intent.invitation_delivered"]);
    expect(audit[2]).toMatchObject({ result: "success", actor_kind: "system" });
  });

  it("changes nothing when the same notice arrives again, or a duplicate says delivered after delivery", async () => {
    const session = await superSession();
    const sent = stubResend();
    const made = await invite(session);
    const hookId = `msg_${crypto.randomBytes(12).toString("hex")}`;
    expect(await notice("email.delivered", sent[0].id, {}, { id: hookId })).toMatchObject({ status: 200, outcome: "processed" });
    // The provider re-sends one notice (same svix id): recorded once.
    expect(await notice("email.delivered", sent[0].id, {}, { id: hookId })).toMatchObject({ status: 200, outcome: "duplicate" });
    // A second, different notice with the same meaning moves nothing and writes nothing new.
    expect(await notice("email.delivered", sent[0].id)).toMatchObject({ status: 200, outcome: "processed" });
    const events = await listPurchaseIntentEvents(session, made.intent.id);
    expect(events.filter((e) => e.kind === "invitation_email")).toHaveLength(2);
    expect((await delivery(made.intent.id)).status).toBe("delivered");
  });

  it("treats a spam complaint as delivered: the message did reach an inbox", async () => {
    const session = await superSession();
    const sent = stubResend();
    const made = await invite(session);
    expect(await notice("email.complained", sent[0].id)).toMatchObject({ status: 200, outcome: "processed" });
    expect((await delivery(made.intent.id)).status).toBe("delivered");
  });
});

describe("a bounce or a refusal is final and says so", () => {
  it("marks a bounce straight after acceptance as Bounced, with the kind of bounce, and offers no delivery claim", async () => {
    const session = await superSession();
    const sent = stubResend();
    const made = await invite(session);
    expect(await notice("email.bounced", sent[0].id, { bounce: { type: "Permanent", subType: "General", message: "550 5.1.1 user unknown" } })).toMatchObject({ status: 200, outcome: "processed" });
    const now = await delivery(made.intent.id);
    expect(now).toMatchObject({ status: "bounced", reason: null, error: "permanent bounce" });
    const view = (await getPurchaseIntent(session, made.intent.id, { now: NOW })).delivery;
    expect(view?.statusText).toBe("Bounced");
    expect(view?.tone).toBe("danger");
    expect(view?.sentence).toContain("mail server did not accept the message (permanent bounce)");
    // The provider's own bounce text (which can quote the buyer's mailbox) is not kept.
    expect(JSON.stringify(await rows("select to_jsonb(x) as t from purchase_intent_deliveries x where intent_id = $1", [made.intent.id]))).not.toContain("user unknown");
    const events = await listPurchaseIntentEvents(session, made.intent.id);
    expect(invitationEmailEventText(events.at(-1)!.detail as Record<string, unknown>)).toBe("Invitation email: the buyer's mail server did not accept it");
  });

  it("does not let a late 'delivered' undo a bounce, and records the bounce once", async () => {
    const session = await superSession();
    const sent = stubResend();
    const made = await invite(session);
    await notice("email.bounced", sent[0].id, { bounce: { type: "Transient" } });
    await notice("email.delivered", sent[0].id);
    expect(await delivery(made.intent.id)).toMatchObject({ status: "bounced", error: "transient bounce" });
    const bounces = (await listPurchaseIntentEvents(session, made.intent.id)).filter((e) => e.kind === "invitation_email" && (e.detail as { status?: string }).status === "bounced");
    expect(bounces).toHaveLength(1);
  });

  it("lets a bounce follow a delivery, because a receiving server can reject a message after first accepting it", async () => {
    const session = await superSession();
    const sent = stubResend();
    const made = await invite(session);
    await notice("email.delivered", sent[0].id);
    await notice("email.bounced", sent[0].id, { bounce: { type: "Permanent" } });
    expect((await delivery(made.intent.id)).status).toBe("bounced");
  });

  it("marks a message the provider took and then did not send as Failed, with a fixed reason, and keeps the invitation open for a resend", async () => {
    const session = await superSession();
    const sent = stubResend();
    const made = await invite(session);
    await notice("email.suppressed", sent[0].id, { suppressed: { reason: "previous_bounce" } });
    const now = await delivery(made.intent.id);
    expect(now).toMatchObject({ status: "failed", reason: "provider_refused" });
    expect(now.error).toBe("suppressed by the provider: previous bounce");
    const view = (await getPurchaseIntent(session, made.intent.id, { now: NOW })).delivery;
    expect(view).toMatchObject({ status: "failed", statusText: "Failed" });
    expect((await getPurchaseIntent(session, made.intent.id, { now: NOW })).can.rotate).toBe(true);
  });

  it("reports a failed notice the same way, and leaves a delivered message alone when a failure for it arrives late", async () => {
    const session = await superSession();
    const sent = stubResend();
    const a = await invite(session);
    await notice("email.failed", sent[0].id, { failed: { reason: "reached_daily_quota" } });
    expect(await delivery(a.intent.id)).toMatchObject({ status: "failed", reason: "provider_refused", error: "failed at the provider: reached daily quota" });
    const b = await invite(session);
    await notice("email.delivered", sent[1].id);
    await notice("email.failed", sent[1].id, { failed: { reason: "reached_daily_quota" } });
    expect((await delivery(b.intent.id)).status).toBe("delivered");
  });
});

describe("a notice that is not about a sent invitation changes nothing", () => {
  it("ignores a delay, an open, a click and any event type the portal does not use, leaving the invitation at Sent", async () => {
    const session = await superSession();
    const sent = stubResend();
    const made = await invite(session);
    for (const type of ["email.delivery_delayed", "email.sent", "email.opened", "email.clicked", "email.scheduled"]) {
      expect((await notice(type, sent[0].id)).status).toBe(200);
    }
    expect(await delivery(made.intent.id)).toMatchObject({ status: "sent", error: null });
    expect((await listPurchaseIntentEvents(session, made.intent.id)).filter((e) => e.kind === "invitation_email")).toHaveLength(1);
  });

  it("answers an unknown message id as unmatched, writes nothing, and never moves another delivery", async () => {
    const session = await superSession();
    const sent = stubResend();
    const made = await invite(session);
    const result = await notice("email.delivered", `em_${crypto.randomUUID()}`);
    expect(result).toMatchObject({ status: 200, outcome: "ignored" });
    expect(result.detail).toMatch(/No message of ours matches/);
    expect((await delivery(made.intent.id)).provider_message_id).toBe(sent[0].id);
    expect((await delivery(made.intent.id)).status).toBe("sent");
  });

  it("cannot move a link that was handed over by hand: it has no provider message to match", async () => {
    const session = await superSession();
    setEnv({ EMAIL_PROVIDER: "capture" });
    const sent = stubResend();
    const made = await invite(session);
    expect(sent).toHaveLength(0);
    expect(made.delivery?.status).toBe("manual");
    expect(await withSystem((db) => applyInvitationEmailNotice(db, { emailId: "em_nothing", type: "delivered" }))).toBeNull();
    expect((await delivery(made.intent.id)).status).toBe("manual");
  });

  it("refuses an unsigned notice, a notice signed with another secret and a notice altered after signing, and records none of them", async () => {
    const session = await superSession();
    const sent = stubResend();
    const made = await invite(session);
    const wrongSecret = `whsec_${crypto.randomBytes(24).toString("base64")}`;
    expect(await notice("email.delivered", sent[0].id, {}, { secret: wrongSecret })).toMatchObject({ status: 401, outcome: "rejected" });
    expect(await notice("email.delivered", sent[0].id, {}, { tamper: (raw) => raw.replace("email.delivered", "email.bounced") })).toMatchObject({ status: 401, outcome: "rejected" });
    const bare = await handleResendWebhook(JSON.stringify({ type: "email.delivered", data: { email_id: sent[0].id } }), {}, { secret: SECRET });
    expect([400, 401]).toContain(bare.status);
    expect(bare.outcome).toBe("rejected");
    expect((await delivery(made.intent.id)).status).toBe("sent");
  });

  it("is a harmless no-op on a database that has not had the delivery tables yet", async () => {
    class Rollback extends Error {}
    await expect(
      withSystem(async (db) => {
        await db.query("drop table purchase_intent_deliveries cascade");
        expect(await applyInvitationEmailNotice(db, { emailId: "em_anything", type: "delivered" })).toBeNull();
        throw new Rollback("undo the drop");
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect((await rows<{ ok: boolean }>("select to_regclass('public.purchase_intent_deliveries') is not null as ok"))[0].ok).toBe(true);
  });
});

describe("no notice ever carries or stores the buyer's link", () => {
  it("holds no token in the deliveries, the timeline or the audit trail after a delivered and a bounced notice", async () => {
    const session = await superSession();
    const sent = stubResend();
    const a = await invite(session);
    const b = await invite(session);
    await notice("email.delivered", sent[0].id);
    await notice("email.bounced", sent[1].id, { bounce: { type: "Permanent" } });
    for (const [made, mail] of [[a, sent[0]], [b, sent[1]]] as const) {
      const token = /\/purchase\/([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1];
      expect(token).toBe(made.token);
      for (const table of ["purchase_intent_deliveries", "purchase_intent_events", "audit_logs", "webhook_receipts"]) {
        const all = await rows<{ t: string }>(`select to_jsonb(x)::text as t from ${table} x`);
        expect(all.some((r) => r.t.includes(token as string))).toBe(false);
      }
    }
  });
});
