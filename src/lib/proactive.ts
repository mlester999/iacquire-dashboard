import type { AgentRoleKey } from "@/lib/agents";
import { isQuietHours } from "@/lib/messaging";

/**
 * Shared vocabulary for proactive AI employee work.
 *
 * Proactive reports are not chat messages and not a second notification centre. They are persisted
 * records of work a reviewed capability actually completed, with the real severity, evidence and
 * actions. This module is client-safe: it contains only types, reviewed duty copy and pure delivery
 * policy helpers. The server owns persistence and authorization.
 */

export const PROACTIVE_SEVERITIES = ["info", "warning", "critical"] as const;
export type ProactiveSeverity = (typeof PROACTIVE_SEVERITIES)[number];

export const PROACTIVE_REPORT_KINDS = [
  "alert",
  "recommendation",
  "completion",
  "blocker",
  "approval_request",
  "daily_briefing",
  "weekly_summary",
] as const;
export type ProactiveReportKind = (typeof PROACTIVE_REPORT_KINDS)[number];

export const PROACTIVE_SEVERITY_LABELS: Record<ProactiveSeverity, string> = {
  info: "Information",
  warning: "Needs attention",
  critical: "Urgent",
};

export const PROACTIVE_KIND_LABELS: Record<ProactiveReportKind, string> = {
  alert: "Issue alert",
  recommendation: "Recommendation",
  completion: "Completed work",
  blocker: "Blocker report",
  approval_request: "Approval request",
  daily_briefing: "Daily briefing",
  weekly_summary: "Weekly summary",
};

export const PROACTIVE_DELIVERY_MODES = ["immediate", "daily_digest"] as const;
export type ProactiveDeliveryMode = (typeof PROACTIVE_DELIVERY_MODES)[number];

