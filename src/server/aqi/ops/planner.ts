import "server-only";
import { opsScopeKey, type OpsScope } from "@/lib/aqi/ops/types";
import { redactSecrets } from "@/server/aqi/ops/redact";

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
  health: /\b(health|healthy|unhealthy|(system|platform|service|overall|production) status|slow|slowness|latency|incidents?|outages?|down|degraded|performance|production (issue|problem)|failing|failures?|errors?|database|db|scheduler|background jobs?|cron|queues?|backlog|stuck|crm (is )?slow|services?|broken|not working|is (it|everything|the \w+) (up|ok|okay|fine|working)|(anything|something|what'?s) (wrong|broken)|on fire)\b/i,
  jobs: /\b(jobs?|scheduler|cron|background|worker|tick)\b/i,
  workspace: /\b(onboard\w*|workspace|tenant|clients?|setup|set up|blockers?|blocked|configur\w+|readiness|activation|provision\w*|go(ing)? live|launch\w*)\b/i,
  workforce: /\b(hermes|ai employees?|employees?|lead hunter|appointment setter|sales assistant|crm manager|analyst|operations manager|workforce|working on|runs?|executions?|bots?|agents?)\b/i,
  approvals: /\b(approvals?|approve|waiting (for )?(my |our |your )?(approval|review)|needs? (my |our )?(approval|review)|pending approval|awaiting approval)\b/i,
  support: /\b(tickets?|support|requests?|complaints?|complain\w*|bug reports?|feedback|escalat\w+|sla|queue|unresolved)\b/i,
  duplicates: /\b(duplicates?|same (issue|problem)|related|group|cluster|recurring)\b/i,
  product: /\b(requesting|requested|feature requests?|most often|improvements?|roadmap|backlog|themes?|what (are )?clients (want|ask)|(clients?|customers?) (are )?(asking|wanting|requesting)|asking for|product (feedback|ideas?))\b/i,
  security: /\b(audit|security|log.?ins?|sign.?ins?|role chang\w+|chang\w+ (the )?(roles?|permissions?)|permission\w*|suspicious|unusual|admin(istrative)? activity|access events?|failed (auth\w*|log.?in\w*)|authori[sz]ation|cross.?tenant)\b/i,
  business: /\b(costs?|spend|spending|spent|revenue|margin|profit\w*|usage|llm|tokens?|telephony|call minutes|billing|bills?|payments?|paid|expens\w+|retention|active clients|activations?|credits?)\b/i,
  integrations: /\b(deliver\w*|didn.?t (send|arrive|go)|not (sent|delivered)|confirmation|emails?|sms|whatsapp|webhooks?|workflows?|n8n|ghl|go ?high ?level|integrations?|calendar|reminders?|bounced?)\b/i,
  release: /\b(release|deploy\w*|versions?|migrations?|latest (change|build|commit)|ci\b|what changed|rollout)\b/i,
  telemetry: /\b(aqi|copilot|your (own )?(tools?|checks?)|ops tools?)\b[\s\S]{0,80}\b(latency|slow|failures?|failing|performing|performance|costs?|usage|telemetry|errors?)\b/i,
  briefing: /\b(briefing|digest|summary of (today|the day|this week|yesterday)|what needs (my )?attention|morning (summary|update)|daily (summary|update)|weekly (summary|update))\b/i,
  acknowledge: /\backnowledge\b/i,
  escalate: /\bescalate\b/i,
  priority: /\b(change|set|raise|lower|make)\b.*\bpriority\b|\bpriority\b.*\b(to|as)\s+(low|normal|high|urgent)\b/i,
  pause: /\b(pause|stop|halt)\b.*\b(automation|messaging|workflows?|employees?|outbound)\b/i,
  resume: /\b(resume|restart|unpause|re-?enable)\b.*\b(automation|messaging|workflows?|employees?|outbound)\b/i,
  // "Raise the priority of this ticket" must not read as "raise a ticket": a new item needs an article or an explicit kind.
  createIssue: /\b(create|open|log|file|record|raise|add)\s+(an?\s+|new\s+|internal\s+|platform\s+|engineering\s+)+(issue|bug|ticket|task)\b|\bpropose\s+(an?\s+)?(engineering\s+)?task\b|\brecord\s+(an?\s+)?platform bug\b/i,
};

const QUESTION_START = /^\s*(why|what|which|who|whom|whose|when|where|how|is|are|was|were|did|does|do|has|have|had|should|shall|can|could|would|will|may|might)\b/i;
const POLITE_REQUEST = /^\s*(please\b|(can|could|would|will) you\b|i('d| would)? (like|want) you to\b|go ahead and\b|kindly\b)/i;

/** A question about something is not an instruction to do it. "Can you pause…" and "Please pause…" are instructions. */
function isQuestion(text: string): boolean {
  if (POLITE_REQUEST.test(text)) return false;
  return QUESTION_START.test(text) || /\?\s*$/.test(text);
}

/**
 * Instructions AQi Operations never carries out. Anchored at the start so that a sentence that merely contains the word ("Show the latest
 * deploy", "Update me on the platform") stays a request for information.
 */
const UNSUPPORTED_REQUEST = /^\s*(?:(?:please|kindly|go ahead and)\s+|(?:can|could|would|will) you\s+)?(?:restart|reboot|redeploy|deploy|roll ?back|revert|delete|remove|wipe|purge|truncate|drop|erase|execute|grant|revoke|impersonate|reset|disable|ban|suspend|refund|charge|retry|resend|re-send|fix|repair|patch|approve|reject|close|resolve|cancel|publish|merge|apply|migrate|rotate|kill|terminate|flush|scale|upgrade|downgrade|edit|modify|assign|unassign|reassign|rename|update(?!\s+me\b)|run(?!\s+(?:an?\s+|the\s+)?(?:health|status|check|diagnostic|investigation|report|briefing)\b))\b/i;

function tidy(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Free text the administrator wrote for an action (a reason, an issue description). A credential pasted into it is removed before it is stored or shown. */
function afterColon(message: string): string {
  const idx = message.indexOf(":");
  return idx >= 0 ? tidy(redactSecrets(message.slice(idx + 1)), 300) : "";
}

/** What an issue is about: the text after a colon, or after "about / regarding / titled / called". Never the instruction itself. */
function issueBody(message: string): string {
  const afterMarker = /\b(?:about|regarding|titled|called)\s+(.+)$/i.exec(message)?.[1];
  return afterColon(message) || (afterMarker ? tidy(redactSecrets(afterMarker), 300) : "");
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

  // Actions are proposals only. The shape is derived here from the verified scope, not from model text. A change is prepared only for an
  // instruction ("Pause automation for this client: reason"), never for a question about one ("Should we pause automation?"), and the
  // verbs are read from what comes before the first colon so that the free text after it (a reason, an issue description) cannot
  // select a second action.
  const head = text.includes(":") ? text.slice(0, text.indexOf(":")) : text;
  const instruction = !isQuestion(text);
  const wants = {
    issue: has(head, RX.createIssue),
    acknowledge: has(head, RX.acknowledge) && /\bincident\b/i.test(head),
    escalate: has(head, RX.escalate) && /\b(ticket|request|support)\b/i.test(head),
    priority: has(head, RX.priority) && /\b(ticket|request|priority)\b/i.test(head),
    pause: has(head, RX.pause),
    resume: has(head, RX.resume),
  };
  const actionKinds = [wants.issue, wants.acknowledge, wants.escalate, wants.priority, wants.pause || wants.resume].filter(Boolean).length;
  const asksForAction = actionKinds > 0;

  if (instruction && actionKinds > 1) {
    intents.add("action");
    return empty({ clarification: "I prepare one change at a time so you can review each preview. Tell me which to start with: acknowledge an incident, escalate a ticket, change a ticket's priority, pause or resume a client's automation, or record an internal issue." });
  }
  if (instruction && wants.pause && wants.resume) {
    intents.add("action");
    return empty({ clarification: "Do you want to pause or resume this client's automation? Say one of them, for example: “Pause automation for this client: runaway sends”." });
  }
  if (instruction && wants.issue) {
    intents.add("action");
    const lower = text.toLowerCase();
    const kind = /engineering task/.test(lower) ? "engineering_task" : /platform bug|\bbug\b/.test(lower) ? "platform_bug" : "internal_issue";
    const body = issueBody(text);
    if (body.length < 8) return empty({ clarification: "Tell me what the issue is after a colon, for example: “Create an internal issue: scheduler has not run since the last deploy”." });
    return empty({ action: { toolId: "issue.create", args: { kind, subject: tidy(body, 120), details: body } } });
  }
  if (instruction && wants.acknowledge) {
    intents.add("action");
    if (scope.type !== "incident" || !scope.id) return empty({ clarification: "Select the incident you want to acknowledge as the investigation context first." });
    return empty({ action: { toolId: "incident.acknowledge", args: { incidentId: scope.id } } });
  }
  if (instruction && wants.escalate) {
    intents.add("action");
    if (scope.type !== "ticket" || !scope.id) return empty({ clarification: "Select the support ticket you want to escalate as the investigation context first." });
    return empty({ action: { toolId: "support.escalate", args: { ticketId: scope.id, reason: tidy(afterColon(text) || "Escalated from AQi Operations after review.", 300) } } });
  }
  if (instruction && wants.priority) {
    intents.add("action");
    const priority = (/\b(urgent|high|normal|low)\b/i.exec(head)?.[1]?.toLowerCase() ?? null) as "low" | "normal" | "high" | "urgent" | null;
    if (scope.type !== "ticket" || !scope.id) return empty({ clarification: "Select the support ticket whose priority you want to change as the investigation context first." });
    if (!priority) return empty({ clarification: "Which priority: low, normal, high or urgent?" });
    return empty({ action: { toolId: "support.set_priority", args: { ticketId: scope.id, priority, reason: "Priority changed from AQi Operations after review." } } });
  }
  if (instruction && (wants.pause || wants.resume)) {
    intents.add("action");
    if (!scope.orgId) return empty({ clarification: "Pausing or resuming automation applies to one client. Select the client workspace as the investigation context first." });
    return empty({ action: { toolId: "automation.agency_pause", args: { orgId: scope.orgId, paused: !wants.resume, reason: tidy(afterColon(text) || "Changed from AQi Operations after review.", 300) } } });
  }
  // Something AQi Operations does not do at all. Said plainly, with what it can do instead, rather than answered with unrelated checks.
  if (instruction && UNSUPPORTED_REQUEST.test(text)) {
    intents.add("general");
    return empty({ clarification: "I can't do that from here. AQi Operations investigates with read-only checks, and the only changes it can prepare (for your confirmation) are: acknowledge an incident, escalate a support ticket, change a ticket's priority, pause or resume a client's automation, and record an internal issue. I can look at the current state of whatever you're trying to change, if that helps." });
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

  if (asksForAction && !instruction && !calls.length) {
    return empty({ clarification: "I only prepare a change when you ask for it directly, for example “Pause automation for this client: runaway sends”. You'll see exactly what will happen and confirm it before anything changes. I can also look at the current state first if you'd like." });
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
