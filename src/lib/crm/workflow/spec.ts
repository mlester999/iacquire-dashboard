// The native workflow engine's contract: which triggers exist, which step kinds exist (each with a validated config, what it can do outside
// the CRM, and whether it branches), the definition shape the editor saves and the server freezes into versions, the validator, the effect
// derivation that decides whether an owner must approve a version, and the content hash an approval is bound to.
//
// Pure (no I/O), so the editor and the server apply exactly the same rules. Every trigger and step kind listed here has a real executor in
// src/server/crm/workflows (and the dispatcher in src/server/crm/dispatch.ts); nothing is listed that the engine cannot do.
import { z } from "zod";
import { CONTACT_FILTER_FIELDS, OPS_BY_KIND, checkFilterShape, customFieldOps, filterGroupSchema, isGroup, type FieldKind, type FilterCondition, type FilterGroup } from "@/lib/crm/filters";
import { CREATED_VIA, LEAD_STATUSES, PREFERRED_CHANNELS, type FieldType } from "@/lib/crm/types";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { customValueKeyOf, extractTokens, isTokenKey } from "@/lib/messaging/tokens";
import { sha256Hex } from "@/lib/crm/workflow/sha256";
import { HTTP_METHODS, cleanStepHeaders, pathProblem } from "@/lib/automation-studio/outbound";

export type MessageChannel = "email" | "sms" | "whatsapp";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_RE, "Choose an item from the list.");
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const STEP_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const WORKFLOW_LIMITS = {
  /** Steps in one workflow. */
  maxSteps: 50,
  /** The longest chain of steps from the first one (cycles through a wait counted once). */
  maxDepth: 40,
  /** How many times one run may enter the same step (a loop back through a wait). */
  maxVisitsPerStep: 25,
  /** Steps one run may execute in total. */
  maxStepsPerRun: 200,
  /** The longest single wait. */
  maxWaitDays: 365,
  /** Attempts of one step before the run is given up (dead). */
  maxAttempts: 5,
} as const;

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** Event types the CRM event outbox carries (crm_events.type) that a workflow can start from. */
export const EVENT_TRIGGER_TYPES = [
  "contact.created", "contact.updated", "contact.assigned", "contact.tag_added", "contact.tag_removed", "contact.consent_changed",
  "opportunity.created", "opportunity.stage_changed", "opportunity.won", "opportunity.lost", "opportunity.reopened",
  "appointment.booked", "appointment.rescheduled", "appointment.cancelled", "appointment.no_show", "appointment.showed", "appointment.confirmed",
  "task.created", "task.completed", "task.due",
  "conversation.message_received",
  "form.submitted",
  "campaign.sent", "review.requested", "feedback.received", "call.completed",
] as const;
export type EventTriggerType = (typeof EVENT_TRIGGER_TYPES)[number];

/** Triggers that don't come from an event: a schedule, a signed inbound webhook, or a person starting the workflow for a record. */
export const OTHER_TRIGGER_TYPES = ["schedule", "inbound_webhook", "manual"] as const;
export const TRIGGER_TYPES = [...EVENT_TRIGGER_TYPES, ...OTHER_TRIGGER_TYPES] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const isEventTrigger = (t: string): t is EventTriggerType => (EVENT_TRIGGER_TYPES as readonly string[]).includes(t);
export const isTriggerType = (t: unknown): t is TriggerType => typeof t === "string" && (TRIGGER_TYPES as readonly string[]).includes(t);

export const TRIGGER_FILTER_KEYS = [
  "tagIds", "pipelineId", "stageIds", "fromStageIds", "calendarIds", "appointmentTypeIds", "channels", "consentPurpose", "consentStatus", "assigneeIds",
  "changedFields", "createdVia", "ignoreOptOutKeywords",
  "formIds",
  "callStatuses", "callDirections",
] as const;
export type TriggerFilterKey = (typeof TRIGGER_FILTER_KEYS)[number];

/** How a call can end (crm_call_records.status once final, FINAL_CALL_STATUSES in src/server/integrations/voice/types.ts). */
export const CALL_TRIGGER_STATUSES = ["completed", "no_answer", "busy", "failed", "voicemail", "cancelled"] as const;
export type CallTriggerStatus = (typeof CALL_TRIGGER_STATUSES)[number];

export interface TriggerFilters {
  /** contact.tag_added / tag_removed: only these tags. */
  tagIds?: string[];
  /** Deal triggers: only deals in this pipeline. */
  pipelineId?: string;
  /** Deal created: in one of these stages. Stage changed: moved into one of these stages. */
  stageIds?: string[];
  /** Stage changed: moved out of one of these stages. */
  fromStageIds?: string[];
  /** Appointment triggers: only on these calendars / appointment types (native bookings). */
  calendarIds?: string[];
  appointmentTypeIds?: string[];
  /** Message received / consent changed: only on these channels. */
  channels?: MessageChannel[];
  consentPurpose?: "service" | "marketing";
  consentStatus?: "granted" | "revoked";
  /** Contact assigned: assigned to one of these people. Task triggers: assigned to one of these people. */
  assigneeIds?: string[];
  /** Contact updated: one of these fields changed (field keys as the contact record reports them, custom fields as cf:<key>). */
  changedFields?: string[];
  /** Contact created: created this way. */
  createdVia?: Array<(typeof CREATED_VIA)[number]>;
  /** Message received: don't start for STOP / START keyword messages (default true). */
  ignoreOptOutKeywords?: boolean;
  /** Form submitted: only submissions to these native forms. */
  formIds?: string[];
  /** Call completed: only calls that ended this way. */
  callStatuses?: CallTriggerStatus[];
  /** Call completed: only incoming or only outgoing calls. */
  callDirections?: Array<"inbound" | "outbound">;
}

export interface ScheduleConfig {
  frequency: "daily" | "weekly";
  /** Wall-clock time in the workspace's time zone, HH:MM. */
  time: string;
  /** Weekly: days of the week, 0 = Sunday. */
  weekdays?: number[];
}

export interface InboundWebhookConfig {
  /** Rotating this value (by publishing) invalidates the old URL. The URL's signature is derived from it on the server. */
  nonce: string;
  /** How the incoming body is matched to a contact: by its email/phone fields, or not at all. */
  match: "email_or_phone" | "none";
  /** Create a contact when no existing one matches (only with match = email_or_phone). */
  createContact: boolean;
}

export interface TriggerConfig {
  type: TriggerType;
  filters?: TriggerFilters;
  /** Only contacts matching this Smart List filter start the workflow (evaluated when the event is dispatched). */
  contactFilter?: FilterGroup | null;
  /** always: every event starts a run. once: a contact goes through this workflow at most once. not_while_active: not while they're already in it. */
  reentry?: "always" | "once" | "not_while_active";
  schedule?: ScheduleConfig;
  inbound?: InboundWebhookConfig;
}

export type CarryLevel = "always" | "maybe" | "never";

export interface TriggerSpec {
  type: TriggerType;
  label: string;
  description: string;
  group: "Contacts" | "Deals" | "Appointments" | "Tasks" | "Conversations" | "Growth" | "Other";
  /** The record the event is about. */
  entity: "contact" | "opportunity" | "appointment" | "task" | "conversation" | "none";
  /** Whether a run started this way has a contact / a deal to act on. */
  carries: { contact: CarryLevel; opportunity: CarryLevel };
  filters: readonly TriggerFilterKey[];
}

const T = (type: TriggerType, label: string, description: string, group: TriggerSpec["group"], entity: TriggerSpec["entity"], carries: TriggerSpec["carries"], filters: readonly TriggerFilterKey[] = []): TriggerSpec => ({ type, label, description, group, entity, carries, filters });
const CONTACT_ONLY = { contact: "always", opportunity: "never" } as const;
const DEAL = { contact: "maybe", opportunity: "always" } as const;

