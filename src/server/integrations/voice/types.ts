import "server-only";
import crypto from "node:crypto";

// What every voice provider adapter turns its webhook into, and the small, pure helpers they share. Nothing here reads the database or
// calls a provider: the adapters (vapi.ts, retell.ts) parse and verify, and the webhook handler (handler.ts) resolves the workspace and
// records the call through src/server/crm/calls.ts.

export type VoiceProvider = "vapi" | "retell";
export const VOICE_PROVIDERS: readonly VoiceProvider[] = ["vapi", "retell"];
export const VOICE_PROVIDER_LABELS: Record<VoiceProvider, string> = { vapi: "Vapi", retell: "Retell AI" };
export const isVoiceProvider = (v: unknown): v is VoiceProvider => v === "vapi" || v === "retell";

/** crm_call_records.status. */
export const CALL_STATUSES = ["ringing", "in_progress", "completed", "no_answer", "busy", "failed", "voicemail", "cancelled"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];
export const isCallStatus = (v: unknown): v is CallStatus => typeof v === "string" && (CALL_STATUSES as readonly string[]).includes(v);
/** Statuses that mean the call is over. A call record that reaches one emits `call.completed` once. */
export const FINAL_CALL_STATUSES: readonly CallStatus[] = ["completed", "no_answer", "busy", "failed", "voicemail", "cancelled"];
export const isFinalCallStatus = (s: CallStatus) => (FINAL_CALL_STATUSES as readonly string[]).includes(s);

/** One call event, in the shape the call service records. Every value came from the provider's own (verified) request. */
export interface VoiceCallEvent {
  provider: VoiceProvider;
  /** The provider's own event type: "status-update", "end-of-call-report", "call_started", "call_ended", "call_analyzed". */
  eventType: string;
  /** Identifies this one logical event of this one call, so a redelivery or replay is recognised (webhook_receipts, prefixed with the workspace id). */
  receiptKey: string;
  /** The provider's call id (crm_call_records.provider_call_id). */
  callId: string;
  /** The assistant / agent / phone-number ids on the call, used only to find the workspace (crm_voice_connections.external_ids). */
  externalIds: string[];
  direction: "inbound" | "outbound";
  status: CallStatus;
  /** The call is over: this event can complete the record. */
  final: boolean;
  /** The customer's number in E.164, or null (a web call, a SIP address, a withheld number). Contacts are matched on exactly this. */
  customerNumber: string | null;
  /** The business's own number on the call, in E.164, or null. */
  businessNumber: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  /** The provider's reason the call ended, as it sent it (Vapi endedReason, Retell disconnection_reason). */
  disposition: string | null;
  /** The provider's post-call summary, when it made one. */
  summary: string | null;
  /** An https link to the provider-hosted recording, when the provider recorded the call. Kept only when the workspace opted in. */
  recordingUrl: string | null;
  /** The provider holds a transcript for this call. Only a reference to it is ever kept, never the text. */
  hasTranscript: boolean;
}

export type ParsedVoiceEvent = { kind: "call"; event: VoiceCallEvent } | { kind: "ignored"; eventType: string; reason: string };

/** Header access the adapters need: a fetch Headers object, or a plain record in tests. */
export interface HeaderSource {
  get(name: string): string | null;
}

export const headersFrom = (h: Record<string, string>): HeaderSource => {
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
};

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "malformed" | "signature" | "stale" };

/** How far a signed timestamp may be from our clock (both directions), as Retell documents and as we apply to Vapi's HMAC timestamp. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Constant-time comparison of two secrets or digests of any length: both sides are hashed first, so neither the length nor the first
 * differing character is revealed by timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(a, "utf8").digest();
  const y = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(x, y);
}

export const E164 = /^\+[1-9][0-9]{6,14}$/;

/** A phone number exactly as E.164, or null. Nothing is guessed: a number without "+" and a country code is not matched to anyone. */
export function e164(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return E164.test(s) ? s : null;
}

/** An https link of at most `max` characters, without credentials, or null. */
export function httpsUrl(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > max || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
    return s;
  } catch {
    return null;
  }
}

/** An ISO-8601 instant, or null. */
export function isoDate(v: unknown): Date | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Milliseconds since the epoch (a number), or null. */
export function msDate(v: unknown): Date | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 8.64e15) return null;
  return new Date(v);
}

/** Seconds between two instants, rounded, within the record's limits (0 to 24 hours), or null. */
export function secondsBetween(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  const s = Math.round((end.getTime() - start.getTime()) / 1000);
  return s >= 0 && s <= 86_400 ? s : null;
}

export function clampSeconds(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const s = Math.round(v);
  return s >= 0 && s <= 86_400 ? s : null;
}

/** A provider id (call, assistant, agent, phone number): printable, without spaces, within the column limit. */
export function providerId(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= max && /^[\x21-\x7e]+$/.test(s) ? s : null;
}

/** Plain text from the provider, stripped of control characters, at most `max` characters, or null when empty. */
export function plainText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return s ? s.slice(0, max) : null;
}

export const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
