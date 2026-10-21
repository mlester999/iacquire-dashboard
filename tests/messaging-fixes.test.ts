// Regression tests for the Native CRM Phase 3 (communications) review findings. Each describe names the finding it guards. Synthetic
// workspaces, an in-memory database and in-memory transports only: nothing contacts a provider and no message leaves the machine.
import crypto from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { expireStaleReservations } from "@/server/billing/ledger";
import { getConsent, isSuppressed, recordConsent } from "@/server/messaging/contacts";
import { applyDeliveryEvent, applyDeliveryEventForMessage, dispatchDue, dispatchMessage, queueOutbound, templateFit } from "@/server/messaging/send";
import { sendHumanReply } from "@/server/messaging/inbox";
import { configureNativeChannel, disableChannel, enableChannel, listChannelStatus, runChannelCapabilityTest, switchChannelToGhl } from "@/server/messaging/channels";
import { memberActor } from "@/server/crm/actor";
import {
  addTestDestination, approveTemplate, createTemplate, getCommunicationSettings, listWhatsappTemplates, sendableWhatsappTemplates, testSendTemplate, type WhatsappTemplateView,
} from "@/server/crm/message-templates";
import type { CapabilityTest, ChannelTransport } from "@/server/messaging/transports/types";
import type { MessagingSettingsView } from "@/server/messaging/inbox";
import { validateTemplate } from "@/lib/messaging/tokens";
import {
  AgencyChannelSetup, liveChannelWarning, RESEND_ACCOUNT_NOTE, setupKeepsState, setupSignature, shownTestResult, type SetupForm, type TestRun,
} from "@/components/crm/communications/agency-channel-setup";
import { WhatsappTemplates, whatsappTemplateState, whatsappTemplateWhyNot } from "@/components/crm/templates/whatsapp-templates";
import { checksSummary, pickFocusGuard, ValidationList } from "@/components/crm/templates/parts";
import { InboxWorkspace, whatsappTemplateDraft, type InboxDetail } from "@/components/inbox/inbox-workspace";
import { MessagingSettings } from "@/components/settings/messaging-settings";
import { inbound, messageRow, messagingOrg, phone, recordingProvider, type MessagingOrg } from "./support/messaging";

// Screens render on the server here: router and server actions are stand-ins that are never called.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-communications", () => Object.fromEntries([
  "addTestDestinationAction", "removeTestDestinationAction", "requestChannelSetupAction", "configureChannelAction", "runChannelTestAction", "setChannelOnAction", "switchChannelToGhlAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/inbox", () => Object.fromEntries([
  "addMemoryAction", "addNoteAction", "approveDraftAction", "assignConversationAction", "claimEscalationAction", "declineEscalationAction", "deleteMemoryAction", "discardDraftAction",
  "markReadAction", "resolveEscalationAction", "resumeAiAction", "sendReplyAction", "setConversationStateAction", "takeOverAction", "setChannelEnabledAction", "updateMessagingSettingsAction",
].map((n) => [n, stub])));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const HOUR = 3600_000;
const queueAi = (org: MessagingOrg, conversationId: string, body = "Thanks for reaching out. We have room on Thursday.") =>
  withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body }));
const reservation = (id: unknown) =>
  withSystem((db) => db.query<{ status: string; expires_at: Date }>("select status, expires_at from usage_reservations where id = $1", [id])).then((r) => r.rows[0]);
const usageFor = (messageId: string) =>
  withSystem((db) => db.query<{ provider_reference: string; reservation_id: string | null }>("select provider_reference, reservation_id from metered_usage_events where message_id = $1", [messageId])).then((r) => r.rows);
