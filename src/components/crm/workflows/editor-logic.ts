// The editor's rules that aren't drawing: the validator's context from the editor's options, issues grouped by where they show, the step
// kinds "+" offers (and why one can't do anything yet), a new step's starting config, why the workflow can't be switched on, what a version
// will send or call (the approval preview), and a template's missing choices. Pure, so server views, client components and the tests share
// them (no "use client" here: a server component can't call functions from a client module).
import { CHANNEL_LABELS } from "@/lib/messaging";
import {
  STEP_KINDS, STEP_KIND_LIST, validationContextFrom, type AiTaskConfig, type HttpRequestConfig, type N8nConfig, type SlackMessageConfig, type SendMessageConfig, type StepKind, type ValidationIssue, type WebhookConfig,
  type WorkflowDefinition, type WorkflowStep,
} from "@/lib/crm/workflow/spec";
import { branchMembers, freshKey, layoutCanvas, orderedKeys } from "@/components/crm/workflows/graph";
import { namesFrom } from "@/components/crm/workflows/summaries";
import { isReviewTemplate } from "@/components/crm/reviews/model";
import type { EditorOptions, EditorWorkflow, RunGate, VersionItem, WorkflowTemplateItem } from "@/components/crm/workflows/types";

/** Everything the validator needs from the editor's options. */
export function validationContextOf(o: EditorOptions) {
  return validationContextFrom({
    tags: o.tags,
    users: o.members,
    pipelines: o.pipelines,
    fields: [...o.contactFields.map((f) => ({ ...f, entity: "contact" as const })), ...o.opportunityFields.map((f) => ({ ...f, entity: "opportunity" as const }))],
    templates: o.templates,
    n8nMappings: o.n8nMappings,
    webhookSubscriptions: o.webhooks.filter((w) => w.active),
    // Bare references, sent to everyone who opens the editor: someone without the assign permission can't see rule names, but a step's rule
    // is still checked the way publishing checks it instead of looking deleted.
    assignmentRules: o.assignmentRuleRefs,
    agents: o.employees,
    calendars: o.calendars,
    appointmentTypes: o.appointmentTypes,
    forms: o.forms,
    customValues: o.customValues,
    connections: o.connections ?? [],
  });
}

/** Issues grouped the way the editor shows them: per step, on the trigger, and about the workflow as a whole. */
export function groupIssues(issues: readonly ValidationIssue[]) {
  const byStep: Record<string, ValidationIssue[]> = {};
  const trigger: ValidationIssue[] = [];
  const general: ValidationIssue[] = [];
  for (const i of issues) {
    if (i.stepKey) (byStep[i.stepKey] ??= []).push(i);
    else if (i.path?.startsWith("trigger")) trigger.push(i);
    else general.push(i);
  }
  return { byStep, trigger, general, errors: issues.filter((i) => i.level === "error").length, warnings: issues.filter((i) => i.level === "warning").length };
}

export interface KindChoice {
  kind: string;
  label: string;
  group: string;
  description: string;
  /**
   * Why this kind can't do anything yet (no approved template, no verified n8n mapping, …). It can still be added, so a workflow can be
   * built before its pieces are approved; the step shows the problem and publishing waits until it's fixed.
   */
  note?: string | null;
}

