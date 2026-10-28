// What each AI employee needs BEYOND a verified connection before "ready" is honest. A verified Hermes profile proves the employee can be reached; it says nothing about whether
// the Appointment Setter has a calendar to book into, the Sales Assistant has a pipeline to read, or the Lead Hunter knows who to look for. Those are workspace facts, read by the
// server (src/server/workforce/readiness-facts.ts) and judged here by pure rules so a screen, a test and the Super Admin all give the same answer.
//
// A requirement is either BLOCKING (the employee cannot do the job it is named for without it, so it reads "Configuration incomplete", not "Ready") or ADVISORY (it makes the
// employee better, but the work it does without it is honest: the capability says what is missing). Nothing here grants a permission or opens a tool; it only decides what to say.
import type { AgentRoleKey } from "@/lib/agents";
import type { CapabilityProvider, CrmMode } from "@/lib/crm/types";

export interface CrmReadinessEvidence {
  organizationKind: "agency" | "client" | null;
  workspaceExists: boolean;
  mode: CrmMode | null;
  contactsProvider: CapabilityProvider | null;
  verifiedGhlConnection: boolean;
}

/** CRM availability depends on its configured source, never on whether contacts or deals already exist. */
export function crmReadyFromEvidence(evidence: CrmReadinessEvidence): boolean {
  // The internal agency workspace is native by design; its CRM workspace row is created lazily when the owner opens CRM.
  if (evidence.organizationKind === "agency" && !evidence.workspaceExists) return true;
  if (!evidence.workspaceExists) return false;
  const owner = evidence.mode === "hybrid" ? (evidence.contactsProvider ?? "native") : (evidence.mode ?? "native");
  return owner === "native" || evidence.verifiedGhlConnection;
}

/** The workspace facts a requirement is judged from. All plain values, so a test can write them by hand. */
export interface WorkspaceFacts {
  /** At least one section of company knowledge is approved (an employee may only use approved knowledge). */
  knowledgeApproved: boolean;
  /** An active calendar with a host that can take bookings, or a connected calendar. */
  calendarReady: boolean;
  /** A native CRM workspace is available or its external provider connection is verified. Record count is not part of readiness. */
  crmReady: boolean;
  /** At least one active sales pipeline with a stage. */
  pipelineReady: boolean;
  /** The workspace has saved who the Lead Hunter should look for. */
  leadTargetingSet: boolean;
  /** At least one customer channel (email, SMS or WhatsApp) is enabled. */
  customerChannelReady: boolean;
}

export const EMPTY_WORKSPACE_FACTS: WorkspaceFacts = { knowledgeApproved: false, calendarReady: false, crmReady: false, pipelineReady: false, leadTargetingSet: false, customerChannelReady: false };

export interface RequirementResult {
  key: string;
  label: string;
  met: boolean;
  blocking: boolean;
  /** One plain sentence: what is in place, or what is missing and what it stops. */
  detail: string;
  /** Where a person fixes it. */
  fixHref: string | null;
}

interface RequirementDef {
  key: string;
  label: string;
  blocking: boolean;
  fact: keyof WorkspaceFacts;
  met: string;
  missing: string;
  fixHref: string | null;
}

