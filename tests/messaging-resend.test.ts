// Resend email transport, capability test, webhooks and unsubscribe links. Every Resend call is a mocked fetch; nothing leaves the
// machine and no email is sent.
import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { publishUnitRate } from "@/server/billing/service";
import { saveCredential } from "@/server/security/credentials";
import { getConsent, recordConsent } from "@/server/messaging/contacts";
import { dispatchMessage, queueOutbound } from "@/server/messaging/send";
import {
  classifyResendError,
  createResendTransport,
  handleResendWebhook,
  htmlToText,
  isAutomatedEmail,
  parseResendSecret,
  receivedAuthentication,
  resendSendPayload,
  resendWebhookUrl,
  senderAuthenticated,
  signResendWebhook,
  stripQuotedReply,
  testResendCapability,
  textToSafeHtml,
  verifyResendSignature,
} from "@/server/messaging/transports/resend";
import { buildUnsubscribeUrl, createUnsubscribeToken, loadUnsubscribePage, maskAddress, performUnsubscribe, verifyUnsubscribeToken } from "@/server/messaging/unsubscribe";
import type { TransportSendRequest } from "@/server/messaging/transports/types";
import { GET as unsubscribeGet, POST as unsubscribePost } from "@/app/api/public/unsubscribe/route";
import { GET as webhookGet, POST as webhookPost } from "@/app/api/webhooks/resend/route";
import { inbound, messageRow, messagingOrg, recordingProvider, type MessagingOrg } from "./support/messaging";

const scheduled = vi.hoisted(() => ({ after: [] as Array<() => unknown> }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => unknown) => void scheduled.after.push(fn) }));

const API_KEY = "re_TestOnly_0123456789abcdefghij";
const API_KEY_2 = "re_TestOnly_zyxwvutsrqponmlkjihg";
const SECRET = `whsec_${crypto.randomBytes(24).toString("base64")}`;
const DOMAIN_ID = "4dd369bc-aa82-4ff3-97de-514ae3000ee0";
const SENDER = "Acme Dental <hello@acme.test>";
const INBOUND = "replies@acme.test";
const INBOUND_2 = "inbox@other-co.test";

const transport = createResendTransport({ confirmDelaysMs: [0, 0] });

let m: MessagingOrg;
let m2: MessagingOrg;
let credentialId: string;

async function connectResend(org: MessagingOrg, opts: { secret: string; identity: string; senderId: string; inbound: string | null }) {
  return withSystem(async (db) => {
    const saved = await saveCredential(db, { orgId: org.org.id, provider: "resend", label: "Resend (synthetic test)", secret: opts.secret, actorId: org.superAdmin.id });
    await db.query(
      `update messaging_channels set provider = 'resend', provider_sender_id = $2, credential_id = $3, sender_identity = $4, inbound_address = $5,
         capability_test = '{"ok":true}'::jsonb, capability_tested_at = now() where org_id = $1 and channel = 'email'`,
      [org.org.id, opts.senderId, saved.id, opts.identity, opts.inbound],
    );
    return saved.id;
  });
}

beforeAll(async () => {
  process.env.RESEND_WRITES_ENABLED = "true";
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  resetEnvCache();
  m = await messagingOrg({ name: "Acme Dental" });
  m2 = await messagingOrg({ name: "Other Co" });
  credentialId = await connectResend(m, { secret: API_KEY, identity: SENDER, senderId: DOMAIN_ID, inbound: INBOUND });
  await connectResend(m2, { secret: JSON.stringify({ apiKey: API_KEY_2 }), identity: "Other Co <team@other-co.test>", senderId: crypto.randomUUID(), inbound: INBOUND_2 });
  await publishUnitRate(m.superAdmin, { provider: "resend", unitType: "email_send", wholesaleMicrosPerUnit: 900 });
});
afterAll(() => {
  delete process.env.RESEND_WRITES_ENABLED;
  delete process.env.RESEND_WEBHOOK_SECRET;
  resetEnvCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type FetchCall = { url: URL; method: string; headers: Record<string, string>; body: unknown };
function stubFetch(answer: (call: FetchCall, n: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit = {}) => {
    const call: FetchCall = { url: new URL(String(input)), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    return answer(call, calls.length);
  });
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const apiError = (status: number, name: string, message = "x") => json({ statusCode: status, name, message }, status);

const sendReq = (over: Partial<TransportSendRequest> = {}): TransportSendRequest => ({
  orgId: m.org.id,
  channel: "email",
  messageId: crypto.randomUUID(),
  to: "maria@example.com",
  contactRef: null,
  body: "Thanks for reaching out.\n\nWe have room on Thursday at 10am.",
  subject: "Your appointment",
  sender: { identity: SENDER, senderId: DOMAIN_ID, accountId: null, credentialId },
  ...over,
});

/** Signs and delivers one webhook the way Resend (through Svix) does. */
async function hook(payload: unknown, opts: { id?: string; at?: number; secret?: string; tamper?: (raw: string) => string } = {}) {
  const raw = JSON.stringify(payload);
  const id = opts.id ?? `msg_${crypto.randomBytes(12).toString("hex")}`;
  const at = opts.at ?? Math.floor(Date.now() / 1000);
  const headers = { "svix-id": id, "svix-timestamp": String(at), "svix-signature": signResendWebhook(opts.secret ?? SECRET, id, at, raw), "content-type": "application/json" };
  return handleResendWebhook(opts.tamper ? opts.tamper(raw) : raw, headers);
}

const emailEvent = (type: string, emailId: string, mid: string | null, data: Record<string, unknown> = {}) => ({
  type,
  created_at: new Date().toISOString(),
  data: { email_id: emailId, created_at: new Date().toISOString(), from: SENDER, to: ["maria@example.com"], subject: "Your appointment", ...(mid ? { tags: { mid } } : {}), ...data },
});

const receivedEvent = (emailId: string, over: Record<string, unknown> = {}) => ({
  type: "email.received",
  created_at: new Date().toISOString(),
  data: { email_id: emailId, created_at: new Date().toISOString(), from: "Maria Santos <maria.inbound@example.com>", to: [INBOUND], cc: [], bcc: [], subject: "Re: Your appointment", message_id: "<CAF-123@mail.example.com>", attachments: [], ...over },
});

const receivedContent = (over: Record<string, unknown> = {}) => ({
  object: "email",
  id: crypto.randomUUID(),
  to: [INBOUND],
  from: "Maria Santos <maria.inbound@example.com>",
  subject: "Re: Your appointment",
  message_id: "<CAF-123@mail.example.com>",
  text: "Thursday works for me, thank you!\n\nOn Tue, Oct 14, 2026 at 9:00 AM Acme Dental <hello@acme.test> wrote:\n> We have room on Thursday at 10am.",
  html: null,
  headers: { "X-Mailer": "Example Mail" },
  created_at: new Date().toISOString(),
  attachments: [],
  // Resend's receiving server's verdicts (GET /emails/receiving/{id} `authentication`): a genuine sender passes DKIM and DMARC.
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  ...over,
});

/** A conversation with a customer on email, through Resend, and an AI reply queued in it. */
async function emailConversation(org: MessagingOrg, address: string) {
  const conv = await inbound(org.org.id, { channel: "email", provider: "resend", address, ghlContactId: null, body: "Do you have time on Thursday?" });
  const queued = await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: conv.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "We have room on Thursday at 10am. Shall I hold it?" }));
  return { conv, queued };
}

const deliveryEvents = (messageId: string) =>
  withSystem((db) => db.query<{ status: string; raw_status: string | null }>("select status, raw_status from message_delivery_events where message_id = $1 order by id", [messageId])).then((r) => r.rows);
const suppression = (orgId: string, address: string) =>
  withSystem((db) => db.query<{ reason: string; lifted_at: Date | null }>("select reason, lifted_at from suppressions where org_id = $1 and channel = 'email' and address = $2", [orgId, address])).then((r) => r.rows[0] ?? null);
const receipt = (id: string) =>
  withSystem((db) => db.query<{ outcome: string; org_id: string | null; kind: string }>("select outcome, org_id, kind from webhook_receipts where provider = 'resend' and external_id = $1", [id])).then((r) => r.rows[0] ?? null);

// ---------------------------------------------------------------------------

