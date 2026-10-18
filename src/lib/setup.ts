// Shared, side-effect-free rules for the Client Setup Center. Used by the server services (which
// enforce them), the UI (which only presents them) and the tests.

export const TASK_STATUSES = ["pending", "in_progress", "waiting_for_client", "ready_for_review", "completed", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  waiting_for_client: "Waiting for client",
  ready_for_review: "Ready for review",
  completed: "Completed",
  blocked: "Blocked",
};

/** Wording used in the client portal. */
export const CLIENT_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  waiting_for_client: "Waiting for you",
  ready_for_review: "Ready for review",
  completed: "Completed",
  blocked: "Blocked",
};

export type CompletionMode = "manual" | "verified" | "activation";
/** A step that applies only when the workspace uses this CRM provider (null: whichever it uses). See 0037_crm_setup_native.sql. */
export type SetupCrmProvider = "native" | "ghl";
export type Section = "agency" | "client";
export type InstanceState = "in_setup" | "ready_for_review" | "activated";

export const SECTION_TITLE: Record<Section, string> = {
  agency: "We're setting this up for you",
  client: "We need a few things from you",
};

export const SETUP_SERVICES = [
  { key: "crm", label: "CRM & pipelines", description: "iAcquire CRM from an industry Blueprint: pipelines, tags, fields and forms (or a connected GoHighLevel location for clients who keep GoHighLevel)." },
  { key: "ai_workforce", label: "AI workforce", description: "Dedicated Hermes AI employees." },
  { key: "automations", label: "Automation workflows", description: "Follow-up and reminder workflows." },
  { key: "website", label: "Custom website", description: "A custom website, client review, publishing and domain checks." },
  { key: "funnel", label: "Lead-generation funnel", description: "A standard lead-generation funnel with its own review and publication checks." },
  { key: "email", label: "Business email", description: "Business email and domain verification." },
  { key: "calendar", label: "Calendar & scheduling", description: "A connected calendar (or the iAcquire calendar) and appointment availability." },
] as const;
export type SetupService = (typeof SETUP_SERVICES)[number]["key"];
export const SETUP_SERVICE_KEYS = SETUP_SERVICES.map((s) => s.key) as SetupService[];

export const CHECK_KEYS = [
  "onboarding",
  "ghl_location",
  "crm_snapshot",
  "crm_assets",
  "hermes_employees",
  "workflows",
  "website_live",
  "email_domain",
  "sms_sender",
  "whatsapp_sender",
  "calendar",
  "final_health",
] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];
export type CheckStatus = "unverified" | "verified" | "failed" | "attested";

export const CHECK_LABEL: Record<CheckKey, string> = {
  onboarding: "Company onboarding",
  ghl_location: "CRM workspace connection",
  crm_snapshot: "CRM Blueprint applied",
  crm_assets: "CRM pipelines, tags, fields and forms",
  hermes_employees: "AI employees (live health)",
  workflows: "Automation workflows",
  website_live: "Website and domain",
  email_domain: "Business email sender and domain",
  sms_sender: "SMS sender",
  whatsapp_sender: "WhatsApp sender",
  calendar: "Calendar and availability",
  final_health: "Final system check",
};

export type ClientActionType = "approve" | "review_and_approve" | "provide_info" | "external";
export interface ClientAction {
  type: ClientActionType;
  label: string;
  instructions: string;
}
export const CLIENT_ACTION_TYPES: Array<{ value: ClientActionType; label: string; hint: string }> = [
  { value: "provide_info", label: "Provide information", hint: "The client types an answer." },
  { value: "approve", label: "Approve", hint: "The client approves something (for example an AI configuration)." },
  { value: "review_and_approve", label: "Review and approve", hint: "The client reviews a preview, then approves or asks for changes." },
  { value: "external", label: "Do something outside the portal", hint: "For example DNS records or Google authorization. The client confirms when done." },
];

// ---------------------------------------------------------------------------
// Progress and readiness (pure)
// ---------------------------------------------------------------------------

export interface RuleTask {
  id: string;
  title: string;
  status: TaskStatus;
  required: boolean;
  hidden: boolean;
  serviceExcluded: boolean;
  completionMode: CompletionMode;
  checkKey: CheckKey | null;
  dependsOn: string[];
}

/** Hidden optional tasks and tasks outside the purchased services never count for or against a client. */
export function isApplicable(t: Pick<RuleTask, "hidden" | "serviceExcluded">): boolean {
  return !t.hidden && !t.serviceExcluded;
}

/** Counted toward the setup percentage: applicable, required, and not the final activation step. */
export function isCounted(t: Pick<RuleTask, "hidden" | "serviceExcluded" | "required" | "completionMode">): boolean {
  return isApplicable(t) && t.required && t.completionMode !== "activation";
}

