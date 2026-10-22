// What the workflow screens receive from their server views: plain, serializable objects with no secrets. The views map the engine's
// service results (src/server/crm/workflows/*) into these, so the client components don't depend on database row shapes.
import type { RunStatus, StartedVia, StepStatus, WorkflowStatus } from "@/components/crm/workflows/parts";

export type ApprovalState = "not_needed" | "needed" | "pending" | "approved" | "rejected" | "expired";

export interface FolderOption {
  id: string;
  name: string;
}

export interface WorkflowListItem {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  folderId: string | null;
  folderName: string | null;
  triggerType: string | null;
  triggerSummary: string;
  stepCount: number;
  publishedVersion: number | null;
  /** The working copy differs from the published version. */
  unpublishedChanges: boolean;
  approval: ApprovalState;
  effects: string[];
  lastRunAt: string | null;
  runsToday: number;
  failuresToday: number;
  updatedAt: string;
}

export interface WorkflowTemplateItem {
  key: string;
  name: string;
  description: string;
  category: string | null;
  triggerSummary: string;
  stepKinds: string[];
  /** "optional": it sends a message only when one is chosen. */
  sendsMessages: boolean | "optional";
  /** The choices only the workspace can make (which tag, which stage, which approved message). */
  inputs: Array<{ key: string; label: string; help: string; kind: "tag" | "user" | "pipeline" | "stage" | "open_stage" | "message_template"; required: boolean }>;
}

/** What the template gallery's pickers offer. */
export interface TemplatePickerOptions {
  tags: Array<{ id: string; name: string }>;
  members: Array<{ id: string; name: string }>;
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string; kind: "open" | "won" | "lost" }> }>;
  /** Approved message templates only. */
  templates: Array<{ id: string; name: string; channel: "email" | "sms" | "whatsapp"; contentHash: string }>;
}

export interface VersionItem {
  id: string;
  version: number;
  publishedAt: string;
  publishedByName: string | null;
  effects: string[];
  contentHash: string;
  current: boolean;
  approval: ApprovalState;
  approvalId: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  /** The frozen definition, for viewing an older version read-only. */
  definition: unknown;
}

export interface RunListItem {
  id: string;
  workflowId: string;
  workflowName: string;
  version: number | null;
  status: RunStatus;
  startedVia: StartedVia;
  /** What started it, in words ("Tag added", "Test run"). */
  triggerLabel: string;
  contactId: string | null;
  contactName: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  /** The step it is on (or stopped at), in words. */
  currentStep: string | null;
  createdAt: string;
  finishedAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  /** Why it ended early, in words (the hourly limit, the loop limit), when it did. */
  outcome: string | null;
}

export interface RunLink {
  label: string;
  href: string;
}

export interface RunStepAttempt {
  id: string;
  stepKey: string;
  kind: string;
  /** The step's name, or its kind's label. */
  label: string;
  /** What the step was set to do, in words, from the version that ran. */
  summary: string;
  attempt: number;
  status: StepStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Result details worth showing, already in words ("Tags: VIP"), never raw secrets. */
  details: Array<{ label: string; value: string }>;
  error: string | null;
  links: RunLink[];
}

export interface RunDetail extends RunListItem {
  depth: number;
  attempts: number;
  steps: RunStepAttempt[];
  /** Steps of the version that haven't run on this run, in drawing order, for a complete picture. */
  pending: Array<{ stepKey: string; kind: string; label: string; summary: string }>;
  /** A wait in progress: when the run continues. */
  waitingUntil: string | null;
  /** A step waiting for a person: its approval request. */
  approvalId: string | null;
  canCancel: boolean;
  /** A failed or stopped run can try its failed step again, or skip past it (not for if / else steps). */
  canRetry: boolean;
  canSkip: boolean;
  /**
   * It stopped on a call to an outside system (n8n) that may or may not have run. Retrying sends the same request key, which the other
   * side answers with the same unknown result, so only skipping is offered.
   */
  externalUnknown: boolean;
}

/** A test run's result: what each step would do for the chosen contact. */
export interface TestRunView {
  /** The recorded test run (only for the published version; a draft's test isn't recorded). */
  runId: string | null;
  source: "draft" | "published";
  contactName: string | null;
  steps: Array<{ stepKey: string; kind: string; label: string; outcome: string; outcomeLabel: string; tone: "success" | "neutral" | "warning" | "danger" | "violet" | "primary"; detail: string }>;
  /** Problems that stopped a draft from being tested at all. */
  issues: Array<{ level: "error" | "warning"; message: string; stepKey?: string }>;
}

