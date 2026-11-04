import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { isValidTimeZone } from "@/lib/calendars/slots";
import type { ReadinessState } from "@/lib/workforce-readiness";
import { ROLE_LABELS, type OrgRole } from "@/lib/permissions";
import { checkCoversInputs, verificationInputs, VERIFICATION_INPUT_LABEL } from "@/lib/launch-verification";

// One honest answer to "is this client ready to launch?", built only from facts that were read from the workspace's own records. Pure: no I/O. Nothing here is inferred from a
// queued job, a drafted calendar or a green badge: a step is done only when the thing it names is true, and "100% Ready to Launch" means every applicable, required setup and
// verification check has passed. Optional or unpurchased things are listed but never block it, and a requirement that does not apply to this business (no appointments, a role
// that is not in the plan) is shown as not applicable instead of blocking setup.

export type LaunchState = "not_started" | "questionnaire_submitted" | "provisioning" | "action_required" | "ready_for_review" | "ready_to_launch";

export const LAUNCH_STATE_LABEL: Record<LaunchState, string> = {
  not_started: "Not started",
  questionnaire_submitted: "Questionnaire submitted",
  provisioning: "Provisioning",
  action_required: "Action required",
  ready_for_review: "Ready for review",
  ready_to_launch: "100% Ready to Launch",
};

export type ItemState = "done" | "in_progress" | "action_required" | "awaiting_review" | "failed" | "not_applicable";
export const ITEM_STATE_LABEL: Record<ItemState, string> = {
  done: "Done",
  in_progress: "In progress",
  action_required: "Action required",
  awaiting_review: "Waiting for review",
  failed: "Failed",
  not_applicable: "Not applicable",
};

/** Who has to move next on an item that is not done. */
export type ItemOwner = "you" | "iacquire" | "system";

/**
 * Every step a button in the guided setup can run. The server action takes its list of valid names from here, so a step that is not in it is refused before anything is read.
 * None of them turns a customer-facing thing on: the three that write to the workspace (the team invitations, the region defaults, the pipeline stages) are the client's own
 * decision, pressed by a person, and the last one only asks the automatic CRM setup to run again. "sync_employees" brings the AI team up to what the client already approved: it
 * writes new versions of the employees that fell behind (each one through the same review a questionnaire submission goes through) and never turns anything on.
 */
export const LAUNCH_INTENTS = ["assign_host", "apply_hours", "activate_calendar", "run_checks", "send_team_invitations", "confirm_region_defaults", "apply_pipeline_stages", "retry_crm_setup", "sync_employees"] as const;
/** A button that does the next step inside the guided setup (an intent the page runs) or a link to the screen where it is done. */
export type LaunchIntent = (typeof LAUNCH_INTENTS)[number];
/** What an intent needs besides its name. The server checks both again: the person is the signed-in one, the host must be an active member of this workspace, and the digest must still describe what is true. */
export interface LaunchIntentParams {
  /** assign_host: the person to make the host. Left out, the person who pressed the button. */
  userId?: string;
  /** apply_hours: the digest of the hosts, hours and zone that were shown, which the server recomputes before it saves anything. */
  hoursDigest?: string;
}
export interface LaunchAction {
  label: string;
  href?: string;
  intent?: LaunchIntent;
  params?: LaunchIntentParams;
  /** "internal" runs inside the guided setup (an intent); "external" opens another screen. Left out, `actionKind` says which from the other fields. */
  kind?: "external" | "internal";
}

/** Whether an action runs here (an intent) or opens another screen (a link), for a panel that treats the two differently. */
export function actionKind(a: Pick<LaunchAction, "intent" | "kind">): "external" | "internal" {
  return a.kind ?? (a.intent ? "internal" : "external");
}

/**
 * The path of one employee's setup, one stage per thing that is stored: a job exists (queued), its profile was created (profile), its connection check passed (verified), its tool
 * inventory was recorded (tools), and its role has what it needs (ready). A stage is never "done" before an earlier one: the evidence of a later stage is also evidence of the earlier ones.
 * "pending" is a stage that has not been reached yet; the others read as they do for an item.
 */
export type StageState = "done" | "in_progress" | "pending" | "action_required" | "failed";
export interface LaunchStage {
  key: "queued" | "profile" | "verified" | "tools" | "ready";
  label: string;
  state: StageState;
}

/** A customer-facing switch and where it is flipped. Informational: a row is never required, never counts towards the percentage, and nothing here ever turns one on. */
export interface LaunchControlFact {
  key: string;
  label: string;
  on: boolean;
  /** The client's own answers say they want this (they asked for the channel, or for appointments). */
  wanted: boolean;
  /** The screen where the person flips it. */
  href: string;
}
export interface LaunchControl extends LaunchControlFact {
  required: false;
  detail: string;
}

export interface LaunchItem {
  key: string;
  label: string;
  state: ItemState;
  /** Only required items count towards "100%". An optional item is shown and never blocks. */
  required: boolean;
  detail: string;
  owner: ItemOwner;
  action?: LaunchAction;
  /** The item was in progress for longer than it should be, so it is now iAcquire's to look at. Only ever set from a start time the facts carried and a clock the caller passed in. */
  stalled?: boolean;
  /** When the thing that stalled began waiting (ISO), so an alert about it can be named once per wait. Set with `stalled`. */
  stalledSince?: string;
  /** The people the client may choose from for this step (the host), for a select beside the button. Names only: the server validates the id that comes back. */
  hostChoices?: Array<{ id: string; name: string }>;
  /** What the client's own part of this step involves (for example the records they add for a domain). Guidance only: it is never a state and never counts as verified. */
  guidance?: string[];
  /** An employee's path, from stored facts only. Present on an employee that is part of the plan, absent otherwise. */
  stages?: LaunchStage[];
}

export type StepKey = "profile" | "knowledge" | "crm" | "calendar" | "integrations" | "employees" | "verification";
export type StepState = "done" | "in_progress" | "action_required" | "awaiting_review" | "not_applicable";

export interface LaunchStep {
  key: StepKey;
  title: string;
  state: StepState;
  summary: string;
  items: LaunchItem[];
}

export interface LaunchReadiness {
  state: LaunchState;
  label: string;
  headline: string;
  detail: string;
  /** Required, applicable checks that passed over all of them, whole numbers, 100 only when `state` is ready_to_launch. */
  percent: number;
  passed: number;
  total: number;
  steps: LaunchStep[];
  /** Required items that need someone to act (or failed), in step order. */
  blocking: LaunchItem[];
  /** The customer-facing switches, each off until the client turns it on. Present when the facts carried them. */
  controls?: LaunchControl[];
}

// ---------------------------------------------------------------------------
// Facts: what the workspace's own records say. The server reads them; this file only judges them.
// ---------------------------------------------------------------------------

export interface CalendarCheckFact {
  key: "hosts" | "hours" | "timezone" | "types" | "connections" | "slot";
  ok: boolean;
  detail: string;
}

/** What one host has connected, as the calendar needs it: strict and per host. */
export interface HostConnectionFact {
  userId: string;
  name: string;
  /** The person looking is this host (only a person can connect their own account). */
  viewer: boolean;
  /** A connected account that can add events: the only kind that can make a Google Meet or Teams link. Another person's account, an ICS feed or CalDAV never counts. */
  meet: { google: boolean; microsoft: boolean };
  /** A connected account of that provider that is being read for busy times, recently enough to trust. */
  busy: { google: boolean; microsoft: boolean };
}

export interface CalendarFacts {
  id: string;
  status: "draft" | "active";
  /** Active hosts assigned to the calendar. */
  hosts: number;
  /** Of those, the hosts that have weekly hours saved. */
  hostsWithHours: number;
  /** The calendar carries suggested weekly hours (from the onboarding answers or a Blueprint) that can be offered to a host for approval. */
  hasSuggestedHours: boolean;
  /** Appointment types that can be booked. */
  types: number;
  /** An appointment type needs a video link from a connected Google or Microsoft account. */
  needsVideoConnection: boolean;
  /** Which provider's account the video appointment types need (Google Meet, Microsoft Teams). Empty when it is not known; absent in older facts. */
  videoProviders?: Array<"google" | "microsoft">;
  /** The activation checks (hosts, hours, time zone, types, connections, a real open time within two weeks), read now; null when they could not be read. */
  checks: CalendarCheckFact[] | null;
  bookingPageOn: boolean;
  /** The person looking may set up calendars (choose a host, approve hours, activate). Absent: assumed, for older facts. */
  canManage?: boolean;
  /** The workspace owner's name, for "Ask ..." when the person looking may not. */
  ownerName?: string | null;
  /** Active members who may host, for the host select. Only read for a person who may choose a host. */
  hostChoices?: Array<{ id: string; name: string }>;
  /** The hosts who still have no weekly hours: a host added from the questionnaire or by an invitation has none until the client approves them. */
  hostsNeedingHours?: Array<{ id: string; name: string }>;
  /** The suggested weekly hours the client can approve and what the digest covers; null when there are none to approve. */
  suggestedHours?: { zone: string; summary: string; digest: string } | null;
  /** Appointment types (of the ones checked) that no customer could be offered a time for. Read with the checks, so absent until they ran. */
  typesWithoutTimes?: string[];
  /** Video appointment types with no meeting tool and no words about how to join. */
  typesWithoutJoinInfo?: string[];
  /** Per host, what is connected. Absent in older facts, which could only say whether any connection existed. */
  hostConnections?: HostConnectionFact[];
  /** Whether iAcquire's Google and Microsoft sign-in is configured here. A yes or no only, never any value. */
  oauthAvailable?: { google: boolean; microsoft: boolean };
  /** What the client said about an outside calendar blocking times: google or microsoft (required), none (not required), or null (not said). */
  busyProvider?: "google" | "microsoft" | "none" | null;
  /**
   * What the re-check recorded when an active calendar that had passed activation stopped passing (src/server/calendars/reverify.ts): the checks that failed, with their client-safe
   * words. Absent: nothing is recorded. The judge speaks from it only when the checks could not be read live (`checks` is null); a live read always outranks a stored record.
   */
  drift?: { checks: Array<{ key: string; detail: string }> };
}

/** A person the client marked as taking appointments in the team answer, and how far they are: not invited, invited and not accepted, or a member. */
export interface TeamHostFact {
  name: string;
  state: "not_invited" | "invited" | "member";
}

/** "retrying" is a failed attempt that still has attempts left and a retry time: it is tried again by itself, so it is not yet a failure anyone must look at. */
export type ProvisioningFact = "none" | "requested" | "in_progress" | "awaiting_health_check" | "succeeded" | "failed" | "retrying" | "cancelled";