export interface Progress {
  total: number;
  completed: number;
  /** null when the checklist has no counted tasks, so the UI never shows a misleading 0% or 100%. */
  percent: number | null;
  counts: Record<TaskStatus, number>;
}

export function computeProgress(tasks: RuleTask[]): Progress {
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of tasks) if (isApplicable(t) && t.completionMode !== "activation") counts[t.status] += 1;
  const counted = tasks.filter(isCounted);
  const completed = counted.filter((t) => t.status === "completed").length;
  return { total: counted.length, completed, percent: counted.length ? Math.round((completed / counted.length) * 100) : null, counts };
}

/** Applicable dependencies that are not completed yet. */
export function unmetDependencies(task: Pick<RuleTask, "dependsOn">, byId: Map<string, RuleTask>): RuleTask[] {
  return task.dependsOn.map((id) => byId.get(id)).filter((d): d is RuleTask => Boolean(d) && isApplicable(d!) && d!.status !== "completed");
}

/** Latest date an applicable, unfinished, counted task is expected, only when every one of them has a date. */
export function estimateCompletion(tasks: Array<RuleTask & { estimatedCompletionAt: string | null }>): string | null {
  const remaining = tasks.filter((t) => isCounted(t) && t.status !== "completed");
  if (!remaining.length) return null;
  if (remaining.some((t) => !t.estimatedCompletionAt)) return null;
  return remaining.map((t) => t.estimatedCompletionAt as string).sort().at(-1) ?? null;
}

export type BlockerCode = "task_incomplete" | "task_blocked" | "dependency_unmet" | "check_failed" | "check_unverified" | "not_in_review" | "job_needs_attention";

export interface Blocker {
  code: BlockerCode;
  message: string;
  taskId?: string;
  checkKey?: CheckKey;
}

export interface Readiness {
  /** Every counted setup task is completed. Separate from production readiness. */
  tasksComplete: boolean;
  canMarkReady: boolean;
  canActivate: boolean;
  /** Task-level problems only: what stops the setup from being marked ready for final review. */
  taskBlockers: Blocker[];
  /** Everything that stops activation: task problems, failing or unverified checks, and review state. */
  blockers: Blocker[];
  failedChecks: CheckKey[];
  attestedChecks: CheckKey[];
}

/**
 * "Setup tasks completed" is not "ready for production". Activation additionally needs a verified
 * result from a provider check for every required integration check
 * behind a required task, with none failing, and the client setup in final review.
 */
export function evaluateReadiness(input: { state: InstanceState; tasks: RuleTask[]; checks: Partial<Record<CheckKey, CheckStatus>> }): Readiness {
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const blockers: Blocker[] = [];
  const applicable = input.tasks.filter(isApplicable);
  const counted = input.tasks.filter(isCounted);

  for (const t of counted) {
    if (t.status !== "completed") blockers.push({ code: "task_incomplete", taskId: t.id, message: `"${t.title}" is not complete.` });
  }
  for (const t of applicable) {
    if (t.status === "blocked") blockers.push({ code: "task_blocked", taskId: t.id, message: `"${t.title}" is blocked.` });
  }
  for (const t of applicable) {
    if (t.status !== "completed") continue;
    const unmet = unmetDependencies(t, byId);
    if (unmet.length) blockers.push({ code: "dependency_unmet", taskId: t.id, message: `"${t.title}" is complete but depends on "${unmet[0].title}", which is not.` });
  }

  const taskBlockers = [...blockers];
  const tasksComplete = counted.every((t) => t.status === "completed");
  const canMarkReady = input.state === "in_setup" && taskBlockers.length === 0;

  const checkBlockers: Blocker[] = [];
  const failedChecks: CheckKey[] = [];
  const attestedChecks: CheckKey[] = [];
  const seen = new Set<CheckKey>();
  for (const t of counted) {
    if (t.completionMode !== "verified" || !t.checkKey || seen.has(t.checkKey)) continue;
    seen.add(t.checkKey);
    const status = input.checks[t.checkKey] ?? "unverified";
    if (status === "failed") {
      failedChecks.push(t.checkKey);
      checkBlockers.push({ code: "check_failed", checkKey: t.checkKey, message: `${CHECK_LABEL[t.checkKey]} is failing.` });
    } else if (status === "unverified") {
      checkBlockers.push({ code: "check_unverified", checkKey: t.checkKey, message: `${CHECK_LABEL[t.checkKey]} has not been verified.` });
    } else if (status === "attested") {
      attestedChecks.push(t.checkKey);
      checkBlockers.push({ code: "check_unverified", checkKey: t.checkKey, message: `${CHECK_LABEL[t.checkKey]} has agency evidence but still needs a verified provider check.` });
    }
  }

  const activationBlockers = [...blockers, ...checkBlockers];
  if (input.state !== "ready_for_review") activationBlockers.push({ code: "not_in_review", message: "Mark the setup ready for final review first." });
  const canActivate = input.state === "ready_for_review" && activationBlockers.length === 0;

  return { tasksComplete, canMarkReady, canActivate, taskBlockers, blockers: activationBlockers, failedChecks, attestedChecks };
}

