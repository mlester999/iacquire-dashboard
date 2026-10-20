import "server-only";
import { opsScopeKey, type OpsScope } from "@/lib/aqi/ops/types";

/**
 * Deterministic question -> tool plan. The model does not choose tools, arguments or scope: a
 * planner that could be talked into a tool call would turn every retrieved ticket into a possible
 * instruction. Everything returned here is still validated by the executor against the registry,
 * the viewer's role and the verified scope, so this file narrows what is *asked*, never what is
 * *allowed*.
 */

export type OpsIntent =
  | "smalltalk" | "help" | "health" | "workspace" | "workforce" | "support" | "security"
  | "business" | "integrations" | "release" | "product" | "briefing" | "telemetry" | "action" | "general";

export interface PlannedCall {
  toolId: string;
  args: Record<string, unknown>;
}

export type PlannedAction =
  | { toolId: "incident.acknowledge"; args: { incidentId: string } }
  | { toolId: "support.escalate"; args: { ticketId: string; reason: string } }
  | { toolId: "support.set_priority"; args: { ticketId: string; priority: "low" | "normal" | "high" | "urgent"; reason: string } }
  | { toolId: "automation.agency_pause"; args: { orgId: string; paused: boolean; reason: string } }
  | { toolId: "issue.create"; args: { kind: "internal_issue" | "platform_bug" | "engineering_task"; subject: string; details: string } };

export interface OpsPlan {
  intents: OpsIntent[];
  calls: PlannedCall[];
  action: PlannedAction | null;
  /** Said instead of guessing, e.g. an action that needs a context the administrator has not selected. */
  clarification: string | null;
  /** True when a client's name was mentioned while the platform scope is selected. */
  needsClientLookup: string | null;
}

const MAX_CALLS = 6;

const has = (text: string, ...patterns: RegExp[]) => patterns.some((p) => p.test(text));

const RX = {
  smalltalk: /^\s*(hi|hello|hey|yo|thanks|thank you|thx|ok|okay|cool|great|good (morning|afternoon|evening))[\s!.,?]*$/i,
  help: /\b(what can you (do|investigate)|how (do|can) i use you|capabilit|help me (understand|use)|what do you (do|know))\b/i,
  health: /\b(health|slow|slowness|latency|incidents?|outages?|down|degraded|performance|production (issue|problem)|failing|failures?|errors?|database|db|scheduler|background jobs?|cron|queues?|backlog|stuck|crm (is )?slow|services?)\b/i,
  jobs: /\b(jobs?|scheduler|cron|background|worker|tick)\b/i,
  workspace: /\b(onboard\w*|workspace|tenant|clients?|setup|set up|blockers?|configur\w+|readiness|activation|provision\w*)\b/i,
  workforce: /\b(hermes|ai employees?|employees?|lead hunter|appointment setter|sales assistant|crm manager|analyst|operations manager|workforce|working on|runs?|executions?)\b/i,
  approvals: /\b(approvals?|waiting for (approval|review)|pending approval)\b/i,
  support: /\b(tickets?|support|requests?|complaints?|bug reports?|feedback|escalat\w+|sla|queue|unresolved)\b/i,
  duplicates: /\b(duplicates?|same (issue|problem)|related|group|cluster|recurring)\b/i,
  product: /\b(requesting|requested|feature requests?|most often|improvements?|roadmap|backlog|themes?|what (are )?clients (want|ask)|product (feedback|ideas?))\b/i,
  security: /\b(audit|security|log.?ins?|sign.?ins?|role changes?|permission\w*|suspicious|unusual|admin(istrative)? activity|access events?|failed (auth\w*|log.?in\w*)|authori[sz]ation|cross.?tenant)\b/i,
  business: /\b(costs?|spend|spent|revenue|margin|profit\w*|usage|llm|tokens?|telephony|call minutes|billing|payments?|paid|expens\w+|retention|active clients|activations?|credits?)\b/i,
  integrations: /\b(deliver\w*|didn.?t (send|arrive|go)|not (sent|delivered)|confirmation|emails?|sms|whatsapp|webhooks?|workflows?|n8n|ghl|go ?high ?level|integrations?|calendar|reminders?|bounced?)\b/i,
  release: /\b(release|deploy\w*|versions?|migrations?|latest (change|build|commit)|ci\b|what changed|rollout)\b/i,
  telemetry: /\b(aqi|copilot|your (own )?(tools?|checks?)|ops tools?)\b[\s\S]{0,80}\b(latency|slow|failures?|failing|performing|performance|costs?|usage|telemetry|errors?)\b/i,
  briefing: /\b(briefing|digest|summary of (today|the day|this week|yesterday)|what needs (my )?attention|morning (summary|update)|daily (summary|update)|weekly (summary|update))\b/i,
  acknowledge: /\backnowledge\b/i,
  escalate: /\bescalate\b/i,
  priority: /\b(change|set|raise|lower|make)\b.*\bpriority\b|\bpriority\b.*\b(to|as)\s+(low|normal|high|urgent)\b/i,
  pause: /\b(pause|stop|halt)\b.*\b(automation|messaging|workflows?|employees?|outbound)\b/i,
  resume: /\b(resume|restart|unpause|re-?enable)\b.*\b(automation|messaging|workflows?|employees?|outbound)\b/i,
  createIssue: /\b(create|open|log|file|record|raise)\b.*\b(internal )?(issue|bug|ticket)\b|\bpropose\b.*\b(engineering )?task\b|\brecord\b.*\bplatform bug\b/i,
};

