import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { sendEmail, type OutgoingEmail } from "@/server/email";
import { notifyAgency } from "@/server/notifications";
import { resolveCredential } from "@/server/security/credentials";
import { ingestInbound } from "@/server/messaging/ingest";
import { applyDeliveryEvent, applyDeliveryEventForMessage, type DeliveryEventInput, type DeliveryResult } from "@/server/messaging/send";
import { normalizeEmail } from "@/lib/messaging";
import type { CapabilityTest, ChannelTransport, TransportResult, TransportSendRequest } from "@/server/messaging/transports/types";

// Email through Resend (https://resend.com), one of the native transports next to GoHighLevel.
//
// Contract sources, read 2026-10-16 (details and what is not verified: docs/messaging-providers.md, "Resend"):
//   * Resend's OpenAPI document, github.com/resend/resend-openapi resend.json v1.5.1: POST /emails (SendEmailRequest: from, to, subject,
//     text, html, reply_to, headers, tags; Idempotency-Key header, max 256; SendEmailResponse { id }), GET /domains (limit/after paging) and
//     GET /domains/{domain_id} (Domain: status, capabilities, records), GET /emails/receiving/{email_id} (GetReceivedEmailResponse), and the
//     webhook event schemas (OutboundEmailEventData.tags is an object of name → value; WebhookEventBounce.type Permanent/Transient/
//     Undetermined; WebhookEventSuppressed.reason previous_bounce/previous_complaint; EmailReceivedEventData), GET /webhooks
//     (ListWebhooksResponse: id, endpoint, events, status; limit/after paging) and GET /webhooks/{webhook_id} (GetWebhookResponse.signing_secret;
//     CreateWebhookRequest has no secret field, so Resend generates every webhook's secret).
//   * resend.com/docs/api-reference/emails/retrieve-received-email (read 2026-10-16; not yet in the OpenAPI document): `authentication`
//     { spf, dkim, dmarc }, each pass | fail | gray | processing_failed | unknown, computed by Resend's receiving server, not taken from headers.
//   * resend.com/docs: the error list (names and statuses), idempotency keys (24 hours, same payload, 409s), custom headers, one-click
//     unsubscribe (List-Unsubscribe + List-Unsubscribe-Post), receiving (webhooks carry metadata only; content is read with the API),
//     replying in a thread (In-Reply-To, "Re:" subject), webhook verification and the retry schedule.
//   * Svix's manual verification guide and the standard-webhooks verifier Svix's library wraps: HMAC-SHA256 over "id.timestamp.body" with
//     the base64 secret after "whsec_", "v1,<base64>" signatures separated by spaces, 5 minute tolerance either way.
// Nothing here has been exercised against a live Resend account. Sending is off unless RESEND_WRITES_ENABLED=true.

const RESEND_API = "https://api.resend.com";
// Resend's API refuses requests without a User-Agent (403, error 1010; API reference introduction).
const USER_AGENT = "iAcquire-Portal/1.0 (+messaging)";
const SEND_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 10_000;
/** Waits before asking Resend again about an unclear send, with the same idempotency key (see sendWithConfirmation). */
const CONFIRM_DELAYS_MS = [1_000, 3_000] as const;
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const UUIDISH = /^[0-9a-fA-F-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_ID = /^<[^<>\s@]{1,400}@[^<>\s]{1,400}>$/;

const writesEnabled = () => env().RESEND_WRITES_ENABLED;
const webhookSecret = () => env().RESEND_WEBHOOK_SECRET ?? null;

// ---------------------------------------------------------------------------
// Addresses and content
// ---------------------------------------------------------------------------

export interface SenderIdentity {
  name: string | null;
  address: string;
  domain: string;
}

/** Reads "Name <hello@example.com>" or a bare address. Anything that could break a header line is refused rather than cleaned. */
export function parseSenderIdentity(identity: string | null | undefined): SenderIdentity | null {
  if (!identity || /[\r\n\0]/.test(identity) || identity.length > 320) return null;
  const s = identity.trim();
  const angled = /^(.*?)\s*<([^<>]+)>$/.exec(s);
  const address = normalizeEmail(angled ? angled[2] : s);
  if (!address) return null;
  const name = angled ? angled[1].trim().replace(/^"(.*)"$/, "$1").replace(/["\\<>]/g, "").trim() : "";
  return { name: name ? name.slice(0, 100) : null, address, domain: address.slice(address.lastIndexOf("@") + 1) };
}

/** RFC 5322 display name: quoted when it holds anything beyond plain words. */
export function formatFrom(sender: SenderIdentity): string {
  if (!sender.name) return sender.address;
  const display = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(sender.name) ? sender.name : `"${sender.name}"`;
  return `${display} <${sender.address}>`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/g;

/** Escapes one line and turns http(s) links into anchors. Only http and https are ever linked; everything else stays text. */
function lineToHtml(line: string): string {
  let out = "";
  let last = 0;
  for (const match of line.matchAll(URL_IN_TEXT)) {
    let url = match[0];
    // Trailing punctuation belongs to the sentence, not the link ("see https://x.test/a."), unless it closes a bracket the link opened.
    while (/[.,;:!?)\]}]$/.test(url) && !(url.endsWith(")") && url.split("(").length > url.split(")").length - 1)) url = url.slice(0, -1);
    const start = match.index ?? 0;
    let safe: string | null = null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") safe = parsed.toString();
    } catch {
      safe = null;
    }
    out += escapeHtml(line.slice(last, start));
    out += safe ? `<a href="${escapeHtml(safe)}" style="color:#2754c5;text-decoration:underline">${escapeHtml(url)}</a>` : escapeHtml(url);
    last = start + url.length;
  }
  return out + escapeHtml(line.slice(last));
}

/**
 * The HTML part of a message, derived from its text: escaped, paragraphs and line breaks kept, links clickable. No images, no remote
 * styles or fonts, nothing loaded from anywhere, so the HTML says exactly what the text says.
 */
export function textToSafeHtml(text: string, opts: { title?: string | null; unsubscribeUrl?: string | null } = {}): string {
  const paragraphs = text.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/).filter((p) => p.trim());
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px">${p.split("\n").map(lineToHtml).join("<br>")}</p>`).join("");
  const footer = opts.unsubscribeUrl
    ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px"><p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280">Don't want these emails? <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a></p>`
    : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><title>${escapeHtml(opts.title ?? "")}</title></head>` +
    `<body style="margin:0;padding:24px 16px;background:#ffffff"><div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2328">` +
    `${body}${footer}</div></body></html>`
  );
}

/** One header line: no line breaks, no control characters, collapsed whitespace. */
const headerText = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** A Message-ID as a header expects it ("<id@host>"); a bare "id@host" gets its angle brackets. Anything else is refused. */
export function normalizeMessageId(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  const wrapped = s.startsWith("<") ? s : `<${s}>`;
  return MESSAGE_ID.test(wrapped) ? wrapped : null;
}

/** References for a reply: the earlier Message-IDs, oldest first, ending with the one being answered, kept within one header line. */
export function threadReferences(inReplyTo: string | null, references: string[] = []): string[] {
  const ids = [...references, ...(inReplyTo ? [inReplyTo] : [])].map(normalizeMessageId).filter((r): r is string => Boolean(r));
  const unique = ids.filter((r, i) => ids.indexOf(r) === i);
  // RFC 5322 keeps the first (thread root) and the most recent ones when a list has to be shortened.
  while (unique.length > 2 && unique.join(" ").length > 900) unique.splice(1, 1);
  return unique.join(" ").length > 900 ? unique.slice(-1) : unique;
}