describe("payload", () => {
  it("builds from, to, subject, text, escaped HTML, the mid tag and the idempotency key from the message", () => {
    const req = sendReq({ body: "Hi <b>Maria</b> & co.\nSee https://acme.test/book?x=1&y=2.\n\njavascript:alert(1)" });
    const p = resendSendPayload(req, { name: "Acme Dental", address: "hello@acme.test", domain: "acme.test" }, { replyTo: INBOUND });
    expect(p.idempotencyKey).toBe(`msg:${req.messageId}`);
    expect(p.body).toMatchObject({ from: "Acme Dental <hello@acme.test>", to: ["maria@example.com"], subject: "Your appointment", reply_to: INBOUND, tags: [{ name: "mid", value: req.messageId }] });
    expect(p.body.text).toBe(req.body);
    expect(p.body.headers).toBeUndefined();
    expect(p.body.html).toContain("Hi &lt;b&gt;Maria&lt;/b&gt; &amp; co.<br>");
    expect(p.body.html).toContain('<a href="https://acme.test/book?x=1&amp;y=2"');
    expect(p.body.html).not.toMatch(/<a[^>]+javascript:/);
    expect(p.body.html).not.toMatch(/<img|<script|src=|url\(/i);
    // The same message always gives the same payload: Resend refuses a reused key with a different body.
    expect(resendSendPayload(req, { name: "Acme Dental", address: "hello@acme.test", domain: "acme.test" }, { replyTo: INBOUND })).toEqual(p);
  });

  it("threads a reply: In-Reply-To, References oldest first, and a Re: subject", () => {
    const p = resendSendPayload(sendReq({ inReplyTo: "<b@mail.example.com>", references: ["<a@mail.example.com>", "not-an-id", "<b@mail.example.com>"] }), { name: null, address: "hello@acme.test", domain: "acme.test" });
    expect(p.body.headers).toEqual({ "In-Reply-To": "<b@mail.example.com>", References: "<a@mail.example.com> <b@mail.example.com>" });
    expect(p.body.subject).toBe("Re: Your appointment");
    expect(p.body.from).toBe("hello@acme.test");
    // A bare id gets its angle brackets; anything that could break a header is ignored.
    expect(resendSendPayload(sendReq({ inReplyTo: "c@mail.example.com" }), { name: null, address: "hello@acme.test", domain: "acme.test" }).body.headers?.["In-Reply-To"]).toBe("<c@mail.example.com>");
    expect(resendSendPayload(sendReq({ inReplyTo: "<x@y>\r\nBcc: evil@example.com" }), { name: null, address: "hello@acme.test", domain: "acme.test" }).body.headers).toBeUndefined();
    expect(resendSendPayload(sendReq({ subject: "Hello\r\nBcc: evil@example.com" }), { name: null, address: "hello@acme.test", domain: "acme.test" }).body.subject).toBe("Hello Bcc: evil@example.com");
  });

  it("adds RFC 8058 unsubscribe headers and a visible link for a marketing email; one-click only for an https link", () => {
    const url = "https://portal.example.com/api/public/unsubscribe?t=abc_DEF-123";
    const p = resendSendPayload(sendReq({ unsubscribeUrl: url }), { name: "Acme Dental", address: "hello@acme.test", domain: "acme.test" });
    expect(p.body.headers).toEqual({ "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(p.body.text).toContain(`Unsubscribe: ${url}`);
    expect(p.body.html).toContain(`href="${url}"`);
    const local = resendSendPayload(sendReq({ unsubscribeUrl: "http://localhost:3000/api/public/unsubscribe?t=x" }), { name: null, address: "hello@acme.test", domain: "acme.test" });
    expect(local.body.headers).toEqual({ "List-Unsubscribe": "<http://localhost:3000/api/public/unsubscribe?t=x>" });
    expect(resendSendPayload(sendReq({ unsubscribeUrl: "https://x.test/u?t=a b>" }), { name: null, address: "hello@acme.test", domain: "acme.test" }).body.headers).toBeUndefined();
  });

  it("derives HTML that loads nothing remote and links only http(s)", () => {
    const html = textToSafeHtml('Look: <img src="https://evil.test/p.gif"> https://acme.test/a.\nftp://files.test/x');
    // The tag stays text: nothing is loaded when the email is opened. (Its URL is only a link someone would have to click.)
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;img src=&quot;");
    expect(html).toContain('<a href="https://acme.test/a"');
    expect(html).not.toContain('href="ftp:');
    expect(html).not.toMatch(/<(link|style|script|iframe|object)\b/i);
  });

  it("reads the stored credential as a bare key or as JSON, and refuses anything else", () => {
    expect(parseResendSecret(API_KEY)).toBe(API_KEY);
    expect(parseResendSecret(JSON.stringify({ apiKey: API_KEY }))).toBe(API_KEY);
    expect(parseResendSecret("sk_live_123")).toBeNull();
    expect(parseResendSecret("{not json")).toBeNull();
    expect(parseResendSecret(null)).toBeNull();
  });
});

describe("sending", () => {
  it("posts to Resend's /emails with the key, a User-Agent, the idempotency key and our mid tag, replying to the workspace's inbound address", async () => {
    const calls = stubFetch(() => json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }));
    const req = sendReq();
    const result = await transport.send(req);
    expect(result).toEqual({ ok: true, providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794", providerThreadRef: null, quantity: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.toString()).toBe("https://api.resend.com/emails");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers).toMatchObject({ Authorization: `Bearer ${API_KEY}`, "Idempotency-Key": `msg:${req.messageId}`, "Content-Type": "application/json" });
    expect(calls[0].headers["User-Agent"]).toMatch(/^iAcquire/);
    expect(calls[0].body).toMatchObject({ from: SENDER, to: ["maria@example.com"], reply_to: INBOUND, tags: [{ name: "mid", value: req.messageId }] });
  });

  it("sends nothing while the RESEND_WRITES_ENABLED kill switch is off", async () => {
    const calls = stubFetch(() => json({ id: "x" }));
    process.env.RESEND_WRITES_ENABLED = "false";
    resetEnvCache();
    try {
      expect(await transport.send(sendReq())).toMatchObject({ ok: false, blocked: true, retryable: false });
    } finally {
      process.env.RESEND_WRITES_ENABLED = "true";
      resetEnvCache();
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses before calling Resend: no credential, no sender, another workspace's credential, a bad address or message id", async () => {
    const calls = stubFetch(() => json({ id: "x" }));
    expect(await transport.send(sendReq({ sender: { identity: SENDER, senderId: DOMAIN_ID, accountId: null, credentialId: null } }))).toMatchObject({ ok: false, blocked: true, reconnectRequired: true });
    expect(await transport.send(sendReq({ sender: { identity: null, senderId: DOMAIN_ID, accountId: null, credentialId } }))).toMatchObject({ ok: false, blocked: true, reconnectRequired: true });
    expect(await transport.send(sendReq({ orgId: m2.org.id }))).toMatchObject({ ok: false, blocked: true, reconnectRequired: true });
    expect(await transport.send(sendReq({ to: "not-an-address" }))).toMatchObject({ ok: false, retryable: false });
    expect(await transport.send(sendReq({ messageId: "abc" }))).toMatchObject({ ok: false, retryable: false });
    expect(await transport.send(sendReq({ channel: "sms" }))).toMatchObject({ ok: false, blocked: true });
    expect(calls).toHaveLength(0);
  });

  it("maps Resend's documented errors", () => {
    expect(classifyResendError(422, { name: "missing_required_field" })).toMatchObject({ kind: "refused", failure: { retryable: false } });
    expect(classifyResendError(400, { name: "validation_error", message: "The `to` field is invalid." })).toMatchObject({ kind: "refused", failure: { retryable: false } });
    expect(classifyResendError(400, { name: "validation_error", message: "API key is invalid" })).toMatchObject({ kind: "refused", failure: { reconnectRequired: true } });
    expect(classifyResendError(401, { name: "missing_api_key" })).toMatchObject({ kind: "refused", failure: { reconnectRequired: true, retryable: false } });
    expect(classifyResendError(403, { name: "validation_error", message: "The `acme.test` domain is not verified." })).toMatchObject({ kind: "refused", failure: { reconnectRequired: true } });
    expect(classifyResendError(403, { name: "suspended_api_key" })).toMatchObject({ kind: "refused", failure: { reconnectRequired: true } });
    expect(classifyResendError(409, { name: "invalid_idempotent_request" })).toMatchObject({ kind: "refused", failure: { retryable: false } });
    expect(classifyResendError(409, { name: "concurrent_idempotent_requests" })).toMatchObject({ kind: "unclear" });
    expect(classifyResendError(429, { name: "rate_limit_exceeded" })).toMatchObject({ kind: "not_accepted", failure: { retryable: true } });
    expect(classifyResendError(429, { name: "daily_quota_exceeded" })).toMatchObject({ kind: "refused", failure: { retryable: false } });
    expect(classifyResendError(429, { name: "monthly_quota_exceeded" })).toMatchObject({ kind: "refused", failure: { retryable: false } });
    expect(classifyResendError(503, { name: "service_unavailable" })).toMatchObject({ kind: "not_accepted", failure: { retryable: true } });
    expect(classifyResendError(500, { name: "application_error" })).toMatchObject({ kind: "unclear" });
    // Resend's message is never passed on.
    expect(JSON.stringify(classifyResendError(422, { name: "invalid_parameter", message: "secret detail" }))).not.toContain("secret detail");
  });

  it("is retryable only when Resend confirms it took nothing (429 rate limit, connection refused)", async () => {
    let calls = stubFetch(() => apiError(429, "rate_limit_exceeded"));
    expect(await transport.send(sendReq())).toMatchObject({ ok: false, retryable: true });
    expect(calls).toHaveLength(1);
    calls = stubFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    expect(await transport.send(sendReq())).toMatchObject({ ok: false, retryable: true });
    expect(calls).toHaveLength(1);
    calls = stubFetch(() => apiError(422, "invalid_parameter"));
    expect(await transport.send(sendReq())).toMatchObject({ ok: false, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("confirms an unclear answer by repeating the identical request with the same key, and reports what Resend then says", async () => {
    const calls = stubFetch((_c, n) => (n === 1 ? apiError(500, "application_error") : json({ id: "e5c1d2f0-0000-4000-8000-000000000001" })));
    expect(await transport.send(sendReq())).toMatchObject({ ok: true, providerMessageId: "e5c1d2f0-0000-4000-8000-000000000001" });
    expect(calls).toHaveLength(2);
    expect(calls[1].headers["Idempotency-Key"]).toBe(calls[0].headers["Idempotency-Key"]);
    expect(calls[1].body).toEqual(calls[0].body);

    const concurrent = stubFetch((_c, n) => (n === 1 ? Promise.reject(new DOMException("timed out", "TimeoutError")) : n === 2 ? apiError(409, "concurrent_idempotent_requests") : json({ id: "e5c1d2f0-0000-4000-8000-000000000002" })));
    expect(await transport.send(sendReq())).toMatchObject({ ok: true, providerMessageId: "e5c1d2f0-0000-4000-8000-000000000002" });
    expect(concurrent).toHaveLength(3);
  });

  it("never retries later after an answer that stayed unclear: 'not confirmed', not retryable", async () => {
    const calls = stubFetch(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    const result = await transport.send(sendReq());
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok ? "" : result.error).toMatch(/didn't confirm/);
    expect(calls).toHaveLength(3);
    // Unclear first, then a rate limit: the first attempt may still have been taken.
    stubFetch((_c, n) => (n === 1 ? apiError(502, "bad_gateway") : apiError(429, "rate_limit_exceeded")));
    expect(await transport.send(sendReq())).toMatchObject({ ok: false, retryable: false });
  });

  it("goes through the dispatcher: settles at Resend's rate, records Resend's id, and never marks it delivered on send", async () => {
    const { queued } = await emailConversation(m, "dispatch@example.com");
    expect(queued.status).toBe("queued");
    const emailId = crypto.randomUUID();
    const calls = stubFetch(() => json({ id: emailId }));
    expect(await dispatchMessage(queued.messageId, { transport })).toEqual({ status: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ to: ["dispatch@example.com"], tags: [{ name: "mid", value: queued.messageId }] });
    const row = await messageRow(queued.messageId);
    expect(row).toMatchObject({ status: "sent", provider: "resend", provider_message_id: emailId });
    expect(row.delivered_at).toBeNull();
    const usage = await withSystem((db) => db.query<{ provider: string; unit_type: string }>("select provider, unit_type from metered_usage_events where org_id = $1 and provider_reference = $2", [m.org.id, `resend:${emailId}`]));
    expect(usage.rows).toEqual([{ provider: "resend", unit_type: "email_send" }]);
  });
});

describe("capability test", () => {
  const domain = (over: Record<string, unknown> = {}) => ({
    object: "domain",
    id: DOMAIN_ID,
    name: "acme.test",
    status: "verified",
    created_at: "2026-10-01 10:00:00.000000+00",
    region: "us-east-1",
    capabilities: { sending: "enabled", receiving: "enabled" },
    records: [
      { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: "verified", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
      { record: "SPF", name: "send", type: "TXT", ttl: "Auto", status: "verified", value: '"v=spf1 include:amazonses.com ~all"' },
      { record: "DKIM", name: "resend._domainkey", type: "TXT", ttl: "Auto", status: "verified", value: "p=MIGf..." },
      { record: "Receiving", name: "@", type: "MX", ttl: "Auto", status: "verified", value: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
    ],
    ...over,
  });
  // The account's webhook to this deployment, as GET /webhooks and GET /webhooks/{id} describe it (resend.json v1.5.1).
  const HOOK_ID = "479e3145-dd38-476b-932c-529ceb705947";
  const ALL_EVENTS = ["email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained", "email.failed", "email.suppressed", "email.received"];
  const hookItem = (over: Record<string, unknown> = {}) => ({ id: HOOK_ID, endpoint: resendWebhookUrl(), events: ALL_EVENTS, status: "enabled", created_at: "2026-10-01 10:00:00.000000+00", ...over });
  const webhooksOf = (opts: { items?: unknown[]; secret?: string } = {}) => (c: FetchCall) =>
    c.url.pathname === "/webhooks"
      ? json({ object: "list", has_more: false, data: opts.items ?? [hookItem()] })
      : json({ object: "webhook", ...hookItem(), signing_secret: opts.secret ?? SECRET });
  /** Answers Resend's webhook reads (by default: our endpoint, signed with this deployment's secret) and everything else with `rest`. */
  const withWebhooks = (rest: (c: FetchCall, n: number) => Response, hooks = webhooksOf()) => (c: FetchCall, n: number) =>
    c.url.pathname === "/webhooks" || c.url.pathname.startsWith("/webhooks/") ? hooks(c) : rest(c, n);

  it("passes for a verified domain read by its id, and never echoes the key", async () => {
    const calls = stubFetch(withWebhooks(() => json(domain())));
    const result = await testResendCapability({ secret: API_KEY, senderIdentity: SENDER, senderId: DOMAIN_ID, inboundAddress: INBOUND });
    expect(result).toMatchObject({ ok: true, senderIdentity: SENDER, senderId: DOMAIN_ID, registrationStatus: "not_required" });
    expect(result.checks.map((c) => [c.label, c.ok])).toEqual([["API key", true], ["Domain", true], ["Sending", true], ["Replies", true], ["Webhooks", true]]);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET /domains/${DOMAIN_ID}`, "GET /webhooks", `GET /webhooks/${HOOK_ID}`]);
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${API_KEY}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("fails for a key whose Resend account can't deliver webhooks this deployment accepts (finding 7)", async () => {
    const run = (hooks: (c: FetchCall) => Response, inbound: string | null = INBOUND) => {
      stubFetch(withWebhooks(() => json(domain()), hooks));
      return testResendCapability({ secret: API_KEY, senderIdentity: SENDER, senderId: DOMAIN_ID, inboundAddress: inbound });
    };
    const webhooksCheck = (r: Awaited<ReturnType<typeof testResendCapability>>) => r.checks.find((c) => c.label === "Webhooks");
    // A client's own Resend account: its webhook to us exists, but Resend generated a different secret for it.
    const otherSecret = `whsec_${crypto.randomBytes(24).toString("base64")}`;
    const foreign = await run(webhooksOf({ secret: otherSecret }));
    expect(foreign.ok).toBe(false);
    expect(webhooksCheck(foreign)).toMatchObject({ ok: false, detail: expect.stringContaining("client-owned Resend accounts aren't supported") });
    expect(JSON.stringify(foreign)).not.toContain(otherSecret);
    expect(JSON.stringify(foreign)).not.toContain(SECRET);
    // No webhook to our endpoint (only someone else's), a disabled one, or one without the events the portal needs.
    const none = await run(webhooksOf({ items: [hookItem({ endpoint: "https://elsewhere.example.com/hooks" })] }));
    expect(webhooksCheck(none)).toMatchObject({ ok: false, detail: expect.stringContaining("has no webhook to") });
    expect((await run(webhooksOf({ items: [hookItem({ status: "disabled" })] }))).ok).toBe(false);
    const noReceived = await run(webhooksOf({ items: [hookItem({ events: ["email.delivered", "email.bounced", "email.complained"] })] }));
    expect(webhooksCheck(noReceived)).toMatchObject({ ok: false, detail: expect.stringContaining("email.received") });
    // Without a reply address, email.received isn't needed.
    expect((await run(webhooksOf({ items: [hookItem({ events: ["email.delivered", "email.bounced", "email.complained"] })] }), null)).ok).toBe(true);
    // No RESEND_WEBHOOK_SECRET in this deployment: nothing could be verified.
    stubFetch(withWebhooks(() => json(domain())));
    const unset = await testResendCapability({ secret: API_KEY, senderIdentity: SENDER, senderId: DOMAIN_ID, webhook: { url: resendWebhookUrl(), secret: null } });
    expect(webhooksCheck(unset)).toMatchObject({ ok: false, detail: expect.stringContaining("RESEND_WEBHOOK_SECRET") });
  });

  it("fails while the domain is still pending, and when receiving isn't set up for the reply address", async () => {
    stubFetch(() => json(domain({ status: "pending", records: [{ record: "SPF", status: "pending" }, { record: "DKIM", status: "pending" }] })));
    const pending = await testResendCapability({ secret: API_KEY, senderIdentity: SENDER, senderId: DOMAIN_ID });
    expect(pending.ok).toBe(false);
    expect(pending.checks.find((c) => c.label === "Sending")).toMatchObject({ ok: false, detail: expect.stringContaining("still checking") });

    stubFetch(() => json(domain({ capabilities: { sending: "enabled", receiving: "disabled" } })));
    const noReceiving = await testResendCapability({ secret: API_KEY, senderIdentity: SENDER, senderId: DOMAIN_ID, inboundAddress: INBOUND });
    expect(noReceiving.ok).toBe(false);
    expect(noReceiving.checks.find((c) => c.label === "Replies")?.ok).toBe(false);

    // Partially verified: sending records verified while something else is pending still sends.
    stubFetch(withWebhooks(() => json(domain({ status: "partially_verified", records: [{ record: "SPF", status: "verified" }, { record: "DKIM", status: "verified" }, { record: "Tracking", status: "pending" }] }))));
    expect((await testResendCapability({ secret: API_KEY, senderIdentity: SENDER, senderId: DOMAIN_ID })).ok).toBe(true);
  });

  it("finds the domain by name when no id is given (channel setup's input shape), and refuses a mismatched from-address", async () => {
    const calls = stubFetch(withWebhooks((c) =>
      c.url.pathname === "/domains"
        ? json({ object: "list", has_more: false, data: [{ id: "11111111-1111-4111-8111-111111111111", name: "elsewhere.test", status: "verified" }, { id: DOMAIN_ID, name: "acme.test", status: "verified" }] })
        : json(domain()),
    ));
    const found = await testResendCapability({ secret: API_KEY, sender: { identity: SENDER, senderId: null }, inboundAddress: null, channel: "email" });
    expect(found).toMatchObject({ ok: true, senderId: DOMAIN_ID });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/domains", `/domains/${DOMAIN_ID}`, "/webhooks", `/webhooks/${HOOK_ID}`]);
    expect(calls[0].url.searchParams.get("limit")).toBe("100");

    stubFetch(() => json(domain({ name: "acme-mail.test" })));
    const mismatch = await testResendCapability({ secret: API_KEY, senderIdentity: SENDER, senderId: DOMAIN_ID });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.checks.at(-1)).toMatchObject({ label: "Domain", ok: false });

    stubFetch(() => json({ object: "list", has_more: false, data: [] }));
    expect((await testResendCapability({ secret: API_KEY, senderIdentity: "hello@unknown.test" })).checks.at(-1)).toMatchObject({ label: "Domain", ok: false, detail: expect.stringContaining("isn't added") });
  });

  it("fails honestly on a rejected, sending-only or suspended key, and refuses bad input without calling Resend", async () => {
    stubFetch(() => apiError(400, "validation_error", "API key is invalid"));
    expect((await testResendCapability({ secret: API_KEY, senderIdentity: SENDER, senderId: DOMAIN_ID })).checks).toEqual([{ label: "API key", ok: false, detail: expect.stringContaining("didn't accept") }]);
    stubFetch(() => apiError(401, "restricted_api_key", "This API key is restricted to only send emails."));
    expect((await testResendCapability({ secret: API_KEY, senderIdentity: SENDER })).checks[0].detail).toMatch(/Full access/);
    stubFetch(() => apiError(403, "suspended_api_key"));
    expect((await testResendCapability({ secret: API_KEY, senderIdentity: SENDER, senderId: DOMAIN_ID })).checks[0].detail).toMatch(/suspended/);

    const calls = stubFetch(() => json(domain()));
    expect((await testResendCapability({ secret: "not-a-key", senderIdentity: SENDER })).ok).toBe(false);
    expect((await testResendCapability({ secret: API_KEY, senderIdentity: "not an address" })).ok).toBe(false);
    expect((await testResendCapability({ secret: API_KEY, senderIdentity: SENDER, senderId: "../../emails" })).ok).toBe(false);
    expect((await testResendCapability({ secret: API_KEY, senderIdentity: SENDER, channel: "sms" })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("webhook signatures", () => {
  it("matches Svix's published example signature", () => {
    const secret = "whsec_plJ3nmyCDGBKInavdOK15jsl";
    const rawBody = '{"event_type":"ping","data":{"success":true}}';
    const headers = { "svix-id": "msg_loFOjxBNrRLzqYUf", "svix-timestamp": "1731705121", "svix-signature": "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=" };
    expect(signResendWebhook(secret, "msg_loFOjxBNrRLzqYUf", 1731705121, rawBody)).toBe(headers["svix-signature"]);
    expect(verifyResendSignature({ rawBody, headers, secret, now: 1731705121_000 })).toEqual({ ok: true, id: "msg_loFOjxBNrRLzqYUf", timestamp: 1731705121 });
    // Several signatures (key rotation): any valid v1 entry passes; other versions are ignored.
    const several = { ...headers, "svix-signature": `v2,${headers["svix-signature"].slice(3)} v1,AAAA v1,${headers["svix-signature"].slice(3)}` };
    expect(verifyResendSignature({ rawBody, headers: several, secret, now: 1731705121_000 }).ok).toBe(true);
    // Svix's unbranded header names.
    expect(verifyResendSignature({ rawBody, headers: { "webhook-id": headers["svix-id"], "webhook-timestamp": headers["svix-timestamp"], "webhook-signature": headers["svix-signature"] }, secret, now: 1731705121_000 }).ok).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, a stale or future timestamp, missing headers and a missing secret", () => {
    const secret = "whsec_plJ3nmyCDGBKInavdOK15jsl";
    const rawBody = '{"event_type":"ping","data":{"success":true}}';
    const headers = { "svix-id": "msg_loFOjxBNrRLzqYUf", "svix-timestamp": "1731705121", "svix-signature": "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=" };
    const at = 1731705121_000;
    expect(verifyResendSignature({ rawBody: rawBody.replace("true", "false"), headers, secret, now: at })).toEqual({ ok: false, reason: "signature" });
    expect(verifyResendSignature({ rawBody, headers, secret: SECRET, now: at })).toEqual({ ok: false, reason: "signature" });
    expect(verifyResendSignature({ rawBody, headers: { ...headers, "svix-id": "msg_other" }, secret, now: at })).toEqual({ ok: false, reason: "signature" });
    expect(verifyResendSignature({ rawBody, headers, secret, now: at + 301_000 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyResendSignature({ rawBody, headers, secret, now: at - 301_000 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyResendSignature({ rawBody, headers, secret, now: at + 299_000 }).ok).toBe(true);
    expect(verifyResendSignature({ rawBody, headers: { "svix-id": headers["svix-id"], "svix-timestamp": headers["svix-timestamp"] }, secret, now: at })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifyResendSignature({ rawBody, headers: { ...headers, "svix-timestamp": "soon" }, secret, now: at })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifyResendSignature({ rawBody, headers, secret: null, now: at })).toEqual({ ok: false, reason: "not_configured" });
  });

  it("records nothing for a request that fails verification", async () => {
    const id = `msg_${crypto.randomBytes(8).toString("hex")}`;
    expect(await hook(emailEvent("email.delivered", crypto.randomUUID(), null), { id, secret: `whsec_${crypto.randomBytes(24).toString("base64")}` })).toMatchObject({ status: 401, outcome: "rejected" });
    expect(await hook(emailEvent("email.delivered", crypto.randomUUID(), null), { id, at: Math.floor(Date.now() / 1000) - 600 })).toMatchObject({ status: 400, outcome: "rejected" });
    expect(await hook(emailEvent("email.delivered", crypto.randomUUID(), null), { id, tamper: (raw) => raw.replace("delivered", "bounced") })).toMatchObject({ status: 401 });
    expect(await receipt(id)).toBeNull();
  });
});

describe("delivery webhooks", () => {
  it("matches an event that arrives before the send returned, by the mid tag, then moves delivery forward", async () => {
    const { queued } = await emailConversation(m, "early@example.com");
    const emailId = crypto.randomUUID();
    let early: Awaited<ReturnType<typeof handleResendWebhook>> | null = null;
    stubFetch(async (c) => {
      // Resend's email.sent can be processed while our POST /emails is still waiting for its answer.
      early = await hook(emailEvent("email.sent", emailId, (c.body as { tags: Array<{ value: string }> }).tags[0].value));
      return json({ id: emailId });
    });
    expect(await dispatchMessage(queued.messageId, { transport })).toEqual({ status: "sent" });
    expect(early).toMatchObject({ status: 200, outcome: "processed", orgId: m.org.id });
    expect(await messageRow(queued.messageId)).toMatchObject({ status: "sent", provider: "resend", provider_message_id: emailId });

    const delivered = emailEvent("email.delivered", emailId, queued.messageId);
    const id = `msg_${crypto.randomBytes(8).toString("hex")}`;
    expect(await hook(delivered, { id })).toMatchObject({ status: 200, outcome: "processed", orgId: m.org.id });
    const row = await messageRow(queued.messageId);
    expect(row.status).toBe("delivered");
    expect(row.delivered_at).not.toBeNull();
    expect(await deliveryEvents(queued.messageId)).toEqual([{ status: "sent", raw_status: "sent" }, { status: "delivered", raw_status: "delivered" }]);
    expect(await receipt(id)).toMatchObject({ outcome: "processed", org_id: m.org.id, kind: "email.delivered" });

    // The same svix-id again (Resend's retry or a manual replay) changes nothing.
    expect(await hook(delivered, { id })).toMatchObject({ status: 200, outcome: "duplicate" });
    // A late "sent" or "delivery_delayed" never moves it back; the delay is kept as the raw status.
    expect(await hook(emailEvent("email.delivery_delayed", emailId, queued.messageId))).toMatchObject({ outcome: "processed", detail: "Delivery delivery_delayed: no_change." });
    expect((await messageRow(queued.messageId)).status).toBe("delivered");
    expect((await deliveryEvents(queued.messageId)).at(-1)).toEqual({ status: "sent", raw_status: "delivery_delayed" });
  });

  it("keeps a delayed delivery as 'sent' with the raw status, and falls back to Resend's email id when there is no tag", async () => {
    const { queued } = await emailConversation(m, "delayed@example.com");
    const emailId = crypto.randomUUID();
    stubFetch(() => json({ id: emailId }));
    await dispatchMessage(queued.messageId, { transport });
    expect(await hook(emailEvent("email.delivery_delayed", emailId, null))).toMatchObject({ outcome: "processed" });
    expect(await messageRow(queued.messageId)).toMatchObject({ status: "sent" });
    expect(await deliveryEvents(queued.messageId)).toEqual([{ status: "sent", raw_status: "delivery_delayed" }]);
    expect(await hook(emailEvent("email.delivered", emailId, null))).toMatchObject({ outcome: "processed" });
    expect((await messageRow(queued.messageId)).status).toBe("delivered");
  });

  it("a hard bounce fails the message and suppresses the address; a soft bounce fails it without suppressing", async () => {
    const hard = await emailConversation(m, "gone@example.com");
    const hardId = crypto.randomUUID();
    stubFetch(() => json({ id: hardId }));
    await dispatchMessage(hard.queued.messageId, { transport });
    const bounce = (type: string) => ({ bounce: { type, subType: type === "Permanent" ? "General" : "MailboxFull", message: "x", diagnosticCode: ["smtp; 550 5.1.1 user unknown"] } });
    expect(await hook(emailEvent("email.bounced", hardId, hard.queued.messageId, bounce("Permanent")))).toMatchObject({ outcome: "processed" });
    expect(await messageRow(hard.queued.messageId)).toMatchObject({ status: "failed", status_detail: expect.stringContaining("permanently") });
    expect(await suppression(m.org.id, "gone@example.com")).toMatchObject({ reason: "bounce", lifted_at: null });
    expect(await deliveryEvents(hard.queued.messageId)).toEqual([{ status: "failed", raw_status: "bounced" }]);
    // Nothing more is sent to a suppressed address (a person trying is told why).
    await expect(withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: hard.conv.conversationId, scope: "human", actor: { kind: "human", userId: m.people.owner.id }, body: "Following up." }))).rejects.toThrow(/bounced/);

    const soft = await emailConversation(m, "full@example.com");
    const softId = crypto.randomUUID();
    stubFetch(() => json({ id: softId }));
    await dispatchMessage(soft.queued.messageId, { transport });
    expect(await hook(emailEvent("email.bounced", softId, soft.queued.messageId, bounce("Transient")))).toMatchObject({ outcome: "processed" });
    expect((await messageRow(soft.queued.messageId)).status).toBe("failed");
    expect(await suppression(m.org.id, "full@example.com")).toBeNull();
  });

  it("a complaint suppresses the address (the email was delivered); Resend's own suppression is mirrored", async () => {
    const c = await emailConversation(m, "spam-button@example.com");
    const emailId = crypto.randomUUID();
    stubFetch(() => json({ id: emailId }));
    await dispatchMessage(c.queued.messageId, { transport });
    expect(await hook(emailEvent("email.complained", emailId, c.queued.messageId))).toMatchObject({ outcome: "processed" });
    expect(await messageRow(c.queued.messageId)).toMatchObject({ status: "delivered" });
    expect(await suppression(m.org.id, "spam-button@example.com")).toMatchObject({ reason: "complaint" });

    const s = await emailConversation(m, "listed@example.com");
    const sId = crypto.randomUUID();
    stubFetch(() => json({ id: sId }));
    await dispatchMessage(s.queued.messageId, { transport });
    expect(await hook(emailEvent("email.suppressed", sId, s.queued.messageId, { suppressed: { type: "OnAccountSuppressionList", reason: "previous_complaint", message: "x", diagnosticCode: [] } }))).toMatchObject({ outcome: "processed" });
    expect(await messageRow(s.queued.messageId)).toMatchObject({ status: "failed" });
    expect(await suppression(m.org.id, "listed@example.com")).toMatchObject({ reason: "complaint" });
  });

  it("ignores events for email that isn't ours, opens and clicks, and a tag pointing at another provider's message", async () => {
    const unknownId = `msg_${crypto.randomBytes(8).toString("hex")}`;
    expect(await hook(emailEvent("email.delivered", crypto.randomUUID(), null), { id: unknownId })).toMatchObject({ status: 200, outcome: "ignored" });
    expect(await receipt(unknownId)).toMatchObject({ outcome: "ignored", org_id: null });
    expect(await hook(emailEvent("email.opened", crypto.randomUUID(), null))).toMatchObject({ status: 200, outcome: "ignored" });
    expect(await hook(emailEvent("email.clicked", crypto.randomUUID(), null))).toMatchObject({ status: 200, outcome: "ignored" });
    expect(await hook({ type: "contact.created", created_at: new Date().toISOString(), data: { id: "x" } })).toMatchObject({ status: 200, outcome: "ignored" });

    // An SMS that went through GoHighLevel: a Resend event naming it in its tag changes nothing.
    const sms = await inbound(m2.org.id, { body: "Hello?" });
    const queued = await withSystem((db) => queueOutbound(db, { orgId: m2.org.id, conversationId: sms.conversationId, scope: "reply", actor: { kind: "ai", agentId: m2.salesAgentId }, body: "Hi there." }));
    const { provider } = recordingProvider();
    await dispatchMessage(queued.messageId, { provider });
    const before = await messageRow(queued.messageId);
    expect(before.provider).toBe("ghl");
    expect(await hook(emailEvent("email.bounced", crypto.randomUUID(), queued.messageId, { bounce: { type: "Permanent", subType: "General", message: "x", diagnosticCode: [] } }))).toMatchObject({ outcome: "ignored" });
    expect(await messageRow(queued.messageId)).toMatchObject({ status: before.status, provider: "ghl", provider_message_id: before.provider_message_id });
  });

  it("the route answers only POST, caps the body and returns no details", async () => {
    expect((await webhookGet()).status).toBe(405);
    const big = await webhookPost(new Request("http://10.0.0.7:3000/api/webhooks/resend", { method: "POST", body: "x".repeat(300_000) }));
    expect(big.status).toBe(413);
    const unsigned = await webhookPost(new Request("http://10.0.0.7:3000/api/webhooks/resend", { method: "POST", body: JSON.stringify(emailEvent("email.sent", crypto.randomUUID(), null)) }));
    expect(unsigned.status).toBe(400);
    expect(unsigned.headers.get("cache-control")).toBe("no-store");
    expect(await unsigned.json()).toEqual({ received: false, outcome: "rejected" });
  });
});

describe("inbound email", () => {
  it("turns a received email into an Inbox message for the workspace that owns the address, keeping only the new words and the Message-ID", async () => {
    const emailId = crypto.randomUUID();
    const calls = stubFetch(() => json(receivedContent({ id: emailId })));
    const id = `msg_${crypto.randomBytes(8).toString("hex")}`;
    const result = await hook(receivedEvent(emailId, { to: [`Acme Replies <${INBOUND.toUpperCase()}>`] }), { id });
    expect(result).toMatchObject({ status: 200, outcome: "processed", orgId: m.org.id });
    expect(calls.map((c) => `${c.method} ${c.url.toString()}`)).toEqual([`GET https://api.resend.com/emails/receiving/${emailId}`]);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const msgs = await withSystem((db) =>
      db.query<{ org_id: string; body: string; provider: string; provider_thread_ref: string; direction: string; channel: string; subject: string }>(
        `select cm.org_id, cm.body, cm.provider, cm.provider_thread_ref, cm.direction, c.channel, c.subject from conversation_messages cm join conversations c on c.id = cm.conversation_id
         where cm.provider = 'resend' and cm.provider_message_id = $1`,
        [emailId],
      ),
    );
    expect(msgs.rows).toEqual([{ org_id: m.org.id, body: "Thursday works for me, thank you!", provider: "resend", provider_thread_ref: "<CAF-123@mail.example.com>", direction: "inbound", channel: "email", subject: "Re: Your appointment" }]);
    expect(result.replies).toEqual([{ orgId: m.org.id, conversationId: result.conversationId }]);
    expect(await receipt(id)).toMatchObject({ outcome: "processed", org_id: m.org.id, kind: "email.received" });
    // A replay is dropped without reading the email again.
    expect(await hook(receivedEvent(emailId), { id })).toMatchObject({ outcome: "duplicate" });
    expect(calls).toHaveLength(1);
  });

  it("our reply to it threads with In-Reply-To and References", async () => {
    const emailId = crypto.randomUUID();
    stubFetch(() => json(receivedContent({ id: emailId, from: "thread@example.com", message_id: "<thread-1@mail.example.com>" })));
    const r = await hook(receivedEvent(emailId, { from: "thread@example.com", message_id: "<thread-1@mail.example.com>" }));
    const queued = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: r.conversationId!, scope: "human", actor: { kind: "human", userId: m.people.owner.id }, body: "Booked you in." }));
    const calls = stubFetch(() => json({ id: crypto.randomUUID() }));
    expect(await dispatchMessage(queued.messageId, { transport })).toEqual({ status: "sent" });
    expect(calls[0].body).toMatchObject({ to: ["thread@example.com"], subject: "Re: Your appointment", headers: { "In-Reply-To": "<thread-1@mail.example.com>", References: "<thread-1@mail.example.com>" } });
  });

  it("ignores auto-replies, mail from the workspace's own address and addresses nobody receives at", async () => {
    stubFetch(() => json(receivedContent({ headers: { "Auto-Submitted": "auto-replied" }, from: "ooo@example.com" })));
    const auto = crypto.randomUUID();
    expect(await hook(receivedEvent(auto, { from: "ooo@example.com" }))).toMatchObject({ status: 200, outcome: "ignored", orgId: m.org.id });
    stubFetch(() => json(receivedContent({ from: SENDER })));
    expect(await hook(receivedEvent(crypto.randomUUID(), { from: SENDER }))).toMatchObject({ outcome: "ignored" });
    const calls = stubFetch(() => json(receivedContent()));
    expect(await hook(receivedEvent(crypto.randomUUID(), { to: ["nobody@acme.test"] }))).toMatchObject({ status: 200, outcome: "ignored" });
    expect(calls).toHaveLength(0);
    const none = await withSystem((db) => db.query("select 1 from conversation_messages where provider = 'resend' and provider_message_id = $1", [auto]));
    expect(none.rows).toHaveLength(0);
  });

  it("lets Resend retry when the email can't be read yet, and records a refusal of the workspace's key", async () => {
    const emailId = crypto.randomUUID();
    const id = `msg_${crypto.randomBytes(8).toString("hex")}`;
    stubFetch(() => apiError(500, "application_error"));
    expect(await hook(receivedEvent(emailId), { id })).toMatchObject({ status: 503, outcome: "retry" });
    expect(await receipt(id)).toBeNull();
    stubFetch(() => json(receivedContent({ id: emailId, text: "Second try works." })));
    expect(await hook(receivedEvent(emailId), { id })).toMatchObject({ status: 200, outcome: "processed" });

    const refused = `msg_${crypto.randomBytes(8).toString("hex")}`;
    stubFetch(() => apiError(401, "restricted_api_key", "This API key is restricted to only send emails."));
    expect(await hook(receivedEvent(crypto.randomUUID()), { id: refused })).toMatchObject({ status: 200, outcome: "rejected", orgId: m.org.id });
    expect(await receipt(refused)).toMatchObject({ outcome: "rejected", org_id: m.org.id });
    const note = await withSystem((db) => db.query<{ title: string }>("select title from notifications where kind = 'integration_reconnect_required' and dedupe_key like $1", [`resend-inbound:${m.org.id}:%`]));
    expect(note.rows.length).toBeGreaterThan(0);
  });

  it("an email addressed to two workspaces reaches the first one in To, read with that workspace's own key, and says so", async () => {
    const emailId = crypto.randomUUID();
    const calls = stubFetch(() => json(receivedContent({ id: emailId, from: "both@example.com", text: "Hello to you both." })));
    const r = await hook(receivedEvent(emailId, { from: "both@example.com", to: [INBOUND_2], cc: [INBOUND] }));
    expect(r).toMatchObject({ outcome: "processed", orgId: m2.org.id, detail: expect.stringContaining("1 other workspace") });
    expect(calls.map((c) => c.headers.Authorization)).toEqual([`Bearer ${API_KEY_2}`]);
    const orgs = await withSystem((db) => db.query<{ org_id: string }>("select org_id from conversation_messages where provider = 'resend' and provider_message_id = $1", [emailId]));
    expect(orgs.rows).toEqual([{ org_id: m2.org.id }]);
  });

  it("the route schedules the AI reply after answering", async () => {
    scheduled.after.length = 0;
    const emailId = crypto.randomUUID();
    stubFetch(() => json(receivedContent({ id: emailId, from: "route@example.com", text: "Can I book for Friday?" })));
    const raw = JSON.stringify(receivedEvent(emailId, { from: "route@example.com" }));
    const svixId = `msg_${crypto.randomBytes(8).toString("hex")}`;
    const at = Math.floor(Date.now() / 1000);
    const res = await webhookPost(new Request("http://10.0.0.7:3000/api/webhooks/resend", { method: "POST", body: raw, headers: { "svix-id": svixId, "svix-timestamp": String(at), "svix-signature": signResendWebhook(SECRET, svixId, at, raw) } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "processed" });
    expect(scheduled.after).toHaveLength(1);
  });

  it("records an email whose sender isn't authenticated, but changes no consent or suppression and sends no automatic reply (finding 1)", async () => {
    // SPF passes for the forger's own envelope domain; DKIM isn't by the From domain (gray) and DMARC fails.
    const forged = { spf: "pass", dkim: "gray", dmarc: "fail" };
    const receive = async (from: string, text: string, authentication: unknown) => {
      const emailId = crypto.randomUUID();
      stubFetch(() => json(receivedContent({ id: emailId, from, text, authentication, message_id: `<${crypto.randomUUID()}@mail.example.com>` })));
      const r = await hook(receivedEvent(emailId, { from }));
      const row = await withSystem((db) => db.query<{ body: string }>("select body from conversation_messages where provider = 'resend' and provider_message_id = $1", [emailId]));
      return { r, recorded: row.rows.map((x) => x.body) };
    };
    const consent = (contactId: string) => withSystem((db) => getConsent(db, m.org.id, contactId, "email", "service"));

    // The victim is on a person's do-not-contact list and had opted out. A forged START must not undo either.
    const victim = `victim.${crypto.randomBytes(4).toString("hex")}@example.com`;
    const first = await inbound(m.org.id, { channel: "email", provider: "resend", address: victim, ghlContactId: null, body: "Please don't email me again." });
    await withSystem(async (db) => {
      await db.query("insert into suppressions (org_id, channel, address, reason, source) values ($1, 'email', $2, 'manual', 'staff')", [m.org.id, victim]);
      await recordConsent(db, { orgId: m.org.id, contactId: first.contactId, channel: "email", purpose: "service", status: "revoked", source: "stop_keyword", evidence: "test" });
    });
    const start = await receive(victim, "START", forged);
    expect(start.r).toMatchObject({ status: 200, outcome: "processed", orgId: m.org.id, aiShouldRespond: false, replies: [], detail: expect.stringContaining("wasn't authenticated") });
    expect(start.recorded).toEqual(["START"]);
    expect(await suppression(m.org.id, victim)).toMatchObject({ reason: "manual", lifted_at: null });
    expect(await consent(first.contactId)).toBe("revoked");

    // An ordinary question from an address nobody vouched for (no verdicts at all): recorded, no inquiry consent, no AI reply.
    const stranger = `third.party.${crypto.randomBytes(4).toString("hex")}@example.com`;
    const asked = await receive(stranger, "What are your prices this week?", null);
    expect(asked.r).toMatchObject({ outcome: "processed", aiShouldRespond: false, replies: [] });
    expect(asked.recorded).toEqual(["What are your prices this week?"]);
    const strangerId = (await withSystem((db) => db.query<{ contact_id: string }>("select contact_id from conversations where id = $1", [asked.r.conversationId]))).rows[0].contact_id;
    expect(await consent(strangerId)).toBe("unknown");

    // A forged STOP neither suppresses the address nor revokes anything.
    await receive(stranger, "STOP", forged);
    expect(await suppression(m.org.id, stranger)).toBeNull();

    // The same STOP from a proven sender (DKIM signed by the From domain) does: authentication is the only difference.
    await receive(stranger, "STOP", { spf: "fail", dkim: "pass", dmarc: "gray" });
    expect(await suppression(m.org.id, stranger)).toMatchObject({ reason: "opt_out", lifted_at: null });
  });

  it("reads the receiving server's verdicts, never a header: DMARC or DKIM pass proves the sender, SPF alone doesn't", () => {
    expect(senderAuthenticated(receivedAuthentication({ spf: "fail", dkim: "fail", dmarc: "pass" }))).toBe(true);
    expect(senderAuthenticated(receivedAuthentication({ spf: "fail", dkim: "pass", dmarc: "gray" }))).toBe(true);
    expect(senderAuthenticated(receivedAuthentication({ spf: "pass", dkim: "gray", dmarc: "gray" }))).toBe(false);
    expect(senderAuthenticated(receivedAuthentication({ spf: "pass", dkim: "fail", dmarc: "fail" }))).toBe(false);
    expect(senderAuthenticated(receivedAuthentication(null))).toBe(false);
    expect(senderAuthenticated(receivedAuthentication({ dkim: "PASS; injected" }))).toBe(false);
  });

  it("parses email text helpers conservatively", () => {
    expect(isAutomatedEmail({ precedence: "bulk" }, "a@b.test")).toBe(true);
    expect(isAutomatedEmail({ "auto-submitted": "no" }, "a@b.test")).toBe(false);
    expect(isAutomatedEmail({}, "MAILER-DAEMON@b.test")).toBe(true);
    expect(htmlToText("<p>Hi&nbsp;there &amp; &#8217;all&#x2019;</p><script>alert(1)</script><p>Bye</p>")).toBe("Hi there & ’all’\nBye");
    expect(stripQuotedReply("Sounds good.\n\n-----Original Message-----\nFrom: x")).toBe("Sounds good.");
    expect(stripQuotedReply("> only quoted")).toBe("> only quoted");
  });
});

describe("unsubscribe links", () => {
  const someone = () => ({ orgId: crypto.randomUUID(), contactId: crypto.randomUUID() });

  it("signs who, which channel, what purpose and when, and verifies without the database", () => {
    const ids = someone();
    const issuedAt = new Date("2026-10-01T00:00:00Z");
    const token = createUnsubscribeToken({ ...ids, channel: "email", issuedAt });
    expect(verifyUnsubscribeToken(token, { now: new Date("2026-10-16T00:00:00Z") })).toEqual({ ok: true, claims: { ...ids, channel: "email", purpose: "marketing", issuedAt } });
    // Deterministic: every attempt of one message carries the same link.
    expect(createUnsubscribeToken({ ...ids, channel: "email", issuedAt })).toBe(token);
    const url = new URL(buildUnsubscribeUrl(ids.orgId, ids.contactId, "email", { issuedAt }));
    expect(url.pathname).toBe("/api/public/unsubscribe");
    expect(url.searchParams.get("t")).toBe(token);
    expect(buildUnsubscribeUrl(ids.orgId, ids.contactId, "email")).toBe(buildUnsubscribeUrl(ids.orgId, ids.contactId, "email"));
  });

  it("refuses a tampered, truncated, expired, future or other-workspace token", () => {
    const ids = someone();
    const now = new Date("2026-10-16T00:00:00Z");
    const token = createUnsubscribeToken({ ...ids, channel: "email", issuedAt: new Date("2026-10-01T00:00:00Z") });
    const raw = Buffer.from(token, "base64url");
    raw[20] ^= 0x01; // a different contact
    expect(verifyUnsubscribeToken(raw.toString("base64url"), { now })).toEqual({ ok: false, reason: "forged" });
    const sms = Buffer.from(token, "base64url");
    sms[33] = 2; // the channel byte, sms
    expect(verifyUnsubscribeToken(sms.toString("base64url"), { now })).toEqual({ ok: false, reason: "forged" });
    expect(verifyUnsubscribeToken(token.slice(0, -2), { now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyUnsubscribeToken("", { now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyUnsubscribeToken(token, { now: new Date("2027-10-02T00:00:00Z") })).toMatchObject({ ok: false, reason: "expired" });
    expect(verifyUnsubscribeToken(createUnsubscribeToken({ ...ids, channel: "email", issuedAt: new Date("2026-10-16T01:00:00Z") }), { now })).toMatchObject({ ok: false, reason: "expired" });
    expect(verifyUnsubscribeToken(token, { now, orgId: crypto.randomUUID() })).toMatchObject({ ok: false, reason: "wrong_org" });
    expect(verifyUnsubscribeToken(token, { now, orgId: ids.orgId.toUpperCase() }).ok).toBe(true);
  });

  it("keeps links valid across a key rotation through APP_ENCRYPTION_KEY_PREVIOUS", () => {
    const ids = someone();
    const token = createUnsubscribeToken({ ...ids, channel: "email" });
    const original = process.env.APP_ENCRYPTION_KEY;
    try {
      process.env.APP_ENCRYPTION_KEY = "rotated-key-0123456789abcdef0123456789abcdef";
      resetEnvCache();
      expect(verifyUnsubscribeToken(token)).toEqual({ ok: false, reason: "forged" });
      process.env.APP_ENCRYPTION_KEY_PREVIOUS = original;
      resetEnvCache();
      expect(verifyUnsubscribeToken(token).ok).toBe(true);
    } finally {
      process.env.APP_ENCRYPTION_KEY = original;
      delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
      resetEnvCache();
    }
  });

  it("one-click POST revokes marketing email consent only, idempotently; GET never changes anything", async () => {
    const r = await inbound(m.org.id, { channel: "email", provider: "resend", address: "promo@example.com", ghlContactId: null, body: "Hi" });
    await withSystem((db) => recordConsent(db, { orgId: m.org.id, contactId: r.contactId, channel: "email", purpose: "marketing", status: "granted", source: "form", evidence: "Signed up on the website." }));
    // A marketing email carries the link (the dispatcher builds it from the message's creation time).
    const marketing = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: r.conversationId, scope: "human", actor: { kind: "human", userId: m.people.owner.id }, body: "Our October offer.", purpose: "marketing" }));
    expect(marketing.status).toBe("queued");
    const calls = stubFetch(() => json({ id: crypto.randomUUID() }));
    await dispatchMessage(marketing.messageId, { transport });
    const sent = calls[0].body as { headers: Record<string, string>; text: string };
    const listUrl = sent.headers["List-Unsubscribe"].slice(1, -1);
    expect(sent.text).toContain(listUrl);
    const url = new URL(listUrl);
    const token = url.searchParams.get("t")!;
    expect(verifyUnsubscribeToken(token)).toMatchObject({ ok: true, claims: { orgId: m.org.id, contactId: r.contactId, channel: "email", purpose: "marketing" } });

    const page = await unsubscribeGet(new Request(`http://10.0.0.7:3000${url.pathname}${url.search}`));
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe(`/unsubscribe/${token}`);
    expect(await loadUnsubscribePage(token)).toMatchObject({ state: "subscribed", channel: "email", maskedAddress: "pr•••@example.com", business: { name: "Acme Dental" } });

    const oneClick = () =>
      unsubscribePost(new Request(`http://10.0.0.7:3000${url.pathname}${url.search}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
    const first = await oneClick();
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("");
    expect((await oneClick()).status).toBe(200);
    const consent = await withSystem((db) =>
      db.query<{ purpose: string; status: string; source: string }>("select purpose, status, source from contact_consent_events where org_id = $1 and contact_id = $2 and channel = 'email' order by id", [m.org.id, r.contactId]),
    );
    expect(consent.rows.filter((c) => c.purpose === "marketing").map((c) => c.status)).toEqual(["granted", "revoked"]);
    expect(consent.rows.at(-1)).toMatchObject({ purpose: "marketing", status: "revoked", source: "list_unsubscribe" });
    expect(await suppression(m.org.id, "promo@example.com")).toBeNull();
    expect(await loadUnsubscribePage(token)).toMatchObject({ state: "unsubscribed" });

    // Marketing email to them is now refused; a service reply still goes.
    await expect(
      withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: r.conversationId, scope: "human", actor: { kind: "human", userId: m.people.owner.id }, body: "Another offer.", purpose: "marketing" })),
    ).rejects.toThrow(/withdrew consent/);
    const service = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: r.conversationId, scope: "human", actor: { kind: "human", userId: m.people.owner.id }, body: "Your appointment is confirmed." }));
    expect(service.status).toBe("queued");
    const audit = await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'consent.unsubscribed' and target_id = $2", [m.org.id, r.contactId]));
    expect(audit.rows).toHaveLength(1);
  });

  it("the confirmation page's form returns to the page; bad and expired links are answered without changing anything", async () => {
    const r = await inbound(m.org.id, { channel: "email", provider: "resend", address: "page@example.com", ghlContactId: null, body: "Hi" });
    const token = createUnsubscribeToken({ orgId: m.org.id, contactId: r.contactId, channel: "email" });
    const form = await unsubscribePost(new Request(`http://localhost/api/public/unsubscribe?t=${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "via=page" }));
    expect(form.status).toBe(303);
    expect(form.headers.get("location")).toBe(`/unsubscribe/${token}?r=unsubscribed`);
    const again = await unsubscribePost(new Request(`http://localhost/api/public/unsubscribe?t=${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "via=page" }));
    expect(again.headers.get("location")).toBe(`/unsubscribe/${token}?r=already`);
    const source = await withSystem((db) => db.query<{ source: string }>("select source from contact_consent_events where contact_id = $1 and purpose = 'marketing' order by id desc limit 1", [r.contactId]));
    expect(source.rows[0].source).toBe("unsubscribe_link");

    expect((await unsubscribePost(new Request("http://localhost/api/public/unsubscribe?t=nope", { method: "POST", body: "List-Unsubscribe=One-Click" }))).status).toBe(400);
    const old = createUnsubscribeToken({ orgId: m.org.id, contactId: r.contactId, channel: "email", issuedAt: new Date(Date.now() - 400 * 86_400_000) });
    expect((await unsubscribePost(new Request(`http://localhost/api/public/unsubscribe?t=${old}`, { method: "POST", body: "List-Unsubscribe=One-Click" }))).status).toBe(410);
    expect(await loadUnsubscribePage(old)).toMatchObject({ state: "expired", business: { name: "Acme Dental" }, maskedAddress: null });
    expect(await loadUnsubscribePage("nope")).toMatchObject({ state: "invalid", business: null });
    expect((await unsubscribeGet(new Request("http://localhost/api/public/unsubscribe?t=nope"))).headers.get("location")).toBe("/unsubscribe/invalid");
  });

  it("a token for one workspace can't touch another workspace's contact", async () => {
    const other = await inbound(m2.org.id, { channel: "email", provider: "resend", address: "cross@example.com", ghlContactId: null, body: "Hi" });
    const forged = createUnsubscribeToken({ orgId: m.org.id, contactId: other.contactId, channel: "email" });
    expect(await performUnsubscribe(forged, { method: "one_click" })).toEqual({ outcome: "not_found" });
    const consent = await withSystem((db) => db.query("select 1 from contact_consent_events where contact_id = $1 and purpose = 'marketing'", [other.contactId]));
    expect(consent.rows).toHaveLength(0);
    expect(await loadUnsubscribePage(forged)).toMatchObject({ state: "not_found" });
  });

  it("renders the confirmation page in every state, and the proxy serves it without signing in", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: UnsubscribePage } = await import("@/app/unsubscribe/[token]/page");
    const render = async (token: string, r?: string) =>
      renderToStaticMarkup(await UnsubscribePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(r ? { r } : {}) })).replace(/<!-- -->/g, "");
    const c = await inbound(m.org.id, { channel: "email", provider: "resend", address: "render@example.com", ghlContactId: null, body: "Hi" });
    const token = createUnsubscribeToken({ orgId: m.org.id, contactId: c.contactId, channel: "email" });

    const confirm = await render(token);
    expect(confirm).toContain("<h1");
    expect(confirm).toContain("Unsubscribe from marketing emails?");
    expect(confirm).toContain("Acme Dental");
    expect(confirm).toContain("re•••@example.com");
    expect(confirm).not.toContain("render@example.com");
    expect(confirm).toContain(`action="/api/public/unsubscribe?t=${token}"`);
    expect(confirm).toContain('method="post"');
    expect(confirm).toContain('<input type="hidden" name="via" value="page"/>');
    expect(confirm).toContain('type="submit"');
    expect(confirm).toContain("appointment confirmations");
    expect(await render(token, "error")).toContain('role="alert"');

    await performUnsubscribe(token, { method: "page" });
    const done = await render(token, "unsubscribed");
    expect(done).toContain('role="status"');
    expect(done).toContain("You&#x27;re unsubscribed");
    expect(done).not.toContain("<form");
    expect(await render(token)).toContain("You&#x27;re already unsubscribed");
    expect(await render("not-a-token")).toContain("This unsubscribe link isn&#x27;t valid");
    const old = createUnsubscribeToken({ orgId: m.org.id, contactId: c.contactId, channel: "email", issuedAt: new Date(Date.now() - 400 * 86_400_000) });
    expect(await render(old)).toContain("This unsubscribe link has expired");

    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const res = await proxy(new NextRequest(`http://localhost/unsubscribe/${token}`));
    expect(res.headers.get("location")).toBeNull();
    const api = await proxy(new NextRequest(`http://localhost/api/public/unsubscribe?t=${token}`, { method: "POST" }));
    expect(api.headers.get("location")).toBeNull();
  });

  it("masks addresses enough to recognize, not to harvest", () => {
    expect(maskAddress("maria@example.com")).toBe("ma•••@example.com");
    expect(maskAddress("a@example.com")).toBe("a•••@example.com");
    expect(maskAddress("+639171234567")).toBe("•••••••••4567");
  });
});
