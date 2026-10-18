import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { sendEmail, type OutgoingEmail } from "@/server/email";
import { resolveCredential } from "@/server/security/credentials";
import { recordConsent } from "@/server/messaging/contacts";
import { ingestInbound, resolveChannelByProviderSender } from "@/server/messaging/ingest";
import { applyDeliveryEvent, applyDeliveryEventForMessage } from "@/server/messaging/send";
import { normalizePhone } from "@/lib/messaging";
import type { WhatsappTemplateVariable } from "@/server/messaging/whatsapp-templates";
import type { CapabilityTest, ChannelTransport, TransportResult, TransportSendRequest, TransportSender } from "@/server/messaging/transports/types";

// WhatsApp through Meta's WhatsApp Business Cloud API (Graph API).
//
// Contract sources, read 2026-10-16 (details and links in docs/messaging-providers.md, "WhatsApp (Meta Cloud API)"):
//   * Graph API changelog: the latest version is v26.0 (released July 29, 2026); v25.0 is available until July 29, 2028.
//   * Messages API reference and "Service messages" / "Text messages": POST /{Version}/{Phone-Number-ID}/messages, Bearer token, JSON body
//     { messaging_product: "whatsapp", recipient_type: "individual", to, type, text: { body ≤ 4096 } | template: { name, language: { code },
//     components: [{ type: "header"|"body", parameters: [{ type: "text", text, parameter_name? }] }] } }. The 200 response only means
//     "accepted": messages[0].id is the wamid; delivery comes from status webhooks.
//   * WhatsApp changelog: biz_opaque_callback_data (≤ 512 characters) is accepted on free-form and template messages and echoed on every
//     status webhook for that message.
//   * Webhooks "Create a webhook endpoint": GET hub.mode=subscribe & hub.verify_token & hub.challenge (answer 200 with the challenge);
//     POST signed with X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body keyed with the app secret>; batches of up to 1,000
//     updates; failed deliveries are retried for up to 7 days, so the receiver deduplicates.
//   * Messages webhook references (text, image, button, interactive, location, reaction, system, unsupported, status): entry[].changes[] with
//     field "messages" and value.metadata.phone_number_id, value.contacts[], value.messages[], value.statuses[] (status sent | delivered |
//     read | failed | played, errors[], pricing { billable, pricing_model, type, category }, biz_opaque_callback_data).
//   * Business-scoped user IDs: a user who adopted a WhatsApp username may arrive with from_user_id and no `from` phone number.
//   * Error codes: 131047 re-engagement (outside the 24-hour window), 131026 undeliverable, 131050 the user stopped marketing messages,
//     190 expired token, 130429 / 131056 / 80007 / 4 rate limits, 132xxx template problems, …
//
// Nothing here has been exercised against a live Meta account. Sending is off unless META_WHATSAPP_WRITES_ENABLED=true.

const GRAPH_ORIGIN = "https://graph.facebook.com";
/** The Graph API version every call uses (latest stable on 2026-10-16). */
export const META_GRAPH_VERSION = "v26.0";
const NUMERIC_ID = /^[0-9]{5,25}$/;
const WAMID = /^wamid\.[A-Za-z0-9+/=_-]{8,150}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9][0-9]{6,14}$/;
/** Meta's documented limit for a text message body. Longer text is refused, never truncated. */
export const META_MAX_TEXT_CHARS = 4096;
/** Our own cap on one template parameter value (Meta documents no per-parameter maximum; this keeps a request sane). */
const MAX_TEMPLATE_PARAM_CHARS = 1024;
/** Meta batches up to 1,000 updates in one request. Past this many events the request is answered 500, so Meta delivers the rest again. */
const MAX_EVENTS_PER_REQUEST = 2000;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * The tenant's WhatsApp credential, stored in the vault as one JSON string: a System User access token with the whatsapp_business_messaging
 * and whatsapp_business_management permissions on the workspace's WhatsApp Business Account. The app secret that signs webhooks is
 * agency-level (META_APP_SECRET), because every workspace's account is subscribed to the same iAcquire Meta app.
 */
export interface MetaWhatsappSecret {
  accessToken: string;
}

const TOKENISH = /^[\x21-\x7e]{20,2048}$/;

/** Parses the stored secret. Returns null for anything that is not a well-formed credential. Never throws, never echoes input. */
export function parseMetaWhatsappSecret(raw: string): MetaWhatsappSecret | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const token = (value as Record<string, unknown>).accessToken;
  if (typeof token !== "string" || !TOKENISH.test(token.trim())) return null;
  return { accessToken: token.trim() };
}

/** Builds the JSON string to store with saveCredential(provider "meta_whatsapp"). Throws a user-safe AppError that never contains the value. */
export function metaWhatsappSecretJson(input: { accessToken: string }): string {
  const accessToken = input.accessToken.trim();
  if (!TOKENISH.test(accessToken)) throw new AppError("invalid_input", "Paste the System User access token from Meta Business Settings exactly as Meta showed it.");
  return JSON.stringify({ accessToken });
}

async function loadSecret(credentialId: string, orgId: string): Promise<MetaWhatsappSecret | null> {
  try {
    const raw = await withSystem((db) => resolveCredential(db, credentialId, orgId, "meta_whatsapp"));
    return raw ? parseMetaWhatsappSecret(raw) : null;
  } catch {
    return null;
  }
}

/** The tenant's access token for a credential id. For the template sync, which runs outside any request. */
export async function resolveMetaWhatsappToken(credentialId: string, orgId: string): Promise<string | null> {
  return (await loadSecret(credentialId, orgId))?.accessToken ?? null;
}

// ---------------------------------------------------------------------------
// Graph API calls
// ---------------------------------------------------------------------------