export interface ResendSendPayload {
  idempotencyKey: string;
  body: {
    from: string;
    to: string[];
    subject: string;
    text: string;
    html: string;
    reply_to?: string;
    headers?: Record<string, string>;
    tags: Array<{ name: string; value: string }>;
  };
}

const safeUnsubscribeUrl = (u: string | null | undefined) => (u && /^https?:\/\/[^\s<>"]+$/.test(u) && u.length <= 2000 ? u : null);

/**
 * The request body for POST /emails, built only from the request. The same message always gives the same body, which matters because
 * Resend refuses a reused idempotency key with a different payload (409 invalid_idempotent_request): whoever builds the unsubscribe URL
 * must build the same one for every attempt (buildUnsubscribeUrl with the message's creation time).
 */
export function resendSendPayload(req: TransportSendRequest, sender: SenderIdentity, opts: { replyTo?: string | null } = {}): ResendSendPayload {
  const inReplyTo = normalizeMessageId(req.inReplyTo);
  let subject = headerText(req.subject ?? "", 200);
  if (!subject) subject = inReplyTo ? "Re: your message" : `A message from ${headerText(sender.name ?? sender.domain, 100)}`;
  // Mail apps group a reply with its thread when the subject starts with "Re:" (Resend's threading guide).
  if (inReplyTo && !/^re:/i.test(subject)) subject = headerText(`Re: ${subject}`, 200);

  const unsubscribe = safeUnsubscribeUrl(req.unsubscribeUrl);
  const body = req.body.replace(/\r\n?/g, "\n").trim();
  const text = unsubscribe && !body.includes(unsubscribe) ? `${body}\n\n---\nDon't want these emails? Unsubscribe: ${unsubscribe}` : body;

  const headers: Record<string, string> = {};
  if (inReplyTo) {
    headers["In-Reply-To"] = inReplyTo;
    const refs = threadReferences(inReplyTo, req.references ?? []);
    if (refs.length) headers.References = refs.join(" ");
  }
  if (unsubscribe) {
    headers["List-Unsubscribe"] = `<${unsubscribe}>`;
    // RFC 8058: the one-click signal is only valid with an HTTPS URI (local development links are plain HTTP).
    if (unsubscribe.startsWith("https://")) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const replyTo = opts.replyTo ? normalizeEmail(opts.replyTo) : null;
  return {
    idempotencyKey: `msg:${req.messageId}`,
    body: {
      from: formatFrom(sender),
      to: [req.to],
      subject,
      text,
      html: textToSafeHtml(body, { title: subject, unsubscribeUrl: unsubscribe }),
      ...(replyTo && replyTo !== sender.address ? { reply_to: replyTo } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      // Our message id travels with the email, so a status webhook is matched even if it arrives before the send call returns.
      tags: [{ name: "mid", value: req.messageId }],
    },
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type Failure = Extract<TransportResult, { ok: false }>;
const safeCode = (name: unknown) => (typeof name === "string" && /^[a-z_]{1,60}$/.test(name) ? name : null);
const errorName = (body: unknown) => safeCode(body && typeof body === "object" ? (body as { name?: unknown }).name : null);
const errorMessage = (body: unknown) => {
  const m = body && typeof body === "object" ? (body as { message?: unknown }).message : null;
  return typeof m === "string" ? m.slice(0, 300) : "";
};

/** What one POST /emails answer means for the message. */
export type ResendAnswer =
  | { kind: "accepted"; id: string }
  /** Resend definitely did not take the message, and asking again later can work (rate limit, connection refused, service unavailable). */
  | { kind: "not_accepted"; failure: Failure }
  /** Resend may or may not have taken it (timeout, 500, a concurrent request with the same key still running). */
  | { kind: "unclear"; detail: string }
  /** A final answer: the message is refused and repeating it won't help. */
  | { kind: "refused"; failure: Failure };

/**
 * Maps one Resend error response (status plus the { name, message } body from Resend's error list) to what it means. Messages shown to
 * people are written here; Resend's own wording is only used to tell apart two errors that share a name, and is never passed on.
 */
export function classifyResendError(status: number, body: unknown): Exclude<ResendAnswer, { kind: "accepted" }> {
  const name = errorName(body);
  const code = name ? ` (${name})` : "";
  const refused = (error: string, extra: Partial<Failure> = {}) => ({ kind: "refused" as const, failure: { ok: false as const, retryable: false, error, ...extra } });
  if (status === 400 && name === "validation_error" && /api key/i.test(errorMessage(body))) {
    return refused("Resend rejected the API key. Reconnect Resend for this workspace.", { reconnectRequired: true });
  }
  if (status === 401) return refused(`Resend rejected the API key${code}. Reconnect Resend for this workspace.`, { reconnectRequired: true });
  if (status === 403) {
    if (name === "validation_error") {
      return refused("Resend refused the sender: the domain isn't verified in this Resend account, or the key can't send from it. Run the channel test again.", { reconnectRequired: true });
    }
    if (name === "suspended_api_key") return refused("Resend says this workspace's API key is suspended. Reconnect Resend with an active key.", { reconnectRequired: true });
    return refused(`Resend refused this API key's access${code}. Reconnect Resend with an active, full-access key.`, { reconnectRequired: true });
  }
  if (status === 409) {
    if (name === "concurrent_idempotent_requests" || name === "resource_locked") return { kind: "unclear", detail: "Resend is still processing an earlier attempt of this message." };
    return refused(`Resend already received a different email under this message's idempotency key${code}. It was not sent again.`);
  }
  if (status === 429) {
    if (name === "daily_quota_exceeded") return refused("Resend's daily sending quota for this account is used up. The message was not sent.");
    if (name === "monthly_quota_exceeded") return refused("Resend's monthly sending quota for this account is used up. The message was not sent.");
    return { kind: "not_accepted", failure: { ok: false, retryable: true, error: "Resend's rate limit was reached. The message was not accepted and will be tried again." } };
  }
  if (status === 503) return { kind: "not_accepted", failure: { ok: false, retryable: true, error: "Resend's API was temporarily unavailable. The message was not accepted and will be tried again." } };
  if (status >= 500) return { kind: "unclear", detail: `Resend answered ${status}.` };
  return refused(`Resend refused the message as invalid (${status}${name ? `, ${name}` : ""}).`);
}

/** Errors that prove the connection never reached Resend, so nothing can have been accepted. */
const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const neverConnected = (err: unknown) => {
  const cause = err && typeof err === "object" ? (err as { cause?: { code?: unknown } }).cause : null;
  return typeof cause?.code === "string" && NOT_CONNECTED.has(cause.code);
};

/** A stored Resend credential: the API key itself, or {"apiKey": "..."}. */
export function parseResendSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  let key = secret.trim();
  if (key.startsWith("{")) {
    try {
      const parsed = JSON.parse(key) as { apiKey?: unknown };
      key = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    } catch {
      return null;
    }
  }
  return /^re_[A-Za-z0-9_-]{8,200}$/.test(key) ? key : null;
}

const authHeaders = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": USER_AGENT });

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const notConnected = (error: string): Failure => ({ ok: false, retryable: false, blocked: true, reconnectRequired: true, error });
const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** One POST /emails. Never throws. */
async function postEmail(doFetch: typeof fetch, apiKey: string, payload: ResendSendPayload, timeoutMs: number): Promise<ResendAnswer> {
  let res: Response;
  try {
    res = await doFetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json", "Idempotency-Key": payload.idempotencyKey },
      body: JSON.stringify(payload.body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
      cache: "no-store",
    });
  } catch (err) {
    if (neverConnected(err)) return { kind: "not_accepted", failure: { ok: false, retryable: true, error: "Resend could not be reached, so the message was not sent. It will be tried again." } };
    return { kind: "unclear", detail: "Resend did not answer in time." };
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) return classifyResendError(res.status, json);
  const id = json && typeof json === "object" && typeof (json as { id?: unknown }).id === "string" ? (json as { id: string }).id.trim() : "";
  // A success without an id can't be correlated; with the same key, asking again returns the original answer.
  if (!id || id.length > 160 || /\s/.test(id)) return { kind: "unclear", detail: "Resend answered without an email id." };
  return { kind: "accepted", id };
}

/**
 * Sends with a confirmation step instead of blind retries. When an answer is unclear (timeout, 5xx, a concurrent request with the same
 * key), the identical request is made again a moment later with the same Idempotency-Key: Resend then either returns the original
 * answer without sending again (it was accepted) or processes it now (it wasn't). Only an outcome Resend itself confirms is reported.
 * If it stays unclear, the message is reported as not confirmed and is not retried later, because by then the 24-hour idempotency
 * window could have passed and the customer could get it twice. A refusal Resend confirms nothing was taken (rate limit, connection
 * refused, service unavailable) is retryable: the dispatcher tries again later.
 */
async function sendWithConfirmation(doFetch: typeof fetch, apiKey: string, payload: ResendSendPayload, opts: { delays: readonly number[]; timeoutMs: number }): Promise<TransportResult> {
  let sawUnclear = false;
  let last: ResendAnswer | null = null;
  for (let attempt = 0; attempt <= opts.delays.length; attempt++) {
    if (attempt > 0) await sleep(opts.delays[attempt - 1]);
    last = await postEmail(doFetch, apiKey, payload, opts.timeoutMs);
    if (last.kind === "accepted") return { ok: true, providerMessageId: last.id, providerThreadRef: null, quantity: 1 };
    if (last.kind === "refused") return last.failure;
    if (last.kind === "unclear") sawUnclear = true;
    // A definite "not taken" on the first try is left to the dispatcher's own retry schedule.
    if (last.kind === "not_accepted" && !sawUnclear) return last.failure;
  }
  if (!sawUnclear && last?.kind === "not_accepted") return last.failure;
  return {
    ok: false,
    retryable: false,
    error: "Resend didn't confirm whether it accepted this email. It wasn't sent again automatically, so the customer can't get it twice. Check the email log in Resend before resending.",
  };
}

export interface ResendTransportOptions {
  /** Defaults to the global fetch at call time. */
  fetch?: typeof fetch;
  /** Waits between confirmation attempts. Tests pass zeros. */
  confirmDelaysMs?: readonly number[];
  timeoutMs?: number;
}

/** Builds the Resend transport. The exported resendTransport is the production one; tests build their own to skip the waits. */
export function createResendTransport(options: ResendTransportOptions = {}): ChannelTransport {
  return {
    name: "resend",
    channels: ["email"],
    requiresContactRef: false,
    async send(req) {
      // The kill switch comes first: when it is off, nothing is read and nothing leaves.
      if (!writesEnabled()) return { ok: false, retryable: false, blocked: true, error: "Sending email through Resend is switched off for this environment." };
      if (req.channel !== "email") return { ok: false, retryable: false, blocked: true, error: "Resend only sends email." };
      if (!UUID.test(req.messageId)) return { ok: false, retryable: false, error: "The message id can't be used with Resend." };
      const to = normalizeEmail(req.to);
      if (!to) return { ok: false, retryable: false, error: "The recipient's email address isn't valid." };
      const sender = parseSenderIdentity(req.sender.identity);
      if (!sender) return notConnected("The email sender isn't set up for Resend. Finish the channel setup.");
      if (!req.sender.credentialId) return notConnected("Resend isn't connected for this workspace.");
      const credentialId = req.sender.credentialId;

      const setup = await withSystem(async (db) => {
        const secret = await resolveCredential(db, credentialId, req.orgId, "resend");
        const channel = await db.query<{ inbound_address: string | null }>(
          "select inbound_address::text as inbound_address from messaging_channels where org_id = $1 and channel = 'email' and provider = 'resend'",
          [req.orgId],
        );
        return { apiKey: parseResendSecret(secret), inbound: channel.rows[0]?.inbound_address ?? null };
      }).catch(() => null);
      if (!setup?.apiKey) return notConnected("The Resend credential for this workspace is missing, revoked or unreadable. Reconnect Resend.");

      // Replies come back into the Inbox when the workspace receives email through Resend at its own address.
      const payload = resendSendPayload({ ...req, to }, sender, { replyTo: setup.inbound });
      return sendWithConfirmation(options.fetch ?? globalThis.fetch, setup.apiKey, payload, {
        delays: options.confirmDelaysMs ?? CONFIRM_DELAYS_MS,
        timeoutMs: options.timeoutMs ?? SEND_TIMEOUT_MS,
      });
    },
  };
}

export const resendTransport: ChannelTransport = createResendTransport();

// ---------------------------------------------------------------------------
// Capability test (channel setup)
// ---------------------------------------------------------------------------

interface ResendDomain {
  id: string;
  name: string;
  status: string;
  capabilities?: { sending?: string; receiving?: string };
  records?: Array<{ record?: string; status?: string }>;
  open_tracking?: boolean;
  click_tracking?: boolean;
}

// Domain.status values in Resend's OpenAPI document.
const DOMAIN_STATUS: Record<string, string> = {
  not_started: "Resend hasn't started checking its DNS records yet",
  pending: "Resend is still checking its DNS records",
  failed: "Resend couldn't verify its DNS records",
  partially_verified: "only part of its setup is verified",
  partially_failed: "one of its features failed verification",
};

function asDomain(v: unknown): ResendDomain | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.name !== "string" || typeof d.status !== "string") return null;
  return d as unknown as ResendDomain;
}

/** Sending works when Resend says the domain is verified, or when its sending records (SPF and DKIM) are while something else is pending. */
function sendingVerified(d: ResendDomain): boolean {
  if (d.capabilities?.sending === "disabled") return false;
  if (d.status === "verified") return true;
  if (d.status !== "partially_verified" && d.status !== "partially_failed") return false;
  const records = d.records ?? [];
  const spf = records.filter((r) => r.record === "SPF");
  const dkim = records.filter((r) => r.record === "DKIM");
  return spf.length > 0 && spf.every((r) => r.status === "verified") && dkim.some((r) => r.status === "verified");
}

/** Receiving works when it is enabled for the domain and its MX ("Receiving") record is verified. */
const receivingVerified = (d: ResendDomain) => d.capabilities?.receiving === "enabled" && (d.records ?? []).some((r) => r.record === "Receiving" && r.status === "verified");

export interface ResendCapabilityInput {
  /** The stored secret: the API key, or {"apiKey": "..."}. */
  secret: string;
  /** The from-address, "Name <hello@example.com>" or a bare address. */
  senderIdentity?: string | null;
  /** The Resend domain id, when known. Without it the domain is found by name. */
  senderId?: string | null;
  /** The shape channel setup passes (CapabilityTestInput in transports/index.ts); used when senderIdentity/senderId are not given. */
  sender?: { identity: string | null; senderId: string | null } | null;
  /** The address customers' replies are sent to, when replies should come back into the Inbox. */
  inboundAddress?: string | null;
  channel?: string;
  /**
   * The webhook this deployment verifies (resendWebhookUrl() and RESEND_WEBHOOK_SECRET by default). Tests pass their own; null skips the
   * webhook check, which only tooling should do: without it the test can't prove delivery events and replies will be accepted.
   */
  webhook?: { url: string; secret: string | null } | null;
}

/** Where Resend must send this deployment's webhooks. One endpoint for every workspace, verified with RESEND_WEBHOOK_SECRET. */
export function resendWebhookUrl(): string {
  return `${env().APP_URL.replace(/\/+$/, "")}/api/webhooks/resend`;
}

/** The events the portal can't do without: delivery outcomes that suppress an address. With a reply address, inbound email too. */
export const RESEND_REQUIRED_EVENTS = ["email.delivered", "email.bounced", "email.complained"] as const;

/** Same endpoint: scheme, host, port and path (a trailing slash and letter case in the host don't matter). */
function sameEndpoint(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host.toLowerCase() === y.host.toLowerCase() && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "") && !x.search && !y.search;
  } catch {
    return false;
  }
}

