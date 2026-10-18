// WhatsApp through Meta's Cloud API: transport, capability test, webhooks and template sync. Every Graph API call is a mocked fetch; nothing
// leaves the machine and no message is sent.
import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { publishUnitRate } from "@/server/billing/service";
import { saveCredential } from "@/server/security/credentials";
import { dispatchMessage, queueOutbound } from "@/server/messaging/send";
import {
  describeMetaError,
  handleMetaWebhook,
  handleMetaWebhookVerify,
  inboundText,
  metaSignature,
  metaWhatsappSecretJson,
  metaWhatsappTransport,
  parseMetaWhatsappSecret,
  templateComponents,
  testMetaWhatsappCapability,
  verifyMetaSignature,
} from "@/server/messaging/transports/meta-whatsapp";
import { mapMetaTemplate, mapMetaTemplateStatus, syncAllWhatsappTemplates, syncWhatsappTemplates, templateVariables } from "@/server/messaging/whatsapp-templates";
import { JOBS } from "@/server/ops/tick";
import type { TransportSendRequest } from "@/server/messaging/transports/types";
import { GET as routeGet, POST as routePost } from "@/app/api/webhooks/meta-whatsapp/route";
import { messageRow, messagingOrg, phone, type MessagingOrg } from "./support/messaging";

// The route schedules follow-up work with next/server's after(), which needs a live request scope. Here it is only recorded, never run.
const scheduled = vi.hoisted(() => ({ after: [] as Array<() => unknown> }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => unknown) => void scheduled.after.push(fn) }));

const BASE = "https://portal.example.com";
const APP_SECRET = "meta-app-secret-0123456789abcdef";
const VERIFY_TOKEN = "verify-token-0123456789abcdef";
const PHONE_ID = "106540352242922";
const WABA = "102290129340398";
const TOKEN = "EAAJBsyntheticTestToken0123456789abcdefABCDEF";
const BUSINESS_NUMBER = "+15550001111";
const PHONE_ID_2 = "209876543210987";
const WABA_2 = "301234567890123";
const TOKEN_2 = "EAAJBsyntheticOtherToken9876543210fedcbaFEDCBA";
const GRAPH = "https://graph.facebook.com/v26.0";

const wamid = () => `wamid.${crypto.randomBytes(24).toString("base64")}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Meta's documented algorithm, written out independently of the implementation: "sha256=" + hex HMAC-SHA256(app secret, raw body). */
const sign = (secret: string, raw: string) => `sha256=${crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;

type Change = { phoneNumberId?: string; waba?: string; messages?: unknown[]; statuses?: unknown[]; contacts?: unknown[]; errors?: unknown[] };
const envelope = (...changes: Change[]) => ({
  object: "whatsapp_business_account",
  entry: changes.map((c) => ({
    id: c.waba ?? WABA,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550001111", phone_number_id: c.phoneNumberId ?? PHONE_ID },
          ...(c.contacts ? { contacts: c.contacts } : {}),
          ...(c.messages ? { messages: c.messages } : {}),
          ...(c.statuses ? { statuses: c.statuses } : {}),
          ...(c.errors ? { errors: c.errors } : {}),
        },
      },
    ],
  })),
});
const textMessage = (from: string, body: string, over: Record<string, unknown> = {}) => ({ from: from.replace(/^\+/, ""), id: wamid(), timestamp: String(nowSeconds() - 30), type: "text", text: { body }, ...over });
const contact = (from: string, name: string) => ({ profile: { name }, wa_id: from.replace(/^\+/, "") });
const statusEvent = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, status, timestamp: String(nowSeconds()), recipient_id: "639170000000", ...over });

