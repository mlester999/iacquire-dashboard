// The missed-call recovery case: its states, the only moves between them, and the vocabulary the screens use.
// Pure data and functions (no database, no clock): the server's transition function (src/server/missed-calls/cases.ts) is the single place
// that writes a state, and it refuses any move this table does not list. Nothing here sends anything.

export const CASE_STATES = [
  "detected", "awaiting_eligibility", "eligible", "suppressed", "scheduled", "in_progress", "awaiting_response",
  "recovered", "completed_without_recovery", "failed", "canceled",
] as const;
export type CaseState = (typeof CASE_STATES)[number];
export const isCaseState = (v: unknown): v is CaseState => typeof v === "string" && (CASE_STATES as readonly string[]).includes(v);

/**
 * What a case's status reads as on screen. A held-back case says why in words a person can act on: "held back by a rule" is only true of
 * rules that matter to the caller, while a workspace that texts nobody simply has a case waiting for its team.
 */
export function caseStatusLabel(state: CaseState, reason: string | null): string {
  if (state === "suppressed") {
    switch (reason) {
      case "messages_off": return "Waiting for your team";
      case "policy_off": return "Recovery is off";
      case "class_not_in_scope": return "Not followed up by your policy";
      case "no_consent": case "message_no_consent": return "No consent to text";
      case "suppressed": case "message_suppressed": return "Opted out or bounced";
      case "human_owner": case "message_human_owner": return "A teammate has the conversation";
      case "policy_not_activated": return "Waiting for settings to be confirmed";
      case "channel_not_ready": return "Text channel not ready";
      case "attempt_cap": return "Follow-up limit reached";
      case "person_followed_up": return "A teammate followed up";
      case "no_caller_number": return "Number withheld";
      default: return "Held back by a rule";
    }
  }
  return CASE_STATE_LABELS[state];
}

export const CASE_STATE_LABELS: Record<CaseState, string> = {
  detected: "Missed call detected",
  awaiting_eligibility: "Waiting to be checked",
  eligible: "Ready to follow up",
  suppressed: "Held back by a rule",
  scheduled: "Follow-up scheduled",
  in_progress: "Following up",
  awaiting_response: "Waiting for the caller",
  recovered: "Recovered",
  completed_without_recovery: "Closed without recovery",
  failed: "Failed",
  canceled: "Canceled",
};

/** A case in one of these states is finished. `failed` can be reopened by a person (see TRANSITIONS), the others cannot. */
export const FINISHED_STATES: readonly CaseState[] = ["recovered", "completed_without_recovery", "failed", "canceled"];
export const isFinishedState = (s: CaseState) => (FINISHED_STATES as readonly string[]).includes(s);
export const OPEN_STATES: readonly CaseState[] = CASE_STATES.filter((s) => !isFinishedState(s));
/** The states the scheduler's job looks at: the engine has something to do (or to check) for them. A suppressed case is revisited so a reason that went away is noticed. */
export const ACTIVE_STATES: readonly CaseState[] = ["detected", "awaiting_eligibility", "eligible", "suppressed", "scheduled", "in_progress", "awaiting_response"];

/**
 * Every allowed move. Anything else is refused, whoever asks. Reading the table:
 *  - a case starts as `detected` and is moved to `awaiting_eligibility` once its policy has been looked at;
 *  - `eligible` means every rule passed at the moment it was checked (rules are checked again right before an action);
 *  - `scheduled` is a follow-up waiting for a time (business hours, a delay, a retry) and `in_progress` is a worker acting on it;
 *  - `awaiting_response` starts only after a message is really on its way (sent or delivered), never on a guess;
 *  - `suppressed` is a rule holding automation back (opt-out, no consent, policy off); a person can still work the case, and it can return
 *    to `awaiting_eligibility` when the reason goes away;
 *  - `recovered`, `completed_without_recovery` and `canceled` are final; `failed` can be reopened by a person only.
 */