/** Constant-time comparison of two secrets of any length: their SHA-256 digests are compared, so neither length nor content leaks. */
function sameSecret(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(a, "utf8").digest();
  const y = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * Proves, with the workspace's own API key, that Resend can send from the sender's domain: the key is accepted, the domain exists in
 * that Resend team, matches the from-address, and is verified for sending. With an inbound address, also that it can receive there. And
 * that the account's webhook to this deployment is signed with RESEND_WEBHOOK_SECRET (webhookCheck), so bounces, complaints and replies
 * will be accepted. It only reads; nothing is sent. The key needs full access: a sending-only key can't read a domain's status (Resend answers 401
 * restricted_api_key), and the Inbox needs full access anyway to read received emails.
 */
export async function testResendCapability(input: ResendCapabilityInput, deps: { fetch?: typeof fetch; now?: Date } = {}): Promise<CapabilityTest> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const checks: CapabilityTest["checks"] = [];
  const done = (extra: Partial<CapabilityTest> = {}): CapabilityTest => ({
    ok: checks.length > 0 && checks.every((c) => c.ok),
    checkedAt: (deps.now ?? new Date()).toISOString(),
    checks,
    registrationStatus: "not_required",
    accountId: null,
    ...extra,
  });
  const fail = (label: string, detail: string, extra: Partial<CapabilityTest> = {}) => {
    checks.push({ label, ok: false, detail });
    return done({ ...extra, ok: false });
  };

  if (input.channel && input.channel !== "email") return fail("Channel", "Resend is connected for email only.");
  const apiKey = parseResendSecret(input.secret);
  if (!apiKey) return fail("API key", "That doesn't look like a Resend API key (they start with re_).");
  const sender = parseSenderIdentity(input.senderIdentity ?? input.sender?.identity);
  if (!sender) return fail("Sender", "Enter the from-address as name@yourdomain.com or Your Business <name@yourdomain.com>.");
  const senderId = (input.senderId ?? input.sender?.senderId)?.trim() || null;
  if (senderId && !UUIDISH.test(senderId)) return fail("Sender", "The Resend domain id isn't valid. Copy it from the domain's page in Resend.");
  const inbound = input.inboundAddress?.trim() ? normalizeEmail(input.inboundAddress) : null;
  if (input.inboundAddress?.trim() && !inbound) return fail("Replies", "The reply address isn't a valid email address.");

  const get = async (path: string): Promise<{ status: number; json: unknown } | null> => {
    try {
      const res = await doFetch(`${RESEND_API}${path}`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(READ_TIMEOUT_MS), redirect: "error", cache: "no-store" });
      return { status: res.status, json: await res.json().catch(() => null) };
    } catch {
      return null;
    }
  };
  const authFailure = (r: { status: number; json: unknown }) => {
    const name = errorName(r.json);
    if (name === "restricted_api_key" && r.status === 401) return "This API key can only send. Create a Full access key in Resend (API Keys), so the domain's status can be checked and replies can be read.";
    if (name === "suspended_api_key") return "Resend says this API key is suspended.";
    if (name === "restricted_api_key") return "Resend says this API key isn't active.";
    return "Resend didn't accept this API key. Check that it was copied in full and hasn't been deleted.";
  };
  const isAuthFailure = (r: { status: number; json: unknown }) => r.status === 401 || r.status === 403 || (r.status === 400 && /api key/i.test(errorMessage(r.json)));

  /** Every domain in the account, read page by page (at most 1,000). Null when Resend can't be read. */
  const listDomains = async (): Promise<{ ok: true; domains: ResendDomain[] } | { ok: false; detail: string; auth: boolean }> => {
    const domains: ResendDomain[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = await get(`/domains?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      if (!r) return { ok: false, detail: "Resend couldn't be reached. Try again in a moment.", auth: false };
      if (isAuthFailure(r)) return { ok: false, detail: authFailure(r), auth: true };
      if (r.status !== 200) return { ok: false, detail: `Resend answered ${r.status} when listing domains. Try again in a moment.`, auth: false };
      const list = r.json as { data?: unknown[]; has_more?: boolean } | null;
      const items = Array.isArray(list?.data) ? list.data.map(asDomain).filter((d): d is ResendDomain => Boolean(d)) : [];
      domains.push(...items);
      if (!list?.has_more || !items.length) break;
      after = items[items.length - 1].id;
    }
    return { ok: true, domains };
  };
  const readDomain = async (id: string) => {
    const r = await get(`/domains/${encodeURIComponent(id)}`);
    return r && r.status === 200 ? asDomain(r.json) : null;
  };

  let domain: ResendDomain | null = null;
  let listed: ResendDomain[] | null = null;
  if (senderId) {
    const r = await get(`/domains/${encodeURIComponent(senderId)}`);
    if (!r) return fail("Reach Resend", "Resend couldn't be reached. Try again in a moment.");
    if (isAuthFailure(r)) return fail("API key", authFailure(r));
    checks.push({ label: "API key", ok: true, detail: "Resend accepted the API key." });
    if (r.status === 404 || r.status === 422) return fail("Domain", "Resend has no domain with that id in this account.");
    if (r.status !== 200) return fail("Domain", `Resend answered ${r.status} when reading the domain. Try again in a moment.`);
    domain = asDomain(r.json);
    if (!domain) return fail("Domain", "Resend's answer about the domain couldn't be read.");
  } else {
    const all = await listDomains();
    if (!all.ok) return fail(all.auth ? "API key" : "Reach Resend", all.detail);
    checks.push({ label: "API key", ok: true, detail: "Resend accepted the API key." });
    listed = all.domains;
    const match = listed.find((d) => d.name.toLowerCase() === sender.domain);
    if (!match) return fail("Domain", `${sender.domain} isn't added to this Resend account. Add and verify it in Resend (Domains), then test again.`);
    // The list doesn't include DNS records; the domain itself does.
    domain = (await readDomain(match.id)) ?? match;
  }

  const name = domain.name.toLowerCase();
  if (name !== sender.domain) {
    return fail("Domain", `The from-address is at ${sender.domain}, but this Resend domain is ${name}. Use an address at ${name}.`, { senderId: domain.id });
  }
  checks.push({ label: "Domain", ok: true, detail: `${name} is in this Resend account and matches the from-address.` });
  const canSend = sendingVerified(domain);
  checks.push({
    label: "Sending",
    ok: canSend,
    detail: canSend
      ? `${name} is verified for sending in Resend.`
      : domain.capabilities?.sending === "disabled"
        ? `Sending is switched off for ${name} in Resend.`
        : `${name} isn't verified for sending yet: ${DOMAIN_STATUS[domain.status] ?? `its status is ${headerText(domain.status, 40)}`}.`,
  });

  if (!inbound) {
    checks.push({
      label: "Replies",
      ok: true,
      detail: receivingVerified(domain)
        ? `${name} can receive email through Resend. Add a reply address at ${name} so customers' replies come back into the Inbox.`
        : "No reply address is set, so customers' replies go to the from-address and won't appear in the Inbox.",
    });
  } else {
    const inboundDomain = inbound.slice(inbound.lastIndexOf("@") + 1);
    if (inboundDomain === name) {
      const ok = receivingVerified(domain);
      checks.push({ label: "Replies", ok, detail: ok ? `${inbound} receives email through Resend, so replies come back into the Inbox.` : `Receiving isn't enabled and verified for ${name} in Resend, so replies to ${inbound} wouldn't arrive. Enable receiving for the domain and add its MX record, or clear the reply address.` });
    } else if (/\.resend\.app$/.test(inboundDomain)) {
      // Resend-managed receiving addresses aren't domains in the account, so the API can't confirm which account owns one.
      checks.push({ label: "Replies", ok: true, detail: `${inbound} is a Resend-managed receiving address. Make sure it belongs to this Resend account (Emails → Receiving).` });
    } else {
      let found: ResendDomain | null = null;
      if (!listed) {
        const all = await listDomains();
        listed = all.ok ? all.domains : [];
      }
      const match = listed.find((d) => d.name.toLowerCase() === inboundDomain);
      if (match) found = (await readDomain(match.id)) ?? match;
      const ok = Boolean(found && receivingVerified(found));
      checks.push({
        label: "Replies",
        ok,
        detail: ok
          ? `${inbound} receives email through Resend, so replies come back into the Inbox.`
          : found
            ? `Receiving isn't enabled and verified for ${inboundDomain} in Resend, so replies to ${inbound} wouldn't arrive.`
            : `${inboundDomain} isn't a domain in this Resend account, so replies to ${inbound} wouldn't reach the Inbox.`,
      });
    }
  }
  if (input.webhook !== null) checks.push(await webhookCheck(get, isAuthFailure, authFailure, { url: input.webhook?.url ?? resendWebhookUrl(), secret: input.webhook === undefined ? webhookSecret() : input.webhook.secret, inbound: Boolean(inbound) }));
  if (domain.open_tracking || domain.click_tracking) {
    checks.push({ label: "Tracking", ok: true, detail: "Open or click tracking is on for this domain in Resend, so Resend adds a tracking image or rewrites links in the HTML part." });
  }
  return done({ senderIdentity: formatFrom(sender), senderId: domain.id });
}

type Getter = (path: string) => Promise<{ status: number; json: unknown } | null>;

/**
 * Proves that this Resend account delivers its events where this deployment can verify them: an enabled webhook to our endpoint
 * (GET /webhooks), subscribed to the events the portal needs, whose signing secret (GET /webhooks/{id}) is RESEND_WEBHOOK_SECRET. Resend
 * generates each webhook's secret itself (CreateWebhookResponse.signing_secret), so a key from another Resend account fails here instead of
 * every bounce, complaint and reply being refused later. The secret is compared in constant time and never shown.
 */
async function webhookCheck(
  get: Getter,
  isAuthFailure: (r: { status: number; json: unknown }) => boolean,
  authFailure: (r: { status: number; json: unknown }) => string,
  opts: { url: string; secret: string | null | undefined; inbound: boolean },
): Promise<CapabilityTest["checks"][number]> {
  const label = "Webhooks";
  const secret = opts.secret?.trim();
  if (!secret) return { label, ok: false, detail: "RESEND_WEBHOOK_SECRET isn't configured in this deployment, so Resend's delivery events and replies would be refused." };
  const required: string[] = [...RESEND_REQUIRED_EVENTS, ...(opts.inbound ? ["email.received"] : [])];
  const hooks: Array<{ id: string; endpoint: string; status: string; events: string[] }> = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const r = await get(`/webhooks?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (!r) return { label, ok: false, detail: "Resend couldn't be reached to read its webhooks. Try again in a moment." };
    if (isAuthFailure(r)) return { label, ok: false, detail: authFailure(r) };
    if (r.status !== 200) return { label, ok: false, detail: `Resend answered ${r.status} when listing webhooks. Try again in a moment.` };
    const list = r.json as { data?: unknown[]; has_more?: boolean } | null;
    const items = (Array.isArray(list?.data) ? list.data : []).flatMap((raw) => {
      const w = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      if (!w || typeof w.id !== "string" || typeof w.endpoint !== "string") return [];
      return [{ id: w.id, endpoint: w.endpoint, status: typeof w.status === "string" ? w.status : "", events: Array.isArray(w.events) ? w.events.filter((e): e is string => typeof e === "string") : [] }];
    });
    hooks.push(...items);
    if (!list?.has_more || !items.length) break;
    after = items[items.length - 1].id;
  }
  const ours = hooks.filter((h) => sameEndpoint(h.endpoint, opts.url));
  if (!ours.length) return { label, ok: false, detail: `This Resend account has no webhook to ${opts.url}. Add it in Resend (Webhooks) with the events ${required.join(", ")}.` };
  const enabled = ours.filter((h) => h.status === "enabled");
  if (!enabled.length) return { label, ok: false, detail: `The webhook to ${opts.url} is switched off in Resend. Enable it.` };
  let missing: string[] = required;
  for (const hook of enabled) {
    const lacking = required.filter((e) => !hook.events.includes(e));
    if (lacking.length) {
      if (lacking.length < missing.length) missing = lacking;
      continue;
    }
    const r = await get(`/webhooks/${encodeURIComponent(hook.id)}`);
    if (!r) return { label, ok: false, detail: "Resend couldn't be reached to read the webhook. Try again in a moment." };
    if (isAuthFailure(r)) return { label, ok: false, detail: authFailure(r) };
    const signing = r.status === 200 && r.json && typeof r.json === "object" ? (r.json as { signing_secret?: unknown }).signing_secret : null;
    if (typeof signing === "string" && signing && sameSecret(signing.trim(), secret)) {
      return { label, ok: true, detail: `Resend sends ${required.join(", ")} to ${opts.url}, signed with this deployment's secret.` };
    }
    return {
      label,
      ok: false,
      detail: `The webhook to ${opts.url} in this Resend account is signed with a different secret than RESEND_WEBHOOK_SECRET, so its events would be refused. Use an API key from iAcquire's own Resend account: client-owned Resend accounts aren't supported.`,
    };
  }
  return { label, ok: false, detail: `The webhook to ${opts.url} doesn't send ${missing.join(", ")}. Add ${missing.length === 1 ? "that event" : "those events"} to it in Resend.` };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

type HeaderSource = Headers | Record<string, string | string[] | null | undefined>;
const header = (h: HeaderSource, name: string): string | null => {
  if (h instanceof Headers) return h.get(name);
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  const v = key ? h[key] : null;
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
};

export type ResendSignatureCheck = { ok: true; id: string; timestamp: number } | { ok: false; reason: "not_configured" | "missing_headers" | "stale" | "signature" };

/**
 * Verifies a Svix-signed request: HMAC-SHA256 over "svix-id.svix-timestamp.body" keyed with the base64 bytes after "whsec_", compared in
 * constant time against each "v1,<base64>" entry, with the timestamp within five minutes of now either way. The unbranded
 * "webhook-*" header names that Svix's library also accepts are read too.
 */
export function verifyResendSignature(input: { rawBody: string; headers: HeaderSource; secret: string | null | undefined; now?: number }): ResendSignatureCheck {
  const secret = input.secret?.trim();
  if (!secret) return { ok: false, reason: "not_configured" };
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  if (key.length < 16) return { ok: false, reason: "not_configured" };
  const id = header(input.headers, "svix-id") ?? header(input.headers, "webhook-id");
  const stamp = header(input.headers, "svix-timestamp") ?? header(input.headers, "webhook-timestamp");
  const signatures = header(input.headers, "svix-signature") ?? header(input.headers, "webhook-signature");
  if (!id || !stamp || !signatures || id.length > 200 || !/^[\x21-\x7e]+$/.test(id) || !/^\d{1,12}$/.test(stamp)) return { ok: false, reason: "missing_headers" };
  const timestamp = Number(stamp);
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
  const expected = crypto.createHmac("sha256", key).update(`${id}.${stamp}.${input.rawBody}`).digest();
  const valid = signatures
    .split(" ")
    .slice(0, 20)
    .some((entry) => {
      const [version, sig] = entry.split(",");
      if (version !== "v1" || !sig) return false;
      const given = Buffer.from(sig, "base64");
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
  return valid ? { ok: true, id, timestamp } : { ok: false, reason: "signature" };
}

/** Signs a payload the way Svix does. For tests and local tooling; production never signs anything. */
export function signResendWebhook(secret: string, id: string, timestamp: number, rawBody: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return `v1,${crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64")}`;
}

export type ResendDeliveryKind = "sent" | "delivered" | "delivery_delayed" | "bounced" | "complained" | "failed" | "suppressed";

export type ResendEvent =
  | {
      kind: "delivery";
      type: ResendDeliveryKind;
      emailId: string;
      /** Our conversation_messages id, from the "mid" tag the transport sets. */
      messageId: string | null;
      occurredAt: Date;
      bounceType: string | null;
      suppressedReason: string | null;
      failedReason: string | null;
    }
  | {
      kind: "received";
      emailId: string;
      from: string | null;
      recipients: string[];
      subject: string | null;
      messageIdHeader: string | null;
      attachments: number;
      occurredAt: Date;
    }
  | { kind: "other"; type: string };

const DELIVERY_TYPES = new Set<ResendDeliveryKind>(["sent", "delivered", "delivery_delayed", "bounced", "complained", "failed", "suppressed"]);
const str = (v: unknown, max = 500) => (typeof v === "string" && v.length <= max ? v : null);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 320) : []);
const when = (v: unknown) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? new Date() : new Date(t);
};

