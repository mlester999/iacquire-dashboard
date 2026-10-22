// The missed-call rules that need no database: which calls count as missed, the only legal moves between case states, the policy's safe
// defaults and wording rules, and every eligibility rule. These are pure functions, so each rule has a direct, fast test.
import { describe, expect, it } from "vitest";
import { classifyCall, type CallFacts } from "@/lib/missed-calls/classify";
import { evaluateEligibility, type EligibilityFacts } from "@/lib/missed-calls/eligibility";
import {
  DEFAULT_MESSAGE_AFTER_HOURS, DEFAULT_MESSAGE_OPEN, DEFAULT_POLICY, policyInputSchema, policyProblems, renderWording, wordingProblem, type MissedCallPolicy,
} from "@/lib/missed-calls/policy";
import { CASE_STATES, FINISHED_STATES, TRANSITIONS, canTransition, isPersonOnlyMove } from "@/lib/missed-calls/state";

const call = (over: Partial<CallFacts> = {}): CallFacts => ({ direction: "inbound", status: "no_answer", durationSeconds: null, disposition: null, hasContent: false, ...over });
const classify = (over: Partial<CallFacts> = {}, abandonedMaxSeconds = 8) => classifyCall(call(over), { abandonedMaxSeconds });

describe("which calls are missed", () => {
  it("treats provider-confirmed no answer, voicemail, busy and failed inbound calls as missed, each in its own class", () => {
    expect(classify({ status: "no_answer" })).toMatchObject({ missed: true, class: "ring_no_answer", providerConfirmed: true });
    expect(classify({ status: "voicemail" })).toMatchObject({ missed: true, class: "voicemail" });
    expect(classify({ status: "busy" })).toMatchObject({ missed: true, class: "busy" });
    expect(classify({ status: "failed" })).toMatchObject({ missed: true, class: "provider_failed" });
    expect(classify({ status: "cancelled" })).toMatchObject({ missed: true, class: "abandoned" });
  });

  it("never treats an outbound call as a missed customer, whatever its status", () => {
    for (const status of ["no_answer", "voicemail", "busy", "failed", "cancelled", "completed"] as const) {
      expect(classify({ direction: "outbound", status })).toEqual({ missed: false, reason: "outbound" });
    }
  });

  it("does not decide a call that is still ringing or in progress", () => {
    expect(classify({ status: "ringing" })).toEqual({ missed: false, reason: "not_final" });
    expect(classify({ status: "in_progress", durationSeconds: 2 })).toEqual({ missed: false, reason: "not_final" });
  });

  it("treats an answered call with a conversation as answered, never missed", () => {
    expect(classify({ status: "completed", durationSeconds: 185, hasContent: true })).toEqual({ missed: false, reason: "answered" });
    expect(classify({ status: "completed", durationSeconds: 45 })).toEqual({ missed: false, reason: "answered" });
  });

  it("treats a completed transfer as answered elsewhere, even when it was short", () => {
    expect(classify({ status: "completed", durationSeconds: 4, disposition: "assistant-forwarded-call" })).toEqual({ missed: false, reason: "answered_elsewhere" });
    expect(classify({ status: "completed", durationSeconds: 3, disposition: "warm_transfer" })).toEqual({ missed: false, reason: "answered_elsewhere" });
  });

  it("calls a very short answered call with nothing said an abandoned call, using the workspace's own threshold", () => {
    expect(classify({ status: "completed", durationSeconds: 5 })).toMatchObject({ missed: true, class: "abandoned", providerConfirmed: false });
    expect(classify({ status: "completed", durationSeconds: 9 }, 8)).toEqual({ missed: false, reason: "answered" });
    expect(classify({ status: "completed", durationSeconds: 9 }, 12)).toMatchObject({ missed: true, class: "abandoned" });
    // Something was said (a summary or transcript is on record): not abandoned.
    expect(classify({ status: "completed", durationSeconds: 5, hasContent: true })).toEqual({ missed: false, reason: "answered" });
  });

  it("recognises a connected call that ended in silence as abandoned and provider-confirmed", () => {
    expect(classify({ status: "completed", durationSeconds: 25, disposition: "silence-timed-out" })).toMatchObject({ missed: true, class: "abandoned", providerConfirmed: true });
  });

  it("does not guess: a completed call with no reported duration is not treated as missed", () => {
    expect(classify({ status: "completed", durationSeconds: null })).toEqual({ missed: false, reason: "unproven" });
  });
});

