// Twilio SMS transport, capability test and webhooks. Every Twilio call is a mocked fetch; nothing leaves the machine and no message is sent.
import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { publishUnitRate } from "@/server/billing/service";
import { saveCredential } from "@/server/security/credentials";
import { dispatchMessage, queueOutbound } from "@/server/messaging/send";
import {
  describeTwilioError,
  handleTwilioWebhook,
  parseTwilioForm,
  parseTwilioSecret,
  resetTwilioWebhookCache,
  testTwilioCapability,
  twilioSecretJson,
  twilioSignature,
  twilioStatusCallbackUrl,
  twilioTransport,
  twilioWebhookUrl,
  verifyTwilioSignature,
} from "@/server/messaging/transports/twilio";
import type { TransportSendRequest } from "@/server/messaging/transports/types";
import { GET as routeGet, POST as routePost } from "@/app/api/webhooks/twilio/[kind]/route";
import { messageRow, messagingOrg, phone, type MessagingOrg } from "./support/messaging";

// The route schedules the AI reply with next/server's after(), which needs a live request scope. Here it is only recorded, never run, so no
// reply is prepared and nothing is dispatched by the route tests.
const scheduled = vi.hoisted(() => ({ after: [] as Array<() => unknown> }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => unknown) => void scheduled.after.push(fn) }));

const BASE = "https://portal.example.com";
const ACCOUNT = `AC${"a1".repeat(16)}`;
const TOKEN = "0123456789abcdef0123456789abcdef";
const SERVICE = `MG${"b2".repeat(16)}`;
const POOL_NUMBER = "+639171230000";
const ACCOUNT_2 = `AC${"c3".repeat(16)}`;
const TOKEN_2 = "fedcba9876543210fedcba9876543210";
const NUMBER_2 = "+447700900123";
const KEY_SID = `SK${"d4".repeat(16)}`;
const KEY_SECRET = "keysecret-0123456789abcdef";

const sid = (prefix: "SM" | "MM" = "SM") => `${prefix}${crypto.randomBytes(16).toString("hex")}`;

/** The documented algorithm, written out independently of the implementation: HMAC-SHA1 over the URL plus sorted name+value pairs. */
const sign = (token: string, url: string, params: Record<string, string>) =>
  crypto.createHmac("sha1", token).update(url + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");

type Hook = { kind: "inbound" | "status"; params: Record<string, string>; token?: string; signedUrl?: string; requestUrl?: string; headers?: Record<string, string>; tamper?: (p: Record<string, string>) => Record<string, string> };
async function hook(h: Hook) {
  const path = `/api/webhooks/twilio/${h.kind}`;
  const signedUrl = h.signedUrl ?? `${BASE}${path}`;
  const query = signedUrl.includes("?") ? signedUrl.slice(signedUrl.indexOf("?")) : "";
  const signature = sign(h.token ?? TOKEN, signedUrl, h.params);
  const sent = h.tamper ? h.tamper({ ...h.params }) : h.params;
  // What the server sees as req.url is an internal address: it must never be what the signature is checked against.
  const requestUrl = h.requestUrl ?? `http://10.0.0.7:3000${path}${query}`;
  return handleTwilioWebhook(h.kind, new URLSearchParams(sent).toString(), { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature, ...h.headers }, requestUrl);
}

const inboundParams = (from: string, body: string, extra: Record<string, string> = {}) => {
  const messageSid = sid();
  return { AccountSid: ACCOUNT, ApiVersion: "2010-04-01", Body: body, From: from, MessageSid: messageSid, MessagingServiceSid: SERVICE, NumMedia: "0", NumSegments: "1", SmsMessageSid: messageSid, SmsSid: messageSid, SmsStatus: "received", To: POOL_NUMBER, ...extra };
};
const statusParams = (messageSid: string, status: string, to: string, extra: Record<string, string> = {}) => ({
  AccountSid: ACCOUNT,
  ApiVersion: "2010-04-01",
  From: POOL_NUMBER,
  MessageSid: messageSid,
  MessageStatus: status,
  MessagingServiceSid: SERVICE,
  SmsSid: messageSid,
  SmsStatus: status,
  To: to,
  ...extra,
});

let m: MessagingOrg;
let m2: MessagingOrg;
let credentialId: string;
let keyCredentialId: string;

async function connectTwilio(org: MessagingOrg, opts: { senderId: string; accountSid: string; secret: string; identity: string }) {
  return withSystem(async (db) => {
    const saved = await saveCredential(db, { orgId: org.org.id, provider: "twilio", label: "Twilio (synthetic test)", secret: opts.secret, actorId: org.superAdmin.id });
    await db.query(
      `update messaging_channels set provider = 'twilio', provider_sender_id = $2, provider_account_id = $3, credential_id = $4, sender_identity = $5,
         capability_test = '{"ok":true}'::jsonb, capability_tested_at = now() where org_id = $1 and channel = 'sms'`,
      [org.org.id, opts.senderId, opts.accountSid, saved.id, opts.identity],
    );
    return saved.id;
  });
}

beforeAll(async () => {
  process.env.TWILIO_WRITES_ENABLED = "true";
  process.env.TWILIO_WEBHOOK_BASE_URL = BASE;
  resetEnvCache();
  m = await messagingOrg({ name: "Twilio SMS Co" });
  m2 = await messagingOrg({ name: "Other Twilio Co" });
  credentialId = await connectTwilio(m, { senderId: SERVICE, accountSid: ACCOUNT, secret: twilioSecretJson({ accountSid: ACCOUNT, authToken: TOKEN }), identity: POOL_NUMBER });
  await connectTwilio(m2, { senderId: NUMBER_2, accountSid: ACCOUNT_2, secret: twilioSecretJson({ accountSid: ACCOUNT_2, authToken: TOKEN_2 }), identity: NUMBER_2 });
  keyCredentialId = await withSystem(async (db) => (await saveCredential(db, { orgId: m.org.id, provider: "twilio", label: "Twilio API key (synthetic)", secret: twilioSecretJson({ accountSid: ACCOUNT, authToken: TOKEN, apiKeySid: KEY_SID, apiKeySecret: KEY_SECRET }), actorId: m.superAdmin.id })).id);
  await publishUnitRate(m.superAdmin, { provider: "twilio", unitType: "sms_segment", wholesaleMicrosPerUnit: 7900 });
});
afterAll(() => {
  delete process.env.TWILIO_WRITES_ENABLED;
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  resetEnvCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetTwilioWebhookCache();
});

type FetchCall = { url: URL; method: string; headers: Record<string, string>; form: URLSearchParams | null };
function stubFetch(answer: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit = {}) => {
    const call: FetchCall = { url: new URL(String(input)), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, form: typeof init.body === "string" ? new URLSearchParams(init.body) : null };
    calls.push(call);
    // A canned Response may answer several calls (the same path asked twice): hand out a copy so its body can be read each time.
    return (await answer(call)).clone();
  });
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const created = (over: Record<string, unknown> = {}) => json({ sid: sid(), status: "accepted", num_segments: "0", error_code: null, error_message: null, ...over }, 201);