/** Narrows a webhook payload to what the portal uses. Unknown or malformed events come back as "other" and are acknowledged, not used. */
export function parseResendEvent(payload: unknown): ResendEvent {
  if (!payload || typeof payload !== "object") return { kind: "other", type: "" };
  const p = payload as { type?: unknown; created_at?: unknown; data?: unknown };
  const type = str(p.type, 80) ?? "";
  const data = p.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : null;
  const emailId = data ? str(data.email_id, 160) : null;
  if (!data || !emailId || /\s/.test(emailId)) return { kind: "other", type };
  if (type === "email.received") {
    return {
      kind: "received",
      emailId,
      from: str(data.from, 320),
      recipients: [...strings(data.to), ...strings(data.cc), ...strings(data.bcc), ...strings(data.received_for)].slice(0, 50),
      subject: str(data.subject, 998),
      messageIdHeader: str(data.message_id, 998),
      attachments: Array.isArray(data.attachments) ? data.attachments.length : 0,
      occurredAt: when(data.created_at ?? p.created_at),
    };
  }
  const short = type.startsWith("email.") ? (type.slice(6) as ResendDeliveryKind) : null;
  if (!short || !DELIVERY_TYPES.has(short)) return { kind: "other", type };
  // Tags arrive as an object of name → value (OutboundEmailEventData.tags).
  const tags = data.tags && typeof data.tags === "object" && !Array.isArray(data.tags) ? (data.tags as Record<string, unknown>) : {};
  const mid = str(tags.mid, 64);
  const bounce = data.bounce && typeof data.bounce === "object" ? (data.bounce as Record<string, unknown>) : null;
  const suppressed = data.suppressed && typeof data.suppressed === "object" ? (data.suppressed as Record<string, unknown>) : null;
  const failed = data.failed && typeof data.failed === "object" ? (data.failed as Record<string, unknown>) : null;
  return {
    kind: "delivery",
    type: short,
    emailId,
    messageId: mid && UUID.test(mid) ? mid.toLowerCase() : null,
    occurredAt: when(p.created_at),
    bounceType: bounce ? str(bounce.type, 40) : null,
    suppressedReason: suppressed ? str(suppressed.reason, 60) : null,
    failedReason: failed ? str(failed.reason, 80) : null,
  };
}