export const PROACTIVE_DELIVERY_LABELS: Record<ProactiveDeliveryMode, string> = {
  immediate: "Send each update when it is verified",
  daily_digest: "Group routine updates into one daily digest",
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const validTime = (value: unknown): value is string => typeof value === "string" && TIME_RE.test(value);

export interface ProactivePrefs {
  /** In-app proactive notifications are on by default; only verified work can produce one. */
  enabled: boolean;
  /** Info, warning or critical. Critical alerts always bypass this threshold. */
  minimumSeverity: ProactiveSeverity;
  delivery: ProactiveDeliveryMode;
  /** Opt-in daily briefing. Off by default, so no briefing is generated until the owner chooses it. */
  dailyBriefing: boolean;
  weeklySummary: boolean;
  /** Local hour (0-23) in the person's own time zone. */
  briefingHour: number;
  quietStart: string | null;
  quietEnd: string | null;
  /** Opt-in, internal-only action: create one follow-up task for a critical report. Never a customer action. */
  autoCreateTasks: boolean;
}

export const DEFAULT_PROACTIVE_PREFS: ProactivePrefs = {
  enabled: true,
  minimumSeverity: "info",
  delivery: "immediate",
  dailyBriefing: false,
  weeklySummary: false,
  briefingHour: 8,
  quietStart: null,
  quietEnd: null,
  autoCreateTasks: false,
};

export const PROACTIVE_PREFS_PATCH_KEYS = [
  "enabled",
  "minimumSeverity",
  "delivery",
  "dailyBriefing",
  "weeklySummary",
  "briefingHour",
  "quietStart",
  "quietEnd",
  "autoCreateTasks",
] as const;

/** Reads the nested `proactive` object from stored notification preferences without trusting its shape. */
export function parseProactivePrefs(prefs: unknown): ProactivePrefs {
  const root = typeof prefs === "object" && prefs !== null && !Array.isArray(prefs) ? (prefs as Record<string, unknown>) : {};
  const raw = typeof root.proactive === "object" && root.proactive !== null && !Array.isArray(root.proactive) ? (root.proactive as Record<string, unknown>) : {};
  const minimumSeverity = PROACTIVE_SEVERITIES.includes(raw.minimumSeverity as ProactiveSeverity)
    ? (raw.minimumSeverity as ProactiveSeverity)
    : DEFAULT_PROACTIVE_PREFS.minimumSeverity;
  const delivery = PROACTIVE_DELIVERY_MODES.includes(raw.delivery as ProactiveDeliveryMode)
    ? (raw.delivery as ProactiveDeliveryMode)
    : DEFAULT_PROACTIVE_PREFS.delivery;
  const quietStart = validTime(raw.quietStart) ? raw.quietStart : null;
  const quietEnd = validTime(raw.quietEnd) && quietStart ? raw.quietEnd : null;
  return {
    enabled: raw.enabled !== false,
    minimumSeverity,
    delivery,
    dailyBriefing: raw.dailyBriefing === true,
    weeklySummary: raw.weeklySummary === true,
    briefingHour:
      typeof raw.briefingHour === "number" && Number.isInteger(raw.briefingHour) && raw.briefingHour >= 0 && raw.briefingHour <= 23
        ? raw.briefingHour
        : DEFAULT_PROACTIVE_PREFS.briefingHour,
    quietStart,
    quietEnd,
    autoCreateTasks: raw.autoCreateTasks === true,
  };
}

export function proactivePrefsFrom(view: ProactivePrefs): Record<string, unknown> {
  return {
    enabled: view.enabled,
    minimumSeverity: view.minimumSeverity,
    delivery: view.delivery,
    dailyBriefing: view.dailyBriefing,
    weeklySummary: view.weeklySummary,
    briefingHour: view.briefingHour,
    quietStart: view.quietStart,
    quietEnd: view.quietEnd,
    autoCreateTasks: view.autoCreateTasks,
  };
}

const SEVERITY_RANK: Record<ProactiveSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function severityAtLeast(value: ProactiveSeverity, minimum: ProactiveSeverity): boolean {
  return SEVERITY_RANK[value] >= SEVERITY_RANK[minimum];
}

export function highestSeverity(values: readonly ProactiveSeverity[]): ProactiveSeverity {
  return values.reduce<ProactiveSeverity>((highest, value) => (SEVERITY_RANK[value] > SEVERITY_RANK[highest] ? value : highest), "info");
}

export type ProactiveDeliveryAction = "deliver" | "hold" | "digest" | "suppress";

export interface ProactiveDeliveryDecision {
  action: ProactiveDeliveryAction;
  reason: string | null;
}

/**
 * Decides whether one verified report should become an in-app notification now. Critical items
 * always pass quiet hours and the severity threshold. A digest preference defers routine work to the
 * daily briefing rather than losing it.
 */
export function proactiveDeliveryDecision(input: {
  prefs: ProactivePrefs;
  severity: ProactiveSeverity;
  now: Date;
  timeZone: string;
}): ProactiveDeliveryDecision {
  if (input.severity === "critical") return { action: "deliver", reason: null };
  if (!input.prefs.enabled) return { action: "suppress", reason: "proactive_notifications_off" };
  if (!severityAtLeast(input.severity, input.prefs.minimumSeverity)) {
    return { action: "suppress", reason: "below_severity_threshold" };
  }
  if (input.prefs.quietStart && input.prefs.quietEnd && isQuietHours(input.prefs.quietStart, input.prefs.quietEnd, input.now, input.timeZone)) {
    return { action: "hold", reason: "quiet_hours" };
  }
  if (input.prefs.delivery === "daily_digest") return { action: "digest", reason: "daily_digest" };
  return { action: "deliver", reason: null };
}

/** A local calendar date such as 2026-10-21 in a specific zone. Used for idempotent briefing slots. */
export function localDateKey(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function localHour(now: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
    return Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  } catch {
    return now.getUTCHours();
  }
}

export function localWeekday(now: Date, timeZone: string): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
  } catch {
    return now.getUTCDay();
  }
}

/** True only while a person's locally configured proactive notifications may be announced now. */
export function proactiveQuietNow(prefs: ProactivePrefs, now: Date, timeZone: string): boolean {
  return Boolean(prefs.quietStart && prefs.quietEnd && isQuietHours(prefs.quietStart, prefs.quietEnd, now, timeZone));
}