const sendReq = (over: Partial<TransportSendRequest> = {}): TransportSendRequest => ({
  orgId: m.org.id,
  channel: "sms",
  messageId: crypto.randomUUID(),
  to: "+639175550101",
  contactRef: null,
  body: "Thanks for reaching out. We have room on Thursday.",
  sender: { identity: POOL_NUMBER, senderId: SERVICE, accountId: ACCOUNT, credentialId },
  ...over,
});

const queueAi = (org: MessagingOrg, conversationId: string, body = "We have a slot on Thursday at 10am. Shall I hold it?") =>
  withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body }));

// ---------------------------------------------------------------------------

describe("signatures", () => {
  it("matches Twilio's own published validation vectors (twilio-node spec/validation.spec.js)", () => {
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = { CallSid: "CA1234567890ABCDE", Caller: "+14158675309", Digits: "1234", From: "+14158675309", To: "+18005551212" };
    expect(twilioSignature("12345", url, params)).toBe("RSOYDt4T1cUTdK1PDd93/VVr8B8=");
    expect(sign("12345", url, params)).toBe("RSOYDt4T1cUTdK1PDd93/VVr8B8=");
    const form = parseTwilioForm(new URLSearchParams(params).toString());
    expect(verifyTwilioSignature("12345", "RSOYDt4T1cUTdK1PDd93/VVr8B8=", url, form)).toBe(true);
    // The SDK accepts the signed URL with a port added or removed.
    expect(verifyTwilioSignature("12345", "RSOYDt4T1cUTdK1PDd93/VVr8B8=", url.replace(".com", ".com:1234"), form)).toBe(true);
    // Repeated names: values de-duplicated and sorted.
    const repeated = new URLSearchParams([["MessagingBinding.Address", "+1415xxxxxxx"], ["MessagingBinding.Address", "+1325xxxxxxx"]]).toString();
    expect(twilioSignature("12345", url, parseTwilioForm(repeated))).toBe("83O6e2vORAoJHUNzJjDWN1jz+BA=");
    const digits = new URLSearchParams([["Sid", "CA123"], ["SidAccount", "AC123"], ["Digits", "5678"], ["Digits", "1234"], ["Digits", "1234"]]).toString();
    expect(twilioSignature("12345", url, parseTwilioForm(digits))).toBe("IK+Dwps556ElfBT0I3Rgjkr1wJU=");
  });

  it("rejects a wrong token, a tampered parameter, a different URL and a missing signature", () => {
    const url = `${BASE}/api/webhooks/twilio/inbound`;
    const params = { AccountSid: ACCOUNT, Body: "Hi", From: "+639175550000", MessageSid: sid(), To: POOL_NUMBER };
    const form = parseTwilioForm(new URLSearchParams(params).toString());
    const good = sign(TOKEN, url, params);
    expect(verifyTwilioSignature(TOKEN, good, url, form)).toBe(true);
    expect(verifyTwilioSignature(TOKEN_2, good, url, form)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, good, url, parseTwilioForm(new URLSearchParams({ ...params, Body: "Hi!" }).toString()))).toBe(false);
    expect(verifyTwilioSignature(TOKEN, good, "https://attacker.example/api/webhooks/twilio/inbound", form)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, null, url, form)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, "", url, form)).toBe(false);
  });
});

