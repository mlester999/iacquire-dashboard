import type { CallClass } from "@/lib/missed-calls/state";

// Is this call a missed call, and which kind? A pure function of what the provider reported (and the workspace's own threshold), so the same
// record always gets the same answer and a late correction from the provider simply gives a new one.
//
// Not missed, whatever the status: outbound calls (an unanswered outbound call is the team's own attempt, not a customer who was missed), calls
// that are still ringing or in progress (not decided yet), calls that were answered and had a conversation, and calls that were answered and
// transferred (answered elsewhere). Nothing is guessed: a call whose duration the provider never reported is treated as answered, because
// "we cannot prove this caller was missed" must never start an outreach.

export interface CallFacts {
  direction: "inbound" | "outbound";
  status: "ringing" | "in_progress" | "completed" | "no_answer" | "busy" | "failed" | "voicemail" | "cancelled";
  durationSeconds: number | null;
  /** The provider's own reason the call ended (Vapi endedReason, Retell disconnection_reason), or the outcome a person chose for a logged call. */
  disposition: string | null;
  /** The team or the provider kept something said on the call (a summary or a transcript reference). */
  hasContent: boolean;
}

export type Classification =
  | { missed: true; class: CallClass; providerConfirmed: boolean; reason: string }
  | { missed: false; reason: NotMissedReason };

export type NotMissedReason = "outbound" | "not_final" | "answered" | "answered_elsewhere" | "unproven";

/** Reasons a provider gives when a call that did connect still ended with nobody able to help: the caller said nothing or never joined. */
const ABANDON_REASONS = /(silence|did-not-give-microphone|no-audio|customer-did-not-speak|user_hangup_before|user-never-spoke)/i;
/** A completed inbound call that ended in a hand-off to a person or another number was answered elsewhere. */
const TRANSFER_REASONS = /(transfer|forward(ed|ing)?[-_. ]?(success|completed|answered)|handoff|warm[-_. ]transfer|cold[-_. ]transfer|assistant-forwarded-call)/i;

export function classifyCall(call: CallFacts, opts: { abandonedMaxSeconds: number }): Classification {
  if (call.direction === "outbound") return { missed: false, reason: "outbound" };
  const disposition = call.disposition ?? "";
  switch (call.status) {
    case "ringing":
    case "in_progress":
      return { missed: false, reason: "not_final" };
    case "no_answer":
      return { missed: true, class: "ring_no_answer", providerConfirmed: true, reason: "The provider reported no answer." };
    case "voicemail":
      return { missed: true, class: "voicemail", providerConfirmed: true, reason: "The caller reached voicemail." };
    case "busy":
      return { missed: true, class: "busy", providerConfirmed: true, reason: "The provider reported a busy line." };
    case "cancelled":
      // An inbound call cancelled before it was answered: the caller gave up.
      return { missed: true, class: "abandoned", providerConfirmed: true, reason: "The caller hung up before the call was answered." };
    case "failed":
      return { missed: true, class: "provider_failed", providerConfirmed: true, reason: "The call failed to connect, so the caller never reached anyone." };
    case "completed": {
      if (TRANSFER_REASONS.test(disposition)) return { missed: false, reason: "answered_elsewhere" };
      const seconds = call.durationSeconds;
      if (seconds === null) return { missed: false, reason: "unproven" };
      if (ABANDON_REASONS.test(disposition) && seconds <= Math.max(opts.abandonedMaxSeconds, 30) && !call.hasContent) {
        return { missed: true, class: "abandoned", providerConfirmed: true, reason: "The call connected but nobody spoke before it ended." };
      }
      if (seconds <= opts.abandonedMaxSeconds && !call.hasContent) {
        return { missed: true, class: "abandoned", providerConfirmed: false, reason: `The caller hung up within ${opts.abandonedMaxSeconds} seconds with nothing said.` };
      }
      return { missed: false, reason: "answered" };
    }
  }
}

export const NOT_MISSED_LABELS: Record<NotMissedReason, string> = {
  outbound: "An outbound call is never a missed customer",
  not_final: "The call is still in progress",
  answered: "The call was answered",
  answered_elsewhere: "The call was answered by a person or another number",
  unproven: "The provider did not say how long the call lasted, so it is not treated as missed",
};