export const TRIGGERS: Record<TriggerType, TriggerSpec> = {
  "contact.created": T("contact.created", "Contact created", "A new contact is added, by hand, an import, a form, a booking or an inbound message.", "Contacts", "contact", CONTACT_ONLY, ["createdVia"]),
  "contact.updated": T("contact.updated", "Contact details changed", "Someone or something changes a contact's details.", "Contacts", "contact", CONTACT_ONLY, ["changedFields"]),
  "contact.assigned": T("contact.assigned", "Contact assigned", "A contact gets a new owner.", "Contacts", "contact", CONTACT_ONLY, ["assigneeIds"]),
  "contact.tag_added": T("contact.tag_added", "Tag added", "A tag is added to a contact.", "Contacts", "contact", CONTACT_ONLY, ["tagIds"]),
  "contact.tag_removed": T("contact.tag_removed", "Tag removed", "A tag is removed from a contact.", "Contacts", "contact", CONTACT_ONLY, ["tagIds"]),
  "contact.consent_changed": T("contact.consent_changed", "Consent changed", "A contact gives or withdraws consent on a channel.", "Contacts", "contact", CONTACT_ONLY, ["channels", "consentPurpose", "consentStatus"]),
  "opportunity.created": T("opportunity.created", "Deal created", "A new deal is created.", "Deals", "opportunity", DEAL, ["pipelineId", "stageIds"]),
  "opportunity.stage_changed": T("opportunity.stage_changed", "Deal moved to a stage", "A deal moves to another stage.", "Deals", "opportunity", DEAL, ["pipelineId", "stageIds", "fromStageIds"]),
  "opportunity.won": T("opportunity.won", "Deal won", "A deal is marked won.", "Deals", "opportunity", DEAL, ["pipelineId"]),
  "opportunity.lost": T("opportunity.lost", "Deal lost", "A deal is marked lost.", "Deals", "opportunity", DEAL, ["pipelineId"]),
  "opportunity.reopened": T("opportunity.reopened", "Deal reopened", "A closed deal is reopened.", "Deals", "opportunity", DEAL, ["pipelineId"]),
  "appointment.booked": T("appointment.booked", "Appointment booked", "An appointment is booked on a native calendar.", "Appointments", "appointment", CONTACT_ONLY, ["calendarIds", "appointmentTypeIds"]),
  "appointment.rescheduled": T("appointment.rescheduled", "Appointment rescheduled", "An appointment moves to a new time.", "Appointments", "appointment", CONTACT_ONLY, ["calendarIds", "appointmentTypeIds"]),
  "appointment.cancelled": T("appointment.cancelled", "Appointment cancelled", "An appointment is cancelled.", "Appointments", "appointment", CONTACT_ONLY, ["calendarIds", "appointmentTypeIds"]),
  "appointment.no_show": T("appointment.no_show", "No-show", "A contact is marked as not having shown up.", "Appointments", "appointment", CONTACT_ONLY, ["calendarIds", "appointmentTypeIds"]),
  "appointment.showed": T("appointment.showed", "Showed up", "A contact is marked as having attended.", "Appointments", "appointment", CONTACT_ONLY, ["calendarIds", "appointmentTypeIds"]),
  "appointment.confirmed": T("appointment.confirmed", "Appointment confirmed", "An appointment is confirmed.", "Appointments", "appointment", CONTACT_ONLY, ["calendarIds", "appointmentTypeIds"]),
  "task.created": T("task.created", "Task created", "A task is added.", "Tasks", "task", { contact: "maybe", opportunity: "maybe" }, ["assigneeIds"]),
  "task.completed": T("task.completed", "Task completed", "A task is marked done.", "Tasks", "task", { contact: "maybe", opportunity: "maybe" }, ["assigneeIds"]),
  "task.due": T("task.due", "Task due", "An open task reaches its due time.", "Tasks", "task", { contact: "maybe", opportunity: "maybe" }, ["assigneeIds"]),
  "conversation.message_received": T("conversation.message_received", "Customer message received", "A customer sends a message on SMS, WhatsApp or email.", "Conversations", "conversation", CONTACT_ONLY, ["channels", "ignoreOptOutKeywords"]),
  // A submission to a native form or survey, once processed. It carries the contact when the form asked for an email or phone number,
  // and the deal when the form creates one.
  "form.submitted": T("form.submitted", "Form submitted", "Someone sends one of your forms or surveys (on your website or its own page).", "Contacts", "contact", { contact: "maybe", opportunity: "maybe" }, ["formIds"]),
  // A campaign as a whole (src/server/crm/campaigns/job.ts): its totals ride in the trigger details, and the run has no contact.
  "campaign.sent": T("campaign.sent", "Campaign finished", "A campaign finishes sending: everyone on it got the message or was left out by the send rules. A run has no contact; it carries the campaign's totals.", "Growth", "none", { contact: "never", opportunity: "never" }, ["channels"]),
  "review.requested": T("review.requested", "Review requested", "A review request is sent to a contact, by someone in your team, a workflow or the API.", "Growth", "contact", { contact: "always", opportunity: "maybe" }, ["channels"]),
  // Deliberately no rating filter: every customer who answers is treated alike, so a workflow can't single out happy customers for public
  // reviews (review gating). Low ratings already create a follow-up task by themselves (src/server/crm/reviews.ts).
  "feedback.received": T("feedback.received", "Private feedback received", "A customer sends private feedback from their review request page. Every rating starts it the same way.", "Growth", "contact", CONTACT_ONLY),
  "call.completed": T("call.completed", "Call ended", "A call with your voice assistant ends, or someone in your team logs a call. It has a contact when the caller's number matches one.", "Growth", "contact", { contact: "maybe", opportunity: "never" }, ["callStatuses", "callDirections"]),
  schedule: T("schedule", "On a schedule", "Runs every day or on chosen weekdays at a set time in your workspace's time zone. A scheduled run has no contact.", "Other", "none", { contact: "never", opportunity: "never" }),
  inbound_webhook: T("inbound_webhook", "Inbound webhook", "Another system calls this workflow's private, signed URL. The body can be matched to a contact by email or phone.", "Other", "none", { contact: "maybe", opportunity: "never" }),
  manual: T("manual", "Started by a person", "Someone in your team starts the workflow for a contact.", "Other", "contact", CONTACT_ONLY),
};

const triggerFiltersSchema = z.strictObject({
  tagIds: z.array(uuid).min(1).max(20).optional(),
  pipelineId: uuid.optional(),
  stageIds: z.array(uuid).min(1).max(50).optional(),
  fromStageIds: z.array(uuid).min(1).max(50).optional(),
  calendarIds: z.array(uuid).min(1).max(50).optional(),
  appointmentTypeIds: z.array(uuid).min(1).max(50).optional(),
  channels: z.array(z.enum(["email", "sms", "whatsapp"])).min(1).max(3).optional(),
  consentPurpose: z.enum(["service", "marketing"]).optional(),
  consentStatus: z.enum(["granted", "revoked"]).optional(),
  assigneeIds: z.array(uuid).min(1).max(50).optional(),
  changedFields: z.array(z.string().trim().min(1).max(80)).min(1).max(30).optional(),
  createdVia: z.array(z.enum(CREATED_VIA)).min(1).max(CREATED_VIA.length).optional(),
  ignoreOptOutKeywords: z.boolean().optional(),
  formIds: z.array(uuid).min(1).max(50).optional(),
  callStatuses: z.array(z.enum(CALL_TRIGGER_STATUSES)).min(1).max(CALL_TRIGGER_STATUSES.length).optional(),
  callDirections: z.array(z.enum(["inbound", "outbound"])).min(1).max(2).optional(),
});

const scheduleSchema = z.strictObject({
  frequency: z.enum(["daily", "weekly"]),
  time: z.string().regex(HHMM, "Use a time like 09:00."),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
});

const inboundSchema = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "The webhook URL needs to be generated again."),
  match: z.enum(["email_or_phone", "none"]),
  createContact: z.boolean(),
});

export const triggerConfigSchema = z.strictObject({
  type: z.enum(TRIGGER_TYPES),
  filters: triggerFiltersSchema.optional(),
  contactFilter: filterGroupSchema.nullable().optional(),
  reentry: z.enum(["always", "once", "not_while_active"]).optional(),
  schedule: scheduleSchema.optional(),
  inbound: inboundSchema.optional(),
});

// ---------------------------------------------------------------------------
// Step kinds
// ---------------------------------------------------------------------------

export const STEP_KIND_LIST = [
  "wait", "branch", "add_tag", "remove_tag", "assign", "create_task", "update_field", "create_opportunity", "move_stage", "send_message",
  "notify_team", "internal_note", "n8n", "webhook", "ai_task", "end", "request_review", "http_request", "slack_message",
] as const;
export type StepKind = (typeof STEP_KIND_LIST)[number];
export const isStepKind = (k: unknown): k is StepKind => typeof k === "string" && (STEP_KIND_LIST as readonly string[]).includes(k);

/** What a version can do outside the CRM. Any of these means an owner must approve the exact version before it runs. */
export const WORKFLOW_EFFECTS = ["send_email", "send_sms", "send_whatsapp", "webhook", "n8n", "hermes", "http", "slack"] as const;
export type WorkflowEffect = (typeof WORKFLOW_EFFECTS)[number];
export const EFFECT_LABELS: Record<WorkflowEffect, string> = {
  send_email: "Sends emails to customers",
  send_sms: "Sends text messages to customers",
  send_whatsapp: "Sends WhatsApp messages to customers",
  webhook: "Sends data to an outside system (webhook)",
  n8n: "Starts an n8n automation",
  hermes: "Asks an AI employee to do work",
  http: "Calls an outside web address (HTTP request)",
  slack: "Posts a message to Slack",
};

/**
 * Premium capabilities of the optional Automation Studio plan. A version that uses any of them runs only while the workspace is entitled
 * (starting, advancing, publishing and switching on are all checked on the server). "studio_workflow" marks a workflow built in Automation
 * Studio; step kinds that only the plan includes (HTTP request, loops, connectors…) list their own feature on their spec as they are added.
 * Workflows built in the CRM workflow screens, and every step kind listed above, need no plan.
 */
export const PREMIUM_FEATURES = ["studio_workflow", "http_request", "slack_message"] as const;
export type PremiumFeature = (typeof PREMIUM_FEATURES)[number];
export const PREMIUM_FEATURE_LABELS: Record<PremiumFeature, string> = { studio_workflow: "Built in Automation Studio", http_request: "HTTP request step", slack_message: "Slack message step" };
export type WorkflowOrigin = "crm" | "studio";

const durationUnit = z.enum(["minutes", "hours", "days"]);
const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;
export const durationMinutes = (d: { amount: number; unit: keyof typeof UNIT_MINUTES }) => d.amount * UNIT_MINUTES[d.unit];

const waitSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("duration"), amount: z.number().int().min(1).max(100_000), unit: durationUnit }),
  z.strictObject({ mode: z.literal("until_time"), time: z.string().regex(HHMM, "Use a time like 09:00."), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional() }),
  z.strictObject({
    mode: z.literal("until_date"),
    /** appointment_start: the triggering appointment. contact_field / opportunity_field: a date custom field. opportunity_close_date: the deal's expected close date. */
    source: z.enum(["appointment_start", "contact_field", "opportunity_field", "opportunity_close_date"]),
    fieldId: uuid.optional(),
    offset: z.strictObject({ amount: z.number().int().min(0).max(100_000), unit: durationUnit, direction: z.enum(["before", "after"]) }),
    /** When the date is missing: carry on now, or end the run. A date already past always carries on now. */
    ifMissing: z.enum(["continue", "end"]),
  }),
]);

/** Fields a deal condition can test (branch steps on a deal). Values are compared on the server with fixed SQL and bound parameters. */
export const OPPORTUNITY_CONDITION_FIELDS: Array<{ key: string; label: string; kind: FieldKind; options?: Array<{ value: string; label: string }> }> = [
  { key: "status", label: "Status", kind: "enum", options: [{ value: "open", label: "Open" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }] },
  { key: "pipeline", label: "Pipeline", kind: "enum" },
  { key: "stage", label: "Stage", kind: "enum" },
  { key: "value", label: "Value", kind: "number" },
  { key: "owner", label: "Owner", kind: "owner" },
  { key: "tags", label: "Tags", kind: "tags" },
  { key: "source", label: "Source", kind: "text" },
  { key: "created_at", label: "Created", kind: "date" },
  { key: "expected_close_date", label: "Expected close", kind: "date" },
];

const branchSchema = z.strictObject({
  subject: z.enum(["contact", "opportunity"]),
  filter: filterGroupSchema,
  /** "No response" checks: did the contact send us a message since this run started? */
  reply: z.enum(["replied", "not_replied"]).nullable().optional(),
});

