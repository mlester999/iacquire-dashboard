import type { MissedCallPolicy, RecoveryChannel } from "@/lib/missed-calls/policy";
import { isFinishedState, type CallClass, type CaseState } from "@/lib/missed-calls/state";

// May the engine act on this case right now, and how? A pure function of facts the server has just read (src/server/missed-calls/facts.ts), so
// every rule has a direct test and the same facts always give the same answer. It decides; it never sends, and the send chain
// (evaluateSend: consent, opt-out, quiet hours, ownership fence, credits, provider switches) still has the last word on every text.
//
// Three separate questions, because they have different bars:
//   1. close:   is the case already settled (the caller was reached, booked, replied, or the call turns out to have been answered)?
//   2. team:    may the engine create the call-back task and the notice? (Needs only an open, unpaused case under an enabled policy.)
//   3. message: may it text or email the caller? (Needs every customer-protection rule to pass.)

export interface CaseFacts {
  state: CaseState;
  paused: boolean;
  attempts: number;
  lastAttemptAt: Date | null;
  firstCalledAt: Date;
  lastCalledAt: Date;
  callerNumber: string | null;
  afterHours: boolean;
  classification: CallClass;
  /** Calls in the case that still count as missed (a late correction can show one was answered after all). */
  countedCalls: number;
  ownerKind: "unassigned" | "human" | "ai";
}

export interface ChannelFacts {
  name: RecoveryChannel;
  /** The workspace's channel is set up and enabled (messaging_channels.enabled). */
  connected: boolean;
  /** The contact has a phone number (sms) or an email address (email) to use. */
  hasAddress: boolean;
  consent: "granted" | "unknown" | "revoked";
  suppressed: boolean;
}

export interface TimingFacts {
  /** The platform's own spacing between follow-up messages to one contact (messaging_policy), in minutes, and when the last one was sent (any automation). */
  platformGapMinutes: number;
  lastFollowUpSentAt: Date | null;
  quietHours: boolean;
  withinBusinessHours: boolean;
  /** The next moment outside quiet hours AND inside business hours. */
  nextOpen: Date | null;
  /** The next moment outside quiet hours (business hours ignored). */
  nextOutsideQuiet: Date | null;
}

export interface EligibilityFacts {
  now: Date;
  orgActive: boolean;
  policy: MissedCallPolicy;
  case: CaseFacts;
  contact: { deleted: boolean } | null;
  channels: ChannelFacts[];
  /** The owner of the contact's conversation on the channel that would be used, or null when there is no conversation yet. */
  conversationOwner: "ai" | "human" | "unassigned" | null;
  after: {
    /** The caller wrote to us after their last missed call. */
    customerReplied: boolean;
    /** A person called the caller back and the call was answered. */
    callbackCompleted: boolean;
    /** A person already texted or emailed the caller after the missed call. */
    personMessaged: boolean;
    /** An appointment was booked for the contact after the call, or one is upcoming. */
    appointmentBooked: boolean;
  };
  timing: TimingFacts;
}

export type RecoveredVia = "customer_reply" | "appointment_booked" | "callback_completed";
export type CloseDecision =
  | { to: "recovered"; via: RecoveredVia; reason: string }
  | { to: "canceled"; reason: string }
  | { to: "completed_without_recovery"; reason: string };

export type MessageBlock = { kind: "wait"; until: Date; reason: string } | { kind: "block"; reason: string; permanent: boolean };

export interface Eligibility {
  close: CloseDecision | null;
  team: { allowed: true } | { allowed: false; reason: string };
  message: { allowed: true; channel: RecoveryChannel; afterHoursWording: boolean; recordInboundCallConsent: boolean } | { allowed: false; block: MessageBlock };
  /** The attempt number the next message would be (1 for the first). */
  attemptNo: number;
}

const block = (reason: string, permanent: boolean): { allowed: false; block: MessageBlock } => ({ allowed: false, block: { kind: "block", reason, permanent } });
const wait = (until: Date, reason: string): { allowed: false; block: MessageBlock } => ({ allowed: false, block: { kind: "wait", until, reason } });