export type GraphResult = { reached: true; status: number; json: Record<string, unknown> | null } | { reached: false };

/**
 * One Graph API call to the official host, pinned to META_GRAPH_VERSION. The path is built only from ids we validated, never from a URL a
 * response or a request supplied. Redirects are refused. The token travels only in the Authorization header.
 */
export async function metaGraph(method: "GET" | "POST", path: string, accessToken: string, opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<GraphResult> {
  const url = new URL(`/${META_GRAPH_VERSION}/${path}`, GRAPH_ORIGIN);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
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
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,12}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The Graph error code of an error response ({ error: { code, … } }). Meta's own message and details are never passed on. */
export function metaErrorCode(json: Record<string, unknown> | null): number | null {
  return int(obj(json?.error)?.code);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_TEXT: Record<number, string> = {
  0: "Meta could not authenticate the stored access token.",
  3: "The access token lacks a permission this call needs.",
  4: "The Meta app reached its API call rate limit.",
  10: "The access token's permission was not granted or was removed.",
  33: "The WhatsApp business phone number has been deleted.",
  100: "Meta refused a parameter of the request.",
  190: "The stored access token has expired or was invalidated.",
  200: "The access token has no permission for this WhatsApp Business Account.",
  368: "The WhatsApp Business Account is restricted or disabled for a policy violation.",
  80007: "The WhatsApp Business Account reached its API rate limit.",
  130403: "This business has blocked the recipient on WhatsApp.",
  130429: "WhatsApp's message throughput limit was reached.",
  130472: "Meta held the message back as part of a marketing message experiment.",
  130497: "The WhatsApp Business Account may not message users in the recipient's country.",
  131000: "WhatsApp failed to send the message for an unknown reason.",
  131005: "The access token's permission was not granted or was removed.",
  131008: "The request was missing a required parameter.",
  131009: "Meta refused a parameter value of the request.",
  131016: "A WhatsApp service was temporarily unavailable.",
  131021: "The recipient is the business's own number.",
  131026: "WhatsApp could not deliver the message (the number may not use WhatsApp, or runs an old version, or hasn't accepted the latest terms).",
  131031: "The WhatsApp Business Account is locked or restricted.",
  131037: "The business phone number has no approved display name.",
  131042: "There is a problem with the WhatsApp Business Account's payment method.",
  131045: "The business phone number is not registered on the WhatsApp Business Platform.",
  131047: "More than 24 hours have passed since the customer last wrote, so only an approved template can be sent.",
  131048: "WhatsApp limited this number because earlier messages were blocked or flagged as spam.",
  131049: "Meta held the message back to protect the recipient's experience (per-user marketing limit).",
  131050: "The recipient has stopped marketing messages from this business on WhatsApp.",
  131051: "WhatsApp doesn't support this message type.",
  131052: "WhatsApp couldn't download the media the customer sent.",
  131053: "WhatsApp couldn't upload the media in the message.",
  131056: "Too many messages went to this recipient in a short time.",
  131057: "The WhatsApp Business Account is in maintenance mode.",
  131063: "Marketing templates are switched off for this account's Cloud API.",
  131064: "The account reached its messaging limit because of template classification violations.",
  132000: "The number of template values doesn't match the template.",
  132001: "The template doesn't exist in this language or isn't approved.",
  132005: "The translated template text is too long.",
  132007: "The template content violates a WhatsApp policy.",
  132012: "The template values are not in the format the template expects.",
  132015: "The template is paused for low quality.",
  132016: "The template was paused too often and is now disabled.",
  132018: "Meta found a problem with the template's parameters.",
  133004: "A WhatsApp server was temporarily unavailable.",
  133010: "The business phone number is not registered on the WhatsApp Business Platform.",
  135000: "WhatsApp failed to send the message because of a request parameter.",
};

/** A short, user-safe description of a Meta error code. Meta's own message text is never passed on (it can contain the phone number). */
export function describeMetaError(code: number | null | undefined): string {
  if (code === null || code === undefined) return "WhatsApp refused the message.";
  const known = ERROR_TEXT[code] ?? (code >= 200 && code <= 299 ? ERROR_TEXT[200] : "WhatsApp refused the message.");
  return `${known} (WhatsApp ${code})`;
}

/** Codes that mean the stored token or the account setup needs a person: the send can't work until the channel is reconnected or fixed. */
const RECONNECT_CODES = new Set([0, 3, 10, 33, 190, 368, 131005, 131031, 131037, 131042, 131045, 133010]);
/** Refused before anything was accepted because of a rate limit: trying again later cannot send twice. */
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131056]);

export function isMetaReconnectError(httpStatus: number, code: number | null): boolean {
  return httpStatus === 401 || (code !== null && (RECONNECT_CODES.has(code) || (code >= 200 && code <= 299)));
}

