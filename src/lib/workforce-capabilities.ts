import type { AgentRoleKey } from "@/lib/agents";
import type { Permission } from "@/lib/permissions";

/**
 * Reviewed business capabilities an AI employee may be asked to perform.
 *
 * The definition is the single allowlist used by the dispatcher, the work board and tests.
 * Adding a capability here does not give any employee permission: the dispatcher also checks the
 * role allowlist, the caller permission, the tenant's agent instance and its readiness.
 */
export type CapabilityKey = "lead_research" | "lead_generation_review" | "proactive_review" | "crm_quality_review" | "pipeline_review" | "appointment_review" | "appointment_availability" | "performance_snapshot" | "missed_call_review" | "lead_priority_review" | "social_performance_review" | "receivables_review" | "reputation_review";

export interface CapabilityDefinition {
  key: CapabilityKey;
  label: string;
  description: string;
  allowedRoles: readonly AgentRoleKey[];
  requiredPermission: Permission;
  /** read_only means the capability cannot change a business record; approval_required means it must not execute without a human decision. */
  risk: "read_only" | "approval_required" | "sensitive";
  produces: string;
  /** True when a person can start it from the AI Work Board without an additional input form. */
  workBoardAction: boolean;
}

export const WORKFORCE_CAPABILITIES: Record<CapabilityKey, CapabilityDefinition> = {
  lead_research: {
    key: "lead_research",
    label: "Lead research",
    description: "Research authorized public sources, qualify candidates, check existing records and prepare source-backed leads for human review.",
    allowedRoles: ["lead_hunter"],
    requiredPermission: "leads.research",
    risk: "read_only",
    produces: "Lead profiles with source evidence, qualification reasons and duplicate warnings.",
    workBoardAction: false,
  },
  lead_generation_review: {
    key: "lead_generation_review",
    label: "Lead generation review",
    description: "Review the authorized research queue, review backlog, CRM handoff and recent coverage, then recommend the next research assignment. It never starts research or contacts a prospect.",
    allowedRoles: ["lead_hunter"],
    requiredPermission: "leads.view",
    risk: "read_only",
    produces: "Lead-generation findings with queue counts, stale work, coverage gaps, duplicate rates and a recommended next assignment.",
    workBoardAction: true,
  },
  proactive_review: {
    key: "proactive_review",
    label: "On-demand operations review",
    description: "Read persisted workspace records, identify blocked or overdue work, failed runs, missing approvals and integration problems, then recommend next actions.",
    allowedRoles: ["operations_manager"],
    // The review can surface approval titles, contact names and workforce state, so it needs the
    // same workspace-wide audit permission as the Activity page, not ordinary chat access.
    requiredPermission: "activity.view",
    risk: "read_only",
    produces: "An evidence-backed review with findings, impact and recommended actions. It does not change business records or start schedules.",
    workBoardAction: true,
  },
  crm_quality_review: {
    key: "crm_quality_review",
    label: "CRM quality review",
    description: "Review authorized CRM contacts and companies for missing details, possible duplicates and unverified identities, then recommend fixes.",
    allowedRoles: ["crm_manager"],
    requiredPermission: "contacts.view",
    risk: "read_only",
    produces: "Data-quality findings with record counts, examples and a link to the affected records.",
    workBoardAction: true,
  },
  pipeline_review: {
    key: "pipeline_review",
    label: "Pipeline review",
    description: "Review open sales opportunities for missing values, stale stages, missing owners and passed close dates, then recommend next actions.",
    allowedRoles: ["sales_assistant"],
    requiredPermission: "sales.view",
    risk: "read_only",
    produces: "Pipeline hygiene findings with opportunity counts, examples and a link to the pipeline.",
    workBoardAction: true,
  },
  appointment_review: {
    key: "appointment_review",
    label: "Appointment review",
    description: "Review authorization, booking and coverage problems in upcoming appointments without changing or confirming anything.",
    allowedRoles: ["appointment_setter"],
    requiredPermission: "appointments.view",
    risk: "read_only",
    produces: "Appointment risk findings with counts, examples and a link to the booking queue.",
    workBoardAction: true,
  },
  appointment_availability: {
    key: "appointment_availability",
    label: "Calendar availability check",
    description: "Read real bookable calendar slots for the next seven days and report them without booking, holding or contacting anyone.",
    allowedRoles: ["appointment_setter"],
    requiredPermission: "appointments.view",
    risk: "read_only",
    produces: "Real available start/end times with their time zone and appointment type, or an honest reason the calendar cannot offer slots.",
    workBoardAction: true,
  },
  missed_call_review: {
    key: "missed_call_review",
    label: "Missed-call review",
    description: "Read recorded missed calls, the follow-ups that were tried and the recovery policy, then say which callers still need a person. It never calls or texts anyone and changes nothing.",
    allowedRoles: ["appointment_setter"],
    requiredPermission: "calls.view",
    risk: "read_only",
    produces: "Findings about missed calls without an owner, drafts waiting for approval and follow-ups that failed, each with a link to the cases.",
    workBoardAction: true,
  },
  lead_priority_review: {
    key: "lead_priority_review",
    label: "Lead priority review",
    description: "Read the lead priorities the scoring rules already wrote and what happened to those leads since, then say which promising leads have not been followed up. It never scores, changes or contacts a lead.",
    allowedRoles: ["sales_assistant"],
    requiredPermission: "contacts.view",
    risk: "read_only",
    produces: "Findings about hot leads without a follow-up or an owner, and about how much of the book can be scored, with links to the contacts.",
    workBoardAction: true,
  },
  social_performance_review: {
    key: "social_performance_review",
    label: "Social media review",
    description: "Read stored social posts, the numbers the platforms returned and the leads that arrived through posts' tracked links, then say what needs a person and what the evidence supports. It never drafts, publishes, contacts anyone or changes anything.",
    allowedRoles: ["performance_analyst"],
    requiredPermission: "social.view",
    risk: "read_only",
    produces: "Findings about failed or unconfirmed posts, approvals waiting, accounts that need reconnecting and, only with enough returned numbers, which post types or weekdays did better; plus tracked leads, each with a link.",
    workBoardAction: true,
  },
  receivables_review: {
    key: "receivables_review",
    label: "Receivables review",
    description: "Read issued customer invoices, the payments and refunds recorded against them, the payment provider's deliveries and the payment account's connection, then say which unpaid invoices are overdue and which payments need a person. It never issues, sends, voids, records or refunds anything, and never contacts a customer or a payment provider.",
    allowedRoles: ["performance_analyst"],
    requiredPermission: "invoices.view",
    risk: "read_only",
    produces: "Findings about overdue invoices, failed or held payments, deliveries that were not applied, a payment account that needs attention, reminders on hold and reminders that could not be sent, each with a link; plus counts of open, overdue and recently paid invoices.",
    workBoardAction: true,
  },
  reputation_review: {
    key: "reputation_review",
    label: "Reputation review",
    description: "Read private feedback, public reviews a connected review site returned, replies to them, review site connections and review requests, then say what is waiting for a person and what the evidence supports. It never writes, posts, approves or sends anything, never contacts a customer or a review site, and never writes, edits or counts a review or a rating.",
    allowedRoles: ["performance_analyst"],
    requiredPermission: "reviews.view",
    risk: "read_only",
    produces: "Findings about low private feedback nobody has acknowledged, complaints nobody has taken, public reviews with no reply, replies waiting for approval or not posted, review sites that need reconnecting, customer programs whose approval lapsed and why review requests did not go out, each with a link; plus counts, and a plain caution when there are too few answers to read a trend.",
    workBoardAction: true,
  },
  performance_snapshot: {
    key: "performance_snapshot",
    label: "Performance snapshot",
    description: "Measure leads, appointments, pipeline outcomes and AI run reliability for the requested calendar month or last 30 days, then compare it with the matching prior period.",
    allowedRoles: ["performance_analyst"],
    requiredPermission: "analytics.view",
    risk: "read_only",
    produces: "Measured KPIs with their period, definition and source, plus anomaly findings. It never invents a benchmark or estimate.",
    workBoardAction: true,
  },
};

export const CAPABILITY_KEYS = Object.keys(WORKFORCE_CAPABILITIES) as CapabilityKey[];

export function isCapabilityKey(value: string): value is CapabilityKey {
  return (CAPABILITY_KEYS as readonly string[]).includes(value);
}

export function capabilityDefinition(key: string): CapabilityDefinition | null {
  return isCapabilityKey(key) ? WORKFORCE_CAPABILITIES[key] : null;
}

export function capabilitiesForRole(role: AgentRoleKey): CapabilityDefinition[] {
  return CAPABILITY_KEYS.map((key) => WORKFORCE_CAPABILITIES[key]).filter((definition) => definition.allowedRoles.includes(role));
}

export function roleMayUseCapability(role: AgentRoleKey, capability: string): boolean {
  const definition = capabilityDefinition(capability);
  return Boolean(definition?.allowedRoles.includes(role));
}

/** A capability the current viewer could start from the Work Board, with its real availability. */
export interface WorkBoardCapabilityAction {
  capability: CapabilityKey;
  label: string;
  description: string;
  employeeName: string;
  available: boolean;
  reason: string | null;
}

