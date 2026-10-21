// Plain-language summaries for the workflow screens: what a trigger listens for, what each step will do, what a version can do outside
// the CRM. Pure functions over the definition and the workspace's names (tags, stages, people, templates), so the list, the canvas, the
// approval dialog and the run timeline all describe a step the same way. Safe to call from server views and client components alike.
import type { RunStatus } from "@/components/crm/workflows/parts";
import { AGENT_ROLES } from "@/lib/agents";
import { CHANNEL_LABELS } from "@/lib/messaging";
import { idleLabel } from "@/lib/inbox";
import { CONTACT_FILTER_FIELDS, isGroup, OP_LABELS, type FilterCondition, type FilterGroup } from "@/lib/crm/filters";
import { CREATED_VIA_LABELS, LEAD_STATUS_LABELS, PREFERRED_CHANNEL_LABELS } from "@/lib/crm/types";
import { CALL_STATUS_LABELS } from "@/components/crm/calls/model";
import {
  EFFECT_LABELS as SPEC_EFFECT_LABELS, isStepKind, isTriggerType, OPPORTUNITY_CONDITION_FIELDS, STEP_KINDS, TRIGGERS, UPDATABLE_FIELDS,
  type AiTaskConfig, type AssignConfig, type BranchConfig, type CreateOpportunityConfig, type CreateTaskConfig, type HttpRequestConfig, type InternalNoteConfig, type MoveStageConfig,
  type N8nConfig, type NotifyTeamConfig, type SendMessageConfig, type SlackMessageConfig, type TriggerConfig, type UpdateFieldConfig, type WaitConfig, type WebhookConfig, type WorkflowStep,
} from "@/lib/crm/workflow/spec";

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet" | "outline";

// ---------------------------------------------------------------------------
// Effects (crm_workflow_versions.effects)
// ---------------------------------------------------------------------------