function failureFor(httpStatus: number, code: number | null): Extract<TransportResult, { ok: false }> {
  if (code === 131047) return { ok: false, retryable: false, windowClosed: true, error: describeMetaError(code) };
  if (isMetaReconnectError(httpStatus, code)) return { ok: false, retryable: false, reconnectRequired: true, error: describeMetaError(code ?? 190) };
  if (httpStatus === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) return { ok: false, retryable: true, error: describeMetaError(code ?? 130429) };
  // A 5xx can mean Meta accepted the message before failing: report it as unconfirmed and never repeat it.
  if (httpStatus >= 500) return { ok: false, retryable: false, error: `WhatsApp returned ${httpStatus}. The message was not confirmed sent.` };
  return { ok: false, retryable: false, error: describeMetaError(code) };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type TemplateComponent = { type: "header" | "body"; parameters: Array<{ type: "text"; text: string; parameter_name?: string }> };

/** The approved template's variables as the last sync recorded them, so values go to the right component and, for named templates, name. */
async function approvedTemplateVariables(orgId: string, name: string, language: string): Promise<WhatsappTemplateVariable[] | null> {
  const { rows } = await withSystem((db) =>
    db.query<{ variables: unknown }>(
      "select variables from whatsapp_templates where org_id = $1 and provider = 'meta_whatsapp' and name = $2 and language = $3 and status = 'approved' order by checked_at desc nulls last limit 1",
      [orgId, name, language],
    ),
  );
  if (!rows[0]) return null;
  return arr(rows[0].variables).flatMap((v): WhatsappTemplateVariable[] => {
    const o = obj(v);
    if (!o || (o.component !== "header" && o.component !== "body")) return [];
    return [{ position: int(o.position) ?? 0, label: str(o.label) ?? "", component: o.component, ...(typeof o.name === "string" ? { name: o.name } : {}) }];
  });
}

/** Template values in Meta's component shape. Values are matched to variables by position, as the sync recorded them. */
export function templateComponents(variables: WhatsappTemplateVariable[], params: string[]): { components: TemplateComponent[] } | { error: string } {
  if (params.length !== variables.length) {
    return { error: `This template needs ${variables.length} value${variables.length === 1 ? "" : "s"}; ${params.length} ${params.length === 1 ? "was" : "were"} given.` };
  }
  const ordered = [...variables].sort((a, b) => a.position - b.position);
  const components: TemplateComponent[] = [];
  for (const kind of ["header", "body"] as const) {
    const parameters: TemplateComponent["parameters"] = [];
    ordered.forEach((v, i) => {
      if (v.component !== kind) return;
      parameters.push({ type: "text", ...(v.name ? { parameter_name: v.name } : {}), text: params[i] });
    });
    if (parameters.length) components.push({ type: kind, parameters });
  }
  for (const p of params) {
    if (!p.trim()) return { error: "A template value is empty. Every value the template needs must be filled in." };
    if ([...p].length > MAX_TEMPLATE_PARAM_CHARS) return { error: `A template value is longer than ${MAX_TEMPLATE_PARAM_CHARS} characters.` };
  }
  return { components };
}

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})?$/;

/**
 * Sends one WhatsApp message: free-form text when no template is given (the dispatcher's rule chain already decided the customer-service
 * window is open), otherwise the approved template with its values. At most once: the Cloud API has no idempotency key, so a timeout or a 5xx
 * is reported as "not confirmed sent" and never retried; only a rate-limit refusal is retryable. Our message id travels as
 * biz_opaque_callback_data, so a status webhook that arrives before this call returns still finds its message. Delivery is never assumed from
 * the response; it advances only from status webhooks.
 */
async function sendMetaWhatsapp(req: TransportSendRequest): Promise<TransportResult> {
  if (!env().META_WHATSAPP_WRITES_ENABLED) return { ok: false, retryable: false, blocked: true, error: "Sending through WhatsApp (Meta) is switched off for this environment." };
  if (req.channel !== "whatsapp") return { ok: false, retryable: false, blocked: true, error: "Meta's Cloud API is connected for WhatsApp only." };
  const phoneNumberId = req.sender.senderId;
  if (!phoneNumberId || !NUMERIC_ID.test(phoneNumberId) || !req.sender.credentialId) {
    return { ok: false, retryable: false, blocked: true, reconnectRequired: true, error: "WhatsApp isn't connected for this workspace. Connect a phone number ID and run its capability test." };
  }
  if (!UUID.test(req.messageId)) return { ok: false, retryable: false, error: "The message has no valid id to track delivery with." };
  const to = normalizePhone(req.to);
  if (!to || to !== req.to || !E164.test(to)) return { ok: false, retryable: false, error: "The destination is not an international (E.164) phone number." };

  let content: Record<string, unknown>;
  if (req.template) {
    const { name, language, params } = req.template;
    if (!TEMPLATE_NAME.test(name) || !LANGUAGE.test(language)) return { ok: false, retryable: false, error: "The WhatsApp template name or language is not valid." };
    const variables = await approvedTemplateVariables(req.orgId, name, language);
    if (!variables) return { ok: false, retryable: false, error: "That template isn't approved in this workspace's WhatsApp Business Account. Sync templates and try again." };
    const built = templateComponents(variables, params);
    if ("error" in built) return { ok: false, retryable: false, error: built.error };
    content = { type: "template", template: { name, language: { code: language }, ...(built.components.length ? { components: built.components } : {}) } };
  } else {
    if (!req.body.trim()) return { ok: false, retryable: false, error: "The message is empty." };
    if ([...req.body].length > META_MAX_TEXT_CHARS) return { ok: false, retryable: false, error: "The message is longer than WhatsApp's 4,096-character limit." };
    content = { type: "text", text: { body: req.body } };
  }

  const secret = await loadSecret(req.sender.credentialId, req.orgId);
  if (!secret) return { ok: false, retryable: false, blocked: true, reconnectRequired: true, error: "The stored WhatsApp credential is missing, revoked or unreadable. Reconnect WhatsApp." };

  const res = await metaGraph("POST", `${phoneNumberId}/messages`, secret.accessToken, {
    body: { messaging_product: "whatsapp", recipient_type: "individual", to, ...content, biz_opaque_callback_data: req.messageId },
    timeoutMs: 20000,
  });
  // A timeout can mean Meta did accept it. The dispatcher records an unconfirmed send as failed instead of repeating it.
  if (!res.reached) return { ok: false, retryable: false, error: "WhatsApp could not be reached. The message was not confirmed sent." };
  if (res.status !== 200) return failureFor(res.status, metaErrorCode(res.json));
  const wamid = str(obj(arr(res.json?.messages)[0])?.id);
  if (!wamid || !WAMID.test(wamid)) return { ok: false, retryable: false, error: "WhatsApp did not confirm the message." };
  return { ok: true, providerMessageId: wamid, providerConversationId: null };
}