async function post(payload: unknown, opts: { secret?: string; signature?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const signature = opts.signature === undefined ? sign(opts.secret ?? APP_SECRET, raw) : opts.signature;
  return handleMetaWebhook(raw, signature === null ? { "content-type": "application/json" } : { "content-type": "application/json", "x-hub-signature-256": signature });
}

let m: MessagingOrg;
let m2: MessagingOrg;
let credentialId: string;

async function connectWhatsapp(org: MessagingOrg, opts: { phoneNumberId: string; waba: string; token: string }) {
  return withSystem(async (db) => {
    const saved = await saveCredential(db, { orgId: org.org.id, provider: "meta_whatsapp", label: "WhatsApp (synthetic test)", secret: metaWhatsappSecretJson({ accessToken: opts.token }), actorId: org.superAdmin.id });
    await db.query(
      `update messaging_channels set provider = 'meta_whatsapp', provider_sender_id = $2, provider_account_id = $3, credential_id = $4, sender_identity = $5,
         capability_test = '{"ok":true}'::jsonb, capability_tested_at = now() where org_id = $1 and channel = 'whatsapp'`,
      [org.org.id, opts.phoneNumberId, opts.waba, saved.id, BUSINESS_NUMBER],
    );
    return saved.id;
  });
}

const REMINDER_VARIABLES = [
  { position: 1, label: "{{1}}", component: "body" },
  { position: 2, label: "{{2}}", component: "body" },
];

beforeAll(async () => {
  process.env.META_WHATSAPP_WRITES_ENABLED = "true";
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
  process.env.APP_URL = BASE;
  resetEnvCache();
  m = await messagingOrg({ name: "WhatsApp Clinic" });
  m2 = await messagingOrg({ name: "Other WhatsApp Co" });
  credentialId = await connectWhatsapp(m, { phoneNumberId: PHONE_ID, waba: WABA, token: TOKEN });
  await connectWhatsapp(m2, { phoneNumberId: PHONE_ID_2, waba: WABA_2, token: TOKEN_2 });
  await withSystem((db) =>
    db.query(
      `insert into whatsapp_templates (org_id, template_id, name, language, body, status, checked_at, provider, category, variables, components)
       values ($1, '900001', 'appointment_reminder', 'en_US', 'Hi {{1}}, your visit is on {{2}}.', 'approved', now(), 'meta_whatsapp', 'utility', $2::jsonb, '[]'::jsonb)`,
      [m.org.id, JSON.stringify(REMINDER_VARIABLES)],
    ),
  );
  await publishUnitRate(m.superAdmin, { provider: "meta_whatsapp", unitType: "whatsapp_message", wholesaleMicrosPerUnit: 5000 });
});
afterAll(() => {
  for (const k of ["META_WHATSAPP_WRITES_ENABLED", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "APP_URL"]) delete process.env[k];
  resetEnvCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type FetchCall = { url: URL; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
function stubFetch(answer: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit = {}) => {
    const call: FetchCall = { url: new URL(String(input)), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const accepted = (id = wamid(), to = "+639175550101") => json({ messaging_product: "whatsapp", contacts: [{ input: to, wa_id: to.slice(1) }], messages: [{ id }] });
const graphError = (status: number, code: number, details = "Message to +639175550101 failed") =>
  json({ error: { message: `(#${code}) Something`, type: "OAuthException", code, error_data: { messaging_product: "whatsapp", details }, fbtrace_id: "Az8or2yhqkZfEZ" } }, status);

const sendReq = (over: Partial<TransportSendRequest> = {}): TransportSendRequest => ({
  orgId: m.org.id,
  channel: "whatsapp",
  messageId: crypto.randomUUID(),
  to: "+639175550101",
  contactRef: null,
  body: "Thanks for reaching out. We have room on Thursday.",
  sender: { identity: BUSINESS_NUMBER, senderId: PHONE_ID, accountId: WABA, credentialId },
  ...over,
});

// ---------------------------------------------------------------------------

describe("webhook signatures and the verification handshake", () => {
  it("signs with HMAC-SHA256 as published (RFC 4231 test case 2) and verifies in constant time", () => {
    expect(metaSignature("Jefe", "what do ya want for nothing?")).toBe("sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    const raw = JSON.stringify(envelope({ messages: [textMessage("+639170000001", "Hi")] }));
    const good = sign(APP_SECRET, raw);
    expect(metaSignature(APP_SECRET, raw)).toBe(good);
    expect(verifyMetaSignature(APP_SECRET, raw, good)).toBe(true);
    expect(verifyMetaSignature(APP_SECRET, raw, good.replace("sha256=", "sha256=").toUpperCase().replace("SHA256=", "sha256="))).toBe(true);
    expect(verifyMetaSignature(APP_SECRET, raw, sign("another-app-secret-000000", raw))).toBe(false);
    expect(verifyMetaSignature(APP_SECRET, `${raw} `, good)).toBe(false);
    expect(verifyMetaSignature(APP_SECRET, raw, good.slice("sha256=".length))).toBe(false);
    expect(verifyMetaSignature(APP_SECRET, raw, `sha1=${good.slice(7, 47)}`)).toBe(false);
    expect(verifyMetaSignature(APP_SECRET, raw, null)).toBe(false);
    expect(verifyMetaSignature(APP_SECRET, raw, "")).toBe(false);
  });

  it("answers Meta's subscription handshake only with the right verify token", () => {
    const q = (o: Record<string, string>) => new URLSearchParams(o);
    expect(handleMetaWebhookVerify(q({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" }))).toEqual({ status: 200, body: "1158201444" });
    expect(handleMetaWebhookVerify(q({ "hub.mode": "subscribe", "hub.verify_token": "wrong-token-0123456789", "hub.challenge": "1158201444" }))).toEqual({ status: 403, body: "Forbidden" });
    expect(handleMetaWebhookVerify(q({ "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" })).status).toBe(403);
    expect(handleMetaWebhookVerify(q({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN })).status).toBe(403);
    expect(handleMetaWebhookVerify(q({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "<script>" + "x".repeat(300) })).status).toBe(403);
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    resetEnvCache();
    try {
      expect(handleMetaWebhookVerify(q({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" })).status).toBe(403);
    } finally {
      process.env.META_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
      resetEnvCache();
    }
  });
});

describe("credentials", () => {
  it("stores the System User token as one JSON secret and refuses anything else", () => {
    expect(parseMetaWhatsappSecret(metaWhatsappSecretJson({ accessToken: ` ${TOKEN} ` }))).toEqual({ accessToken: TOKEN });
    expect(() => metaWhatsappSecretJson({ accessToken: "short" })).toThrow(/System User access token/);
    expect(parseMetaWhatsappSecret("not json")).toBeNull();
    expect(parseMetaWhatsappSecret(JSON.stringify({ token: TOKEN }))).toBeNull();
    expect(parseMetaWhatsappSecret(JSON.stringify({ accessToken: "has spaces in it which is wrong" }))).toBeNull();
  });
});

describe("sending", () => {
  it("sends free-form text to the phone number ID with a Bearer token and our message id as biz_opaque_callback_data", async () => {
    const id = wamid();
    const calls = stubFetch(() => accepted(id));
    const req = sendReq();
    expect(await metaWhatsappTransport.send(req)).toEqual({ ok: true, providerMessageId: id, providerConversationId: null });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url.toString()).toBe(`${GRAPH}/${PHONE_ID}/messages`);
    expect(c.method).toBe("POST");
    expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(c.body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: req.to, type: "text", text: { body: req.body }, biz_opaque_callback_data: req.messageId });
    expect(metaWhatsappTransport).toMatchObject({ name: "meta_whatsapp", channels: ["whatsapp"], requiresContactRef: false });
  });

  it("sends an approved template by name and language with its values as body parameters", async () => {
    const calls = stubFetch(() => accepted());
    const req = sendReq({ body: "Hi Maria, your visit is on Friday at 10am.", template: { name: "appointment_reminder", language: "en_US", params: ["Maria", "Friday at 10am"] } });
    expect(await metaWhatsappTransport.send(req)).toMatchObject({ ok: true });
    expect(calls[0].body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: req.to,
      type: "template",
      template: { name: "appointment_reminder", language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "Maria" }, { type: "text", text: "Friday at 10am" }] }] },
      biz_opaque_callback_data: req.messageId,
    });
  });

  it("refuses a template it can't fill correctly or that isn't approved, without calling Meta", async () => {
    const calls = stubFetch(() => accepted());
    expect(await metaWhatsappTransport.send(sendReq({ template: { name: "appointment_reminder", language: "en_US", params: ["Maria"] } }))).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/needs 2 values; 1 was given/) });
    expect(await metaWhatsappTransport.send(sendReq({ template: { name: "appointment_reminder", language: "en_US", params: ["Maria", " "] } }))).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
    expect(await metaWhatsappTransport.send(sendReq({ template: { name: "appointment_reminder", language: "pt_BR", params: ["a", "b"] } }))).toMatchObject({ ok: false, error: expect.stringMatching(/isn't approved/) });
    expect(await metaWhatsappTransport.send(sendReq({ orgId: m2.org.id, template: { name: "appointment_reminder", language: "en_US", params: ["a", "b"] } }))).toMatchObject({ ok: false });
    expect(await metaWhatsappTransport.send(sendReq({ template: { name: "Bad Name!", language: "en_US", params: [] } }))).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("builds header, body and named parameters in Meta's shape", () => {
    expect(templateComponents([{ position: 1, label: "Header", component: "header" }, { position: 2, label: "{{1}}", component: "body" }], ["Act fast", "SUMMER20"])).toEqual({
      components: [{ type: "header", parameters: [{ type: "text", text: "Act fast" }] }, { type: "body", parameters: [{ type: "text", text: "SUMMER20" }] }],
    });
    expect(templateComponents([{ position: 1, label: "first_name", component: "body", name: "first_name" }], ["Jessica"])).toEqual({ components: [{ type: "body", parameters: [{ type: "text", parameter_name: "first_name", text: "Jessica" }] }] });
    expect(templateComponents([], [])).toEqual({ components: [] });
  });

  it("sends nothing while the META_WHATSAPP_WRITES_ENABLED kill switch is off", async () => {
    const calls = stubFetch(() => accepted());
    process.env.META_WHATSAPP_WRITES_ENABLED = "false";
    resetEnvCache();
    try {
      expect(await metaWhatsappTransport.send(sendReq())).toMatchObject({ ok: false, blocked: true, retryable: false });
    } finally {
      process.env.META_WHATSAPP_WRITES_ENABLED = "true";
      resetEnvCache();
    }
    expect(calls).toHaveLength(0);
  });

  it("maps Meta errors: 131047 closes the window, 190 asks to reconnect, rate limits retry, and Meta's text (with the number) is never passed on", async () => {
    stubFetch(() => graphError(400, 131047));
    const window = await metaWhatsappTransport.send(sendReq());
    expect(window).toMatchObject({ ok: false, retryable: false, windowClosed: true, error: expect.stringMatching(/24 hours.*\(WhatsApp 131047\)/) });
    expect(JSON.stringify(window)).not.toContain("+639175550101");
    stubFetch(() => graphError(401, 190));
    expect(await metaWhatsappTransport.send(sendReq())).toMatchObject({ ok: false, retryable: false, reconnectRequired: true });
    stubFetch(() => graphError(403, 200));
    expect(await metaWhatsappTransport.send(sendReq())).toMatchObject({ ok: false, reconnectRequired: true });
    stubFetch(() => graphError(400, 130429));
    expect(await metaWhatsappTransport.send(sendReq())).toMatchObject({ ok: false, retryable: true });
    stubFetch(() => graphError(400, 131056));
    expect(await metaWhatsappTransport.send(sendReq())).toMatchObject({ ok: false, retryable: true });
    stubFetch(() => graphError(400, 131026));
    const undeliverable = await metaWhatsappTransport.send(sendReq());
    expect(undeliverable).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/could not deliver/) });
    expect(undeliverable.ok === false && (undeliverable.suppress || undeliverable.windowClosed || undeliverable.reconnectRequired)).toBeFalsy();
    stubFetch(() => graphError(400, 132001));
    expect(await metaWhatsappTransport.send(sendReq())).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/isn't approved/) });
    expect(describeMetaError(999999)).toBe("WhatsApp refused the message. (WhatsApp 999999)");
  });

  it("is at most once: a timeout, a 5xx or an answer without a message id is never retried", async () => {
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await metaWhatsappTransport.send(sendReq())).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/not confirmed sent/) });
    stubFetch(() => graphError(503, 2));
    expect(await metaWhatsappTransport.send(sendReq())).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/not confirmed sent/) });
    stubFetch(() => json({ messaging_product: "whatsapp", messages: [] }));
    expect(await metaWhatsappTransport.send(sendReq())).toMatchObject({ ok: false, retryable: false, error: "WhatsApp did not confirm the message." });
  });

  it("refuses before calling Meta: no sender, a revoked or foreign credential, a bad number, an over-long text, another channel", async () => {
    const calls = stubFetch(() => accepted());
    expect(await metaWhatsappTransport.send(sendReq({ sender: { identity: null, senderId: null, accountId: null, credentialId: null } }))).toMatchObject({ ok: false, blocked: true, reconnectRequired: true });
    expect(await metaWhatsappTransport.send(sendReq({ sender: { identity: null, senderId: "+15550001111", accountId: WABA, credentialId } }))).toMatchObject({ ok: false, blocked: true });
    expect(await metaWhatsappTransport.send(sendReq({ to: "09175550101" }))).toMatchObject({ ok: false, retryable: false });
    expect(await metaWhatsappTransport.send(sendReq({ body: "x".repeat(4097) }))).toMatchObject({ ok: false, error: expect.stringMatching(/4,096/) });
    expect(await metaWhatsappTransport.send(sendReq({ body: "   " }))).toMatchObject({ ok: false, error: "The message is empty." });
    expect(await metaWhatsappTransport.send(sendReq({ channel: "sms" }))).toMatchObject({ ok: false, blocked: true });
    expect(await metaWhatsappTransport.send(sendReq({ messageId: "not-a-uuid" }))).toMatchObject({ ok: false });
    const foreign = await withSystem(async (db) => (await saveCredential(db, { orgId: m2.org.id, provider: "meta_whatsapp", label: "Not yours", secret: metaWhatsappSecretJson({ accessToken: TOKEN }), actorId: m2.superAdmin.id })).id);
    expect(await metaWhatsappTransport.send(sendReq({ sender: { identity: BUSINESS_NUMBER, senderId: PHONE_ID, accountId: WABA, credentialId: foreign } }))).toMatchObject({ ok: false, blocked: true, reconnectRequired: true });
    const revoked = await withSystem(async (db) => {
      const saved = await saveCredential(db, { orgId: m.org.id, provider: "meta_whatsapp", label: "Revoked", secret: metaWhatsappSecretJson({ accessToken: TOKEN }), actorId: m.superAdmin.id });
      await db.query("update integration_credentials set revoked_at = now() where id = $1", [saved.id]);
      return saved.id;
    });
    expect(await metaWhatsappTransport.send(sendReq({ sender: { identity: BUSINESS_NUMBER, senderId: PHONE_ID, accountId: WABA, credentialId: revoked } }))).toMatchObject({ ok: false, blocked: true, reconnectRequired: true });
    expect(calls).toHaveLength(0);
  });
});

