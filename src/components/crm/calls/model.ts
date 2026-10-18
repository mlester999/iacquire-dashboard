// Pure labels for the call screens (CRM → Calls and the Calls section of a contact). No I/O and no "use client", so server views,
// client components and tests share them. The rules live in src/server/crm/calls.ts.

export type CallStatusKey = "ringing" | "in_progress" | "completed" | "no_answer" | "busy" | "failed" | "voicemail" | "cancelled";
export type CallProviderKey = "vapi" | "retell" | "manual";
export type ConsentKey = "unknown" | "announced" | "granted" | "not_recorded";

export const CALL_STATUS_LABELS: Record<CallStatusKey, string> = {
  ringing: "Ringing", in_progress: "In progress", completed: "Completed", no_answer: "No answer", busy: "Busy", failed: "Failed", voicemail: "Voicemail", cancelled: "Cancelled",
};
export const CALL_STATUS_TONES: Record<CallStatusKey, "neutral" | "primary" | "success" | "warning" | "danger" | "violet"> = {
  ringing: "violet", in_progress: "violet", completed: "success", no_answer: "warning", busy: "warning", failed: "danger", voicemail: "neutral", cancelled: "neutral",
};
export const CALL_PROVIDER_LABELS: Record<CallProviderKey, string> = { vapi: "Vapi", retell: "Retell AI", manual: "Logged by the team" };
export const CONSENT_LABELS: Record<ConsentKey, string> = {
  unknown: "Not known", announced: "Caller was told the call is recorded", granted: "Caller agreed to recording", not_recorded: "Not recorded",
};
export const MANUAL_STATUSES: CallStatusKey[] = ["completed", "no_answer", "busy", "voicemail", "failed"];

/** "3 min 12 s", "45 s", or "" when unknown. */
export function durationLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m} min${s ? ` ${s} s` : ""}` : `${s} s`;
}

const DISPOSITIONS: Record<string, string> = {
  "customer-ended-call": "Caller hung up", "assistant-ended-call": "Assistant ended the call", "assistant-said-end-call-phrase": "Assistant ended the call",
  "assistant-forwarded-call": "Forwarded", "silence-timed-out": "Silence timeout", "exceeded-max-duration": "Reached the time limit", voicemail: "Voicemail",
  "customer-did-not-answer": "No answer", "customer-busy": "Busy", "manually-canceled": "Cancelled",
  user_hangup: "Caller hung up", agent_hangup: "Agent ended the call", call_transfer: "Transferred", voicemail_reached: "Voicemail", inactivity: "Inactivity",
  max_duration_reached: "Reached the time limit", dial_no_answer: "No answer", dial_busy: "Busy", dial_failed: "Couldn't connect", user_declined: "Declined",
  user_requested_dnc: "Asked not to be called", user_requested_callback: "Asked for a call back", ivr_reached: "Reached a phone menu", transfer_bridged: "Transferred",
};

/** A provider's ended reason in words: known ones translated, others with their dashes and underscores turned into spaces. */
export function dispositionLabel(d: string | null | undefined): string {
  if (!d) return "";
  const known = DISPOSITIONS[d];
  if (known) return known;
  const words = d.replace(/[-_.]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}
