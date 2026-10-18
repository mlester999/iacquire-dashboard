// Turns the engine's run records (src/server/crm/workflows/runs.ts) into what the run screens show: each step attempt's result in words,
// links to the records it touched, the steps that didn't run, and a test run's "would do" list. Pure, so the server views use it and the
// tests check it directly; ids are only ever shown as names (or not at all), never raw.
import type { RunDetail as EngineRunDetail, RunSummary, RunStepView, TestRunResult } from "@/server/crm/workflows/runs";
import type { WorkflowStep } from "@/lib/crm/workflow/spec";
import { isTriggerType, TRIGGERS } from "@/lib/crm/workflow/spec";
import { STARTED_VIA, type StepStatus } from "@/components/crm/workflows/parts";
import { kindLabel, stepSummary, type Names } from "@/components/crm/workflows/summaries";
import { layoutCanvas, orderedKeys } from "@/components/crm/workflows/graph";
import type { RunDetail, RunListItem, RunStepAttempt, TestRunView } from "@/components/crm/workflows/types";
import type { RunFilter } from "@/components/crm/workflows/summaries";

/** Why a run ended early or did nothing, in words. */
export const RUN_OUTCOMES: Record<string, string> = {
  rate_limited: "Not started: the workflow reached its hourly run limit.",
  loop_limit: "Stopped by the loop limit: workflows kept triggering each other.",
  visit_limit: "Stopped: the run came back to the same step too many times.",
  step_limit: "Stopped: the run took too many steps.",
};

/** What a skipped or blocked step's reason means. */
const BLOCK_REASONS: Record<string, string> = {
  missing_values: "A placeholder had no value for this contact",
  contact_unreachable: "No address to send to",
  suppressed: "Opted out or bounced",
  no_consent: "No consent on record",
  authorization_needed: "Waiting for the owner's approval of this version",
  agent_unavailable: "The AI employee isn't available",
  agent_not_ready: "The AI employee hasn't passed its connection check",
  automation_paused: "Paused",
  quiet_hours: "Quiet hours",
  frequency_cap: "Sending limit reached",
  human_takeover: "A person took over the conversation",
};

export function triggerLabelOf(triggerType: string | null, startedVia: RunSummary["startedVia"]): string {
  if (startedVia === "test") return STARTED_VIA.test;
  if (triggerType && isTriggerType(triggerType)) return TRIGGERS[triggerType].label;
  return STARTED_VIA[startedVia] ?? "Started";
}

export function toRunListItem(r: RunSummary): RunListItem {
  return {
    id: r.id, workflowId: r.workflowId, workflowName: r.workflowName, version: r.version ?? null, status: r.status, startedVia: r.startedVia,
    triggerLabel: triggerLabelOf(r.triggerType, r.startedVia),
    contactId: r.contact?.id ?? null, contactName: r.contact?.name ?? null, opportunityId: r.opportunity?.id ?? null, opportunityName: r.opportunity?.name ?? null,
    currentStep: r.currentStep?.label ?? null, createdAt: r.createdAt, finishedAt: r.finishedAt, nextRunAt: r.nextRunAt, lastError: r.lastError,
    outcome: r.outcome ? RUN_OUTCOMES[r.outcome] ?? null : null,
  };
}

/** The engine's run query for a filter chip on the runs list. */
export function runQueryFor(filter: RunFilter): { status?: "live" | "problems" | "awaiting_approval" | "completed" | "cancelled"; startedVia?: "test" } {
  switch (filter) {
    case "open":
      return { status: "live" };
    case "failed":
      return { status: "problems" };
    case "awaiting_approval":
    case "completed":
    case "cancelled":
      return { status: filter };
    case "test":
      return { startedVia: "test" };
    default:
      return {};
  }
}