export function evaluateEligibility(f: EligibilityFacts): Eligibility {
  const { policy, now } = f;
  const attemptNo = f.case.attempts + 1;
  const done = (close: CloseDecision | null, team: Eligibility["team"], message: Eligibility["message"]): Eligibility => ({ close, team, message, attemptNo });

  if (isFinishedState(f.case.state)) return done(null, { allowed: false, reason: "case_finished" }, block("case_finished", true));

  // 1. Settled already? These win over everything: no rule below can make a settled case worth contacting.
  if (f.case.countedCalls === 0) {
    return done({ to: "canceled", reason: "answered_later" }, { allowed: false, reason: "answered_later" }, block("answered_later", true));
  }
  if (f.after.callbackCompleted) {
    return done({ to: "recovered", via: "callback_completed", reason: "A person called the caller back." }, { allowed: false, reason: "recovered" }, block("recovered", true));
  }
  if (f.after.customerReplied) {
    return done({ to: "recovered", via: "customer_reply", reason: "The caller wrote back." }, { allowed: false, reason: "recovered" }, block("recovered", true));
  }
  if (f.after.appointmentBooked) {
    return done({ to: "recovered", via: "appointment_booked", reason: "An appointment is booked for this contact." }, { allowed: false, reason: "recovered" }, block("recovered", true));
  }
  const expiresAt = f.case.firstCalledAt.getTime() + policy.caseExpiryHours * 3_600_000;
  if (now.getTime() >= expiresAt) {
    return done({ to: "completed_without_recovery", reason: "expired" }, { allowed: false, reason: "expired" }, block("expired", true));
  }

  // 2. The team actions.
  let team: Eligibility["team"] = { allowed: true };
  if (!f.orgActive) team = { allowed: false, reason: "workspace_inactive" };
  else if (!policy.enabled) team = { allowed: false, reason: "policy_off" };
  else if (!policy.classes.includes(f.case.classification)) team = { allowed: false, reason: "class_not_in_scope" };
  else if (f.case.paused) team = { allowed: false, reason: "paused" };

  // 3. The message.
  if (!team.allowed) return done(null, team, block(team.reason, team.reason !== "paused"));
  if (!policy.actionMessage || policy.mode === "manual") return done(null, team, block("messages_off", true));
  if (!policy.activatedAt) return done(null, team, block("policy_not_activated", false));
  if (!f.case.callerNumber) return done(null, team, block("no_caller_number", true));
  if (!f.contact) return done(null, team, block("no_contact", false));
  if (f.contact.deleted) return done(null, team, block("contact_removed", true));
  if (f.after.personMessaged) return done(null, team, block("person_followed_up", true));
  // A person owns the conversation: automation stands down completely (the Inbox's own fence says the same).
  if (f.conversationOwner === "human") return done(null, team, block("human_owner", false));
  if (f.case.attempts >= policy.maxAttempts) return done(null, team, block("attempt_cap", true));

  const attempt = firstUsableChannel(f, policy);
  if (!attempt.ok) return done(null, team, block(attempt.reason, attempt.permanent));

  // Timing, last: everything else is known to pass, so waiting is meaningful.
  // The platform spaces every follow-up to one contact (a day by default), whichever automation sent the last one: waiting here, with the true time,
  // is better than queueing a text that the send chain would hold for hours.
  const platformNext = f.timing.lastFollowUpSentAt ? f.timing.lastFollowUpSentAt.getTime() + f.timing.platformGapMinutes * 60_000 : 0;
  if (f.case.lastAttemptAt) {
    const next = Math.max(f.case.lastAttemptAt.getTime() + policy.attemptGapMinutes * 60_000, platformNext);
    if (now.getTime() < next) return done(null, team, wait(new Date(next), "attempt_gap"));
  } else if (now.getTime() < platformNext) {
    return done(null, team, wait(new Date(platformNext), "attempt_gap"));
  } else {
    const next = f.case.lastCalledAt.getTime() + policy.delayMinutes * 60_000;
    if (now.getTime() < next) return done(null, team, wait(new Date(next), "delay"));
  }
  const afterHoursWording = !f.timing.withinBusinessHours && policy.afterHoursBehavior === "send_after_hours_text";
  if (f.timing.quietHours) return done(null, team, wait(f.timing.nextOutsideQuiet ?? new Date(now.getTime() + 3_600_000), "quiet_hours"));
  if (!f.timing.withinBusinessHours && policy.afterHoursBehavior === "wait_for_open") {
    return done(null, team, wait(f.timing.nextOpen ?? new Date(now.getTime() + 3_600_000), "outside_business_hours"));
  }
  return done(null, team, { allowed: true, channel: attempt.channel, afterHoursWording, recordInboundCallConsent: attempt.recordInboundCallConsent });
}