const tagsSchema = z.strictObject({ tagIds: z.array(uuid).min(1, "Choose at least one tag.").max(20) });

const assignSchema = z.strictObject({
  subject: z.enum(["contact", "opportunity"]),
  to: z.enum(["user", "rule"]),
  userId: uuid.optional(),
  ruleId: uuid.optional(),
  /** Leave records that already have an owner alone. */
  onlyIfUnassigned: z.boolean(),
});

const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1, "Give the task a title.").max(200),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  /** Due this long after the step runs; omitted for no due date. */
  dueIn: z.strictObject({ amount: z.number().int().min(0).max(100_000), unit: durationUnit }).optional(),
  assignee: z.enum(["contact_owner", "user", "none"]),
  userId: uuid.optional(),
  /** Link the task to the run's deal as well as its contact. */
  linkOpportunity: z.boolean().optional(),
});

/** Built-in fields a workflow may set. Custom fields are written as cf:<field id>. */
export const UPDATABLE_FIELDS = {
  contact: {
    lead_status: { label: "Lead status", type: "enum" as const, options: LEAD_STATUSES as readonly string[] },
    lead_score: { label: "Lead score", type: "number" as const, min: 0, max: 100 },
    preferred_channel: { label: "Preferred channel", type: "enum" as const, options: PREFERRED_CHANNELS as readonly string[] },
    source: { label: "Lead source", type: "text" as const, max: 60, required: true },
  },
  opportunity: {
    value: { label: "Deal value", type: "number" as const, min: 0, max: 999_999_999_999 },
    probability: { label: "Probability", type: "number" as const, min: 0, max: 100 },
    source: { label: "Source", type: "text" as const, max: 120 },
  },
} as const;

const fieldValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(50), z.null()]);
const updateFieldSchema = z.strictObject({
  subject: z.enum(["contact", "opportunity"]),
  field: z.string().regex(/^(cf:[0-9a-f-]{36}|[a-z_]{1,40})$/, "Choose a field."),
  value: fieldValue,
});

const createOpportunitySchema = z.strictObject({
  name: z.string().trim().min(1, "Name the deal.").max(200),
  pipelineId: uuid,
  stageId: uuid,
  value: z.number().min(0).max(999_999_999_999).nullable().optional(),
  /** The deal's owner is the contact's owner. */
  ownerFromContact: z.boolean(),
  /** Don't create another deal when the contact already has an open one in this pipeline (it becomes the run's deal instead). */
  skipIfOpenInPipeline: z.boolean(),
});

const moveStageSchema = z.strictObject({
  pipelineId: uuid,
  stageId: uuid,
  /** Required when the stage is a Lost stage. */
  lostReason: z.string().trim().max(300).optional(),
});

const sendMessageSchema = z.strictObject({
  /** A native message template, approved for automated use. */
  templateId: uuid,
  /** The approved wording this workflow was built with; if the template's approved wording changes, the step stops until republished. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, "Choose an approved template."),
  /** Copied from the template: a template has exactly one channel. */
  channel: z.enum(["email", "sms", "whatsapp"]),
  /** The AI employee the message goes out under (its mode and pauses apply). */
  sendAs: z.enum(AGENT_ROLE_KEYS),
  /** Hold the message until business hours (quiet hours always apply). */
  businessHoursOnly: z.boolean(),
});

/** A review request (src/server/crm/reviews.ts): an approved service template with {{review.link}}, sent only with service consent on its channel. */
const requestReviewSchema = z.strictObject({
  templateId: uuid,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, "Choose an approved review request template."),
  channel: z.enum(["email", "sms", "whatsapp"]),
  /** Hold the message until business hours (quiet hours always apply). */
  businessHoursOnly: z.boolean(),
});

const notifySchema = z.strictObject({
  roles: z.array(z.enum(["owner", "admin"])).max(2).optional(),
  userIds: z.array(uuid).max(20).optional(),
  contactOwner: z.boolean().optional(),
  title: z.string().trim().min(1, "Say what the notification is about.").max(160),
  body: z.string().trim().max(600).optional(),
});

const noteSchema = z.strictObject({ subject: z.enum(["contact", "opportunity"]), body: z.string().trim().min(1, "Write the note.").max(4000) });

const n8nSchema = z.strictObject({
  /** A verified agency n8n mapping for this workspace. */
  mappingId: uuid,
  /** Send the contact's name, email and phone with the trigger details. */
  includeContact: z.boolean(),
});

const webhookSchema = z.strictObject({
  /** An active outbound webhook subscription of this workspace (signed with its secret). */
  subscriptionId: uuid,
  includeContact: z.boolean(),
});

const nameValue = z.strictObject({ name: z.string().trim().min(1).max(60), value: z.string().max(300) });
/** An HTTP request to a connection's host. The host is the connection's, never written here; the path, query and body may hold {{placeholders}}. */
const httpRequestSchema = z.strictObject({
  connectionId: uuid,
  method: z.enum(HTTP_METHODS),
  path: z.string().trim().min(1, "Write the path to call, for example /v1/orders.").max(300),
  query: z.array(nameValue).max(20).optional(),
  /** Extra harmless headers (Accept, X-…). Credentials come from the connection. */
  headers: z.array(nameValue).max(8).optional(),
  bodyType: z.enum(["none", "json", "form", "text"]),
  /** JSON text (strings inside it may hold placeholders) or plain text. */
  body: z.string().max(4000).optional(),
  form: z.array(nameValue).max(20).optional(),
  timeoutSeconds: z.number().int().min(1).max(30).optional(),
  /** The other system ignores a repeat of the same request (it honours the Idempotency-Key), so a failed attempt may be retried. */
  safeToRepeat: z.boolean().optional(),
});

const slackMessageSchema = z.strictObject({
  connectionId: uuid,
  text: z.string().trim().min(1, "Write the message.").max(1500),
});

const aiTaskSchema = z.strictObject({
  roleKey: z.enum(AGENT_ROLE_KEYS),
  instruction: z.string().trim().min(10, "Tell the AI employee what to do (at least a sentence).").max(2000),
});

const endSchema = z.strictObject({});

export type WaitConfig = z.infer<typeof waitSchema>;
export type BranchConfig = z.infer<typeof branchSchema>;
export type TagsConfig = z.infer<typeof tagsSchema>;
export type AssignConfig = z.infer<typeof assignSchema>;
export type CreateTaskConfig = z.infer<typeof createTaskSchema>;
export type UpdateFieldConfig = z.infer<typeof updateFieldSchema>;
export type CreateOpportunityConfig = z.infer<typeof createOpportunitySchema>;
export type MoveStageConfig = z.infer<typeof moveStageSchema>;
export type SendMessageConfig = z.infer<typeof sendMessageSchema>;
export type NotifyTeamConfig = z.infer<typeof notifySchema>;
export type RequestReviewConfig = z.infer<typeof requestReviewSchema>;
export type InternalNoteConfig = z.infer<typeof noteSchema>;
export type N8nConfig = z.infer<typeof n8nSchema>;
export type WebhookConfig = z.infer<typeof webhookSchema>;
export type AiTaskConfig = z.infer<typeof aiTaskSchema>;
export type HttpRequestConfig = z.infer<typeof httpRequestSchema>;
export type SlackMessageConfig = z.infer<typeof slackMessageSchema>;

export interface StepConfigMap {
  wait: WaitConfig;
  branch: BranchConfig;
  add_tag: TagsConfig;
  remove_tag: TagsConfig;
  assign: AssignConfig;
  create_task: CreateTaskConfig;
  update_field: UpdateFieldConfig;
  create_opportunity: CreateOpportunityConfig;
  move_stage: MoveStageConfig;
  send_message: SendMessageConfig;
  request_review: RequestReviewConfig;
  notify_team: NotifyTeamConfig;
  internal_note: InternalNoteConfig;
  n8n: N8nConfig;
  webhook: WebhookConfig;
  ai_task: AiTaskConfig;
  end: Record<string, never>;
  http_request: HttpRequestConfig;
  slack_message: SlackMessageConfig;
}

export type Need = "required" | "optional" | "none";

export interface StepSpec<K extends StepKind = StepKind> {
  kind: K;
  label: string;
  description: string;
  group: "Flow" | "Contact" | "Deals" | "Tasks & notes" | "Messages" | "Team" | "Integrations" | "AI";
  schema: z.ZodType<StepConfigMap[K]>;
  /** A branch step has yes/no paths instead of one next step. */
  branches: boolean;
  /** The run ends here. */
  terminal: boolean;
  /** Calls a system outside iAcquire directly (claimed, called outside any transaction, recorded; an unknown outcome is never retried blindly). */
  external: boolean;
  /** Changes CRM records, which records events other workflows can react to (the loop limit applies). */
  emitsEvents: boolean;
  /** The step can be set to wait for a person's approval each time it runs ("Ask before doing this"). */
  approvable: boolean;
  /** Set when only the Automation Studio plan includes this kind of step. No kind needs the plan today. */
  premium?: PremiumFeature;
  /** What it acts on. "required": skipped when the run has none. */
  needs: (config: StepConfigMap[K]) => { contact: Need; opportunity: Need };
  effects: (config: StepConfigMap[K]) => WorkflowEffect[];
  /** A sensible starting config for the editor (may still need choices before it validates). */
  defaults: () => Partial<StepConfigMap[K]>;
}

const none = () => ({ contact: "none" as Need, opportunity: "none" as Need });
const onSubject = (c: { subject: "contact" | "opportunity" }) => (c.subject === "contact" ? { contact: "required" as Need, opportunity: "none" as Need } : { contact: "none" as Need, opportunity: "required" as Need });

function spec<K extends StepKind>(s: StepSpec<K>): StepSpec<K> {
  return s;
}