/** Kinds offered by "+", in the catalog's groups, with a note when a kind can't do anything in this workspace yet. */
export function kindChoices(options: EditorOptions): KindChoice[] {
  const n8nProblems = [...new Set(options.n8nMappings.map((m) => m.problem))];
  const note = (k: StepKind): string | null => {
    if (k === "send_message" && !options.templates.length) return "Needs an approved message template first.";
    if (k === "request_review" && !options.templates.some(isReviewTemplate)) return "Needs an approved review request template (with {{review.link}}) first.";
    if (k === "send_message" && options.employees.length && !options.employees.some((e) => sendAsState(e).state !== "blocked")) return "None of your AI employees has passed its connection check, so messages wouldn't be sent.";
    if (k === "n8n" && !options.n8nMappings.length) return "Your agency hasn't verified an n8n automation for you yet.";
    if (k === "n8n" && !n8nProblems.includes(null)) return n8nProblems.length === 1 ? n8nProblems[0] : "None of your n8n automations can run right now, so this step won't run.";
    if (k === "webhook" && !options.webhooks.some((w) => w.active)) return "Add a webhook endpoint first.";
    if (k === "http_request" && !(options.connections ?? []).some((c) => c.kind === "http")) return "Set up an HTTP connection first (Automation Studio → Connections).";
    if (k === "slack_message" && !(options.connections ?? []).some((c) => c.kind === "slack_webhook")) return "Set up a Slack connection first (Automation Studio → Connections).";
    if (k === "ai_task" && !options.employees.length) return "No AI employees are included in your workspace.";
    if (k === "ai_task" && !options.employees.some((e) => aiTaskState(e).state !== "blocked")) {
      return options.employees.some((e) => e.liveRuns) ? "None of your AI employees can be reached yet, so this step would be skipped." : "AI employee runs are switched off for now, so this step would be skipped.";
    }
    if ((k === "create_opportunity" || k === "move_stage") && !options.pipelines.length) return "Set up a pipeline first.";
    if ((k === "add_tag" || k === "remove_tag") && !options.tags.length) return "Create tags first.";
    if (k === "assign" && options.assignmentRules === null && !options.members.length) return "There's nobody to assign to.";
    return null;
  };
  return STEP_KIND_LIST.map((k) => ({ kind: k, label: STEP_KINDS[k].label, group: STEP_KINDS[k].group, description: STEP_KINDS[k].description, note: note(k) }));
}

/** A new step of a kind with the catalog's starting config, and a sensible first choice where there is exactly one. */
export function newStep(steps: readonly WorkflowStep[], kind: StepKind, options: EditorOptions): WorkflowStep {
  const config = { ...(STEP_KINDS[kind].defaults() as Record<string, unknown>) };
  if (kind === "send_message" && options.employees.length && !options.employees.some((e) => e.roleKey === config.sendAs)) config.sendAs = options.employees[0].roleKey;
  if (kind === "ai_task" && options.employees.length && !options.employees.some((e) => e.roleKey === config.roleKey)) config.roleKey = options.employees[0].roleKey;
  if ((kind === "create_opportunity" || kind === "move_stage") && options.pipelines.length === 1) {
    config.pipelineId = options.pipelines[0].id;
    const stage = options.pipelines[0].stages.find((s) => s.kind === "open");
    if (stage && kind === "create_opportunity") config.stageId = stage.id;
  }
  if (kind === "send_message" && options.templates.length === 1) {
    const t = options.templates[0];
    Object.assign(config, { templateId: t.id, contentHash: t.contentHash, channel: t.channel });
  }
  const httpConnections = (options.connections ?? []).filter((c) => c.kind === "http" && c.status === "active");
  if (kind === "http_request" && httpConnections.length === 1) {
    config.connectionId = httpConnections[0].id;
    if (!httpConnections[0].methods.includes(String(config.method))) config.method = httpConnections[0].methods[0] ?? "GET";
  }
  const slackConnections = (options.connections ?? []).filter((c) => c.kind === "slack_webhook" && c.status === "active");
  if (kind === "slack_message" && slackConnections.length === 1) config.connectionId = slackConnections[0].id;
  const reviewTemplates = kind === "request_review" ? options.templates.filter(isReviewTemplate) : [];
  if (reviewTemplates.length === 1) Object.assign(config, { templateId: reviewTemplates[0].id, contentHash: reviewTemplates[0].contentHash, channel: reviewTemplates[0].channel });
  return { key: freshKey(steps, kind), kind, config } as WorkflowStep;
}

/**
 * Why the workflow can't be switched on right now, or null when it can. Mirrors the server's checks so the button explains itself (the
 * server checks again). A workspace pause doesn't block switching on: it stops runs from acting, and the editor says so separately.
 */
export function activationBlocker(input: { status: EditorWorkflow["status"]; publishedVersion: VersionItem | null; gate: RunGate }): string | null {
  const v = input.publishedVersion;
  if (input.status === "archived") return "Restore it first.";
  if (input.gate.ownerProblem) return input.gate.ownerProblem;
  if (!v) return "Publish a version first.";
  if (v.effects.length && v.approval !== "approved") {
    if (v.approval === "pending") return `Waiting for the owner to approve version ${v.version}.`;
    if (v.approval === "rejected") return `The owner declined version ${v.version}. Change it, publish and ask again.`;
    if (v.approval === "expired") return `The owner's approval of version ${v.version} has lapsed. Ask again.`;
    return `Version ${v.version} sends messages or calls outside systems, so the owner approves it first.`;
  }
  return null;
}

