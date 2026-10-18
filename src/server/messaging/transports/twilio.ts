import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { sendEmail, type OutgoingEmail } from "@/server/email";
import { resolveCredential } from "@/server/security/credentials";
import { KEYWORD_LIFTABLE_SUPPRESSIONS, liftSuppression, recordConsent, suppressAddress } from "@/server/messaging/contacts";
import { cancelFollowUps } from "@/server/messaging/followups";
import { ingestInbound, resolveChannelByProviderSender } from "@/server/messaging/ingest";
import { applyDeliveryEvent, applyDeliveryEventForMessage, cancelPendingAiMessages, type DeliveryEventInput } from "@/server/messaging/send";
import { normalizePhone, type Channel } from "@/lib/messaging";
import type { CapabilityTest, ChannelTransport, TransportResult, TransportSendRequest } from "@/server/messaging/transports/types";

// SMS through Twilio Programmable Messaging.
//
// Contract sources, read 2026-10-16 (details and links in docs/messaging-providers.md, "Twilio"):
//   * twilio/twilio-oai spec/json/twilio_api_v2010.json: POST /2010-04-01/Accounts/{AccountSid}/Messages.json (form fields To, From or
//     MessagingServiceSid, Body, StatusCallback; 201 with sid, status, num_segments as a string, error_code), GET Accounts/{Sid}.json (status
//     active|suspended|closed, type Trial|Full; the response also carries auth_token, which is never read), GET IncomingPhoneNumbers.json
//     (PhoneNumber filter; capabilities.sms, sms_url, sms_method). Basic auth, host https://api.twilio.com.
//   * twilio_messaging_v1.json: GET /v1/Services/{Sid} (account_sid, inbound_request_url, inbound_method, use_inbound_webhook_on_number,
//     us_app_to_person_registered), GET /v1/Services/{ServiceSid}/PhoneNumbers and /ShortCodes (capabilities as ["SMS", "MMS", …]).
//     Host https://messaging.twilio.com.
//   * Twilio "Secure webhooks" and the twilio-node validateRequest source: X-Twilio-Signature is base64(HMAC-SHA1(auth token, URL + every POST
//     parameter as name+value, names sorted)); the URL fragment is not signed; the SDK accepts the URL with and without the default port.
//   * Webhook connection overrides: retries carry I-Twilio-Idempotency-Token. Messaging webhooks: an empty <Response></Response> receives
//     without replying. Advanced Opt-Out: OptOutType START|STOP|HELP means Twilio already matched the keyword and replied.
//   * Twilio error dictionary (twilio-error-codes.json): 21610 unsubscribed recipient, 21211 invalid To, 21614 To not a mobile number, …
//
// Nothing here has been exercised against a live Twilio account. Sending is off unless TWILIO_WRITES_ENABLED=true.

const API_ORIGIN = "https://api.twilio.com";
const MESSAGING_ORIGIN = "https://messaging.twilio.com";
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const API_KEY_SID = /^SK[0-9a-fA-F]{32}$/;
const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Twilio's documented Body limit. Longer text is refused (21617) rather than truncated. */
export const TWILIO_MAX_BODY_CHARS = 1600;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * The tenant's Twilio credential, stored in the vault as one JSON string. The auth token is always required: Twilio signs every webhook with
 * the account's auth token, so without it inbound replies and STOP messages could not be authenticated. An API key (SK…) is optional and, when
 * present, is what REST calls use, so the token can stay out of request traffic.
 */
export interface TwilioSecret {
  accountSid: string;
  authToken: string;
  apiKeySid: string | null;
  apiKeySecret: string | null;
}

const TOKENISH = /^[\x21-\x7e]{16,128}$/;

/** Parses the stored secret. Returns null for anything that is not a complete, well-formed credential. Never throws, never echoes input. */
export function parseTwilioSecret(raw: string): TwilioSecret | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string).trim() : null);
  const accountSid = str("accountSid");
  const authToken = str("authToken");
  const apiKeySid = str("apiKeySid") || null;
  const apiKeySecret = str("apiKeySecret") || null;
  if (!accountSid || !ACCOUNT_SID.test(accountSid) || !authToken || !TOKENISH.test(authToken)) return null;
  if (Boolean(apiKeySid) !== Boolean(apiKeySecret)) return null;
  if (apiKeySid && (!API_KEY_SID.test(apiKeySid) || !TOKENISH.test(apiKeySecret ?? ""))) return null;
  return { accountSid, authToken, apiKeySid, apiKeySecret };
}

/**
 * Builds the JSON string to store with saveCredential(provider "twilio") from what an admin typed. Throws a user-safe AppError naming the
 * field that is wrong, never the value.
 */