describe("credentials", () => {
  it("stores the account SID and auth token (and optionally an API key) as one JSON secret, and refuses partial or malformed input", () => {
    expect(parseTwilioSecret(twilioSecretJson({ accountSid: ACCOUNT, authToken: TOKEN }))).toEqual({ accountSid: ACCOUNT, authToken: TOKEN, apiKeySid: null, apiKeySecret: null });
    expect(parseTwilioSecret(twilioSecretJson({ accountSid: ACCOUNT, authToken: TOKEN, apiKeySid: KEY_SID, apiKeySecret: KEY_SECRET }))).toMatchObject({ apiKeySid: KEY_SID });
    expect(() => twilioSecretJson({ accountSid: "AC123", authToken: TOKEN })).toThrow(/Account SID/);
    expect(() => twilioSecretJson({ accountSid: ACCOUNT, authToken: "short" })).toThrow(/Auth Token/);
    expect(() => twilioSecretJson({ accountSid: ACCOUNT, authToken: TOKEN, apiKeySid: KEY_SID })).toThrow(/both/);
    // An API key alone cannot verify webhooks, so the auth token is always required.
    expect(parseTwilioSecret(JSON.stringify({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: KEY_SECRET }))).toBeNull();
    expect(parseTwilioSecret("not json")).toBeNull();
    expect(parseTwilioSecret(JSON.stringify({ accountSid: ACCOUNT, authToken: TOKEN, apiKeySid: "SK1", apiKeySecret: KEY_SECRET }))).toBeNull();
  });
});

describe("sending", () => {
  it("posts To, MessagingServiceSid, Body and a StatusCallback carrying our message id, with basic auth to Twilio's API host", async () => {
    const calls = stubFetch(() => created({ num_segments: "2" }));
    const req = sendReq();
    const result = await twilioTransport.send(req);
    expect(result).toMatchObject({ ok: true, quantity: 2 });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url.toString()).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages.json`);
    expect(c.method).toBe("POST");
    expect(c.headers.Authorization).toBe(`Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64")}`);
    expect(c.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(c.form!)).toEqual({ To: req.to, MessagingServiceSid: SERVICE, Body: req.body, StatusCallback: `${BASE}/api/webhooks/twilio/status?mid=${req.messageId}` });
    expect(twilioTransport).toMatchObject({ name: "twilio", channels: ["sms"], requiresContactRef: false });
  });

  it("sends From for a number sender, uses a stored API key for REST calls, and reports no quantity while Twilio says 0 segments", async () => {
    const calls = stubFetch(() => created({ num_segments: "0" }));
    const result = await twilioTransport.send(sendReq({ sender: { identity: POOL_NUMBER, senderId: POOL_NUMBER, accountId: ACCOUNT, credentialId: keyCredentialId } }));
    expect(result).toMatchObject({ ok: true, quantity: null });
    expect(calls[0].form!.get("From")).toBe(POOL_NUMBER);
    expect(calls[0].form!.has("MessagingServiceSid")).toBe(false);
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from(`${KEY_SID}:${KEY_SECRET}`).toString("base64")}`);
  });

  it("builds webhook addresses from TWILIO_WEBHOOK_BASE_URL, falling back to APP_URL", () => {
    const id = crypto.randomUUID();
    expect(twilioWebhookUrl("inbound")).toBe(`${BASE}/api/webhooks/twilio/inbound`);
    expect(twilioStatusCallbackUrl(id)).toBe(`${BASE}/api/webhooks/twilio/status?mid=${id}`);
    const appUrl = process.env.APP_URL;
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
    process.env.APP_URL = "https://app.example.org/";
    resetEnvCache();
    try {
      expect(twilioStatusCallbackUrl(id)).toBe(`https://app.example.org/api/webhooks/twilio/status?mid=${id}`);
    } finally {
      if (appUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = appUrl;
      process.env.TWILIO_WEBHOOK_BASE_URL = BASE;
      resetEnvCache();
    }
  });

  it("sends nothing while the TWILIO_WRITES_ENABLED kill switch is off", async () => {
    const calls = stubFetch(() => created());
    process.env.TWILIO_WRITES_ENABLED = "false";
    resetEnvCache();
    try {
      expect(await twilioTransport.send(sendReq())).toMatchObject({ ok: false, blocked: true, retryable: false });
    } finally {
      process.env.TWILIO_WRITES_ENABLED = "true";
      resetEnvCache();
    }
    expect(calls).toHaveLength(0);
  });

  it("maps Twilio errors: 21610 suppresses as opt-out, 21211/21614 as invalid, bad credentials ask to reconnect, 429 is retryable", async () => {
    const answer = (status: number, code?: number) => () => json({ status, code, message: "Contains +639175550101", more_info: `https://www.twilio.com/docs/errors/${code}` }, status);
    stubFetch(answer(400, 21610));
    const optOut = await twilioTransport.send(sendReq());
    expect(optOut).toMatchObject({ ok: false, retryable: false, suppress: "opt_out" });
    expect(JSON.stringify(optOut)).not.toContain("+639175550101");
    stubFetch(answer(400, 21211));
    expect(await twilioTransport.send(sendReq())).toMatchObject({ ok: false, retryable: false, suppress: "invalid" });
    stubFetch(answer(400, 21614));
    expect(await twilioTransport.send(sendReq())).toMatchObject({ ok: false, suppress: "invalid" });
    stubFetch(answer(401, 20003));
    expect(await twilioTransport.send(sendReq())).toMatchObject({ ok: false, retryable: false, reconnectRequired: true });
    stubFetch(answer(429, 20429));
    expect(await twilioTransport.send(sendReq())).toMatchObject({ ok: false, retryable: true });
    stubFetch(answer(400, 30007));
    const filtered = await twilioTransport.send(sendReq());
    expect(filtered).toMatchObject({ ok: false, retryable: false });
    expect(filtered.ok === false && filtered.suppress).toBeFalsy();
    expect(describeTwilioError(30007)).toMatch(/carrier filtered.*\(Twilio 30007\)/);
    // A creation response that already says failed is a failure, never a send.
    stubFetch(() => created({ status: "failed", error_code: 21610 }));
    expect(await twilioTransport.send(sendReq())).toMatchObject({ ok: false, suppress: "opt_out" });
  });

  it("is at most once: a timeout or a 5xx is 'not confirmed sent' and not retryable", async () => {
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await twilioTransport.send(sendReq())).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/not confirmed sent/) });
    stubFetch(() => json({ status: 503, message: "unavailable" }, 503));
    expect(await twilioTransport.send(sendReq())).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/not confirmed sent/) });
    stubFetch(() => json({ status: "accepted" }, 201));
    expect(await twilioTransport.send(sendReq())).toMatchObject({ ok: false, error: "Twilio did not confirm the message." });
  });

  it("refuses before calling Twilio: no sender, a revoked credential, another account's credential, a bad number, an over-long body", async () => {
    const calls = stubFetch(() => created());
    expect(await twilioTransport.send(sendReq({ sender: { identity: null, senderId: null, accountId: null, credentialId: null } }))).toMatchObject({ ok: false, blocked: true, reconnectRequired: true });
    expect(await twilioTransport.send(sendReq({ sender: { identity: POOL_NUMBER, senderId: SERVICE, accountId: ACCOUNT_2, credentialId } }))).toMatchObject({ ok: false, blocked: true });
    expect(await twilioTransport.send(sendReq({ to: "09175550101" }))).toMatchObject({ ok: false, retryable: false });
    expect(await twilioTransport.send(sendReq({ body: "x".repeat(1601) }))).toMatchObject({ ok: false, error: expect.stringMatching(/1,600/) });
    expect(await twilioTransport.send(sendReq({ channel: "whatsapp" }))).toMatchObject({ ok: false, blocked: true });
    const other = await withSystem(async (db) => (await saveCredential(db, { orgId: m2.org.id, provider: "twilio", label: "Not yours", secret: twilioSecretJson({ accountSid: ACCOUNT, authToken: TOKEN }), actorId: m2.superAdmin.id })).id);
    expect(await twilioTransport.send(sendReq({ sender: { identity: POOL_NUMBER, senderId: SERVICE, accountId: ACCOUNT, credentialId: other } }))).toMatchObject({ ok: false, blocked: true, reconnectRequired: true });
    const revoked = await withSystem(async (db) => {
      const saved = await saveCredential(db, { orgId: m.org.id, provider: "twilio", label: "Revoked", secret: twilioSecretJson({ accountSid: ACCOUNT, authToken: TOKEN }), actorId: m.superAdmin.id });
      await db.query("update integration_credentials set revoked_at = now() where id = $1", [saved.id]);
      return saved.id;
    });
    expect(await twilioTransport.send(sendReq({ sender: { identity: POOL_NUMBER, senderId: SERVICE, accountId: ACCOUNT, credentialId: revoked } }))).toMatchObject({ ok: false, blocked: true, reconnectRequired: true });
    expect(calls).toHaveLength(0);
  });
});