export const STEP_KINDS: { [K in StepKind]: StepSpec<K> } = {
  wait: spec({
    kind: "wait", label: "Wait", description: "Pause for a while, until a time of day, or until a date (such as a day before the appointment).", group: "Flow",
    schema: waitSchema, branches: false, terminal: false, external: false, emitsEvents: false, approvable: false,
    needs: (c) => (c.mode !== "until_date" ? none() : c.source === "contact_field" || c.source === "appointment_start" ? { contact: "optional", opportunity: "none" } : { contact: "none", opportunity: "optional" }),
    effects: () => [], defaults: () => ({ mode: "duration" as const, amount: 1, unit: "days" as const }),
  }),
  branch: spec({
    kind: "branch", label: "If / else", description: "Check the contact or deal against conditions (or whether they replied) and continue down the Yes or No path.", group: "Flow",
    schema: branchSchema, branches: true, terminal: false, external: false, emitsEvents: false, approvable: false, needs: onSubject, effects: () => [],
    defaults: () => ({ subject: "contact", filter: { op: "and", conditions: [] }, reply: null }),
  }),
  add_tag: spec({
    kind: "add_tag", label: "Add tag", description: "Add tags to the contact.", group: "Contact", schema: tagsSchema, branches: false, terminal: false, external: false, emitsEvents: true, approvable: true,
    needs: () => ({ contact: "required", opportunity: "none" }), effects: () => [], defaults: () => ({ tagIds: [] }),
  }),
  remove_tag: spec({
    kind: "remove_tag", label: "Remove tag", description: "Remove tags from the contact.", group: "Contact", schema: tagsSchema, branches: false, terminal: false, external: false, emitsEvents: true, approvable: true,
    needs: () => ({ contact: "required", opportunity: "none" }), effects: () => [], defaults: () => ({ tagIds: [] }),
  }),
  assign: spec({
    kind: "assign", label: "Assign owner", description: "Give the contact or deal an owner: a named person, or the next person in an assignment rule.", group: "Contact",
    schema: assignSchema, branches: false, terminal: false, external: false, emitsEvents: true, approvable: true, needs: onSubject, effects: () => [],
    defaults: () => ({ subject: "contact", to: "user", onlyIfUnassigned: true }),
  }),
  create_task: spec({
    kind: "create_task", label: "Create task", description: "Add a task for your team, linked to the contact (and deal).", group: "Tasks & notes",
    schema: createTaskSchema, branches: false, terminal: false, external: false, emitsEvents: true, approvable: true,
    needs: (c) => ({ contact: c.assignee === "contact_owner" ? "required" : "optional", opportunity: c.linkOpportunity ? "optional" : "none" }), effects: () => [],
    defaults: () => ({ title: "", priority: "normal", assignee: "contact_owner", dueIn: { amount: 1, unit: "days" } }),
  }),
  update_field: spec({
    kind: "update_field", label: "Update field", description: "Set a field on the contact or deal.", group: "Contact", schema: updateFieldSchema,
    branches: false, terminal: false, external: false, emitsEvents: true, approvable: true, needs: onSubject, effects: () => [], defaults: () => ({ subject: "contact", field: "lead_status", value: "contacted" }),
  }),
  create_opportunity: spec({
    kind: "create_opportunity", label: "Create deal", description: "Create a deal for the contact in a pipeline stage. Later steps work on this deal.", group: "Deals",
    schema: createOpportunitySchema, branches: false, terminal: false, external: false, emitsEvents: true, approvable: true,
    needs: (c) => ({ contact: c.ownerFromContact || c.skipIfOpenInPipeline ? "required" : "optional", opportunity: "none" }), effects: () => [],
    defaults: () => ({ name: "{{contact.full_name}}", ownerFromContact: true, skipIfOpenInPipeline: true }),
  }),
  move_stage: spec({
    kind: "move_stage", label: "Move deal to stage", description: "Move the run's deal (or the contact's open deal in that pipeline) to a stage.", group: "Deals",
    schema: moveStageSchema, branches: false, terminal: false, external: false, emitsEvents: true, approvable: true, needs: () => ({ contact: "optional", opportunity: "optional" }), effects: () => [],
    defaults: () => ({}),
  }),
  send_message: spec({
    kind: "send_message", label: "Send message", description: "Send an approved message template. Consent, opt-outs, quiet hours, limits and credits are checked when it sends.", group: "Messages",
    schema: sendMessageSchema, branches: false, terminal: false, external: false, emitsEvents: false, approvable: true, needs: () => ({ contact: "required", opportunity: "none" }),
    effects: (c) => [c.channel === "email" ? "send_email" : c.channel === "sms" ? "send_sms" : "send_whatsapp"], defaults: () => ({ sendAs: "sales_assistant", businessHoursOnly: true }),
  }),
  request_review: spec({
    kind: "request_review", label: "Request a review", description: "Ask the contact how it went with an approved review request template. They get a private feedback page with your public review links; it's sent only if they agreed to messages on that channel.", group: "Messages",
    schema: requestReviewSchema, branches: false, terminal: false, external: false, emitsEvents: true, approvable: true, needs: () => ({ contact: "required", opportunity: "none" }),
    // Until a template (and so its channel) is chosen the step can't validate, so it sends nothing yet.
    effects: (c) => (c.channel ? [c.channel === "email" ? "send_email" : c.channel === "sms" ? "send_sms" : "send_whatsapp"] : []), defaults: () => ({ businessHoursOnly: true }),
  }),
  notify_team: spec({
    kind: "notify_team", label: "Notify team", description: "Send an in-app notification to people in your workspace.", group: "Team", schema: notifySchema,
    branches: false, terminal: false, external: false, emitsEvents: false, approvable: true, needs: (c) => ({ contact: c.contactOwner ? "required" : "optional", opportunity: "none" }), effects: () => [],
    defaults: () => ({ roles: ["owner", "admin"], title: "" }),
  }),
  internal_note: spec({
    kind: "internal_note", label: "Add internal note", description: "Add a note to the contact or deal that only your team sees.", group: "Tasks & notes", schema: noteSchema,
    branches: false, terminal: false, external: false, emitsEvents: true, approvable: true, needs: onSubject, effects: () => [], defaults: () => ({ subject: "contact", body: "" }),
  }),
  n8n: spec({
    kind: "n8n", label: "Run n8n automation", description: "Start an n8n automation your agency verified for this workspace.", group: "Integrations", schema: n8nSchema,
    branches: false, terminal: false, external: true, emitsEvents: false, approvable: true, needs: (c) => ({ contact: c.includeContact ? "optional" : "none", opportunity: "none" }), effects: () => ["n8n"],
    defaults: () => ({ includeContact: true }),
  }),
  webhook: spec({
    kind: "webhook", label: "Send webhook", description: "Send a signed request to one of your outbound webhook endpoints.", group: "Integrations", schema: webhookSchema,
    branches: false, terminal: false, external: false, emitsEvents: false, approvable: true, needs: (c) => ({ contact: c.includeContact ? "optional" : "none", opportunity: "none" }), effects: () => ["webhook"],
    defaults: () => ({ includeContact: true }),
  }),
  ai_task: spec({
    kind: "ai_task", label: "Ask AI employee", description: "Ask one of your AI employees to do something for this contact. Its mode and pauses apply to everything it then does, so an employee that asks first asks before each change.", group: "AI",
    schema: aiTaskSchema, branches: false, terminal: false, external: false, emitsEvents: false, approvable: true, needs: () => ({ contact: "optional", opportunity: "none" }), effects: () => ["hermes"],
    defaults: () => ({ roleKey: "crm_manager", instruction: "" }),
  }),
  http_request: spec({
    kind: "http_request", label: "HTTP request",
    description: "Call a web address you have connected (a method, a path, optional query values and body) and carry on when it answers. The address, and the credentials it needs, belong to the connection, not the step. Calls only the connection's own host, never a private network.",
    group: "Integrations", schema: httpRequestSchema, branches: false, terminal: false, external: true, emitsEvents: false, approvable: true, premium: "http_request",
    needs: () => ({ contact: "optional", opportunity: "optional" }), effects: () => ["http"],
    defaults: () => ({ method: "POST" as const, path: "/", bodyType: "none" as const }),
  }),
  slack_message: spec({
    kind: "slack_message", label: "Post to Slack",
    description: "Post a message to the Slack channel of a Slack connection (an incoming webhook). The text may hold placeholders such as {{contact.full_name}}; mentions and links in values are made harmless.",
    group: "Integrations", schema: slackMessageSchema, branches: false, terminal: false, external: true, emitsEvents: false, approvable: true, premium: "slack_message",
    needs: () => ({ contact: "optional", opportunity: "optional" }), effects: () => ["slack"],
    defaults: () => ({ text: "" }),
  }),
  end: spec({
    kind: "end", label: "End", description: "Stop the workflow here.", group: "Flow", schema: endSchema as unknown as z.ZodType<Record<string, never>>, branches: false, terminal: true, external: false, emitsEvents: false, approvable: false,
    needs: none, effects: () => [], defaults: () => ({}),
  }),
};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface WorkflowStep<K extends StepKind = StepKind> {
  key: string;
  kind: K;
  name?: string;
  config: StepConfigMap[K];
  /** Each time the step is reached, a person approves it in the Approval Center before it acts (rejecting it cancels the run). */
  requireApproval?: boolean;
  /** The next step (null or absent: the run ends). Not used by branch steps. */
  next?: string | null;
  /** Branch steps: where Yes and No lead (null: the run ends). */
  branches?: { yes?: string | null; no?: string | null };
  /** Editor-only layout (ignored by the engine and the content hash). */
  ui?: { x?: number; y?: number; collapsed?: boolean };
}

export interface WorkflowDefinition {
  trigger: TriggerConfig;
  /** The first step runs first. */
  steps: WorkflowStep[];
}

const rawStepSchema = z.strictObject({
  key: z.string().regex(STEP_KEY_RE, "Step keys are lower-case letters, numbers, - and _ (up to 40)."),
  kind: z.string(),
  name: z.string().trim().max(80).optional(),
  config: z.record(z.string(), z.unknown()),
  requireApproval: z.boolean().optional(),
  next: z.string().nullable().optional(),
  branches: z.strictObject({ yes: z.string().nullable().optional(), no: z.string().nullable().optional() }).optional(),
  ui: z.strictObject({ x: z.number().optional(), y: z.number().optional(), collapsed: z.boolean().optional() }).optional(),
});

const rawDefinitionSchema = z.strictObject({ trigger: z.unknown(), steps: z.array(z.unknown()).max(WORKFLOW_LIMITS.maxSteps * 2) });

export type IssueLevel = "error" | "warning";