export interface EmployeeFact {
  role: AgentRoleKey;
  /** The role is part of the client's plan (the employee is switched on for this workspace). */
  entitled: boolean;
  /** Provisioning of the employee's own profile, from its persisted job. */
  provisioning: ProvisioningFact;
  /** The job's recorded note. For iAcquire's eyes: the client never reads it. */
  provisioningDetail: string | null;
  /** Attempts the profile job has used, the most it gets, and when the next automatic try is due (null: none is scheduled). */
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  /** The employee's last connection check ran and did not pass. */
  healthFailed: boolean;
  /** What that check recorded. For iAcquire's eyes: the client never reads it. */
  healthDetail: string | null;
  readiness: { state: ReadinessState; chatAvailable: boolean; workReady: boolean; description: string; blocking: string[] };
  /** A configuration change for this employee is held for iAcquire's review. */
  heldForReview: boolean;
  /** The applied configuration version the checks below were run against. */
  configVersion: number | null;
  /** When the profile job that is still open began waiting (ISO). Absent or null: unknown, so the item is never called stalled. */
  startedAt?: string | null;
  /** That open job is claimed by nobody: its lease ran out. */
  leaseExpired?: boolean;
  /** iAcquire was really told this wait is long (a recorded notice for it). The words "iAcquire has been alerted" are used only when this is true. */
  stallAlerted?: boolean;
  /**
   * The profile job is held back only because the client runtime is at its profile ceiling (the claim's own capacity rule), or the worker answered capacity_exceeded. Nothing
   * failed; it starts by itself once there is room. Absent or false: not held for room.
   */
  capacityHeld?: boolean;
  /** The employee's own readiness steps, as stored, for the stages. Absent: the stages fall back to what `readiness` says. */
  readinessSteps?: Array<{ key: string; state: "done" | "current" | "upcoming" | "blocked" | "not_applicable" }>;
  /**
   * A digest of the setup this employee's final check reads (src/lib/launch-verification.ts `verificationInputs`) as it is now. Null or absent: the check reads nothing but the
   * configuration. A check recorded against a different digest is stale.
   */
  inputsDigest?: string | null;
}

export type VerificationFact =
  | { role: AgentRoleKey; state: "none" }
  | {
      role: AgentRoleKey;
      state: "running";
      /** When the check was queued (ISO), so a check that runs for too long is noticed. Absent: unknown. */
      since?: string | null;
      /** Its worker stopped reporting: the lease ran out. */
      leaseExpired?: boolean;
      /** iAcquire was really told this check is taking long. */
      alerted?: boolean;
    }
  /** The check is held for a person's approval (a work job in waiting_for_approval): that is a review, not a run. */
  | { role: AgentRoleKey; state: "awaiting_review" }
  | {
      role: AgentRoleKey;
      state: "passed" | "failed";
      /** The configuration version the check was run against. */
      configVersion: number | null;
      detail: string | null;
      /** A passed check that read nothing because the records it reads do not exist yet (an empty CRM). Still a pass: a new client is legitimately empty. */
      nothingToCheck?: boolean;
      /** The digest of the setup the check read. Absent or null: recorded without one, so it stays valid for its configuration version. */
      inputsDigest?: string | null;
    };

export interface ChannelFact {
  channel: "sms" | "whatsapp" | "email";
  /** The client named it as a way customers reach them. */
  wanted: boolean;
  enabled: boolean;
  registration: string;
  /**
   * What the client wrote as the sender of this channel (their questionnaire answer), or null when they gave none. A hint for the person who connects the channel: it is never
   * verified and never counts towards "connected". Absent (undefined) when the facts did not read it.
   */
  statedSender?: string | null;
  /** A provider credential is stored for the channel. Absent when the facts did not read it. */
  credentialStored?: boolean;
}

/**
 * What the CRM setup evidence says (src/server/setup/native-evidence.ts), judged by the server from the workspace's own records. "none" is nothing applied and nothing failed yet.
 * Only "verified" counts: the newest application of every live Blueprint finished and every record it created is still in the CRM.
 */
export type CrmBlueprintFact = "none" | "verified" | "partial" | "failed" | "missing_records" | "waiting_for_a_person";

export interface LaunchFacts {
  /** The questionnaire was submitted (the workspace's onboarding completed). */
  submitted: boolean;
  /** The setup payment is confirmed (paid or waived). Null: not asked (a sample workspace has no setup fee). */
  paymentCleared: boolean | null;
  /** Whether the person looking can open billing, so the payment line can link to it. */
  canOpenBilling: boolean;
  profile: { companyName: boolean; industry: boolean; description: boolean; timezone: string | null; timezoneAnswered: boolean };
  knowledge: { approved: number; pending: number };
  crm: {
    mode: "native" | "ghl" | "hybrid";
    blueprint: CrmBlueprintFact;
    /** The evidence's client-safe summary for a Blueprint that is not verified. Never the agency's detail. */
    blueprintSummary?: string | null;
    /** The automatic industry setup is switched on in this deployment (it reads the same either way: iAcquire is setting it up). */
    automaticSetup?: boolean;
    /** A non-archived pipeline with at least two non-archived stages, one of them open. */
    pipelineReady: boolean;
    /** Tags, contact fields and forms in the CRM, and whether they match what the Blueprint created. */
    records?: { state: "in_place" | "missing" | "pending"; tags: number; contactFields: number; forms: number };
    providerConnected: boolean;
    /** When the industry setup began to be waited for: the later of the questionnaire's submission and the setup fee clearing (ISO). Absent or null: unknown. */
    waitingSince?: string | null;
    /** iAcquire was really told this wait is long. */
    waitingAlerted?: boolean;
    /** The person looking may ask for the automatic setup to run again (they manage the workspace profile, and the automatic setup is on here). Absent: no button. */
    canRetry?: boolean;
    /** What the client's time zone suggests for currency and phone country: on offer, or already in place. Absent: nothing to say. */
    region?: { state: "offer" | "matches"; currency: string; callingCode: string; country: string; canConfirm?: boolean };
    /** The client's own sales steps as a pipeline: on offer, or already in the CRM. Absent: nothing to say (no clean list of steps, or the CRM cannot take it). */
    pipelineDraft?: { state: "offer" | "applied"; stages: string[]; makesDefault?: boolean; canApply?: boolean };
  };
  /** True: appointments are wanted. False: not wanted. Null: the questionnaire does not say. */
  appointments: {
    wanted: boolean | null;
    calendar: CalendarFacts | null;
    externalCalendarConnected: boolean;
    /** Who the client said takes the appointments: themselves ("owner") or a team member ("team"). Null: not said. */
    hostChoice?: "owner" | "team" | null;
    /** The team members the client marked as taking appointments, for the "team" choice. */
    teamHosts?: TeamHostFact[];
  };
  channels: ChannelFact[];
  /** Present only for tenants using the unified Growth Partner model. */
  growthPartner?: {
    status: "setup_required" | "provisioning" | "configured" | "paused" | "migration_required";
    runtimeBound: boolean;
    enabled: boolean | null;
    runtimeStatus: "setup_required" | "provisioning" | "online" | "busy" | "offline" | "error" | "disabled" | null;
    profileConnected: boolean;
    runtimeReady: boolean;
    healthFailed: boolean;
    brainActive: boolean;
    latestBrainVersion: number | null;
    conversationReady: boolean;
    provisioning: "requested" | "in_progress" | "awaiting_health_check" | "succeeded" | "failed" | "retrying" | "cancelled" | null;
  };
  employees: EmployeeFact[];
  verification: VerificationFact[];
  /**
   * The client saved answer edits after their last approval, so the live setup (and the AI team) still runs on the earlier answers. The same rule the questionnaire uses for
   * "unsubmitted changes". It blocks 100% until the client approves. Absent: nothing is waiting.
   */
  pendingAnswerChanges?: boolean;
  /**
   * The people the client listed as talking to customers (the team answer, as last approved) and how far each one is. `toInviteNames` are names only. `invitable` carries the address and
   * role each invitation would go out with, and is read only for a viewer who may send them (never for a system read), so the button names exactly who is emailed and as what; it holds
   * only the people that viewer may invite. Absent or with nobody listed: the workspace listed no one, so no line is shown.
   */
  team?: { listed: number; members: number; pending: number; toInviteNames: string[]; invitable?: Array<{ name: string; email: string; role: OrgRole }>; canManage?: boolean };
  /**
   * The employees that do not run what the client approved: the answers or the business information moved on and no version of theirs picked it up (a change that was rejected or
   * replaced, or never made). Never a version that is waiting for review: that is `heldForReview`. Absent or empty: every employee is in step.
   */
  employeesBehind?: Array<{ role: AgentRoleKey; reason: string }>;
  /** The person looking may bring the employees up to date (they manage the workspace profile). Absent: assumed. */
  canSyncEmployees?: boolean;
  /** Whether a person is set up to take over a customer conversation: read from the staff profiles, never from free text. Absent: not read. */
  handoff?: { ownerHasNotifyChannel: boolean; eligibleStaff: number };
  /** The workspace's booking rules that decide what happens after a booking, as saved (or the defaults when nothing was saved). Absent: not read. */
  bookingSettings?: { lateCancelHours: number | null; aiBookingEnabled: boolean; remindersEnabled: boolean };
  /** Every customer-facing switch and its real state. Absent: not read. */
  launchControls?: LaunchControlFact[];
}

// ---------------------------------------------------------------------------
// Time: how long a wait may last before it is somebody's to look at
// ---------------------------------------------------------------------------

export interface StallMinutes {
  /** An employee's profile job that is still open. The server reads HERMES_PROVISIONER_STALL_MINUTES for this one. */
  provisioning: number;
  /** A final read-only check that is queued or running. */
  verification: number;
  /** The industry CRM setup that has not been applied yet. */
  crm: number;
}
export const STALL_MINUTES: StallMinutes = { provisioning: 30, verification: 15, crm: 60 };

/** What the judge needs to tell a long wait from a short one. Without `now` nothing is ever called stalled: a pure read of the facts says only what they say. */
interface Clock {
  now: Date | null;
  stall: StallMinutes;
}

/** How long ago `since` was, when both it and the clock are known and the wait has passed `thresholdMinutes`; otherwise null. */
function waitedPast(clock: Clock, since: string | null | undefined, thresholdMinutes: number): number | null {
  if (!clock.now || !since) return null;
  const began = Date.parse(since);
  if (!Number.isFinite(began)) return null;
  const waited = clock.now.getTime() - began;
  return waited >= thresholdMinutes * 60_000 ? waited : null;
}

const howLong = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 120 ? `about ${minutes} minutes` : `about ${Math.round(minutes / 60)} hours`;
};

/**
 * An item that waited too long: iAcquire's to look at, and said so in plain words. "iAcquire has been alerted" is written only when a recorded alert exists (`alerted`); otherwise it
 * says what is true, that the item is waiting on iAcquire, and promises nothing.
 */