function firstUsableChannel(f: EligibilityFacts, policy: MissedCallPolicy):
  | { ok: true; channel: RecoveryChannel; recordInboundCallConsent: boolean }
  | { ok: false; reason: string; permanent: boolean } {
  let firstFailure: { reason: string; permanent: boolean } | null = null;
  for (const name of policy.messageChannels) {
    const c = f.channels.find((x) => x.name === name);
    let failure: { reason: string; permanent: boolean } | null = null;
    if (!c || !c.connected) failure = { reason: "channel_not_ready", permanent: false };
    else if (!c.hasAddress) failure = { reason: "no_address", permanent: true };
    else if (c.suppressed) failure = { reason: "suppressed", permanent: true };
    else if (c.consent === "revoked") failure = { reason: "no_consent", permanent: true };
    else if (c.consent === "unknown" && !(name === "sms" && policy.smsConsentBasis === "inbound_call" && policy.consentAckAt)) failure = { reason: "no_consent", permanent: true };
    if (!failure) return { ok: true, channel: name, recordInboundCallConsent: c!.consent === "unknown" };
    firstFailure ??= failure;
  }
  return { ok: false, ...(firstFailure ?? { reason: "channel_not_ready", permanent: false }) };
}

// ---------------------------------------------------------------------------
// Words for the screens
// ---------------------------------------------------------------------------

export const BLOCK_REASON_TEXT: Record<string, string> = {
  case_finished: "This case is already finished.",
  answered_later: "The call turned out to have been answered, so there is nobody to follow up.",
  recovered: "The caller has already been reached.",
  expired: "The case was open longer than your policy allows and was closed.",
  workspace_inactive: "This workspace is not active.",
  policy_off: "Missed-call recovery is switched off for this workspace.",
  class_not_in_scope: "Your policy does not follow up this kind of missed call.",
  paused: "A teammate paused automatic follow-up on this case.",
  messages_off: "Your policy does not text callers automatically.",
  policy_not_activated: "A person has not confirmed the messaging settings yet, so no text is drafted or sent.",
  no_caller_number: "The caller's number was withheld, so there is nowhere to send a message.",
  no_contact: "The caller is not linked to a contact yet.",
  contact_removed: "The contact was removed.",
  person_followed_up: "A teammate already messaged this caller.",
  human_owner: "A teammate owns this conversation, so nothing is sent automatically.",
  attempt_cap: "The follow-up limit for this case has been reached.",
  channel_not_ready: "The text channel is not set up and verified for this workspace.",
  no_address: "There is no phone number or email on file to use.",
  suppressed: "This address opted out or bounced, so nothing can be sent to it.",
  no_consent: "There is no consent on record to message this person.",
  attempt_gap: "Waiting before the next attempt.",
  delay: "Waiting for the delay in your policy.",
  quiet_hours: "Waiting until quiet hours end.",
  outside_business_hours: "Waiting until your business opens.",
};

export const blockReasonText = (reason: string): string => BLOCK_REASON_TEXT[reason] ?? "A rule held this back.";