/** The reviewed proactive duties that back each employee's monitoring schedule. */
export interface ProactiveDuty {
  role: AgentRoleKey;
  capability: string;
  title: string;
  description: string;
  watches: string[];
  safeActions: string[];
  approvalBoundary: string;
}

export const PROACTIVE_DUTIES: readonly ProactiveDuty[] = [
  {
    role: "operations_manager",
    capability: "proactive_review",
    title: "Operational health watch",
    description: "Reads persisted work, approvals, CRM, integration and workforce records, then reports what is blocked and what should happen next.",
    watches: [
      "Failed or stuck AI runs and jobs",
      "Approvals waiting for a person",
      "Overdue tasks and unresolved work",
      "Employees that are unavailable or unconfigured",
      "Integrations that are degraded",
      "Leads waiting for review",
    ],
    safeActions: ["Create an internal follow-up task when the owner has opted in"],
    approvalBoundary: "It never changes a customer record, contacts a provider, or approves work on the owner's behalf.",
  },
  {
    role: "lead_hunter",
    capability: "lead_generation_review",
    title: "Lead generation watch",
    description: "Checks the approved research queue, review backlog, CRM handoff and coverage against the saved target, then recommends the next research assignment.",
    watches: [
      "Research requests that did not finish",
      "Researched leads waiting for review",
      "Approved leads not yet handed to the CRM",
      "How recently authorized research ran",
      "Duplicate rates in newly researched leads",
      "Saved target versus current coverage",
    ],
    safeActions: ["Create an internal follow-up task when the owner has opted in"],
    approvalBoundary: "It never starts a provider research run, imports a lead, or contacts a prospect without a separate authorized action.",
  },
  {
    role: "appointment_setter",
    capability: "appointment_review",
    title: "Booking risk watch",
    description: "Watches persisted appointment requests and confirmations for the risks that stop a booking from becoming a meeting.",
    watches: [
      "Bookings waiting for approval",
      "Upcoming bookings that need manual calendar entry",
      "Requests stuck before confirmation",
      "Confirmed appointments with no responsible person",
      "Unconfirmed or conflicting booking states",
    ],
    safeActions: ["Create an internal follow-up task when the owner has opted in"],
    approvalBoundary: "It never confirms, moves, cancels or holds an appointment and never writes to a calendar provider.",
  },
  {
    role: "sales_assistant",
    capability: "pipeline_review",
    title: "Pipeline follow-up watch",
    description: "Reads open opportunities and their recorded stage history to find deals that need a real next step.",
    watches: [
      "Open deals that have not moved",
      "Missing owner, value, close date or customer link",
      "Deals past their expected close date",
      "Proposal-stage gaps that block a decision",
    ],
    safeActions: ["Create an internal follow-up task when the owner has opted in"],
    approvalBoundary: "It never changes a stage, owner, value or close date and never messages a prospect.",
  },
  {
    role: "crm_manager",
    capability: "crm_quality_review",
    title: "CRM quality watch",
    description: "Compares persisted contacts, companies and verified identities for duplicates and incomplete records.",
    watches: [
      "Contacts with no verified email or phone",
      "Companies with no domain or website",
      "Possible duplicate company names",
      "Shared contact names that need identity checks",
      "Unverified contact identities",
    ],
    safeActions: ["Create an internal follow-up task when the owner has opted in"],
    approvalBoundary: "It never merges, edits or deletes a CRM record. A merge remains a person's decision.",
  },
  {
    role: "performance_analyst",
    capability: "performance_snapshot",
    title: "Performance trend watch",
    description: "Measures leads, contacts, appointments, pipeline outcomes and AI run reliability, then compares the period with the one before it.",
    watches: [
      "Significant metric changes against the prior period",
      "AI run reliability",
      "Lead and appointment flow",
      "Pipeline outcomes",
      "Threshold crossings stated in the report",
    ],
    safeActions: ["Create an internal follow-up task when the owner has opted in"],
    approvalBoundary: "It never invents a benchmark, estimate or target and never changes a business record.",
  },
] as const;

export function proactiveDutyForRole(role: AgentRoleKey): ProactiveDuty | null {
  return PROACTIVE_DUTIES.find((duty) => duty.role === role) ?? null;
}