describe("case state machine", () => {
  it("has a table entry for every state and only names states that exist", () => {
    for (const s of CASE_STATES) {
      expect(TRANSITIONS[s]).toBeDefined();
      for (const t of TRANSITIONS[s]) expect(CASE_STATES).toContain(t);
    }
  });

  it("never moves a state to itself", () => {
    for (const s of CASE_STATES) expect(TRANSITIONS[s]).not.toContain(s);
  });

  it("lets recovered, closed-without-recovery and canceled cases go nowhere", () => {
    for (const s of ["recovered", "completed_without_recovery", "canceled"] as const) expect(TRANSITIONS[s]).toEqual([]);
  });

  it("lets only a person reopen a failed case", () => {
    expect(canTransition("failed", "awaiting_eligibility")).toBe(true);
    expect(isPersonOnlyMove("failed", "awaiting_eligibility")).toBe(true);
    expect(isPersonOnlyMove("awaiting_eligibility", "eligible")).toBe(false);
  });

  it("cannot reach 'awaiting a response' without passing through work, and cannot jump from detected to sent", () => {
    expect(canTransition("detected", "awaiting_response")).toBe(false);
    expect(canTransition("detected", "in_progress")).toBe(false);
    expect(canTransition("in_progress", "awaiting_response")).toBe(true);
    expect(canTransition("recovered", "in_progress")).toBe(false);
  });

  it("allows every open state to be canceled, recovered or closed", () => {
    for (const s of CASE_STATES) {
      if (FINISHED_STATES.includes(s)) continue;
      expect(canTransition(s, "canceled")).toBe(true);
      expect(canTransition(s, "recovered")).toBe(true);
    }
  });
});