describe("capability test", () => {
  const number = (over: Record<string, unknown> = {}) => ({ id: PHONE_ID, display_phone_number: "+1 555-000-1111", verified_name: "WhatsApp Clinic", quality_rating: "GREEN", name_status: "APPROVED", status: "CONNECTED", ...over });
  const route = (over: { number?: Response; numbers?: Response; templates?: Response; apps?: Response } = {}) => (c: FetchCall) => {
    if (c.url.pathname === `/v26.0/${PHONE_ID}`) return over.number ?? json(number());
    if (c.url.pathname === `/v26.0/${WABA}/phone_numbers`) return over.numbers ?? json({ data: [{ id: "999999999999" }, { id: PHONE_ID }], paging: { cursors: { before: "QVFI", after: "QVFJ" } } });
    if (c.url.pathname === `/v26.0/${WABA}/message_templates`) return over.templates ?? json({ data: [], paging: { cursors: {} } });
    if (c.url.pathname === `/v26.0/${WABA}/subscribed_apps`) return over.apps ?? json({ data: [{ whatsapp_business_api_data: { id: "1234567890123456", name: "iAcquire", link: "https://www.facebook.com/games/?app_id=1234567890123456" } }] });
    return graphError(404, 100);
  };
  const secret = metaWhatsappSecretJson({ accessToken: TOKEN });

  it("passes for a connected number in the account, readable templates and a subscribed app, using only GETs and never leaking the token", async () => {
    const calls = stubFetch(route());
    const result = await testMetaWhatsappCapability({ secret, senderId: ` ${PHONE_ID} `, accountId: WABA });
    expect(result).toMatchObject({ ok: true, senderId: PHONE_ID, accountId: WABA, senderIdentity: BUSINESS_NUMBER, registrationStatus: "approved" });
    expect(result.checks.map((c) => c.label)).toEqual(["Access token", "Phone number", "WhatsApp Business Account", "Message templates", "Webhook subscription", "Webhook address"]);
    expect(result.checks.find((c) => c.label === "Webhook address")?.detail).toContain(`${BASE}/api/webhooks/meta-whatsapp`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(calls.every((c) => c.method === "GET" && c.url.origin === "https://graph.facebook.com" && c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.some((c) => c.url.pathname.endsWith("/messages"))).toBe(false);
    expect(calls[0].url.searchParams.get("fields")).toContain("status");
  });

  it("accepts channel setup's input shape and refuses another channel or malformed ids without calling Meta", async () => {
    stubFetch(route());
    expect(await testMetaWhatsappCapability({ secret, sender: { senderId: PHONE_ID, accountId: WABA }, channel: "whatsapp", orgId: m.org.id })).toMatchObject({ ok: true });
    const calls = stubFetch(route());
    expect(await testMetaWhatsappCapability({ secret, senderId: PHONE_ID, accountId: WABA, channel: "sms" })).toMatchObject({ ok: false, checks: [{ label: "Channel", ok: false }] });
    expect(await testMetaWhatsappCapability({ secret: "nope", senderId: PHONE_ID, accountId: WABA })).toMatchObject({ ok: false, checks: [{ label: "Credential" }] });
    expect(await testMetaWhatsappCapability({ secret, senderId: "+15550001111", accountId: WABA })).toMatchObject({ ok: false, checks: [{ label: "Phone number ID" }] });
    expect(await testMetaWhatsappCapability({ secret, senderId: PHONE_ID, accountId: null })).toMatchObject({ ok: false, checks: [{ label: "WhatsApp Business Account ID" }] });
    expect(calls).toHaveLength(0);
  });

  it("fails honestly: rejected token, a disconnected number, a number from another account, unreadable templates, no subscribed app", async () => {
    stubFetch(route({ number: graphError(401, 190) }));
    const rejected = await testMetaWhatsappCapability({ secret, senderId: PHONE_ID, accountId: WABA });
    expect(rejected).toMatchObject({ ok: false, checks: [{ label: "Access token", ok: false, detail: expect.stringMatching(/rejected the access token \(WhatsApp 190\)/) }] });

    stubFetch(route({ number: json(number({ status: "DISCONNECTED" })) }));
    const disconnected = await testMetaWhatsappCapability({ secret, senderId: PHONE_ID, accountId: WABA });
    expect(disconnected).toMatchObject({ ok: false, registrationStatus: "pending" });
    expect(disconnected.checks.find((c) => c.label === "Phone number")).toMatchObject({ ok: false, detail: expect.stringMatching(/disconnected/) });

    stubFetch(route({ numbers: json({ data: [{ id: "999999999999" }], paging: { cursors: {} } }) }));
    const elsewhere = await testMetaWhatsappCapability({ secret, senderId: PHONE_ID, accountId: WABA });
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.checks.at(-1)).toMatchObject({ label: "WhatsApp Business Account", ok: false, detail: expect.stringMatching(/isn't in/) });

    stubFetch(route({ templates: graphError(403, 200) }));
    expect((await testMetaWhatsappCapability({ secret, senderId: PHONE_ID, accountId: WABA })).checks.find((c) => c.label === "Message templates")).toMatchObject({ ok: false });

    stubFetch(route({ apps: json({ data: [] }) }));
    const noApp = await testMetaWhatsappCapability({ secret, senderId: PHONE_ID, accountId: WABA });
    expect(noApp.ok).toBe(false);
    expect(noApp.checks.find((c) => c.label === "Webhook subscription")).toMatchObject({ ok: false, detail: expect.stringMatching(/never arrive/) });

    stubFetch(route({ number: graphError(404, 100) }));
    expect((await testMetaWhatsappCapability({ secret, senderId: PHONE_ID, accountId: WABA })).checks.find((c) => c.label === "Phone number")).toMatchObject({ ok: false });
  });

  it("fails the webhook check when signed webhooks can't be verified or Meta can't reach the address", async () => {
    stubFetch(route());
    delete process.env.META_APP_SECRET;
    resetEnvCache();
    try {
      expect((await testMetaWhatsappCapability({ secret, senderId: PHONE_ID, accountId: WABA })).checks.find((c) => c.label === "Webhook address")).toMatchObject({ ok: false, detail: expect.stringMatching(/META_APP_SECRET/) });
    } finally {
      process.env.META_APP_SECRET = APP_SECRET;
      resetEnvCache();
    }
    process.env.APP_URL = "http://localhost:3000";
    resetEnvCache();
    try {
      const local = await testMetaWhatsappCapability({ secret, senderId: PHONE_ID, accountId: WABA });
      expect(local.ok).toBe(false);
      expect(local.checks.find((c) => c.label === "Webhook address")).toMatchObject({ ok: false });
    } finally {
      process.env.APP_URL = BASE;
      resetEnvCache();
    }
  });
});

describe("inbound message text", () => {
  it("keeps text, notes media without downloading it, and skips reactions and system notices", () => {
    expect(inboundText({ type: "text", text: { body: "Does it come in another color?" } })).toBe("Does it come in another color?");
    expect(inboundText({ type: "image", image: { caption: "My rash", mime_type: "image/jpeg", sha256: "x", id: "123" } })).toBe("My rash\n\n[Photo received. Media isn't downloaded or shown in the inbox yet.]");
    expect(inboundText({ type: "audio", audio: { voice: true, id: "1" } })).toBe("[Voice message received. Media isn't downloaded or shown in the inbox yet.]");
    expect(inboundText({ type: "document", document: { filename: "referral.pdf", id: "1" } })).toBe('[Document "referral.pdf" received. Media isn\'t downloaded or shown in the inbox yet.]');
    expect(inboundText({ type: "button", button: { payload: "Unsubscribe", text: "Unsubscribe" } })).toBe("Unsubscribe");
    expect(inboundText({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "r1", title: "Thursday 10am", description: "Dr. Cruz" } } })).toBe("Thursday 10am\nDr. Cruz");
    expect(inboundText({ type: "location", location: { latitude: 14.5547, longitude: 121.0244, name: "Clinic", address: "Makati" } })).toBe("[Location shared: Clinic, Makati (14.55470, 121.02440)]");
    expect(inboundText({ type: "reaction", reaction: { message_id: "wamid.x", emoji: "👍" } })).toBeNull();
    expect(inboundText({ type: "system", system: { type: "user_changed_number" } })).toBeNull();
    expect(inboundText({ type: "unsupported", unsupported: { type: "edit" } })).toMatch(/doesn't support/);
  });
});

describe("webhooks", () => {
  const messagesFor = (id: string) => withSystem((db) => db.query<{ id: string; org_id: string; body: string; conversation_id: string; provider: string }>("select id, org_id, body, conversation_id, provider from conversation_messages where provider = 'meta_whatsapp' and provider_message_id = $1", [id]));
  const receipts = (id: string) => withSystem((db) => db.query<{ external_id: string; outcome: string; org_id: string | null }>("select external_id, outcome, org_id from webhook_receipts where provider = 'meta_whatsapp' and external_id like $1 order by external_id", [`%${id}%`]));
  const conversation = (id: string) => withSystem((db) => db.query<{ last_inbound_at: Date | null; channel: string; contact_id: string; org_id: string }>("select last_inbound_at, channel, contact_id, org_id from conversations where id = $1", [id]));
  const queueAi = (conversationId: string, body = "We have a slot on Thursday at 10am. Shall I hold it?") =>
    withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body }));

  async function inboundConversation(customer = phone(), body = "Hi, do you have availability this week?") {
    const msg = textMessage(customer, body);
    const res = await post(envelope({ contacts: [contact(customer, "Maria Santos")], messages: [msg] }));
    const conversationId = res.events.find((e) => e.kind === "inbound")?.conversationId;
    if (!conversationId) throw new Error("no conversation");
    return { customer, msg, res, conversationId };
  }

  it("records an inbound text in the contact's WhatsApp conversation and opens the 24-hour window", async () => {
    const customer = phone();
    const sentAt = nowSeconds() - 120;
    const msg = textMessage(customer, "Hi, can I book a cleaning on Saturday?", { timestamp: String(sentAt) });
    const res = await post(envelope({ contacts: [contact(customer, "Maria Santos")], messages: [msg] }));
    expect(res).toMatchObject({ status: 200, body: "OK", templateSync: [] });
    expect(res.events).toEqual([expect.objectContaining({ kind: "inbound", outcome: "processed", orgId: m.org.id })]);
    const rows = await messagesFor(msg.id);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ org_id: m.org.id, body: "Hi, can I book a cleaning on Saturday?", provider: "meta_whatsapp" });
    const conv = (await conversation(rows.rows[0].conversation_id)).rows[0];
    expect(conv).toMatchObject({ channel: "whatsapp", org_id: m.org.id });
    expect(new Date(conv.last_inbound_at!).getTime()).toBe(sentAt * 1000);
    const name = await withSystem((db) => db.query<{ display_name: string }>("select display_name from contacts where id = $1", [conv.contact_id]));
    expect(name.rows[0].display_name).toBe("Maria Santos");
    // The AI-owned conversation gets a reply prepared after the response.
    expect(res.respond).toEqual([{ orgId: m.org.id, conversationId: rows.rows[0].conversation_id }]);
    expect((await receipts(msg.id)).rows).toEqual([{ external_id: `inbound:${msg.id}`, outcome: "processed", org_id: m.org.id }]);

    // A second message from the same number threads into the same conversation.
    const next = textMessage(customer, "Or Sunday works too.");
    const again = await post(envelope({ messages: [next] }));
    expect(again.events[0]).toMatchObject({ outcome: "processed", conversationId: rows.rows[0].conversation_id });
  });

  it("refuses bad, missing or foreign signatures before reading anything, and waits (503) while the app secret is not configured", async () => {
    const msg = textMessage(phone(), "Hello");
    expect(await post(envelope({ messages: [msg] }), { secret: "some-other-app-secret-000" })).toMatchObject({ status: 401, events: [] });
    expect(await post(envelope({ messages: [msg] }), { signature: null })).toMatchObject({ status: 401 });
    expect(await post(envelope({ messages: [msg] }), { signature: "sha256=00" })).toMatchObject({ status: 401 });
    const raw = JSON.stringify(envelope({ messages: [msg] }));
    expect(await handleMetaWebhook(raw.replace("Hello", "Hello, what are your prices?"), { "x-hub-signature-256": sign(APP_SECRET, raw) })).toMatchObject({ status: 401 });
    expect((await messagesFor(msg.id)).rows).toHaveLength(0);
    expect((await receipts(msg.id)).rows).toHaveLength(0);
    delete process.env.META_APP_SECRET;
    resetEnvCache();
    try {
      expect(await post(envelope({ messages: [msg] }))).toMatchObject({ status: 503 });
    } finally {
      process.env.META_APP_SECRET = APP_SECRET;
      resetEnvCache();
    }
    expect(await handleMetaWebhook("not json", { "x-hub-signature-256": sign(APP_SECRET, "not json") })).toMatchObject({ status: 400 });
    expect(await post({ object: "page", entry: [] })).toMatchObject({ status: 200, events: [{ outcome: "ignored" }] });
  });

  it("handles every event of a batch on its own: two numbers, an unknown number, a stray status", async () => {
    const a = textMessage(phone(), "First customer");
    const b = textMessage(phone(), "Second customer");
    const other = textMessage(phone(), "Customer of the other workspace");
    const stranger = textMessage(phone(), "To a number nobody connected");
    const stray = statusEvent(wamid(), "delivered");
    const payload = envelope(
      { messages: [a, b], statuses: [stray] },
      { phoneNumberId: PHONE_ID_2, waba: WABA_2, messages: [other] },
      { phoneNumberId: "555555555555555", messages: [stranger] },
    );
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(res.events.filter((e) => e.outcome === "processed")).toHaveLength(3);
    expect(res.events.find((e) => e.kind === "status")).toMatchObject({ outcome: "ignored", detail: "unknown_message" });
    expect(res.events.filter((e) => e.detail === "The phone number isn't connected to a workspace.")).toHaveLength(1);
    expect((await messagesFor(a.id)).rows[0].org_id).toBe(m.org.id);
    expect((await messagesFor(b.id)).rows[0].org_id).toBe(m.org.id);
    expect((await messagesFor(other.id)).rows[0].org_id).toBe(m2.org.id);
    expect((await messagesFor(stranger.id)).rows).toHaveLength(0);
    expect((await receipts(stranger.id)).rows).toHaveLength(0);

    // Meta retries the whole batch: everything already recorded is a duplicate and nothing is stored twice.
    const replay = await post(payload);
    expect(replay.status).toBe(200);
    expect(replay.events.filter((e) => e.outcome === "processed")).toHaveLength(0);
    expect(replay.events.filter((e) => e.outcome === "duplicate")).toHaveLength(4);
    expect(replay.respond).toEqual([]);
    expect((await messagesFor(a.id)).rows).toHaveLength(1);
  });

  it("answers 500 when one event fails, keeps the others, and processes the failed one when Meta retries", async () => {
    const good = textMessage(phone(), "This one is fine");
    const bad = textMessage(phone(), "This one hits a database error", { id: `wamid.FAILME${crypto.randomBytes(12).toString("hex")}` });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withSystem((db) => db.query("alter table webhook_receipts add constraint test_whatsapp_fail check (external_id not like 'inbound:wamid.FAILME%')"));
    let first: Awaited<ReturnType<typeof handleMetaWebhook>>;
    try {
      first = await post(envelope({ messages: [good, bad] }));
    } finally {
      await withSystem((db) => db.query("alter table webhook_receipts drop constraint test_whatsapp_fail"));
    }
    expect(first).toMatchObject({ status: 500, events: [{ kind: "inbound", outcome: "processed" }, { kind: "inbound", outcome: "failed" }] });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("hits a database error");
    expect((await messagesFor(good.id)).rows).toHaveLength(1);
    expect((await messagesFor(bad.id)).rows).toHaveLength(0);
    const retry = await post(envelope({ messages: [good, bad] }));
    expect(retry).toMatchObject({ status: 200, events: [{ outcome: "duplicate" }, { outcome: "processed" }] });
    expect((await messagesFor(bad.id)).rows).toHaveLength(1);
  });

  it("ignores a number recorded under a different WhatsApp Business Account, username-only senders and reactions", async () => {
    const wrongAccount = textMessage(phone(), "Hi");
    expect((await post(envelope({ waba: WABA_2, messages: [wrongAccount] }))).events[0]).toMatchObject({ outcome: "ignored" });
    expect((await messagesFor(wrongAccount.id)).rows).toHaveLength(0);
    const usernameOnly = { id: wamid(), from_user_id: "US.13491208655302741918", timestamp: String(nowSeconds()), type: "text", text: { body: "Hello" } };
    expect((await post(envelope({ messages: [usernameOnly] }))).events[0]).toMatchObject({ outcome: "ignored", detail: expect.stringMatching(/username/) });
    const reaction = { from: "639170001234", id: wamid(), timestamp: String(nowSeconds()), type: "reaction", reaction: { message_id: wamid(), emoji: "👍" } };
    expect((await post(envelope({ messages: [reaction] }))).events[0]).toMatchObject({ outcome: "ignored" });
    expect((await messagesFor(reaction.id)).rows).toHaveLength(0);
    expect((await post(envelope({ errors: [{ code: 131000, title: "Something went wrong" }] }))).events[0]).toMatchObject({ outcome: "ignored" });
  });

  it("records a photo as a note with its caption and never fetches the media", async () => {
    const calls = stubFetch(() => json({}));
    const customer = phone();
    const photo = { from: customer.slice(1), id: wamid(), timestamp: String(nowSeconds()), type: "image", image: { caption: "Is this tooth OK?", mime_type: "image/jpeg", sha256: "abc", id: "1479537139650973", url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1" } };
    expect((await post(envelope({ messages: [photo] }))).events[0]).toMatchObject({ outcome: "processed" });
    expect((await messagesFor(photo.id)).rows[0].body).toBe("Is this tooth OK?\n\n[Photo received. Media isn't downloaded or shown in the inbox yet.]");
    expect(calls).toHaveLength(0);
  });

  it("STOP over WhatsApp suppresses the number and stops the AI's pending reply", async () => {
    const { customer, conversationId } = await inboundConversation();
    const pending = await queueAi(conversationId);
    expect(pending.status).toBe("queued");
    const stop = await post(envelope({ messages: [{ from: customer.slice(1), id: wamid(), timestamp: String(nowSeconds()), type: "button", button: { payload: "Unsubscribe", text: "Unsubscribe" } }] }));
    expect(stop.events[0]).toMatchObject({ outcome: "processed" });
    expect(stop.respond).toEqual([]);
    const supp = await withSystem((db) => db.query<{ reason: string }>("select reason from suppressions where org_id = $1 and channel = 'whatsapp' and address = $2 and lifted_at is null", [m.org.id, customer]));
    expect(supp.rows).toEqual([{ reason: "opt_out" }]);
    expect(await messageRow(pending.messageId!)).toMatchObject({ status: "blocked", blocked_reason: "suppressed" });
  });

  it("free-form text goes only while the window is open; outside it the core requires a template and the transport sends it as one", async () => {
    const { customer, conversationId } = await inboundConversation(phone(), "Can you remind me about my visit?");
    const reply = await queueAi(conversationId, "Of course, I'll remind you the day before.");
    expect(reply.status).toBe("queued");
    const replyId = wamid();
    const calls = stubFetch(() => accepted(replyId, customer));
    expect(await dispatchMessage(reply.messageId!)).toEqual({ status: "sent" });
    expect(calls[0].body).toMatchObject({ to: customer, type: "text", text: { body: "Of course, I'll remind you the day before." }, biz_opaque_callback_data: reply.messageId });
    expect(await messageRow(reply.messageId!)).toMatchObject({ status: "sent", provider: "meta_whatsapp", provider_message_id: replyId });

    // 25 hours later the window has closed.
    await withSystem((db) => db.query("update conversations set last_inbound_at = now() - interval '25 hours' where id = $1", [conversationId]));
    const late = await queueAi(conversationId, "Just checking in about your visit.");
    expect(late).toMatchObject({ status: "blocked", reason: "whatsapp_window_closed" });
    const templated = await withSystem((db) =>
      queueOutbound(db, { orgId: m.org.id, conversationId, scope: "human", actor: { kind: "human", userId: m.people.owner.id }, body: "Hi Maria, your visit is on Friday at 10am.", templateId: "900001" }),
    );
    expect(templated.status).toBe("queued");
    const templateCalls = stubFetch(() => accepted(wamid(), customer));
    expect(await dispatchMessage(templated.messageId)).toEqual({ status: "sent" });
    expect(templateCalls[0].body).toMatchObject({
      type: "template",
      template: { name: "appointment_reminder", language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "Maria" }, { type: "text", text: "Friday at 10am" }] }] },
      biz_opaque_callback_data: templated.messageId,
    });
  });

  it("matches a status that arrives before the send returned by biz_opaque_callback_data, and moves delivery forward only", async () => {
    const { conversationId } = await inboundConversation();
    const queued = await queueAi(conversationId);
    const id = wamid();
    let early: Awaited<ReturnType<typeof handleMetaWebhook>> | null = null;
    stubFetch(async (c) => {
      expect(c.body?.biz_opaque_callback_data).toBe(queued.messageId);
      early = await post(envelope({ statuses: [statusEvent(id, "delivered", { biz_opaque_callback_data: queued.messageId })] }));
      return accepted(id);
    });
    expect(await dispatchMessage(queued.messageId!)).toEqual({ status: "sent" });
    expect(early).toMatchObject({ status: 200, events: [{ kind: "status", outcome: "processed", orgId: m.org.id }] });
    const row = await messageRow(queued.messageId!);
    expect(row).toMatchObject({ status: "delivered", provider: "meta_whatsapp", provider_message_id: id });
    expect(row.delivered_at).not.toBeNull();

    const send = (status: string, over: Record<string, unknown> = {}) => post(envelope({ statuses: [statusEvent(id, status, { biz_opaque_callback_data: queued.messageId, ...over })] }));
    expect((await send("read")).events[0]).toMatchObject({ outcome: "processed" });
    expect((await messageRow(queued.messageId!)).status).toBe("read");
    expect((await send("sent", { pricing: { billable: false, pricing_model: "PMP", type: "free_customer_service", category: "service" } })).events[0]).toMatchObject({ outcome: "ignored", detail: "no_change" });
    expect((await send("failed", { errors: [{ code: 131026, title: "Message undeliverable" }] })).events[0]).toMatchObject({ outcome: "ignored" });
    expect((await send("read")).events[0]).toMatchObject({ outcome: "duplicate" });
    expect((await send("played")).events[0]).toMatchObject({ outcome: "ignored", detail: expect.stringMatching(/not a delivery update/) });
    expect((await messageRow(queued.messageId!)).status).toBe("read");
    const events = await withSystem((db) => db.query<{ status: string; raw_status: string; detail: string | null }>("select status, raw_status, detail from message_delivery_events where message_id = $1 order by id", [queued.messageId]));
    expect(events.rows.map((e) => [e.status, e.raw_status])).toEqual([["delivered", "delivered"], ["read", "read"], ["sent", "sent"], ["failed", "failed"]]);
    expect(events.rows[2].detail).toBe("Meta pricing category: service (free_customer_service).");
    expect(events.rows[3].detail).toMatch(/\(WhatsApp 131026\)/);
  });

  it("falls back to the wamid without callback data, and never lets another workspace's webhook touch this workspace's message", async () => {
    const { conversationId } = await inboundConversation();
    const queued = await queueAi(conversationId);
    const id = wamid();
    stubFetch(() => accepted(id));
    await dispatchMessage(queued.messageId!);
    // Workspace 2's number reporting our message id (and our wamid): ignored.
    const foreign = await post(envelope({ phoneNumberId: PHONE_ID_2, waba: WABA_2, statuses: [statusEvent(id, "read", { biz_opaque_callback_data: queued.messageId })] }));
    expect(foreign.events[0]).toMatchObject({ outcome: "ignored", orgId: m2.org.id });
    expect((await messageRow(queued.messageId!)).status).toBe("sent");
    // Our own number, no callback data: matched by the wamid.
    expect((await post(envelope({ statuses: [statusEvent(id, "delivered")] }))).events[0]).toMatchObject({ outcome: "processed" });
    expect((await messageRow(queued.messageId!)).status).toBe("delivered");
  });

  it("a failed status with 131050 fails the message and withdraws marketing consent only", async () => {
    const { conversationId } = await inboundConversation();
    const queued = await queueAi(conversationId);
    const id = wamid();
    stubFetch(() => accepted(id));
    await dispatchMessage(queued.messageId!);
    const res = await post(envelope({ statuses: [statusEvent(id, "failed", { biz_opaque_callback_data: queued.messageId, errors: [{ code: 131050, title: "Unable to deliver the message.", message: "Unable to deliver", error_data: { details: "stopped marketing" } }] })] }));
    expect(res.events[0]).toMatchObject({ outcome: "processed" });
    const row = await messageRow(queued.messageId!);
    expect(row).toMatchObject({ status: "failed" });
    expect(String(row.status_detail)).toMatch(/stopped marketing messages.*131050/);
    const consent = await withSystem((db) =>
      db.query<{ purpose: string; status: string }>(
        "select distinct on (purpose) purpose, status from contact_consent_events where org_id = $1 and channel = 'whatsapp' and contact_id = (select contact_id from conversations where id = $2) order by purpose, id desc",
        [m.org.id, conversationId],
      ),
    );
    expect(consent.rows).toEqual([{ purpose: "marketing", status: "revoked" }, { purpose: "service", status: "granted" }]);
    const supp = await withSystem((db) => db.query("select 1 from suppressions where org_id = $1 and channel = 'whatsapp' and lifted_at is null and address = (select value from contact_identities where contact_id = (select contact_id from conversations where id = $2) and kind = 'phone' limit 1)", [m.org.id, conversationId]));
    expect(supp.rows).toHaveLength(0);
  });

  it("the route answers the handshake, refuses unsigned posts, caps the body and schedules the AI reply after responding", async () => {
    const get = await routeGet(new Request(`${BASE}/api/webhooks/meta-whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=987654321`));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("987654321");
    expect(get.headers.get("content-type")).toMatch(/^text\/plain/);
    expect((await routeGet(new Request(`${BASE}/api/webhooks/meta-whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`))).status).toBe(403);

    const unsigned = await routePost(new Request(`${BASE}/api/webhooks/meta-whatsapp`, { method: "POST", body: JSON.stringify(envelope({ messages: [textMessage(phone(), "Hi")] })), headers: { "content-type": "application/json" } }));
    expect(unsigned.status).toBe(401);
    const huge = await routePost(new Request(`${BASE}/api/webhooks/meta-whatsapp`, { method: "POST", body: "x".repeat(1_000_001), headers: { "content-type": "application/json" } }));
    expect(huge.status).toBe(413);

    scheduled.after.length = 0;
    const raw = JSON.stringify(envelope({ messages: [textMessage(phone(), "Hello from the route")] }));
    const ok = await routePost(new Request(`${BASE}/api/webhooks/meta-whatsapp`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sign(APP_SECRET, raw) } }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("OK");
    expect(scheduled.after).toHaveLength(1);
  });
});

