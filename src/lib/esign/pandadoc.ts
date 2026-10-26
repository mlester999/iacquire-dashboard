// What iAcquire knows about PandaDoc's wire format, as pure functions. Only server code and tests import this file (it needs Node's crypto).
//
// UNEXERCISED, AND FROM MEMORY. No network was available when this was written and no PandaDoc account exists for this deployment, so nothing here has ever been checked against
// the real service: the status names, the shape of a webhook, the way it is signed and the event names are what the audit (docs/roadmap/phases-3-to-7/audit/5ab-proposals-esign.md)
// and the author remember of PandaDoc's public API reference. Every one must be re-read against PandaDoc's CURRENT documentation, and then tried in PandaDoc's sandbox, before this
// adapter is switched on for anyone. Where the reference was not remembered with confidence, the code says so beside the line and takes the cautious reading (an unknown status or
// event changes nothing).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderFact } from "@/lib/esign/state";
import { sha256Hex } from "@/lib/proposals/hash";

export const PANDADOC_ORIGIN = "https://api.pandadoc.com";
export const PANDADOC_LABEL = "PandaDoc";

/** A PandaDoc status in our terms. "draft" is a document PandaDoc holds but has not sent. null is a status this adapter does not understand, which changes nothing. */
export type PandaDocReading = ProviderFact | "draft" | null;

// UNVERIFIED: the "document.*" names. Statuses of PandaDoc's own approval and payment flows (waiting_approval, approved, rejected, waiting_pay, paid) are deliberately not mapped:
// iAcquire does not use those flows, so a document in one of them is something the business did in PandaDoc, not a fact about the signature.
const STATUS_READINGS: Record<string, PandaDocReading> = {
  "document.uploaded": "draft",
  "document.draft": "draft",
  "document.sent": "sent",
  "document.viewed": "viewed",
  "document.completed": "completed",
  "document.declined": "declined",
  "document.expired": "expired",
  "document.voided": "voided",
};

export function readPandaDocStatus(status: unknown): PandaDocReading {
  return typeof status === "string" && Object.hasOwn(STATUS_READINGS, status) ? STATUS_READINGS[status] : null;
}

const DOCUMENT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
export const isPandaDocId = (v: unknown): v is string => typeof v === "string" && DOCUMENT_ID_RE.test(v);

export interface WebhookEvent {
  /** The event's name at PandaDoc, kept short for the history. */
  name: string;
  documentId: string;
  /** The status the event carries, when it carries one. */
  status: string | null;
  /** The event in our terms; null for an event that is not a statement about the document's state (it is recorded and changes nothing). */
  fact: ProviderFact | null;
  /** Stable for the same delivery: a replay of the same body names the same id, so the history keeps one row for it. */
  eventId: string;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

/**
 * The events in a delivery's body. UNVERIFIED shape: a JSON array of { event, data: { id, status, date_modified } } (a single object is read too). Anything that is not that is
 * refused as a whole, so a malformed body records nothing. Only document_state_changed makes a statement about the document's state; other events are recorded and ignored.
 * The id of an event is made from what it says (name, document, status and the time PandaDoc stamped), because the remembered payload has no id of its own.
 */
export function parseWebhookBody(raw: Buffer | string): WebhookEvent[] | null {
  let json: unknown;
  try {
    json = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return null;
  }
  const items = Array.isArray(json) ? json : [json];
  if (items.length === 0 || items.length > 50) return null;
  const out: WebhookEvent[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const name = str((item as { event?: unknown }).event, 60);
    const data = (item as { data?: unknown }).data;
    if (!name || !data || typeof data !== "object") return null;
    const id = (data as { id?: unknown }).id;
    if (!isPandaDocId(id)) return null;
    const status = str((data as { status?: unknown }).status, 60);
    const stamp = str((data as { date_modified?: unknown }).date_modified, 40) ?? str((data as { date_completed?: unknown }).date_completed, 40) ?? "";
    const reading = name === "document_state_changed" ? readPandaDocStatus(status) : null;
    out.push({
      name, documentId: id, status, fact: reading && reading !== "draft" ? reading : null,
      eventId: `pd:${sha256Hex(`${name}|${id}|${status ?? ""}|${stamp}`).slice(0, 40)}`,
    });
  }
  return out;
}

/**
 * Checks a delivery's signature. UNVERIFIED: PandaDoc is remembered to sign the raw request body with HMAC-SHA256 under the shared key shown when the webhook is set up, and to
 * send the lowercase hex digest in a `signature` query parameter of the webhook address. The comparison is constant-time, over the exact bytes received.
 */
export function pandaDocSignatureValid(rawBody: Buffer, provided: string | null | undefined, sharedKey: string): boolean {
  if (!provided || !sharedKey || !/^[0-9a-fA-F]{64}$/.test(provided)) return false;
  const expected = createHmac("sha256", sharedKey).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(provided, "hex"));
}

/** The name the document carries at the signing service (the signer sees it): the proposal, its version and a short reference that lets a lost answer be matched. */
export function documentName(number: string, version: number, requestId: string): string {
  return `Proposal ${number} (version ${version}) ref ${requestId.replace(/-/g, "").slice(0, 8)}`;
}

/** The reference inside a document name, for matching a document to its request after a lost answer. */
export const referenceOf = (requestId: string): string => `ref ${requestId.replace(/-/g, "").slice(0, 8)}`;

export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}