export interface ValidationIssue {
  level: IssueLevel;
  /** Stable machine code, e.g. "missing_tag", "cycle", "unreachable". */
  code: string;
  message: string;
  /** The step it is about, when it is about one. */
  stepKey?: string;
  /** Where in the step's config or the trigger (e.g. "config.tagIds", "trigger.filters.stageIds"). */
  path?: string;
  /** The schema's own words for a setting that is wrong, when the message above is the generic one. For the AI builder to correct itself; people see the message. */
  detail?: string;
}

/** Everything in the workspace a definition may refer to. The server loads it; the editor may build it from the builder options. */
export interface ValidationContext {
  tags: ReadonlySet<string>;
  /** Active members who can be given records. */
  users: ReadonlySet<string>;
  pipelines: ReadonlyMap<string, { stages: ReadonlyMap<string, { kind: "open" | "won" | "lost" }> }>;
  /** Custom fields by id. */
  fields: ReadonlyMap<string, { entity: "contact" | "company" | "opportunity"; type: FieldType; key: string }>;
  /** Approved native message templates by id: their approved wording's hash and channel. */
  templates: ReadonlyMap<string, { contentHash: string; channel: MessageChannel }>;
  /** Verified n8n mappings of this workspace. */
  n8nMappings: ReadonlySet<string>;
  /** Active outbound webhook subscriptions. */
  webhookSubscriptions: ReadonlySet<string>;
  /** The workspace's connections to outside systems that aren't revoked, by id. Absent: not checked. */
  connections?: ReadonlyMap<string, { kind: "http" | "slack_webhook"; status: string; methods: readonly string[] }>;
  /** Active assignment rules and what they assign. */
  assignmentRules: ReadonlyMap<string, { entity: "contact" | "opportunity" }>;
  /** AI employees (role keys) that are included in the workspace. */
  agents: ReadonlySet<string>;
  calendars: ReadonlySet<string>;
  appointmentTypes: ReadonlySet<string>;
  /** Native forms that aren't archived (the form.submitted trigger's filter). Absent: not checked. */
  forms?: ReadonlySet<string>;
  /** The workspace's configuration value keys ({{custom_values.<key>}} in a workflow's own texts). Absent: not checked. */
  customValues?: ReadonlySet<string>;
}

export interface ParsedDefinition {
  ok: boolean;
  definition: WorkflowDefinition | null;
  issues: ValidationIssue[];
}

const issue = (level: IssueLevel, code: string, message: string, extra: Pick<ValidationIssue, "stepKey" | "path"> = {}): ValidationIssue => ({ level, code, message, ...extra });

/** zod's own messages ("Invalid input: expected string…") are for developers; messages written in this file are for people. */
const GENERIC_ZOD = /^(Invalid|Too small|Too big|Unrecognized|Expected)/;

function zodIssues(err: z.ZodError, base: Pick<ValidationIssue, "stepKey">, prefix: string): ValidationIssue[] {
  return err.issues.slice(0, 5).map((i) => {
    const path = [prefix, ...i.path.map(String)].filter(Boolean).join(".");
    const message = i.message && !GENERIC_ZOD.test(i.message) ? i.message : `Some settings of this ${prefix === "trigger" ? "trigger" : "step"} are missing or not valid (${path || "settings"}).`;
    return { ...issue("error", "invalid_config", message, { ...base, path }), ...(i.message && GENERIC_ZOD.test(i.message) ? { detail: i.message.slice(0, 200) } : {}) };
  });
}

/** Structural parse: shapes, known kinds, configs. Reference and graph checks are in validateDefinition. */
export function parseDefinition(input: unknown): ParsedDefinition {
  const issues: ValidationIssue[] = [];
  const raw = rawDefinitionSchema.safeParse(input);
  if (!raw.success) return { ok: false, definition: null, issues: [issue("error", "invalid_definition", "This workflow can't be read. Start from a fresh draft.")] };
  const trigger = triggerConfigSchema.safeParse(raw.data.trigger);
  if (!trigger.success) issues.push(...zodIssues(trigger.error, {}, "trigger").map((i) => ({ ...i, code: "invalid_trigger", message: i.path === "trigger.type" ? "Choose what starts this workflow." : i.message })));
  const steps: WorkflowStep[] = [];
  raw.data.steps.forEach((s, index) => {
    const r = rawStepSchema.safeParse(s);
    if (!r.success) {
      issues.push(...zodIssues(r.error, {}, `steps.${index}`));
      return;
    }
    if (!isStepKind(r.data.kind)) {
      issues.push(issue("error", "unknown_step", "This kind of step doesn't exist.", { stepKey: r.data.key }));
      return;
    }
    const kind = r.data.kind;
    const cfg = (STEP_KINDS[kind].schema as z.ZodType).safeParse(r.data.config);
    if (!cfg.success) {
      issues.push(...zodIssues(cfg.error, { stepKey: r.data.key }, "config"));
      return;
    }
    if (r.data.requireApproval && !STEP_KINDS[kind].approvable) {
      issues.push(issue("error", "invalid_config", "Only steps that act can ask for approval first.", { stepKey: r.data.key, path: "requireApproval" }));
      return;
    }
    steps.push({ key: r.data.key, kind, name: r.data.name, config: cfg.data as StepConfigMap[typeof kind], requireApproval: r.data.requireApproval || undefined, next: r.data.next ?? null, branches: r.data.branches, ui: r.data.ui } as WorkflowStep);
  });
  if (!trigger.success) return { ok: false, definition: null, issues };
  return { ok: issues.length === 0, definition: { trigger: trigger.data as TriggerConfig, steps }, issues };
}

/** The keys a step can continue to (in the order Yes, No for a branch). */
export function stepSuccessors(step: Pick<WorkflowStep, "kind" | "next" | "branches">): string[] {
  if (step.kind === "end") return [];
  if (step.kind === "branch") return [step.branches?.yes, step.branches?.no].filter((k): k is string => Boolean(k));
  return step.next ? [step.next] : [];
}

function graphIssues(steps: WorkflowStep[]): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!steps.length) return [issue("error", "no_steps", "Add at least one step.")];
  if (steps.length > WORKFLOW_LIMITS.maxSteps) out.push(issue("error", "too_many_steps", `A workflow can have at most ${WORKFLOW_LIMITS.maxSteps} steps. Split it into two workflows.`));
  const byKey = new Map<string, WorkflowStep>();
  for (const s of steps) {
    if (byKey.has(s.key)) out.push(issue("error", "duplicate_key", "Two steps share this key.", { stepKey: s.key }));
    byKey.set(s.key, s);
  }
  for (const s of steps) {
    if (s.kind === "branch" && s.next) out.push(issue("error", "invalid_link", "An if / else step continues through its Yes and No paths only.", { stepKey: s.key, path: "next" }));
    if (s.kind !== "branch" && s.branches && (s.branches.yes || s.branches.no)) out.push(issue("error", "invalid_link", "Only if / else steps have Yes and No paths.", { stepKey: s.key, path: "branches" }));
    if (s.kind === "end" && s.next) out.push(issue("error", "invalid_link", "Nothing can follow an End step.", { stepKey: s.key, path: "next" }));
    for (const k of stepSuccessors(s)) if (!byKey.has(k)) out.push(issue("error", "missing_step", "This step leads to a step that no longer exists.", { stepKey: s.key }));
  }
  // Reachability from the first step: one entry, nothing stranded.
  const seen = new Set<string>();
  const stack = [steps[0].key];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    const s = byKey.get(k);
    if (s) for (const n of stepSuccessors(s)) stack.push(n);
  }
  for (const s of steps) if (!seen.has(s.key)) out.push(issue("error", "unreachable", "This step isn't connected to the workflow, so it would never run.", { stepKey: s.key }));

  // Cycles are only allowed through a wait step: without one, a loop would run instantly forever.
  const color = new Map<string, 0 | 1 | 2>();
  const cyclic = new Set<string>();
  const visit = (k: string, path: string[]) => {
    color.set(k, 1);
    const s = byKey.get(k);
    if (s && s.kind !== "wait") {
      for (const n of stepSuccessors(s)) {
        if (!byKey.has(n)) continue;
        const c = color.get(n) ?? 0;
        if (c === 1) {
          const loop = path.slice(path.indexOf(n));
          for (const x of loop) cyclic.add(x);
        } else if (c === 0) visit(n, [...path, n]);
      }
    }
    color.set(k, 2);
  };
  for (const s of steps) if ((color.get(s.key) ?? 0) === 0) visit(s.key, [s.key]);
  for (const k of cyclic) out.push(issue("error", "cycle", "This step is part of a loop with no wait in it. Add a wait to the loop or remove it.", { stepKey: k }));

  // Depth: the longest chain from the first step, cutting edges that close a loop (those always pass a wait).
  const memo = new Map<string, number>();
  const onPath = new Set<string>();
  const depth = (k: string): number => {
    if (memo.has(k)) return memo.get(k)!;
    if (onPath.has(k)) return 0;
    onPath.add(k);
    const s = byKey.get(k);
    let best = 0;
    if (s) for (const n of stepSuccessors(s)) if (byKey.has(n)) best = Math.max(best, depth(n));
    onPath.delete(k);
    memo.set(k, best + 1);
    return best + 1;
  };
  if (!cyclic.size && depth(steps[0].key) > WORKFLOW_LIMITS.maxDepth) out.push(issue("error", "too_deep", `The longest path has more than ${WORKFLOW_LIMITS.maxDepth} steps. Split the workflow.`));
  return out;
}

const CONTACT_FIELDS = new Map(CONTACT_FILTER_FIELDS.map((f) => [f.key, f]));
const OPP_FIELDS = new Map(OPPORTUNITY_CONDITION_FIELDS.map((f) => [f.key, f]));

function conditionIssues(group: FilterGroup, subject: "contact" | "opportunity", ctx: ValidationContext | null, base: Pick<ValidationIssue, "stepKey" | "path">): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const shape = checkFilterShape(group);
  if (shape) out.push(issue("error", "invalid_conditions", shape, base));
  const walk = (g: FilterGroup) => {
    for (const c of g.conditions) {
      if (isGroup(c)) walk(c);
      else out.push(...conditionIssue(c, subject, ctx, base));
    }
  };
  walk(group);
  return out;
}

