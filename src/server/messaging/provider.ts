import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { loadGhlMapping } from "@/server/integrations/ghl";
import type { Channel } from "@/lib/messaging";

// Contract sources: GoHighLevel OpenAPI (conversations: POST /conversations/messages, Version 2021-04-15) and the
// GoHighLevel webhook authentication guide (x-wh-signature, RSA-SHA256), read 2026-10-14.
// Nothing here has been exercised against a live GoHighLevel location. Sending is off unless GHL_WRITES_ENABLED=true.

export interface ProviderSendRequest {
  orgId: string;
  channel: Channel;
  /** The GoHighLevel contact id the message goes to. */
  contactRef: string;
  body: string;
  subject?: string | null;
  templateId?: string | null;
  /** The verified sender (number or from-address) recorded for this channel. */
  fromIdentity: string | null;
  /** Our message id, for logs only. GoHighLevel has no idempotency key, so sends are at-most-once. */
  messageId: string;
}

export type ProviderResult =
  | { ok: true; providerMessageId: string; providerConversationId?: string }
  | { ok: false; retryable: boolean; error: string; /** Not attempted at all: disabled or not connected. */ blocked?: boolean; reconnectRequired?: boolean };

export interface ChannelProvider {
  name: string;
  send(req: ProviderSendRequest): Promise<ProviderResult>;
}

const GHL_TYPES: Record<Channel, string> = { sms: "SMS", whatsapp: "WhatsApp", email: "Email" };
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

export function ghlSendPayload(req: ProviderSendRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { type: GHL_TYPES[req.channel], contactId: req.contactRef, message: req.body };
  if (req.channel === "email") {
    payload.subject = (req.subject ?? "").slice(0, 300) || "Re: your enquiry";
    payload.html = escapeHtml(req.body);
    if (req.fromIdentity) payload.emailFrom = req.fromIdentity;
  } else if (req.fromIdentity) {
    payload.fromNumber = req.fromIdentity;
  }
  if (req.templateId) payload.templateId = req.templateId;
  return payload;
}