/** Short badge labels; the spec's EFFECT_LABELS are the long form used where the approval is explained. */
const EFFECT_LABELS: Record<string, string> = {
  send_email: "Sends email",
  send_sms: "Sends SMS",
  send_whatsapp: "Sends WhatsApp",
  webhook: "Calls a webhook",
  http: "Calls a web address",
  slack: "Posts to Slack",
  n8n: "Runs n8n",
  hermes: "Asks an AI employee",
};
export const EFFECT_TONE: Record<string, Tone> = { send_email: "primary", send_sms: "primary", send_whatsapp: "primary", webhook: "warning", http: "warning", slack: "warning", n8n: "warning", hermes: "violet" };
export function effectLabel(effect: string): string {
  return EFFECT_LABELS[effect] ?? effect.replace(/_/g, " ");
}
export function effectLongLabel(effect: string): string {
  return (SPEC_EFFECT_LABELS as Record<string, string>)[effect] ?? effectLabel(effect);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type RunFilter = "" | "open" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "test";
export const RUN_FILTERS: Array<{ value: RunFilter; label: string }> = [
  { value: "", label: "All" },
  { value: "open", label: "In progress" },
  { value: "awaiting_approval", label: "Needs approval" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "test", label: "Test runs" },
];
export function parseRunFilter(v: unknown): RunFilter {
  return RUN_FILTERS.some((f) => f.value === v) ? (v as RunFilter) : "";
}
/** The run statuses a filter shows (test runs are filtered by how they started, not by status). */
export function statusesFor(filter: RunFilter): RunStatus[] | null {
  switch (filter) {
    case "open":
      return ["queued", "running", "waiting", "awaiting_approval"];
    case "awaiting_approval":
      return ["awaiting_approval"];
    case "completed":
      return ["completed"];
    case "failed":
      return ["failed", "dead"];
    case "cancelled":
      return ["cancelled"];
    default:
      return null;
  }
}

/** "4 s", "2 min 5 s", "3 h 10 min". */
export function durationText(fromIso: string, toIso: string): string {
  const ms = Math.max(0, new Date(toIso).getTime() - new Date(fromIso).getTime());
  if (ms < 1000) return "under a second";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

// ---------------------------------------------------------------------------
// Step kinds
// ---------------------------------------------------------------------------

export function kindLabel(kind: string): string {
  return isStepKind(kind) ? STEP_KINDS[kind].label : kind.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Names: the workspace's labels for the ids a definition holds
// ---------------------------------------------------------------------------

/** The lists the summaries read names from. The editor's options satisfy it; the server views build it from the same services. */
export interface NameSource {
  tags?: Array<{ id: string; name: string }>;
  members?: Array<{ id: string; name: string }>;
  pipelines?: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
  contactFields?: Array<{ id: string; label: string }>;
  opportunityFields?: Array<{ id: string; label: string }>;
  templates?: Array<{ id: string; name: string; channel: string }>;
  unapprovedTemplates?: Array<{ id: string; name: string }>;
  assignmentRules?: Array<{ id: string; name: string }> | null;
  n8nMappings?: Array<{ id: string; label: string }>;
  webhooks?: Array<{ id: string; name: string }>;
  connections?: Array<{ id: string; name: string }>;
  employees?: Array<{ roleKey: string; name: string }>;
  calendars?: Array<{ id: string; name: string }>;
  appointmentTypes?: Array<{ id: string; name: string }>;
  forms?: Array<{ id: string; name: string }>;
}

export interface Names {
  tag: (id: string) => string | undefined;
  user: (id: string) => string | undefined;
  pipeline: (id: string) => string | undefined;
  stage: (id: string) => string | undefined;
  field: (id: string) => string | undefined;
  template: (id: string) => { name: string; channel: string } | undefined;
  rule: (id: string) => string | undefined;
  n8n: (id: string) => string | undefined;
  webhook: (id: string) => string | undefined;
  connection: (id: string) => string | undefined;
  agent: (roleKey: string) => string;
  calendar: (id: string) => string | undefined;
  appointmentType: (id: string) => string | undefined;
  /** A native form's name (the "Form submitted" trigger's filter). */
  form?: (id: string) => string | undefined;
}

export function namesFrom(src: NameSource): Names {
  const map = <T extends { id: string }>(list: T[] | null | undefined, label: (t: T) => string) => new Map((list ?? []).map((t) => [t.id, label(t)] as const));
  const tags = map(src.tags, (t) => t.name);
  const users = map(src.members, (t) => t.name);
  const pipelines = map(src.pipelines, (t) => t.name);
  const stages = new Map((src.pipelines ?? []).flatMap((p) => p.stages.map((s) => [s.id, s.name] as const)));
  const fields = new Map([...map(src.contactFields, (f) => f.label), ...map(src.opportunityFields, (f) => f.label)]);
  const templates = new Map<string, { name: string; channel: string }>([
    ...(src.unapprovedTemplates ?? []).map((t) => [t.id, { name: t.name, channel: "" }] as const),
    ...(src.templates ?? []).map((t) => [t.id, { name: t.name, channel: t.channel }] as const),
  ]);
  const rules = map(src.assignmentRules, (r) => r.name);
  const n8n = map(src.n8nMappings, (m) => m.label);
  const webhooks = map(src.webhooks, (w) => w.name);
  const connections = map(src.connections, (c) => c.name);
  const agents = new Map((src.employees ?? []).map((e) => [e.roleKey, e.name] as const));
  const calendars = map(src.calendars, (c) => c.name);
  const types = map(src.appointmentTypes, (t) => t.name);
  const forms = map(src.forms, (f) => f.name);
  return {
    tag: (id) => tags.get(id),
    user: (id) => users.get(id),
    pipeline: (id) => pipelines.get(id),
    stage: (id) => stages.get(id),
    field: (id) => fields.get(id),
    template: (id) => templates.get(id),
    rule: (id) => rules.get(id),
    n8n: (id) => n8n.get(id),
    webhook: (id) => webhooks.get(id),
    connection: (id) => connections.get(id),
    agent: (k) => agents.get(k) ?? AGENT_ROLES.find((r) => r.key === k)?.shortName ?? k.replace(/_/g, " "),
    calendar: (id) => calendars.get(id),
    appointmentType: (id) => types.get(id),
    form: (id) => forms.get(id),
  };
}

/** "VIP", "VIP and Hot lead", "VIP, Hot lead and 2 more". Unknown ids are counted, never shown raw. */
export function listText(ids: readonly string[] | undefined, lookup: (id: string) => string | undefined, noun: [string, string]): string {
  const list = ids ?? [];
  if (!list.length) return "";
  const found = list.map((id) => lookup(id)).filter((x): x is string => Boolean(x));
  const missing = list.length - found.length;
  if (!found.length) return `${list.length} ${list.length === 1 ? noun[0] : noun[1]}`;
  const shown = found.slice(0, 2);
  const more = found.length - shown.length + missing;
  if (!more) return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : shown[0];
  return `${shown.join(", ")} and ${more} more`;
}

const UNIT_WORDS: Record<string, [string, string]> = { minutes: ["minute", "minutes"], hours: ["hour", "hours"], days: ["day", "days"] };
export function amountText(d: { amount: number; unit: string }): string {
  const w = UNIT_WORDS[d.unit] ?? [d.unit, d.unit];
  return `${d.amount.toLocaleString("en-US")} ${d.amount === 1 ? w[0] : w[1]}`;
}
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function weekdaysText(days: readonly number[] | undefined): string {
  if (!days?.length || days.length === 7) return "every day";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join() === "1,2,3,4,5") return "on weekdays";
  if (sorted.join() === "0,6") return "on weekends";
  return `on ${sorted.map((d) => WEEKDAY_SHORT[d]).join(", ")}`;
}
/** "09:00" → "9:00 AM". */
export function clockText(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm ?? "");
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function conditionText(c: FilterCondition, subject: "contact" | "opportunity", names: Names): string {
  const custom = c.field.startsWith("cf:");
  const def = custom ? null : subject === "contact" ? CONTACT_FILTER_FIELDS.find((f) => f.key === c.field) : OPPORTUNITY_CONDITION_FIELDS.find((f) => f.key === c.field);
  const label = custom ? names.field(c.field.slice(3)) ?? "A custom field" : def?.label ?? "A field";
  const op = OP_LABELS[c.op] ?? c.op.replace(/_/g, " ");
  const v = c.value;
  let value = "";
  if (Array.isArray(v)) {
    const ids = v.map(String);
    if (def?.kind === "tags") value = listText(ids, names.tag, ["tag", "tags"]);
    else if (def?.kind === "owner") value = listText(ids, names.user, ["person", "people"]);
    else if (def?.key === "pipeline" || c.op === "in_pipeline") value = listText(ids, names.pipeline, ["pipeline", "pipelines"]);
    else if (def?.key === "stage" || c.op === "in_stage") value = listText(ids, names.stage, ["stage", "stages"]);
    else value = ids.map((x) => def?.options?.find((o) => o.value === x)?.label ?? x).join(", ");
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("from" in o || "to" in o) value = `${String(o.from || "…")} – ${String(o.to || "…")}`;
    else if ("channel" in o) value = `${String(o.purpose ?? "")} ${CHANNEL_LABELS[o.channel as keyof typeof CHANNEL_LABELS] ?? String(o.channel)} consent ${String(o.status ?? "")}`.replace(/\s+/g, " ").trim();
  } else if (v !== undefined && v !== null && v !== "") {
    value = typeof v === "string" && def?.kind === "text" ? `“${v}”` : String(v);
    if (op.includes("…")) return `${label} ${op.replace("…", value)}`;
  }
  return `${label} ${op}${value ? ` ${value}` : ""}`;
}

export function conditionsText(group: FilterGroup, subject: "contact" | "opportunity", names: Names): string {
  const parts = group.conditions.map((c) => (isGroup(c) ? `(${conditionsText(c, subject, names)})` : conditionText(c, subject, names)));
  return parts.join(group.op === "and" ? " and " : " or ");
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const PRIORITY_WORDS: Record<string, string> = { low: "low priority", normal: "", high: "high priority", urgent: "urgent" };
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One line saying what a step will do, from its config and the workspace's names. An unfinished step says what's missing. */
export function stepSummary(step: Pick<WorkflowStep, "kind" | "config">, names: Names): string {
  const c = (step.config ?? {}) as Record<string, unknown>;
  switch (step.kind) {
    case "wait": {
      const w = step.config as WaitConfig;
      if (w.mode === "duration") return w.amount ? `Wait ${amountText(w)}` : "Choose how long to wait";
      if (w.mode === "until_time") return w.time ? `Wait until ${clockText(w.time)} ${weekdaysText(w.weekdays)}` : "Choose the time to wait for";
      if (w.mode !== "until_date") return "Choose how long to wait";
      const when =
        w.source === "appointment_start" ? "the appointment starts"
        : w.source === "opportunity_close_date" ? "the deal's expected close date"
        : w.fieldId ? names.field(w.fieldId) ?? "a date field that no longer exists" : "a date field (choose one)";
      const offset = w.offset?.amount ? `${amountText(w.offset)} ${w.offset.direction} ` : "";
      return `Wait until ${offset}${when}${w.ifMissing === "end" ? " (ends the run if there's no date)" : ""}`;
    }
    case "branch": {
      const b = step.config as BranchConfig;
      const parts: string[] = [];
      if (b.reply) parts.push(b.reply === "replied" ? "they replied since this run started" : "they haven't replied since this run started");
      if (b.filter?.conditions?.length) parts.push(conditionsText(b.filter, b.subject, names));
      return parts.length ? `If ${b.subject === "opportunity" ? "the deal: " : ""}${parts.join(", and ")}` : "Add conditions to check";
    }
    case "add_tag":
    case "remove_tag": {
      const ids = (c.tagIds as string[] | undefined) ?? [];
      if (!ids.length) return "Choose tags";
      return `${step.kind === "add_tag" ? "Add" : "Remove"} ${listText(ids, names.tag, ["tag", "tags"])}`;
    }
    case "assign": {
      const a = step.config as AssignConfig;
      const what = a.subject === "opportunity" ? "the deal" : "the contact";
      const who = a.to === "rule" ? (a.ruleId ? `the next person in “${names.rule(a.ruleId) ?? "an inactive rule"}”` : null) : a.userId ? names.user(a.userId) ?? "a former teammate" : null;
      if (!who) return a.to === "rule" ? "Choose an assignment rule" : "Choose who gets it";
      return `Assign ${what} to ${who}${a.onlyIfUnassigned ? " if it has no owner" : ""}`;
    }
    case "create_task": {
      const t = step.config as CreateTaskConfig;
      if (!t.title?.trim()) return "Give the task a title";
      const who = t.assignee === "contact_owner" ? "the contact's owner" : t.assignee === "user" ? (t.userId ? names.user(t.userId) ?? "a former teammate" : "someone to choose") : "nobody in particular";
      const due = t.dueIn ? (t.dueIn.amount ? `, due in ${amountText(t.dueIn)}` : ", due right away") : "";
      const pr = PRIORITY_WORDS[t.priority] ? ` (${PRIORITY_WORDS[t.priority]})` : "";
      return `Task “${clip(t.title, 60)}” for ${who}${due}${pr}`;
    }
    case "update_field": {
      const u = step.config as UpdateFieldConfig;
      const what = u.subject === "opportunity" ? "deal" : "contact";
      const custom = u.field?.startsWith("cf:");
      const builtIn = custom ? null : (UPDATABLE_FIELDS[u.subject] as Record<string, { label: string } | undefined>)?.[u.field];
      const label = custom ? names.field(u.field.slice(3)) ?? "custom field" : builtIn?.label ?? "field";
      if (!u.field) return "Choose a field";
      if (u.value === null || u.value === "" || (Array.isArray(u.value) && !u.value.length)) return `Clear the ${what}'s ${label.toLowerCase()}`;
      let value = Array.isArray(u.value) ? u.value.join(", ") : String(u.value);
      if (!custom && u.field === "lead_status") value = LEAD_STATUS_LABELS[u.value as keyof typeof LEAD_STATUS_LABELS] ?? value;
      if (!custom && u.field === "preferred_channel") value = PREFERRED_CHANNEL_LABELS[u.value as keyof typeof PREFERRED_CHANNEL_LABELS] ?? value;
      if (typeof u.value === "boolean") value = u.value ? "Yes" : "No";
      return `Set the ${what}'s ${label.toLowerCase()} to ${clip(value, 60)}`;
    }
    case "create_opportunity": {
      const o = step.config as CreateOpportunityConfig;
      if (!o.pipelineId || !o.stageId) return "Choose the pipeline and stage";
      return `Create deal “${clip(o.name || "Untitled", 50)}” in ${names.pipeline(o.pipelineId) ?? "a pipeline that no longer exists"} › ${names.stage(o.stageId) ?? "a missing stage"}${o.skipIfOpenInPipeline ? ", unless one is already open there" : ""}`;
    }
    case "move_stage": {
      const m = step.config as MoveStageConfig;
      if (!m.pipelineId || !m.stageId) return "Choose the stage";
      return `Move the deal to ${names.pipeline(m.pipelineId) ?? "a pipeline that no longer exists"} › ${names.stage(m.stageId) ?? "a missing stage"}`;
    }
    case "send_message": {
      const s = step.config as SendMessageConfig;
      if (!s.templateId) return "Choose an approved template";
      const t = names.template(s.templateId);
      const ch = s.channel ? CHANNEL_LABELS[s.channel] : "message";
      return `Send ${ch} “${t?.name ?? "a template that's no longer approved"}” as ${names.agent(s.sendAs)}${s.businessHoursOnly ? ", in business hours" : ""}`;
    }
    case "request_review": {
      const r = step.config as { templateId?: string; channel?: keyof typeof CHANNEL_LABELS; businessHoursOnly?: boolean };
      if (!r.templateId) return "Choose a review request template";
      const t = names.template(r.templateId);
      return `Ask for a review by ${r.channel ? CHANNEL_LABELS[r.channel] : "message"} with “${t?.name ?? "a template that's no longer approved"}”${r.businessHoursOnly ? ", in business hours" : ""}`;
    }
    case "notify_team": {
      const n = step.config as NotifyTeamConfig;
      const who: string[] = [];
      if (n.roles?.includes("owner")) who.push("the owner");
      if (n.roles?.includes("admin")) who.push("managers");
      if (n.contactOwner) who.push("the contact's owner");
      if (n.userIds?.length) who.push(listText(n.userIds, names.user, ["person", "people"]));
      if (!n.title?.trim()) return "Say what the notification is about";
      return `Notify ${who.join(", ") || "nobody yet"}: “${clip(n.title, 60)}”`;
    }
    case "internal_note": {
      const n = step.config as InternalNoteConfig;
      if (!n.body?.trim()) return "Write the note";
      return `Note on the ${n.subject === "opportunity" ? "deal" : "contact"}: “${clip(n.body)}”`;
    }
    case "n8n": {
      const n = step.config as N8nConfig;
      if (!n.mappingId) return "Choose a verified n8n automation";
      return `Start n8n automation “${names.n8n(n.mappingId) ?? "no longer verified"}”${n.includeContact ? " with the contact's details" : ""}`;
    }
    case "webhook": {
      const w = step.config as WebhookConfig;
      if (!w.subscriptionId) return "Choose a webhook endpoint";
      return `Send a signed request to “${names.webhook(w.subscriptionId) ?? "an inactive endpoint"}”${w.includeContact ? " with the contact's details" : ""}`;
    }
    case "http_request": {
      const h = step.config as HttpRequestConfig;
      if (!h.connectionId) return "Choose a connection";
      return `${h.method} ${names.connection(h.connectionId) ?? "an unavailable connection"}${h.path ? ` ${clip(h.path, 40)}` : ""}`;
    }
    case "slack_message": {
      const m = step.config as SlackMessageConfig;
      if (!m.connectionId) return "Choose a Slack connection";
      return m.text?.trim() ? `Post to Slack (${names.connection(m.connectionId) ?? "an unavailable connection"}): “${clip(m.text)}”` : "Write the Slack message";
    }
    case "ai_task": {
      const a = step.config as AiTaskConfig;
      if (!a.instruction?.trim()) return `Tell ${names.agent(a.roleKey)} what to do`;
      return `Ask ${names.agent(a.roleKey)}: “${clip(a.instruction)}”`;
    }
    case "end":
      return "Stop the workflow here";
    default:
      return kindLabel(step.kind);
  }
}

/** The two side labels of an if / else, for the canvas. */
export function branchSideLabels(step: Pick<WorkflowStep, "kind" | "config">, names: Names): { yes: string; no: string } {
  const s = stepSummary(step, names);
  return { yes: s.startsWith("If ") ? s.slice(3) : "Conditions match", no: "Otherwise" };
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** The trigger's label plus its filters in words: "Deal moved to a stage" · "into Won · in Sales". */
export function triggerSummary(t: TriggerConfig | null | undefined, names: Names): { title: string; detail: string } {
  if (!t || !isTriggerType(t.type)) return { title: "Choose what starts this workflow", detail: "" };
  const spec = TRIGGERS[t.type];
  const f = t.filters ?? {};
  const bits: string[] = [];
  if (f.createdVia?.length) bits.push(`created via ${f.createdVia.map((v) => CREATED_VIA_LABELS[v] ?? v).join(", ")}`);
  if (f.changedFields?.length) {
    const labels = f.changedFields.map((k) => (k.startsWith("cf:") ? names.field(k.slice(3)) ?? k : CONTACT_FILTER_FIELDS.find((x) => x.key === k)?.label ?? k));
    bits.push(`when ${labels.length === 1 ? "this changes" : "one of these changes"}: ${labels.join(", ")}`);
  }
  if (f.tagIds?.length) bits.push(listText(f.tagIds, names.tag, ["tag", "tags"]));
  if (f.assigneeIds?.length) bits.push(`for ${listText(f.assigneeIds, names.user, ["person", "people"])}`);
  if (f.pipelineId) bits.push(`in ${names.pipeline(f.pipelineId) ?? "a pipeline that no longer exists"}`);
  if (f.stageIds?.length) bits.push(`${t.type === "opportunity.stage_changed" ? "into" : "in"} ${listText(f.stageIds, names.stage, ["stage", "stages"])}`);
  if (f.fromStageIds?.length) bits.push(`out of ${listText(f.fromStageIds, names.stage, ["stage", "stages"])}`);
  if (f.calendarIds?.length) bits.push(`on ${listText(f.calendarIds, names.calendar, ["calendar", "calendars"])}`);
  if (f.appointmentTypeIds?.length) bits.push(`for ${listText(f.appointmentTypeIds, names.appointmentType, ["appointment type", "appointment types"])}`);
  if (f.formIds?.length) bits.push(`to ${listText(f.formIds, names.form ?? (() => undefined), ["form", "forms"])}`);
  if (f.consentStatus || f.consentPurpose) bits.push(`when they ${f.consentStatus === "granted" ? "give" : f.consentStatus === "revoked" ? "withdraw" : "give or withdraw"} ${f.consentPurpose ?? ""} consent`.replace(/\s+/g, " "));
  if (f.channels?.length) bits.push(`on ${f.channels.map((c) => CHANNEL_LABELS[c]).join(", ")}`);
  if (f.idleHours?.length) bits.push(`quiet for ${f.idleHours.map(idleLabel).join(", ")}`);
  if (f.callDirections?.length === 1) bits.push(f.callDirections[0] === "inbound" ? "incoming calls" : "outgoing calls");
  if (f.callStatuses?.length) bits.push(`ended as ${f.callStatuses.map((s) => CALL_STATUS_LABELS[s].toLowerCase()).join(", ")}`);
  if (t.type === "schedule" && t.schedule) bits.push(`${t.schedule.frequency === "weekly" ? weekdaysText(t.schedule.weekdays) : "every day"} at ${clockText(t.schedule.time)}`);
  if (t.type === "inbound_webhook" && t.inbound) bits.push(t.inbound.match === "email_or_phone" ? `matched by email or phone${t.inbound.createContact ? ", adding new contacts" : ""}` : "without a contact");
  if (t.contactFilter?.conditions.length) bits.push(`only contacts where ${conditionsText(t.contactFilter, "contact", names)}`);
  if (t.reentry === "once") bits.push("once per contact");
  if (t.reentry === "not_while_active") bits.push("not while they're already in it");
  return { title: spec.label, detail: bits.join(" · ") };
}

/** One line for lists: "Deal moved to a stage · into Won". */
export function triggerLine(t: TriggerConfig | null | undefined, names: Names): string {
  const s = triggerSummary(t, names);
  return s.detail ? `${s.title} · ${s.detail}` : s.title;
}
