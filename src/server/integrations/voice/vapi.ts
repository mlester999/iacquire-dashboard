import "server-only";
import crypto from "node:crypto";
import { AppError } from "@/server/errors";
import { encodeCredentialSecret, parseCredentialSecret } from "@/server/security/credentials";
import {
  clampSeconds, e164, httpsUrl, isoDate, obj, plainText, providerId, safeEqual, secondsBetween, SIGNATURE_TOLERANCE_MS,
  type CallStatus, type HeaderSource, type ParsedVoiceEvent, type VerifyResult,
} from "@/server/integrations/voice/types";

// Vapi server messages ("Server URL" webhooks). Checked on 2026-10-16 against Vapi's own documentation and TypeScript SDK
// (docs.vapi.ai/server-url/server-authentication, docs.vapi.ai/server-url/events, github.com/VapiAI/server-sdk-typescript
// src/api/types: ServerMessage, ServerMessageEndOfCallReport, ServerMessageStatusUpdate, Call, Artifact, Analysis, BearerAuthenticationPlan,
// HmacAuthenticationPlan). What we rely on:
//
//  * Every message is POSTed as { "message": { "type": …, "call": { Call }, … } }.
//  * "end-of-call-report" is sent when the call ends and post-processing is complete: endedReason, startedAt / endedAt (ISO 8601),
//    analysis.summary, artifact.recordingUrl (also artifact.recording.mono.combinedUrl) and artifact.transcript, plus call, customer and
//    phoneNumber. "status-update" carries status: scheduled | queued | ringing | in-progress | forwarding | ended (with endedReason).
//  * Call: id, type (inboundPhoneCall | outboundPhoneCall | webCall | vapi.websocketCall), assistantId, phoneNumberId, customer.number.
//  * Authentication is a credential the Vapi org attaches to its saved assistant / phone number / Server Configuration:
//      - Bearer Token: "Authorization: Bearer <token>" by default (header name and prefix are configurable);
//      - the legacy X-Vapi-Secret header (a Bearer Token credential with header X-Vapi-Secret and no prefix);
//      - HMAC: signature header default "x-signature", timestamp header default "x-timestamp", payload format default
//        "{timestamp}.{body}", encoding default hex, algorithm chosen (we accept sha256 only).
//    Vapi does NOT attach the credential when the server URL comes from the API request itself (a transient assistant or
//    assistantOverrides), so such calls are refused here: only saved assistants / phone numbers can report calls.
//  * Bearer and X-Vapi-Secret carry no timestamp, so replays are stopped by webhook_receipts (one row per call and event); HMAC requests
//    must also be fresh (within five minutes).

export const VAPI_AUTH_MODES = ["bearer", "x-vapi-secret", "hmac"] as const;
export type VapiAuthMode = (typeof VAPI_AUTH_MODES)[number];
export const VAPI_AUTH_LABELS: Record<VapiAuthMode, string> = {
  bearer: "Bearer token (Authorization header)",
  "x-vapi-secret": "X-Vapi-Secret header (legacy secret)",
  hmac: "HMAC-SHA256 signature (x-signature, x-timestamp)",
};
export const isVapiAuthMode = (v: unknown): v is VapiAuthMode => typeof v === "string" && (VAPI_AUTH_MODES as readonly string[]).includes(v);

export interface VapiSecret {
  mode: VapiAuthMode;
  secret: string;
}

/** The vault value for a Vapi connection: how Vapi authenticates and the shared secret, as one JSON string. */
export function encodeVapiSecret(s: VapiSecret): string {
  if (!isVapiAuthMode(s.mode)) throw new AppError("invalid_input", "Choose how Vapi authenticates its requests.");
  const secret = (s.secret ?? "").trim();
  if (secret.length < 16 || secret.length > 2000 || /\s/.test(secret)) throw new AppError("invalid_input", "Enter the secret exactly as it is in the Vapi credential (at least 16 characters, no spaces).");
  return encodeCredentialSecret({ mode: s.mode, secret });
}