// ---------------------------------------------------------------------------
// Snapshot shapes shared by the API routes and the UI
// ---------------------------------------------------------------------------

export interface ClientTaskView {
  id: string;
  title: string;
  description: string;
  section: Section;
  status: TaskStatus;
  isActivation: boolean;
  required: boolean;
  completedAt: string | null;
  completionNote: string | null;
  clientNote: string | null;
  blockedReason: string | null;
  estimatedCompletionAt: string | null;
  updatedAt: string;
  /** Titles of unfinished earlier steps this one is waiting on. */
  waitingOn: string[];
  action: (ClientAction & { available: boolean; unavailableReason: string | null; previewLinks: Array<{ label: string; url: string }> }) | null;
  responded: { at: string; decision: string | null } | null;
  attachments: Array<{ id: string; label: string; url: string; kind: string }>;
  history: Array<{ at: string; text: string }>;
}

export interface ClientSetupSnapshot {
  /** Tenant identifier used only to prevent stale revisions when switching workspaces. */
  scope?: string;
  revision: number;
  generatedAt: string;
  orgName: string;
  state: InstanceState;
  activatedAt: string | null;
  progress: Progress;
  estimatedCompletion: string | null;
  lastUpdatedAt: string;
  /** True when every setup task is done but a final check still needs agency attention. */
  finalCheckIssue: boolean;
  canRespond: boolean;
  needsAttention: number;
  tasks: ClientTaskView[];
}

export interface AgencyTaskView {
  id: string;
  templateKey: string | null;
  title: string;
  clientTitle: string | null;
  description: string;
  section: Section;
  completionMode: CompletionMode;
  checkKey: CheckKey | null;
  service: SetupService | null;
  /** Applies only when the client's CRM uses this provider. A step for a provider it doesn't use is excluded like an unpurchased service. */
  crmProvider?: SetupCrmProvider | null;
  status: TaskStatus;
  required: boolean;
  hidden: boolean;
  serviceExcluded: boolean;
  requiresEvidence: boolean;
  requiresClientResponse: boolean;
  sortOrder: number;
  assignedTo: string | null;
  estimatedCompletionAt: string | null;
  clientNote: string | null;
  blockedReason: string | null;
  completionNote: string | null;
  clientAction: ClientAction | null;
  clientResponse: { type?: string; decision?: string | null; message?: string | null; at?: string } | null;
  clientRespondedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completionSource: "agency" | "connector" | "attestation" | "activation" | null;
  verifiedAt: string | null;
  verifiedDetail: string | null;
  updatedAt: string;
  dependsOn: string[];
  unmetDependencies: string[];
  attachments: Array<{ id: string; label: string; url: string; kind: string; visibility: "internal" | "client"; createdAt: string }>;
}

export interface AgencyEventView {
  id: string;
  taskId: string | null;
  at: string;
  actor: string | null;
  actorKind: "agency" | "client" | "system";
  event: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  body: string | null;
  reason: string | null;
  visibility: "internal" | "client";
}

export interface AgencyCheckView {
  key: CheckKey;
  label: string;
  status: CheckStatus;
  detail: string | null;
  source: "connector" | "attestation" | null;
  checkedAt: string | null;
  attestedBy: string | null;
  evidenceUrl: string | null;
  note: string | null;
  /** False when no connector exists yet: the portal cannot test this itself. */
  connectorImplemented: boolean;
  connectorNote: string | null;
  appliesTo: string[];
}

export interface AgencySetupSnapshot {
  scope?: string;
  revision: number;
  generatedAt: string;
  org: { id: string; name: string; status: string; onboardingCompletedAt: string | null; timezone: string };
  state: InstanceState;
  services: SetupService[];
  responsibleUserId: string | null;
  readyForReviewAt: string | null;
  activatedAt: string | null;
  progress: Progress;
  estimatedCompletion: string | null;
  readiness: Readiness;
  tasks: AgencyTaskView[];
  events: AgencyEventView[];
  checks: AgencyCheckView[];
  staff: Array<{ id: string; name: string; role: "agency_staff" | "agency_manager" | "agency_super_admin" }>;
  canActivate: boolean;
}