/** What a version will send or call, step by step, exactly as approving it would allow. */
export interface EffectItem {
  stepKey: string;
  stepNumber: number;
  kind: "send_message" | "webhook" | "n8n" | "ai_task" | "http_request" | "slack_message";
  title: string;
  lines: Array<{ label: string; value: string }>;
  /** The exact wording, for messages. */
  message?: { subject: string | null; body: string } | null;
  /** Problems that would stop this step, e.g. the template's approved wording changed. */
  warning?: string | null;
  /** The step waits for a person each time as well. */
  asksFirst?: boolean;
}

export function effectItems(def: WorkflowDefinition, options: EditorOptions): EffectItem[] {
  const names = namesFrom(options);
  const numbers = new Map(orderedKeys(layoutCanvas(def.steps).items).map((k, i) => [k, i + 1] as const));
  const out: EffectItem[] = [];
  def.steps.forEach((s, i) => {
    const n = numbers.get(s.key) ?? i + 1;
    const asksFirst = !!s.requireApproval;
    if (s.kind === "send_message") {
      const c = s.config as SendMessageConfig;
      const t = options.templates.find((x) => x.id === c.templateId);
      const purpose = t?.purpose === "marketing" ? "marketing" : "service";
      const channel = CHANNEL_LABELS[c.channel] ?? c.channel;
      out.push({
        stepKey: s.key, stepNumber: n, kind: "send_message", asksFirst,
        title: `${channel} message: ${t?.name ?? "template no longer approved"}`,
        lines: [
          { label: "To", value: `The contact the run is for, only if they agreed to ${purpose} messages by ${channel} and haven't opted out` },
          { label: "Sent as", value: names.agent(c.sendAs) },
          { label: "When", value: c.businessHoursOnly ? "During business hours, never in quiet hours" : "Any time outside quiet hours" },
          { label: "Limits", value: "Frequency limits, a person taking over the conversation and your message credits are checked when it sends" },
        ],
        message: t ? { subject: t.subject, body: t.body } : null,
        warning: !t ? "This template isn't approved any more, so this step can't send."
          : t.contentHash !== c.contentHash ? "The template's approved wording changed after this step was set up. Choose it again and publish."
          : blockedText(sendAsState(options.employees.find((x) => x.roleKey === c.sendAs))),
      });
    } else if (s.kind === "request_review") {
      const c = s.config as { templateId: string; contentHash: string; channel: "email" | "sms" | "whatsapp"; businessHoursOnly: boolean };
      const t = options.templates.find((x) => x.id === c.templateId);
      const channel = CHANNEL_LABELS[c.channel] ?? c.channel;
      out.push({
        stepKey: s.key, stepNumber: n, kind: "send_message", asksFirst,
        title: `Review request by ${channel}: ${t?.name ?? "template no longer approved"}`,
        lines: [
          { label: "To", value: `The contact the run is for, only if they agreed to messages by ${channel}, haven't opted out and weren't asked for a review in the last 30 days` },
          { label: "Link", value: "Their own private page: a feedback form for you, and your public review links (the same for everyone)" },
          { label: "When", value: c.businessHoursOnly ? "During business hours, never in quiet hours" : "Any time outside quiet hours" },
          { label: "Limits", value: "Frequency limits and your message credits are checked when it sends" },
        ],
        message: t ? { subject: t.subject, body: t.body } : null,
        warning: !t ? "This template isn't approved any more, so this step can't send." : t.contentHash !== c.contentHash ? "The template's approved wording changed after this step was set up. Choose it again and publish." : null,
      });
    } else if (s.kind === "webhook") {
      const c = s.config as WebhookConfig;
      const w = options.webhooks.find((x) => x.id === c.subscriptionId && x.active);
      out.push({
        stepKey: s.key, stepNumber: n, kind: "webhook", asksFirst, title: `Webhook to ${w?.name ?? "an inactive endpoint"}`,
        lines: [
          { label: "Address", value: w?.host ? `https://${w.host}/…` : "Unknown" },
          { label: "Sends", value: c.includeContact ? "What started the run, plus the contact's name, email and phone" : "What started the run (no contact details)" },
          { label: "Signed", value: "With the endpoint's own secret; retried if the endpoint is down" },
        ],
        warning: w ? null : "This endpoint isn't active.",
      });
    } else if (s.kind === "n8n") {
      const c = s.config as N8nConfig;
      const m = options.n8nMappings.find((x) => x.id === c.mappingId);
      out.push({
        stepKey: s.key, stepNumber: n, kind: "n8n", asksFirst, title: `n8n automation: ${m?.label ?? "no longer verified"}`,
        lines: [
          { label: "Sends", value: c.includeContact ? "What started the run, plus the contact's name, email and phone" : "What started the run (no contact details)" },
          { label: "Once", value: "Started at most once per run step; an unclear result is marked for review, never sent again" },
        ],
        warning: m ? m.problem : "This automation isn't verified for your workspace any more.",
      });
    } else if (s.kind === "http_request") {
      const c = s.config as HttpRequestConfig;
      const conn = (options.connections ?? []).find((x) => x.id === c.connectionId);
      out.push({
        stepKey: s.key, stepNumber: n, kind: "http_request", asksFirst, title: `${c.method} ${conn?.host ?? "a connection that isn't available"}${c.path.startsWith("/") ? c.path.split("?")[0].slice(0, 60) : ""}`,
        lines: [
          { label: "Connection", value: conn ? `${conn.name} (${conn.host})` : "Not available" },
          { label: "Sends", value: c.bodyType === "none" ? "No body" : `A ${c.bodyType} body built from this workflow's text, with placeholders filled from the contact` },
          { label: "Safeguards", value: "Only that host, only public addresses, no redirects, a time limit and a size limit; credentials stay on the connection and are never shown" },
          { label: "If it fails", value: c.safeToRepeat ? "Tried again, because the other system ignores repeats of the same request" : "Tried again only when it was certainly not sent; otherwise marked for review, never repeated blindly" },
        ],
        warning: !conn ? "This connection isn't available any more." : conn.status !== "active" ? "This connection hasn't been verified (or needs attention), so the step would wait." : null,
      });
    } else if (s.kind === "slack_message") {
      const c = s.config as SlackMessageConfig;
      const conn = (options.connections ?? []).find((x) => x.id === c.connectionId);
      out.push({
        stepKey: s.key, stepNumber: n, kind: "slack_message", asksFirst, title: `Slack message via ${conn?.name ?? "a connection that isn't available"}`,
        lines: [
          { label: "Posts", value: c.text },
          { label: "To", value: conn ? `The channel behind “${conn.name}”` : "Not available" },
          { label: "Safeguards", value: "Mentions and links in the text are made harmless; the Slack address is never shown" },
        ],
        warning: !conn ? "This connection isn't available any more." : conn.status !== "active" ? "This connection hasn't been verified (or needs attention), so the step would wait." : null,
      });
    } else if (s.kind === "ai_task") {
      const c = s.config as AiTaskConfig;
      const e = options.employees.find((x) => x.roleKey === c.roleKey);
      out.push({
        stepKey: s.key, stepNumber: n, kind: "ai_task", asksFirst, title: `Ask ${names.agent(c.roleKey)}`,
        lines: [
          { label: "Instruction", value: c.instruction },
          { label: "Its mode", value: e?.mode === "autonomous" ? "Acts on its own, within its tools" : e?.mode === "paused" ? AI_PAUSED : "Asks you before changing anything" },
        ],
        warning: e ? blockedText(aiTaskState(e)) : "That AI employee isn't included in your workspace.",
      });
    }
  });
  return out.sort((a, b) => a.stepNumber - b.stepNumber);
}

