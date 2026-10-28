/**
 * What an AI employee can actually do right now, as eight separate facts.
 *
 * A "ready" badge says the employee is configured and connected. It does not say the employee has been able to read the records its role needs, answered a real question from
 * them, or is allowed to work on its own. These checks keep those apart so one green badge cannot hide a missing capability. A check is "yes" only on recorded evidence; with no
 * evidence it is "not_verified", never quietly "yes".
 */

import type { EmployeeReadiness } from "@/lib/workforce-readiness";

export type CapabilityState = "yes" | "no" | "not_verified";

export const CAPABILITY_KEYS = [
  "configuration",
  "connected",
  "tools",
  "business_setup",
  "read_only",
  "approval_for_changes",
  "real_chat",
  "automatic_work",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface CapabilityCheck {
  key: CapabilityKey;
  label: string;
  state: CapabilityState;
  /** One plain sentence for the customer. Never a technical term. */
  customer: string;
  /** Detail for administrators only. */
  admin: string;
}

export interface CapabilityActivity {
  /** The latest time the server read this employee's role data for a chat, and whether every area could be read. */
  lastEvidenceRead: { at: string; ok: boolean; unavailableAreas: string[]; role: string } | null;
  completedChatRuns: number;
  lastCompletedChatAt: string | null;
  scheduledJobsOn: number;
}

export interface CapabilityInput {
  configured: boolean;
  configVersion: number | null;
  enabled: boolean;
  connected: boolean;
  runtimeStatus: string;
  inventoryVerified: boolean;
  inventoryToolCount: number | null;
  /** From the role prerequisites (src/lib/employee-requirements.ts). Null when the workspace facts could not be read. */
  prerequisitesMet: boolean | null;
  missingPrerequisites: string[];
  mode: "paused" | "approval_required" | "autonomous";
  activity: CapabilityActivity | null;
  now: Date;
  /** How recent a recorded read or chat must be to count. */
  freshForDays?: number;
}

const DAY = 86_400_000;

function fresh(at: string | null | undefined, now: Date, days: number): boolean {
  if (!at) return false;
  const time = new Date(at).getTime();
  return Number.isFinite(time) && now.getTime() - time <= days * DAY && time <= now.getTime() + 60_000;
}

export function deriveCapabilityChecks(input: CapabilityInput): CapabilityCheck[] {
  const days = input.freshForDays ?? 30;
  const a = input.activity;
  const read = a?.lastEvidenceRead ?? null;
  const readFresh = read ? fresh(read.at, input.now, days) : false;

  const readOnly: CapabilityCheck = !read || !readFresh
    ? {
        key: "read_only",
        label: "Can read your records",
        state: "not_verified",
        customer: "Not checked yet. Ask this employee a question about your business to confirm it can read your records.",
        admin: read ? `The last successful read was more than ${days} days ago (${read.at}).` : "No workspace read has been recorded for this employee yet.",
      }
    : read.ok
      ? {
          key: "read_only",
          label: "Can read your records",
          state: "yes",
          customer: "Yes. It reads your current records each time you ask.",
          admin: `Every area for this role was read at ${read.at}.`,
        }
      : {
          key: "read_only",
          label: "Can read your records",
          state: "no",
          customer: "Some of your information could not be read the last time it was needed.",
          admin: `Unreadable at ${read.at}: ${read.unavailableAreas.join(", ") || "unknown area"}.`,
        };

  const chatFresh = a ? fresh(a.lastCompletedChatAt, input.now, days) : false;
  const realChat: CapabilityCheck = a && a.completedChatRuns > 0 && chatFresh
    ? {
        key: "real_chat",
        label: "Has answered a real question",
        state: "yes",
        customer: "Yes. It has answered questions in chat.",
        admin: `${a.completedChatRuns} completed chat run${a.completedChatRuns === 1 ? "" : "s"} recorded; the latest was ${a.lastCompletedChatAt}.`,
      }
    : {
        key: "real_chat",
        label: "Has answered a real question",
        state: "not_verified",
        customer: "Not yet. Send it a question to confirm it works for you.",
        admin: a && a.completedChatRuns > 0 ? `The latest completed chat run (${a.lastCompletedChatAt}) is older than ${days} days.` : "No completed chat run is recorded for this employee.",
      };

  const auto = a?.scheduledJobsOn ?? 0;
  const automatic: CapabilityCheck = input.mode === "autonomous" || auto > 0
    ? {
        key: "automatic_work",
        label: "Allowed to work on its own",
        state: "yes",
        customer: auto > 0 ? "Yes, for the scheduled work you switched on." : "Yes, for routine work. Anything that reaches a customer still needs approval.",
        admin: `Mode ${input.mode}; ${auto} scheduled job${auto === 1 ? "" : "s"} switched on.`,
      }
    : {
        key: "automatic_work",
        label: "Allowed to work on its own",
        state: "no",
        customer: "No. It only works when you ask.",
        admin: `Mode ${input.mode}; no scheduled jobs switched on.`,
      };

  return [
    input.configured
      ? { key: "configuration", label: "Set up", state: "yes", customer: "Yes. Its role and instructions are in place.", admin: `Configuration version ${input.configVersion ?? "unknown"} is applied.` }
      : { key: "configuration", label: "Set up", state: "no", customer: "Not yet. Its role and instructions still need to be set up.", admin: "No applied configuration version." },
    input.connected && input.enabled
      ? { key: "connected", label: "Connected", state: "yes", customer: "Yes. It is switched on and reachable.", admin: `Runtime status ${input.runtimeStatus}.` }
      : { key: "connected", label: "Connected", state: "no", customer: input.enabled ? "Not reachable right now." : "It is switched off.", admin: `Enabled ${input.enabled}; runtime status ${input.runtimeStatus}; connected ${input.connected}.` },
    input.inventoryVerified
      ? { key: "tools", label: "Safe tools confirmed", state: "yes", customer: "Yes. The tools it can use have been checked and limited.", admin: `Runtime tool inventory verified${input.inventoryToolCount !== null ? ` (${input.inventoryToolCount} tools)` : ""}. Business data is not a runtime tool: the server reads it for the employee.` }
      : { key: "tools", label: "Safe tools confirmed", state: "not_verified", customer: "Not confirmed yet. It cannot take on work until its tools are checked.", admin: "No current, complete runtime tool inventory on record." },
    input.prerequisitesMet === null
      ? { key: "business_setup", label: "Your business setup is ready", state: "not_verified", customer: "We could not check your setup just now.", admin: "Workspace facts could not be read." }
      : input.prerequisitesMet
        ? { key: "business_setup", label: "Your business setup is ready", state: "yes", customer: "Yes. What this role needs from your business is in place.", admin: "All role prerequisites are met." }
        : { key: "business_setup", label: "Your business setup is ready", state: "no", customer: `Still needed: ${input.missingPrerequisites.join("; ") || "some setup"}.`, admin: `Unmet prerequisites: ${input.missingPrerequisites.join("; ") || "unspecified"}.` },
    readOnly,
    {
      key: "approval_for_changes",
      label: "Changes need your approval",
      state: "yes",
      customer: "Yes. It prepares proposals. A person approves anything that changes a record, books a meeting or reaches a customer.",
      admin: `Chat gives the employee read-only facts and no write path. Mode ${input.mode}; a drafted change or booking is created only as an approval request.`,
    },
    realChat,
    automatic,
  ];
}

/**
 * The number that must not be inflated: how many of the checks that can be proved from evidence are proved. "Changes need your approval" is a design guarantee, so it is not counted.
 */
export function provedCapabilityCount(checks: readonly CapabilityCheck[]): { proved: number; total: number } {
  const counted = checks.filter((check) => check.key !== "approval_for_changes" && check.key !== "automatic_work");
  return { proved: counted.filter((check) => check.state === "yes").length, total: counted.length };
}

/**
 * Builds the checks from what the screens already know. The readiness result is the single source for "set up", "connected", "tools" and "business setup", so this view can never
 * disagree with the badge; it only adds the evidence the badge does not carry.
 */
export function capabilityChecksFor(input: {
  readiness: Pick<EmployeeReadiness, "chatAvailable" | "inventoryAttestationCurrent" | "blocking" | "requirements">;
  configVersion: number | null;
  enabled: boolean;
  status: string;
  mode: CapabilityInput["mode"];
  inventoryToolCount: number | null;
  activity: CapabilityActivity | null | undefined;
  now: Date;
}): CapabilityCheck[] {
  const { readiness } = input;
  return deriveCapabilityChecks({
    configured: input.configVersion !== null,
    configVersion: input.configVersion,
    enabled: input.enabled,
    connected: readiness.chatAvailable,
    runtimeStatus: input.status,
    inventoryVerified: readiness.inventoryAttestationCurrent,
    inventoryToolCount: input.inventoryToolCount,
    prerequisitesMet: readiness.requirements.length === 0 ? null : readiness.blocking.length === 0,
    missingPrerequisites: readiness.blocking.map((requirement) => requirement.label),
    mode: input.mode,
    activity: input.activity ?? null,
    now: input.now,
  });
}