export const ghlProvider: ChannelProvider = {
  name: "ghl",
  async send(req) {
    if (!env().GHL_WRITES_ENABLED) return { ok: false, retryable: false, blocked: true, error: "Sending through GoHighLevel is switched off for this environment." };
    const mapping = await withSystem((db) => loadGhlMapping(db, req.orgId)).catch(() => null);
    if (!mapping) return { ok: false, retryable: false, blocked: true, reconnectRequired: true, error: "GoHighLevel is not connected for this workspace." };
    const base = new URL(env().GHL_API_BASE);
    if (base.origin !== "https://services.leadconnectorhq.com") return { ok: false, retryable: false, blocked: true, error: "GoHighLevel must use the official API host." };
    let res: Response;
    try {
      res = await fetch(new URL("/conversations/messages", base), {
        method: "POST",
        headers: { Authorization: `Bearer ${mapping.token}`, Version: "2021-04-15", "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(ghlSendPayload(req)),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      // A timeout can mean the provider did receive it. The dispatcher treats an unconfirmed send as failed, not as safe to repeat.
      return { ok: false, retryable: false, error: "GoHighLevel could not be reached. The message was not confirmed sent." };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, retryable: false, reconnectRequired: true, error: "GoHighLevel rejected the credential or its permissions." };
    if (res.status === 429) return { ok: false, retryable: true, error: "GoHighLevel rate limit reached." };
    if (res.status >= 500) return { ok: false, retryable: false, error: `GoHighLevel returned ${res.status}. The message was not confirmed sent.` };
    if (!res.ok) return { ok: false, retryable: false, error: `GoHighLevel refused the message (${res.status}).` };
    const body: unknown = await res.json().catch(() => null);
    const messageId = body && typeof body === "object" && typeof (body as { messageId?: unknown }).messageId === "string" ? (body as { messageId: string }).messageId : null;
    if (!messageId) return { ok: false, retryable: false, error: "GoHighLevel did not confirm the message." };
    const conversationId = typeof (body as { conversationId?: unknown }).conversationId === "string" ? (body as { conversationId: string }).conversationId : undefined;
    return { ok: true, providerMessageId: messageId, providerConversationId: conversationId };
  },
};

export interface GhlContactInfo {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

/** Looks a contact up in the tenant's own location. A contact belonging to another location is refused. */
export async function fetchGhlContact(orgId: string, contactId: string): Promise<GhlContactInfo | null> {
  const mapping = await withSystem((db) => loadGhlMapping(db, orgId)).catch(() => null);
  if (!mapping || !/^[A-Za-z0-9_-]{6,64}$/.test(contactId)) return null;
  const base = new URL(env().GHL_API_BASE);
  if (base.origin !== "https://services.leadconnectorhq.com") return null;
  try {
    const res = await fetch(new URL(`/contacts/${contactId}`, base), {
      headers: { Authorization: `Bearer ${mapping.token}`, Version: "2021-07-28", Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { contact?: { id?: string; locationId?: string; name?: string; firstName?: string; lastName?: string; email?: string; phone?: string } };
    const c = json.contact;
    if (!c || c.id !== contactId) return null;
    if (c.locationId && c.locationId !== mapping.locationId) return null;
    return { id: c.id, name: (c.name ?? [c.firstName, c.lastName].filter(Boolean).join(" ")).trim(), email: c.email ?? null, phone: c.phone ?? null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** GoHighLevel's published webhook verification key (public material). It can be replaced when GoHighLevel rotates it. */
const GHL_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

export type GhlWebhookCheck = { ok: true; webhookId: string; payload: Record<string, unknown> } | { ok: false; reason: "signature" | "malformed" | "stale" };

/**
 * Verifies a GoHighLevel webhook: RSA-SHA256 over the raw body with GoHighLevel's public key, plus a freshness window on
 * the payload timestamp. Duplicate `webhookId`s are rejected by the caller's receipt table.
 */
export function verifyGhlWebhook(input: { rawBody: string; signature: string | null; now?: number; toleranceSeconds?: number; publicKey?: string }): GhlWebhookCheck {
  if (!input.signature) return { ok: false, reason: "signature" };
  const key = input.publicKey ?? env().GHL_WEBHOOK_PUBLIC_KEY ?? GHL_PUBLIC_KEY;
  let valid = false;
  try {
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(input.rawBody);
    verifier.end();
    valid = verifier.verify(key.replace(/\\n/g, "\n"), input.signature, "base64");
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature" };
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { ok: false, reason: "malformed" };
  const p = payload as Record<string, unknown>;
  const webhookId = typeof p.webhookId === "string" ? p.webhookId : null;
  const stamp = typeof p.timestamp === "string" ? Date.parse(p.timestamp) : NaN;
  if (!webhookId || Number.isNaN(stamp)) return { ok: false, reason: "malformed" };
  if (Math.abs((input.now ?? Date.now()) - stamp) > (input.toleranceSeconds ?? 300) * 1000) return { ok: false, reason: "stale" };
  return { ok: true, webhookId, payload: p };
}

export interface GhlMessageEvent {
  kind: "inbound" | "outbound";
  locationId: string;
  contactId: string;
  conversationId: string | null;
  messageId: string;
  channel: Channel | null;
  body: string;
  status: string | null;
  occurredAt: Date;
  attachments: string[];
}

const CHANNEL_BY_TYPE: Record<string, Channel> = { sms: "sms", email: "email", whatsapp: "whatsapp", type_sms: "sms", type_email: "email", type_whatsapp: "whatsapp" };

/** Narrows an Inbound/OutboundMessage payload to the fields the portal uses. Unknown channels yield `channel: null`. */
export function parseGhlMessageEvent(payload: Record<string, unknown>): GhlMessageEvent | null {
  const type = payload.type;
  if (type !== "InboundMessage" && type !== "OutboundMessage") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const locationId = str(payload.locationId);
  const contactId = str(payload.contactId);
  const messageId = str(payload.messageId);
  if (!locationId || !contactId || !messageId) return null;
  const channelKey = (str(payload.messageType) ?? str(payload.channel) ?? "").toLowerCase().replace(/^type_/, "");
  const when = str(payload.dateAdded) ? Date.parse(str(payload.dateAdded) as string) : NaN;
  return {
    kind: type === "InboundMessage" ? "inbound" : "outbound",
    locationId,
    contactId,
    conversationId: str(payload.conversationId),
    messageId,
    channel: CHANNEL_BY_TYPE[channelKey] ?? null,
    body: (str(payload.body) ?? "").slice(0, 5000),
    status: str(payload.status),
    occurredAt: Number.isNaN(when) ? new Date() : new Date(when),
    attachments: Array.isArray(payload.attachments) ? payload.attachments.filter((a): a is string => typeof a === "string").slice(0, 10) : [],
  };
}