export type ResendDeliveryUpdate = Pick<DeliveryEventInput, "status" | "detail" | "suppress"> & { rawStatus: string };

/** How each Resend delivery event is recorded. Only Resend's events move a message forward; a send returning never marks it delivered. */
export function deliveryUpdate(e: Extract<ResendEvent, { kind: "delivery" }>): ResendDeliveryUpdate {
  switch (e.type) {
    case "sent":
      return { status: "sent", rawStatus: "sent" };
    case "delivered":
      return { status: "delivered", rawStatus: "delivered" };
    case "delivery_delayed":
      // Resend has the email and the receiving server asked it to try later. Kept as the raw status; "sent" never moves anything back.
      return { status: "sent", rawStatus: "delivery_delayed", detail: "Delivery is delayed: the receiving server asked Resend to try again later." };
    case "bounced": {
      const hard = e.bounceType === "Permanent";
      return {
        status: "failed",
        rawStatus: "bounced",
        detail: hard ? "The address bounced permanently, so it won't be emailed again." : `The email bounced${e.bounceType ? ` (${headerText(e.bounceType, 30).toLowerCase()})` : ""}.`,
        // Only a hard bounce means the address is bad. A soft bounce (full mailbox, too large) can succeed another time.
        suppress: hard ? "bounce" : undefined,
      };
    }
    case "complained":
      // A complaint means it reached the inbox and the person marked it as spam: delivered, and never email them again.
      return { status: "delivered", rawStatus: "complained", detail: "The recipient marked this email as spam, so the address won't be emailed again.", suppress: "complaint" };
    case "suppressed": {
      const complaint = e.suppressedReason === "previous_complaint";
      return {
        status: "failed",
        rawStatus: "suppressed",
        detail: complaint ? "Resend didn't send it: this address complained before." : "Resend didn't send it: this address bounced before.",
        suppress: complaint ? "complaint" : "bounce",
      };
    }
    case "failed":
      return { status: "failed", rawStatus: "failed", detail: `Resend couldn't send the email${e.failedReason ? ` (${headerText(e.failedReason, 60)})` : ""}.` };
  }
}