export interface RunFormatContext {
  names: Names;
  /** The CRM base path (/crm or the agency mirror's). */
  base: string;
  /** Formats an ISO time in the workspace's zone. */
  formatTime: (iso: string) => string;
  /** Conversations of the messages the run sent, for linking to them in the inbox (client workspace only). */
  conversations?: Record<string, string>;
  /** Whether links that leave the CRM (the inbox) can be shown. */
  inboxLinks?: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const MESSAGE_STATUS: Record<string, string> = {
  queued: "Queued to send", sending: "Sending", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed", blocked: "Not sent", draft: "Held for approval",
};
const DELIVERY_STATUS: Record<string, string> = { pending: "Queued", delivering: "Sending", delivered: "Delivered", failed: "Will retry", dead: "Gave up after retries", queued: "Queued" };

/** A step attempt's stored result, in words, with links to what it created or changed. */
export function stepResultDetails(kind: string, result: Record<string, unknown>, run: { contactId: string | null }, ctx: RunFormatContext): { details: Array<{ label: string; value: string }>; links: Array<{ label: string; href: string }> } {
  const details: Array<{ label: string; value: string }> = [];
  const links: Array<{ label: string; href: string }> = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) details.push({ label, value });
  };
  const outcome = str(result.outcome);
  if (result.dryRun) add("Test", "Nothing was done; this shows what would happen.");
  if (outcome === "blocked" || (outcome === "would_skip" && str(result.reason))) add("Why", BLOCK_REASONS[String(result.reason)] ?? null);
  if (outcome === "skipped_by_person") add("Skipped", `By ${str(result.by) ?? "a person"}`);
  if (outcome === "unknown") add("Outcome", "Unknown: it may or may not have reached the other system, so it isn't sent again automatically.");
  switch (kind) {
    case "wait": {
      const until = str(result.until);
      if (until) add(outcome === "already_passed" ? "Date had passed" : "Continues at", ctx.formatTime(until));
      add("Note", str(result.note));
      break;
    }
    case "branch":
      if (result.path === "yes" || result.path === "no") add("Path taken", result.path === "yes" ? "Yes" : "No");
      break;
    case "add_tag":
    case "remove_tag":
      if (Array.isArray(result.tags) && result.tags.length) add("Tags", result.tags.map(String).join(", "));
      if (typeof result.changed === "number") add("Changed", result.changed ? "Yes" : "No, it was already that way");
      break;
    case "assign": {
      const user = str(result.assignedTo) ?? (str(result.userId) ? ctx.names.user(String(result.userId)) ?? "A former teammate" : null);
      add("Assigned to", user);
      if (str(result.ruleId)) add("Rule", ctx.names.rule(String(result.ruleId)) ?? "A rule that's no longer active");
      if (result.duplicate) add("Note", "Already assigned for this event.");
      break;
    }
    case "update_field":
      if ("to" in result) add("New value", result.to === null || result.to === "" ? "Empty" : Array.isArray(result.to) ? result.to.join(", ") : String(result.to));
      if ("from" in result) add("Was", result.from === null || result.from === "" ? "Empty" : Array.isArray(result.from) ? result.from.join(", ") : String(result.from));
      if (result.changed === false) add("Changed", "No, it already had that value");
      break;
    case "create_task":
      add("Task", str(result.title));
      add("Note", str(result.note));
      if (str(result.taskId)) links.push({ label: "Open task", href: `${ctx.base}/tasks?task=${result.taskId}` });
      break;
    case "internal_note":
      if (str(result.noteId) && run.contactId) links.push({ label: "See it on the contact", href: `${ctx.base}/contacts/${run.contactId}` });
      break;
    case "notify_team":
      add("Notified", typeof result.users === "number" ? `${result.users} ${result.users === 1 ? "person" : "people"}` : null);
      break;
    case "create_opportunity":
    case "move_stage": {
      if (kind === "create_opportunity" && result.created === false) add("Deal", "Already existed");
      if (outcome === "existing_deal") add("Deal", "They already had an open deal in this pipeline; later steps use it.");
      if (str(result.stageId)) add("Stage", ctx.names.stage(String(result.stageId)) ?? "A stage that no longer exists");
      if (result.changed === false) add("Changed", "No, it was already there");
      if (str(result.opportunityId)) links.push({ label: "Open deal", href: `${ctx.base}/opportunities/${result.opportunityId}` });
      break;
    }
    case "send_message": {
      add("Template", str(result.template) ? `${result.template}${typeof result.version === "number" ? ` (v${result.version})` : ""}` : null);
      add("Status", str(result.status) ? MESSAGE_STATUS[String(result.status)] ?? String(result.status) : null);
      const mid = str(result.messageId);
      const conv = mid ? ctx.conversations?.[mid] : null;
      if (conv && ctx.inboxLinks) links.push({ label: "Open conversation", href: `/inbox?conversation=${conv}` });
      else if (mid && run.contactId) links.push({ label: "Open contact", href: `${ctx.base}/contacts/${run.contactId}` });
      break;
    }
    case "webhook":
      add("Delivery", str(result.status) ? DELIVERY_STATUS[String(result.status)] ?? String(result.status) : null);
      break;
    case "n8n":
      if (str(result.mappingId)) add("Automation", ctx.names.n8n(String(result.mappingId)) ?? "No longer verified");
      add("Status", str(result.status) ? (result.status === "accepted" || result.status === "succeeded" ? "Started" : String(result.status).replace(/_/g, " ")) : null);
      break;
    case "ai_task":
      add("Status", str(result.status) ? (result.status === "queued" ? "Handed to the AI employee" : String(result.status).replace(/_/g, " ")) : null);
      break;
  }
  const detail = str(result.detail);
  if (detail && !details.some((d) => d.value === detail)) details.push({ label: kind === "branch" ? "Checked" : "Detail", value: detail });
  return { details, links };
}