// ---------------------------------------------------------------------------
// Whether a step's AI employee or n8n automation can act right now
// ---------------------------------------------------------------------------

type Employee = EditorOptions["employees"][number];

/** "ok": it acts. "paused": the employee is paused, so the step is skipped until it's resumed. "blocked": the step can't do anything yet. */
export interface ReadyState {
  state: "ok" | "paused" | "blocked";
  text: string;
}

/** The paused copy, the same wherever it shows: the engine skips the step (it doesn't wait) and the run carries on. */
export const AI_PAUSED = "Paused: this step is skipped while it's paused (nothing is asked) and the run carries on";

/**
 * What an "Ask AI employee" step does with this employee right now, in the order requestAgentTask checks when the step runs: included,
 * paused, its connection check, connected to its AI service, live runs verified. Anything but "ok" means the step is skipped and the run
 * carries on; nothing is asked.
 */
export function aiTaskState(e: Employee | undefined): ReadyState {
  if (!e || !e.enabled) return { state: "blocked", text: "That AI employee isn't included in your workspace, so this step is skipped." };
  if (e.mode === "paused") return { state: "paused", text: `${AI_PAUSED}.` };
  if (!e.ready) return { state: "blocked", text: `${e.name} hasn't passed its connection check, so this step is skipped (nothing is asked) and the run carries on.` };
  if (!e.connected) return { state: "blocked", text: `${e.name} isn't connected to its AI service yet, so this step is skipped (nothing is asked) and the run carries on.` };
  if (!e.liveRuns) return { state: "blocked", text: "AI employee runs are switched off for now, so this step is skipped (nothing is asked) and the run carries on." };
  return { state: "ok", text: e.mode === "autonomous" ? "Acts on its own within its tools." : "Asks you before it changes anything." };
}