/**
 * Records one delivery event against our message: by the "mid" tag first, through send.ts's applyDeliveryEventForMessage (so an event
 * that arrives before the send call returned still lands, and Resend's email id is recorded then), otherwise by Resend's email id.
 * Returns the workspace the message belongs to, when one does.
 */
async function applyResendDelivery(db: Queryable, e: Extract<ResendEvent, { kind: "delivery" }>): Promise<DeliveryResult & { orgId: string | null }> {
  const update = deliveryUpdate(e);
  const input: DeliveryEventInput = {
    provider: "resend",
    providerEventId: `${e.emailId}:${e.type}`,
    providerMessageId: e.emailId,
    occurredAt: e.occurredAt,
    status: update.status,
    rawStatus: update.rawStatus,
    detail: update.detail,
    suppress: update.suppress,
  };
  let applied: DeliveryResult = { result: "unknown_message" };
  if (e.messageId) applied = await applyDeliveryEventForMessage(db, { ...input, messageId: e.messageId });
  // No tag (an email sent before tags were set) or a tag that matches nothing of ours: fall back to Resend's email id.
  if (applied.result === "unknown_message") applied = await applyDeliveryEvent(db, input);
  if (applied.result === "unknown_message") return { ...applied, orgId: null };
  const org = await db.query<{ org_id: string }>("select org_id from conversation_messages where provider = 'resend' and provider_message_id = $1", [e.emailId]);
  return { ...applied, orgId: org.rows[0]?.org_id ?? null };
}