export function parseVapiSecret(raw: string | null | undefined): VapiSecret | null {
  const p = parseCredentialSecret(raw, ["mode", "secret"] as const);
  return p && isVapiAuthMode(p.mode) ? { mode: p.mode, secret: p.secret } : null;
}

/** The HMAC Vapi computes with its default HMAC plan: hex sha256 over "{timestamp}.{body}". Exported for tests and the setup notes. */
export function vapiHmacSignature(secret: string, timestamp: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** Vapi's timestamp header as milliseconds. Seconds and milliseconds are both accepted (the documentation doesn't fix the unit). */
function timestampMs(raw: string): number | null {
  if (!/^\d{9,16}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Checks that a request comes from the Vapi org that holds this workspace's credential. The comparison is constant-time; a missing header
 * and a wrong value are both refused.
 */
export function verifyVapiRequest(input: { headers: HeaderSource; rawBody: string; secret: VapiSecret; now?: number }): VerifyResult {
  const { headers, secret } = input;
  if (secret.mode === "bearer") {
    const h = headers.get("authorization");
    if (!h) return { ok: false, reason: "missing" };
    const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
    if (!m) return { ok: false, reason: "malformed" };
    return safeEqual(m[1], secret.secret) ? { ok: true } : { ok: false, reason: "signature" };
  }
  if (secret.mode === "x-vapi-secret") {
    const h = headers.get("x-vapi-secret");
    if (!h) return { ok: false, reason: "missing" };
    return safeEqual(h.trim(), secret.secret) ? { ok: true } : { ok: false, reason: "signature" };
  }
  const sig = headers.get("x-signature");
  const ts = headers.get("x-timestamp");
  if (!sig || !ts) return { ok: false, reason: "missing" };
  const at = timestampMs(ts.trim());
  const digest = sig.trim().replace(/^sha256=/i, "");
  if (at === null || !/^[0-9a-f]{64}$/i.test(digest)) return { ok: false, reason: "malformed" };
  if (Math.abs((input.now ?? Date.now()) - at) > SIGNATURE_TOLERANCE_MS) return { ok: false, reason: "stale" };
  return safeEqual(digest.toLowerCase(), vapiHmacSignature(secret.secret, ts.trim(), input.rawBody)) ? { ok: true } : { ok: false, reason: "signature" };
}

const NO_ANSWER = new Set(["customer-did-not-answer", "call.forwarding.no-answer"]);
const BUSY = new Set(["customer-busy", "call.forwarding.operator-busy"]);
const CANCELLED = new Set(["manually-canceled", "scheduled-call-deleted", "call-deleted"]);
const FAILED = new Set([
  "assistant-not-found", "assistant-not-valid", "assistant-join-timed-out", "vonage-rejected", "vonage-failed-to-connect-call", "twilio-failed-to-connect-call",
  "twilio-reported-customer-misdialed", "sip-outbound-unallocated-number", "sip-outbound-carrier-released-call", "phone-call-provider-bypass-enabled-but-no-call-received",
  "call-start-error-neither-assistant-nor-server-set", "worker-shutdown",
]);

/**
 * A Vapi endedReason as a call status. Errors and failures to connect are "failed"; voicemail, busy, no answer and cancellations are their
 * own statuses; any other reason on a call that started (the assistant or the customer hung up, silence, the maximum duration, a transfer)
 * is "completed". A call that never started and ended for a reason not listed here is "failed", never "completed".
 */
export function vapiStatusFor(endedReason: string | null, started: boolean): CallStatus {
  const r = (endedReason ?? "").toLowerCase();
  if (r === "voicemail") return "voicemail";
  if (NO_ANSWER.has(r)) return "no_answer";
  if (BUSY.has(r)) return "busy";
  if (CANCELLED.has(r)) return "cancelled";
  if (FAILED.has(r) || r.startsWith("assistant-request") || r.startsWith("pipeline-error") || r.includes("error") || r.includes("failed") || r.includes("fault")) return "failed";
  return started ? "completed" : "failed";
}

/** The assistant and phone-number ids on a Vapi message: the only things that say which workspace a call belongs to. */
export function vapiExternalIds(message: Record<string, unknown>): string[] {
  const call = obj(message.call) ?? {};
  const ids = [call.assistantId, obj(message.assistant)?.id, call.phoneNumberId, obj(message.phoneNumber)?.id].map((v) => providerId(v, 120)).filter((v): v is string => !!v);
  return [...new Set(ids)];
}

/**
 * A Vapi server message as a call event, or why it is ignored. Only "status-update" and "end-of-call-report" are recorded; tool calls,
 * transcripts, speech updates and the rest are not call activity (point only these two at iAcquire with assistant.serverMessages).
 */
export function parseVapiEvent(payload: unknown): ParsedVoiceEvent {
  const message = obj(obj(payload)?.message);
  const type = typeof message?.type === "string" ? message.type.slice(0, 80) : "";
  if (!message || !type) return { kind: "ignored", eventType: "", reason: "The body isn't a Vapi server message." };
  if (type !== "status-update" && type !== "end-of-call-report") return { kind: "ignored", eventType: type, reason: `Vapi "${type}" messages aren't call activity.` };
  const call = obj(message.call) ?? {};
  const callId = providerId(call.id);
  if (!callId) return { kind: "ignored", eventType: type, reason: "The message has no call id." };
  const callType = typeof call.type === "string" ? call.type : "";
  const direction = callType === "outboundPhoneCall" ? "outbound" : "inbound";
  const customer = obj(message.customer) ?? obj(call.customer) ?? {};
  const phone = obj(message.phoneNumber) ?? obj(call.phoneNumber) ?? {};
  const startedAt = isoDate(message.startedAt) ?? isoDate(call.startedAt);
  const endedAt = isoDate(message.endedAt) ?? isoDate(call.endedAt);
  const endedReason = plainText(message.endedReason, 60) ?? plainText(call.endedReason, 60);
  const artifact = obj(message.artifact) ?? obj(call.artifact) ?? {};
  const recording = obj(artifact.recording);
  const analysis = obj(message.analysis) ?? obj(call.analysis) ?? {};

  let status: CallStatus;
  let final: boolean;
  let receiptKey: string;
  if (type === "status-update") {
    const s = typeof message.status === "string" ? message.status : "";
    if (s === "ended") {
      status = vapiStatusFor(endedReason, !!startedAt);
      final = true;
    } else if (s === "in-progress" || s === "forwarding") {
      status = "in_progress";
      final = false;
    } else if (s === "ringing" || s === "queued" || s === "scheduled") {
      status = "ringing";
      final = false;
    } else {
      return { kind: "ignored", eventType: type, reason: `Vapi status "${s || "(none)"}" isn't recorded.` };
    }
    receiptKey = `${callId}:status-update:${s}`;
  } else {
    status = vapiStatusFor(endedReason, !!startedAt);
    final = true;
    receiptKey = `${callId}:end-of-call-report`;
  }
  const transcript = typeof artifact.transcript === "string" ? artifact.transcript : typeof message.transcript === "string" ? message.transcript : "";
  return {
    kind: "call",
    event: {
      provider: "vapi",
      eventType: type,
      receiptKey,
      callId,
      externalIds: vapiExternalIds(message),
      direction,
      status,
      final,
      customerNumber: e164(customer.number),
      businessNumber: e164(phone.number),
      startedAt,
      endedAt,
      durationSeconds: secondsBetween(startedAt, endedAt) ?? clampSeconds(message.durationSeconds),
      disposition: endedReason,
      summary: plainText(analysis.summary, 4000) ?? plainText(message.summary, 4000),
      recordingUrl: httpsUrl(artifact.recordingUrl) ?? httpsUrl(obj(recording?.mono)?.combinedUrl) ?? httpsUrl(artifact.stereoRecordingUrl) ?? httpsUrl(message.recordingUrl),
      hasTranscript: transcript.trim().length > 0,
    },
  };
}