/** Whether a message can go out under this employee, as the send path's gate decides: included, not paused, passed its connection check. */
export function sendAsState(e: Employee | undefined): ReadyState {
  if (!e || !e.enabled) return { state: "blocked", text: "That AI employee isn't included in your workspace, so nothing is sent." };
  if (e.mode === "paused") return { state: "paused", text: `${e.name} is paused: while it is, this step sends nothing (it's skipped) and the run carries on.` };
  if (!e.ready) return { state: "blocked", text: `${e.name} hasn't passed its connection check, so this step sends nothing (it's skipped) and the run carries on.` };
  return { state: "ok", text: "" };
}

const blockedText = (r: ReadyState) => (r.state === "blocked" ? r.text : null);

/**
 * Warnings for steps that are set up correctly but can't act right now (an AI employee that isn't connected, live AI runs switched off, an
 * n8n automation that can't be started). They don't stop publishing; the step panel shows the same words next to the choice. Missing
 * choices are the validator's errors, so they aren't repeated here.
 */
export function readinessIssues(def: Pick<WorkflowDefinition, "steps">, options: EditorOptions): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const warn = (stepKey: string, message: string) => out.push({ level: "warning", code: "not_ready", message, stepKey });
  for (const s of def.steps ?? []) {
    if (s.kind === "ai_task") {
      const e = options.employees.find((x) => x.roleKey === (s.config as AiTaskConfig).roleKey);
      const r = aiTaskState(e);
      if (e && r.state !== "ok") warn(s.key, r.text);
    } else if (s.kind === "send_message") {
      const e = options.employees.find((x) => x.roleKey === (s.config as SendMessageConfig).sendAs);
      const r = sendAsState(e);
      if (e && r.state !== "ok") warn(s.key, r.text);
    } else if (s.kind === "n8n") {
      const m = options.n8nMappings.find((x) => x.id === (s.config as N8nConfig).mappingId);
      if (m?.problem) warn(s.key, m.problem);
    }
  }
  return out;
}

/**
 * Where keyboard focus goes after a step is removed (its card, menu or panel button no longer exists): the card of the step that led to
 * it, or the trigger when nothing did. Steps removed with it (an if / else's paths) are passed over.
 */
export function focusTargetAfterRemove(steps: readonly WorkflowStep[], key: string): string {
  const gone = new Set([key, ...(steps.find((s) => s.key === key)?.kind === "branch" ? branchMembers(steps, key) : [])]);
  const leadsTo = (s: WorkflowStep) => s.next === key || s.branches?.yes === key || s.branches?.no === key;
  return steps.find((s) => !gone.has(s.key) && leadsTo(s))?.key ?? "trigger";
}

export type TemplateInputValue = string | { pipelineId: string; stageId: string } | { templateId: string; contentHash: string; channel: "email" | "sms" | "whatsapp" } | null;

/** The labels of a template's required choices that haven't been made yet. */
export function missingTemplateInputs(t: Pick<WorkflowTemplateItem, "inputs">, values: Record<string, TemplateInputValue | undefined>): string[] {
  return t.inputs.filter((i) => i.required && !values[i.key]).map((i) => i.label);
}