/** The run detail screen's data: every attempt in words, and the version's steps this run didn't reach. */
export function toRunDetailView(run: EngineRunDetail, versionSteps: readonly WorkflowStep[], ctx: RunFormatContext): RunDetail {
  const byKey = new Map(versionSteps.map((s) => [s.key, s]));
  const summaryOf = (key: string, kind: string) => {
    const s = byKey.get(key);
    return s ? stepSummary(s, ctx.names) : kindLabel(kind);
  };
  const steps: RunStepAttempt[] = run.steps.map((s: RunStepView) => {
    const { details, links } = stepResultDetails(s.kind, s.result ?? {}, { contactId: run.contact?.id ?? null }, ctx);
    return {
      id: String(s.id), stepKey: s.stepKey, kind: s.kind, label: s.label, summary: summaryOf(s.stepKey, s.kind), attempt: s.attempt, status: s.status as StepStatus,
      startedAt: s.startedAt, finishedAt: s.finishedAt, details, error: s.error, links,
    };
  });
  const ran = new Set(run.steps.map((s) => s.stepKey));
  const order = orderedKeys(layoutCanvas(versionSteps).items);
  const pending = order.filter((k) => !ran.has(k)).map((k) => {
    const s = byKey.get(k)!;
    return { stepKey: k, kind: s.kind, label: s.name?.trim() || kindLabel(s.kind), summary: stepSummary(s, ctx.names) };
  });
  return {
    ...toRunListItem(run),
    depth: run.depth, attempts: run.attempts, steps, pending,
    waitingUntil: run.waitingUntil, approvalId: run.approvalId, canCancel: run.canCancel, canRetry: run.canRetry, canSkip: run.canSkip,
    externalUnknown: run.outcome === "external_unknown",
  };
}

const TEST_OUTCOMES: Record<string, { label: string; tone: TestRunView["steps"][number]["tone"] }> = {
  would_run: { label: "Would do", tone: "success" },
  would_skip: { label: "Would skip", tone: "neutral" },
  branch_yes: { label: "Yes path", tone: "success" },
  branch_no: { label: "No path", tone: "neutral" },
  would_end: { label: "Would end", tone: "neutral" },
  would_fail: { label: "Would fail", tone: "danger" },
  would_ask: { label: "Would ask first", tone: "warning" },
  would_loop: { label: "Loops back", tone: "violet" },
};

export function toTestRunView(r: TestRunResult): TestRunView {
  return {
    runId: r.runId, source: r.source, contactName: r.contact?.name ?? null,
    steps: r.steps.map((s) => {
      const o = TEST_OUTCOMES[s.outcome] ?? { label: s.outcome.replace(/_/g, " "), tone: "neutral" as const };
      return { stepKey: s.stepKey, kind: s.kind, label: s.label, outcome: s.outcome, outcomeLabel: o.label, tone: o.tone, detail: s.detail };
    }),
    issues: r.issues.map((i) => ({ level: i.level, message: i.message, ...(i.stepKey ? { stepKey: i.stepKey } : {}) })),
  };
}
