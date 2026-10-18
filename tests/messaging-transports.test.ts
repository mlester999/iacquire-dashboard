// The provider-neutral messaging core: the transport registry, per-channel routing (GoHighLevel and the native providers), delivery
// events correlated by our own message id, provider-neutral inbound with tenant resolution, email threading, channel setup, and the
// customer booking link that is never stored. Synthetic workspaces only: every send goes to an in-memory recorder, and the one place a
// real transport is called proves that its kill switch stops it before any network request.
import crypto from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { getBalance } from "@/server/billing/ledger";
import { recordConsent } from "@/server/messaging/contacts";
import { ingestInbound, resolveChannelByInboundAddress, resolveChannelByProviderSender } from "@/server/messaging/ingest";
import { applyDeliveryEvent, applyDeliveryEventForMessage, dispatchMessage, queueOutbound, whatsappTemplateParams } from "@/server/messaging/send";
import { attestChannelSender, getConversationDetail, listConversations, sendHumanReply, setChannelEnabled } from "@/server/messaging/inbox";
import { configureNativeChannel, disableChannel, enableChannel, listChannelStatus, runChannelCapabilityTest, switchChannelToGhl } from "@/server/messaging/channels";
import { loadChannelTransport, transportFor, transportWritesEnabled, type CapabilityTestInput } from "@/server/messaging/transports";
import { CUSTOMER_LINK_LABEL, fillManageLink, maskCustomerLinks } from "@/server/messaging/redact";
import { getTimeline } from "@/server/crm/timeline";
import { memberActor } from "@/server/crm/actor";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { encodeCredentialSecret, parseCredentialSecret } from "@/server/security/credentials";
import type { CapabilityTest, ChannelTransport, TransportSendRequest } from "@/server/messaging/transports/types";
import { agencyUser, createUser } from "./support/fixtures";
import { FIXTURE_RATES, inbound, messageRow, messagingOrg, phone, recordingProvider, type MessagingOrg } from "./support/messaging";

// The billing markup the fixtures run with (30%), so a reservation's size shows which provider's rate priced it.
const client = (wholesale: number) => Math.ceil(wholesale * 1.3);