function stalledItem(i: LaunchItem, what: string, waited: number, since: string, alerted: boolean | undefined, extra = "", action?: LaunchAction): LaunchItem {
  return {
    key: i.key, label: i.label, state: "action_required", required: i.required, owner: "iacquire", stalled: true, stalledSince: since,
    detail: `${what} has taken ${howLong(waited)}, longer than expected.${extra} ${alerted ? "iAcquire has been alerted." : "It is waiting on iAcquire."} Nothing is needed from you.`,
    ...(action ? { action } : {}),
  };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const item = (i: LaunchItem): LaunchItem => i;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function profileStep(f: LaunchFacts): LaunchStep {
  const p = f.profile;
  const complete = p.companyName && p.industry && p.description;
  const zoneOk = p.timezoneAnswered && Boolean(p.timezone) && isValidTimeZone(p.timezone as string);
  const items = [
    item(complete
      ? { key: "profile.company", label: "Company details", state: "done", required: true, owner: "you", detail: "Name, industry and what the business does are saved." }
      : { key: "profile.company", label: "Company details", state: "action_required", required: true, owner: "you", detail: "The company name, industry and description are not all saved yet.", action: { label: "Finish company setup", href: "/onboarding" } }),
    item(zoneOk
      ? { key: "profile.timezone", label: "Business time zone", state: "done", required: true, owner: "you", detail: `Your business time zone is ${p.timezone}.` }
      : { key: "profile.timezone", label: "Business time zone", state: "action_required", required: true, owner: "you", detail: "Confirm the time zone your business works in. Booking times and replies depend on it.", action: { label: "Confirm time zone", href: "/onboarding" } }),
  ];
  // Edits nobody approved are not the live setup: until the client approves them, "ready" would describe answers that nothing has been built from.
  if (f.pendingAnswerChanges) {
    items.push(item({ key: "profile.pending_changes", label: "Changes waiting for your approval", state: "action_required", required: true, owner: "you", detail: "You changed your company setup and have not approved it yet. Your active profile setup still uses the previous answers.", action: { label: "Review and approve your changes", href: "/onboarding" } }));
  }
  return { key: "profile", title: "Business profile", ...summarize(items) };
}

/**
 * The people the client listed as talking to customers. Informational and never required: a business with no team is not held up, and nobody is invited until the owner presses the
 * button (an invitation is an email to a third party). Shown only when the client listed someone.
 */
function teamItem(f: LaunchFacts): LaunchItem | null {
  const t = f.team;
  if (!t || t.listed === 0) return null;
  const base = { key: "knowledge.team", label: "Invite your team", required: false, owner: "you" } as const;
  const n = t.toInviteNames.length;
  if (n > 0) {
    const who = namesOf(t.toInviteNames.map((name) => ({ name })));
    if (t.canManage === false) return { ...base, state: "action_required", detail: `You listed ${plural(n, "person", "people")} who talk to customers (${who}) and nobody has been invited. Only an owner or admin can send invitations.` };
    // The viewer is shown the address and the access level each invitation goes out with before it is sent, and the count is only the people they may actually invite.
    const sendable = t.invitable;
    if (sendable && sendable.length === 0) {
      return { ...base, state: "action_required", detail: `You listed ${plural(n, "person", "people")} who talk to customers (${who}) and nobody has been invited. The access you listed for them is higher than the access you can give, so an owner has to send these invitations.` };
    }
    const m = sendable ? sendable.length : n;
    const lines = sendable ? sendable.map((p) => `${p.name}, ${p.email}, as ${ROLE_LABELS[p.role]}`).join("; ") : who;
    const left = sendable && m < n ? ` ${plural(n - m, "more person is", "more people are")} listed with access you cannot give, so an owner has to invite ${n - m === 1 ? "them" : "those"}.` : "";
    return { ...base, state: "action_required", detail: `You listed ${plural(n, "person", "people")} who talk to customers. Nobody has been invited: pressing this emails ${lines}, and only then. It does not hold up launch.${left}`,
      action: { label: m === 1 ? "Send 1 invitation" : `Send ${m} invitations`, intent: "send_team_invitations" } };
  }
  if (t.pending > 0) return { ...base, state: "in_progress", detail: `${plural(t.pending, "invitation is", "invitations are")} waiting to be accepted.${t.members ? ` ${plural(t.members, "person has", "people have")} already joined.` : ""}` };
  return { ...base, state: "done", detail: `${t.members === 1 ? "The person" : "Everyone"} you listed ${t.members === 1 ? "is" : "are"} on your team.` };
}

/** Whether a person would actually be told when a customer needs one, judged from the staff profiles. Not applicable until the client wants a customer channel; never required. */
function handoffItem(f: LaunchFacts): LaunchItem | null {
  const h = f.handoff;
  const base = { key: "knowledge.handoff", label: "A person to take over customer conversations", required: false, owner: "you" } as const;
  if (!f.channels.some((c) => c.wanted)) return h ? { ...base, state: "not_applicable", detail: "You have not asked for a customer channel yet, so nobody needs to take over a conversation yet." } : null;
  if (!h) return null;
  if (h.eligibleStaff > 0) {
    return { ...base, state: "done", detail: `${plural(h.eligibleStaff, "person is", "people are")} set up to be told when a customer asks for a person${h.ownerHasNotifyChannel ? "" : ", and the owner has no way to be notified"}.` };
  }
  return { ...base, state: "action_required", detail: "Nobody is set up to be told when a customer asks for a person, so a hand-off would wait unclaimed. Choose who is notified, and how, in escalation settings. This does not hold up launch.",
    action: { label: "Set up escalations", href: "/settings/escalations" } };
}

function knowledgeStep(f: LaunchFacts): LaunchStep {
  const { approved, pending } = f.knowledge;
  const items: LaunchItem[] = [];
  if (approved > 0) {
    items.push(item({ key: "knowledge.approved", label: "Approved company knowledge", state: "done", required: true, owner: "you", detail: `${plural(approved, "section is", "sections are")} approved. The AI Growth Partner and any retained profiles use only approved knowledge.` }));
  } else if (pending > 0) {
    // Sensitive wording (prices, policies, promises) is held for iAcquire's review before a profile may use it: the client has done their part.
    items.push(item({ key: "knowledge.approved", label: "Approved company knowledge", state: "awaiting_review", required: true, owner: "iacquire", detail: `${plural(pending, "section is", "sections are")} waiting for iAcquire's review. Nothing is used until it is approved.`, action: { label: "See your knowledge", href: "/knowledge" } }));
  } else {
    items.push(item({ key: "knowledge.approved", label: "Approved company knowledge", state: "action_required", required: true, owner: "you", detail: "No company knowledge has been saved yet.", action: { label: "Add your knowledge", href: "/knowledge" } }));
  }
  if (approved > 0 && pending > 0) {
    items.push(item({ key: "knowledge.pending", label: "More knowledge waiting", state: "awaiting_review", required: false, owner: "iacquire", detail: `${plural(pending, "more section is", "more sections are")} waiting for iAcquire's review. This does not hold up launch.`, action: { label: "See your knowledge", href: "/knowledge" } }));
  }
  const team = teamItem(f);
  if (team) items.push(item(team));
  const handoff = handoffItem(f);
  if (handoff) items.push(item(handoff));
  return { key: "knowledge", title: "Knowledge and approvals", ...summarize(items) };
}

/** The industry CRM setup, judged from the Blueprint evidence: only a verified one is done, and everything that is not verified is iAcquire's to fix, never the client's. */
function blueprintItem(c: LaunchFacts["crm"], clock: Clock, started: boolean): LaunchItem {
  const base = { key: "crm.blueprint", label: "Industry CRM setup", required: true, owner: "iacquire" } as const;
  const summary = c.blueprintSummary?.trim();
  // Asking the automatic setup to run again is offered only to a person who may, and only where the automation is on and nothing from it exists to be repeated.
  const retry: LaunchAction | undefined = c.canRetry ? { label: "Try the setup again", intent: "retry_crm_setup" } : undefined;
  switch (c.blueprint) {
    case "verified":
      return { ...base, state: "done", detail: "Your pipeline, stages, tags and fields for your industry are in place, and each one was found in your CRM." };
    case "waiting_for_a_person":
      return { ...base, state: "action_required", detail: "A person at iAcquire has to apply your industry starter. Nothing has been added to your CRM yet, and nothing is needed from you." };
    case "failed":
      return { ...base, state: "action_required", detail: summary || "Your industry CRM setup did not finish. iAcquire will review it and apply it again. Nothing is needed from you.", ...(retry ? { action: retry } : {}) };
    case "partial":
      return { ...base, state: "action_required", detail: summary || "Your industry CRM setup was only partly applied. iAcquire will finish it. Nothing is needed from you." };
    case "missing_records":
      return { ...base, state: "action_required", detail: summary || "Some items your CRM setup created are no longer in your CRM. iAcquire will review this with you." };
    case "none": {
      const waiting: LaunchItem = { ...base, state: "in_progress", detail: c.automaticSetup
        ? "Your industry CRM is being set up by iAcquire's automatic setup. Nothing is needed from you."
        : "Your industry CRM is being set up by iAcquire. Nothing is needed from you." };
      // The automatic setup waits for the questionnaire AND the setup fee: until both have happened nothing is late, and it is not iAcquire that is being waited for.
      const waited = started ? waitedPast(clock, c.waitingSince, clock.stall.crm) : null;
      return waited === null || !c.waitingSince ? waiting : stalledItem(waiting, "Setting up your industry CRM", waited, c.waitingSince, c.waitingAlerted, "", retry);
    }
  }
}

function crmRecordsItem(c: LaunchFacts["crm"]): LaunchItem {
  const base = { key: "crm.records", label: "Tags, contact fields and forms", required: false, owner: "iacquire" } as const;
  const r = c.records;
  if (r?.state === "in_place") return { ...base, state: "done", detail: `Your CRM has ${plural(r.tags, "tag", "tags")}, ${plural(r.contactFields, "contact field", "contact fields")} and ${plural(r.forms, "form", "forms")}, and every one your setup created is there.` };
  if (r?.state === "missing") {
    // Missing records and an unverified Industry CRM setup are the same condition on the server, and that setup line is the one that holds launch up: this line must not say the opposite.
    const heldUp = c.blueprint !== "verified" ? "The Industry CRM setup line above is what holds launch up." : "This does not hold up launch.";
    return { ...base, state: "action_required", detail: `Some tags, fields or forms from your setup are missing from your CRM. iAcquire will review this with you. ${heldUp}` };
  }
  return { ...base, state: "in_progress", detail: "Your tags, contact fields and forms arrive with the CRM setup." };
}

/** The currency and phone country that go with the client's time zone. A suggestion the client confirms: optional, never required, and never written by itself. */
function regionItem(c: LaunchFacts["crm"]): LaunchItem | null {
  const r = c.region;
  if (!r) return null;
  const base = { key: "crm.region", label: "Currency and phone country", required: false, owner: "you" } as const;
  const code = `+${r.callingCode}`;
  if (r.state === "matches") return { ...base, state: "done", detail: `Your workspace uses ${r.currency} and ${code} (${r.country}).` };
  const detail = `Your time zone suggests ${r.currency} and ${code} (${r.country}). Quotes, proposals and invoices use the currency, and customers' local phone numbers are read with the country code. Nothing changes until you confirm, and it does not hold up launch.`;
  return r.canConfirm === false
    ? { ...base, state: "action_required", detail: `${detail} Only an owner or admin can confirm it.` }
    : { ...base, state: "action_required", detail, action: { label: `Use ${r.currency} and ${code}`, intent: "confirm_region_defaults" } };
}

/** The client's own sales steps as a pipeline. Optional: it only ever adds a new pipeline, and an existing one is never edited or deleted. */
function pipelineDraftItem(c: LaunchFacts["crm"]): LaunchItem | null {
  const d = c.pipelineDraft;
  if (!d) return null;
  const base = { key: "crm.stages", label: "Your sales steps as pipeline stages", required: false, owner: "you" } as const;
  if (d.state === "applied") return { ...base, state: "done", detail: "Your sales steps are in your CRM as a pipeline." };
  const steps = d.stages.join(", ");
  const detail = `You described these sales steps: ${steps}. A new pipeline called "Your sales process" would be added with them${d.makesDefault ? " and become your default pipeline, because your current one has not been used" : ""}. Your existing pipelines and stages are never edited or deleted, and it does not hold up launch.`;
  return d.canApply === false
    ? { ...base, state: "action_required", detail: `${detail} Only an owner or admin can add it.` }
    : { ...base, state: "action_required", detail, action: { label: "Add my sales steps", intent: "apply_pipeline_stages" } };
}

function crmStep(f: LaunchFacts, clock: Clock): LaunchStep {
  const c = f.crm;
  const items: LaunchItem[] = [];
  if (c.mode === "native") {
    items.push(item(blueprintItem(c, clock, f.submitted && f.paymentCleared !== false)));
    // A pipeline that exists is done whatever the Blueprint says; one that does not exist is waited for while the setup has not run (or is waiting for a person), and reviewed once it has.
    const waiting = c.blueprint === "none" || c.blueprint === "waiting_for_a_person" || c.blueprint === "failed";
    items.push(item(c.pipelineReady
      ? { key: "crm.pipeline", label: "Sales pipeline", state: "done", required: true, owner: "iacquire", detail: "An active pipeline with at least two stages, one of them open, is ready for your leads and deals." }
      : { key: "crm.pipeline", label: "Sales pipeline", state: waiting ? "in_progress" : "action_required", required: true, owner: "iacquire",
        detail: waiting ? "The pipeline arrives with the CRM setup." : "Your CRM has no active pipeline with at least two stages, one of them open. iAcquire needs to review it." }));
    items.push(item(crmRecordsItem(c)));
    const region = regionItem(c);
    if (region) items.push(item(region));
    const stages = pipelineDraftItem(c);
    if (stages) items.push(item(stages));
  } else {
    items.push(item(c.providerConnected
      ? { key: "crm.provider", label: "CRM connection", state: "done", required: true, owner: "iacquire", detail: "Your CRM provider connection is verified." }
      : { key: "crm.provider", label: "CRM connection", state: "in_progress", required: true, owner: "iacquire", detail: "iAcquire links and verifies your CRM. Nothing is needed from you." }));
  }
  return { key: "crm", title: "CRM and pipeline", ...summarize(items) };
}

/** Where the guided setup sends the person after a Google or Microsoft sign-in: back here (the server accepts only this path and the CRM's own pages). */
export const OAUTH_RETURN_TO_SETUP = "/setup";

const oauthStartHref = (provider: "google" | "microsoft") => `/api/crm/calendar-oauth/${provider}/start?return=${OAUTH_RETURN_TO_SETUP}`;
const PROVIDER_NAME = { google: "Google", microsoft: "Microsoft" } as const;
const MEETING_TOOL = { google: "Google Meet", microsoft: "Microsoft Teams" } as const;

/**
 * The button for a missing meeting-tool connection when the facts do not say who is missing it. When the appointment types name exactly one provider, it starts that provider's
 * sign-in and comes back to Setup. When they name both, or the facts do not say, it opens the connections screen, which offers each provider.
 */
function calendarConnectAction(cal: CalendarFacts): LaunchAction {
  const providers = cal.videoProviders ?? [];
  if (providers.length === 1) {
    const provider = providers[0];
    return { label: `Connect ${PROVIDER_NAME[provider]}`, href: oauthStartHref(provider) };
  }
  return { label: "Connect a calendar", href: "/crm/calendar-connections" };
}

/** "Mon to Fri, 9:00 AM to 5:00 PM; Sat, 10:00 AM to 2:00 PM": the weekly hours a client approves, in words, Monday first. Days with the same hours are joined. */
export function summarizeWeeklyHours(rules: ReadonlyArray<{ weekday: number; startMinute: number; endMinute: number }>): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const clock = (m: number) => {
    if (m >= 1440) return "midnight";
    const h = Math.floor(m / 60);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups: Array<{ first: number; last: number; text: string }> = [];
  for (const weekday of order) {
    const ranges = rules.filter((r) => r.weekday === weekday).sort((a, b) => a.startMinute - b.startMinute).map((r) => `${clock(r.startMinute)} to ${clock(r.endMinute)}`);
    if (!ranges.length) continue;
    const text = ranges.join(" and ");
    const prev = groups[groups.length - 1];
    if (prev && prev.text === text && order.indexOf(prev.last) === order.indexOf(weekday) - 1) prev.last = weekday;
    else groups.push({ first: weekday, last: weekday, text });
  }
  return groups.map((g) => `${g.first === g.last ? days[g.first] : `${days[g.first]} to ${days[g.last]}`}, ${g.text}`).join("; ");
}

const namesOf = (people: ReadonlyArray<{ name: string }>) => {
  const n = people.map((p) => p.name);
  return n.length <= 3 ? n.join(", ") : `${n.slice(0, 3).join(", ")} and ${n.length - 3} more`;
};

/** What the calendar step says while the questionnaire or the setup payment is still outstanding: the buttons wait, because every one of them would be refused. */
function calendarGate(f: LaunchFacts): string | null {
  if (!f.submitted) return "This opens once you have submitted your company information.";
  if (f.paymentCleared === false) return "This opens once your setup payment is confirmed.";
  return null;
}

function hostItem(f: LaunchFacts, cal: CalendarFacts, gate: string | null, manage: boolean, ask: string): LaunchItem {
  const a = f.appointments;
  const base = { key: "calendar.host", label: "Host", required: true, owner: "you" } as const;
  const invited = (a.teamHosts ?? []).filter((t) => t.state === "invited");
  if (cal.hosts > 0) {
    return { ...base, state: "done", detail: `${plural(cal.hosts, "person takes", "people take")} appointments on this calendar.${a.hostChoice === "team" && invited.length ? ` Still waiting for ${namesOf(invited)} to accept their invitation.` : ""}` };
  }
  const choices = manage && !gate && cal.hostChoices?.length ? { hostChoices: cal.hostChoices } : {};
  const makeMe: LaunchAction = { label: "Make me the host", intent: "assign_host" };
  if (gate) return { ...base, state: "action_required", detail: `Choose who takes your appointments. ${gate}` };
  if (!manage) return { ...base, state: "action_required", detail: `Nobody takes your appointments yet. Only someone who sets up calendars can choose a host. ${ask}` };
  if (a.hostChoice === "team") {
    const team = a.teamHosts ?? [];
    if (invited.length) {
      return { ...base, state: "in_progress", ...choices, detail: `You said a team member takes these appointments. Waiting for ${namesOf(invited)} to accept their invitation. They join as a host with no hours, and you approve their hours next. You can also choose a host now.` };
    }
    return { ...base, state: "action_required", ...choices,
      detail: team.length
        ? `You said a team member takes these appointments. Invite ${namesOf(team)} from Team settings, and they join as a host once they accept. You can also choose a host now.`
        : "You said a team member takes these appointments, but no one is marked as taking them yet. Mark them in your company setup and invite them, or choose a host now.",
      action: team.length ? { label: "Open Team settings", href: "/settings/team" } : { label: "Mark who takes appointments", href: "/onboarding" } };
  }
  if (a.hostChoice === "owner") {
    return { ...base, state: "action_required", ...choices, detail: "You said you take these appointments yourself, but this calendar has no host yet. Confirm it here, or choose someone else. We never pick a host for you.", action: makeMe };
  }
  return { ...base, state: "action_required", ...choices, detail: "Choose who takes your appointments. We never pick a host for you.", action: makeMe };
}

function hoursItem(cal: CalendarFacts, gate: string | null, manage: boolean, ask: string): LaunchItem {
  const base = { key: "calendar.hours", label: "Host availability", required: true, owner: "you" } as const;
  if (cal.hosts === 0) return { ...base, state: "in_progress", detail: "Set after you choose a host. We never invent working hours." };
  if (cal.hostsWithHours >= cal.hosts) return { ...base, state: "done", detail: "Every host has weekly hours saved." };
  const missing = cal.hosts - cal.hostsWithHours;
  const who = cal.hostsNeedingHours?.length ? namesOf(cal.hostsNeedingHours) : plural(missing, "host", "hosts");
  const lack = `${who} ${missing === 1 ? "has" : "have"} no weekly hours yet.`;
  if (gate) return { ...base, state: "action_required", detail: `${lack} ${gate}` };
  if (!manage) return { ...base, state: "action_required", detail: `${lack} Only someone who sets up calendars can approve hours. ${ask}` };
  if (cal.hasSuggestedHours) {
    const s = cal.suggestedHours;
    return s
      ? { ...base, state: "action_required", detail: `${lack} Your answers suggest: ${s.summary}. Nothing is saved until you approve exactly these hours, or you can set your own.`, action: { label: "Approve these hours", intent: "apply_hours", params: { hoursDigest: s.digest } } }
      : { ...base, state: "action_required", detail: `${lack} Approve the hours from your company setup, or set your own.`, action: { label: "Approve suggested hours", intent: "apply_hours" } };
  }
  return { ...base, state: "action_required", detail: `${lack} Set them in Availability.`, action: { label: "Set hours", href: "/crm/availability" } };
}

/** The Google or Microsoft connection a video appointment needs, judged per host: only a connected account that can add events satisfies it, and only its owner can connect it. */
function connectionItem(f: LaunchFacts, cal: CalendarFacts, manage: boolean): LaunchItem | null {
  const a = f.appointments;
  if (!cal.needsVideoConnection) return null;
  const providers = cal.videoProviders ?? [];
  const hosts = cal.hostConnections;
  const base = { key: "calendar.connection", label: "Google or Microsoft connection", required: true, owner: "you" } as const;
  if (!hosts || !providers.length) {
    // Older facts say only whether any connection exists.
    return a.externalCalendarConnected ? null : { ...base, state: "action_required", detail: "A video appointment needs a connected Google or Microsoft account to make the meeting link.", action: calendarConnectAction(cal) };
  }
  if (!hosts.length) return { ...base, state: "in_progress", detail: "Video links are made through each host's own connected Google or Microsoft account. Choose a host first." };
  const missing = providers.map((provider) => ({ provider, hosts: hosts.filter((h) => !h.meet[provider]) })).filter((m) => m.hosts.length);
  if (!missing.length) return null;
  const detail = missing.map((m) => `${MEETING_TOOL[m.provider]} links are made through each host's own connected ${PROVIDER_NAME[m.provider]} account, which ${namesOf(m.hosts)} ${m.hosts.length === 1 ? "has" : "have"} not connected yet.`).join(" ");
  const first = missing[0];
  if (cal.oauthAvailable && cal.oauthAvailable[first.provider] === false) {
    return { ...base, state: "action_required", owner: "iacquire", detail: `${detail} ${PROVIDER_NAME[first.provider]} sign-in is not switched on for your workspace yet, so iAcquire has to set that up first. Or choose "I send my own link" in the appointment type.` };
  }
  if (first.hosts.some((h) => h.viewer)) return { ...base, state: "action_required", detail, action: { label: `Connect ${PROVIDER_NAME[first.provider]}`, href: oauthStartHref(first.provider) } };
  return { ...base, state: "action_required", detail: `${detail} Each person connects their own account, so ${manage ? "ask them to open Setup and connect it" : "they need to open Setup and connect it"}.` };
}

/** "Existing events in my Google or Microsoft calendar block times": required only when the client said they use one, and done only when a host's calendar is being read for busy times. */
function busyItem(cal: CalendarFacts): LaunchItem | null {
  const stated = cal.busyProvider;
  const base = { key: "calendar.busy", label: "Existing calendar blocks times", owner: "you" } as const;
  if (stated === "none") return { ...base, state: "not_applicable", required: false, detail: "You said you do not keep appointments in Google Calendar or Microsoft 365, so nothing needs connecting for busy times." };
  if (stated !== "google" && stated !== "microsoft") return null;
  const account = stated === "google" ? "Google Calendar" : "Microsoft 365 calendar";
  const hosts = cal.hostConnections;
  if (!hosts) return null;
  if (!hosts.length) return { ...base, state: "in_progress", required: true, detail: `You said your events in ${account} must block times. Choose a host first; then their ${account} is connected.` };
  if (hosts.some((h) => h.busy[stated])) return { ...base, state: "done", required: true, detail: `A connected ${account} is read for busy times, so your existing events block times.` };
  const detail = `You said your events in ${account} must block times, but no host has connected one that is being read yet, so a customer could be offered a time you are already busy.`;
  if (cal.oauthAvailable && cal.oauthAvailable[stated] === false) return { ...base, state: "action_required", required: true, owner: "iacquire", detail: `${detail} ${PROVIDER_NAME[stated]} sign-in is not switched on for your workspace yet, so iAcquire has to set that up first.` };
  if (hosts.some((h) => h.viewer)) return { ...base, state: "action_required", required: true, detail, action: { label: `Connect ${PROVIDER_NAME[stated]}`, href: oauthStartHref(stated) } };
  return { ...base, state: "action_required", required: true, detail: `${detail} Each person connects their own account, so a host has to open Setup and connect it.` };
}

function calendarStep(f: LaunchFacts): LaunchStep {
  const a = f.appointments;
  const title = "Calendar and availability";
  if (a.wanted === false) {
    return { key: "calendar", title, state: "not_applicable", summary: "You said you do not book appointments, so no calendar is needed.", items: [item({ key: "calendar.not_needed", label: "Booking calendar", state: "not_applicable", required: false, owner: "you", detail: "Not needed for your business. If that changes, say so in your company setup." })] };
  }
  if (a.wanted === null) {
    return { key: "calendar", title, ...summarize([item({ key: "calendar.question", label: "Appointments", state: "action_required", required: true, owner: "you", detail: "Tell us whether your business books appointments.", action: { label: "Answer in company setup", href: "/onboarding" } })]) };
  }
  if (f.crm.mode !== "native") {
    return { key: "calendar", title, ...summarize([item(a.externalCalendarConnected
      ? { key: "calendar.external", label: "Booking calendar", state: "done", required: true, owner: "iacquire", detail: "Your calendar connection is verified." }
      : { key: "calendar.external", label: "Booking calendar", state: "in_progress", required: true, owner: "iacquire", detail: "iAcquire connects and verifies your calendar. Nothing is needed from you." })]) };
  }
  const cal = a.calendar;
  if (!cal) {
    return { key: "calendar", title, ...summarize([item({ key: "calendar.draft", label: "Booking calendar", state: "action_required", required: true, owner: "you", detail: "No booking calendar exists yet. Create one with your appointment types.", action: { label: "Open Calendars & Types", href: "/crm/calendars" } })]) };
  }
  const gate = calendarGate(f);
  // Setting up calendars needs the calendar permission: a person without it is told who to ask, and is given no button that would only be refused.
  const manage = cal.canManage !== false;
  const ask = `Ask ${cal.ownerName?.trim() || "a workspace owner"}.`;
  const failed = (key: CalendarCheckFact["key"]) => cal.checks?.find((c) => c.key === key && !c.ok) ?? null;
  const items: LaunchItem[] = [];
  items.push(item(hostItem(f, cal, gate, manage, ask)));
  items.push(item(hoursItem(cal, gate, manage, ask)));
  items.push(item(cal.types > 0
    ? { key: "calendar.types", label: "Appointment types", state: "done", required: true, owner: "you", detail: `${plural(cal.types, "appointment type is", "appointment types are")} ready to book.` }
    : { key: "calendar.types", label: "Appointment types", state: "action_required", required: true, owner: "you", detail: manage ? "Add at least one appointment type." : `Add at least one appointment type. ${ask}`, ...(manage ? { action: { label: "Open Calendars & Types", href: `/crm/calendars/${cal.id}` } } : {}) }));
  // Every type the client listed has to be bookable, not just one: the activation check passes with a single open time, so the types without one are named here.
  const slotOk = cal.checks !== null && !failed("slot");
  if (slotOk && cal.typesWithoutTimes?.length) {
    items.push(item({ key: "calendar.type_times", label: "Every appointment type has an open time", state: "action_required", required: true, owner: "you",
      detail: `No open time was found in the next two weeks for ${namesOf(cal.typesWithoutTimes.map((name) => ({ name })))}. Check the hosts' hours, and the notice and booking window of ${cal.typesWithoutTimes.length === 1 ? "that type" : "those types"}.`,
      ...(manage ? { action: { label: "Open Calendars & Types", href: `/crm/calendars/${cal.id}` } } : {}) }));
  }
  const connection = connectionItem(f, cal, manage);
  if (connection) items.push(item(connection));
  const busy = busyItem(cal);
  if (busy) items.push(item(busy));
  // A video appointment that tells the customer nothing about how to join: no meeting tool and no words of the client's own.
  if (cal.typesWithoutJoinInfo?.length) {
    const n = cal.typesWithoutJoinInfo.length;
    items.push(item({ key: "calendar.own_link", label: "How customers join video appointments", state: "action_required", required: true, owner: "you",
      detail: `${namesOf(cal.typesWithoutJoinInfo.map((name) => ({ name })))} ${n === 1 ? "is a video appointment" : "are video appointments"} with no meeting tool and no link. Choose Google Meet or Microsoft Teams, or write how you send the link, in the appointment type. We never make one up.`,
      ...(manage ? { action: { label: "Add the meeting link", href: `/crm/calendars/${cal.id}` } } : {}) }));
  }
  // The checks that need everything above: shown once there is a host, read live, never remembered.
  const slot = failed("slot");
  const others = (["timezone", "connections"] as const).map(failed).filter((c): c is CalendarCheckFact => c !== null);
  if (cal.status === "active") {
    items.push(item({ key: "calendar.verified", label: "Real open time verified", state: slot ? "failed" : "done", required: true, owner: "you", detail: slot ? slot.detail : "A real open time was found within the next two weeks." }));
    // An active calendar is held to every check, every time it is read: a host who paused, lost their hours or disconnected is a failing line, never a quiet "Done".
    const open = (keys: string[]) => items.some((i) => keys.includes(i.key) && i.state !== "done" && i.state !== "not_applicable");
    const covered: Record<string, boolean> = {
      hosts: cal.hosts === 0,
      hours: cal.hosts === 0 || cal.hostsWithHours < cal.hosts,
      types: cal.types === 0,
      timezone: false,
      connections: open(["calendar.connection", "calendar.busy", "calendar.own_link"]),
    };
    const fix: Record<string, LaunchAction | undefined> = {
      hours: manage ? { label: "Review hours", href: "/crm/availability" } : undefined,
      timezone: manage ? { label: "Set time zone", href: "/crm/availability" } : undefined,
      types: manage ? { label: "Open Calendars & Types", href: `/crm/calendars/${cal.id}` } : undefined,
      connections: manage ? { label: "Review connections", href: "/crm/calendar-connections" } : undefined,
    };
    const label: Record<string, string> = { hosts: "Hosts", hours: "Working hours", timezone: "Time zones", types: "Appointment types", connections: "Calendar connections" };
    for (const key of ["hosts", "hours", "timezone", "types", "connections"] as const) {
      const c = failed(key);
      if (!c || covered[key]) continue;
      const action = fix[key];
      items.push(item({ key: `calendar.check.${key}`, label: `${label[key]} check`, state: "action_required", required: true, owner: "you", detail: manage ? c.detail : `${c.detail} ${ask}`, ...(action ? { action } : {}) }));
    }
    // The checks could not be read right now, but the re-check recorded that this calendar stopped passing after it was activated: say so, one line per failing check, instead of a quiet "Done".
    if (cal.checks === null && cal.drift?.checks.length) items.push(...driftItems(cal, manage, ask).map(item));
    items.push(item({ key: "calendar.active", label: "Calendar active", state: "done", required: true, owner: "you", detail: "The calendar is active. Its booking page stays off until you turn it on." }));
  } else if (cal.hosts > 0 && cal.hostsWithHours >= cal.hosts && cal.types > 0) {
    const problem = slot ?? others[0] ?? null;
    items.push(item({ key: "calendar.verified", label: "Real open time verified", state: problem ? "action_required" : cal.checks ? "done" : "in_progress", required: true, owner: "you",
      detail: problem ? (manage ? problem.detail : `${problem.detail} ${ask}`) : cal.checks ? "A real open time was found within the next two weeks." : "Run the checks to prove a real time would be offered.",
      ...(problem && manage ? { action: { label: problem.key === "connections" ? "Review connections" : "Review hours", href: problem.key === "connections" ? "/crm/calendar-connections" : "/crm/availability" } } : {}) }));
    items.push(item(gate || !manage
      ? { key: "calendar.active", label: "Calendar active", state: "action_required", required: true, owner: "you", detail: gate ?? `Check and activate the calendar. Only someone who sets up calendars can do it. ${ask}` }
      : { key: "calendar.active", label: "Calendar active", state: "action_required", required: true, owner: "you", detail: "Check and activate the calendar. This does not turn on a public booking page.", action: { label: "Check and activate", intent: "activate_calendar" } }));
  } else {
    items.push(item({ key: "calendar.verified", label: "Real open time verified", state: "in_progress", required: true, owner: "you", detail: "Runs after a host, weekly hours and an appointment type are in place." }));
    items.push(item({ key: "calendar.active", label: "Calendar active", state: "in_progress", required: true, owner: "you", detail: "Activation follows the checks. The calendar takes no bookings until then." }));
  }
  // A page that is on while the calendar fails a check can offer a customer a time nobody can keep: that is a failure, and it holds up launch until the page is off or the check passes.
  const failing = cal.checks?.find((c) => !c.ok) ?? null;
  items.push(item(cal.bookingPageOn && failing
    ? { key: "calendar.public", label: "Public booking page", state: "failed", required: true, owner: "you", detail: `Your public booking page is on, but the calendar does not pass its checks: ${failing.detail} Fix it, or turn the page off until it does.${manage ? "" : ` ${ask}`}`,
        ...(manage ? { action: { label: "Open Calendars & Types", href: `/crm/calendars/${cal.id}` } } : {}) }
    : { key: "calendar.public", label: "Public booking page", state: "done", required: false, owner: "you", detail: cal.bookingPageOn ? "Your public booking page is on." : "Your public booking page is off. Customers cannot book until you turn it on yourself." }));
  const rules = bookingRulesItem(f.bookingSettings);
  if (rules) items.push(item(rules));
  return { key: "calendar", title, ...summarize(items) };
}

const DRIFT_LABEL: Record<string, string> = { hosts: "Hosts", hours: "Working hours", timezone: "Time zones", types: "Appointment types", connections: "Calendar connections", slot: "Open times" };

/**
 * What the calendar's re-check recorded after activation (CalendarFacts.drift): one required line per failing check, in the check's own client-safe words. The owner is the client
 * unless the fix is iAcquire's (a connection whose sign-in is not switched on here). A key this judge does not know is still a line, never dropped.
 */
function driftItems(cal: CalendarFacts, manage: boolean, ask: string): LaunchItem[] {
  const drift = cal.drift?.checks ?? [];
  return drift.slice(0, 6).map((c): LaunchItem => {
    const label = DRIFT_LABEL[c.key] ?? "Calendar check";
    const iacquire = c.key === "connections" && cal.oauthAvailable !== undefined && !cal.oauthAvailable.google && !cal.oauthAvailable.microsoft;
    const hours = c.key === "hours" || c.key === "timezone" || c.key === "slot";
    const href = c.key === "connections" ? "/crm/calendar-connections" : hours ? "/crm/availability" : `/crm/calendars/${cal.id}`;
    const words = `This calendar passed its checks when it was activated, and no longer does: ${c.detail.trim()}`;
    return {
      key: `calendar.drift.${c.key}`, label: `${label} changed after activation`, state: "action_required", required: true, owner: iacquire ? "iacquire" : "you",
      detail: iacquire ? `${words} iAcquire has to switch on the sign-in this needs.` : manage ? words : `${words} ${ask}`,
      ...(!iacquire && manage ? { action: { label: c.key === "connections" ? "Review connections" : hours ? "Review hours" : "Open Calendars & Types", href } } : {}),
    };
  });
}

/** What happens after someone books, in the client's own settings, in words. Informational: a summary of saved rules, never a check, never required. */
function bookingRulesItem(b: LaunchFacts["bookingSettings"]): LaunchItem | null {
  if (!b) return null;
  const late = b.lateCancelHours === null ? "No late-cancellation rule is set." : `A cancellation less than ${plural(b.lateCancelHours, "hour", "hours")} before the start counts as late.`;
  const ai = b.aiBookingEnabled ? "AI Growth Partner may book on its own, because you turned that on." : "AI Growth Partner proposes a booking, and a person confirms it.";
  const reminders = b.remindersEnabled ? "Reminders to customers are on." : "Reminders to customers are off until you turn them on.";
  return { key: "calendar.booking_settings", label: "Booking rules", state: "done", required: false, owner: "you", detail: `${ai} ${late} ${reminders}`, action: { label: "Review booking rules", href: "/appointments" } };
}

const CHANNEL_LABEL: Record<ChannelFact["channel"], string> = { sms: "SMS", whatsapp: "WhatsApp", email: "Email" };
/** Where a client sees each channel's status. Setting a channel up (the credential, the provider test, switching it on) is iAcquire's job, so nothing here is a "connect" button. */
const CHANNEL_HREF: Record<ChannelFact["channel"], string> = { sms: "/settings/messaging", whatsapp: "/settings/messaging", email: "/settings/messaging" };
const CHANNEL_SENDER_NOUN: Record<ChannelFact["channel"], string> = { sms: "text number", whatsapp: "WhatsApp number", email: "sending address" };

/**
 * What the client's own part of connecting a channel involves, in plain words. Guidance only: it describes the outside steps and proves nothing, so it is never a state and
 * never makes a channel look connected. The panel shows it only for a channel the client said they want that is not connected yet.
 */
export function connectionSteps(channel: ChannelFact["channel"]): string[] {
  switch (channel) {
    case "email":
      return ["iAcquire sends you the DNS records for your sending domain. You add them where your domain is managed.", "Nothing is sent from your domain until iAcquire has verified it."];
    case "sms":
      return ["Confirm the business details iAcquire needs to register your number with the carrier.", "Approve the registration and number fees iAcquire tells you about before anything is charged.", "Texts start only after the carrier approves the registration."];
    case "whatsapp":
      return ["Have an approved Meta (Facebook) Business account for your company.", "iAcquire connects your WhatsApp Business number once Meta approves it.", "Nothing is sent on WhatsApp until the connection is verified."];
  }
}

export function channelIsReady(c: Pick<ChannelFact, "channel" | "enabled" | "registration">): boolean {
  if (!c.enabled) return false;
  // Email has no registration; SMS and WhatsApp count once their carrier registration is approved (the database refuses to enable them otherwise).
  return c.channel === "email" || c.registration === "approved" || c.registration === "not_required";
}

function integrationsStep(f: LaunchFacts): LaunchStep {
  const wanted = f.channels.filter((c) => c.wanted);
  if (!wanted.length) {
    return { key: "integrations", title: "Required integrations", state: "not_applicable", summary: "You have not asked for a customer channel, so nothing needs connecting yet.", items: [item({ key: "integrations.none", label: "Customer channels", state: "not_applicable", required: false, owner: "you", detail: "Email, SMS and WhatsApp are connected only when you choose them in your company setup." })] };
  }
  return { key: "integrations", title: "Required integrations", ...summarize(wanted.map((c) => item(channelItem(c)))) };
}

/**
 * One customer channel the client asked for. The split of who moves next follows who can: the client gives the sender and any carrier or Meta paperwork; iAcquire stores the
 * provider credential, runs the provider's test and switches the channel on, so those are never a button for the client. What the client wrote as their sender is shown as what
 * they said and never makes the channel look connected: only the recorded provider test and an approved registration do (channelIsReady).
 */
function channelItem(c: ChannelFact): LaunchItem {
  const key = `integrations.${c.channel}`;
  const label = CHANNEL_LABEL[c.channel];
  if (channelIsReady(c)) return { key, label, state: "done", required: true, owner: "iacquire", detail: `${label} is connected and verified.` };
  const stated = c.statedSender?.trim() ? ` You told us your ${CHANNEL_SENDER_NOUN[c.channel]}: ${c.statedSender.trim()}. iAcquire still verifies it.` : "";
  const guidance = connectionSteps(c.channel);
  if (c.registration === "rejected") {
    return { key, label, state: "action_required", required: true, owner: "you", guidance,
      detail: `${label} registration was rejected. Review the details with iAcquire and send them again. Nothing is sent until it is approved.${stated}`,
      action: { label: "See channel status", href: CHANNEL_HREF[c.channel] } };
  }
  // A text number can be left blank in the questionnaire (iAcquire helps get one); an email address or a WhatsApp number cannot be connected without the client's own.
  if (c.statedSender === null && c.channel !== "sms") {
    return { key, label, state: "action_required", required: true, owner: "you", guidance,
      detail: `Tell us which ${CHANNEL_SENDER_NOUN[c.channel]} to use. iAcquire connects and verifies it, and nothing is sent until it is verified.`,
      action: { label: "Add your sender", href: "/onboarding" } };
  }
  if (c.registration === "pending") {
    return { key, label, state: "in_progress", required: true, owner: "iacquire", guidance,
      detail: `${label} registration is with ${c.channel === "whatsapp" ? "Meta" : "the carrier"}, and iAcquire is following it. Nothing is sent until it is approved.${stated}` };
  }
  return { key, label, state: "in_progress", required: true, owner: "iacquire", guidance,
    detail: c.credentialStored
      ? `iAcquire has saved the credentials for ${label} and still has to test it and switch it on. Nothing is sent until it is verified and switched on.${stated}`
      : `iAcquire connects, tests and switches on your ${label} sender. Nothing is sent until it is verified.${stated}` };
}

/** A profile job that is still open and has waited past the provisioning threshold. Only the job states that mean "somebody is on it" can stall: not started and cancelled never do. */
function stalledProvisioning(i: LaunchItem, e: EmployeeFact, clock: Clock): LaunchItem {
  const open = e.provisioning === "requested" || e.provisioning === "in_progress" || e.provisioning === "awaiting_health_check" || e.provisioning === "retrying" || (e.capacityHeld === true && e.provisioning === "failed");
  if (!e.startedAt || !open) return i;
  const waited = waitedPast(clock, e.startedAt, clock.stall.provisioning);
  if (waited === null) return i;
  const what = e.capacityHeld ? "Waiting for room to set up its profile" : "Setting up its profile";
  return stalledItem(i, what, waited, e.startedAt, e.stallAlerted, e.leaseExpired ? " Nothing is working on it right now." : "");
}

const STAGE_LABEL: Record<LaunchStage["key"], string> = { queued: "Queued", profile: "Profile created", verified: "Connection verified", tools: "Tools verified", ready: "Ready for work" };

/**
 * The path of one employee's setup, from what is stored: a profile job exists, the profile was created, the connection check passed, the tool inventory was recorded, and the
 * role has what it needs. Every stage is judged on its own evidence and then made consistent with the later ones: a stage that has later evidence is done too, so a later stage is
 * never done while an earlier one is not. A queued job is not a created profile: only a job that reached the health check or finished says the profile exists. The first stage that
 * is not done carries the current state (under way, failed or waiting on something) and every stage after it has not been reached. Not part of the plan: no stages.
 */
export function employeeStages(f: Pick<LaunchFacts, "appointments">, e: EmployeeFact): LaunchStage[] | undefined {
  if (!e.entitled || (e.role === "appointment_setter" && f.appointments.wanted === false)) return undefined;
  const step = (key: string) => e.readinessSteps?.find((s) => s.key === key)?.state;
  const verified = step("connection") ? step("connection") === "done" : e.readiness.chatAvailable;
  const tools = step("inventory") ? step("inventory") === "done" : e.readiness.chatAvailable;
  const ready = e.readiness.workReady;
  const profile = e.provisioning === "awaiting_health_check" || e.provisioning === "succeeded" || verified || tools || ready;
  const queued = e.provisioning !== "none" && e.provisioning !== "cancelled" || profile;
  const reached: Array<[LaunchStage["key"], boolean]> = [["queued", queued], ["profile", profile], ["verified", verified || tools || ready], ["tools", tools || ready], ["ready", ready]];
  const firstOpen = reached.findIndex(([, done]) => !done);
  return reached.map(([key, done], index): LaunchStage => {
    const label = STAGE_LABEL[key];
    if (done) return { key, label, state: "done" };
    if (index > firstOpen) return { key, label, state: "pending" };
    return { key, label, state: currentStageState(key, e) };
  });
}

/** The state of the stage an employee is at: what is happening to it right now, said from the same facts the item uses. */
function currentStageState(key: LaunchStage["key"], e: EmployeeFact): StageState {
  switch (key) {
    case "queued": return "pending";
    case "profile":
      if (e.capacityHeld) return "pending";
      if (e.provisioning === "failed") return "failed";
      return e.provisioning === "in_progress" || e.provisioning === "retrying" ? "in_progress" : "pending";
    case "verified": return e.healthFailed ? "failed" : "in_progress";
    case "tools": return "in_progress";
    case "ready": return e.readiness.blocking.length ? "action_required" : "in_progress";
  }
}

function employeeItem(f: LaunchFacts, e: EmployeeFact, clock: Clock): LaunchItem {
  const found = employeeItemNow(f, e);
  const judged = found.state === "in_progress" ? stalledProvisioning(found, e, clock) : found;
  const stages = employeeStages(f, e);
  return stages ? { ...judged, stages } : judged;
}

function employeeItemNow(f: LaunchFacts, e: EmployeeFact): LaunchItem {
  const meta = AGENT_BY_KEY[e.role];
  const key = `employees.${e.role}`;
  const label = meta.shortName;
  if (!e.entitled) return { key, label, state: "not_applicable", required: false, owner: "iacquire", detail: "Not part of your current plan, so it does not hold up launch." };
  if (e.role === "appointment_setter" && f.appointments.wanted === false) return { key, label, state: "not_applicable", required: false, owner: "you", detail: "You do not book appointments, so this retained profile has nothing to prepare yet." };
  if (e.readiness.workReady) return { key, label, state: "done", required: true, owner: "system", detail: "Its retained profile, identity, tools and connection are verified, and what its role needs from your business is in place." };
  if (f.paymentCleared === false && e.provisioning === "none") {
    return { key, label, state: "action_required", required: true, owner: "you", detail: "Starts after your setup payment is confirmed.", ...(f.canOpenBilling ? { action: { label: "Open billing", href: "/settings/billing" } } : {}) };
  }
  if (e.heldForReview) return { key, label, state: "awaiting_review", required: true, owner: "iacquire", detail: "A configuration change is waiting for iAcquire's review. Nothing runs on it until it is approved." };
  // The runtime is full: nothing failed and nothing is needed from the client. It is iAcquire's to make room, and the setup starts by itself once there is. Said before a failure,
  // because a worker that answered "no room" is a hold, not a broken profile.
  if (e.capacityHeld && (e.provisioning === "requested" || e.provisioning === "retrying" || e.provisioning === "failed")) {
    return { key, label, state: "in_progress", required: true, owner: "iacquire", detail: "Waiting for capacity (iAcquire). The system that hosts existing profiles is at its limit, so setting up this profile is on hold until iAcquire makes room. Nothing has failed and nothing is needed from you." };
  }
  // The attempt count is what the job recorded; the raw failure note and the check's own words are for iAcquire and are never put in front of the client.
  if (e.provisioning === "failed") {
    const used = e.attempts > 0 ? ` (${e.attempts} of ${e.maxAttempts} attempts used)` : "";
    return { key, label, state: "failed", required: true, owner: "iacquire", detail: `Setting up its profile did not finish${used}. iAcquire can review it and retry. Nothing is needed from you.` };
  }
  if (e.provisioning === "retrying") {
    const next = Math.min(e.attempts + 1, e.maxAttempts);
    return { key, label, state: "in_progress", required: true, owner: "system", detail: `Attempt ${next} of ${e.maxAttempts}: setting up its profile hit a temporary problem and is being tried again automatically. Nothing is needed from you, and iAcquire is told if it does not recover.` };
  }
  if (e.provisioning === "requested") return { key, label, state: "in_progress", required: true, owner: "system", detail: "Its dedicated profile is queued. It is not ready until its identity and tools are verified." };
  if (e.provisioning === "in_progress") return { key, label, state: "in_progress", required: true, owner: "system", detail: "Its dedicated profile is being created. Verification has not passed yet." };
  // A check that ran and did not pass is a failure someone has to look at, never "being verified": waiting stays in progress only while no check has failed.
  if (e.healthFailed) return { key, label, state: "action_required", required: true, owner: "iacquire", detail: "Its profile exists, but its last connection check did not pass, so it is not ready. iAcquire can review it and retry. Nothing is needed from you." };
  if (e.provisioning === "awaiting_health_check") return { key, label, state: "in_progress", required: true, owner: "system", detail: "Its profile exists. Its connection and tool inventory are being verified." };
  if (e.readiness.chatAvailable && e.readiness.blocking.length) {
    return { key, label, state: "action_required", required: true, owner: "you", detail: `Verified and waiting for what its role needs: ${e.readiness.blocking.join("; ")}.` };
  }
  if (e.provisioning === "cancelled" || e.provisioning === "none") return { key, label, state: "in_progress", required: true, owner: "iacquire", detail: "Not started. iAcquire will start it once setup allows." };
  return { key, label, state: "action_required", required: true, owner: "iacquire", detail: e.readiness.description };
}

/**
 * Required, and present only while an employee is behind: an AI team that runs on older answers than the ones the client approved is not ready, whatever its checks say. It names the
 * employees. The button brings them up to date through the same review as a submission (a change that needs review still waits for it, and the line says so afterwards), and it
 * waits behind the client's own unapproved edits, which are not yet what the workspace runs on.
 */
function employeesInSyncItem(f: LaunchFacts): LaunchItem | null {
  const behind = (f.employeesBehind ?? []).filter((b) => f.employees.find((e) => e.role === b.role)?.entitled !== false);
  if (!behind.length) return null;
  const names = namesOf(behind.map((b) => ({ name: AGENT_BY_KEY[b.role].shortName })));
  const base = { key: "employees.in_sync", label: "Retained profiles match your setup", required: true, owner: "you" } as const;
  const lead = `${names} ${behind.length === 1 ? "has" : "have"} not been updated to what you approved, so ${behind.length === 1 ? "it still works" : "they still work"} from older information.`;
  if (f.pendingAnswerChanges) {
    return { ...base, state: "action_required", detail: `${lead} Approve your changes in company setup first; your retained profiles are updated from what you approve.`, action: { label: "Review and approve your changes", href: "/onboarding" } };
  }
  // The same opening as the calendar steps: nothing is changed in the workspace before the questionnaire is submitted and the setup payment is confirmed.
  const gate = calendarGate(f);
  if (gate) return { ...base, state: "action_required", detail: `${lead} ${gate}` };
  if (f.canSyncEmployees === false) return { ...base, state: "action_required", detail: `${lead} Only an owner or admin can update these profiles.` };
  return { ...base, state: "action_required", detail: `${lead} Updating changes nothing you wrote yourself, and a change that needs iAcquire's review waits for it.`, action: { label: "Update retained profiles", intent: "sync_employees" } };
}

function growthPartnerStep(partner: NonNullable<LaunchFacts["growthPartner"]>): LaunchStep {
  const brain: LaunchItem = partner.brainActive
    ? { key: "growth_partner.brain", label: "Business Brain", state: "done", required: true, owner: "system", detail: `Your onboarding answers are saved in active version ${partner.latestBrainVersion}. Unknown or unconfirmed facts stay out of the active knowledge.` }
    : { key: "growth_partner.brain", label: "Business Brain", state: "action_required", required: true, owner: "iacquire", detail: "The submitted business information has not been activated as a Business Brain yet. iAcquire needs to review setup." };
  const conversation: LaunchItem = partner.conversationReady
    ? { key: "growth_partner.conversation", label: "Permanent conversation", state: "done", required: true, owner: "system", detail: "The partner's one shared conversation is ready for authorized workspace members." }
    : partner.runtimeReady
      ? { key: "growth_partner.conversation", label: "Permanent conversation", state: "action_required", required: true, owner: "iacquire", detail: "The runtime passed its checks but the permanent conversation is not available yet. iAcquire needs to review setup." }
      : { key: "growth_partner.conversation", label: "Permanent conversation", state: "in_progress", required: true, owner: "system", detail: "The one permanent conversation opens after the dedicated runtime passes its checks." };
  return { key: "employees", title: "AI Growth Partner", ...summarize([item(brain), item(conversation)]) };
}

function employeesStep(f: LaunchFacts, clock: Clock): LaunchStep {
  const byRole = new Map(f.employees.map((e) => [e.role, e]));
  // A role with no record at all is an employee that was never created: that is something iAcquire must look at, never a quiet "not applicable".
  const missing = (role: AgentRoleKey): EmployeeFact => ({ role, entitled: true, provisioning: "succeeded", provisioningDetail: null, attempts: 0, maxAttempts: 3, nextRetryAt: null, healthFailed: false, healthDetail: null, readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "This employee has not been created. iAcquire needs to review the workspace.", blocking: [] }, heldForReview: false, configVersion: null });
  const items = AGENT_ROLE_KEYS.map((role) => employeeItem(f, byRole.get(role) ?? missing(role), clock));
  const inSync = employeesInSyncItem(f);
  if (inSync) items.push(inSync);
  const title = "Retained profile setup";
  return { key: "employees", title, ...summarize(items) };
}