function conditionIssue(c: FilterCondition, subject: "contact" | "opportunity", ctx: ValidationContext | null, base: Pick<ValidationIssue, "stepKey" | "path">): ValidationIssue[] {
  if (c.field.startsWith("cf:")) {
    if (subject === "opportunity") return [issue("error", "invalid_conditions", "Deal conditions can't use custom fields yet.", base)];
    const field = ctx?.fields.get(c.field.slice(3));
    if (ctx && (!field || field.entity !== "contact")) return [issue("error", "missing_field", "A condition uses a custom field that no longer exists.", base)];
    if (field && !customFieldOps(field.type).includes(c.op)) return [issue("error", "invalid_conditions", "A condition uses a comparison that doesn't fit its field.", base)];
    return [];
  }
  const def = subject === "contact" ? CONTACT_FIELDS.get(c.field) : OPP_FIELDS.get(c.field);
  if (!def) return [issue("error", "invalid_conditions", "A condition uses a field that doesn't exist.", base)];
  if (!OPS_BY_KIND[def.kind].includes(c.op)) return [issue("error", "invalid_conditions", `"${def.label}" can't be compared that way.`, base)];
  // A workflow has no "me": it acts for the workspace, not for whoever is looking.
  if (c.op === "is_me") return [issue("error", "invalid_conditions", `"${def.label} is me" doesn't apply in a workflow. Choose the people instead.`, base)];
  if (ctx && def.kind === "tags" && Array.isArray(c.value)) {
    for (const v of c.value) if (typeof v === "string" && !ctx.tags.has(v)) return [issue("error", "missing_tag", "A condition uses a tag that no longer exists.", base)];
  }
  if (ctx && def.kind === "owner" && c.op === "is_any_of" && Array.isArray(c.value)) {
    for (const v of c.value) if (typeof v === "string" && !ctx.users.has(v)) return [issue("error", "missing_user", "A condition names someone who is no longer in the workspace.", base)];
  }
  return [];
}

/**
 * Placeholders in a workflow's own texts (task titles and descriptions, notes, notifications, deal names): the built-in tokens and the
 * workspace's configuration values ({{custom_values.<key>}}). The engine fills them when the step runs and leaves out anything without a
 * value, so a raw placeholder never shows. Without the workspace's values (`customValues` absent) any well-formed value key is accepted.
 */
function tokenIssues(text: string | undefined, base: Pick<ValidationIssue, "stepKey" | "path">, customValues?: ReadonlySet<string>): ValidationIssue[] {
  if (!text) return [];
  for (const t of extractTokens(text)) {
    if (isTokenKey(t.key)) continue;
    const cv = customValueKeyOf(t.key);
    if (cv !== null && (!customValues || customValues.has(cv))) continue;
    if (cv !== null) return [issue("error", "unknown_token", `${t.raw} isn't one of this workspace's configuration values. Add it in CRM Settings → Configuration Values, or use the placeholder picker.`, base)];
    return [issue("error", "unknown_token", `${t.raw} isn't a placeholder iAcquire knows. Use the placeholder picker.`, base)];
  }
  return [];
}

/** A step's connection: it exists, is the right kind, and has been verified. */
function connectionIssues(id: string, kind: "http" | "slack_webhook", ctx: ValidationContext | null, base: Pick<ValidationIssue, "stepKey">): ValidationIssue[] {
  const where = { ...base, path: "config.connectionId" };
  if (!ctx?.connections) return [];
  const c = ctx.connections.get(id);
  if (!c) return [issue("error", "missing_connection", "That connection isn't available (it may have been revoked). Choose another or add one.", where)];
  if (c.kind !== kind) return [issue("error", "invalid_config", kind === "slack_webhook" ? "Choose a Slack connection." : "Choose an HTTP connection.", where)];
  if (c.status === "unverified") return [issue("error", "unverified_connection", "That connection hasn't been verified yet. Open Connections and send its test first.", where)];
  if (c.status === "needs_attention") return [issue("error", "connection_needs_attention", "That connection needs attention (its last calls failed). Check it in Connections.", where)];
  return [];
}

/** A JSON body template: valid JSON, with every {{placeholder}} inside a string and known. */
function jsonTemplateIssues(text: string, base: Pick<ValidationIssue, "stepKey">, customValues?: ReadonlySet<string>): ValidationIssue[] {
  const where = { ...base, path: "config.body" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [issue("error", "invalid_config", `The body isn't valid JSON. Put placeholders inside quotes, like {"name": "{{contact.full_name}}"}.`, where)];
  }
  const out: ValidationIssue[] = [];
  const walk = (v: unknown, depth: number) => {
    if (out.length || depth > 10) return;
    if (typeof v === "string") out.push(...tokenIssues(v, where, customValues));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(parsed, 0);
  return out;
}

function httpRequestIssues(c: HttpRequestConfig, ctx: ValidationContext | null, base: Pick<ValidationIssue, "stepKey">): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  out.push(...connectionIssues(c.connectionId, "http", ctx, base));
  const conn = ctx?.connections?.get(c.connectionId);
  if (conn && conn.kind === "http" && conn.methods.length && !conn.methods.includes(c.method)) {
    out.push(issue("error", "invalid_config", `That connection doesn't allow ${c.method} requests (it allows ${conn.methods.join(", ")}). Change the method, or allow it on the connection.`, { ...base, path: "config.method" }));
  }
  // The path may hold placeholders (each value is encoded when it is filled in); it is checked with a stand-in for each.
  const probe = c.path.replace(/\{\{[^}]*\}\}/g, "x");
  const problem = pathProblem(probe);
  if (problem) out.push(issue("error", "invalid_config", problem, { ...base, path: "config.path" }));
  out.push(...tokenIssues(c.path, { ...base, path: "config.path" }, ctx?.customValues));
  for (const q of c.query ?? []) {
    if (!/^[A-Za-z0-9_.[\]-]{1,60}$/.test(q.name)) out.push(issue("error", "invalid_config", `The query name “${q.name.slice(0, 30)}” isn't allowed (letters, digits and _ . - only).`, { ...base, path: "config.query" }));
    out.push(...tokenIssues(q.value, { ...base, path: "config.query" }, ctx?.customValues));
  }
  try {
    if ((c.headers ?? []).some((h) => h.value.includes("{{"))) throw new Error("Header values can't hold placeholders.");
    cleanStepHeaders(Object.fromEntries((c.headers ?? []).map((h) => [h.name, h.value])));
  } catch (err) {
    out.push(issue("error", "invalid_config", err instanceof Error ? err.message : "A header isn't allowed.", { ...base, path: "config.headers" }));
  }
  if (c.bodyType === "none" && (c.body || c.form?.length)) out.push(issue("error", "invalid_config", "Remove the body, or choose a body type.", { ...base, path: "config.bodyType" }));
  if (c.method === "GET" && c.bodyType !== "none") out.push(issue("error", "invalid_config", "A GET request doesn't carry a body.", { ...base, path: "config.bodyType" }));
  if (c.bodyType === "json") {
    if (!c.body?.trim()) out.push(issue("error", "invalid_config", "Write the JSON body.", { ...base, path: "config.body" }));
    else out.push(...jsonTemplateIssues(c.body, base, ctx?.customValues));
  }
  if (c.bodyType === "text") {
    if (!c.body?.trim()) out.push(issue("error", "invalid_config", "Write the body text.", { ...base, path: "config.body" }));
    else out.push(...tokenIssues(c.body, { ...base, path: "config.body" }, ctx?.customValues));
  }
  if (c.bodyType === "form") {
    if (!c.form?.length) out.push(issue("error", "invalid_config", "Add at least one form field.", { ...base, path: "config.form" }));
    for (const f of c.form ?? []) out.push(...tokenIssues(f.value, { ...base, path: "config.form" }, ctx?.customValues));
  }
  return out;
}

function triggerIssues(t: TriggerConfig, ctx: ValidationContext | null): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const ts = TRIGGERS[t.type];
  const filters = t.filters ?? {};
  for (const key of Object.keys(filters) as TriggerFilterKey[]) {
    if (filters[key] === undefined) continue;
    if (!ts.filters.includes(key)) out.push(issue("error", "invalid_trigger", `"${ts.label}" can't be filtered that way.`, { path: `trigger.filters.${key}` }));
  }
  if (t.type === "schedule") {
    if (!t.schedule) out.push(issue("error", "invalid_trigger", "Choose when the schedule runs.", { path: "trigger.schedule" }));
    else if (t.schedule.frequency === "weekly" && !t.schedule.weekdays?.length) out.push(issue("error", "invalid_trigger", "Choose at least one weekday.", { path: "trigger.schedule.weekdays" }));
  } else if (t.schedule) out.push(issue("error", "invalid_trigger", "Only scheduled workflows have a schedule.", { path: "trigger.schedule" }));
  if (t.type === "inbound_webhook") {
    if (!t.inbound) out.push(issue("error", "invalid_trigger", "Generate the webhook URL for this workflow.", { path: "trigger.inbound" }));
    else if (t.inbound.createContact && t.inbound.match === "none") out.push(issue("error", "invalid_trigger", "A contact can only be created when the body is matched by email or phone.", { path: "trigger.inbound.createContact" }));
  } else if (t.inbound) out.push(issue("error", "invalid_trigger", "Only inbound-webhook workflows have a webhook URL.", { path: "trigger.inbound" }));
  if (t.contactFilter) {
    if (ts.carries.contact === "never") out.push(issue("error", "invalid_trigger", "This trigger has no contact to filter on.", { path: "trigger.contactFilter" }));
    else out.push(...conditionIssues(t.contactFilter, "contact", ctx, { path: "trigger.contactFilter" }));
  }
  if (t.reentry && ts.carries.contact === "never") out.push(issue("error", "invalid_trigger", "Re-entry rules apply to contacts, and this trigger has none.", { path: "trigger.reentry" }));
  if (ctx) {
    for (const id of filters.tagIds ?? []) if (!ctx.tags.has(id)) out.push(issue("error", "missing_tag", "The trigger uses a tag that no longer exists.", { path: "trigger.filters.tagIds" }));
    for (const id of filters.assigneeIds ?? []) if (!ctx.users.has(id)) out.push(issue("error", "missing_user", "The trigger names someone who is no longer in the workspace.", { path: "trigger.filters.assigneeIds" }));
    for (const id of filters.calendarIds ?? []) if (!ctx.calendars.has(id)) out.push(issue("error", "missing_calendar", "The trigger uses a calendar that no longer exists.", { path: "trigger.filters.calendarIds" }));
    for (const id of filters.appointmentTypeIds ?? []) if (!ctx.appointmentTypes.has(id)) out.push(issue("error", "missing_calendar", "The trigger uses an appointment type that no longer exists.", { path: "trigger.filters.appointmentTypeIds" }));
    if (ctx.forms) for (const id of filters.formIds ?? []) if (!ctx.forms.has(id)) out.push(issue("error", "missing_form", "The trigger uses a form that no longer exists or was archived.", { path: "trigger.filters.formIds" }));
    if (filters.pipelineId && !ctx.pipelines.has(filters.pipelineId)) out.push(issue("error", "missing_pipeline", "The trigger uses a pipeline that no longer exists.", { path: "trigger.filters.pipelineId" }));
    const stagesOk = (ids: string[] | undefined, path: string) => {
      if (!ids?.length) return;
      const pipe = filters.pipelineId ? ctx.pipelines.get(filters.pipelineId) : null;
      for (const id of ids) {
        const found = pipe ? pipe.stages.has(id) : [...ctx.pipelines.values()].some((p) => p.stages.has(id));
        if (!found) out.push(issue("error", "missing_stage", "The trigger uses a stage that no longer exists in that pipeline.", { path }));
      }
    };
    stagesOk(filters.stageIds, "trigger.filters.stageIds");
    stagesOk(filters.fromStageIds, "trigger.filters.fromStageIds");
  }
  return out;
}