let ghl: MessagingOrg;
let native: MessagingOrg;
beforeAll(async () => {
  // Meta's rate is deliberately not published yet: the first test proves a native channel without a published rate refuses to send.
  ghl = await messagingOrg({ name: "Classic GHL Co" });
  native = await messagingOrg({ name: "Native Co", provider: { sms: "twilio", email: "resend" } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const queueAi = (org: MessagingOrg, conversationId: string, body = "Thanks for reaching out. We have room on Thursday.", extra: Record<string, unknown> = {}) =>
  withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body, ...extra }));
const usageFor = (messageId: string) =>
  withSystem((db) => db.query<{ provider: string; unit_type: string; quantity: string; wholesale_micros: string; provider_reference: string }>(
    "select provider, unit_type, quantity::int::text as quantity, wholesale_micros::text, provider_reference from metered_usage_events where message_id = $1", [messageId])).then((r) => r.rows);
const email = () => `cust-${crypto.randomBytes(4).toString("hex")}@example.test`;
const mid = () => `<${crypto.randomBytes(6).toString("hex")}@mail.example.test>`;

describe("rates per provider", () => {
  it("refuses a native channel's message while iAcquire has published no rate for that provider, as it does for GoHighLevel", async () => {
    const wa = await messagingOrg({ name: "Unpriced WhatsApp Co", provider: { whatsapp: "meta_whatsapp" }, publishNativeRates: false });
    const c = await inbound(wa.org.id, { provider: "meta_whatsapp", channel: "whatsapp" });
    // GoHighLevel's WhatsApp rate is published; it doesn't price a message Meta carries.
    expect(await queueAi(wa, c.conversationId)).toMatchObject({ status: "blocked", reason: "rate_not_published" });
  });
});

describe("GoHighLevel tenants are unchanged", () => {
  it("send through GoHighLevel at GoHighLevel's rate, addressed by the CRM contact id, and need that id", async () => {
    const c = await inbound(ghl.org.id);
    const before = await withSystem((db) => getBalance(db, ghl.org.id));
    const q = await queueAi(ghl, c.conversationId);
    expect(q.status).toBe("queued");
    expect((await withSystem((db) => getBalance(db, ghl.org.id))).reservedMicros - before.reservedMicros).toBe(client(FIXTURE_RATES.ghl.sms_segment));
    const rec = recordingProvider();
    const twilio = recordingProvider("twilio");
    // A recorder replaces only the transport of its own name: the Twilio one never sees a GoHighLevel workspace's message.
    expect(await dispatchMessage(q.messageId, { provider: rec.provider, transport: twilio.transport })).toEqual({ status: "sent" });
    expect(twilio.calls).toHaveLength(0);
    expect(rec.calls[0]).toMatchObject({ channel: "sms", contactRef: expect.stringMatching(/^ghl_/), to: c.address, fromIdentity: "+15550001111", templateId: null });
    expect(await messageRow(q.messageId)).toMatchObject({ status: "sent", provider: "ghl" });
    const usage = await usageFor(q.messageId);
    expect(usage).toEqual([{ provider: "ghl", unit_type: "sms_segment", quantity: "1", wholesale_micros: String(FIXTURE_RATES.ghl.sms_segment), provider_reference: expect.stringMatching(/^ghl:pm_/) }]);

    // Without the CRM link GoHighLevel can't deliver, so the message is held with the reason.
    const unlinked = await inbound(ghl.org.id, { ghlContactId: null });
    expect(await queueAi(ghl, unlinked.conversationId)).toMatchObject({ status: "blocked", reason: "contact_unreachable" });
  });

  it("keep their channel rows untouched: provider ghl, no native setup", async () => {
    const route = await withSystem((db) => loadChannelTransport(db, ghl.org.id, "sms"));
    expect(route).toMatchObject({ provider: "ghl", enabled: true, sender: { identity: "+15550001111", senderId: null, credentialId: null } });
    expect(route.transport.requiresContactRef).toBe(true);
    const empty = await withSystem((db) => loadChannelTransport(db, crypto.randomUUID(), "email"));
    expect(empty).toMatchObject({ provider: "ghl", enabled: false });
  });
});

describe("native routing", () => {
  it("sends SMS through Twilio to the number itself, at Twilio's rate, with no CRM contact id, and settles usage under Twilio", async () => {
    const c = await inbound(native.org.id, { provider: "twilio" });
    expect((await withSystem((db) => db.query<{ ghl_contact_id: string | null }>("select ghl_contact_id from contacts where id = $1", [c.contactId]))).rows[0].ghl_contact_id).toBeNull();
    const before = await withSystem((db) => getBalance(db, native.org.id));
    const q = await queueAi(native, c.conversationId);
    expect(q.status).toBe("queued");
    expect((await withSystem((db) => getBalance(db, native.org.id))).reservedMicros - before.reservedMicros).toBe(client(FIXTURE_RATES.twilio.sms_segment));
    const ghlRec = recordingProvider();
    const rec = recordingProvider("twilio", (_r, n) => ({ ok: true, providerMessageId: `SM${crypto.randomBytes(16).toString("hex")}`, quantity: n }));
    expect(await dispatchMessage(q.messageId, { provider: ghlRec.provider, transport: rec.transport })).toEqual({ status: "sent" });
    expect(ghlRec.calls).toHaveLength(0);
    const sms = native.channels.sms;
    expect(rec.calls[0]).toMatchObject({
      channel: "sms", to: c.address, requestContactRef: null, messageId: q.messageId,
      sender: { identity: sms.identity, senderId: sms.senderId, accountId: sms.accountId, credentialId: sms.credentialId },
    });
    const row = await messageRow(q.messageId);
    expect(row).toMatchObject({ status: "sent", provider: "twilio", provider_message_id: expect.stringMatching(/^SM/), segments_actual: 1, delivered_at: null });
    const usage = await usageFor(q.messageId);
    expect(usage).toEqual([{ provider: "twilio", unit_type: "sms_segment", quantity: "1", wholesale_micros: String(FIXTURE_RATES.twilio.sms_segment), provider_reference: `twilio:${row.provider_message_id}` }]);
  });

  it("threads email replies (In-Reply-To and References from the conversation) and adds a one-click unsubscribe only to marketing email", async () => {
    const address = email();
    const first = mid();
    const c = await inbound(native.org.id, { provider: "resend", channel: "email", address, subject: "Quote for a deck", threadRef: first });
    const rec = recordingProvider("resend", (_r, n) => ({ ok: true, providerMessageId: crypto.randomUUID(), providerThreadRef: `<out-${n}@send.example.test>` }));
    const reply = await queueAi(native, c.conversationId, "Happy to quote. When suits you?");
    expect(await dispatchMessage(reply.messageId, { transport: rec.transport })).toEqual({ status: "sent" });
    expect(rec.calls[0]).toMatchObject({ channel: "email", to: address, subject: "Quote for a deck", inReplyTo: first, references: [first], unsubscribeUrl: null });
    expect((await messageRow(reply.messageId)).provider_thread_ref).toBe("<out-1@send.example.test>");
    expect((await usageFor(reply.messageId))[0]).toMatchObject({ provider: "resend", unit_type: "email_send", wholesale_micros: String(FIXTURE_RATES.resend.email_send) });

    // The customer answers our reply: it joins the conversation, and our next email answers their latest one.
    const second = mid();
    const back = await withSystem((db) => ingestInbound(db, {
      provider: "resend", channel: "email", toAddress: undefined, orgId: native.org.id, address, body: "Thursday works.", providerMessageId: crypto.randomUUID(),
      threadRef: second, inReplyTo: "<out-1@send.example.test>", references: [first, "<out-1@send.example.test>"],
    }));
    expect(back).toMatchObject({ status: "created", conversationId: c.conversationId });
    await withSystem((db) => recordConsent(db, { orgId: native.org.id, contactId: c.contactId, channel: "email", purpose: "marketing", status: "granted", source: "test", evidence: "Synthetic consent." }));
    const promo = await queueAi(native, c.conversationId, "Our spring offer is on.", { purpose: "marketing" });
    expect(promo.status).toBe("queued");
    await dispatchMessage(promo.messageId, { transport: rec.transport });
    const sent = rec.calls[1];
    expect(sent.inReplyTo).toBe(second);
    expect(sent.references).toEqual([first, "<out-1@send.example.test>", second]);
    expect(sent.unsubscribeUrl).toMatch(/^http:\/\/localhost:3000\/api\/public\/unsubscribe\?t=[A-Za-z0-9_-]+$/);
  });

  it("sends an approved WhatsApp template by name with the parameters read from the message, through Meta", async () => {
    const wa = await messagingOrg({ name: "WhatsApp Native Co", provider: { whatsapp: "meta_whatsapp" } });
    await withSystem((db) => db.query(
      "insert into whatsapp_templates (org_id, template_id, name, language, body, status, provider, category) values ($1, 'visit_reminder', 'visit_reminder', 'en_US', 'Hi {{1}}, your visit is on {{2}}.', 'approved', 'meta_whatsapp', 'utility')",
      [wa.org.id],
    ));
    const c = await inbound(wa.org.id, { provider: "meta_whatsapp", channel: "whatsapp" });
    const rec = recordingProvider("meta_whatsapp");
    // GoHighLevel's approval doesn't count for Meta: the fixture's GoHighLevel template is refused on a Meta channel.
    await expect(sendHumanReply(wa.ctx("owner"), c.conversationId, "Following up", { templateId: "tmpl_followup" })).rejects.toThrow(/not approved/);
    const q = await sendHumanReply(wa.ctx("owner"), c.conversationId, "Hi Ana, your visit is on Friday 3pm.", { templateId: "visit_reminder" });
    expect(await dispatchMessage(q.messageId, { transport: rec.transport })).toEqual({ status: "sent" });
    expect(rec.calls[0].template).toEqual({ name: "visit_reminder", language: "en_US", params: ["Ana", "Friday 3pm"] });
    expect((await usageFor(q.messageId))[0]).toMatchObject({ provider: "meta_whatsapp", unit_type: "whatsapp_message", wholesale_micros: String(FIXTURE_RATES.meta_whatsapp.whatsapp_message) });
  });

  it("suppresses an address the provider refuses because of the address, and names the provider when it must be reconnected", async () => {
    const c = await inbound(native.org.id, { provider: "twilio" });
    const q = await queueAi(native, c.conversationId);
    const optedOut = recordingProvider("twilio", () => ({ ok: false, retryable: false, error: "The recipient opted out with the carrier.", suppress: "opt_out" }));
    expect(await dispatchMessage(q.messageId, { transport: optedOut.transport })).toEqual({ status: "blocked" });
    expect(await messageRow(q.messageId)).toMatchObject({ status: "blocked", blocked_reason: "suppressed" });
    const supp = await withSystem((db) => db.query<{ reason: string; source: string }>("select reason, source from suppressions where org_id = $1 and channel = 'sms' and address = $2 and lifted_at is null", [native.org.id, c.address]));
    expect(supp.rows).toEqual([{ reason: "opt_out", source: "twilio_send" }]);

    const d = await inbound(native.org.id, { provider: "twilio" });
    const q2 = await queueAi(native, d.conversationId);
    const refused = recordingProvider("twilio", () => ({ ok: false, retryable: false, blocked: true, reconnectRequired: true, error: "Twilio refused the stored credential." }));
    expect(await dispatchMessage(q2.messageId, { transport: refused.transport })).toEqual({ status: "blocked" });
    const owner = await withUser(native.people.owner.id, (db) => db.query<{ title: string; link: string }>("select title, link from notifications where kind = 'integration_reconnect_required'"));
    expect(owner.rows).toContainEqual({ title: "Reconnect Twilio to send messages", link: "/settings/messaging" });
    const agency = await withSystem((db) => db.query<{ title: string }>("select title from notifications where kind = 'integration_reconnect_required' and user_id = $1", [native.superAdmin.id]));
    expect(agency.rows.map((r) => r.title)).toContain("Twilio needs reconnecting for a client");
  });
});

describe("delivery events correlated by our message id", () => {
  it("applies a callback that arrives before the send returned, and the send's own result never moves the status back", async () => {
    const c = await inbound(native.org.id, { provider: "twilio" });
    const q = await queueAi(native, c.conversationId);
    const sid = `SM${crypto.randomBytes(16).toString("hex")}`;
    const early: Array<Awaited<ReturnType<typeof applyDeliveryEventForMessage>>> = [];
    const racing: ChannelTransport = {
      name: "twilio", channels: ["sms"], requiresContactRef: false,
      async send(req) {
        // The provider's status callback lands while our call is still in flight (the row is "sending" and has no provider id yet).
        expect((await messageRow(req.messageId)).provider_message_id).toBeNull();
        early.push(await withSystem((db) => applyDeliveryEventForMessage(db, { provider: "twilio", messageId: req.messageId, providerMessageId: sid, providerEventId: `${sid}:delivered`, status: "delivered", rawStatus: "delivered", segments: 2 })));
        return { ok: true, providerMessageId: sid, quantity: 1 };
      },
    };
    expect(await dispatchMessage(q.messageId, { transport: racing })).toEqual({ status: "sent" });
    expect(early).toEqual([{ result: "applied", status: "delivered" }]);
    const row = await messageRow(q.messageId);
    expect(row).toMatchObject({ status: "delivered", provider: "twilio", provider_message_id: sid, segments_actual: 2 });
    expect(row.delivered_at).not.toBeNull();
    expect(row.sent_at).not.toBeNull();
    const events = await withSystem((db) => db.query<{ status: string; raw_status: string }>("select status, raw_status from message_delivery_events where message_id = $1", [q.messageId]));
    expect(events.rows).toEqual([{ status: "delivered", raw_status: "delivered" }]);
    // Idempotent: the same event again changes nothing, by our id or by the provider's.
    expect(await withSystem((db) => applyDeliveryEventForMessage(db, { provider: "twilio", messageId: q.messageId, providerMessageId: sid, providerEventId: `${sid}:delivered`, status: "delivered" }))).toEqual({ result: "duplicate" });
    expect(await withSystem((db) => applyDeliveryEvent(db, { provider: "twilio", providerMessageId: sid, providerEventId: `${sid}:delivered`, status: "delivered" }))).toEqual({ result: "duplicate" });
    // A later read still moves it forward.
    expect(await withSystem((db) => applyDeliveryEvent(db, { provider: "twilio", providerMessageId: sid, providerEventId: `${sid}:read`, status: "read", rawStatus: "read" }))).toEqual({ result: "applied", status: "read" });
  });

  it("keeps a failure reported before the send returned", async () => {
    const c = await inbound(native.org.id, { provider: "twilio" });
    const q = await queueAi(native, c.conversationId);
    const sid = `SM${crypto.randomBytes(16).toString("hex")}`;
    const racing: ChannelTransport = {
      name: "twilio", channels: ["sms"], requiresContactRef: false,
      async send(req) {
        await withSystem((db) => applyDeliveryEventForMessage(db, { provider: "twilio", messageId: req.messageId, providerMessageId: sid, providerEventId: `${sid}:failed`, status: "failed", rawStatus: "failed", detail: "Carrier rejected it." }));
        return { ok: true, providerMessageId: sid };
      },
    };
    await dispatchMessage(q.messageId, { transport: racing });
    expect(await messageRow(q.messageId)).toMatchObject({ status: "failed", status_detail: "Carrier rejected it.", provider_message_id: sid });
  });

  it("refuses events that don't belong to the message: another provider, another workspace, another provider id, or no such message", async () => {
    const c = await inbound(native.org.id, { provider: "twilio" });
    const q = await queueAi(native, c.conversationId);
    const sid = `SM${crypto.randomBytes(16).toString("hex")}`;
    await dispatchMessage(q.messageId, { transport: recordingProvider("twilio", () => ({ ok: true, providerMessageId: sid })).transport });
    const apply = (over: Partial<Parameters<typeof applyDeliveryEventForMessage>[1]>) =>
      withSystem((db) => applyDeliveryEventForMessage(db, { provider: "twilio", messageId: q.messageId, providerEventId: crypto.randomUUID(), status: "delivered", ...over }));
    expect(await apply({ provider: "meta_whatsapp" })).toEqual({ result: "unknown_message" });
    expect(await apply({ orgId: ghl.org.id })).toEqual({ result: "unknown_message" });
    expect(await apply({ providerMessageId: `SM${crypto.randomBytes(16).toString("hex")}` })).toEqual({ result: "unknown_message" });
    expect(await apply({ messageId: crypto.randomUUID() })).toEqual({ result: "unknown_message" });
    expect(await apply({ messageId: "not-a-uuid" })).toEqual({ result: "unknown_message" });
    expect((await messageRow(q.messageId)).status).toBe("sent");
    expect(await apply({ orgId: native.org.id, providerMessageId: sid })).toEqual({ result: "applied", status: "delivered" });
  });
});

describe("a provider switch in progress", () => {
  it("holds messages (they wait, keeping their credit) and sends them once the switch is finished", async () => {
    const org = await messagingOrg({ name: "Switching Co" });
    const c = await inbound(org.org.id);
    const setSwitching = (on: boolean) => withSystem((db) => db.query("insert into crm_workspaces (org_id, switching) values ($1, $2) on conflict (org_id) do update set switching = excluded.switching", [org.org.id, on]));
    await setSwitching(true);
    const at = new Date();
    const q = await queueAi(org, c.conversationId);
    expect(q.status).toBe("queued");
    const row = await messageRow(q.messageId);
    expect(new Date(row.send_after as Date).getTime()).toBeGreaterThanOrEqual(at.getTime() + 9 * 60_000);
    expect(row.reservation_id).not.toBeNull();
    // A person is told to wait rather than the message being dropped.
    await withSystem((db) => db.query("update conversations set owner_kind = 'human', owner_user_id = $2 where id = $1", [c.conversationId, org.people.sales.id]));
    await expect(sendHumanReply(org.ctx("sales"), c.conversationId, "One moment")).rejects.toThrow(/switching providers/);
    await withSystem((db) => db.query("update conversations set owner_kind = 'ai', owner_user_id = null where id = $1", [c.conversationId]));

    const rec = recordingProvider();
    const later = new Date(Date.now() + 11 * 60_000);
    expect(await dispatchMessage(q.messageId, { provider: rec.provider, now: later })).toEqual({ status: "queued" });
    expect(rec.calls).toHaveLength(0);
    expect((await messageRow(q.messageId)).status).toBe("queued");
    await setSwitching(false);
    expect(await dispatchMessage(q.messageId, { provider: rec.provider, now: new Date(Date.now() + 25 * 60_000) })).toEqual({ status: "sent" });
    expect(rec.calls).toHaveLength(1);
  });
});

describe("native inbound", () => {
  it("finds the workspace from the provider's sender id, and ignores a sender no workspace has", async () => {
    const sms = native.channels.sms;
    const address = phone();
    const r = await withSystem((db) => ingestInbound(db, { provider: "twilio", channel: "sms", senderId: sms.senderId, address, body: "Is Saturday open?", providerMessageId: `SM${crypto.randomBytes(16).toString("hex")}` }));
    expect(r.status).toBe("created");
    const conv = await withSystem((db) => db.query<{ org_id: string }>("select org_id from conversations where id = $1", [r.conversationId]));
    expect(conv.rows[0].org_id).toBe(native.org.id);

    const before = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from conversation_messages"));
    const unknown = await withSystem((db) => ingestInbound(db, { provider: "twilio", channel: "sms", senderId: `MG${crypto.randomBytes(16).toString("hex")}`, address, body: "Hello?", providerMessageId: `SM${crypto.randomBytes(16).toString("hex")}` }));
    expect(unknown).toMatchObject({ status: "ignored", reason: "unknown_channel", aiShouldRespond: false });
    // The right sender id under another provider's name, or for another channel, isn't a match either.
    expect((await withSystem((db) => ingestInbound(db, { provider: "meta_whatsapp", channel: "sms", senderId: sms.senderId, address, body: "Hi", providerMessageId: crypto.randomUUID() }))).status).toBe("ignored");
    expect((await withSystem((db) => ingestInbound(db, { provider: "twilio", channel: "whatsapp", senderId: sms.senderId, address, body: "Hi", providerMessageId: crypto.randomUUID() }))).status).toBe("ignored");
    // GoHighLevel tenants are found through their location mapping only.
    expect((await withSystem((db) => ingestInbound(db, { provider: "ghl", channel: "sms", senderId: "+15550001111", address, body: "Hi", providerMessageId: crypto.randomUUID() }))).status).toBe("ignored");
    const after = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from conversation_messages"));
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const match = await withSystem((db) => resolveChannelByProviderSender(db, "twilio", sms.senderId!));
    expect(match).toMatchObject({ orgId: native.org.id, channel: "sms", provider: "twilio", credentialId: sms.credentialId, accountId: sms.accountId });
    expect(Object.keys(match!)).not.toContain("secret");
  });

  it("finds an email workspace by its receiving address, and threads a reply into the conversation it answers, for the same customer only", async () => {
    const inboundAddress = `replies-${crypto.randomBytes(3).toString("hex")}@native.example.test`;
    await withSystem((db) => db.query("update messaging_channels set inbound_address = $2 where org_id = $1 and channel = 'email'", [native.org.id, inboundAddress]));
    expect(await withSystem((db) => resolveChannelByInboundAddress(db, inboundAddress.toUpperCase()))).toMatchObject({ orgId: native.org.id, channel: "email", provider: "resend" });
    expect(await withSystem((db) => resolveChannelByInboundAddress(db, "nobody@native.example.test"))).toBeNull();

    const customer = email();
    const send = (over: Partial<Parameters<typeof ingestInbound>[1]>) =>
      withSystem((db) => ingestInbound(db, { provider: "resend", channel: "email", toAddress: inboundAddress, address: customer, body: "Hello", providerMessageId: crypto.randomUUID(), ...over }));
    const opening = await send({ threadRef: mid(), subject: "Kitchen" });
    expect(opening.status).toBe("created");
    // A second thread with the same customer (a separate quote conversation) holding an earlier email of theirs.
    const quoteRef = mid();
    const quoteConv = await withSystem(async (db) => {
      const conv = await db.query<{ id: string }>("insert into conversations (org_id, contact_id, channel, thread_key, owner_kind, subject) values ($1, $2, 'email', 'quote', 'unassigned', 'Quote') returning id", [native.org.id, opening.contactId]);
      await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, provider, provider_message_id, provider_thread_ref) values ($1, $2, 'inbound', 'contact', 'Quote please', 'received', 'resend', $3, $4)", [native.org.id, conv.rows[0].id, crypto.randomUUID(), quoteRef]);
      return conv.rows[0].id;
    });
    const intoQuote = await send({ inReplyTo: "<unknown-ours@send.example.test>", references: [quoteRef, "<unknown-ours@send.example.test>"], threadRef: mid() });
    expect(intoQuote.conversationId).toBe(quoteConv);
    const plain = await send({ threadRef: mid() });
    expect(plain.conversationId).toBe(opening.conversationId);

    // Someone else quoting this customer's Message-ID can't put their email into this customer's conversation.
    const stranger = await send({ address: email(), references: [quoteRef], threadRef: mid() });
    expect(stranger.status).toBe("created");
    expect([quoteConv, opening.conversationId]).not.toContain(stranger.conversationId);
    // No workspace receives at an unknown address.
    expect((await send({ toAddress: "nobody@native.example.test" })).status).toBe("ignored");
  });
});