function tidy(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function afterColon(message: string): string {
  const idx = message.indexOf(":");
  return tidy(idx >= 0 ? message.slice(idx + 1) : message, 300);
}

const EMPLOYEE_ROLES: Array<[RegExp, string]> = [
  [/lead hunter/i, "lead_hunter"], [/appointment setter/i, "appointment_setter"], [/sales assistant/i, "sales_assistant"],
  [/crm manager/i, "crm_manager"], [/operations manager/i, "operations_manager"], [/(performance )?analyst/i, "performance_analyst"],
];

/** The AI Employee role a question names, so "Why did the Lead Hunter stop?" looks at Lead Hunters rather than everyone. */
export function employeeRole(text: string): string | null {
  return EMPLOYEE_ROLES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/** Capitalised phrases and quoted strings that could be a client's name. */
export function candidateClientNames(message: string): string[] {
  const names = new Set<string>();
  for (const m of message.matchAll(/["“']([^"”']{3,60})["”']/g)) names.add(m[1].trim());
  for (const m of message.matchAll(/\b([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,4})\b/g)) {
    const phrase = m[1].trim();
    if (phrase.length >= 4 && !/^(Why|What|Which|Show|Are|Is|Did|How|Who|When|The|Generate|Investigate|Review|Inspect|View|Analyze|AQi|Hermes|Support|CRM|Hello|Hey)$/.test(phrase)) names.add(phrase);
  }
  return [...names].slice(0, 4);
}

export function planOps(message: string, scope: OpsScope, available: ReadonlySet<string>): OpsPlan {
  const text = message.trim();
  const intents = new Set<OpsIntent>();
  const calls: PlannedCall[] = [];
  const add = (toolId: string, args: Record<string, unknown> = {}) => {
    if (!available.has(toolId)) return;
    if (calls.some((c) => c.toolId === toolId && JSON.stringify(c.args) === JSON.stringify(args))) return;
    if (calls.length < MAX_CALLS) calls.push({ toolId, args });
  };
  const empty = (partial: Partial<OpsPlan> = {}): OpsPlan => ({ intents: [...intents], calls, action: null, clarification: null, needsClientLookup: null, ...partial });

  if (RX.smalltalk.test(text)) { intents.add("smalltalk"); return empty(); }
  if (RX.help.test(text)) { intents.add("help"); return empty(); }

  // Actions are proposals only. The shape is derived here from the verified scope, not from model text.
  if (has(text, RX.createIssue)) {
    intents.add("action");
    const lower = text.toLowerCase();
    const kind = /engineering task/.test(lower) ? "engineering_task" : /platform bug|\bbug\b/.test(lower) ? "platform_bug" : "internal_issue";
    const body = afterColon(text);
    if (body.length < 8) return empty({ clarification: "Tell me what the issue is after a colon, for example: “Create an internal issue: scheduler has not run since the last deploy”." });
    return empty({ action: { toolId: "issue.create", args: { kind, subject: tidy(body, 120), details: body } } });
  }
  if (has(text, RX.acknowledge) && /\bincident\b/i.test(text)) {
    intents.add("action");
    if (scope.type !== "incident" || !scope.id) return empty({ clarification: "Select the incident you want to acknowledge as the investigation context first." });
    return empty({ action: { toolId: "incident.acknowledge", args: { incidentId: scope.id } } });
  }
  if (has(text, RX.escalate) && /\b(ticket|request|support)\b/i.test(text)) {
    intents.add("action");
    if (scope.type !== "ticket" || !scope.id) return empty({ clarification: "Select the support ticket you want to escalate as the investigation context first." });
    return empty({ action: { toolId: "support.escalate", args: { ticketId: scope.id, reason: tidy(afterColon(text) || "Escalated from AQi Operations after review.", 300) } } });
  }
  if (has(text, RX.priority) && /\b(ticket|request|priority)\b/i.test(text)) {
    intents.add("action");
    const priority = (/\b(urgent|high|normal|low)\b/i.exec(text)?.[1]?.toLowerCase() ?? null) as "low" | "normal" | "high" | "urgent" | null;
    if (scope.type !== "ticket" || !scope.id) return empty({ clarification: "Select the support ticket whose priority you want to change as the investigation context first." });
    if (!priority) return empty({ clarification: "Which priority: low, normal, high or urgent?" });
    return empty({ action: { toolId: "support.set_priority", args: { ticketId: scope.id, priority, reason: "Priority changed from AQi Operations after review." } } });
  }
  if (has(text, RX.pause, RX.resume) && !has(text, /\bwhy\b|\bwhat\b|\bis\b|\bare\b/i)) {
    intents.add("action");
    if (!scope.orgId) return empty({ clarification: "Pausing or resuming automation applies to one client. Select the client workspace as the investigation context first." });
    return empty({ action: { toolId: "automation.agency_pause", args: { orgId: scope.orgId, paused: !has(text, RX.resume), reason: tidy(afterColon(text) || "Changed from AQi Operations after review.", 300) } } });
  }

  const tenantScoped = Boolean(scope.orgId);
  const lookup = (): string | null => {
    if (tenantScoped) return null;
    const names = candidateClientNames(message);
    return names.length ? names.join("|") : null;
  };

  if (has(text, RX.briefing)) { intents.add("briefing"); add("briefing.compose"); return empty(); }
  // "AQi, why is the CRM slow?" addresses the assistant; it is not a question about the assistant, so a leading name is ignored.
  if (has(text.replace(/^\s*(hey|hi|hello|ok|okay)?[\s,]*aqi\b[\s,:!-]*/i, ""), RX.telemetry)) { intents.add("telemetry"); add("aqi.telemetry"); return empty(); }

  if (has(text, RX.release)) { intents.add("release"); add("release.info"); }
  if (has(text, RX.security)) { intents.add("security"); add("security.events"); }
  if (has(text, RX.product) && !has(text, RX.release)) { intents.add("product"); add("product.requests"); }
  if (has(text, RX.business)) { intents.add("business"); add("business.summary"); if (/\b(clients?|by client|highest|most|top)\b/i.test(text)) add("business.client_costs"); }

  if (scope.type === "ticket") {
    intents.add("support");
    add("support.ticket");
    if (has(text, RX.duplicates)) add("support.duplicates");
    if (/\b(draft|reply|respond|response)\b/i.test(text)) add("support.draft_reply");
  } else if (has(text, RX.support) && !has(text, RX.integrations)) {
    intents.add("support");
    add("support.queue");
    if (has(text, RX.duplicates)) add("support.duplicates");
  }

  if (scope.type === "employee" || has(text, RX.workforce)) {
    intents.add("workforce");
    const role = employeeRole(text);
    add("workforce.status", role ? { role } : {});
    if (has(text, RX.approvals)) add("workforce.approvals");
    if (scope.type === "employee" || /\b(why|stop|stopped|fail\w*|runs?|executions?|last)\b/i.test(text)) add("workforce.runs");
  } else if (has(text, RX.approvals)) {
    intents.add("workforce");
    add("workforce.approvals");
  }

  if (scope.type === "workflow" || (has(text, RX.integrations) && !has(text, RX.health))) {
    intents.add("integrations");
    add("integrations.status");
    if (scope.type === "workflow" || tenantScoped || /\b(why|didn.?t|not|confirmation|reminder|bounced?)\b/i.test(text)) add("integrations.trace");
  }

  if (has(text, RX.health) && !intents.has("support") && !intents.has("security")) {
    intents.add("health");
    if (tenantScoped) add("platform.incidents");
    else {
      add("platform.health");
      add("platform.incidents");
      if (has(text, RX.jobs)) add("platform.jobs");
    }
  }

  if (tenantScoped && (has(text, RX.workspace) || intents.size === 0)) {
    intents.add("workspace");
    add("workspace.summary");
    if (!intents.has("health")) add("platform.incidents");
  } else if (has(text, RX.workspace)) {
    intents.add("workspace");
    const names = lookup();
    if (names) add("workspace.find", { names: names.split("|") });
    add("workspace.directory");
    if (names) return empty({ needsClientLookup: names });
  }

  if (!calls.length && !intents.size) {
    // Nothing matched. Say what can be investigated instead of guessing at an operational fact.
    if (tenantScoped) { intents.add("workspace"); add("workspace.summary"); }
    else intents.add("general");
  }
  return empty();
}

/** Follow-up questions that are real investigations for the scope, not generic filler. */
export function suggestOpsQuestions(scope: OpsScope, intents: readonly string[]): string[] {
  const key = opsScopeKey(scope);
  const platform = [
    "Are there any production incidents right now?",
    "Which AI Employees failed today?",
    "Which support tickets are unresolved and urgent?",
    "Show unusual administrative activity this week",
    "Generate an operations briefing",
  ];
  const byType: Record<string, string[]> = {
    tenant: ["What is blocking this client's onboarding?", "Which integrations are failing for this client?", "What are this client's AI Employees doing?", "Show this client's open support tickets"],
    employee: ["Why did this employee stop?", "What is this employee waiting for?", "Show this employee's recent runs"],
    ticket: ["Are there duplicates of this ticket?", "Draft a reply to this ticket", "Should this ticket be escalated?"],
    incident: ["How long has this incident been open?", "Which clients does this incident affect?"],
    workflow: ["Why did this workflow fail?", "Show recent runs of this workflow"],
  };
  const base = key === "platform" ? platform : (byType[scope.type] ?? platform);
  return base.filter((q) => !intents.includes(q)).slice(0, 4);
}