/** Everything the editor's pickers offer. Only usable choices are listed: approved templates, verified n8n mappings, active webhooks. */
export interface EditorOptions {
  tags: Array<{ id: string; name: string; color: string }>;
  members: Array<{ id: string; name: string; role: string }>;
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string; kind: "open" | "won" | "lost" }> }>;
  contactFields: Array<{ id: string; key: string; label: string; type: import("@/lib/crm/types").FieldType; options: Array<{ value: string; label: string }> }>;
  opportunityFields: Array<{ id: string; key: string; label: string; type: import("@/lib/crm/types").FieldType; options: Array<{ value: string; label: string }> }>;
  /** Null when the person can't see assignment rules (it needs the assign permission). */
  assignmentRules: Array<{ id: string; name: string; entity: "contact" | "opportunity"; active: boolean }> | null;
  /**
   * Every active rule as a bare reference (no name), for everyone who can open the editor: the validator checks a step's rule against these,
   * so a builder without the assign permission isn't told a rule someone else chose "no longer exists".
   */
  assignmentRuleRefs: Array<{ id: string; entity: "contact" | "opportunity" }>;
  /** Approved message templates, with the exact approved wording a workflow would send. */
  templates: Array<{ id: string; key: string; name: string; channel: import("@/lib/messaging").Channel; purpose: "service" | "marketing"; version: number; subject: string | null; body: string; contentHash: string }>;
  /** Templates that exist but aren't approved, so the picker can say why they can't be chosen. */
  unapprovedTemplates: Array<{ id: string; name: string; channel: import("@/lib/messaging").Channel | null }>;
  /** `problem`: why a step starting it can't run right now (n8n calls switched off, the trigger not set up…), in client-safe words. */
  n8nMappings: Array<{ id: string; label: string; workflowId: string; problem: string | null }>;
  webhooks: Array<{ id: string; name: string; host: string; active: boolean }>;
  /**
   * `ready`: passed its connection check (what sending as it needs). `connected`: has its AI service address and credential. `liveRuns`:
   * live AI employee runs are verified for it, so an "Ask AI employee" step can reach it. The same checks the engine makes at run time.
   */
  employees: Array<{ roleKey: string; name: string; mode: string; enabled: boolean; ready: boolean; connected: boolean; liveRuns: boolean }>;
  calendars: Array<{ id: string; name: string }>;
  appointmentTypes: Array<{ id: string; name: string; calendarId: string | null }>;
  /** Native forms that aren't archived, for the "Form submitted" trigger's filter. */
  forms?: Array<{ id: string; name: string; status: string }>;
  /** The workspace's configuration values, offered as {{custom_values.<key>}} in task titles, notes, notifications and deal names. */
  customValues?: Array<{ key: string; label: string }>;
  /** Connections to outside systems that aren't revoked (never their secrets), for HTTP request and Slack steps. */
  connections?: Array<{ id: string; name: string; kind: "http" | "slack_webhook"; status: string; host: string; methods: string[] }>;
  /** False when the workspace does not have the new inbox yet (the rollout): its conversation triggers and the "Update conversation" step can't be published. */
  inboxEnabled?: boolean;
  folders: FolderOption[];
}

/** The workflow as the editor opens it. */
export interface EditorWorkflow {
  id: string;
  name: string;
  description: string | null;
  status: import("@/components/crm/workflows/parts").WorkflowStatus;
  folderId: string | null;
  hourlyRunLimit: number;
  /** The saved working copy, exactly as stored (it may not validate yet). */
  draft: import("@/lib/crm/workflow/spec").WorkflowDefinition;
  draftRevision: number;
  publishedVersion: number | null;
  publishedVersionId: string | null;
  /** The saved draft differs from the published version. */
  unpublishedChanges: boolean;
  updatedAt: string;
  updatedByName: string | null;
  /** The published version's private inbound URL, for inbound-webhook workflows. */
  inboundUrl: string | null;
  /** There is a URL, but this person can't see it (only people who can change the workflow do). */
  inboundHidden: boolean;
}

/** Whether the workflow can run right now, and if not, why (shown next to the disabled control). */
export interface RunGate {
  /** Workspace-level stops: the workflows pause, the agency pause, a suspended workspace. Runs hold; switching on is still allowed. */
  pausedReason: string | null;
  /** Workflows are managed in another system for this workspace (the CRM provider setting), so nothing here can be switched on. */
  ownerProblem: string | null;
}