export const metaWhatsappTransport: ChannelTransport = { name: "meta_whatsapp", channels: ["whatsapp"], requiresContactRef: false, send: sendMetaWhatsapp };

// ---------------------------------------------------------------------------
// Capability test
// ---------------------------------------------------------------------------

/** The public address to give Meta as the webhook callback URL. */
export function metaWhatsappWebhookUrl(): string {
  return `${env().APP_URL.replace(/\/+$/, "")}/api/webhooks/meta-whatsapp`;
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

/** The business number as E.164 from Meta's display format ("+1 631-555-5555", "15550783881"). */
function displayToE164(display: string | null): string | null {
  if (!display) return null;
  const digits = display.replace(/[^0-9]/g, "");
  const phone = digits ? normalizePhone(`+${digits}`) : null;
  return phone && E164.test(phone) ? phone : null;
}

export interface MetaCapabilityInput {
  secret: string;
  /** The Meta phone_number_id. Channel setup may pass it inside `sender` instead (the registry's CapabilityTestInput). */
  senderId?: string | null;
  /** The WhatsApp Business Account id. */
  accountId?: string | null;
  sender?: Partial<TransportSender> | null;
  channel?: string;
  orgId?: string;
}

/**
 * Proves, with the tenant's own token, that WhatsApp can work end to end: the token is valid, the phone number exists, is connected and
 * belongs to the WhatsApp Business Account, templates can be read (for the template sync), an app is subscribed to the account's webhooks,
 * and this deployment can verify Meta's signed webhooks at a public address. Read-only: it sends nothing. The result never contains a secret.
 */
export async function testMetaWhatsappCapability(input: MetaCapabilityInput): Promise<CapabilityTest> {
  const checkedAt = new Date().toISOString();
  const checks: CapabilityTest["checks"] = [];
  const done = (extra: Partial<CapabilityTest> = {}): CapabilityTest => ({ ok: checks.length > 0 && checks.every((c) => c.ok), checkedAt, checks, ...extra });

  if (input.channel && input.channel !== "whatsapp") {
    checks.push({ label: "Channel", ok: false, detail: "Meta's Cloud API carries WhatsApp only." });
    return done();
  }
  const secret = parseMetaWhatsappSecret(input.secret);
  if (!secret) {
    checks.push({ label: "Credential", ok: false, detail: "The credential must hold a System User access token from Meta Business Settings." });
    return done();
  }
  const phoneNumberId = (input.senderId ?? input.sender?.senderId ?? "").trim();
  const accountId = (input.accountId ?? input.sender?.accountId ?? "").trim();
  if (!NUMERIC_ID.test(phoneNumberId)) {
    checks.push({ label: "Phone number ID", ok: false, detail: "Enter the phone number ID from WhatsApp Manager (API Setup): digits only, not the phone number itself." });
    return done();
  }
  if (!NUMERIC_ID.test(accountId)) {
    checks.push({ label: "WhatsApp Business Account ID", ok: false, detail: "Enter the WhatsApp Business Account ID from WhatsApp Manager: digits only." });
    return done({ senderId: phoneNumberId });
  }
  const facts = { senderId: phoneNumberId, accountId };

  // 1. The token and the phone number.
  const number = await metaGraph("GET", phoneNumberId, secret.accessToken, { query: { fields: "id,display_phone_number,verified_name,quality_rating,name_status,status" } });
  if (!number.reached) {
    checks.push({ label: "Access token", ok: false, detail: "Meta could not be reached. Try again in a minute." });
    return done(facts);
  }
  const numberCode = metaErrorCode(number.json);
  if (number.status !== 200 && isMetaReconnectError(number.status, numberCode)) {
    checks.push({ label: "Access token", ok: false, detail: `Meta rejected the access token${numberCode !== null ? ` (WhatsApp ${numberCode})` : ""}. Create a System User token with whatsapp_business_messaging and whatsapp_business_management and paste it again.` });
    return done(facts);
  }
  if (number.status !== 200 || str(number.json?.id) !== phoneNumberId) {
    checks.push({ label: "Access token", ok: true, detail: "Meta accepted the access token." });
    checks.push({ label: "Phone number", ok: false, detail: `Meta has no phone number ${phoneNumberId} this token can use${number.status !== 200 ? ` (HTTP ${number.status})` : ""}. Check the phone number ID in WhatsApp Manager.` });
    return done(facts);
  }
  checks.push({ label: "Access token", ok: true, detail: "Meta accepted the access token." });
  const senderIdentity = displayToE164(str(number.json?.display_phone_number));
  const verifiedName = (str(number.json?.verified_name) ?? "").slice(0, 80);
  const status = (str(number.json?.status) ?? "").toUpperCase();
  const quality = (str(number.json?.quality_rating) ?? "").toUpperCase();
  const nameStatus = (str(number.json?.name_status) ?? "").toUpperCase();
  const connected = status === "CONNECTED";
  const about = [verifiedName ? `"${verifiedName}"` : null, nameStatus ? `display name ${nameStatus.toLowerCase().replace(/_/g, " ")}` : null, quality && quality !== "NA" ? `quality ${quality.toLowerCase()}` : null].filter(Boolean).join(", ");
  checks.push({
    label: "Phone number",
    ok: connected && Boolean(senderIdentity),
    detail: connected
      ? `${senderIdentity ?? "The number"} is connected${about ? ` (${about})` : ""}.`
      : status
        ? `The number's status is ${status.toLowerCase().replace(/_/g, " ")}. It must be connected to send and receive messages.`
        : "Meta didn't report whether the number is connected.",
  });
  const registrationStatus: CapabilityTest["registrationStatus"] = connected ? "approved" : "pending";

  // 2. The number belongs to the account (templates and webhooks live on the account).
  let belongs = false;
  let listed = false;
  let after: string | null = null;
  for (let page = 0; page < 5 && !belongs; page++) {
    const list = await metaGraph("GET", `${accountId}/phone_numbers`, secret.accessToken, { query: { fields: "id", limit: "100", ...(after ? { after } : {}) } });
    if (!list.reached || list.status !== 200) break;
    listed = true;
    belongs = arr(list.json?.data).some((n) => str(obj(n)?.id) === phoneNumberId);
    const paging = obj(list.json?.paging);
    after = str(obj(paging?.cursors)?.after);
    if (!after || !paging?.next) break;
  }
  checks.push({
    label: "WhatsApp Business Account",
    ok: belongs,
    detail: belongs ? `The number belongs to WhatsApp Business Account ${accountId}.` : listed ? `Phone number ${phoneNumberId} isn't in WhatsApp Business Account ${accountId}.` : `Meta wouldn't list WhatsApp Business Account ${accountId}'s phone numbers with this token.`,
  });
  if (!belongs) return done({ ...facts, senderIdentity, registrationStatus });

  // 3. Templates can be read (the template sync and the 24-hour rule depend on them).
  const templates = await metaGraph("GET", `${accountId}/message_templates`, secret.accessToken, { query: { fields: "id,status", limit: "1" } });
  const templatesOk = templates.reached && templates.status === 200 && Array.isArray(templates.json?.data);
  checks.push({
    label: "Message templates",
    ok: templatesOk,
    detail: templatesOk ? "iAcquire can read this account's message templates." : "Meta refused to list this account's message templates. The token needs the whatsapp_business_management permission.",
  });

  // 4. Some app receives this account's webhooks. Meta reports the subscribed apps, not which callback URL each uses.
  const subscribed = await metaGraph("GET", `${accountId}/subscribed_apps`, secret.accessToken);
  const apps = subscribed.reached && subscribed.status === 200 ? arr(subscribed.json?.data).map((a) => (str(obj(obj(a)?.whatsapp_business_api_data)?.name) ?? "").slice(0, 60)) : null;
  checks.push({
    label: "Webhook subscription",
    ok: Boolean(apps && apps.length),
    detail: !apps
      ? "Meta wouldn't list the apps subscribed to this account's webhooks."
      : apps.length
        ? `Webhooks for this account go to: ${apps.map((n) => n || "an unnamed app").join(", ")}. The iAcquire app must be one of them for replies to arrive.`
        : "No app is subscribed to this account's webhooks, so customer replies would never arrive. Subscribe the iAcquire app to the WhatsApp Business Account.",
  });

  // 5. This deployment can authenticate Meta's webhooks at a public address.
  const e = env();
  const hookUrl = metaWhatsappWebhookUrl();
  const configured = Boolean(e.META_APP_SECRET && e.META_WEBHOOK_VERIFY_TOKEN);
  checks.push({
    label: "Webhook address",
    ok: configured && isPublicHttps(hookUrl),
    detail: !configured
      ? "META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN must both be set, or Meta's signed webhooks can't be verified."
      : isPublicHttps(hookUrl)
        ? `Meta's callback URL for the iAcquire app is ${hookUrl}.`
        : `${hookUrl} isn't a public https address Meta can reach. Set APP_URL to the portal's public address.`,
  });
  return done({ ...facts, senderIdentity, registrationStatus });
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

/** Meta's X-Hub-Signature-256 value for a raw body: "sha256=" + hex HMAC-SHA256 keyed with the app secret. */
export function metaSignature(appSecret: string, rawBody: string): string {
  return `sha256=${crypto.createHmac("sha256", appSecret).update(Buffer.from(rawBody, "utf8")).digest("hex")}`;
}

/** Constant-time check of X-Hub-Signature-256 over the exact raw body. */
export function verifyMetaSignature(appSecret: string, rawBody: string, header: string | null): boolean {
  if (!header) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(Buffer.from(rawBody, "utf8")).digest();
  const given = Buffer.from(m[1], "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const sameSecret = (a: string, b: string) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
const CHALLENGE = /^[\x21-\x7e]{1,256}$/;

/**
 * Meta's subscription handshake: GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…. Answer 200 with the challenge only when the
 * token matches META_WEBHOOK_VERIFY_TOKEN (compared in constant time); anything else is refused, so Meta treats the endpoint as unverified.
 */
export function handleMetaWebhookVerify(searchParams: URLSearchParams): { status: number; body: string } {
  const token = env().META_WEBHOOK_VERIFY_TOKEN;
  const mode = searchParams.get("hub.mode");
  const given = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (!token || mode !== "subscribe" || !given || !challenge || !CHALLENGE.test(challenge) || !sameSecret(given, token)) return { status: 403, body: "Forbidden" };
  return { status: 200, body: challenge };
}

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------

type HeaderSource = Headers | Record<string, string | string[] | undefined>;
function header(headers: HeaderSource, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const v = key ? headers[key] : undefined;
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export interface MetaWebhookEvent {
  kind: "inbound" | "status" | "template" | "other";
  outcome: "processed" | "duplicate" | "ignored" | "failed";
  detail?: string;
  orgId?: string;
  conversationId?: string;
}

export interface MetaWebhookResult {
  status: number;
  body: string;
  events: MetaWebhookEvent[];
  /** AI-owned conversations that got an inbound message: prepare a reply after the response is sent. */
  respond: Array<{ orgId: string; conversationId: string }>;
  /** Workspaces whose WhatsApp templates changed in Meta: re-sync them after the response is sent. */
  templateSync: string[];
}

interface MetaTenant {
  orgId: string;
  accountId: string | null;
}

const DELIVERY: Record<string, "sent" | "delivered" | "read" | "failed"> = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/** Seconds since the epoch, as Meta sends them; anything implausible becomes "now". */
function eventTime(v: unknown, now: Date): Date {
  const s = int(v);
  if (s === null || s <= 0) return now;
  const t = new Date(s * 1000);
  // Meta retries for up to 7 days; a time in the future (clock skew beyond five minutes) is not trusted.
  return t.getTime() > now.getTime() + 5 * 60_000 || t.getTime() < now.getTime() - 30 * 86_400_000 ? now : t;
}

const MEDIA_LABEL: Record<string, string> = { image: "Photo", video: "Video", audio: "Audio", document: "Document", sticker: "Sticker" };
const MEDIA_NOTE = "Media isn't downloaded or shown in the inbox yet.";

/**
 * What an inbound WhatsApp message becomes in the inbox. Text and replies to buttons and lists become their text. Media is recorded as a
 * note (with the caption) without downloading anything: fetching it needs the tenant's token and storage, which is a separate decision.
 * Reactions, system notices and other non-messages return null and are not recorded.
 */
export function inboundText(m: Record<string, unknown>): string | null {
  const type = clean(m.type, 40);
  const part = obj(m[type]);
  switch (type) {
    case "text":
      return clean(part?.body, META_MAX_TEXT_CHARS) || "[Empty message]";
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const caption = clean(part?.caption, 1024);
      const filename = type === "document" ? clean(part?.filename, 120) : "";
      const label = type === "audio" && part?.voice === true ? "Voice message" : MEDIA_LABEL[type];
      const note = `[${label}${filename ? ` "${filename}"` : ""} received. ${MEDIA_NOTE}]`;
      return caption ? `${caption}\n\n${note}` : note;
    }
    case "button":
      return clean(part?.text, 256) || clean(part?.payload, 256) || "[Button tapped]";
    case "interactive": {
      const reply = obj(part?.button_reply) ?? obj(part?.list_reply);
      const title = clean(reply?.title, 256);
      const description = clean(reply?.description, 256);
      if (title) return description ? `${title}\n${description}` : title;
      return "[The customer answered an interactive message. That answer can't be shown in the inbox yet.]";
    }
    case "location": {
      const name = clean(part?.name, 200);
      const address = clean(part?.address, 300);
      const lat = typeof part?.latitude === "number" ? part.latitude : null;
      const lng = typeof part?.longitude === "number" ? part.longitude : null;
      const where = [name, address].filter(Boolean).join(", ");
      return `[Location shared${where ? `: ${where}` : ""}${lat !== null && lng !== null ? ` (${lat.toFixed(5)}, ${lng.toFixed(5)})` : ""}]`;
    }
    case "contacts": {
      const names = arr(m.contacts).map((c) => clean(obj(obj(c)?.name)?.formatted_name, 80)).filter(Boolean);
      return `[Contact card shared${names.length ? `: ${names.slice(0, 5).join(", ")}` : ""}]`;
    }
    case "order":
      return "[The customer sent an order from the catalog. Orders aren't shown in the inbox yet.]";
    case "unsupported":
      return "[The customer sent a kind of message WhatsApp's API doesn't support, so it can't be shown.]";
    case "reaction":
    case "system":
    case "request_welcome":
    case "ephemeral":
    case "errors":
      return null;
    default:
      return type ? `[A WhatsApp "${type.replace(/[^a-z_]/gi, "")}" message was received. It can't be shown in the inbox yet.]` : null;
  }
}

/** Finds the workspace that owns a business phone number, only from our own channel records. */
async function locateTenant(phoneNumberId: string): Promise<MetaTenant | null> {
  if (!NUMERIC_ID.test(phoneNumberId)) return null;
  const ch = await withSystem((db) => resolveChannelByProviderSender(db, "meta_whatsapp", phoneNumberId));
  if (!ch || ch.channel !== "whatsapp") return null;
  return { orgId: ch.orgId, accountId: ch.accountId ?? null };
}

async function withReceipt<T extends MetaWebhookEvent>(db: Queryable, externalId: string, kind: string, orgId: string | null, work: () => Promise<T>): Promise<T | MetaWebhookEvent> {
  const receipt = await db.query("insert into webhook_receipts (provider, external_id, kind, org_id) values ('meta_whatsapp', $1, $2, $3) on conflict do nothing returning external_id", [externalId.slice(0, 200), kind, orgId]);
  if (!receipt.rows[0]) return { kind: "other", outcome: "duplicate", ...(orgId ? { orgId } : {}) };
  const result = await work();
  await db.query("update webhook_receipts set outcome = $2, detail = $3 where provider = 'meta_whatsapp' and external_id = $1", [externalId.slice(0, 200), result.outcome === "processed" ? "processed" : "ignored", result.detail?.slice(0, 300) ?? null]);
  return result;
}

/** One delivery update. Matched by our message id first (biz_opaque_callback_data), else by the wamid; delivery only moves forward. */
async function handleStatus(db: Queryable, tenant: MetaTenant, s: Record<string, unknown>, now: Date): Promise<MetaWebhookEvent> {
  const wamid = str(s.id);
  const rawStatus = clean(s.status, 40).toLowerCase();
  const base = { kind: "status" as const, orgId: tenant.orgId };
  if (!wamid || !WAMID.test(wamid)) return { ...base, outcome: "ignored", detail: "No message id." };
  if (!/^[a-z_]+$/.test(rawStatus)) return { ...base, outcome: "ignored", detail: "No status." };
  const done = await withReceipt(db, `status:${wamid}:${rawStatus}`, "whatsapp.status", tenant.orgId, async (): Promise<MetaWebhookEvent> => {
    const status = DELIVERY[rawStatus];
    // "played" (a voice message was played) and anything newer is not a delivery state.
    if (!status) return { ...base, outcome: "ignored", detail: `Status "${rawStatus}" is not a delivery update.` };
    const errorCode = int(obj(arr(s.errors)[0])?.code);
    const pricing = obj(s.pricing);
    const category = clean(pricing?.category, 40);
    const priceType = clean(pricing?.type, 40);
    const detail = status === "failed"
      ? describeMetaError(errorCode)
      : category && /^[a-z_-]+$/.test(category)
        ? `Meta pricing category: ${category}${priceType && /^[a-z_]+$/.test(priceType) ? ` (${priceType})` : ""}.`
        : undefined;
    const event = { provider: "meta_whatsapp", providerEventId: `${wamid}:${rawStatus}`, providerMessageId: wamid, status, rawStatus, occurredAt: eventTime(s.timestamp, now), detail };

    // Our id comes back as biz_opaque_callback_data. It is used only for a message of this workspace that has no other wamid yet.
    const opaque = str(s.biz_opaque_callback_data);
    let messageId: string | null = null;
    if (opaque && UUID.test(opaque)) {
      const own = await db.query<{ id: string }>(
        `select m.id from conversation_messages m join conversations c on c.id = m.conversation_id
         where m.id = $1 and m.org_id = $2 and m.direction = 'outbound' and c.channel = 'whatsapp' and (m.provider_message_id is null or m.provider_message_id = $3)`,
        [opaque.toLowerCase(), tenant.orgId, wamid],
      );
      messageId = own.rows[0]?.id ?? null;
    }
    let applied: { result: string };
    if (messageId) {
      applied = await applyDeliveryEventForMessage(db, { ...event, messageId });
    } else {
      const owner = await db.query<{ org_id: string }>("select org_id from conversation_messages where provider = 'meta_whatsapp' and provider_message_id = $1", [wamid]);
      if (owner.rows[0] && owner.rows[0].org_id !== tenant.orgId) return { ...base, outcome: "ignored", detail: "The message belongs to another workspace." };
      applied = await applyDeliveryEvent(db, event);
    }

    // 131050: the person stopped marketing messages from this business. Service messages may still go; marketing consent is withdrawn.
    if (errorCode === 131050) {
      const contact = await db.query<{ contact_id: string }>(
        "select c.contact_id from conversation_messages m join conversations c on c.id = m.conversation_id where m.org_id = $1 and (m.id = $2 or (m.provider = 'meta_whatsapp' and m.provider_message_id = $3)) limit 1",
        [tenant.orgId, messageId, wamid],
      );
      if (contact.rows[0]) {
        await recordConsent(db, { orgId: tenant.orgId, contactId: contact.rows[0].contact_id, channel: "whatsapp", purpose: "marketing", status: "revoked", source: "provider_opt_out", evidence: "WhatsApp reported that the recipient stopped marketing messages from this business (131050)." });
      }
    }
    return { ...base, outcome: applied.result === "applied" ? "processed" : "ignored", detail: applied.result };
  });
  return { ...done, kind: "status" };
}

/** One inbound customer message, recorded through the provider-neutral ingest (consent, STOP/START, follow-ups, escalation). */
async function handleInbound(db: Queryable, tenant: MetaTenant, m: Record<string, unknown>, names: Map<string, string>, now: Date, emails: OutgoingEmail[]): Promise<MetaWebhookEvent & { aiShouldRespond?: boolean }> {
  const wamid = str(m.id);
  const base = { kind: "inbound" as const, orgId: tenant.orgId };
  if (!wamid || !WAMID.test(wamid)) return { ...base, outcome: "ignored", detail: "No message id." };
  const done = await withReceipt(db, `inbound:${wamid}`, "whatsapp.inbound", tenant.orgId, async (): Promise<MetaWebhookEvent & { aiShouldRespond?: boolean }> => {
    const body = inboundText(m);
    if (body === null) return { ...base, outcome: "ignored", detail: `A "${clean(m.type, 30)}" event is not recorded as a message.` };
    const from = str(m.from);
    // A customer who uses a WhatsApp username may arrive with only a business-scoped user id (from_user_id): there's no number to answer.
    const address = from && /^\+?[0-9]{7,15}$/.test(from) ? normalizePhone(from.startsWith("+") ? from : `+${from}`) : null;
    if (!address || !E164.test(address)) return { ...base, outcome: "ignored", detail: "The customer shared no phone number (WhatsApp username only), which this inbox can't answer yet." };
    const r = await ingestInbound(db, {
      orgId: tenant.orgId,
      provider: "meta_whatsapp",
      channel: "whatsapp",
      address,
      name: names.get(from!.replace(/^\+/, "")) || undefined,
      body,
      providerMessageId: wamid,
      receivedAt: eventTime(m.timestamp, now),
    });
    emails.push(...r.emails);
    return { ...base, outcome: r.status === "duplicate" ? "duplicate" : "processed", conversationId: r.conversationId, aiShouldRespond: r.status === "created" && r.aiShouldRespond };
  });
  return { ...done, kind: "inbound" };
}

/**
 * Handles one signed POST from Meta. The signature over the exact raw body is checked first (constant time) and nothing is read or written
 * before it passes. Meta batches events: every status and message is handled on its own, in its own transaction, behind its own replay
 * receipt (wamid:status, inbound wamid), so one bad event never loses the others and a retried batch only processes what is new. The
 * workspace comes only from our own records (metadata.phone_number_id → messaging_channels); an unknown number is acknowledged and ignored.
 * If any event fails unexpectedly the answer is 500, so Meta retries the batch; the events already recorded are skipped as duplicates.
 */
export async function handleMetaWebhook(rawBody: string, headers: HeaderSource, opts: { now?: Date } = {}): Promise<MetaWebhookResult> {
  const now = opts.now ?? new Date();
  const result: MetaWebhookResult = { status: 200, body: "OK", events: [], respond: [], templateSync: [] };
  const appSecret = env().META_APP_SECRET;
  // Without the app secret nothing can be authenticated. 503 makes Meta retry, so events arrive once the secret is configured.
  if (!appSecret) return { ...result, status: 503, body: "Not configured" };
  if (!verifyMetaSignature(appSecret, rawBody, header(headers, "x-hub-signature-256"))) return { ...result, status: 401, body: "Invalid signature" };

  let payload: Record<string, unknown> | null;
  try {
    payload = obj(JSON.parse(rawBody));
  } catch {
    payload = null;
  }
  if (!payload) return { ...result, status: 400, body: "Bad request" };
  if (payload.object !== "whatsapp_business_account") {
    result.events.push({ kind: "other", outcome: "ignored", detail: "Not a WhatsApp Business Account event." });
    return result;
  }

  const tenants = new Map<string, Promise<MetaTenant | null>>();
  const tenantFor = (id: string) => {
    let p = tenants.get(id);
    if (!p) {
      p = locateTenant(id);
      tenants.set(id, p);
    }
    return p;
  };
  const emails: OutgoingEmail[] = [];
  const templateOrgs = new Set<string>();
  let failed = false;
  let budget = MAX_EVENTS_PER_REQUEST;
  const run = async (kind: MetaWebhookEvent["kind"], work: () => Promise<MetaWebhookEvent & { aiShouldRespond?: boolean }>) => {
    if (budget-- <= 0) {
      // Meta documents at most 1,000 updates per request. Anything beyond the cap is left for Meta's retry rather than dropped silently.
      failed = true;
      return;
    }
    try {
      const e = await work();
      const { aiShouldRespond, ...event } = e;
      result.events.push(event);
      if (aiShouldRespond && e.orgId && e.conversationId && !result.respond.some((r) => r.conversationId === e.conversationId)) result.respond.push({ orgId: e.orgId, conversationId: e.conversationId });
    } catch (err) {
      failed = true;
      // Nothing about the payload or the tenant is logged: only which kind of event failed and the error class.
      console.error("[iacquire] whatsapp webhook event failed", { kind, type: err instanceof Error ? err.name : "unknown" });
      result.events.push({ kind, outcome: "failed" });
    }
  };

  for (const entry of arr(payload.entry)) {
    const e = obj(entry);
    if (!e) continue;
    const accountId = str(e.id);
    for (const change of arr(e.changes)) {
      const c = obj(change);
      const value = obj(c?.value);
      if (!c || !value) continue;
      if (c.field === "message_template_status_update") {
        await run("template", async () => {
          const { applyTemplateStatusEvent } = await import("@/server/messaging/whatsapp-templates");
          const r = await withSystem((db) => applyTemplateStatusEvent(db, { accountId, value, entryTime: int(e.time) }));
          for (const orgId of r.orgIds) templateOrgs.add(orgId);
          return { kind: "template", outcome: r.outcome, detail: r.detail };
        });
        continue;
      }
      if (c.field !== "messages") {
        result.events.push({ kind: "other", outcome: "ignored", detail: `Field "${clean(c.field, 60)}" is not used.` });
        continue;
      }
      const phoneNumberId = str(obj(value.metadata)?.phone_number_id) ?? "";
      const statuses = arr(value.statuses).map(obj).filter((x): x is Record<string, unknown> => Boolean(x));
      const messages = arr(value.messages).map(obj).filter((x): x is Record<string, unknown> => Boolean(x));
      if (!statuses.length && !messages.length) {
        // Account-level errors (value.errors) and other notices carry no message to record.
        result.events.push({ kind: "other", outcome: "ignored", detail: arr(value.errors).length ? "Account-level error notice." : "No messages or statuses." });
        continue;
      }
      let tenant: MetaTenant | null;
      try {
        tenant = await tenantFor(phoneNumberId);
      } catch (err) {
        failed = true;
        console.error("[iacquire] whatsapp webhook tenant lookup failed", { type: err instanceof Error ? err.name : "unknown" });
        continue;
      }
      // An unknown number, or one recorded under a different WhatsApp Business Account, is not ours: acknowledged and ignored.
      if (!tenant || (tenant.accountId && accountId && tenant.accountId !== accountId)) {
        for (let i = 0; i < statuses.length + messages.length; i++) result.events.push({ kind: "other", outcome: "ignored", detail: "The phone number isn't connected to a workspace." });
        continue;
      }
      const t = tenant;
      for (const s of statuses) await run("status", () => withSystem((db) => handleStatus(db, t, s, now)));
      const names = new Map<string, string>();
      for (const ct of arr(value.contacts)) {
        const o = obj(ct);
        const waId = str(o?.wa_id);
        const name = clean(obj(o?.profile)?.name, 200);
        if (waId && name) names.set(waId.replace(/^\+/, ""), name);
      }
      for (const msg of messages) {
        await run("inbound", async () => {
          // Escalation emails go out only for a message whose transaction committed.
          const own: OutgoingEmail[] = [];
          const event = await withSystem((db) => handleInbound(db, t, msg, names, now, own));
          emails.push(...own);
          return event;
        });
      }
    }
  }
  result.templateSync = [...templateOrgs];
  await Promise.all(emails.map((mail) => sendEmail(mail).catch(() => console.error("[iacquire] escalation email after whatsapp webhook failed"))));
  if (failed) return { ...result, status: 500, body: "Error" };
  return result;
}