describe("policy", () => {
  it("is off, team-only and consent-respecting by default, so a new workspace sends nothing", () => {
    expect(DEFAULT_POLICY).toMatchObject({ enabled: false, mode: "manual", actionMessage: false, activatedAt: null, smsConsentBasis: "recorded", actionAiCallback: false, routeAppointmentSetter: false });
  });

  it("validates its input strictly", () => {
    expect(policyInputSchema.safeParse({ expectedVersion: 0, delayMinutes: 5 }).success).toBe(true);
    expect(policyInputSchema.safeParse({ expectedVersion: 0, delayMinutes: -1 }).success).toBe(false);
    expect(policyInputSchema.safeParse({ expectedVersion: 0, maxAttempts: 6 }).success).toBe(false);
    expect(policyInputSchema.safeParse({ expectedVersion: 0, orgId: "x" }).success).toBe(false);
    expect(policyInputSchema.safeParse({ delayMinutes: 5 }).success).toBe(false);
  });

  it("accepts plain wording with the business name and refuses links and unknown placeholders", () => {
    expect(wordingProblem(DEFAULT_MESSAGE_OPEN)).toBeNull();
    expect(wordingProblem(DEFAULT_MESSAGE_AFTER_HOURS)).toBeNull();
    expect(wordingProblem("Visit https://example.com to book now please")).toMatch(/link/i);
    expect(wordingProblem("Hi {{first_name}}, sorry we missed you today")).toMatch(/first_name/);
    expect(wordingProblem("Hi {{business_name")).toMatch(/incomplete/);
    expect(wordingProblem("short")).toMatch(/sentence/);
    expect(wordingProblem("x".repeat(481))).toMatch(/480/);
  });

  it("renders the business name and nothing else", () => {
    expect(renderWording("Hi, this is {{business_name}}.  Sorry!", { businessName: "Harbor Dental" })).toBe("Hi, this is Harbor Dental. Sorry!");
    expect(renderWording("Hi from {{business_name}}", { businessName: "  " })).toBe("Hi from our team");
  });

  it("refuses unsafe combinations", () => {
    const base = { ...DEFAULT_POLICY, enabled: true };
    expect(policyProblems({ ...base, mode: "automatic", actionMessage: false }, { acknowledged: false })).toHaveLength(1);
    expect(policyProblems({ ...base, mode: "manual", actionMessage: true }, { acknowledged: false })).toHaveLength(1);
    expect(policyProblems({ ...base, mode: "automatic", actionMessage: true, smsConsentBasis: "inbound_call" }, { acknowledged: false }).join(" ")).toMatch(/messaging rules/);
    expect(policyProblems({ ...base, mode: "automatic", actionMessage: true, smsConsentBasis: "inbound_call" }, { acknowledged: true })).toEqual([]);
    expect(policyProblems({ ...base, actionTask: false, actionNotify: false }, { acknowledged: false }).join(" ")).toMatch(/task or a notice/);
    expect(policyProblems({ ...base, messageOpen: "Click http://x.example now to book" }, { acknowledged: false }).join(" ")).toMatch(/Links/);
    expect(policyProblems(base, { acknowledged: false })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-22T15:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const AUTO: MissedCallPolicy = { ...DEFAULT_POLICY, enabled: true, mode: "automatic", actionMessage: true, activatedAt: "2026-10-01T00:00:00.000Z", delayMinutes: 2, maxAttempts: 2, attemptGapMinutes: 240 };

function facts(over: { policy?: Partial<MissedCallPolicy>; case?: Partial<EligibilityFacts["case"]>; after?: Partial<EligibilityFacts["after"]> } & Partial<Omit<EligibilityFacts, "policy" | "case" | "after">> = {}): EligibilityFacts {
  const { policy, case: c, after, ...rest } = over;
  return {
    now: NOW,
    orgActive: true,
    policy: { ...AUTO, ...policy },
    case: { state: "awaiting_eligibility", paused: false, attempts: 0, lastAttemptAt: null, firstCalledAt: minutesAgo(10), lastCalledAt: minutesAgo(10), callerNumber: "+15555550123", afterHours: false, classification: "ring_no_answer", countedCalls: 1, ownerKind: "unassigned", ...c },
    contact: { deleted: false },
    channels: [{ name: "sms", connected: true, hasAddress: true, consent: "granted", suppressed: false }],
    conversationOwner: "ai",
    after: { customerReplied: false, callbackCompleted: false, personMessaged: false, appointmentBooked: false, ...after },
    timing: { platformGapMinutes: 0, lastFollowUpSentAt: null, quietHours: false, withinBusinessHours: true, nextOpen: null, nextOutsideQuiet: null },
    ...rest,
  };
}

const messageBlock = (e: ReturnType<typeof evaluateEligibility>) => (e.message.allowed ? null : e.message.block);

describe("eligibility", () => {
  it("allows one text for an ordinary missed call once every rule passes", () => {
    const e = evaluateEligibility(facts());
    expect(e.close).toBeNull();
    expect(e.team).toEqual({ allowed: true });
    expect(e.message).toEqual({ allowed: true, channel: "sms", afterHoursWording: false, recordInboundCallConsent: false });
    expect(e.attemptNo).toBe(1);
  });

  it("waits for the policy's delay, then for the gap between attempts", () => {
    const early = evaluateEligibility(facts({ case: { lastCalledAt: minutesAgo(1) } }));
    expect(messageBlock(early)).toMatchObject({ kind: "wait", reason: "delay" });
    const gap = evaluateEligibility(facts({ case: { attempts: 1, lastAttemptAt: minutesAgo(30) } }));
    expect(messageBlock(gap)).toMatchObject({ kind: "wait", reason: "attempt_gap" });
    expect(gap.attemptNo).toBe(2);
    expect(evaluateEligibility(facts({ case: { attempts: 1, lastAttemptAt: minutesAgo(241) } })).message.allowed).toBe(true);
  });

  it("also waits for the platform's own spacing between follow-ups, whoever sent the last one", () => {
    const e = evaluateEligibility(facts({ timing: { platformGapMinutes: 20 * 60, lastFollowUpSentAt: minutesAgo(60), quietHours: false, withinBusinessHours: true, nextOpen: null, nextOutsideQuiet: null } }));
    expect(messageBlock(e)).toMatchObject({ kind: "wait", reason: "attempt_gap" });
    expect((messageBlock(e) as { until: Date }).until.getTime()).toBe(minutesAgo(60).getTime() + 20 * 3_600_000);
    const clear = evaluateEligibility(facts({ timing: { platformGapMinutes: 20 * 60, lastFollowUpSentAt: minutesAgo(21 * 60), quietHours: false, withinBusinessHours: true, nextOpen: null, nextOutsideQuiet: null } }));
    expect(clear.message.allowed).toBe(true);
  });

  it("stops at the attempt cap", () => {
    expect(messageBlock(evaluateEligibility(facts({ case: { attempts: 2, lastAttemptAt: minutesAgo(1000) } })))).toMatchObject({ kind: "block", reason: "attempt_cap", permanent: true });
  });

  it("holds a text back during quiet hours and, by default, until the business opens", () => {
    const quiet = evaluateEligibility(facts({ timing: { platformGapMinutes: 0, lastFollowUpSentAt: null, quietHours: true, withinBusinessHours: false, nextOpen: null, nextOutsideQuiet: new Date("2026-10-22T23:00:00Z") } }));
    expect(messageBlock(quiet)).toMatchObject({ kind: "wait", reason: "quiet_hours" });
    const closed = evaluateEligibility(facts({ timing: { platformGapMinutes: 0, lastFollowUpSentAt: null, quietHours: false, withinBusinessHours: false, nextOpen: new Date("2026-10-23T13:00:00Z"), nextOutsideQuiet: NOW } }));
    expect(messageBlock(closed)).toMatchObject({ kind: "wait", reason: "outside_business_hours" });
  });

  it("can send the after-hours wording promptly when the policy says so, but never during quiet hours", () => {
    const policy = { afterHoursBehavior: "send_after_hours_text" as const };
    const open = evaluateEligibility(facts({ policy, timing: { platformGapMinutes: 0, lastFollowUpSentAt: null, quietHours: false, withinBusinessHours: false, nextOpen: null, nextOutsideQuiet: NOW } }));
    expect(open.message).toMatchObject({ allowed: true, afterHoursWording: true });
    const quiet = evaluateEligibility(facts({ policy, timing: { platformGapMinutes: 0, lastFollowUpSentAt: null, quietHours: true, withinBusinessHours: false, nextOpen: null, nextOutsideQuiet: new Date("2026-10-22T23:00:00Z") } }));
    expect(messageBlock(quiet)).toMatchObject({ kind: "wait", reason: "quiet_hours" });
  });

  it("never texts a caller who opted out, bounced, or withdrew consent", () => {
    expect(messageBlock(evaluateEligibility(facts({ channels: [{ name: "sms", connected: true, hasAddress: true, consent: "granted", suppressed: true }] })))).toMatchObject({ reason: "suppressed", permanent: true });
    expect(messageBlock(evaluateEligibility(facts({ channels: [{ name: "sms", connected: true, hasAddress: true, consent: "revoked", suppressed: false }] })))).toMatchObject({ reason: "no_consent", permanent: true });
  });

  it("needs a consent on record by default, and accepts an inbound call as the basis only when the business acknowledged the rules", () => {
    const unknown = [{ name: "sms" as const, connected: true, hasAddress: true, consent: "unknown" as const, suppressed: false }];
    expect(messageBlock(evaluateEligibility(facts({ channels: unknown })))).toMatchObject({ reason: "no_consent" });
    expect(messageBlock(evaluateEligibility(facts({ channels: unknown, policy: { smsConsentBasis: "inbound_call" } })))).toMatchObject({ reason: "no_consent" });
    const acknowledged = evaluateEligibility(facts({ channels: unknown, policy: { smsConsentBasis: "inbound_call", consentAckAt: "2026-10-01T00:00:00Z" } }));
    expect(acknowledged.message).toMatchObject({ allowed: true, recordInboundCallConsent: true });
    // Revoked consent is never overridden by the basis.
    const revoked = [{ ...unknown[0], consent: "revoked" as const }];
    expect(messageBlock(evaluateEligibility(facts({ channels: revoked, policy: { smsConsentBasis: "inbound_call", consentAckAt: "2026-10-01T00:00:00Z" } })))).toMatchObject({ reason: "no_consent" });
  });

  it("stands down when a person owns the conversation or already messaged the caller", () => {
    expect(messageBlock(evaluateEligibility(facts({ conversationOwner: "human" })))).toMatchObject({ reason: "human_owner" });
    expect(messageBlock(evaluateEligibility(facts({ after: { personMessaged: true } })))).toMatchObject({ reason: "person_followed_up", permanent: true });
  });

  it("holds every automatic message until a person has activated the policy, and while the channel is not ready", () => {
    expect(messageBlock(evaluateEligibility(facts({ policy: { activatedAt: null } })))).toMatchObject({ reason: "policy_not_activated" });
    expect(messageBlock(evaluateEligibility(facts({ channels: [{ name: "sms", connected: false, hasAddress: true, consent: "granted", suppressed: false }] })))).toMatchObject({ reason: "channel_not_ready", permanent: false });
    expect(messageBlock(evaluateEligibility(facts({ policy: { mode: "manual" } })))).toMatchObject({ reason: "messages_off" });
    expect(messageBlock(evaluateEligibility(facts({ policy: { actionMessage: false } })))).toMatchObject({ reason: "messages_off" });
  });

  it("cannot message a withheld number or a removed contact", () => {
    expect(messageBlock(evaluateEligibility(facts({ case: { callerNumber: null } })))).toMatchObject({ reason: "no_caller_number" });
    expect(messageBlock(evaluateEligibility(facts({ contact: { deleted: true } })))).toMatchObject({ reason: "contact_removed" });
    expect(messageBlock(evaluateEligibility(facts({ contact: null })))).toMatchObject({ reason: "no_contact" });
  });

  it("falls through to the next channel when the first is not usable", () => {
    const e = evaluateEligibility(facts({
      policy: { messageChannels: ["sms", "email"] },
      channels: [
        { name: "sms", connected: false, hasAddress: true, consent: "granted", suppressed: false },
        { name: "email", connected: true, hasAddress: true, consent: "granted", suppressed: false },
      ],
    }));
    expect(e.message).toMatchObject({ allowed: true, channel: "email" });
  });

  it("settles the case when the caller wrote back, was called back, or booked", () => {
    expect(evaluateEligibility(facts({ after: { customerReplied: true } })).close).toEqual({ to: "recovered", via: "customer_reply", reason: "The caller wrote back." });
    expect(evaluateEligibility(facts({ after: { callbackCompleted: true } })).close).toMatchObject({ to: "recovered", via: "callback_completed" });
    expect(evaluateEligibility(facts({ after: { appointmentBooked: true } })).close).toMatchObject({ to: "recovered", via: "appointment_booked" });
    for (const after of [{ customerReplied: true }, { callbackCompleted: true }, { appointmentBooked: true }]) {
      expect(messageBlock(evaluateEligibility(facts({ after })))).toMatchObject({ reason: "recovered", permanent: true });
    }
  });

  it("cancels a case whose calls all turned out to be answered, and closes one that expired", () => {
    expect(evaluateEligibility(facts({ case: { countedCalls: 0 } })).close).toEqual({ to: "canceled", reason: "answered_later" });
    const old = evaluateEligibility(facts({ case: { firstCalledAt: minutesAgo(72 * 60 + 1), lastCalledAt: minutesAgo(72 * 60 + 1) } }));
    expect(old.close).toEqual({ to: "completed_without_recovery", reason: "expired" });
  });

  it("does nothing at all for a finished case", () => {
    for (const state of FINISHED_STATES) {
      const e = evaluateEligibility(facts({ case: { state } }));
      expect(e.close).toBeNull();
      expect(e.team.allowed).toBe(false);
      expect(e.message.allowed).toBe(false);
    }
  });

  it("allows the team actions only while the policy is on and the call class is in scope, and not while paused", () => {
    expect(evaluateEligibility(facts({ policy: { enabled: false } })).team).toEqual({ allowed: false, reason: "policy_off" });
    expect(evaluateEligibility(facts({ policy: { classes: ["voicemail"] } })).team).toEqual({ allowed: false, reason: "class_not_in_scope" });
    expect(evaluateEligibility(facts({ case: { paused: true } })).team).toEqual({ allowed: false, reason: "paused" });
    expect(evaluateEligibility(facts({ orgActive: false })).team).toEqual({ allowed: false, reason: "workspace_inactive" });
    // A policy in "team only" mode still creates the task and the notice.
    expect(evaluateEligibility(facts({ policy: { mode: "manual", actionMessage: false } })).team).toEqual({ allowed: true });
  });
});