function verificationStep(f: LaunchFacts, clock: Clock): LaunchStep {
  if (f.growthPartner) {
    const partner = f.growthPartner;
    const verification: LaunchItem = partner.runtimeReady
      ? { key: "growth_partner.runtime", label: "Runtime identity and tool checks", state: "done", required: true, owner: "system", detail: "The dedicated profile, identity, permitted tools and connection have passed their live checks." }
      : partner.healthFailed
        ? { key: "growth_partner.runtime", label: "Runtime identity and tool checks", state: "action_required", required: true, owner: "iacquire", detail: "The latest profile or tool check did not pass. iAcquire can review the recorded result and retry." }
        : partner.provisioning === "failed"
          ? { key: "growth_partner.runtime", label: "Runtime identity and tool checks", state: "action_required", required: true, owner: "iacquire", detail: "Preparing the dedicated profile did not finish. iAcquire can review the setup request and retry." }
          : partner.status === "paused"
            ? { key: "growth_partner.runtime", label: "Runtime identity and tool checks", state: "action_required", required: true, owner: "iacquire", detail: "The AI Growth Partner is paused. iAcquire needs to review its runtime state before work resumes." }
            : { key: "growth_partner.runtime", label: "Runtime identity and tool checks", state: "in_progress", required: true, owner: "iacquire", detail: partner.profileConnected ? "The profile is linked; its identity, tools and connection still need a passing check." : "iAcquire is preparing a dedicated profile for your workspace." };
    return { key: "verification", title: "Partner verification", ...summarize([item(verification)]) };
  }
  const verification = new Map(f.verification.map((v) => [v.role, v]));
  const employees = new Map(f.employees.map((e) => [e.role, e]));
  const items: LaunchItem[] = [];
  for (const role of AGENT_ROLE_KEYS) {
    const e = employees.get(role);
    const key = `verification.${role}`;
    const label = AGENT_BY_KEY[role].shortName;
    if (!e || !e.entitled || (role === "appointment_setter" && f.appointments.wanted === false)) {
      items.push(item({ key, label, state: "not_applicable", required: false, owner: "system", detail: "Not part of your plan, so nothing to check." }));
      continue;
    }
    // The Appointment Setter proves itself on a calendar that takes bookings: until the client's calendar is active there is nothing real to check, so the check waits instead of failing.
    if (role === "appointment_setter" && f.crm.mode === "native" && f.appointments.calendar?.status !== "active") {
      items.push(item({ key, label, state: "in_progress", required: true, owner: "you", detail: "The check runs once your booking calendar is active." }));
      continue;
    }
    if (!e.readiness.workReady) {
      // A check that waits on a review waits on that review, not on "provisioning": the two must not be mixed up in the overall state.
      items.push(item(e.heldForReview
        ? { key, label, state: "awaiting_review", required: true, owner: "iacquire", detail: "The check runs after iAcquire reviews this retained profile's configuration change." }
        : { key, label, state: "in_progress", required: true, owner: "system", detail: "The check runs once this retained profile is ready for authorized work." }));
      continue;
    }
    const v = verification.get(role) ?? { role, state: "none" as const };
    if (v.state === "running") {
      const running = item({ key, label, state: "in_progress", required: true, owner: "system", detail: "A read-only check on your real records is running." });
      const waited = waitedPast(clock, v.since, clock.stall.verification);
      items.push(waited === null || !v.since ? running : stalledItem(running, "Its read-only check", waited, v.since, v.alerted, v.leaseExpired ? " Nothing is running it right now." : ""));
    }
    // A check held for a person's approval is waiting on that review, not running: it must not read as progress.
    else if (v.state === "awaiting_review") items.push(item({ key, label, state: "awaiting_review", required: true, owner: "iacquire", detail: "Its read-only check is waiting for iAcquire's review. Nothing runs until it is approved." }));
    else if (v.state === "none") items.push(item({ key, label, state: "action_required", required: true, owner: "you", detail: "Not checked yet. The check reads your real records and changes nothing.", action: { label: "Run final checks", intent: "run_checks" } }));
    // A result for an older configuration says nothing about this one, whether it passed or failed: the check runs again (the sweep starts it by itself).
    else if (v.configVersion !== e.configVersion) items.push(item({ key, label, state: "action_required", required: true, owner: "you", detail: "Its configuration changed since the last check, so the check needs to run again.", action: { label: "Run final checks", intent: "run_checks" } }));
    // The same for what the check reads: a check run against other appointment types, host hours, targeting or pipeline stages says nothing about the ones the client has now. A check
    // recorded without a digest (an old job, or a role that reads nothing) stays valid for its configuration version.
    else if (!checkCoversInputs(v.inputsDigest, e.inputsDigest)) items.push(item({ key, label, state: "action_required", required: true, owner: "you", detail: `Your ${verificationInputs(role).map((i) => VERIFICATION_INPUT_LABEL[i]).join(" or ")} changed since the last check, so the check needs to run again.`, action: { label: "Run final checks", intent: "run_checks" } }));
    // A check that had no records to read is still a pass (a new client is legitimately empty), and it says so first, then keeps the check's own account of what it counted.
    else if (v.state === "passed" && v.nothingToCheck) items.push(item({ key, label, state: "done", required: true, owner: "system", detail: v.detail ? `Nothing to check yet. ${v.detail}` : "Nothing to check yet: there are no records for this check to read, so it passed without examining anything." }));
    else if (v.state === "passed") items.push(item({ key, label, state: "done", required: true, owner: "system", detail: v.detail ?? "A read-only check on your real records completed. Nothing was changed or sent." }));
    else items.push(item({ key, label, state: "failed", required: true, owner: "you", detail: v.detail ?? "The check did not pass.", action: { label: "Run final checks", intent: "run_checks" } }));
  }
  return { key: "verification", title: "Functional verification", ...summarize(items) };
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

function summarize(items: LaunchItem[]): { state: StepState; summary: string; items: LaunchItem[] } {
  const applicable = items.filter((i) => i.state !== "not_applicable");
  if (!applicable.length) return { state: "not_applicable", summary: "Does not apply to your business.", items };
  const required = applicable.filter((i) => i.required);
  const watched = required.length ? required : applicable;
  const done = watched.filter((i) => i.state === "done").length;
  let state: StepState;
  if (watched.some((i) => i.state === "action_required" || i.state === "failed")) state = "action_required";
  else if (watched.some((i) => i.state === "in_progress")) state = "in_progress";
  else if (watched.some((i) => i.state === "awaiting_review")) state = "awaiting_review";
  else state = "done";
  return { state, summary: state === "done" ? "Complete." : `${done} of ${watched.length} checks passed.`, items };
}

/**
 * The customer-facing switches as rows for the "final activation" hand-off. Every row is informational: not required, so none of them can move the percentage or hold up launch, and
 * none is ever flipped from here. The words say only what the facts know: whether it is on, and what this setup does about it (nothing). Nothing records who turned a switch on (the
 * client, a teammate, iAcquire's staff), so no row says who did. A channel is the one switch with a known owner: iAcquire stores its credential, runs the provider test and switches it
 * on once it is verified (the same words as the integrations step), so a channel row never promises a switch for the client.
 */
function controlsOf(facts: LaunchControlFact[]): LaunchControl[] {
  return facts.map((c) => {
    const asked = c.wanted ? " You asked for this." : "";
    const detail = c.on
      ? "On."
      : c.key.startsWith("channel.")
        ? `Off.${asked} iAcquire switches a channel on once it is set up and verified; nothing in this setup turns it on.`
        : `Off.${asked} Nothing in this setup turns it on: it stays off until a person switches it on.`;
    return { ...c, required: false as const, detail };
  });
}

/**
 * `now` makes the judge time-aware: an employee's profile, a final check or the industry CRM setup that has been in progress for longer than its threshold (STALL_MINUTES, or the
 * `stall` the server read from the environment) becomes an action for iAcquire instead of "in progress, nothing is needed" for ever. Left out, nothing is ever called stalled.
 */
export function deriveLaunchReadiness(f: LaunchFacts, now?: Date, stall: Partial<StallMinutes> = {}): LaunchReadiness {
  const clock: Clock = { now: now ?? null, stall: { ...STALL_MINUTES, ...stall } };
  const steps: LaunchStep[] = [profileStep(f), knowledgeStep(f), crmStep(f, clock), calendarStep(f), integrationsStep(f), f.growthPartner ? growthPartnerStep(f.growthPartner) : employeesStep(f, clock), verificationStep(f, clock)];
  const required = steps.flatMap((s) => s.items).filter((i) => i.required && i.state !== "not_applicable");
  const passed = required.filter((i) => i.state === "done").length;
  const total = required.length;
  const blocking = required.filter((i) => i.state === "action_required" || i.state === "failed");
  const base = { passed, total, steps, blocking, ...(f.launchControls ? { controls: controlsOf(f.launchControls) } : {}) };

  if (!f.submitted) {
    return { ...base, state: "not_started", label: LAUNCH_STATE_LABEL.not_started, headline: "Start with your company information", detail: "Answer a few short questions about your business once. Everything else is set up from your answers.", percent: 0 };
  }
  const percentOf = (n: number, d: number) => (d === 0 ? 0 : Math.floor((n / d) * 100));
  if (f.paymentCleared === false) {
    return { ...base, state: "questionnaire_submitted", label: LAUNCH_STATE_LABEL.questionnaire_submitted, headline: "Questionnaire submitted", detail: f.growthPartner ? "Your answers are saved. Your AI Growth Partner and the rest of your setup start after your setup payment is confirmed." : "Your answers are saved. Setup for retained profiles and the rest of the workspace start after your setup payment is confirmed.", percent: percentOf(passed, total) };
  }
  const youBlocking = blocking.filter((i) => i.owner === "you").length;
  const iacquireBlocking = blocking.filter((i) => i.owner !== "you").length;
  if (blocking.length) {
    const parts = [youBlocking ? `${plural(youBlocking, "thing needs", "things need")} you` : null, iacquireBlocking ? `${plural(iacquireBlocking, "needs", "need")} iAcquire's attention` : null].filter(Boolean).join(" and ");
    return { ...base, state: "action_required", label: LAUNCH_STATE_LABEL.action_required, headline: "Action required", detail: `${parts}. Everything else keeps running.`, percent: percentOf(passed, total) };
  }
  const running = required.filter((i) => i.state === "in_progress").length;
  if (running) {
    return { ...base, state: "provisioning", label: LAUNCH_STATE_LABEL.provisioning, headline: "Setting up your business", detail: `${passed} of ${total} checks have passed. ${plural(running, "check is", "checks are")} still running; nothing is needed from you right now.`, percent: percentOf(passed, total) };
  }
  const waiting = required.filter((i) => i.state === "awaiting_review").length;
  if (waiting) {
    return { ...base, state: "ready_for_review", label: LAUNCH_STATE_LABEL.ready_for_review, headline: "Ready for review", detail: `Every automatic check has passed. ${plural(waiting, "item is", "items are")} waiting for iAcquire's review before you can launch.`, percent: percentOf(passed, total) };
  }
  // Every applicable, required check passed. A workspace with nothing required to check never reaches "100%": that would be a green badge with nothing behind it.
  if (total === 0) {
    return { ...base, state: "provisioning", label: LAUNCH_STATE_LABEL.provisioning, headline: "Setting up your business", detail: "Nothing has been checked yet.", percent: 0 };
  }
  return { ...base, state: "ready_to_launch", label: LAUNCH_STATE_LABEL.ready_to_launch, headline: "100% Ready to Launch", detail: "Every applicable setup and verification check has passed. Nothing customer-facing is switched on until you turn it on.", percent: 100 };
}

/**
 * A short fingerprint of what matters about a readiness: the overall state and every required, applicable item's key, state and owner. Wording, counts and the time never move it, so
 * two reads that say the same thing in different words are the same fingerprint, and a change in who has to move or what is done is a different one. Not a secret and not a
 * security boundary: it only tells "something changed" from "nothing did". (cyrb53, 53 bits.)
 */
export function fingerprintOf(r: Pick<LaunchReadiness, "state" | "steps">): string {
  const parts = r.steps.flatMap((s) => s.items).filter((i) => i.required && i.state !== "not_applicable").map((i) => `${i.key}:${i.state}:${i.owner}`).sort();
  const text = `${r.state}|${parts.join(",")}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
