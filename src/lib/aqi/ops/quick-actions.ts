import { opsScopeKey, type OpsScope } from "@/lib/aqi/ops/types";

/**
 * Quick actions are shortcuts, never decoration: each one either opens a real page or sends a real
 * question to the Operations runtime (which answers from tools, or says what it cannot determine).
 */
export type OpsQuickActionKind = "ask" | "link" | "scope" | "draft";

export interface OpsQuickAction {
  key: string;
  label: string;
  description: string;
  kind: OpsQuickActionKind;
  /** Question sent to AQi Operations. */
  ask?: string;
  /** Destination for a link action. */
  href?: string;
  /** Text placed in the composer for the administrator to complete. */
  draft?: string;
}

const PLATFORM: OpsQuickAction[] = [
  { key: "health", label: "Investigate System Health", description: "Database, scheduler, incidents and delivery, with what cannot be measured.", kind: "ask", ask: "Investigate system health" },
  { key: "client", label: "Inspect Client Workspace", description: "Pick a client to see onboarding blockers, integrations and AI Employees.", kind: "scope" },
  { key: "hermes", label: "View Hermes Workforce", description: "Evidence-based status of every AI Employee.", kind: "ask", ask: "Which AI Employees failed today?" },
  { key: "support", label: "Review Support Tickets", description: "Unresolved, urgent and overdue requests.", kind: "ask", ask: "Which support tickets are unresolved and urgent?" },
  { key: "usage", label: "Analyze Platform Usage", description: "Highest AI and messaging costs by client.", kind: "ask", ask: "Which clients have the highest AI operating costs this month?" },
  { key: "integrations", label: "Investigate Integration Failures", description: "Connections in error and delivery failures.", kind: "ask", ask: "Investigate integration failures" },
  { key: "security", label: "Review Security Events", description: "Sign-ins, role changes and sensitive actions from the audit log.", kind: "ask", ask: "Show unusual administrative activity this week" },
  { key: "briefing", label: "Generate Operations Briefing", description: "A sourced summary of the last 24 hours.", kind: "ask", ask: "Generate an operations briefing" },
  { key: "issue", label: "Create Internal Issue", description: "Record a platform bug or engineering task in Support & Requests.", kind: "draft", draft: "Create an internal issue: " },
  { key: "queue", label: "Review Support Queue", description: "Open the full Support & Requests module.", kind: "link", href: "/admin/support" },
];

const TENANT: OpsQuickAction[] = [
  { key: "blockers", label: "What is blocking onboarding?", description: "Setup tasks, integrations and employees for this client.", kind: "ask", ask: "What is blocking this client's onboarding?" },
  { key: "delivery", label: "Trace message delivery", description: "Failed, blocked and stuck messages, reminders and workflows.", kind: "ask", ask: "Why didn't the appointment confirmation send?" },
  { key: "employees", label: "Check AI Employees", description: "Status, last runs and approvals for this client.", kind: "ask", ask: "What are this client's AI Employees doing?" },
  { key: "tickets", label: "Review this client's tickets", description: "Open Support & Requests for this client.", kind: "ask", ask: "Show this client's open support tickets" },
  { key: "pause", label: "Pause automation…", description: "Prepare an emergency pause for this client. You confirm it separately.", kind: "draft", draft: "Pause automation for this client: " },
  { key: "issue", label: "Create Internal Issue", description: "Record a platform bug or engineering task.", kind: "draft", draft: "Create an internal issue: " },
];

const TICKET: OpsQuickAction[] = [
  { key: "detail", label: "Summarize this ticket", description: "Status, priority, timeline and escalation advice.", kind: "ask", ask: "Summarize this ticket" },
  { key: "duplicates", label: "Find duplicates", description: "Other requests from this client with similar wording.", kind: "ask", ask: "Are there duplicates of this ticket?" },
  { key: "draft", label: "Draft a reply", description: "A draft for you to edit. It is never sent.", kind: "ask", ask: "Draft a reply to this ticket" },
  { key: "escalate", label: "Escalate…", description: "Prepare an escalation. You confirm it separately.", kind: "draft", draft: "Escalate this ticket: " },
];

const INCIDENT: OpsQuickAction[] = [
  { key: "timeline", label: "Show the incident timeline", description: "Detection, escalation and notes.", kind: "ask", ask: "Show this incident's timeline" },
  { key: "ack", label: "Acknowledge…", description: "Prepare an acknowledgement. You confirm it separately.", kind: "ask", ask: "Acknowledge this incident" },
];

const EMPLOYEE: OpsQuickAction[] = [
  { key: "status", label: "What is this employee doing?", description: "Evidence-based status.", kind: "ask", ask: "What is this employee doing right now?" },
  { key: "runs", label: "Why did it stop?", description: "Latest runs, errors and tools.", kind: "ask", ask: "Why did this employee stop?" },
];

const WORKFLOW: OpsQuickAction[] = [
  { key: "trace", label: "Why did this workflow fail?", description: "Failed runs, step and error.", kind: "ask", ask: "Why did this workflow fail?" },
];

/** Shortcuts that match the current investigation context. The platform set is always available as a fallback. */
export function quickActionsFor(scope: OpsScope): OpsQuickAction[] {
  switch (scope.type) {
    case "tenant": return TENANT;
    case "ticket": return TICKET;
    case "incident": return INCIDENT;
    case "employee": return EMPLOYEE;
    case "workflow": return WORKFLOW;
    default: return PLATFORM;
  }
}

export function contextSuggestions(scope: OpsScope): string[] {
  return quickActionsFor(scope).filter((a) => a.kind === "ask" && a.ask).map((a) => a.ask!).slice(0, 4);
}

export const scopeLabelFor = (scope: OpsScope) => (opsScopeKey(scope) === "platform" ? "Entire platform" : scope.label);

export const SCOPE_TYPE_LABEL: Record<OpsScope["type"], string> = {
  platform: "Platform",
  tenant: "Client",
  employee: "AI Employee",
  workflow: "Workflow",
  ticket: "Support ticket",
  incident: "Incident",
};