export interface ResendWebhookResult {
  status: number;
  outcome: "processed" | "duplicate" | "ignored" | "rejected" | "retry";
  detail?: string;
  orgId?: string;
  conversationId?: string;
  aiShouldRespond?: boolean;
  /** Conversations an AI reply should be prepared for, after the webhook is answered. */
  replies?: Array<{ orgId: string; conversationId: string }>;
}

/** An automatic or bulk email (out-of-office, mailing list, bounce notice) is never treated as a customer writing in. */
export function isAutomatedEmail(headers: Record<string, string>, from: string | null): boolean {
  const h = (k: string) => (headers[k] ?? "").toLowerCase().trim();
  if (h("auto-submitted") && h("auto-submitted") !== "no") return true;
  if (/^(bulk|junk|list|auto_reply)$/.test(h("precedence"))) return true;
  if (h("x-autoreply") || h("x-autorespond") || h("x-auto-response-suppress").includes("all") || h("list-id") || h("list-unsubscribe")) return true;
  return Boolean(from && /^(mailer-daemon|postmaster)@/i.test(from));
}

/** Plain text from an HTML-only email, for the Inbox. Tags are dropped, never interpreted. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d{1,7});/g, (m, d: string) => (Number(d) > 0 && Number(d) <= 0x10ffff ? String.fromCodePoint(Number(d)) : m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h: string) => (parseInt(h, 16) > 0 && parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : m))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The customer's new words, without the quoted thread below them ("On … wrote:", "> …", forwarded headers). Falls back to the whole text. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = `${line} ${lines[i + 1] ?? ""}`;
    if (/^\s*>/.test(line)) break;
    if (/^\s*On\b.{0,200}\bwrote:\s*$/i.test(line) || /^\s*On\b.{0,200}\bwrote:\s*$/i.test(next.trim())) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^_{10,}\s*$/.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && /^\s*(Sent|Date):\s/i.test(lines[i + 1] ?? "")) break;
    out.push(line);
  }
  const kept = out.join("\n").trim();
  return kept || text.trim();
}

interface ReceivedContent {
  text: string;
  fromName: string | null;
  from: string | null;
  headers: Record<string, string>;
  messageIdHeader: string | null;
  subject: string | null;
  /** The receiving server proved the From domain (see senderAuthenticated). */
  senderVerified: boolean;
}

/** One SPF/DKIM/DMARC verdict as Resend reports it: pass, fail, gray, processing_failed or unknown. */
export interface ReceivedAuthentication {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

/**
 * The `authentication` object of a received email (GET /emails/receiving/{id}): the SPF, DKIM and DMARC results Resend's receiving server
 * computed. Resend documents that they come from the receiving server, not from the message's headers, so the sender can't forge them; an
 * Authentication-Results header inside the message could be, so it is never read. Null when Resend didn't report it (older emails).
 */
export function receivedAuthentication(v: unknown): ReceivedAuthentication | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const verdict = (x: unknown) => (typeof x === "string" && /^[a-z_]{1,30}$/.test(x) ? x : null);
  return { spf: verdict(o.spf), dkim: verdict(o.dkim), dmarc: verdict(o.dmarc) };
}

/**
 * Whether the From address is proven: DMARC passed (SPF or DKIM passed aligned with the From domain), or DKIM passed (Resend's "pass" means
 * the message was signed by the From domain; a signature by another domain is "gray"). SPF alone proves only the envelope sender, which
 * can differ from From, so it isn't enough. Without a verdict the sender is unproven.
 */
export function senderAuthenticated(a: ReceivedAuthentication | null): boolean {
  return Boolean(a && (a.dmarc === "pass" || a.dkim === "pass"));
}

type Fetched = { ok: true; content: ReceivedContent } | { ok: false; permanent: boolean; detail: string };

async function fetchReceivedEmail(apiKey: string, emailId: string, doFetch: typeof fetch): Promise<Fetched> {
  let res: Response;
  try {
    res = await doFetch(`${RESEND_API}/emails/receiving/${encodeURIComponent(emailId)}`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(READ_TIMEOUT_MS), redirect: "error", cache: "no-store" });
  } catch {
    return { ok: false, permanent: false, detail: "Resend couldn't be reached to read the email." };
  }
  const json: unknown = await res.json().catch(() => null);
  const name = errorName(json);
  if (res.status === 403 && name === "email_above_quota") return { ok: false, permanent: true, detail: "Resend won't show this email's content: it arrived while the account was over its quota." };
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(errorMessage(json)))) {
    return { ok: false, permanent: true, detail: `Resend refused to let this workspace's key read the email (${res.status}${name ? `, ${name}` : ""}).` };
  }
  // The email exists in the account that received it; a 404 means this workspace's key belongs to a different Resend account.
  if (res.status === 404) return { ok: false, permanent: true, detail: "Resend has no such email in the account this workspace's key belongs to." };
  if (res.status === 429 || res.status >= 500) return { ok: false, permanent: false, detail: `Resend answered ${res.status} when reading the email.` };
  if (!res.ok || !json || typeof json !== "object") return { ok: false, permanent: true, detail: `Resend answered ${res.status} when reading the email.` };
  const e = json as Record<string, unknown>;
  const rawHeaders = e.headers && typeof e.headers === "object" ? (e.headers as Record<string, unknown>) : {};
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders).slice(0, 200)) {
    const value = Array.isArray(v) ? v.find((x) => typeof x === "string") : v;
    if (typeof value === "string") headers[k.toLowerCase()] = value.slice(0, 2000);
  }
  const fromHeader = parseSenderIdentity(headers.from ?? str(e.from, 320));
  const text = str(e.text, 1_000_000) ?? (str(e.html, 2_000_000) ? htmlToText(e.html as string) : "");
  return {
    ok: true,
    content: {
      text,
      fromName: fromHeader?.name ?? null,
      from: fromHeader?.address ?? normalizeEmail(str(e.from, 320)),
      headers,
      messageIdHeader: str(e.message_id, 998),
      subject: str(e.subject, 998),
      senderVerified: senderAuthenticated(receivedAuthentication(e.authentication)),
    },
  };
}

/** The address part of "Name <a@b>" or a bare address, normalized. */
const addressOf = (v: string) => parseSenderIdentity(v)?.address ?? normalizeEmail(v);

/** Webhook processing state the route never sees. */
interface InboundTarget {
  orgId: string;
  inboundAddress: string;
  senderIdentity: string | null;
  apiKey: string | null;
}

/**
 * Handles one Resend webhook. The Svix signature and freshness are checked first; the svix-id goes into webhook_receipts so a replay
 * changes nothing; delivery events update our message; a received email becomes an inbound Inbox message for the workspace that
 * receives email at the address it was sent to. Answers 2xx for everything that is handled or deliberately ignored, and 5xx only when a
 * retry can help (Resend retries for about a day: 5s, 5m, 30m, 2h, 5h, 10h, 10h).
 */