describe("capability test", () => {
  const inboundUrl = `${BASE}/api/webhooks/twilio/inbound`;
  const account = (over: Record<string, unknown> = {}) => ({ sid: ACCOUNT, status: "active", type: "Full", friendly_name: "Acme Dental", auth_token: TOKEN, ...over });
  const service = (over: Record<string, unknown> = {}) => ({ sid: SERVICE, account_sid: ACCOUNT, friendly_name: "Acme SMS", inbound_request_url: inboundUrl, inbound_method: "POST", use_inbound_webhook_on_number: false, us_app_to_person_registered: false, ...over });
  const route = (over: { account?: Response; service?: Response; numbers?: Response; incoming?: Response } = {}) => (c: FetchCall) => {
    if (c.url.origin === "https://api.twilio.com" && c.url.pathname === `/2010-04-01/Accounts/${ACCOUNT}.json`) return over.account ?? json(account());
    if (c.url.origin === "https://messaging.twilio.com" && c.url.pathname === `/v1/Services/${SERVICE}`) return over.service ?? json(service());
    if (c.url.origin === "https://messaging.twilio.com" && c.url.pathname === `/v1/Services/${SERVICE}/PhoneNumbers`) return over.numbers ?? json({ phone_numbers: [{ phone_number: POOL_NUMBER, capabilities: ["SMS", "MMS"] }], meta: {} });
    if (c.url.origin === "https://messaging.twilio.com" && c.url.pathname === `/v1/Services/${SERVICE}/ShortCodes`) return json({ short_codes: [], meta: {} });
    if (c.url.origin === "https://api.twilio.com" && c.url.pathname === `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json`) return over.incoming ?? json({ incoming_phone_numbers: [] });
    return json({ status: 404, code: 20404 }, 404);
  };
  const secret = twilioSecretJson({ accountSid: ACCOUNT, authToken: TOKEN });

  it("passes for an active account whose Messaging Service has an SMS number and routes incoming messages to iAcquire, without leaking the token", async () => {
    const calls = stubFetch(route());
    const result = await testTwilioCapability({ secret, senderId: ` ${SERVICE} ` });
    expect(result).toMatchObject({ ok: true, accountId: ACCOUNT, senderId: SERVICE, senderIdentity: POOL_NUMBER, registrationStatus: "not_required" });
    expect(result.checks.map((c) => c.label)).toEqual(["Twilio account", "Messaging Service", "Incoming messages", "Webhook address"]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64")}`);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => c.url.pathname.endsWith("/Messages.json"))).toBe(false);
  });

  it("fails honestly: rejected token, trial account, incoming webhook elsewhere, empty sender pool, unregistered US traffic", async () => {
    stubFetch(route({ account: json({ status: 401, code: 20003 }, 401) }));
    const rejected = await testTwilioCapability({ secret, senderId: SERVICE });
    expect(rejected.ok).toBe(false);
    expect(rejected.checks[0]).toMatchObject({ label: "Twilio account", ok: false, detail: expect.stringMatching(/rejected/) });

    stubFetch(route({ account: json(account({ type: "Trial" })) }));
    expect((await testTwilioCapability({ secret, senderId: SERVICE })).checks[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/trial/) });

    stubFetch(route({ service: json(service({ inbound_request_url: "https://old-crm.example/sms" })) }));
    const elsewhere = await testTwilioCapability({ secret, senderId: SERVICE });
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.checks.find((c) => c.label === "Incoming messages")).toMatchObject({ ok: false, detail: expect.stringContaining(inboundUrl) });

    stubFetch(route({ numbers: json({ phone_numbers: [], meta: {} }) }));
    expect((await testTwilioCapability({ secret, senderId: SERVICE })).checks.find((c) => c.label === "Messaging Service")).toMatchObject({ ok: false });

    stubFetch(route({ numbers: json({ phone_numbers: [{ phone_number: "+15005550006", capabilities: ["SMS"] }], meta: {} }) }));
    const us = await testTwilioCapability({ secret, senderId: SERVICE });
    expect(us).toMatchObject({ ok: false, registrationStatus: "pending" });
    stubFetch(route({ numbers: json({ phone_numbers: [{ phone_number: "+15005550006", capabilities: ["SMS"] }], meta: {} }), service: json(service({ us_app_to_person_registered: true })) }));
    expect(await testTwilioCapability({ secret, senderId: SERVICE })).toMatchObject({ ok: true, registrationStatus: "approved" });

    stubFetch(route({ service: json(service({ account_sid: ACCOUNT_2 })) }));
    expect((await testTwilioCapability({ secret, senderId: SERVICE })).ok).toBe(false);
  });

  it("checks a phone-number sender by its own webhook, and checks a stored API key too", async () => {
    const number = { phone_number: NUMBER_2, account_sid: ACCOUNT, capabilities: { sms: true, mms: false, voice: true, fax: false }, sms_url: inboundUrl, sms_method: "POST" };
    const calls = stubFetch(route({ incoming: json({ incoming_phone_numbers: [number] }) }));
    const keySecret = twilioSecretJson({ accountSid: ACCOUNT, authToken: TOKEN, apiKeySid: KEY_SID, apiKeySecret: KEY_SECRET });
    const result = await testTwilioCapability({ secret: keySecret, senderId: "+44 7700 900123" });
    expect(result).toMatchObject({ ok: true, senderId: NUMBER_2, senderIdentity: NUMBER_2 });
    expect(result.checks.map((c) => c.label)).toEqual(["Twilio account", "API key", "Phone number", "Incoming messages", "Webhook address"]);
    const lookup = calls.find((c) => c.url.searchParams.get("PhoneNumber"));
    expect(lookup?.url.searchParams.get("PhoneNumber")).toBe(NUMBER_2);
    expect(lookup?.headers.Authorization).toBe(`Basic ${Buffer.from(`${KEY_SID}:${KEY_SECRET}`).toString("base64")}`);
    expect(JSON.stringify(result)).not.toContain(KEY_SECRET);

    stubFetch(route({ incoming: json({ incoming_phone_numbers: [{ ...number, sms_url: null }] }) }));
    expect((await testTwilioCapability({ secret, senderId: NUMBER_2 })).ok).toBe(false);
    stubFetch(route({ incoming: json({ incoming_phone_numbers: [{ ...number, phone_number: "+15005550006" }] }) }));
    const usNumber = await testTwilioCapability({ secret, senderId: "+15005550006" });
    expect(usNumber).toMatchObject({ ok: false, registrationStatus: "pending" });
  });

  it("accepts channel setup's input shape (a sender object) and refuses a channel other than SMS", async () => {
    stubFetch(route());
    expect(await testTwilioCapability({ secret, sender: { senderId: SERVICE }, channel: "sms" })).toMatchObject({ ok: true, senderId: SERVICE });
    const calls = stubFetch(route());
    expect(await testTwilioCapability({ secret, sender: { senderId: SERVICE }, channel: "email" })).toMatchObject({ ok: false, checks: [{ label: "Channel", ok: false }] });
    expect(await testTwilioCapability({ secret, sender: { senderId: null } })).toMatchObject({ ok: false, checks: [{ label: "Sender", ok: false }] });
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed credential or sender without calling Twilio, and a webhook base Twilio cannot reach", async () => {
    const calls = stubFetch(route());
    expect(await testTwilioCapability({ secret: "nope", senderId: SERVICE })).toMatchObject({ ok: false });
    expect(await testTwilioCapability({ secret, senderId: "MG123" })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
    process.env.TWILIO_WEBHOOK_BASE_URL = "http://localhost:3000";
    resetEnvCache();
    try {
      stubFetch(route({ service: json(service({ inbound_request_url: "http://localhost:3000/api/webhooks/twilio/inbound" })) }));
      const local = await testTwilioCapability({ secret, senderId: SERVICE });
      expect(local.ok).toBe(false);
      expect(local.checks.find((c) => c.label === "Webhook address")).toMatchObject({ ok: false });
    } finally {
      process.env.TWILIO_WEBHOOK_BASE_URL = BASE;
      resetEnvCache();
    }
  });
});