const KNOWLEDGE: Omit<RequirementDef, "blocking"> = {
  key: "knowledge", label: "Approved company knowledge", fact: "knowledgeApproved",
  met: "Approved company knowledge is available to this employee.",
  missing: "No company knowledge is approved yet, so this employee has only generic context about the business.",
  fixHref: "/knowledge",
};
const CALENDAR: Omit<RequirementDef, "blocking"> = {
  key: "calendar", label: "A calendar that takes bookings", fact: "calendarReady",
  met: "A calendar with a host is ready to take bookings.",
  missing: "No active calendar with a host (or connected calendar) exists, so no appointment can be offered or booked.",
  fixHref: "/crm/calendar",
};
const CRM: Omit<RequirementDef, "blocking"> = {
  key: "crm", label: "CRM set up", fact: "crmReady",
  met: "The CRM data source is available. It may contain no records yet.",
  missing: "The CRM data source is not configured or connected yet.",
  fixHref: "/crm",
};
const PIPELINE: Omit<RequirementDef, "blocking"> = {
  key: "pipeline", label: "A sales pipeline", fact: "pipelineReady",
  met: "A sales pipeline with stages exists.",
  missing: "No active sales pipeline exists, so there are no opportunities to review.",
  fixHref: "/crm/pipelines",
};
const TARGETING: Omit<RequirementDef, "blocking"> = {
  key: "lead_targeting", label: "Lead targeting saved", fact: "leadTargetingSet",
  met: "Targeting rules are saved.",
  missing: "No targeting rules are saved, so research has no description of the ideal customer to work from.",
  fixHref: "/leads",
};
const CHANNEL: Omit<RequirementDef, "blocking"> = {
  key: "customer_channel", label: "A customer channel", fact: "customerChannelReady",
  met: "At least one customer channel (email, SMS or WhatsApp) is enabled.",
  missing: "No customer channel is enabled, so nothing this employee prepares can reach a customer.",
  fixHref: "/settings/integrations",
};

const blocking = (d: Omit<RequirementDef, "blocking">): RequirementDef => ({ ...d, blocking: true });
const advisory = (d: Omit<RequirementDef, "blocking">): RequirementDef => ({ ...d, blocking: false });

/** The requirements of each of the six roles. A role not listed with a requirement needs nothing beyond the connection. */
export const ROLE_REQUIREMENTS: Record<AgentRoleKey, readonly RequirementDef[]> = {
  operations_manager: [advisory(KNOWLEDGE)],
  lead_hunter: [blocking(KNOWLEDGE), blocking(TARGETING)],
  appointment_setter: [blocking(KNOWLEDGE), blocking(CALENDAR), advisory(CHANNEL)],
  sales_assistant: [blocking(KNOWLEDGE), blocking(PIPELINE), advisory(CHANNEL)],
  crm_manager: [advisory(KNOWLEDGE), blocking(CRM)],
  performance_analyst: [advisory(KNOWLEDGE), blocking(CRM)],
};

/** Facts about the one employee (not the workspace): what its profile's recorded tool inventory exposes beyond its role's policy. `null` or absent: not known, nothing is said. */
export interface EmployeeFacts {
  runtimeToolsExcess?: readonly string[] | null;
}

/**
 * Judges one role's requirements against the workspace facts. Pure. For a client employee whose tool inventory is on record it also says whether the profile exposes more than the
 * role's tool policy allows; that is advisory (the portal refuses the actions, and enforcement removes the tools), but it is shown so nobody believes the tools are gone when they are not.
 */
export function evaluateRequirements(role: AgentRoleKey, facts: WorkspaceFacts, employee: EmployeeFacts = {}): RequirementResult[] {
  const results = ROLE_REQUIREMENTS[role].map((d) => {
    const met = facts[d.fact] === true;
    return { key: d.key, label: d.label, met, blocking: d.blocking, detail: met ? d.met : d.missing, fixHref: met ? null : d.fixHref };
  });
  const excess = employee.runtimeToolsExcess;
  if (excess) {
    const met = excess.length === 0;
    results.push({
      key: "role_tools", label: "Tools limited to this role", met, blocking: false, fixHref: null,
      detail: met
        ? "The profile exposes only the tools this role may use."
        : `The profile still exposes ${excess.join(", ")}, which this role's policy does not include. The portal refuses those actions for this role, but the tools stay until the profile's tool policy is updated.`,
    });
  }
  return results;
}

/** The unmet requirements that stop the employee from reading "ready". */
export const blockingUnmet = (results: readonly RequirementResult[] | undefined | null): RequirementResult[] => (results ?? []).filter((r) => r.blocking && !r.met);