function stepIssues(step: WorkflowStep, def: WorkflowDefinition, ctx: ValidationContext | null): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const base = { stepKey: step.key };
  const trig = TRIGGERS[def.trigger.type];
  const kindSpec = STEP_KINDS[step.kind] as StepSpec;
  const needs = kindSpec.needs(step.config as never);
  const createsDeal = def.steps.some((s) => s.kind === "create_opportunity");
  if (needs.contact === "required") {
    if (trig.carries.contact === "never") out.push(issue("error", "needs_contact", `"${kindSpec.label}" needs a contact, and "${trig.label}" doesn't have one.`, base));
    else if (trig.carries.contact === "maybe") out.push(issue("warning", "needs_contact", `"${kindSpec.label}" is skipped for runs without a contact.`, base));
  }
  if (needs.opportunity === "required" && trig.carries.opportunity === "never" && !createsDeal) {
    out.push(issue("error", "needs_deal", `"${kindSpec.label}" works on a deal, and nothing in this workflow provides one. Use a deal trigger or add a "Create deal" step first.`, base));
  }

  switch (step.kind) {
    case "wait": {
      const w = step.config as WaitConfig;
      if (w.mode === "duration" && durationMinutes(w) > WORKFLOW_LIMITS.maxWaitDays * 1440) out.push(issue("error", "invalid_config", `A wait can be at most ${WORKFLOW_LIMITS.maxWaitDays} days.`, { ...base, path: "config.amount" }));
      if (w.mode === "until_date") {
        if (durationMinutes(w.offset) > WORKFLOW_LIMITS.maxWaitDays * 1440) out.push(issue("error", "invalid_config", `The offset can be at most ${WORKFLOW_LIMITS.maxWaitDays} days.`, { ...base, path: "config.offset" }));
        if (w.source === "appointment_start" && trig.entity !== "appointment") out.push(issue("error", "invalid_config", "Waiting for the appointment needs an appointment trigger.", { ...base, path: "config.source" }));
        if (w.source === "contact_field" || w.source === "opportunity_field") {
          if (!w.fieldId) out.push(issue("error", "invalid_config", "Choose the date field to wait for.", { ...base, path: "config.fieldId" }));
          else if (ctx) {
            const f = ctx.fields.get(w.fieldId);
            const entity = w.source === "contact_field" ? "contact" : "opportunity";
            if (!f || f.entity !== entity) out.push(issue("error", "missing_field", "The date field no longer exists.", { ...base, path: "config.fieldId" }));
            else if (f.type !== "date" && f.type !== "datetime") out.push(issue("error", "invalid_config", "Choose a date or date-and-time field.", { ...base, path: "config.fieldId" }));
          }
        }
        if ((w.source === "opportunity_field" || w.source === "opportunity_close_date") && trig.carries.opportunity === "never" && !createsDeal) {
          out.push(issue("error", "needs_deal", "Waiting for a deal's date needs a deal trigger or a \"Create deal\" step first.", base));
        }
      }
      break;
    }
    case "branch": {
      const b = step.config as BranchConfig;
      if (!b.filter.conditions.length && !b.reply) out.push(issue("error", "invalid_config", "Add at least one condition.", { ...base, path: "config.filter" }));
      if (b.reply && b.subject !== "contact") out.push(issue("error", "invalid_config", "Reply checks are about the contact.", { ...base, path: "config.reply" }));
      out.push(...conditionIssues(b.filter, b.subject, ctx, { ...base, path: "config.filter" }));
      if (!step.branches?.yes && !step.branches?.no) out.push(issue("warning", "empty_branch", "Both paths end the workflow, so this check changes nothing.", base));
      break;
    }
    case "add_tag":
    case "remove_tag":
      if (ctx) for (const id of (step.config as TagsConfig).tagIds) if (!ctx.tags.has(id)) out.push(issue("error", "missing_tag", "This step uses a tag that no longer exists.", { ...base, path: "config.tagIds" }));
      if (step.kind === "add_tag" && def.trigger.type === "contact.tag_added" && (!def.trigger.filters?.tagIds || (step.config as TagsConfig).tagIds.some((t) => def.trigger.filters?.tagIds?.includes(t)))) {
        out.push(issue("warning", "self_trigger", "Adding a tag that starts this same workflow can make it run again for the same contact. The loop limit stops it, but check this is what you want.", base));
      }
      break;
    case "assign": {
      const a = step.config as AssignConfig;
      if (a.to === "user") {
        if (!a.userId) out.push(issue("error", "invalid_config", "Choose who gets it.", { ...base, path: "config.userId" }));
        else if (ctx && !ctx.users.has(a.userId)) out.push(issue("error", "missing_user", "That person is no longer in the workspace or can't see contacts.", { ...base, path: "config.userId" }));
      } else if (!a.ruleId) out.push(issue("error", "invalid_config", "Choose an assignment rule.", { ...base, path: "config.ruleId" }));
      else if (ctx) {
        const rule = ctx.assignmentRules.get(a.ruleId);
        if (!rule) out.push(issue("error", "missing_rule", "That assignment rule is no longer active.", { ...base, path: "config.ruleId" }));
        else if (rule.entity !== a.subject) out.push(issue("error", "invalid_config", `That rule assigns ${rule.entity === "contact" ? "contacts" : "deals"}.`, { ...base, path: "config.ruleId" }));
      }
      break;
    }
    case "create_task": {
      const t = step.config as CreateTaskConfig;
      if (t.assignee === "user" && !t.userId) out.push(issue("error", "invalid_config", "Choose who the task is for.", { ...base, path: "config.userId" }));
      if (t.assignee === "user" && t.userId && ctx && !ctx.users.has(t.userId)) out.push(issue("error", "missing_user", "That person is no longer in the workspace.", { ...base, path: "config.userId" }));
      if (t.dueIn && durationMinutes(t.dueIn) > WORKFLOW_LIMITS.maxWaitDays * 1440) out.push(issue("error", "invalid_config", `A due date can be at most ${WORKFLOW_LIMITS.maxWaitDays} days ahead.`, { ...base, path: "config.dueIn" }));
      out.push(...tokenIssues(t.title, { ...base, path: "config.title" }, ctx?.customValues), ...tokenIssues(t.description, { ...base, path: "config.description" }, ctx?.customValues));
      break;
    }
    case "update_field": {
      const u = step.config as UpdateFieldConfig;
      out.push(...updateFieldIssues(u, ctx, base));
      break;
    }
    case "create_opportunity": {
      const o = step.config as CreateOpportunityConfig;
      out.push(...stageIssues(o.pipelineId, o.stageId, ctx, base, true));
      out.push(...tokenIssues(o.name, { ...base, path: "config.name" }, ctx?.customValues));
      break;
    }
    case "move_stage": {
      const m = step.config as MoveStageConfig;
      out.push(...stageIssues(m.pipelineId, m.stageId, ctx, base, false));
      const kind = ctx?.pipelines.get(m.pipelineId)?.stages.get(m.stageId)?.kind;
      if (kind === "lost" && (!m.lostReason || m.lostReason.length < 3)) out.push(issue("error", "invalid_config", "Say why deals moved to a Lost stage are lost.", { ...base, path: "config.lostReason" }));
      break;
    }
    case "send_message": {
      const s = step.config as SendMessageConfig;
      if (ctx) {
        const t = ctx.templates.get(s.templateId);
        if (!t) out.push(issue("error", "missing_template", "That template isn't approved for automated messages (or no longer exists).", { ...base, path: "config.templateId" }));
        else if (t.contentHash !== s.contentHash) out.push(issue("error", "template_changed", "The template's approved wording changed. Choose it again to use the new wording.", { ...base, path: "config.templateId" }));
        else if (t.channel !== s.channel) out.push(issue("error", "template_changed", "The template's channel changed. Choose it again.", { ...base, path: "config.channel" }));
        if (!ctx.agents.has(s.sendAs)) out.push(issue("error", "missing_agent", "That AI employee isn't included in this workspace.", { ...base, path: "config.sendAs" }));
      }
      break;
    }
    case "request_review": {
      const s = step.config as RequestReviewConfig;
      if (ctx) {
        const t = ctx.templates.get(s.templateId);
        if (!t) out.push(issue("error", "missing_template", "That template isn't approved for automated messages (or no longer exists).", { ...base, path: "config.templateId" }));
        else if (t.contentHash !== s.contentHash) out.push(issue("error", "template_changed", "The template's approved wording changed. Choose it again to use the new wording.", { ...base, path: "config.templateId" }));
        else if (t.channel !== s.channel) out.push(issue("error", "template_changed", "The template's channel changed. Choose it again.", { ...base, path: "config.channel" }));
      }
      break;
    }
    case "notify_team": {
      const n = step.config as NotifyTeamConfig;
      if (!n.roles?.length && !n.userIds?.length && !n.contactOwner) out.push(issue("error", "invalid_config", "Choose who gets the notification.", { ...base, path: "config.roles" }));
      if (ctx) for (const id of n.userIds ?? []) if (!ctx.users.has(id)) out.push(issue("error", "missing_user", "Someone chosen is no longer in the workspace.", { ...base, path: "config.userIds" }));
      out.push(...tokenIssues(n.title, { ...base, path: "config.title" }, ctx?.customValues), ...tokenIssues(n.body, { ...base, path: "config.body" }, ctx?.customValues));
      break;
    }
    case "internal_note":
      out.push(...tokenIssues((step.config as InternalNoteConfig).body, { ...base, path: "config.body" }, ctx?.customValues));
      break;
    case "n8n":
      if (ctx && !ctx.n8nMappings.has((step.config as N8nConfig).mappingId)) out.push(issue("error", "missing_n8n", "That n8n automation isn't verified for this workspace.", { ...base, path: "config.mappingId" }));
      break;
    case "webhook":
      if (ctx && !ctx.webhookSubscriptions.has((step.config as WebhookConfig).subscriptionId)) out.push(issue("error", "missing_webhook", "That webhook endpoint is not active.", { ...base, path: "config.subscriptionId" }));
      break;
    case "http_request":
      out.push(...httpRequestIssues(step.config as HttpRequestConfig, ctx, base));
      break;
    case "slack_message": {
      const m = step.config as SlackMessageConfig;
      out.push(...connectionIssues(m.connectionId, "slack_webhook", ctx, base));
      out.push(...tokenIssues(m.text, { ...base, path: "config.text" }, ctx?.customValues));
      break;
    }
    case "ai_task":
      if (ctx && !ctx.agents.has((step.config as AiTaskConfig).roleKey)) out.push(issue("error", "missing_agent", "That AI employee isn't included in this workspace.", { ...base, path: "config.roleKey" }));
      break;
    case "end":
      break;
  }
  return out;
}

