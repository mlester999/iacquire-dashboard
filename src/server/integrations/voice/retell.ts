import "server-only";
import crypto from "node:crypto";
import { AppError } from "@/server/errors";
import { encodeCredentialSecret, parseCredentialSecret } from "@/server/security/credentials";
import {
  clampSeconds, e164, httpsUrl, msDate, obj, plainText, providerId, safeEqual, secondsBetween, SIGNATURE_TOLERANCE_MS,
  type CallStatus, type ParsedVoiceEvent, type VerifyResult,
} from "@/server/integrations/voice/types";

// Retell AI webhooks. Checked on 2026-10-16 against Retell's own documentation and SDK (docs.retellai.com/features/webhook-overview,
// docs.retellai.com/features/secure-webhook, docs.retellai.com/api-references/get-call, github.com/RetellAI/retell-typescript-sdk
// src/lib/webhook_auth.ts and tests/webhook-auth.test.ts). What we rely on:
//
//  * The body is { "event": "call_started" | "call_ended" | "call_analyzed" | "transcript_updated" | "transfer_…", "call": { call object } }.
//    call_started is not sent when the call never connected (dial_failed, dial_no_answer, dial_busy); call_ended and call_analyzed are.
//    Events are sent in order but not blocking, and a delivery without a 2xx within 10 seconds is retried up to 3 times.
//  * The call object: call_id, agent_id, call_type (phone_call | web_call), direction (inbound | outbound, phone calls), from_number,
//    to_number, call_status (registered | not_connected | ongoing | ended | error), start_timestamp / end_timestamp / duration_ms
//    (milliseconds), disconnection_reason, recording_url, transcript, and on call_analyzed call_analysis.call_summary / in_voicemail.
//  * X-Retell-Signature is "v=<unix ms>,d=<hex HMAC-SHA256 of raw body + timestamp>" keyed with the workspace's Retell API key (the key
//    that has the webhook badge). The timestamp must be within five minutes. The SDK's own test vector (body {"event":"call_ended"}, key
//    test-api-key, timestamp 1700000000000, digest 07024cab…823e) is pinned in tests/crm-calls.test.ts.

export interface RetellSecret {
  apiKey: string;
}

export function encodeRetellSecret(apiKey: string): string {
  const key = (apiKey ?? "").trim();
  if (key.length < 16 || key.length > 500 || /\s/.test(key)) throw new AppError("invalid_input", "Enter the Retell API key that has the webhook badge (at least 16 characters, no spaces).");
  return encodeCredentialSecret({ apiKey: key });
}

export function parseRetellSecret(raw: string | null | undefined): RetellSecret | null {
  const p = parseCredentialSecret(raw, ["apiKey"] as const);
  return p ? { apiKey: p.apiKey } : null;
}

/** The X-Retell-Signature value Retell sends for a body at a timestamp (milliseconds). Exported for tests and the setup notes. */
export function signRetell(rawBody: string, apiKey: string, timestampMs: number): string {
  return `v=${timestampMs},d=${crypto.createHmac("sha256", apiKey).update(rawBody + String(timestampMs), "utf8").digest("hex")}`;
}

/** Verifies X-Retell-Signature exactly as Retell documents it: strict format, five-minute window, constant-time digest comparison. */
export function verifyRetellSignature(input: { rawBody: string; apiKey: string; header: string | null; now?: number }): VerifyResult {
  if (!input.header) return { ok: false, reason: "missing" };
  const m = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(input.header.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const ts = Number(m[1]);
  if (!Number.isSafeInteger(ts)) return { ok: false, reason: "malformed" };
  if (Math.abs((input.now ?? Date.now()) - ts) > SIGNATURE_TOLERANCE_MS) return { ok: false, reason: "stale" };
  const expected = crypto.createHmac("sha256", input.apiKey).update(input.rawBody + m[1], "utf8").digest("hex");
  return safeEqual(m[2].toLowerCase(), expected) ? { ok: true } : { ok: false, reason: "signature" };
}

const NO_ANSWER = new Set(["dial_no_answer"]);
const BUSY = new Set(["dial_busy", "user_declined"]);
const VOICEMAIL = new Set(["voicemail_reached"]);
const CANCELLED = new Set(["manual_stopped"]);
const FAILED = new Set([
  "dial_failed", "invalid_destination", "telephony_provider_permission_denied", "telephony_provider_unavailable", "sip_routing_error", "marked_as_spam",
  "network_blocked", "concurrency_limit_reached", "no_concurrency_fallback", "no_valid_payment", "credit_exhausted", "budget_reached", "scam_detected",
  "registered_call_timeout",
]);

/**
 * A finished Retell call's status from its call_status, disconnection_reason and (after analysis) in_voicemail. Errors and failures to
 * connect are "failed"; the person declining or the line being busy is "busy"; any other way a connected call ended (either side hung up,
 * a transfer, inactivity, the maximum duration, an IVR) is "completed".
 */
export function retellStatusFor(callStatus: string | null, reason: string | null, inVoicemail: boolean): CallStatus {
  const r = (reason ?? "").toLowerCase();
  if (inVoicemail || VOICEMAIL.has(r)) return "voicemail";
  if (NO_ANSWER.has(r)) return "no_answer";
  if (BUSY.has(r)) return "busy";
  if (CANCELLED.has(r)) return "cancelled";
  if (FAILED.has(r) || r.startsWith("error_")) return "failed";
  if (callStatus === "error" || callStatus === "not_connected") return "failed";
  return "completed";
}

/** A Retell webhook as a call event, or why it is ignored. Only call_started, call_ended and call_analyzed are call activity. */
export function parseRetellEvent(payload: unknown): ParsedVoiceEvent {
  const body = obj(payload);
  const event = typeof body?.event === "string" ? body.event.slice(0, 80) : "";
  if (!body || !event) return { kind: "ignored", eventType: "", reason: "The body isn't a Retell webhook." };
  if (event !== "call_started" && event !== "call_ended" && event !== "call_analyzed") return { kind: "ignored", eventType: event, reason: `Retell "${event}" events aren't recorded.` };
  const call = obj(body.call) ?? {};
  const callId = providerId(call.call_id);
  if (!callId) return { kind: "ignored", eventType: event, reason: "The event has no call id." };
  const agentId = providerId(call.agent_id, 120);
  const direction = call.direction === "outbound" ? "outbound" : "inbound";
  const from = e164(call.from_number);
  const to = e164(call.to_number);
  const startedAt = msDate(call.start_timestamp);
  const endedAt = msDate(call.end_timestamp);
  const analysis = obj(call.call_analysis) ?? {};
  const reason = plainText(call.disconnection_reason, 60);
  const final = event !== "call_started";
  const status: CallStatus = final ? retellStatusFor(typeof call.call_status === "string" ? call.call_status : null, reason, analysis.in_voicemail === true) : "in_progress";
  const durationMs = typeof call.duration_ms === "number" ? call.duration_ms / 1000 : null;
  return {
    kind: "call",
    event: {
      provider: "retell",
      eventType: event,
      receiptKey: `${callId}:${event}`,
      callId,
      externalIds: agentId ? [agentId] : [],
      direction,
      status,
      final,
      customerNumber: direction === "inbound" ? from : to,
      businessNumber: direction === "inbound" ? to : from,
      startedAt,
      endedAt,
      durationSeconds: clampSeconds(durationMs) ?? secondsBetween(startedAt, endedAt),
      disposition: reason,
      summary: plainText(analysis.call_summary, 4000),
      recordingUrl: httpsUrl(call.recording_url),
      hasTranscript: typeof call.transcript === "string" && call.transcript.trim().length > 0,
    },
  };
}