export const TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  detected: ["awaiting_eligibility", "suppressed", "recovered", "completed_without_recovery", "canceled"],
  awaiting_eligibility: ["eligible", "scheduled", "suppressed", "recovered", "completed_without_recovery", "failed", "canceled"],
  eligible: ["scheduled", "in_progress", "awaiting_eligibility", "suppressed", "recovered", "completed_without_recovery", "failed", "canceled"],
  scheduled: ["in_progress", "awaiting_eligibility", "suppressed", "recovered", "completed_without_recovery", "failed", "canceled"],
  in_progress: ["awaiting_response", "scheduled", "awaiting_eligibility", "suppressed", "recovered", "completed_without_recovery", "failed", "canceled"],
  awaiting_response: ["in_progress", "awaiting_eligibility", "suppressed", "recovered", "completed_without_recovery", "failed", "canceled"],
  suppressed: ["awaiting_eligibility", "recovered", "completed_without_recovery", "canceled"],
  recovered: [],
  completed_without_recovery: [],
  failed: ["awaiting_eligibility", "completed_without_recovery", "canceled"],
  canceled: [],
};

export const canTransition = (from: CaseState, to: CaseState): boolean => TRANSITIONS[from].includes(to);

/**
 * The shortest legal route from one state to another, as the states to pass through (not including `from`). Used when one pass of the worker
 * moves a case several steps, so every step is a validated move with its own history row. Finished states are never passed through. Null when
 * there is no route.
 */
export function pathTo(from: CaseState, to: CaseState): CaseState[] | null {
  if (from === to) return [];
  const queue: Array<{ state: CaseState; path: CaseState[] }> = [{ state: from, path: [] }];
  const seen = new Set<CaseState>([from]);
  while (queue.length) {
    const { state, path } = queue.shift()!;
    for (const next of TRANSITIONS[state]) {
      if (seen.has(next)) continue;
      if (next === to) return [...path, next];
      if (isFinishedState(next)) continue;
      seen.add(next);
      queue.push({ state: next, path: [...path, next] });
    }
  }
  return null;
}

/** Moves only a person may make (the engine never reopens or abandons a case on its own). */
export const PERSON_ONLY_MOVES: ReadonlyArray<readonly [CaseState, CaseState]> = [
  ["failed", "awaiting_eligibility"],
  ["failed", "completed_without_recovery"],
];
export const isPersonOnlyMove = (from: CaseState, to: CaseState) => PERSON_ONLY_MOVES.some(([f, t]) => f === from && t === to);

export type CaseActor =
  | { kind: "system" }
  | { kind: "provider" }
  | { kind: "workflow" }
  | { kind: "user"; userId: string }
  | { kind: "agency"; userId: string }
  | { kind: "ai"; agentId: string };

export const actorIsPerson = (a: CaseActor) => a.kind === "user" || a.kind === "agency";

// ---------------------------------------------------------------------------
// Call classes
// ---------------------------------------------------------------------------

export const CALL_CLASSES = ["ring_no_answer", "voicemail", "abandoned", "busy", "provider_failed"] as const;
export type CallClass = (typeof CALL_CLASSES)[number];
export const isCallClass = (v: unknown): v is CallClass => typeof v === "string" && (CALL_CLASSES as readonly string[]).includes(v);

export const CALL_CLASS_LABELS: Record<CallClass, string> = {
  ring_no_answer: "Rang with no answer",
  voicemail: "Left a voicemail",
  abandoned: "Hung up before anyone helped",
  busy: "Line was busy",
  provider_failed: "The call could not connect",
};

export const CALL_CLASS_HELP: Record<CallClass, string> = {
  ring_no_answer: "The provider reported that nobody answered.",
  voicemail: "The caller reached voicemail.",
  abandoned: "The caller hung up (or went silent) within seconds, before anything was said that the team could act on.",
  busy: "The provider reported a busy line.",
  provider_failed: "The call failed to connect on the provider's side, so the caller never reached anyone.",
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const ACTION_KINDS = ["task", "notify", "assign", "message", "ai_callback", "appointment_setter", "opportunity", "follow_up"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ACTION_STATUSES = ["planned", "awaiting_approval", "queued", "sent", "delivered", "done", "blocked", "failed", "skipped", "canceled"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  task: "Call-back task",
  notify: "Team notice",
  assign: "Owner assigned",
  message: "Text or email to the caller",
  ai_callback: "AI call-back",
  appointment_setter: "Handed to the Appointment Setter",
  opportunity: "Deal timeline note",
  follow_up: "Follow-up reminder",
};

export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  planned: "Planned",
  awaiting_approval: "Waiting for approval",
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  done: "Done",
  blocked: "Blocked",
  failed: "Failed",
  skipped: "Skipped",
  canceled: "Canceled",
};

/** A message counts as having reached the caller's provider only in one of these two statuses. Queued is a promise, not a delivery. */
export const MESSAGE_REACHED: readonly ActionStatus[] = ["sent", "delivered"];