function stageIssues(pipelineId: string, stageId: string, ctx: ValidationContext | null, base: { stepKey: string }, mustBeOpen: boolean): ValidationIssue[] {
  if (!ctx) return [];
  const pipe = ctx.pipelines.get(pipelineId);
  if (!pipe) return [issue("error", "missing_pipeline", "That pipeline no longer exists.", { ...base, path: "config.pipelineId" })];
  const stage = pipe.stages.get(stageId);
  if (!stage) return [issue("error", "missing_stage", "That stage isn't in the pipeline any more.", { ...base, path: "config.stageId" })];
  if (mustBeOpen && stage.kind !== "open") return [issue("error", "invalid_config", "New deals start in an open stage.", { ...base, path: "config.stageId" })];
  return [];
}

function updateFieldIssues(u: UpdateFieldConfig, ctx: ValidationContext | null, base: { stepKey: string }): ValidationIssue[] {
  const path = { ...base, path: "config.value" };
  if (u.field.startsWith("cf:")) {
    if (!ctx) return [];
    const f = ctx.fields.get(u.field.slice(3));
    if (!f || f.entity !== u.subject) return [issue("error", "missing_field", "That custom field no longer exists.", { ...base, path: "config.field" })];
    return [];
  }
  const builtIn = (UPDATABLE_FIELDS[u.subject] as Record<string, { label: string; type: "enum" | "number" | "text"; options?: readonly string[]; min?: number; max?: number; required?: boolean }>)[u.field];
  if (!builtIn) return [issue("error", "invalid_config", "That field can't be set by a workflow.", { ...base, path: "config.field" })];
  if (builtIn.type === "enum" && (typeof u.value !== "string" || !builtIn.options?.includes(u.value))) return [issue("error", "invalid_config", `Choose a value for ${builtIn.label.toLowerCase()}.`, path)];
  if (builtIn.type === "number") {
    if (u.value === null) return [];
    if (typeof u.value !== "number" || !Number.isFinite(u.value) || u.value < (builtIn.min ?? -Infinity) || u.value > (builtIn.max ?? Infinity)) return [issue("error", "invalid_config", `${builtIn.label} must be a number from ${builtIn.min} to ${builtIn.max}.`, path)];
    if (u.field !== "value" && !Number.isInteger(u.value)) return [issue("error", "invalid_config", `${builtIn.label} is a whole number.`, path)];
  }
  if (builtIn.type === "text" && builtIn.required && (typeof u.value !== "string" || !u.value.trim())) return [issue("error", "invalid_config", `${builtIn.label} can't be empty.`, path)];
  if (builtIn.type === "text" && u.value !== null && (typeof u.value !== "string" || u.value.trim().length > (builtIn.max ?? 200))) return [issue("error", "invalid_config", `${builtIn.label} is text of up to ${builtIn.max} characters.`, path)];
  return [];
}

/**
 * Every problem with a definition: structure, configs, references to things in the workspace (when `ctx` is given), and the graph (one
 * entry, nothing unreachable, no loop without a wait, size and depth limits). A definition with any "error" can't be published.
 */
export function validateDefinition(input: unknown, ctx: ValidationContext | null): ValidationIssue[] {
  const parsed = parseDefinition(input);
  if (!parsed.definition) return parsed.issues;
  const def = parsed.definition;
  const out = [...parsed.issues, ...triggerIssues(def.trigger, ctx)];
  // Graph checks only make sense on the steps that parsed; a step that failed to parse is reported above.
  if (parsed.issues.every((i) => !i.stepKey)) out.push(...graphIssues(def.steps));
  for (const s of def.steps) out.push(...stepIssues(s, def, ctx));
  return out;
}

export const hasErrors = (issues: readonly ValidationIssue[]) => issues.some((i) => i.level === "error");

/** What the definition can do outside the CRM, in a fixed order. Empty means no owner approval is needed. */
export function deriveEffects(def: WorkflowDefinition): WorkflowEffect[] {
  const found = new Set<WorkflowEffect>();
  for (const s of def.steps) for (const e of (STEP_KINDS[s.kind] as StepSpec).effects(s.config as never)) found.add(e);
  return WORKFLOW_EFFECTS.filter((e) => found.has(e));
}

/** A version that messages customers or calls outside systems runs only once an owner approved its exact content. */
export const needsOwnerApproval = (effects: readonly string[]) => effects.length > 0;

/**
 * The premium capabilities a definition uses, in a fixed order: "studio_workflow" when it was built in Automation Studio, plus the feature
 * of every step kind that only the plan includes. Empty means the workflow needs no plan. `specs` is a parameter so a test can add a kind.
 */
export function derivePremiumFeatures(
  def: Pick<WorkflowDefinition, "steps">,
  origin: WorkflowOrigin = "crm",
  specs: Readonly<Record<string, { premium?: PremiumFeature } | undefined>> = STEP_KINDS,
): PremiumFeature[] {
  const found = new Set<PremiumFeature>();
  if (origin === "studio") found.add("studio_workflow");
  for (const s of Array.isArray(def.steps) ? def.steps : []) {
    const feature = specs[s.kind]?.premium;
    if (feature) found.add(feature);
  }
  return PREMIUM_FEATURES.filter((f) => found.has(f));
}

/** JSON with object keys sorted and undefined dropped, so equal content always serializes identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The content an approval is bound to: the trigger and every step (names, configs, links), without editor layout. */
export function definitionHash(def: WorkflowDefinition): string {
  const content = { trigger: def.trigger, steps: def.steps.map((s) => ({ key: s.key, kind: s.kind, name: s.name ?? null, config: s.config, requireApproval: s.requireApproval === true, next: s.kind === "branch" ? null : (s.next ?? null), branches: s.kind === "branch" ? { yes: s.branches?.yes ?? null, no: s.branches?.no ?? null } : null })) };
  return sha256Hex(canonicalJson(content));
}

/** A blank draft for a trigger. */
export function emptyDefinition(type: TriggerType = "contact.created"): WorkflowDefinition {
  return { trigger: { type }, steps: [] };
}

/** Builds a ValidationContext from plain lists (the shape the server's builder options return), for validating in the editor. */
export function validationContextFrom(o: {
  tags: Array<{ id: string }>;
  users: Array<{ id: string }>;
  pipelines: Array<{ id: string; stages: Array<{ id: string; kind: "open" | "won" | "lost" }> }>;
  fields: Array<{ id: string; entity: "contact" | "company" | "opportunity"; type: FieldType; key: string }>;
  templates: Array<{ id: string; contentHash: string; channel: MessageChannel }>;
  n8nMappings: Array<{ id: string }>;
  webhookSubscriptions: Array<{ id: string }>;
  connections?: Array<{ id: string; kind: "http" | "slack_webhook"; status: string; methods?: string[] }>;
  assignmentRules: Array<{ id: string; entity: "contact" | "opportunity" }>;
  agents: Array<{ roleKey: string }>;
  calendars: Array<{ id: string }>;
  appointmentTypes: Array<{ id: string }>;
  forms?: Array<{ id: string }>;
  customValues?: Array<{ key: string }>;
}): ValidationContext {
  return {
    tags: new Set(o.tags.map((t) => t.id)),
    users: new Set(o.users.map((u) => u.id)),
    pipelines: new Map(o.pipelines.map((p) => [p.id, { stages: new Map(p.stages.map((s) => [s.id, { kind: s.kind }])) }])),
    fields: new Map(o.fields.map((f) => [f.id, { entity: f.entity, type: f.type, key: f.key }])),
    templates: new Map(o.templates.map((t) => [t.id, { contentHash: t.contentHash, channel: t.channel }])),
    n8nMappings: new Set(o.n8nMappings.map((m) => m.id)),
    webhookSubscriptions: new Set(o.webhookSubscriptions.map((w) => w.id)),
    connections: new Map((o.connections ?? []).map((c) => [c.id, { kind: c.kind, status: c.status, methods: c.methods ?? [] }])),
    assignmentRules: new Map(o.assignmentRules.map((r) => [r.id, { entity: r.entity }])),
    agents: new Set(o.agents.map((a) => a.roleKey)),
    calendars: new Set(o.calendars.map((c) => c.id)),
    appointmentTypes: new Set(o.appointmentTypes.map((t) => t.id)),
    ...(o.forms ? { forms: new Set(o.forms.map((f) => f.id)) } : {}),
    ...(o.customValues ? { customValues: new Set(o.customValues.map((v) => v.key)) } : {}),
  };
}

export type { AgentRoleKey, FilterGroup };