export async function handleResendWebhook(
  rawBody: string,
  headers: HeaderSource,
  opts: { now?: number; secret?: string | null; fetch?: typeof fetch } = {},
): Promise<ResendWebhookResult> {
  const check = verifyResendSignature({ rawBody, headers, secret: opts.secret === undefined ? webhookSecret() : opts.secret, now: opts.now });
  if (!check.ok) {
    if (check.reason === "not_configured") return { status: 503, outcome: "rejected", detail: "Resend webhooks aren't configured." };
    return { status: check.reason === "signature" ? 401 : 400, outcome: "rejected", detail: `Webhook ${check.reason.replace("_", " ")}.` };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, outcome: "rejected", detail: "Webhook malformed." };
  }
  const event = parseResendEvent(payload);
  const kind = (typeof (payload as { type?: unknown } | null)?.type === "string" ? (payload as { type: string }).type : "").slice(0, 80);

  const finish = async (db: Queryable, result: ResendWebhookResult, orgId?: string | null) => {
    await db.query("update webhook_receipts set outcome = $2, detail = $3, org_id = $4 where provider = 'resend' and external_id = $1", [
      check.id,
      result.outcome === "duplicate" ? "ignored" : result.outcome === "retry" ? "rejected" : result.outcome,
      result.detail?.slice(0, 300) ?? null,
      orgId ?? null,
    ]);
    return result;
  };
  const receipt = (db: Queryable) =>
    db.query("insert into webhook_receipts (provider, external_id, kind) values ('resend', $1, $2) on conflict do nothing returning external_id", [check.id, kind]).then((r) => Boolean(r.rows[0]));

  if (event.kind === "other") {
    return withSystem(async (db) => {
      if (!(await receipt(db))) return { status: 200, outcome: "duplicate" as const };
      return finish(db, { status: 200, outcome: "ignored", detail: `Event type ${kind || "(none)"} is not used.` });
    });
  }

  if (event.kind === "delivery") {
    return withSystem(async (db) => {
      if (!(await receipt(db))) return { status: 200, outcome: "duplicate" as const };
      const applied = await applyResendDelivery(db, event);
      const outcome = applied.result === "applied" || applied.result === "no_change" ? "processed" : applied.result === "duplicate" ? "duplicate" : "ignored";
      const detail = applied.result === "unknown_message" ? "No message of ours matches this email." : `Delivery ${event.type}: ${applied.result}.`;
      return finish(db, { status: 200, outcome, detail, orgId: applied.orgId ?? undefined }, applied.orgId);
    });
  }

  // A received email. Its body isn't in the webhook: it is read with the receiving workspace's own key, outside any transaction.
  // One email reaches one workspace (a Resend email id belongs to one message): the one whose address comes first in To, then Cc.
  const recipients = [...new Set(event.recipients.map(addressOf).filter((a): a is string => Boolean(a)))];
  const found = await withSystem(async (db) => {
    const seen = await db.query("select 1 from webhook_receipts where provider = 'resend' and external_id = $1", [check.id]);
    if (seen.rows[0]) return null;
    if (!recipients.length) return { target: null, others: 0 };
    const { rows } = await db.query<{ org_id: string; credential_id: string | null; sender_identity: string | null; inbound_address: string }>(
      `select org_id, credential_id, sender_identity, inbound_address::text as inbound_address from messaging_channels
       where channel = 'email' and provider = 'resend' and inbound_address = any(($1::text[])::citext[])`,
      [recipients],
    );
    const rank = (a: string) => recipients.indexOf(a.toLowerCase());
    const chosen = [...rows].sort((a, b) => rank(a.inbound_address) - rank(b.inbound_address))[0];
    if (!chosen) return { target: null, others: 0 };
    const secret = chosen.credential_id ? await resolveCredential(db, chosen.credential_id, chosen.org_id, "resend").catch(() => null) : null;
    const target: InboundTarget = { orgId: chosen.org_id, inboundAddress: chosen.inbound_address.toLowerCase(), senderIdentity: chosen.sender_identity, apiKey: parseResendSecret(secret) };
    return { target, others: rows.length - 1 };
  });
  if (!found) return { status: 200, outcome: "duplicate" };

  const recordOnly = (result: ResendWebhookResult, orgId: string | null, notify?: string) =>
    withSystem(async (db) => {
      if (!(await receipt(db))) return { status: 200, outcome: "duplicate" as const };
      if (notify && orgId) {
        await notifyAgency(db, orgId, {
          kind: "integration_reconnect_required",
          severity: "warning",
          title: "A customer email couldn't be read",
          body: `An email arrived through Resend for this workspace but couldn't be read: ${notify} The email is still in Resend.`,
          dedupeKey: `resend-inbound:${orgId}:${new Date().toISOString().slice(0, 10)}`,
        });
      }
      return finish(db, result, orgId);
    });
  const target = found.target;
  if (!target) return recordOnly({ status: 200, outcome: "ignored", detail: "No workspace receives email at this address through Resend." }, null);
  const orgId = target.orgId;
  const alsoFor = found.others > 0 ? ` It was also addressed to ${found.others} other workspace${found.others === 1 ? "" : "s"}, which didn't get it.` : "";

  const got: Fetched = target.apiKey
    ? await fetchReceivedEmail(target.apiKey, event.emailId, opts.fetch ?? globalThis.fetch)
    : { ok: false, permanent: true, detail: "The workspace's Resend credential is missing or revoked, so the email couldn't be read." };
  if (!got.ok) {
    // Transient: let Resend retry (nothing is recorded, so the retry is processed normally). Permanent: record it and tell the agency.
    if (!got.permanent) return { status: 503, outcome: "retry", detail: got.detail, orgId };
    return recordOnly({ status: 200, outcome: "rejected", detail: got.detail, orgId }, orgId, got.detail);
  }

  const content = got.content;
  const address = content.from ?? (event.from ? addressOf(event.from) : null);
  const own = new Set([parseSenderIdentity(target.senderIdentity)?.address, target.inboundAddress].filter(Boolean));
  if (!address) return recordOnly({ status: 200, outcome: "ignored", detail: "The email has no usable sender address.", orgId }, orgId);
  if (own.has(address)) return recordOnly({ status: 200, outcome: "ignored", detail: "The email came from this workspace's own address.", orgId }, orgId);
  if (isAutomatedEmail(content.headers, address)) return recordOnly({ status: 200, outcome: "ignored", detail: "Automatic or bulk email (auto-reply, mailing list or bounce notice).", orgId }, orgId);

  let body = stripQuotedReply(content.text).slice(0, 5000);
  if (!body) body = event.attachments ? `(No message text. ${event.attachments} attachment${event.attachments === 1 ? "" : "s"} not shown; open the email in Resend to see ${event.attachments === 1 ? "it" : "them"}.)` : "(No message text.)";
  const messageIdHeader = normalizeMessageId(content.messageIdHeader) ?? normalizeMessageId(event.messageIdHeader);

  const emails: OutgoingEmail[] = [];
  const result = await withSystem(async (db): Promise<ResendWebhookResult> => {
    if (!(await receipt(db))) return { status: 200, outcome: "duplicate" };
    const r = await ingestInbound(db, {
      orgId,
      provider: "resend",
      channel: "email",
      address,
      name: content.fromName ?? undefined,
      body,
      providerMessageId: event.emailId,
      subject: headerText(content.subject ?? event.subject ?? "", 300) || null,
      receivedAt: event.occurredAt,
      // Anyone can put any address in From. Unless Resend's receiving server authenticated it, the email is recorded but changes no
      // consent or suppression (STOP/START), counts as no inquiry, and gets no automatic reply.
      senderVerified: content.senderVerified,
    });
    // The customer's Message-ID, so our reply can carry In-Reply-To and References and stay in their thread.
    if (r.status === "created" && messageIdHeader) await db.query("update conversation_messages set provider_thread_ref = $2 where id = $1 and provider_thread_ref is null", [r.messageId, messageIdHeader]);
    emails.push(...r.emails);
    const replies = r.aiShouldRespond ? [{ orgId, conversationId: r.conversationId }] : [];
    const unproven = content.senderVerified ? "" : " The sender's address wasn't authenticated (no DMARC or DKIM pass), so it was recorded without consent changes or an automatic reply.";
    return finish(
      db,
      { status: 200, outcome: r.status === "duplicate" ? "duplicate" : "processed", detail: `${alsoFor}${unproven}`.trim() || undefined, orgId, conversationId: r.conversationId, aiShouldRespond: r.aiShouldRespond, replies },
      orgId,
    );
  });
  await Promise.all(emails.map((e) => sendEmail(e)));
  return result;
}