describe("webhooks", () => {
  const receipts = (messageSid: string) => withSystem((db) => db.query<{ external_id: string; outcome: string; org_id: string | null }>("select external_id, outcome, org_id from webhook_receipts where provider = 'twilio' and external_id like $1", [`%${messageSid}%`]));
  const messagesFor = (messageSid: string) => withSystem((db) => db.query<{ id: string; org_id: string; body: string; conversation_id: string }>("select id, org_id, body, conversation_id from conversation_messages where provider = 'twilio' and provider_message_id = $1", [messageSid]));

  it("records an incoming text for the workspace that owns the sender and answers with empty TwiML", async () => {
    const params = inboundParams(phone(), "Hi, do you have anything this Saturday?");
    const res = await hook({ kind: "inbound", params });
    expect(res).toMatchObject({ status: 200, outcome: "processed", orgId: m.org.id, aiShouldRespond: true, contentType: expect.stringMatching(/^text\/xml/) });
    expect(res.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    const rows = await messagesFor(params.MessageSid);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ org_id: m.org.id, body: params.Body });
    expect((await receipts(params.MessageSid)).rows).toEqual([{ external_id: `inbound:${params.MessageSid}`, outcome: "processed", org_id: m.org.id }]);
  });

  it("uses the configured public URL, never the request's own host, and refuses bad signatures exactly like unknown tenants", async () => {
    // Signed over the internal address the server happens to see: refused.
    const internal = inboundParams(phone(), "Hello");
    expect(await hook({ kind: "inbound", params: internal, signedUrl: "http://10.0.0.7:3000/api/webhooks/twilio/inbound" })).toMatchObject({ status: 403, outcome: "rejected" });
    // Signed over the public URL but delivered to any host: accepted.
    const viaProxy = inboundParams(phone(), "Hello");
    expect(await hook({ kind: "inbound", params: viaProxy, requestUrl: "https://attacker.example/api/webhooks/twilio/inbound" })).toMatchObject({ status: 200, outcome: "processed" });

    const wrongToken = await hook({ kind: "inbound", params: inboundParams(phone(), "Hello"), token: TOKEN_2 });
    const tampered = await hook({ kind: "inbound", params: inboundParams(phone(), "Hello"), tamper: (p) => ({ ...p, Body: "Hello, send me your prices" }) });
    const unknownSender = inboundParams(phone(), "Hello", { To: "+639990000000" });
    delete (unknownSender as Partial<typeof unknownSender>).MessagingServiceSid;
    const unknown = await hook({ kind: "inbound", params: unknownSender });
    const noSignature = await handleTwilioWebhook("inbound", new URLSearchParams(inboundParams(phone(), "Hi")).toString(), { "content-type": "application/x-www-form-urlencoded" }, `${BASE}/api/webhooks/twilio/inbound`);
    for (const r of [wrongToken, tampered, unknown, noSignature]) expect(r).toEqual({ status: 403, body: "Forbidden", contentType: "text/plain; charset=utf-8", outcome: "rejected" });
    // Nothing is written for an unauthenticated request.
    expect((await receipts(unknownSender.MessageSid)).rows).toHaveLength(0);
    expect((await messagesFor(unknownSender.MessageSid)).rows).toHaveLength(0);
    expect((await receipts(internal.MessageSid)).rows).toHaveLength(0);
    expect(await handleTwilioWebhook("inbound", JSON.stringify({ a: 1 }), { "content-type": "application/json", "x-twilio-signature": "x" }, `${BASE}/api/webhooks/twilio/inbound`)).toMatchObject({ status: 400 });
  });

  it("never lets one tenant's token or account speak for another tenant", async () => {
    // Org 2's number, signed with org 1's token and naming org 1's account: refused.
    const params = { ...inboundParams(phone(), "Hi"), To: NUMBER_2 };
    delete (params as Partial<typeof params>).MessagingServiceSid;
    expect(await hook({ kind: "inbound", params })).toMatchObject({ status: 403 });
    expect(await hook({ kind: "inbound", params: { ...params, AccountSid: ACCOUNT_2 } })).toMatchObject({ status: 403 });
    // Correctly signed by org 2's account: accepted for org 2.
    const own = { ...inboundParams(phone(), "Hi"), To: NUMBER_2, AccountSid: ACCOUNT_2 };
    delete (own as Partial<typeof own>).MessagingServiceSid;
    expect(await hook({ kind: "inbound", params: own, token: TOKEN_2 })).toMatchObject({ status: 200, orgId: m2.org.id });
    // A sender of org 1 together with a number of org 2 names two workspaces: refused.
    expect(await hook({ kind: "inbound", params: { ...inboundParams(phone(), "Hi"), To: NUMBER_2 } })).toMatchObject({ status: 403 });
  });

  it("drops replays, including a replay with a fresh idempotency header (the header is not signed)", async () => {
    const params = inboundParams(phone(), "Is parking available?");
    expect(await hook({ kind: "inbound", params, headers: { "i-twilio-idempotency-token": "tok-1" } })).toMatchObject({ outcome: "processed" });
    expect(await hook({ kind: "inbound", params, headers: { "i-twilio-idempotency-token": "tok-1" } })).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(await hook({ kind: "inbound", params, headers: { "i-twilio-idempotency-token": "tok-2" } })).toMatchObject({ status: 200, outcome: "duplicate", body: expect.stringContaining("<Response>") });
    expect((await messagesFor(params.MessageSid)).rows).toHaveLength(1);
  });

  it("STOP end to end: suppresses the number, revokes consent and stops the AI's pending reply; the AI does not answer", async () => {
    const customer = phone();
    const first = await hook({ kind: "inbound", params: inboundParams(customer, "Hi, can I book a cleaning?") });
    expect(first.conversationId).toBeTruthy();
    const pending = await queueAi(m, first.conversationId!);
    expect(pending.status).toBe("queued");
    const stop = await hook({ kind: "inbound", params: inboundParams(customer, "STOP", { OptOutType: "STOP" }) });
    expect(stop).toMatchObject({ status: 200, outcome: "processed", aiShouldRespond: false });
    const supp = await withSystem((db) => db.query<{ reason: string; lifted_at: Date | null }>("select reason, lifted_at from suppressions where org_id = $1 and channel = 'sms' and address = $2", [m.org.id, customer]));
    expect(supp.rows).toEqual([{ reason: "opt_out", lifted_at: null }]);
    expect(await messageRow(pending.messageId!)).toMatchObject({ status: "blocked", blocked_reason: "suppressed" });
    const consent = await withSystem((db) =>
      db.query<{ purpose: string; status: string }>(
        "select distinct on (purpose) purpose, status from contact_consent_events where org_id = $1 and channel = 'sms' and contact_id = (select contact_id from conversations where id = $2) order by purpose, id desc",
        [m.org.id, first.conversationId],
      ),
    );
    expect(consent.rows).toEqual([{ purpose: "marketing", status: "revoked" }, { purpose: "service", status: "revoked" }]);
    // START lifts it again.
    await hook({ kind: "inbound", params: inboundParams(customer, "START", { OptOutType: "START" }) });
    const lifted = await withSystem((db) => db.query<{ lifted_at: Date | null }>("select lifted_at from suppressions where org_id = $1 and channel = 'sms' and address = $2", [m.org.id, customer]));
    expect(lifted.rows[0].lifted_at).not.toBeNull();
  });

  it("honours Twilio's own opt-out match for a keyword the shared list doesn't know, and keeps quiet after HELP", async () => {
    const customer = phone();
    await hook({ kind: "inbound", params: inboundParams(customer, "Hello there") });
    const revoke = await hook({ kind: "inbound", params: inboundParams(customer, "REVOKE", { OptOutType: "STOP" }) });
    expect(revoke).toMatchObject({ outcome: "processed", aiShouldRespond: false });
    const supp = await withSystem((db) => db.query<{ reason: string; source: string }>("select reason, source from suppressions where org_id = $1 and channel = 'sms' and address = $2 and lifted_at is null", [m.org.id, customer]));
    expect(supp.rows).toEqual([{ reason: "opt_out", source: "twilio_opt_out" }]);
    const help = await hook({ kind: "inbound", params: inboundParams(phone(), "HELP", { OptOutType: "HELP" }) });
    expect(help).toMatchObject({ outcome: "processed", aiShouldRespond: false });

    // A plain number without Advanced Opt-Out: no OptOutType, but REVOKE is one of Twilio's default opt-out words, so Twilio blocks the person.
    const other = phone();
    const base = { ...inboundParams(other, "Revoke."), To: NUMBER_2, AccountSid: ACCOUNT_2 };
    delete (base as Partial<typeof base>).MessagingServiceSid;
    expect(await hook({ kind: "inbound", params: base, token: TOKEN_2 })).toMatchObject({ outcome: "processed", orgId: m2.org.id, aiShouldRespond: false });
    const supp2 = await withSystem((db) => db.query<{ reason: string; source: string }>("select reason, source from suppressions where org_id = $1 and channel = 'sms' and address = $2 and lifted_at is null", [m2.org.id, other]));
    expect(supp2.rows).toEqual([{ reason: "opt_out", source: "twilio_opt_out" }]);
  });

  it("notes attachments it can't show, and ignores other Twilio channels on this SMS connection", async () => {
    const media = inboundParams(phone(), "", { NumMedia: "2", MediaUrl0: "https://api.twilio.com/media/1", MediaContentType0: "image/jpeg", MediaUrl1: "https://api.twilio.com/media/2", MediaContentType1: "image/png" });
    expect(await hook({ kind: "inbound", params: media })).toMatchObject({ outcome: "processed" });
    expect((await messagesFor(media.MessageSid)).rows[0].body).toBe("[2 attachments received. Attachments aren't shown in the inbox yet.]");
    const wa = inboundParams("whatsapp:+639175550199", "Hi");
    expect(await hook({ kind: "inbound", params: wa })).toMatchObject({ status: 200, outcome: "ignored" });
    expect((await messagesFor(wa.MessageSid)).rows).toHaveLength(0);
  });

  it("matches a status callback that arrives before the send returned, by the message id in its URL", async () => {
    const customer = phone();
    const conv = await hook({ kind: "inbound", params: inboundParams(customer, "Do you take walk-ins?") });
    const queued = await queueAi(m, conv.conversationId!);
    expect(queued.status).toBe("queued");
    const twilioSid = sid();
    let early: Awaited<ReturnType<typeof handleTwilioWebhook>> | null = null;
    stubFetch(async (c) => {
      const callback = c.form!.get("StatusCallback")!;
      expect(callback).toBe(`${BASE}/api/webhooks/twilio/status?mid=${queued.messageId}`);
      early = await hook({ kind: "status", params: statusParams(twilioSid, "delivered", customer, { NumSegments: "1" }), signedUrl: callback });
      return created({ sid: twilioSid });
    });
    expect(await dispatchMessage(queued.messageId!)).toEqual({ status: "sent" });
    expect(early).toMatchObject({ status: 200, outcome: "processed", orgId: m.org.id });
    const row = await messageRow(queued.messageId!);
    expect(row).toMatchObject({ status: "delivered", provider: "twilio", provider_message_id: twilioSid });
    expect(row.delivered_at).not.toBeNull();
    const events = await withSystem((db) => db.query<{ status: string; raw_status: string }>("select status, raw_status from message_delivery_events where message_id = $1", [queued.messageId]));
    expect(events.rows).toEqual([{ status: "delivered", raw_status: "delivered" }]);
  });

  it("moves delivery forward only: read after delivered sticks, a late sent or delivered changes nothing, a duplicate is ignored", async () => {
    const customer = phone();
    const conv = await hook({ kind: "inbound", params: inboundParams(customer, "What are your hours?") });
    const queued = await queueAi(m, conv.conversationId!);
    const twilioSid = sid();
    stubFetch(() => created({ sid: twilioSid, num_segments: "1" }));
    await dispatchMessage(queued.messageId!);
    // Sent is not delivered; the usage is metered against Twilio's published rate with Twilio's message id as the reference.
    expect(await messageRow(queued.messageId!)).toMatchObject({ status: "sent", provider: "twilio", provider_message_id: twilioSid, segments_actual: 1, delivered_at: null });
    const usage = await withSystem((db) => db.query<{ provider: string; unit_type: string; provider_reference: string }>("select provider, unit_type, provider_reference from metered_usage_events where message_id = $1", [queued.messageId]));
    expect(usage.rows).toEqual([{ provider: "twilio", unit_type: "sms_segment", provider_reference: `twilio:${twilioSid}` }]);
    const cb = `${BASE}/api/webhooks/twilio/status?mid=${queued.messageId}`;
    const send = (status: string) => hook({ kind: "status", params: statusParams(twilioSid, status, customer), signedUrl: cb });
    expect(await send("read")).toMatchObject({ outcome: "processed" });
    expect((await messageRow(queued.messageId!)).status).toBe("read");
    expect(await send("delivered")).toMatchObject({ outcome: "ignored", detail: "no_change" });
    expect(await send("sent")).toMatchObject({ outcome: "ignored" });
    expect(await send("read")).toMatchObject({ outcome: "duplicate" });
    expect(await send("queued")).toMatchObject({ status: 200, outcome: "ignored" });
    expect((await messageRow(queued.messageId!)).status).toBe("read");
    // A status callback for our message signed by another tenant's token is refused.
    expect(await hook({ kind: "status", params: { ...statusParams(twilioSid, "failed", customer), AccountSid: ACCOUNT_2 }, signedUrl: cb, token: TOKEN_2 })).toMatchObject({ status: 403 });
  });

  it("the route answers only POST to inbound or status, caps the body, returns TwiML and schedules the AI reply after responding", async () => {
    const ctx = (kind: string) => ({ params: Promise.resolve({ kind }) });
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const post = (kind: string, body: string, headers: Record<string, string> = {}) =>
      routePost(new Request(`http://10.0.0.7:3000/api/webhooks/twilio/${kind}`, { method: "POST", body, headers: { ...form, ...headers } }), ctx(kind));

    expect((await routeGet()).status).toBe(405);
    expect((await post("voice", "a=b")).status).toBe(404);
    expect((await post("inbound", `Body=${"x".repeat(300_000)}`)).status).toBe(413);
    const unsigned = await post("inbound", new URLSearchParams(inboundParams(phone(), "Hi")).toString());
    expect(unsigned.status).toBe(403);
    expect(unsigned.headers.get("cache-control")).toBe("no-store");
    expect(await unsigned.text()).toBe("Forbidden");

    scheduled.after.length = 0;
    const params = inboundParams(phone(), "Hello, are you open on Sunday?");
    const signature = sign(TOKEN, `${BASE}/api/webhooks/twilio/inbound`, params);
    const res = await post("inbound", new URLSearchParams(params).toString(), { "x-twilio-signature": signature });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/xml/);
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(scheduled.after).toHaveLength(1);
    expect((await messagesFor(params.MessageSid)).rows).toHaveLength(1);
  });

  it("an undelivered callback with 21610 fails the message and suppresses the number as opted out", async () => {
    const customer = phone();
    const conv = await hook({ kind: "inbound", params: inboundParams(customer, "Any discounts?") });
    const queued = await queueAi(m, conv.conversationId!);
    const twilioSid = sid();
    stubFetch(() => created({ sid: twilioSid }));
    await dispatchMessage(queued.messageId!);
    const res = await hook({ kind: "status", params: statusParams(twilioSid, "undelivered", customer, { ErrorCode: "21610" }), signedUrl: `${BASE}/api/webhooks/twilio/status?mid=${queued.messageId}` });
    expect(res).toMatchObject({ outcome: "processed" });
    const row = await messageRow(queued.messageId!);
    expect(row).toMatchObject({ status: "failed" });
    expect(String(row.status_detail)).toMatch(/opted out/);
    const supp = await withSystem((db) => db.query<{ reason: string }>("select reason from suppressions where org_id = $1 and channel = 'sms' and address = $2 and lifted_at is null", [m.org.id, customer]));
    expect(supp.rows).toEqual([{ reason: "opt_out" }]);
    const events = await withSystem((db) => db.query<{ status: string; raw_status: string }>("select status, raw_status from message_delivery_events where message_id = $1", [queued.messageId]));
    expect(events.rows).toEqual([{ status: "undelivered", raw_status: "undelivered" }]);
  });
});