describe("template sync", () => {
  const tpl = (over: Record<string, unknown>) => ({
    name: "visit_reminder",
    parameter_format: "POSITIONAL",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    id: "1000001",
    components: [
      { type: "BODY", text: "Hi {{1}}, your visit is on {{2}}.", example: { body_text: [["Pablo", "Friday"]] } },
      { type: "FOOTER", text: "WhatsApp Clinic" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Unsubscribe" }, { type: "URL", text: "Directions", url: "https://clinic.example/map" }] },
    ],
    ...over,
  });
  const page1 = [
    tpl({}),
    tpl({ id: "1000002", name: "spring_promo", status: "PAUSED", category: "MARKETING", components: [{ type: "BODY", text: "20% off this spring!" }] }),
    tpl({ id: "1000003", name: "bad_template", status: "REJECTED", rejected_reason: "INVALID_FORMAT", components: [{ type: "BODY", text: "{{1}}{{2}}" }] }),
    tpl({ id: "1000004", name: "old_offer", status: "DISABLED", category: "MARKETING", components: [{ type: "BODY", text: "Old offer" }] }),
  ];
  const page2 = [
    tpl({ id: "1000005", name: "photo_header", components: [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.whatsapp.net/v/t61"] } }, { type: "BODY", text: "See our new clinic" }] }),
    tpl({ id: "1000006", name: "named_values", parameter_format: "NAMED", components: [{ type: "BODY", text: "Thank you, {{first_name}}!", example: { body_text_named_params: [{ param_name: "first_name", example: "Pablo" }] } }] }),
    tpl({ id: "1000007", name: "new_draft", status: "PENDING", components: [{ type: "BODY", text: "Coming soon" }] }),
    tpl({ id: "1000008", name: "x".repeat(130) }),
    tpl({ id: "1000009", name: "otp_code", category: "AUTHENTICATION", components: [{ type: "BODY", text: "{{1}} is your verification code." }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] }] }),
  ];
  const pages = (first: unknown[], second: unknown[] | Response) => (c: FetchCall) => {
    if (c.url.pathname !== `/v26.0/${WABA}/message_templates`) return graphError(404, 100);
    if (c.url.searchParams.get("after") === "CURSOR2") return second instanceof Response ? second : json({ data: second, paging: { cursors: { before: "B2", after: "END" } } });
    return json({ data: first, paging: { cursors: { before: "B1", after: "CURSOR2" }, next: `${GRAPH}/${WABA}/message_templates?after=CURSOR2` } });
  };
  const rows = () =>
    withSystem((db) =>
      db.query<{ template_id: string; name: string; status: string; category: string | null; variables: unknown; components: unknown; rejection_reason: string | null; body: string; provider: string }>(
        "select template_id, name, status, category, variables, components, rejection_reason, body, provider from whatsapp_templates where org_id = $1 and template_id like '10000%' order by template_id",
        [m.org.id],
      ),
    );

  it("maps statuses: approved only when sendable; paused/pending wait; rejected, disabled and unsendable templates are refused with the reason", () => {
    expect(mapMetaTemplateStatus("APPROVED")).toEqual({ status: "approved", reason: null });
    expect(mapMetaTemplateStatus("PAUSED").status).toBe("pending");
    expect(mapMetaTemplateStatus("IN_APPEAL").status).toBe("pending");
    expect(mapMetaTemplateStatus("PENDING")).toEqual({ status: "pending", reason: null });
    expect(mapMetaTemplateStatus("REJECTED", "INCORRECT_CATEGORY")).toEqual({ status: "rejected", reason: "Rejected by Meta: the content doesn't match the template's category." });
    expect(mapMetaTemplateStatus("DISABLED").status).toBe("rejected");
    expect(mapMetaTemplateStatus("ARCHIVED").status).toBe("rejected");
    expect(mapMetaTemplateStatus("SOMETHING_NEW").status).toBe("rejected");
    expect(templateVariables([{ type: "HEADER", format: "TEXT", text: "Act fast, {{1}}!", example: { header_text: ["Pablo"] } }, { type: "BODY", text: "Code {{1}} expires in {{2}} days", example: { body_text: [["SUMMER20", "10"]] } }], "POSITIONAL")).toEqual([
      { position: 1, label: "Header {{1}} (e.g. Pablo)", component: "header" },
      { position: 2, label: "{{1}} (e.g. SUMMER20)", component: "body" },
      { position: 3, label: "{{2}} (e.g. 10)", component: "body" },
    ]);
    expect(mapMetaTemplate({ id: "1", name: "x", language: "en", status: "APPROVED", components: [{ type: "HEADER", format: "TEXT", text: "Hi {{1}}" }, { type: "BODY", text: "Body" }] })).toMatchObject({ status: "rejected", rejectionReason: expect.stringMatching(/header has a value/) });
  });

  it("mirrors every page into whatsapp_templates, reading only, and is idempotent", async () => {
    const calls = stubFetch(pages(page1, page2));
    const first = await syncWhatsappTemplates(m.org.id);
    expect(first).toEqual({ ok: true, fetched: 9, saved: 8, skipped: 1, retired: expect.any(Number), approved: 1 });
    expect(calls.every((c) => c.method === "GET" && c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls[0].url.searchParams.get("fields")).toBe("id,name,language,status,category,components,rejected_reason,parameter_format");
    expect(calls.map((c) => c.url.searchParams.get("after"))).toEqual([null, "CURSOR2"]);

    const saved = (await rows()).rows;
    const byId = Object.fromEntries(saved.map((r) => [r.template_id, r]));
    expect(saved.map((r) => r.template_id)).toEqual(["1000001", "1000002", "1000003", "1000004", "1000005", "1000006", "1000007", "1000009"]);
    expect(byId["1000001"]).toMatchObject({ name: "visit_reminder", status: "approved", category: "utility", provider: "meta_whatsapp", body: "Hi {{1}}, your visit is on {{2}}.", rejection_reason: null });
    expect(byId["1000001"].variables).toEqual([{ position: 1, label: "{{1}} (e.g. Pablo)", component: "body" }, { position: 2, label: "{{2}} (e.g. Friday)", component: "body" }]);
    expect(JSON.stringify(byId["1000001"].components)).not.toContain('"example"');
    expect(byId["1000002"]).toMatchObject({ status: "pending", category: "marketing", rejection_reason: expect.stringMatching(/Paused/) });
    expect(byId["1000003"]).toMatchObject({ status: "rejected", rejection_reason: "Rejected by Meta: the template's format is invalid." });
    expect(byId["1000004"]).toMatchObject({ status: "rejected", rejection_reason: expect.stringMatching(/Disabled/) });
    expect(byId["1000005"]).toMatchObject({ status: "rejected", rejection_reason: expect.stringMatching(/image header/) });
    expect(byId["1000006"]).toMatchObject({ status: "rejected", rejection_reason: expect.stringMatching(/named values/) });
    expect(byId["1000006"].variables).toEqual([{ position: 1, label: "first_name (e.g. Pablo)", component: "body", name: "first_name" }]);
    expect(byId["1000007"]).toMatchObject({ status: "pending" });
    expect(byId["1000009"]).toMatchObject({ status: "rejected", category: "authentication", rejection_reason: expect.stringMatching(/otp button/) });

    stubFetch(pages(page1, page2));
    const second = await syncWhatsappTemplates(m.org.id);
    expect(second).toMatchObject({ ok: true, fetched: 9, saved: 8, retired: 0 });
    expect((await rows()).rows).toEqual(saved);
  });

  it("never overwrites a GoHighLevel template with the same id, and marks templates that left the account as not sendable", async () => {
    await withSystem((db) => db.query("insert into whatsapp_templates (org_id, template_id, name, status) values ($1, '1000004', 'ghl copy', 'approved') on conflict (org_id, template_id) do update set provider = 'ghl', name = 'ghl copy', status = 'approved'", [m.org.id]));
    // Meta still lists 1000004 (now a GoHighLevel row here) and has dropped everything on the second page.
    stubFetch(pages(page1, []));
    const r = await syncWhatsappTemplates(m.org.id);
    expect(r).toMatchObject({ ok: true, fetched: 4, saved: 3, skipped: 1 });
    const byId = Object.fromEntries((await rows()).rows.map((x) => [x.template_id, x]));
    expect(byId["1000004"]).toMatchObject({ provider: "ghl", name: "ghl copy", status: "approved" });
    expect(byId["1000001"].status).toBe("approved");
    expect(byId["1000002"]).toMatchObject({ status: "pending", rejection_reason: expect.stringMatching(/Paused/) });
    for (const id of ["1000005", "1000006", "1000007", "1000009"]) expect(byId[id]).toMatchObject({ status: "rejected", rejection_reason: expect.stringMatching(/No longer in the WhatsApp Business Account/) });
    // The GoHighLevel template of the default fixture is untouched.
    const ghl = await withSystem((db) => db.query<{ status: string; provider: string }>("select status, provider from whatsapp_templates where org_id = $1 and template_id = 'tmpl_followup'", [m.org.id]));
    expect(ghl.rows[0]).toEqual({ status: "approved", provider: "ghl" });
    await withSystem((db) => db.query("delete from whatsapp_templates where org_id = $1 and template_id = '1000004'", [m.org.id]));
  });

  it("changes nothing when a page fails or the token is rejected, and reports a workspace that isn't connected", async () => {
    stubFetch(pages(page1, page2));
    await syncWhatsappTemplates(m.org.id);
    const before = (await rows()).rows;
    stubFetch(pages([], graphError(500, 1)));
    expect(await syncWhatsappTemplates(m.org.id)).toMatchObject({ ok: false, reason: "provider_error" });
    stubFetch(() => graphError(401, 190));
    expect(await syncWhatsappTemplates(m.org.id)).toMatchObject({ ok: false, reason: "reconnect_required", detail: expect.stringMatching(/WhatsApp 190/) });
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await syncWhatsappTemplates(m.org.id)).toMatchObject({ ok: false, reason: "provider_error" });
    expect((await rows()).rows).toEqual(before);
    const ghlOnly = await messagingOrg({ name: "GoHighLevel WhatsApp" });
    expect(await syncWhatsappTemplates(ghlOnly.org.id)).toMatchObject({ ok: false, reason: "not_connected" });
  });

  it("runs for every connected workspace from the scheduled tick", async () => {
    expect(JOBS.map((j) => j.name)).toContain("whatsappTemplateSync");
    const calls = stubFetch((c) => json({ data: c.url.pathname.includes(WABA_2) ? [] : [tpl({})], paging: { cursors: {} } }));
    expect(await syncAllWhatsappTemplates()).toEqual({ synced: 2, failed: 0 });
    expect(new Set(calls.map((c) => c.url.pathname))).toEqual(new Set([`/v26.0/${WABA}/message_templates`, `/v26.0/${WABA_2}/message_templates`]));
    expect(calls.find((c) => c.url.pathname.includes(WABA_2))?.headers.Authorization).toBe(`Bearer ${TOKEN_2}`);
  });

  it("a template status webhook pauses a template at once and asks for a full sync; an approval only asks for the sync", async () => {
    stubFetch(pages(page1, page2));
    await syncWhatsappTemplates(m.org.id);
    const event = (ev: string, time: number) => ({
      object: "whatsapp_business_account",
      entry: [{ id: WABA, time, changes: [{ field: "message_template_status_update", value: { event: ev, message_template_id: 1000001, message_template_name: "visit_reminder", message_template_language: "en_US", reason: "NONE" } }] }],
    });
    const paused = await post(event("PAUSED", 1751234563));
    expect(paused).toMatchObject({ status: 200, templateSync: [m.org.id], events: [{ kind: "template", outcome: "processed" }] });
    const row = (await rows()).rows.find((r) => r.template_id === "1000001");
    expect(row).toMatchObject({ status: "pending", rejection_reason: expect.stringMatching(/Paused/) });
    expect((await post(event("PAUSED", 1751234563))).events[0]).toMatchObject({ outcome: "duplicate" });
    const approved = await post(event("APPROVED", 1751239999));
    expect(approved).toMatchObject({ templateSync: [m.org.id] });
    expect((await rows()).rows.find((r) => r.template_id === "1000001")?.status).toBe("pending");
    // The route runs the sync after responding.
    scheduled.after.length = 0;
    const raw = JSON.stringify(event("REINSTATED", 1751240000));
    const res = await routePost(new Request(`${BASE}/api/webhooks/meta-whatsapp`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sign(APP_SECRET, raw) } }));
    expect(res.status).toBe(200);
    expect(scheduled.after).toHaveLength(1);
    stubFetch(pages(page1, page2));
    await scheduled.after[0]();
    expect((await rows()).rows.find((r) => r.template_id === "1000001")?.status).toBe("approved");
  });
});