const sid = () => `SM${crypto.randomBytes(16).toString("hex")}`;
const twilioTransport = (send: ChannelTransport["send"]): ChannelTransport => ({ name: "twilio", channels: ["sms"], requiresContactRef: false, send });
const unescape = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** The outer HTML of the first element whose start tag contains `marker`, balanced on its own tag name. */
function elementHtml(html: string, marker: string): string {
  const at = html.indexOf(marker);
  const start = html.lastIndexOf("<", at);
  const tag = /^<([a-z0-9]+)/i.exec(html.slice(start))![1];
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

let native: MessagingOrg;
beforeAll(async () => {
  native = await messagingOrg({ name: "Fixes Native Co", provider: { sms: "twilio", email: "resend" } });
});

// ---------------------------------------------------------------------------
// 1. Keywords never lift a bounce, complaint or a person's do-not-contact entry
// ---------------------------------------------------------------------------

describe("finding 1: opt-in keywords", () => {
  it("START lifts the customer's own opt-out, but never a manual, complaint or bounce suppression", async () => {
    for (const [reason, lifted] of [["opt_out", true], ["invalid", true], ["manual", false], ["complaint", false], ["bounce", false]] as const) {
      const address = phone();
      await withSystem((db) => db.query("insert into suppressions (org_id, channel, address, reason, source) values ($1, 'sms', $2, $3, 'test')", [native.org.id, address, reason]));
      const r = await inbound(native.org.id, { provider: "twilio", ghlContactId: null, address, body: "START" });
      expect(r.optOut, reason).toBe("start");
      expect(await withSystem((db) => isSuppressed(db, native.org.id, "sms", address)), reason).toBe(!lifted);
    }
  });

  it("an unproven sender changes no consent or suppression and gets no automatic reply, whatever it says", async () => {
    const address = `forged.${crypto.randomBytes(4).toString("hex")}@example.com`;
    for (const body of ["Hello, are you open?", "STOP", "START"]) {
      const r = await inbound(native.org.id, { provider: "resend", channel: "email", ghlContactId: null, address, body, senderVerified: false });
      expect(r).toMatchObject({ status: "created", optOut: null, aiShouldRespond: false });
      expect(await withSystem((db) => getConsent(db, native.org.id, r.contactId!, "email", "service"))).toBe("unknown");
      expect(await withSystem((db) => isSuppressed(db, native.org.id, "email", address))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. A test send never reaches a customer who holds the approved address as a second identity
// ---------------------------------------------------------------------------

describe("finding 2: test send destinations", () => {
  afterAll(() => {
    delete process.env.TWILIO_WRITES_ENABLED;
    resetEnvCache();
  });

  it("refuses an approved destination that is only a second address on a customer's record, and records nothing on it", async () => {
    process.env.TWILIO_WRITES_ENABLED = "true";
    resetEnvCache();
    const org = await messagingOrg({ name: "Test Dest Co", provider: { sms: "twilio" } });
    const owner = memberActor(org.ctx("owner"));
    const main = phone();
    const shared = phone();
    const customer = await withSystem(async (db) => {
      const c = (await db.query<{ id: string }>("insert into contacts (org_id, display_name, phone) values ($1, 'Real Customer', $2) returning id", [org.org.id, main])).rows[0].id;
      await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified, verified_via, created_at) values ($1, $2, 'phone', $3, true, 'provider_inbound', now() - interval '1 day')", [org.org.id, c, main]);
      await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified) values ($1, $2, 'phone', $3, false)", [org.org.id, c, shared]);
      return c;
    });
    await addTestDestination(owner, { channel: "sms", address: shared, label: "Owner phone", confirmOwnAddress: true });
    const t = await createTemplate(owner, { name: "Test me", channel: "sms", body: "Hello from {{business.name}}." });
    const out = await testSendTemplate(owner, t.id, { destination: shared });
    expect(out).toMatchObject({ ok: false, reason: "destination_not_approved", detail: expect.stringContaining("customer's record") });
    expect(await withSystem((db) => getConsent(db, org.org.id, customer, "sms", "service"))).toBe("unknown");
    const sent = await withSystem((db) => db.query("select 1 from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = $1", [customer]));
    expect(sent.rows).toHaveLength(0);

    // A destination that is its own contact's main address is sent to exactly that address.
    const own = phone();
    await addTestDestination(owner, { channel: "sms", address: own, confirmOwnAddress: true });
    const ok = await testSendTemplate(owner, t.id, { destination: own });
    expect(ok).toMatchObject({ ok: true, to: own });
    const rec = recordingProvider("twilio");
    expect(await dispatchMessage(ok.ok ? ok.messageId : "", { transport: rec.transport })).toEqual({ status: "sent" });
    expect(rec.calls.map((c) => c.to)).toEqual([own]);
  });
});

// ---------------------------------------------------------------------------
// 3, 6, 11. WhatsApp templates on Meta: exact wording, marketing consent, the current provider's templates only
// ---------------------------------------------------------------------------

describe("WhatsApp templates on Meta", () => {
  let wa: MessagingOrg;
  beforeAll(async () => {
    wa = await messagingOrg({ name: "Fixes WA Co", provider: { whatsapp: "meta_whatsapp" } });
    await withSystem((db) =>
      db.query(
        `insert into whatsapp_templates (org_id, template_id, name, language, body, status, provider, category, variables) values
           ($1, '900777', 'spring_promo', 'en_US', 'Spring sale! 20% off every service this week. Book now.', 'approved', 'meta_whatsapp', 'marketing', '[]'::jsonb),
           ($1, '900778', 'car_ready', 'en_US', 'Hi {{1}}, your car is ready. The total is {{2}}.', 'approved', 'meta_whatsapp', 'utility', '[{"position":1,"label":"Name"},{"position":2,"label":"Total"}]'::jsonb),
           ($1, '900779', 'pickup_reminder', 'en_US', 'Your car is ready for pickup today.', 'approved', 'meta_whatsapp', 'utility', '[]'::jsonb)`,
        [wa.org.id],
      ),
    );
  });
  /** A WhatsApp conversation whose 24-hour window closed two days ago. */
  const closedWindow = () => inbound(wa.org.id, { provider: "meta_whatsapp", channel: "whatsapp", ghlContactId: null, receivedAt: new Date(Date.now() - 2 * 24 * HOUR) });

  describe("finding 3: the inbox records exactly what the customer receives", () => {
    it("refuses typed text that isn't the template's fixed wording, and sends it when it is", async () => {
      const c = await closedWindow();
      await expect(sendHumanReply(wa.ctx("owner"), c.conversationId, "Your car is ready for pickup. The total is $420.", { templateId: "900779" })).rejects.toThrow(/fixed wording/);
      const q = await sendHumanReply(wa.ctx("owner"), c.conversationId, "Your car is ready  for pickup today. ", { templateId: "900779" });
      expect(q.status).toBe("queued");
      const rec = recordingProvider("meta_whatsapp");
      expect(await dispatchMessage(q.messageId, { transport: rec.transport })).toEqual({ status: "sent" });
      expect(rec.calls[0].template).toEqual({ name: "pickup_reminder", language: "en_US", params: [] });
      expect((await messageRow(q.messageId)).body).toBe("Your car is ready  for pickup today.");
    });

    it("needs every value of a template with placeholders, and passes them in order", async () => {
      const c = await closedWindow();
      await expect(sendHumanReply(wa.ctx("owner"), c.conversationId, "Your car is ready.", { templateId: "900778" })).rejects.toThrow(/doesn't follow the template/);
      await expect(sendHumanReply(wa.ctx("owner"), c.conversationId, "Hi {{1}}, your car is ready. The total is $420.", { templateId: "900778" })).rejects.toThrow(/Replace every/);
      const q = await sendHumanReply(wa.ctx("owner"), c.conversationId, "Hi Ana, your car is ready. The total is $420.", { templateId: "900778" });
      const rec = recordingProvider("meta_whatsapp");
      expect(await dispatchMessage(q.messageId, { transport: rec.transport })).toEqual({ status: "sent" });
      expect(rec.calls[0].template).toMatchObject({ name: "car_ready", params: ["Ana", "$420"] });
    });

    it("holds an AI message that doesn't fit its template visibly, and checks again before sending", async () => {
      const c = await closedWindow();
      const q = await withSystem((db) => queueOutbound(db, { orgId: wa.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: wa.salesAgentId }, body: "Hello again!", templateId: "900779" }));
      expect(q).toMatchObject({ status: "blocked", reason: "template_mismatch" });
      expect(templateFit({ name: "t", body: "Hi {{1}}", variableCount: 1 }, "Hi Ana")).toEqual({ ok: true, params: ["Ana"] });
      expect(templateFit({ name: "t", body: "Hi there", variableCount: 0 }, "Hi there!").ok).toBe(false);
    });

    it("refuses approving a CRM template linked to a Meta template whose wording it doesn't follow", async () => {
      const owner = memberActor(wa.ctx("owner"));
      const off = await createTemplate(owner, { name: "Car ready (own words)", channel: "whatsapp", body: "Good news {{contact.first_name}}: your car is done!", whatsappTemplateId: "900778" });
      await expect(approveTemplate(owner, off.id, { version: 1, contentHash: off.contentHash })).rejects.toThrow(/WhatsApp would deliver the linked template's wording/);
      const fits = await createTemplate(owner, { name: "Car ready (Meta wording)", channel: "whatsapp", body: "Hi {{contact.first_name}}, your car is ready. The total is $420.", whatsappTemplateId: "900778" });
      expect((await approveTemplate(owner, fits.id, { version: 1, contentHash: fits.contentHash })).status).toBe("approved");
    });

    it("puts the template's approved wording in the composer when one is picked", () => {
      expect(whatsappTemplateDraft("Hi {{1}}, your car is ready. The total is {{2}}.")).toEqual({ text: "Hi {{1}}, your car is ready. The total is {{2}}.", holes: ["{{1}}", "{{2}}"] });
      expect(whatsappTemplateDraft("Your car is ready for pickup today.").holes).toEqual([]);
    });
  });

  describe("finding 6: marketing templates need marketing consent", () => {
    it("refuses a MARKETING template to a customer without marketing consent, and records the message as marketing otherwise", async () => {
      const promo = "Spring sale! 20% off every service this week. Book now.";
      const c = await closedWindow();
      await withSystem((db) => recordConsent(db, { orgId: wa.org.id, contactId: c.contactId!, channel: "whatsapp", purpose: "marketing", status: "revoked", source: "provider_opt_out", evidence: "test" }));
      await expect(sendHumanReply(wa.ctx("owner"), c.conversationId, promo, { templateId: "900777" })).rejects.toThrow(/withdrew consent/);
      // Service consent alone (the customer wrote in) isn't enough either.
      const d = await closedWindow();
      await expect(sendHumanReply(wa.ctx("owner"), d.conversationId, promo, { templateId: "900777" })).rejects.toThrow(/marketing template/);
      await withSystem((db) => recordConsent(db, { orgId: wa.org.id, contactId: d.contactId!, channel: "whatsapp", purpose: "marketing", status: "granted", source: "form", evidence: "test" }));
      const q = await sendHumanReply(wa.ctx("owner"), d.conversationId, promo, { templateId: "900777" });
      expect(q.status).toBe("queued");
      expect((await messageRow(q.messageId)).purpose).toBe("marketing");
      // Revoked after it was queued: the check before sending refuses it.
      await withSystem((db) => recordConsent(db, { orgId: wa.org.id, contactId: d.contactId!, channel: "whatsapp", purpose: "marketing", status: "revoked", source: "provider_opt_out", evidence: "test" }));
      const rec = recordingProvider("meta_whatsapp");
      expect(await dispatchMessage(q.messageId, { transport: rec.transport })).toEqual({ status: "blocked" });
      expect(rec.calls).toHaveLength(0);
    });
  });

  describe("finding 11: only the current provider's templates", () => {
    it("never offers, links or approves a GoHighLevel template once WhatsApp sends through Meta", async () => {
      // messagingOrg leaves GoHighLevel-approved rows behind ('tmpl_followup'), as a workspace moved from GoHighLevel has.
      const offered = await withSystem((db) => sendableWhatsappTemplates(db, wa.org.id));
      expect(offered.map((t) => t.id).sort()).toEqual(["900777", "900778", "900779"]);
      const owner = memberActor(wa.ctx("owner"));
      await expect(createTemplate(owner, { name: "Old GHL link", channel: "whatsapp", body: "Follow up", whatsappTemplateId: "tmpl_followup" })).rejects.toThrow(/belongs to GoHighLevel/);
      const t = await createTemplate(owner, { name: "Linked before the switch", channel: "whatsapp", body: "Follow up" });
      await withSystem((db) => db.query("update crm_message_templates set whatsapp_template_id = 'tmpl_followup' where id = $1", [t.id]));
      await expect(approveTemplate(owner, t.id, { version: 1, contentHash: t.contentHash })).rejects.toThrow(/isn't one of WhatsApp Business \(Meta\)'s templates/);
      const listed = await listWhatsappTemplates(owner);
      expect(listed.find((x) => x.templateId === "tmpl_followup")).toMatchObject({ provider: "ghl", usable: false });
      expect(listed.find((x) => x.templateId === "900779")).toMatchObject({ usable: true });
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Credit holds that lapse while a message waits
// ---------------------------------------------------------------------------

describe("finding 4: credit holds and waits", () => {
  it("takes a fresh hold for a message whose hold expired while it waited, sends it once and records it as sent", async () => {
    const c = await inbound(native.org.id, { provider: "twilio", ghlContactId: null });
    const q = await queueAi(native, c.conversationId);
    const first = (await messageRow(q.messageId)).reservation_id;
    await withSystem((db) => db.query("update usage_reservations set expires_at = now() - interval '1 minute' where id = $1", [first]));
    await withSystem((db) => expireStaleReservations(db));
    expect((await reservation(first)).status).toBe("expired");
    const rec = recordingProvider("twilio");
    expect(await dispatchMessage(q.messageId, { transport: rec.transport })).toEqual({ status: "sent" });
    expect(rec.calls).toHaveLength(1);
    const row = await messageRow(q.messageId);
    expect(row).toMatchObject({ status: "sent" });
    expect(row.provider_message_id).toBeTruthy();
    expect(row.reservation_id).not.toBe(first);
    expect((await reservation(row.reservation_id)).status).toBe("settled");
    expect(await usageFor(q.messageId)).toHaveLength(1);
  });

  it("charges a send the provider accepted even when its hold lapsed during the call", async () => {
    const c = await inbound(native.org.id, { provider: "twilio", ghlContactId: null });
    const q = await queueAi(native, c.conversationId);
    const id = sid();
    const lapsing = twilioTransport(async (req) => {
      await withSystem(async (db) => {
        await db.query("update usage_reservations set expires_at = now() - interval '1 minute' where id = (select reservation_id from conversation_messages where id = $1)", [req.messageId]);
        await expireStaleReservations(db);
      });
      return { ok: true, providerMessageId: id };
    });
    expect(await dispatchMessage(q.messageId, { transport: lapsing })).toEqual({ status: "sent" });
    expect(await messageRow(q.messageId)).toMatchObject({ status: "sent", provider_message_id: id });
    expect(await usageFor(q.messageId)).toEqual([{ provider_reference: `twilio:${id}`, reservation_id: null }]);
  });

  it("sizes the hold to cover the wait, and extends it each time the message waits again", async () => {
    const org = await messagingOrg({ name: "Long Wait Co", provider: { sms: "twilio" } });
    const c = await inbound(org.org.id, { provider: "twilio", ghlContactId: null });
    const setSwitching = (on: boolean) => withSystem((db) => db.query("insert into crm_workspaces (org_id, switching) values ($1, $2) on conflict (org_id) do update set switching = excluded.switching", [org.org.id, on]));
    await setSwitching(true);
    const q = await queueAi(org, c.conversationId);
    expect(q.status).toBe("queued");
    const covers = async () => {
      const row = await messageRow(q.messageId);
      const hold = await reservation(row.reservation_id);
      return new Date(hold.expires_at).getTime() - (new Date(row.send_after as Date).getTime() + 6 * HOUR);
    };
    expect(await covers()).toBeGreaterThan(-5_000);
    const rec = recordingProvider("twilio");
    expect(await dispatchMessage(q.messageId, { transport: rec.transport, now: new Date(Date.now() + 5 * HOUR) })).toEqual({ status: "queued" });
    expect(await covers()).toBeGreaterThan(-5_000);
    await setSwitching(false);
  });

  it("one message whose result can't be recorded doesn't stop the rest of the batch", async () => {
    const org = await messagingOrg({ name: "Batch Co", provider: { sms: "twilio" } });
    const taken = sid();
    const a = await inbound(org.org.id, { provider: "twilio", ghlContactId: null });
    const b = await inbound(org.org.id, { provider: "twilio", ghlContactId: null });
    const before = await queueAi(org, a.conversationId, "Already sent earlier.");
    expect(await dispatchMessage(before.messageId, { transport: twilioTransport(async () => ({ ok: true, providerMessageId: taken })) })).toEqual({ status: "sent" });
    const qa = await queueAi(org, a.conversationId, "First in the batch.");
    const qb = await queueAi(org, b.conversationId, "Second in the batch.");
    await withSystem((db) => db.query("update conversation_messages set send_after = now() - interval '1 minute' where id = $1", [qa.messageId]));
    // The provider answers the first with an id another message already holds, so recording it fails.
    const t = twilioTransport(async (req) => ({ ok: true, providerMessageId: req.messageId === qa.messageId ? taken : sid() }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(dispatchDue({ transport: t })).resolves.toMatchObject({ attempted: expect.any(Number) });
    expect((await messageRow(qb.messageId)).status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// 5. A callback that raced ahead of an unconfirmed send result
// ---------------------------------------------------------------------------

describe("finding 5: early callbacks", () => {
  it("keeps a delivery the provider already confirmed when the send call then times out, and bills it", async () => {
    const c = await inbound(native.org.id, { provider: "twilio", ghlContactId: null });
    const q = await queueAi(native, c.conversationId);
    const id = sid();
    const racing = twilioTransport(async (req) => {
      await withSystem((db) => applyDeliveryEventForMessage(db, { provider: "twilio", messageId: req.messageId, providerMessageId: id, providerEventId: `${id}:delivered`, status: "delivered", rawStatus: "delivered" }));
      return { ok: false, retryable: false, error: "Twilio could not be reached. The message was not confirmed sent." };
    });
    expect(await dispatchMessage(q.messageId, { transport: racing })).toEqual({ status: "delivered" });
    const row = await messageRow(q.messageId);
    expect(row).toMatchObject({ status: "delivered", provider_message_id: id, failed_at: null });
    expect(row.sent_at).not.toBeNull();
    expect((await reservation(row.reservation_id)).status).toBe("settled");
    expect(await usageFor(q.messageId)).toEqual([{ provider_reference: `twilio:${id}`, reservation_id: row.reservation_id }]);
    const failedNote = await withSystem((db) => db.query("select 1 from notifications where dedupe_key = $1", [`failed:${q.messageId}`]));
    expect(failedNote.rows).toHaveLength(0);
    expect(await withSystem((db) => applyDeliveryEvent(db, { provider: "twilio", providerMessageId: id, providerEventId: `${id}:read`, status: "read", rawStatus: "read" }))).toEqual({ result: "applied", status: "read" });
  });

  it("never re-queues a message a callback recorded as sent", async () => {
    const c = await inbound(native.org.id, { provider: "twilio", ghlContactId: null });
    const q = await queueAi(native, c.conversationId);
    const id = sid();
    let calls = 0;
    const racing = twilioTransport(async (req) => {
      calls += 1;
      await withSystem((db) => applyDeliveryEventForMessage(db, { provider: "twilio", messageId: req.messageId, providerMessageId: id, providerEventId: `${id}:sent`, status: "sent", rawStatus: "sent" }));
      return { ok: false, retryable: true, error: "Twilio answered 503." };
    });
    expect(await dispatchMessage(q.messageId, { transport: racing })).toEqual({ status: "sent" });
    expect(await messageRow(q.messageId)).toMatchObject({ status: "sent", provider_message_id: id });
    await dispatchDue({ transport: racing, now: new Date(Date.now() + HOUR) });
    expect(calls).toBe(1);
  });

  it("settles the hold of a send a callback confirmed after its worker stopped", async () => {
    const c = await inbound(native.org.id, { provider: "twilio", ghlContactId: null });
    const q = await queueAi(native, c.conversationId);
    const id = sid();
    // The worker claimed it and died; Twilio's callback then reported it sent.
    await withSystem((db) => db.query("update conversation_messages set status = 'sending', claimed_at = now() - interval '11 minutes' where id = $1", [q.messageId]));
    await withSystem((db) => applyDeliveryEventForMessage(db, { provider: "twilio", messageId: q.messageId, providerMessageId: id, providerEventId: `${id}:sent`, status: "sent", rawStatus: "sent" }));
    await dispatchDue({ transport: twilioTransport(async () => ({ ok: true, providerMessageId: sid() })) });
    const row = await messageRow(q.messageId);
    expect(row.status).toBe("sent");
    expect((await reservation(row.reservation_id)).status).toBe("settled");
    expect(await usageFor(q.messageId)).toEqual([{ provider_reference: `twilio:${id}`, reservation_id: row.reservation_id }]);
  });
});

// ---------------------------------------------------------------------------
// 8, 9, 13. A failed re-test
// ---------------------------------------------------------------------------

const passing = async (): Promise<CapabilityTest> => ({ ok: true, checkedAt: new Date().toISOString(), checks: [{ label: "Account", ok: true, detail: "The account is active." }], registrationStatus: "approved" });
const failing = async (): Promise<CapabilityTest> => ({ ok: false, checkedAt: new Date().toISOString(), checks: [{ label: "Account", ok: false, detail: "Twilio refused the auth token." }] });

async function twilioSetup(name: string) {
  const org = await messagingOrg({ name });
  const accountId = `AC${crypto.randomBytes(16).toString("hex")}`;
  const input = { channel: "sms" as const, provider: "twilio" as const, secret: { accountSid: accountId, authToken: crypto.randomBytes(16).toString("hex") }, senderIdentity: phone(), senderId: `MG${crypto.randomBytes(16).toString("hex")}`, accountId, replaceLiveChannel: true };
  await configureNativeChannel(org.superAdmin, org.org.id, input);
  return { org, input };
}

describe("findings 8 and 9: a failed re-test withdraws the pass", () => {
  it("switches a live channel off, can't be switched on again, and tells the owners and the agency", async () => {
    const { org } = await twilioSetup("Retest Co");
    await runChannelCapabilityTest(org.superAdmin, org.org.id, "sms", { test: passing });
    expect((await enableChannel(org.superAdmin, org.org.id, "sms")).enabled).toBe(true);
    const failed = await runChannelCapabilityTest(org.superAdmin, org.org.id, "sms", { test: failing });
    expect(failed.status).toMatchObject({ enabled: false, ready: false, testedAt: null, senderVerifiedAt: null, lastTest: { ok: false } });
    expect(failed.status.readinessIssues.join(" ")).toMatch(/last Twilio test didn't pass/);
    expect(failed.status.detail).toMatch(/switched off/);
    await expect(enableChannel(org.superAdmin, org.org.id, "sms")).rejects.toThrow(/can't be switched on yet/);
    const notes = await withSystem((db) =>
      db.query<{ dedupe_key: string }>("select dedupe_key from notifications where (org_id = $1 and dedupe_key like 'channel_test_failed:sms:%') or dedupe_key like $2", [org.org.id, `channel_test_failed:twilio:${org.org.id}:%`]),
    );
    expect(notes.rows.some((r) => r.dedupe_key.startsWith("channel_test_failed:sms:"))).toBe(true);
    expect(notes.rows.some((r) => r.dedupe_key.startsWith(`channel_test_failed:twilio:${org.org.id}:`))).toBe(true);
    // Passing again makes it ready to switch on again.
    expect((await runChannelCapabilityTest(org.superAdmin, org.org.id, "sms", { test: passing })).status.ready).toBe(true);
  });

  it("keeps a switched-off channel off after a failed re-test, and the database refuses enabling over a failed latest test", async () => {
    const { org } = await twilioSetup("Retest Off Co");
    await runChannelCapabilityTest(org.superAdmin, org.org.id, "sms", { test: passing });
    await enableChannel(org.superAdmin, org.org.id, "sms");
    await disableChannel(org.superAdmin, org.org.id, "sms");
    const failed = await runChannelCapabilityTest(org.superAdmin, org.org.id, "sms", { test: failing });
    expect(failed.status).toMatchObject({ enabled: false, ready: false });
    await expect(enableChannel(org.superAdmin, org.org.id, "sms")).rejects.toThrow(/didn't pass/);
    // Even with the tested time put back, a failed latest result can't be switched on.
    await expect(withSystem((db) => db.query("update messaging_channels set capability_tested_at = now(), sender_verified_at = now(), enabled = true where org_id = $1 and channel = 'sms'", [org.org.id]))).rejects.toThrow();
  });

  it("finding 13: the client's settings say the last test failed, not that it never ran", async () => {
    const { org } = await twilioSetup("Retest Copy Co");
    await runChannelCapabilityTest(org.superAdmin, org.org.id, "sms", { test: failing });
    const sms = (await getCommunicationSettings(memberActor(org.ctx("owner")))).find((s) => s.channel === "sms")!;
    expect(sms.whyOff).toBe("The last connection test didn't pass.");
    expect(sms.lastTest).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// 10, 14, 16. Channel setup (agency)
// ---------------------------------------------------------------------------

describe("finding 10: saving the setup of a live channel", () => {
  it("keeps a live channel on when nothing the test checked changed, and needs confirmation before switching it off", async () => {
    const org = await messagingOrg({ name: "Live Edit Co", provider: { sms: "twilio" } });
    const ch = org.channels.sms;
    const same = { channel: "sms" as const, provider: "twilio" as const, senderIdentity: ch.identity, senderId: ch.senderId!, accountId: ch.accountId };
    const kept = await configureNativeChannel(org.superAdmin, org.org.id, same);
    expect(kept).toMatchObject({ enabled: true, ready: true, lastTest: { ok: true } });
    expect(kept.testedAt).not.toBeNull();

    const status = (await listChannelStatus(org.org.id)).find((s) => s.channel === "sms")!;
    const form: SetupForm = { provider: "twilio", secretTyped: false, senderIdentity: ch.identity, senderId: ch.senderId!, accountId: ch.accountId!, inboundAddress: "" };
    expect(setupKeepsState(status, form)).toBe(true);
    expect(liveChannelWarning(status, form)).toBeNull();
    const changed = { ...form, senderId: `MG${crypto.randomBytes(16).toString("hex")}` };
    expect(liveChannelWarning(status, changed)).toMatch(/live through Twilio. I understand saving this change switches it off/);
    expect(liveChannelWarning(status, { ...form, secretTyped: true })).toMatch(/live through Twilio/);

    await expect(configureNativeChannel(org.superAdmin, org.org.id, { ...same, senderId: changed.senderId })).rejects.toThrow(/live through Twilio.*Confirm/);
    expect((await listChannelStatus(org.org.id)).find((s) => s.channel === "sms")!.enabled).toBe(true);
    const off = await configureNativeChannel(org.superAdmin, org.org.id, { ...same, senderId: changed.senderId, replaceLiveChannel: true });
    expect(off).toMatchObject({ enabled: false, testedAt: null });

    // A channel live through GoHighLevel is warned about the same way.
    const ghl = (await listChannelStatus(org.org.id)).find((s) => s.channel === "email")!;
    expect(liveChannelWarning(ghl, { ...form, provider: "resend" })).toMatch(/live through GoHighLevel/);
  });
});

describe("finding 14: a capability test run shown on the card belongs to its setup", () => {
  it("stops showing an earlier run once the setup changes or moves back to GoHighLevel", async () => {
    const org = await messagingOrg({ name: "Stale Run Co", provider: { sms: "twilio" } });
    const before = (await listChannelStatus(org.org.id)).find((s) => s.channel === "sms")!;
    const run: TestRun = { setup: setupSignature(before), ok: true, checks: [{ label: "Account", ok: true, detail: "Active." }] };
    expect(shownTestResult(before, run)).toMatchObject({ ok: true, fresh: true });
    const changed = await configureNativeChannel(org.superAdmin, org.org.id, { channel: "sms", provider: "twilio", senderIdentity: org.channels.sms.identity, senderId: `MG${crypto.randomBytes(16).toString("hex")}`, accountId: org.channels.sms.accountId, replaceLiveChannel: true });
    expect(shownTestResult(changed, run)).toEqual({ ok: null, checks: [], fresh: false });
    const back = await switchChannelToGhl(org.superAdmin, org.org.id, "sms");
    expect(shownTestResult(back, run)).toMatchObject({ fresh: false, checks: [] });
    const webhooks = { email: { url: "https://p.example/api/webhooks/resend", ready: true, note: "n" }, sms: { url: "https://p.example/api/webhooks/twilio/inbound", ready: true, note: "n" }, whatsapp: { url: "https://p.example/api/webhooks/meta-whatsapp", ready: true, note: "n" } };
    const html = renderToStaticMarkup(React.createElement(AgencyChannelSetup, { orgId: org.org.id, channels: await listChannelStatus(org.org.id), webhooks, superAdmin: true, timeZone: "UTC" }));
    expect(html).not.toContain("Capability test passed");
  });
});

describe("provider ownership blocks native senders when GoHighLevel owns conversations", () => {
  it("shows the ownership reason on channel settings and refuses the enable action server-side", async () => {
    const { org } = await twilioSetup("Owned Conversations Co");
    await runChannelCapabilityTest(org.superAdmin, org.org.id, "sms", { test: passing });
    await withSystem((db) => db.query(
      "insert into crm_workspaces (org_id, mode) values ($1, 'ghl') on conflict (org_id) do update set mode = 'ghl'",
      [org.org.id],
    ));

    const sms = (await listChannelStatus(org.org.id)).find((s) => s.channel === "sms")!;
    expect(sms).toMatchObject({ native: true, ready: false, enabled: false });
    expect(sms.readinessIssues.join(" ")).toMatch(/Conversations are managed in GoHighLevel.*iAcquire's own sending channels don't send/);
    await expect(enableChannel(org.superAdmin, org.org.id, "sms")).rejects.toThrow(/Conversations are managed in GoHighLevel/);

    const webhooks = { email: { url: "https://p.example/api/webhooks/resend", ready: true, note: "n" }, sms: { url: "https://p.example/api/webhooks/twilio/inbound", ready: true, note: "n" }, whatsapp: { url: "https://p.example/api/webhooks/meta-whatsapp", ready: true, note: "n" } };
    const html = unescape(renderToStaticMarkup(React.createElement(AgencyChannelSetup, { orgId: org.org.id, channels: await listChannelStatus(org.org.id), webhooks, superAdmin: true, timeZone: "UTC" })));
    expect(html).toContain("Conversations are managed in GoHighLevel for this workspace");
    expect(html).toContain("Before it can be switched on");
  });
});

describe("finding 16: Resend needs iAcquire's own account", () => {
  it("says so on the channel card", async () => {
    const webhooks = { email: { url: "https://p.example/api/webhooks/resend", ready: true, note: "n" }, sms: { url: "https://p.example/api/webhooks/twilio/inbound", ready: true, note: "n" }, whatsapp: { url: "https://p.example/api/webhooks/meta-whatsapp", ready: true, note: "n" } };
    const html = unescape(renderToStaticMarkup(React.createElement(AgencyChannelSetup, { orgId: native.org.id, channels: await listChannelStatus(native.org.id), webhooks, superAdmin: true, timeZone: "UTC" })));
    expect(html).toContain(RESEND_ACCOUNT_NOTE);
    expect(RESEND_ACCOUNT_NOTE).toMatch(/Client-owned Resend accounts aren't supported/);
  });
});

// ---------------------------------------------------------------------------
// 12, 15, 17, 18, 19. Screens
// ---------------------------------------------------------------------------

describe("finding 12: WhatsApp template states", () => {
  const view = (over: Partial<WhatsappTemplateView>): WhatsappTemplateView => ({
    templateId: crypto.randomUUID(), name: "t", language: "en_US", body: "Hello", status: "approved", category: "utility", provider: "meta_whatsapp", variables: [], rejectionReason: null, checkedAt: null, usable: true, ...over,
  });

  it("labels by whether a template can be sent and shows the stored reason as written", () => {
    const unsendable = view({ name: "media_header", status: "rejected", rejectionReason: "Approved by Meta, but iAcquire can't send it yet: it has an image header." });
    const paused = view({ name: "paused_one", status: "pending", rejectionReason: "Paused by Meta because of low quality." });
    const leftover = view({ name: "old_ghl", provider: "ghl", usable: false });
    expect(whatsappTemplateState(unsendable)).toMatchObject({ label: "Can't be sent" });
    expect(whatsappTemplateState(paused)).toMatchObject({ label: "Not sendable yet" });
    expect(whatsappTemplateState(leftover)).toMatchObject({ label: "Not usable now" });
    expect(whatsappTemplateState(view({}))).toMatchObject({ label: "Approved by Meta" });
    expect(whatsappTemplateWhyNot(paused)).toBe("Paused by Meta because of low quality.");
    const html = unescape(renderToStaticMarkup(React.createElement(WhatsappTemplates, { items: [unsendable, paused, leftover], timeZone: "UTC", q: "" })));
    expect(html).not.toContain("Meta's reason");
    expect(html).not.toMatch(/>Rejected</);
    expect(html).toContain("Approved by Meta, but iAcquire can't send it yet");
    expect(html).toContain("Paused by Meta because of low quality.");
    expect(html).toContain("Not usable now");
  });
});

describe("finding 15: messaging settings for a native channel", () => {
  it("doesn't offer switching on a native channel the server refuses, and says who switches it on", () => {
    const base = { senderIdentity: "+15550001111", verified: true, registrationStatus: "approved", detail: null, testedAt: new Date().toISOString() };
    const settings: MessagingSettingsView = {
      autoReplyEnabled: true, replyBusinessHoursOnly: false, businessHours: {}, followUpPreset: "balanced", followUpCustom: null, ownerTimeoutUrgentSeconds: 120, ownerTimeoutNormalSeconds: 300,
      channels: [
        { ...base, channel: "sms", enabled: false, provider: "twilio", providerLabel: "Twilio" },
        { ...base, channel: "whatsapp", enabled: true, provider: "meta_whatsapp", providerLabel: "WhatsApp Business (Meta)" },
        { ...base, channel: "email", enabled: false, senderIdentity: "hello@example.test", registrationStatus: "not_required", provider: "ghl", providerLabel: "GoHighLevel" },
      ],
      agencyLimits: { maxFollowupAttempts: 3, maxFollowupsPer30Days: 6, quietHoursStart: "21:00", quietHoursEnd: "08:00", whatsappWindowHours: 24, minHoursBetweenFollowups: 24 },
    };
    const html = renderToStaticMarkup(React.createElement(MessagingSettings, { settings, isOwner: true, canConfigure: true }));
    const sw = (label: string) => /<button[^>]*>/.exec(elementHtml(html, `aria-label="${label} channel"`))![0];
    expect(sw("SMS")).toMatch(/disabled=""/);
    expect(sw("SMS")).toContain('aria-describedby="ch-sms-on-hint"');
    expect(html).toContain("Switched on by iAcquire after its connection test.");
    expect(html).toContain('href="/crm/settings/communications"');
    // A native channel that is on can still be switched off; a verified GoHighLevel channel can still be switched on.
    expect(sw("WhatsApp")).not.toMatch(/disabled=""/);
    expect(sw("Email")).not.toMatch(/disabled=""/);
  });
});

describe("finding 17: the composer's tablist owns only tabs", () => {
  it("renders the canned replies button outside role=tablist", () => {
    const detail: InboxDetail = {
      conversation: {
        id: "00000000-0000-4000-8000-000000000002", contactId: "c1", contactName: "Lea Reyes", channel: "sms", status: "open", ownerKind: "human", ownerName: "Owner Person", ownerUserId: "u1",
        assignedUserId: null, priority: "normal", unread: 0, lastMessageAt: new Date().toISOString(), preview: "Hi", escalation: null, aiAgent: null, aiPaused: false, archivedAt: null, resolvedAt: null, outcome: null, lastOutboundAt: null, waitingOnCustomer: false, attention: [], revision: 0, subject: null, lastInboundAt: new Date().toISOString(), whatsappWindowOpen: null,
      },
      contact: { id: "c1", name: "Lea Reyes", lifecycleStage: "lead_captured", temperature: null, source: "inbound_message", identities: [], consent: [] },
      messages: [],
      timeline: [], events: [], memories: [], followUp: null, escalation: null,
    };
    const html = renderToStaticMarkup(React.createElement(InboxWorkspace, {
      list: [detail.conversation], detail, escalations: [], me: { id: "u1", isOwner: true },
      perms: { reply: true, assign: true, notes: true, resume: true, respond: true, editContacts: true }, team: [], templates: [], timeZone: "UTC",
      filters: { q: "", channel: "", owner: "", unread: false },
      cannedReplies: [{ id: "r1", name: "Greeting", body: "Hi {{contact.first_name}}", channel: null, folderName: null }], cannedValues: {},
    }));
    expect(html).toContain("Canned replies");
    const tablist = elementHtml(html, 'aria-label="Composer mode"');
    expect(tablist).toContain('role="tab"');
    expect(tablist).not.toContain("Canned replies");
    expect(tablist).not.toContain("aria-haspopup");
    // Every element the tablist owns directly is a tab.
    const children = [...tablist.slice(tablist.indexOf(">") + 1).matchAll(/<(button|a|div|span)\b[^>]*>/g)].map((m) => m[0]).filter((t) => /^<button/.test(t));
    expect(children.every((t) => t.includes('role="tab"'))).toBe(true);
  });
});

describe("finding 18: Escape returns focus to the trigger", () => {
  it("lets the menu return focus after Escape, and keeps it in the field after a pick", () => {
    const guard = pickFocusGuard();
    const escape = { preventDefault: vi.fn() };
    guard.onCloseAutoFocus(escape);
    expect(escape.preventDefault).not.toHaveBeenCalled();
    guard.markPicked();
    const afterPick = { preventDefault: vi.fn() };
    guard.onCloseAutoFocus(afterPick);
    expect(afterPick.preventDefault).toHaveBeenCalledTimes(1);
    // The next close (Escape again) returns focus normally.
    const again = { preventDefault: vi.fn() };
    guard.onCloseAutoFocus(again);
    expect(again.preventDefault).not.toHaveBeenCalled();
  });
});

describe("finding 19: the checks under the editor", () => {
  it("announces only the number of problems, never the segment estimate that changes as you type", () => {
    const check = validateTemplate("Hi {{contact.first_name}}, your visit is tomorrow.", null, "sms", { purpose: "service", kind: "template" });
    expect(check.info.some((i) => /segment/i.test(i.message))).toBe(true);
    const html = renderToStaticMarkup(React.createElement(ValidationList, { check }));
    const live = elementHtml(html, 'aria-live="polite"');
    expect(live).not.toMatch(/segment|GSM|characters/i);
    expect(live).toContain(checksSummary(check));
    // The details are still there, as plain text outside the live region.
    expect(html).toMatch(/segment/i);
    expect(elementHtml(html, "<ul")).not.toContain("aria-live");
    expect(checksSummary({ errors: [{} as never], warnings: [] })).toBe("1 problem to fix.");
  });
});