export function twilioSecretJson(input: { accountSid: string; authToken: string; apiKeySid?: string | null; apiKeySecret?: string | null }): string {
  const accountSid = input.accountSid.trim();
  const authToken = input.authToken.trim();
  const apiKeySid = input.apiKeySid?.trim() || null;
  const apiKeySecret = input.apiKeySecret?.trim() || null;
  if (!ACCOUNT_SID.test(accountSid)) throw new AppError("invalid_input", "Enter the Twilio Account SID: AC followed by 32 letters and digits.");
  if (!TOKENISH.test(authToken)) throw new AppError("invalid_input", "Enter the account's Auth Token from the Twilio Console. It is needed to verify Twilio's webhooks.");
  if (Boolean(apiKeySid) !== Boolean(apiKeySecret)) throw new AppError("invalid_input", "Enter both the API key SID and its secret, or neither.");
  if (apiKeySid && !API_KEY_SID.test(apiKeySid)) throw new AppError("invalid_input", "Enter the API key SID: SK followed by 32 letters and digits.");
  if (apiKeySecret && !TOKENISH.test(apiKeySecret)) throw new AppError("invalid_input", "Enter the API key secret exactly as Twilio showed it.");
  return JSON.stringify(apiKeySid ? { accountSid, authToken, apiKeySid, apiKeySecret } : { accountSid, authToken });
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
/** REST calls use the API key when one is stored, else the account SID and auth token. */
const restAuth = (s: TwilioSecret) => (s.apiKeySid && s.apiKeySecret ? basic(s.apiKeySid, s.apiKeySecret) : basic(s.accountSid, s.authToken));
/** The Account resource refuses Standard API keys, and the token is what signs webhooks, so the account check always uses the token. */
const tokenAuth = (s: TwilioSecret) => basic(s.accountSid, s.authToken);

// ---------------------------------------------------------------------------
// Webhook addresses
// ---------------------------------------------------------------------------

function webhookBase(): string {
  const e = env();
  return (e.TWILIO_WEBHOOK_BASE_URL ?? e.APP_URL).replace(/\/+$/, "");
}

/** The exact address to configure in Twilio for incoming messages (kind "inbound"); status callbacks are set per message. */
export function twilioWebhookUrl(kind: "inbound" | "status"): string {
  return `${webhookBase()}/api/webhooks/twilio/${kind}`;
}

/** Per-message StatusCallback carrying our message id, so a callback that arrives before the send returned is still matched. */
export function twilioStatusCallbackUrl(messageId: string): string {
  return `${twilioWebhookUrl("status")}?mid=${encodeURIComponent(messageId)}`;
}

/**
 * The URL Twilio signed, rebuilt from our configured public base (never from the request's Host or forwarded headers, which a caller
 * controls) plus the query string exactly as received. The fragment is never sent or signed.
 */
function signedUrlFor(kind: "inbound" | "status", requestUrl: string): string {
  const noFragment = requestUrl.split("#", 1)[0];
  const q = noFragment.indexOf("?");
  const query = q === -1 ? "" : noFragment.slice(q + 1);
  return query ? `${twilioWebhookUrl(kind)}?${query}` : twilioWebhookUrl(kind);
}

function isPublicHttps(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (u.protocol !== "https:") return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".test") || h.endsWith(".internal") || h.includes("_")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

export type TwilioParams = Map<string, string[]>;

/** Parses an application/x-www-form-urlencoded body, keeping repeated names (they are all signed). */
export function parseTwilioForm(rawBody: string): TwilioParams {
  const params: TwilioParams = new Map();
  for (const [k, v] of new URLSearchParams(rawBody)) {
    const list = params.get(k);
    if (list) list.push(v);
    else params.set(k, [v]);
  }
  return params;
}

/**
 * Twilio's signature: base64(HMAC-SHA1(authToken, url + name1 + value1 + name2 + value2 …)) with names sorted, and repeated values of one
 * name de-duplicated and sorted (as twilio-node's getExpectedTwilioSignature does).
 */
export function twilioSignature(authToken: string, url: string, params: TwilioParams | Record<string, string>): string {
  const map: TwilioParams = params instanceof Map ? params : new Map(Object.entries(params).map(([k, v]) => [k, [v]]));
  let data = url;
  for (const key of [...map.keys()].sort()) {
    const values = map.get(key) ?? [];
    const list = values.length > 1 ? [...new Set(values)].sort() : values;
    for (const value of list) data += key + value;
  }
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

function withoutPort(url: string): string {
  return url.replace(/^(https?:\/\/[^/?#]*?)(:\d+)(?=[/?#]|$)/i, "$1");
}
function withDefaultPort(url: string): string {
  const m = /^(https?):\/\/([^/?#]*)/i.exec(url);
  if (!m || /:\d+$/.test(m[2])) return url;
  return url.replace(/^(https?:\/\/[^/?#]*)/i, `$1${m[1].toLowerCase() === "https" ? ":443" : ":80"}`);
}

/** Constant-time check of X-Twilio-Signature, accepting the URL with or without its default port, as Twilio's own SDK does. */
export function verifyTwilioSignature(authToken: string, signature: string | null, url: string, params: TwilioParams): boolean {
  if (!signature || signature.length > 200) return false;
  const given = Buffer.from(signature, "utf8");
  const candidates = [...new Set([url, withoutPort(url), withDefaultPort(url)])];
  let valid = false;
  for (const candidate of candidates) {
    const expected = Buffer.from(twilioSignature(authToken, candidate, params), "utf8");
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) valid = true;
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_TEXT: Record<number, string> = {
  20003: "Twilio rejected the stored credentials.",
  20404: "Twilio could not find the account or sender.",
  20429: "Twilio's API rate limit was reached.",
  21211: "Twilio says the destination is not a valid phone number.",
  21408: "Twilio's Messaging Geo Permissions don't allow texting this country.",
  21606: "The configured sender is not an SMS-capable number on this Twilio account.",
  21608: "Trial Twilio accounts can only text verified numbers.",
  21609: "Twilio refused the status callback address. Set TWILIO_WEBHOOK_BASE_URL to the portal's public https address.",
  21610: "The recipient opted out (replied STOP) of this sender. Twilio won't deliver to them until they reply START.",
  21612: "Twilio can't send between this sender and this destination.",
  21614: "Twilio says the destination is not a mobile number that can receive SMS.",
  21617: "The message is longer than Twilio's 1,600-character limit.",
  21660: "The configured sender belongs to a different Twilio account.",
  21704: "The Messaging Service has no phone numbers in its sender pool.",
  30001: "Twilio's send queue for this sender overflowed.",
  30002: "The Twilio account is suspended.",
  30003: "The destination handset is unreachable (switched off or out of coverage).",
  30004: "The message was blocked by the destination or its carrier.",
  30005: "The destination number is unknown and may no longer exist.",
  30006: "The destination is a landline or its carrier can't be reached.",
  30007: "The carrier filtered the message as possible spam.",
  30008: "Delivery failed for an unknown reason (Twilio 30008).",
  30032: "The toll-free number has not been verified.",
  30034: "The US number is not registered for A2P 10DLC.",
  30035: "The US number is still being configured for A2P 10DLC.",
  30036: "Twilio couldn't send within the message's validity period.",
  30037: "Outbound messaging is disabled for this Twilio account.",
  30041: "The sender is not registered for the destination country.",
  30044: "The message is too long for a Twilio trial account.",
  30410: "The carrier timed out.",
  30450: "Twilio blocked delivery of the message.",
};

/** A short, user-safe description of a Twilio error code. Twilio's own message text is never passed on (it can contain the phone number). */
export function describeTwilioError(code: number | null | undefined): string {
  if (!code) return "Twilio refused the message.";
  return `${ERROR_TEXT[code] ?? "Twilio refused the message."} (Twilio ${code})`;
}

/** Codes that say something lasting about the destination address. Ambiguous carrier codes (30003–30006) never suppress. */
export function suppressionForTwilioError(code: number | null | undefined): "opt_out" | "invalid" | null {
  if (code === 21610) return "opt_out";
  if (code === 21211 || code === 21614) return "invalid";
  return null;
}

/** Credential and sender problems that a person must fix in the channel setup. */
const RECONNECT_CODES = new Set([20003, 20404, 21606, 21660, 21704, 30002, 30037]);

function failureFor(httpStatus: number, code: number | null): Extract<TransportResult, { ok: false }> {
  if (httpStatus === 401 || httpStatus === 403 || code === 20003) return { ok: false, retryable: false, reconnectRequired: true, error: describeTwilioError(code ?? 20003) };
  // Rejected before anything was accepted, so trying again later cannot send twice.
  if (httpStatus === 429 || code === 20429) return { ok: false, retryable: true, error: describeTwilioError(code ?? 20429) };
  if (httpStatus >= 500) return { ok: false, retryable: false, error: `Twilio returned ${httpStatus}. The message was not confirmed sent.` };
  const suppress = suppressionForTwilioError(code);
  return { ok: false, retryable: false, error: describeTwilioError(code), ...(suppress ? { suppress } : {}), ...(code && RECONNECT_CODES.has(code) ? { reconnectRequired: true } : {}) };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type CallResult = { reached: true; status: number; json: Record<string, unknown> | null } | { reached: false };

async function call(url: URL, auth: string, init: { form?: URLSearchParams; timeoutMs?: number } = {}): Promise<CallResult> {
  try {
    const res = await fetch(url, {
      method: init.form ? "POST" : "GET",
      headers: { Authorization: auth, Accept: "application/json", ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: init.form?.toString(),
      signal: AbortSignal.timeout(init.timeoutMs ?? 10000),
      redirect: "error",
      cache: "no-store",
    });
    const json: unknown = await res.json().catch(() => null);
    return { reached: true, status: res.status, json: json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null };
  } catch {
    return { reached: false };
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,6}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function loadSecret(credentialId: string, orgId: string): Promise<TwilioSecret | null> {
  try {
    const raw = await withSystem((db) => resolveCredential(db, credentialId, orgId, "twilio"));
    return raw ? parseTwilioSecret(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Sends one SMS. At most once: Twilio has no idempotency key for message creation, so a timeout or a 5xx is reported as "not confirmed sent"
 * and never retried automatically; only a 429 (refused before anything was accepted) is retryable. Delivery is never assumed from the
 * response; it advances only from Twilio's status callbacks.
 */
async function sendTwilio(req: TransportSendRequest): Promise<TransportResult> {
  if (!env().TWILIO_WRITES_ENABLED) return { ok: false, retryable: false, blocked: true, error: "Sending through Twilio is switched off for this environment." };
  if (req.channel !== "sms") return { ok: false, retryable: false, blocked: true, error: "Twilio is connected for SMS only." };
  const senderId = req.sender.senderId;
  if (!senderId || !(SERVICE_SID.test(senderId) || E164.test(senderId)) || !req.sender.credentialId) {
    return { ok: false, retryable: false, blocked: true, reconnectRequired: true, error: "Twilio SMS isn't connected for this workspace. Connect a sender and run its capability test." };
  }
  if (!UUID.test(req.messageId)) return { ok: false, retryable: false, error: "The message has no valid id to track delivery with." };
  const to = normalizePhone(req.to);
  if (!to || to !== req.to) return { ok: false, retryable: false, error: "The destination is not an international (E.164) phone number." };
  if (!req.body.trim()) return { ok: false, retryable: false, error: "The message is empty." };
  if ([...req.body].length > TWILIO_MAX_BODY_CHARS) return { ok: false, retryable: false, error: describeTwilioError(21617) };

  const secret = await loadSecret(req.sender.credentialId, req.orgId);
  if (!secret) return { ok: false, retryable: false, blocked: true, reconnectRequired: true, error: "The stored Twilio credential is missing, revoked or unreadable. Reconnect Twilio." };
  if (req.sender.accountId && req.sender.accountId !== secret.accountSid) {
    return { ok: false, retryable: false, blocked: true, reconnectRequired: true, error: "The stored Twilio credential belongs to a different account than this sender. Reconnect Twilio." };
  }

  const form = new URLSearchParams();
  form.set("To", to);
  if (SERVICE_SID.test(senderId)) form.set("MessagingServiceSid", senderId);
  else form.set("From", senderId);
  form.set("Body", req.body);
  form.set("StatusCallback", twilioStatusCallbackUrl(req.messageId));

  const res = await call(new URL(`/2010-04-01/Accounts/${secret.accountSid}/Messages.json`, API_ORIGIN), restAuth(secret), { form, timeoutMs: 20000 });
  // A timeout can mean Twilio did accept it. The dispatcher records an unconfirmed send as failed instead of repeating it.
  if (!res.reached) return { ok: false, retryable: false, error: "Twilio could not be reached. The message was not confirmed sent." };
  const code = int(res.json?.code);
  if (res.status !== 200 && res.status !== 201) return failureFor(res.status, code);

  const sid = str(res.json?.sid);
  if (!sid || !MESSAGE_SID.test(sid)) return { ok: false, retryable: false, error: "Twilio did not confirm the message." };
  const status = str(res.json?.status);
  if (status === "failed" || status === "undelivered" || status === "canceled") {
    const errorCode = int(res.json?.error_code);
    const suppress = suppressionForTwilioError(errorCode);
    return { ok: false, retryable: false, error: describeTwilioError(errorCode), ...(suppress ? { suppress } : {}) };
  }
  // num_segments is a string, and "0" while a Messaging Service has not picked a sender yet: only a real count is reported.
  const segments = int(res.json?.num_segments);
  return { ok: true, providerMessageId: sid, providerConversationId: null, quantity: segments && segments >= 1 && segments <= 50 ? segments : null };
}

export const twilioTransport: ChannelTransport = { name: "twilio", channels: ["sms"], requiresContactRef: false, send: sendTwilio };

// ---------------------------------------------------------------------------
// Capability test
// ---------------------------------------------------------------------------

/** Normalizes what an admin typed as the sender: a Messaging Service SID or an E.164 number. */
export function normalizeTwilioSender(raw: string): string | null {
  const s = raw.trim();
  if (SERVICE_SID.test(s)) return `MG${s.slice(2).toLowerCase()}`;
  const phone = normalizePhone(s);
  return phone && E164.test(phone) ? phone : null;
}

function sameWebhookUrl(configured: string | null, expected: string): boolean {
  if (!configured) return false;
  const c = configured.split("#", 1)[0].trim();
  return c === expected || withoutPort(c) === expected;
}

const capabilityList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.toUpperCase()) : []);

/**
 * What the Twilio capability test needs. The sender may be given directly (senderId) or as channel setup's sender object (the registry's
 * CapabilityTestInput), so the same function serves both callers.
 */
export interface TwilioCapabilityInput {
  /** The vault secret: JSON {accountSid, authToken} with an optional {apiKeySid, apiKeySecret}. */
  secret: string;
  /** A Messaging Service SID (MG…) or a Twilio phone number in E.164 form. */
  senderId?: string | null;
  sender?: { senderId: string | null } | null;
  channel?: Channel;
}

/**
 * Proves, with the tenant's own credential, that SMS can work end to end: the auth token is valid and the account active and upgraded, the API
 * key (if any) works, the sender belongs to the account and can send SMS, incoming messages are routed to iAcquire's webhook, and US carrier
 * registration is confirmed where the API can show it. Read-only: it sends nothing. The result never contains a secret.
 */
export async function testTwilioCapability(input: TwilioCapabilityInput): Promise<CapabilityTest> {
  const checkedAt = new Date().toISOString();
  const checks: CapabilityTest["checks"] = [];
  const done = (extra: Partial<CapabilityTest> = {}): CapabilityTest => ({ ok: checks.length > 0 && checks.every((c) => c.ok), checkedAt, checks, ...extra });

  if (input.channel && input.channel !== "sms") {
    checks.push({ label: "Channel", ok: false, detail: "Twilio is connected for SMS only." });
    return done();
  }
  const secret = parseTwilioSecret(input.secret);
  if (!secret) {
    checks.push({ label: "Credential", ok: false, detail: "The credential must hold the Account SID (AC…) and its Auth Token, and optionally an API key SID (SK…) with its secret." });
    return done();
  }
  const senderId = normalizeTwilioSender(input.senderId ?? input.sender?.senderId ?? "");
  if (!senderId) {
    checks.push({ label: "Sender", ok: false, detail: "Enter a Messaging Service SID (MG…) or a Twilio phone number in international format, such as +15551234567." });
    return done({ accountId: secret.accountSid });
  }

  // 1. The auth token: the Account resource accepts only the account's own SID and token (or a Main key), and this token signs webhooks.
  const account = await call(new URL(`/2010-04-01/Accounts/${secret.accountSid}.json`, API_ORIGIN), tokenAuth(secret));
  if (!account.reached) {
    checks.push({ label: "Twilio account", ok: false, detail: "Twilio could not be reached. Try again in a minute." });
    return done({ accountId: secret.accountSid, senderId });
  }
  if (account.status === 401 || account.status === 403 || account.status === 404) {
    checks.push({ label: "Twilio account", ok: false, detail: "Twilio rejected the Account SID and Auth Token. Copy both again from the Twilio Console." });
    return done({ accountId: secret.accountSid, senderId });
  }
  if (account.status !== 200 || str(account.json?.sid) !== secret.accountSid) {
    checks.push({ label: "Twilio account", ok: false, detail: `Twilio answered ${account.status} when the account was checked.` });
    return done({ accountId: secret.accountSid, senderId });
  }
  const accountStatus = str(account.json?.status);
  const accountType = str(account.json?.type);
  const accountName = (str(account.json?.friendly_name) ?? "").slice(0, 80);
  if (accountStatus !== "active") {
    checks.push({ label: "Twilio account", ok: false, detail: `The Twilio account is ${accountStatus ?? "not active"}. Only an active account can send.` });
  } else if (accountType === "Trial") {
    checks.push({ label: "Twilio account", ok: false, detail: "This is a Twilio trial account: it can only text verified numbers and adds a trial notice to every message. Upgrade it first." });
  } else {
    checks.push({ label: "Twilio account", ok: true, detail: `${accountName ? `"${accountName}" ` : "The account "}is active, and the Auth Token that signs webhooks is valid.` });
  }

  // 2. The API key, when one is stored: it is what sends.
  if (secret.apiKeySid) {
    const keyCheck = await call(new URL(`/2010-04-01/Accounts/${secret.accountSid}/IncomingPhoneNumbers.json?PageSize=1`, API_ORIGIN), restAuth(secret));
    const ok = keyCheck.reached && keyCheck.status === 200;
    checks.push({ label: "API key", ok, detail: ok ? "The API key can use this account." : keyCheck.reached ? `Twilio refused the API key (${keyCheck.status}). Check that it belongs to this account.` : "Twilio could not be reached to check the API key." });
  }

  // 3. The sender, and 4. where its incoming messages go.
  const inboundUrl = twilioWebhookUrl("inbound");
  let senderIdentity: string | null = null;
  let registrationStatus: CapabilityTest["registrationStatus"] = "not_required";
  if (SERVICE_SID.test(senderId)) {
    const svc = await call(new URL(`/v1/Services/${senderId}`, MESSAGING_ORIGIN), restAuth(secret));
    if (!svc.reached || svc.status !== 200 || str(svc.json?.account_sid) !== secret.accountSid) {
      checks.push({ label: "Messaging Service", ok: false, detail: !svc.reached ? "Twilio could not be reached to check the Messaging Service." : svc.status === 404 || svc.status === 200 ? "That Messaging Service isn't in this Twilio account." : `Twilio answered ${svc.status} for the Messaging Service.` });
      return done({ accountId: secret.accountSid, senderId });
    }
    const numbers = await call(new URL(`/v1/Services/${senderId}/PhoneNumbers?PageSize=50`, MESSAGING_ORIGIN), restAuth(secret));
    const pool = numbers.reached && numbers.status === 200 && Array.isArray(numbers.json?.phone_numbers) ? (numbers.json.phone_numbers as Array<Record<string, unknown>>) : [];
    const smsNumbers = pool.filter((n) => capabilityList(n.capabilities).includes("SMS")).map((n) => str(n.phone_number)).filter((n): n is string => Boolean(n && E164.test(n)));
    let shortCodes: string[] = [];
    if (!smsNumbers.length) {
      const codes = await call(new URL(`/v1/Services/${senderId}/ShortCodes?PageSize=20`, MESSAGING_ORIGIN), restAuth(secret));
      const list = codes.reached && codes.status === 200 && Array.isArray(codes.json?.short_codes) ? (codes.json.short_codes as Array<Record<string, unknown>>) : [];
      shortCodes = list.filter((c) => capabilityList(c.capabilities).includes("SMS")).map((c) => str(c.short_code)).filter((c): c is string => Boolean(c && /^\d{3,8}$/.test(c)));
    }
    const senders = smsNumbers.length + shortCodes.length;
    senderIdentity = smsNumbers[0] ?? shortCodes[0] ?? null;
    const name = (str(svc.json?.friendly_name) ?? "").slice(0, 80);
    checks.push({
      label: "Messaging Service",
      ok: senders > 0,
      detail: senders > 0 ? `${name ? `"${name}"` : "The service"} has ${senders} SMS-capable sender${senders === 1 ? "" : "s"}${senderIdentity ? `, starting with ${senderIdentity}` : ""}.` : "The Messaging Service has no SMS-capable phone number or short code in its sender pool. Add one in Twilio.",
    });
    const perNumber = svc.json?.use_inbound_webhook_on_number === true;
    const routed = !perNumber && sameWebhookUrl(str(svc.json?.inbound_request_url), inboundUrl) && (str(svc.json?.inbound_method) ?? "POST").toUpperCase() === "POST";
    checks.push({
      label: "Incoming messages",
      ok: routed,
      detail: routed ? "Replies and STOP messages come to iAcquire." : perNumber ? `The service is set to use each number's own webhook. Turn that off and set the service's incoming message URL to ${inboundUrl} (HTTP POST).` : `Set the Messaging Service's incoming message webhook to ${inboundUrl} (HTTP POST), so replies and STOP messages reach the inbox.`,
    });
    if (svc.json?.us_app_to_person_registered === true) registrationStatus = "approved";
    else if (smsNumbers.some((n) => n.startsWith("+1"))) registrationStatus = "pending";
  } else {
    const list = await call(new URL(`/2010-04-01/Accounts/${secret.accountSid}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: senderId, PageSize: "20" })}`, API_ORIGIN), restAuth(secret));
    const rows = list.reached && list.status === 200 && Array.isArray(list.json?.incoming_phone_numbers) ? (list.json.incoming_phone_numbers as Array<Record<string, unknown>>) : [];
    const number = rows.find((r) => str(r.phone_number) === senderId && (str(r.account_sid) ?? secret.accountSid) === secret.accountSid);
    if (!number) {
      checks.push({ label: "Phone number", ok: false, detail: list.reached ? `${senderId} isn't a phone number in this Twilio account.` : "Twilio could not be reached to check the phone number." });
      return done({ accountId: secret.accountSid, senderId });
    }
    const caps = number.capabilities && typeof number.capabilities === "object" ? (number.capabilities as Record<string, unknown>) : {};
    checks.push({ label: "Phone number", ok: caps.sms === true, detail: caps.sms === true ? `${senderId} is in the account and can send SMS.` : `${senderId} is in the account but can't send SMS.` });
    senderIdentity = senderId;
    const routed = sameWebhookUrl(str(number.sms_url), inboundUrl) && (str(number.sms_method) ?? "POST").toUpperCase() === "POST";
    checks.push({
      label: "Incoming messages",
      ok: routed,
      detail: routed ? "Replies and STOP messages come to iAcquire." : `Set the number's "A message comes in" webhook to ${inboundUrl} (HTTP POST). If the number is in a Messaging Service, connect the Messaging Service SID instead.`,
    });
    // Twilio's number API doesn't report A2P 10DLC or toll-free verification, so a US number can't be confirmed registered here.
    if (senderId.startsWith("+1")) registrationStatus = "pending";
  }

  checks.push({
    label: "Webhook address",
    ok: isPublicHttps(inboundUrl),
    detail: isPublicHttps(inboundUrl) ? `Twilio will call ${inboundUrl} and ${twilioWebhookUrl("status")}.` : `${inboundUrl} isn't a public https address Twilio can reach. Set TWILIO_WEBHOOK_BASE_URL (or APP_URL) to the portal's public address.`,
  });
  if (registrationStatus === "pending") {
    checks.push({
      label: "US carrier registration",
      ok: false,
      detail: SERVICE_SID.test(senderId)
        ? "The Messaging Service has US numbers but no registered A2P 10DLC campaign. US carriers filter unregistered traffic; finish registration in Twilio and test again."
        : "US numbers need A2P 10DLC registration (or toll-free verification), which Twilio's number API doesn't report. Add the number to a registered Messaging Service and connect that instead.",
    });
  } else if (registrationStatus === "approved") {
    checks.push({ label: "US carrier registration", ok: true, detail: "The Messaging Service has a registered US A2P 10DLC campaign." });
  }
  return done({ accountId: secret.accountSid, senderId, senderIdentity, registrationStatus });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface TwilioWebhookResult {
  status: number;
  body: string;
  contentType: string;
  outcome: "processed" | "duplicate" | "ignored" | "rejected";
  detail?: string;
  orgId?: string;
  conversationId?: string;
  /** The inbound message should get an automatic reply prepared (after the response is sent). */
  aiShouldRespond?: boolean;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;
function header(headers: HeaderSource, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const v = key ? headers[key] : undefined;
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

interface TwilioTenant {
  orgId: string;
  credentialId: string;
  accountId: string | null;
}

/**
 * Finds the one workspace a webhook belongs to, only from our own records: the sender it names (Messaging Service SID, or our number: To for
 * an incoming message, From for a status callback) and, for a status callback, the message id we put in its URL. Anything that points at
 * two workspaces, or at none, is refused.
 */
async function locateTenant(db: Queryable, kind: "inbound" | "status", first: (k: string) => string | null, mid: string | null): Promise<TwilioTenant | null> {
  const found = new Map<string, TwilioTenant>();
  const add = (orgId: string, credentialId: string | null, accountId: string | null) => {
    if (!credentialId) return false;
    const prior = found.get(orgId);
    if (prior && prior.credentialId !== credentialId) return false;
    found.set(orgId, { orgId, credentialId, accountId });
    return true;
  };
  if (mid) {
    const { rows } = await db.query<{ org_id: string; credential_id: string | null; provider_account_id: string | null }>(
      `select mc.org_id, mc.credential_id, mc.provider_account_id from conversation_messages m
       join conversations c on c.id = m.conversation_id
       join messaging_channels mc on mc.org_id = m.org_id and mc.channel = c.channel and mc.provider = 'twilio'
       where m.id = $1 and m.direction = 'outbound'`,
      [mid],
    );
    if (rows[0]) add(rows[0].org_id, rows[0].credential_id, rows[0].provider_account_id);
  }
  const candidates = [first("MessagingServiceSid"), kind === "inbound" ? first("To") : first("From")].filter((s): s is string => Boolean(s && (SERVICE_SID.test(s) || E164.test(s))));
  for (const senderId of [...new Set(candidates)]) {
    const ch = await resolveChannelByProviderSender(db, "twilio", senderId);
    if (ch && ch.channel === "sms" && !add(ch.orgId, ch.credentialId ?? null, ch.accountId ?? null)) return null;
  }
  if (found.size !== 1) return null;
  return [...found.values()][0];
}

/** Webhook verification resolves the tenant's token often (several callbacks per message), so it is kept in memory briefly. */
const SECRET_TTL_MS = 60_000;
const secretCache = new Map<string, { secret: TwilioSecret; expires: number }>();
async function webhookSecret(t: TwilioTenant): Promise<TwilioSecret | null> {
  const key = `${t.orgId}:${t.credentialId}`;
  const hit = secretCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.secret;
  const secret = await loadSecret(t.credentialId, t.orgId);
  if (!secret) {
    secretCache.delete(key);
    return null;
  }
  if (secretCache.size > 500) secretCache.clear();
  secretCache.set(key, { secret, expires: Date.now() + SECRET_TTL_MS });
  return secret;
}

/** Tests only: forgets cached webhook credentials. */
export function resetTwilioWebhookCache() {
  secretCache.clear();
}

const DELIVERY: Record<string, "sent" | "delivered" | "read" | "failed" | "undelivered"> = {
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
  undelivered: "undelivered",
  // Only scheduled messages can be canceled; iAcquire never schedules through Twilio, but a canceled message was certainly not delivered.
  canceled: "failed",
};

/** Twilio delivers at most 10 media items with one incoming MMS. */
const MAX_INBOUND_MEDIA = 10;

/**
 * The opt-out words Twilio honours by default on long codes (Advanced Opt-Out docs). When one of them is the whole message, Twilio replies and
 * stops delivering to the person even without Advanced Opt-Out, which is when OptOutType is absent.
 */
const TWILIO_DEFAULT_STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "END", "QUIT", "STOPALL", "REVOKE", "OPTOUT", "CANCEL"]);
/** The message as a keyword: carriers match the whole message, ignoring case and trailing punctuation. */
const keywordOf = (body: string) => body.trim().toUpperCase().replace(/[.!?\s]+$/g, "");

/**
 * The incoming message as the inbox records it. Media is described by content type only (never downloaded or stored: the URLs need the
 * account's credentials), and the shared ingest adds the note that attachments aren't shown yet.
 */
function inboundContent(first: (k: string) => string | null): { body: string; attachments: Array<{ contentType: string | null }> } {
  const numMedia = Math.min(int(first("NumMedia")) ?? 0, MAX_INBOUND_MEDIA);
  const attachments = Array.from({ length: numMedia }, (_, i) => ({ contentType: (first(`MediaContentType${i}`) ?? "").trim().slice(0, 100) || null }));
  const text = (first("Body") ?? "").slice(0, TWILIO_MAX_BODY_CHARS);
  const empty = !text.trim() && attachments.length === 0;
  return { body: empty ? "[Empty message]" : text, attachments };
}

/**
 * Handles one Twilio webhook: "inbound" (a customer texted the workspace's number) or "status" (a delivery update for a message we sent).
 *
 * Order matters. The tenant is found from our own records, its auth token checks X-Twilio-Signature over the URL rebuilt from our configured
 * public base, and only then is anything written. An unknown sender and a bad signature get the same bare 403, so a caller learns nothing
 * about which numbers are connected, and nothing is stored for a request that was not authenticated. Replays are dropped by a receipt keyed
 * on signed fields (the idempotency header is not covered by the signature, so it cannot be the replay key). Incoming messages go through
 * the provider-neutral ingest (consent, STOP/START, follow-ups, escalation); status callbacks are matched by our message id first.
 */
export async function handleTwilioWebhook(kind: "inbound" | "status", rawBody: string, headers: HeaderSource, url: string): Promise<TwilioWebhookResult> {
  const plain = "text/plain; charset=utf-8";
  const forbidden: TwilioWebhookResult = { status: 403, body: "Forbidden", contentType: plain, outcome: "rejected" };
  if (kind !== "inbound" && kind !== "status") return { status: 404, body: "Not found", contentType: plain, outcome: "rejected" };
  const ok = (outcome: TwilioWebhookResult["outcome"], extra: Partial<TwilioWebhookResult> = {}): TwilioWebhookResult =>
    kind === "inbound" ? { status: 200, body: EMPTY_TWIML, contentType: "text/xml; charset=utf-8", outcome, ...extra } : { status: 200, body: "", contentType: plain, outcome, ...extra };

  if (!/^application\/x-www-form-urlencoded\b/i.test(header(headers, "content-type") ?? "")) return { status: 400, body: "Bad request", contentType: plain, outcome: "rejected" };
  const signature = header(headers, "x-twilio-signature");
  if (!signature) return forbidden;
  const params = parseTwilioForm(rawBody);
  const first = (k: string) => params.get(k)?.[0] ?? null;
  const accountSid = first("AccountSid");
  if (!accountSid || !ACCOUNT_SID.test(accountSid)) return forbidden;
  let midRaw: string | null = null;
  try {
    midRaw = new URL(url).searchParams.get("mid");
  } catch {
    midRaw = null;
  }
  const mid = kind === "status" && midRaw && UUID.test(midRaw) ? midRaw.toLowerCase() : null;

  const tenant = await withSystem((db) => locateTenant(db, kind, first, mid));
  if (!tenant) return forbidden;
  const secret = await webhookSecret(tenant);
  if (!secret || secret.accountSid !== accountSid || (tenant.accountId && tenant.accountId !== accountSid)) return forbidden;
  if (!verifyTwilioSignature(secret.authToken, signature, signedUrlFor(kind, url), params)) return forbidden;

  const orgId = tenant.orgId;
  const messageSid = first("MessageSid");
  if (!messageSid || !MESSAGE_SID.test(messageSid)) return ok("ignored", { detail: "No message id.", orgId });

  if (kind === "status") {
    const rawStatus = (first("MessageStatus") ?? "").toLowerCase().slice(0, 40);
    if (!/^[a-z_]+$/.test(rawStatus)) return ok("ignored", { detail: "No status.", orgId });
    const receiptId = `status:${messageSid}:${rawStatus}`;
    return withSystem(async (db) => {
      const receipt = await db.query("insert into webhook_receipts (provider, external_id, kind, org_id) values ('twilio', $1, 'sms.status', $2) on conflict do nothing returning external_id", [receiptId, orgId]);
      if (!receipt.rows[0]) return ok("duplicate", { orgId });
      const finish = async (result: TwilioWebhookResult) => {
        await db.query("update webhook_receipts set outcome = $2, detail = $3 where provider = 'twilio' and external_id = $1", [receiptId, result.outcome === "duplicate" ? "ignored" : result.outcome, result.detail?.slice(0, 300) ?? null]);
        return result;
      };
      const status = DELIVERY[rawStatus];
      if (!status) return finish(ok("ignored", { detail: `Status "${rawStatus}" is not a delivery update.`, orgId }));
      const errorCode = int(first("ErrorCode"));
      const segments = int(first("NumSegments"));
      const event: DeliveryEventInput = {
        provider: "twilio",
        providerEventId: `${messageSid}:${rawStatus}`,
        providerMessageId: messageSid,
        status,
        rawStatus,
        segments: segments && segments >= 1 && segments <= 50 ? segments : null,
        occurredAt: new Date(),
        detail: errorCode ? describeTwilioError(errorCode) : undefined,
        suppress: suppressionForTwilioError(errorCode) ?? undefined,
      };
      // Our message id first (it is set before the send returns); without one, Twilio's MessageSid as the dispatcher recorded it.
      const applied = mid ? await applyDeliveryEventForMessage(db, { ...event, messageId: mid }) : await applyDeliveryEvent(db, event);
      return finish(ok(applied.result === "applied" ? "processed" : "ignored", { detail: applied.result, orgId }));
    });
  }

  // Incoming message.
  const receiptId = `inbound:${messageSid}`;
  const emails: OutgoingEmail[] = [];
  const outcome = await withSystem(async (db): Promise<TwilioWebhookResult> => {
    const receipt = await db.query("insert into webhook_receipts (provider, external_id, kind, org_id) values ('twilio', $1, 'sms.inbound', $2) on conflict do nothing returning external_id", [receiptId, orgId]);
    if (!receipt.rows[0]) return ok("duplicate", { orgId });
    const finish = async (result: TwilioWebhookResult) => {
      await db.query("update webhook_receipts set outcome = $2, detail = $3 where provider = 'twilio' and external_id = $1", [receiptId, result.outcome === "duplicate" ? "ignored" : result.outcome, result.detail?.slice(0, 300) ?? null]);
      return result;
    };
    const from = first("From") ?? "";
    // whatsapp:, messenger:, rcs: … are other Twilio channels; this connection carries SMS only.
    if (/^[a-z]+:/i.test(from)) return finish(ok("ignored", { detail: "Only SMS is handled on this connection.", orgId }));
    const address = normalizePhone(from);
    if (!address || !E164.test(address)) return finish(ok("ignored", { detail: "The sender has no phone number that can be answered.", orgId }));
    const optOutType = (first("OptOutType") ?? "").toUpperCase();
    const r = await ingestInbound(db, {
      orgId,
      provider: "twilio",
      channel: "sms",
      address,
      ...inboundContent(first),
      providerMessageId: messageSid,
      receivedAt: new Date(),
    });
    emails.push(...r.emails);
    // Twilio blocks the sender for this person when Advanced Opt-Out matched a STOP keyword (OptOutType), or, without Advanced Opt-Out, when the
    // whole message is one of Twilio's default opt-out words. Either way later sends would fail with 21610, so the opt-out is recorded here too.
    const twilioStop = optOutType === "STOP" || (!optOutType && TWILIO_DEFAULT_STOP_WORDS.has(keywordOf(first("Body") ?? "")));
    if (r.status === "created") {
      // A keyword the shared list may not know (REVOKE, a custom or translated word) is honoured the same way.
      if (twilioStop && r.optOut !== "stop") {
        for (const purpose of ["service", "marketing"] as const) {
          await recordConsent(db, { orgId, contactId: r.contactId, channel: "sms", purpose, status: "revoked", source: "provider_opt_out", evidence: "Twilio matched an opt-out keyword." });
        }
        await suppressAddress(db, { orgId, channel: "sms", address, reason: "opt_out", source: "twilio_opt_out" });
        await cancelFollowUps(db, { orgId, contactId: r.contactId, reason: "customer_opted_out" });
        await cancelPendingAiMessages(db, orgId, r.conversationId, "suppressed");
      } else if (optOutType === "START" && r.optOut !== "start") {
        await liftSuppression(db, { orgId, channel: "sms", address, reasons: KEYWORD_LIFTABLE_SUPPRESSIONS });
        await recordConsent(db, { orgId, contactId: r.contactId, channel: "sms", purpose: "service", status: "granted", source: "provider_opt_in", evidence: "Twilio Advanced Opt-Out matched an opt-in keyword." });
      }
    }
    // When Twilio matched an opt-out keyword it has already replied; Twilio advises against sending another message.
    const aiShouldRespond = r.status === "created" && r.aiShouldRespond && !optOutType && !twilioStop;
    return finish(ok(r.status === "duplicate" ? "duplicate" : "processed", { orgId, conversationId: r.conversationId, aiShouldRespond, detail: optOutType ? `Opt-out keyword: ${optOutType.slice(0, 10)}` : undefined }));
  });
  await Promise.all(emails.map((e) => sendEmail(e)));
  return outcome;
}