describe("channel setup", () => {
  const twilioSecret = { accountSid: `AC${"1".repeat(32)}`, authToken: `tok_${crypto.randomBytes(12).toString("hex")}` };
  const senderId = `MG${crypto.randomBytes(16).toString("hex")}`;
  const passing = (registrationStatus: CapabilityTest["registrationStatus"] = "approved") => {
    const seen: CapabilityTestInput[] = [];
    const test = async (input: CapabilityTestInput): Promise<CapabilityTest> => {
      seen.push(input);
      return { ok: true, checkedAt: new Date().toISOString(), checks: [{ label: "Account", ok: true, detail: "The account is active." }, { label: "Sender", ok: true, detail: "The sender can send SMS." }], registrationStatus };
    };
    return { seen, test };
  };

  it("is for agency super admins only", async () => {
    const org = await messagingOrg({ name: "Setup Rights Co" });
    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    const input = { channel: "sms" as const, provider: "twilio" as const, secret: twilioSecret, senderIdentity: "+15551230001", senderId, accountId: twilioSecret.accountSid, replaceLiveChannel: true };
    await expect(configureNativeChannel(staff, org.org.id, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(configureNativeChannel({ id: org.people.owner.id, platformRole: "none" }, org.org.id, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(enableChannel(staff, org.org.id, "sms")).rejects.toMatchObject({ code: "forbidden" });
    await expect(runChannelCapabilityTest(staff, org.org.id, "sms")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("stores the credential in the vault, never returns it, and switches a native channel on only after a passed test", async () => {
    const org = await messagingOrg({ name: "Setup Co" });
    const input = { channel: "sms" as const, provider: "twilio" as const, secret: twilioSecret, senderIdentity: "+1 555 123 0002", senderId, accountId: twilioSecret.accountSid };
    // SMS is live through GoHighLevel: moving it has to be confirmed.
    await expect(configureNativeChannel(org.superAdmin, org.org.id, input)).rejects.toThrow(/live through GoHighLevel/);
    await expect(configureNativeChannel(org.superAdmin, org.org.id, { ...input, senderId: "nonsense", replaceLiveChannel: true })).rejects.toThrow(/Messaging Service SID/);
    await expect(configureNativeChannel(org.superAdmin, org.org.id, { ...input, provider: "resend" as never, replaceLiveChannel: true })).rejects.toThrow(/can't be sent through Resend/);
    const configured = await configureNativeChannel(org.superAdmin, org.org.id, { ...input, replaceLiveChannel: true });
    expect(configured).toMatchObject({ channel: "sms", provider: "twilio", providerLabel: "Twilio", enabled: false, senderIdentity: "+15551230002", senderId, credentialStored: true, ready: false, testedAt: null, sendingAllowedHere: false });
    expect(configured.readinessIssues.join(" ")).toMatch(/test hasn't passed/);

    // The database refuses an untested native channel even if the application were bypassed.
    await expect(withSystem((db) => db.query("update messaging_channels set enabled = true, sender_verified_at = now(), registration_status = 'approved' where org_id = $1 and channel = 'sms'", [org.org.id]))).rejects.toThrow();
    await expect(enableChannel(org.superAdmin, org.org.id, "sms")).rejects.toThrow(/can't be switched on yet.*test hasn't passed/);

    // A failed test is recorded, and nothing it would have unlocked changes.
    const failed = await runChannelCapabilityTest(org.superAdmin, org.org.id, "sms", {
      test: async () => ({ ok: false, checkedAt: new Date().toISOString(), checks: [{ label: "Account", ok: false, detail: "Twilio refused the auth token." }] }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.status).toMatchObject({ testedAt: null, senderVerifiedAt: null, ready: false, lastTest: { ok: false, checks: [{ label: "Account", ok: false }] } });
    expect(failed.status.detail).toMatch(/Twilio refused the auth token/);

    const { seen, test } = passing();
    const passed = await runChannelCapabilityTest(org.superAdmin, org.org.id, "sms", { test });
    expect(passed.ok).toBe(true);
    // The test got the stored secret, resolved from the vault for that one call.
    expect(parseCredentialSecret(seen[0].secret, ["accountSid", "authToken"])).toEqual(twilioSecret);
    expect(seen[0]).toMatchObject({ channel: "sms", senderId, accountId: twilioSecret.accountSid, senderIdentity: "+15551230002" });
    expect(passed.status).toMatchObject({ registrationStatus: "approved", ready: true, lastTest: { ok: true } });
    expect(passed.status.testedAt).not.toBeNull();
    const on = await enableChannel(org.superAdmin, org.org.id, "sms");
    expect(on.enabled).toBe(true);

    // A pending carrier registration keeps an SMS channel off even after a passed test.
    const wa = await messagingOrg({ name: "Pending Reg Co" });
    await configureNativeChannel(wa.superAdmin, wa.org.id, { ...input, senderId: `MG${crypto.randomBytes(16).toString("hex")}`, replaceLiveChannel: true });
    await runChannelCapabilityTest(wa.superAdmin, wa.org.id, "sms", { test: passing("pending").test });
    await expect(enableChannel(wa.superAdmin, wa.org.id, "sms")).rejects.toThrow(/registration is still pending/);

    // Nothing anyone can read holds the secret: statuses, audit records, channel rows.
    const everything = JSON.stringify([
      configured, failed, passed, on, await listChannelStatus(org.org.id),
      (await withSystem((db) => db.query("select * from audit_logs where org_id = $1", [org.org.id]))).rows,
      (await withSystem((db) => db.query("select * from messaging_channels where org_id = $1", [org.org.id]))).rows,
      (await withSystem((db) => db.query("select * from integration_credentials where org_id = $1", [org.org.id]))).rows,
    ]);
    expect(everything).not.toContain(twilioSecret.authToken);
    const actions = (await withSystem((db) => db.query<{ action: string }>("select action from audit_logs where org_id = $1 and target_type in ('messaging_channel', 'integration') order by created_at", [org.org.id]))).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["credential.saved", "messaging.channel_configured", "messaging.channel_tested", "messaging.channel_enabled"]));

    // The same sender can't be connected to a second workspace.
    const other = await messagingOrg({ name: "Copycat Co" });
    await expect(configureNativeChannel(other.superAdmin, other.org.id, { ...input, replaceLiveChannel: true })).rejects.toThrow(/already connected to another workspace/);
  });

  it("lets a client's owner switch a native channel off but not on, and keeps attestation for GoHighLevel senders", async () => {
    await expect(setChannelEnabled(native.ctx("owner"), "sms", true)).rejects.toThrow(/iAcquire team/);
    await setChannelEnabled(native.ctx("owner"), "sms", false);
    expect((await listChannelStatus(native.org.id)).find((s) => s.channel === "sms")!.enabled).toBe(false);
    await enableChannel(native.superAdmin, native.org.id, "sms");
    await expect(attestChannelSender(native.superAdmin, { orgId: native.org.id, channel: "sms", senderIdentity: "+15550009999", registrationStatus: "approved", verified: true, evidence: "Checked in the console." }))
      .rejects.toThrow(/Run its channel test instead/);
    // The client's own settings show who carries each channel.
    const { getMessagingSettings } = await import("@/server/messaging/inbox");
    const settings = await getMessagingSettings(native.ctx("owner"));
    expect(settings.channels.find((c) => c.channel === "sms")).toMatchObject({ provider: "twilio", providerLabel: "Twilio", enabled: true });
    expect(settings.channels.find((c) => c.channel === "whatsapp")).toMatchObject({ provider: "ghl", providerLabel: "GoHighLevel" });
  });

  it("moves a channel back to GoHighLevel, revoking the native credential and leaving it off until its sender is verified again", async () => {
    const org = await messagingOrg({ name: "Back To GHL Co", provider: { email: "resend" } });
    await disableChannel(org.superAdmin, org.org.id, "email");
    const back = await switchChannelToGhl(org.superAdmin, org.org.id, "email");
    expect(back).toMatchObject({ provider: "ghl", enabled: false, credentialStored: false, senderId: null, testedAt: null });
    const cred = await withSystem((db) => db.query<{ revoked_at: Date | null }>("select revoked_at from integration_credentials where id = $1", [org.channels.email.credentialId]));
    expect(cred.rows[0].revoked_at).not.toBeNull();
    await expect(switchChannelToGhl(org.superAdmin, org.org.id, "email")).rejects.toThrow(/already uses GoHighLevel/);
  });
});

describe("transports", () => {
  it("each native transport's kill switch is off by default and stops the send before any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const req = (channel: TransportSendRequest["channel"], to: string): TransportSendRequest => ({
      orgId: native.org.id, channel, messageId: crypto.randomUUID(), to, contactRef: null, body: "Hello", sender: { identity: "x", senderId: "y", accountId: null, credentialId: crypto.randomUUID() },
    });
    for (const [name, channel, to] of [["resend", "email", "a@example.test"], ["twilio", "sms", "+15551234567"], ["meta_whatsapp", "whatsapp", "+15551234567"]] as const) {
      expect(transportWritesEnabled(name)).toBe(false);
      const t = transportFor(name);
      expect(t).toMatchObject({ name, channels: [channel], requiresContactRef: false });
      expect(await t.send(req(channel, to))).toMatchObject({ ok: false, blocked: true, retryable: false });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(transportFor("ghl")).toMatchObject({ name: "ghl", requiresContactRef: true });
  });

  it("stores several credential parts as one secret and reads them back, refusing anything malformed", () => {
    const secret = encodeCredentialSecret({ authToken: " abc ", accountSid: "AC1" });
    expect(secret).toBe('{"accountSid":"AC1","authToken":"abc"}');
    expect(parseCredentialSecret(secret, ["accountSid", "authToken"])).toEqual({ accountSid: "AC1", authToken: "abc" });
    expect(parseCredentialSecret(secret, ["accountSid", "apiKey"])).toBeNull();
    expect(parseCredentialSecret("not json", ["accountSid"])).toBeNull();
    expect(() => encodeCredentialSecret({ accountSid: "" })).toThrow();
    expect(() => encodeCredentialSecret({ "bad key": "x" })).toThrow();
  });

  it("reads WhatsApp template parameters back from the message, and sends none when it doesn't follow the template", () => {
    expect(whatsappTemplateParams("Hi {{1}}, your visit is on {{2}}.", "Hi Ana, your visit is on Friday 3pm.")).toEqual(["Ana", "Friday 3pm"]);
    expect(whatsappTemplateParams("Your code is {{1}}. Hi {{1}}!", "Your code is 42. Hi 42!")).toEqual(["42"]);
    expect(whatsappTemplateParams("Your code is {{1}}. Hi {{1}}!", "Your code is 42. Hi 43!")).toEqual([]);
    expect(whatsappTemplateParams("Thanks for booking.", "Thanks for booking.")).toEqual([]);
    expect(whatsappTemplateParams("Hi {{1}}, see you {{2}}.", "Something else entirely")).toEqual([]);
    expect(whatsappTemplateParams("Hi {{2}}", "Hi Ana")).toEqual([]);
    expect(whatsappTemplateParams("Hi {{1}}  (price: $5)", "Hi Ana (price: $5)")).toEqual(["Ana"]);
  });
});

describe("a customer's booking link is never shown or exported", () => {
  const link = "http://localhost:3000/book/manage/AbCdEfGhIjKlMnOpQrStUvWxYz012345";

  it("never sends the raw placeholder from a message that isn't a reminder, and stores none of it differently", async () => {
    const c = await inbound(ghl.org.id);
    const body = "Thanks for booking. You can change it here: {{appointment.manage_link}}";
    const q = await queueAi(ghl, c.conversationId, body);
    const rec = recordingProvider();
    expect(await dispatchMessage(q.messageId, { provider: rec.provider })).toEqual({ status: "sent" });
    expect(rec.calls[0].body).toBe("Thanks for booking.");
    expect((await messageRow(q.messageId)).body).toBe(body);
    expect((await withSystem((db) => db.query("select 1 from crm_appointment_links l join conversation_messages m on m.id = $1 where l.org_id = m.org_id", [q.messageId]))).rows).toHaveLength(0);
  });

  it("masks old links and the placeholder; fills or drops the placeholder only for sending", () => {
    expect(maskCustomerLinks(`To reschedule or cancel: ${link}`)).toBe(`To reschedule or cancel: ${CUSTOMER_LINK_LABEL}`);
    expect(maskCustomerLinks("See /book/manage/abc%2Ddef_123 and https://x.example/book/manage/Zz9-_")).toBe(`See ${CUSTOMER_LINK_LABEL} and ${CUSTOMER_LINK_LABEL}`);
    expect(maskCustomerLinks("Reply: {{ appointment.manage_link }}")).toBe(`Reply: ${CUSTOMER_LINK_LABEL}`);
    expect(maskCustomerLinks("Book at https://x.example/book/clinic/visits")).toBe("Book at https://x.example/book/clinic/visits");
    expect(maskCustomerLinks(null)).toBeNull();
    expect(fillManageLink("Hi. Change it: {{appointment.manage_link}}", link)).toBe(`Hi. Change it: ${link}`);
    expect(fillManageLink("Hi Ana, see you at 3. To reschedule or cancel: {{appointment.manage_link}}", null)).toBe("Hi Ana, see you at 3.");
    expect(fillManageLink("Hi Ana.\nManage: {{appointment.manage_link}}\nThanks!", null)).toBe("Hi Ana.\nThanks!");
    expect(fillManageLink("No placeholder here.", null)).toBe("No placeholder here.");
  });

  it("in the inbox, the conversation list, the contact timeline and the data export", async () => {
    const org = await messagingOrg({ name: "Old Link Co" });
    const c = await inbound(org.org.id, { name: "Lina Legacy" });
    await withSystem(async (db) => {
      await db.query(
        "insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope) values ($1, $2, 'outbound', 'ai', $3, 'sent', 'reminder')",
        [org.org.id, c.conversationId, `A reminder from Old Link Co. To reschedule or cancel: ${link}`],
      );
      await db.query("update conversations set last_message_preview = $2 where id = $1", [c.conversationId, `To reschedule or cancel: ${link}`]);
    });
    const detail = await getConversationDetail(org.ctx("owner"), c.conversationId);
    const shown = JSON.stringify(detail);
    expect(shown).not.toContain("/book/manage/");
    expect(shown).toContain(CUSTOMER_LINK_LABEL);
    const list = await listConversations(org.ctx("owner"));
    expect(list.find((x) => x.id === c.conversationId)!.preview).toBe(`To reschedule or cancel: ${CUSTOMER_LINK_LABEL}`);
    const timeline = await getTimeline(memberActor(org.ctx("owner")), { contactId: c.contactId });
    expect(JSON.stringify(timeline)).not.toContain("/book/manage/");
    const files = readZip((await buildExport(org.org.id)).bytes);
    const exported = files.filter((f) => f.name.startsWith("conversations/")).map((f) => f.data.toString("utf8")).join("\n");
    expect(exported).not.toContain("/book/manage/");
    expect(exported).toContain(CUSTOMER_LINK_LABEL);
  });
});
