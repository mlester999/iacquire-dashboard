// Strict structural schema for Blueprint packages (format v1). Unknown keys are refused everywhere, every string and list is bounded, and
// nothing in a package can carry code: assets are plain data the server turns into rows through fixed code paths.
//
// The embedded native formats are built FROM the native schemas (src/lib/crm/forms/spec.ts draftSchema and questionSchema,
// src/lib/crm/workflow/spec.ts triggerConfigSchema and STEP_KINDS, the report config schema), with only their ID slots replaced by reference
// schemas, so a package can never hold a definition the CRM itself would not accept structurally. Reference integrity, the CRM's own
// semantic rules, unsafe content and secret checks live in validate.ts.
import { z } from "zod";
import { FIELD_ENTITIES, FIELD_TYPES } from "@/lib/crm/types";
import { MAX_FILTER_CONDITIONS, type FilterGroup } from "@/lib/crm/filters";
import { CONTACT_TARGET_KEYS, FORM_KEY_RE, FORM_KINDS, FORM_LIMITS, FORM_PURPOSES, QUESTION_KEY_RE, draftSchema, questionSchema } from "@/lib/crm/forms/spec";
import { STEP_KEY_RE, STEP_KINDS, STEP_KIND_LIST, WORKFLOW_LIMITS, triggerConfigSchema, type StepKind } from "@/lib/crm/workflow/spec";
import { reportConfigSchema, reportFiltersSchema } from "@/components/crm/reports/spec";
import {
  ASSET_SECTIONS, ASSIGNMENT_STRATEGIES, BLUEPRINT_FOLDER_KINDS, BLUEPRINT_FORMAT, BLUEPRINT_INDUSTRIES, CUSTOM_VALUE_TYPES, ID_PREFIX, ID_SEGMENT, LOGICAL_ID_MAX,
  MESSAGE_CHANNELS, REQUIREMENT_KEYS, TEMPLATE_KINDS, isLogicalId, isRef, typeOfId,
  type AssetType, type BlueprintContent, type BlueprintPackageFile, type SlotKind,
} from "@/lib/crm/blueprints/types";

/** How many of each thing one package may hold. Mirrors the native limits where there is one. */
export const LIMITS = {
  folders: 100,
  tags: 300,
  customFields: 200,
  customValues: 200,
  pipelines: 25,
  stagesPerPipeline: 30,
  calendars: 30,
  typesPerCalendar: 20,
  hoursPerCalendar: 50,
  questionsPerType: 10,
  smartLists: 100,
  assignmentRules: 50,
  ruleMembers: 50,
  forms: 60,
  messageTemplates: 200,
  workflows: 100,
  reports: 100,
  slots: 50,
  options: 100,
  calendarHosts: 50,
} as const;

const text = (max: number) => z.string().max(max);
const name = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => z.string().max(max).nullable();
const color = z.string().regex(/^#[0-9a-f]{6}$/, "Colours are lower-case #rrggbb.");
/** crm_message_templates / crm_workflows keys. */
const KEY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$/;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;

const TYPE_LABEL: Record<AssetType | SlotKind, string> = {
  folder: "folder", tag: "tag", customField: "custom field", customValue: "configuration value", pipeline: "pipeline", stage: "stage", calendar: "calendar",
  appointmentType: "appointment type", smartList: "Smart List", assignmentRule: "assignment rule", form: "form", messageTemplate: "message template",
  workflow: "workflow", report: "report", member: "team member slot", n8n: "n8n slot", webhook: "webhook slot",
};

/** An asset's own logical ID, of one type. */
export const idOf = (type: AssetType | SlotKind) =>
  z.string().max(LOGICAL_ID_MAX).refine(isLogicalId, "Not a valid logical ID (a prefix and one to three lower-case segments, such as tag.hot-lead).")
    .refine((v) => typeOfId(v) === type, `Expected a ${TYPE_LABEL[type]} ID ("${ID_PREFIX[type]}.…").`);

/** A reference ("@" + logical ID) to one of the given types. */
export const refTo = (...types: Array<AssetType | SlotKind>) =>
  z.string().max(LOGICAL_ID_MAX + 1).refine(isRef, "Use a reference such as @tag.hot-lead, never a database or GoHighLevel ID.")
    .refine((v) => types.includes(typeOfId(v) as AssetType | SlotKind), `Expected a reference to a ${types.map((t) => TYPE_LABEL[t]).join(" or ")}.`);

const FIELD_REF = `@field(?:\\.${ID_SEGMENT}){1,3}`;
/** A built-in field key, or a custom field reference. */
const fieldOrRef = (builtIn: string) => new RegExp(`^(?:${FIELD_REF}|${builtIn})$`);

// ---------------------------------------------------------------------------
// Filters with references
// ---------------------------------------------------------------------------

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const filterValueSchema = z.union([
  scalar,
  z.array(z.union([z.string().max(200), z.number().finite()])).max(200),
  z.strictObject({ from: z.union([z.string().max(40), z.number().finite()]), to: z.union([z.string().max(40), z.number().finite()]) }),
  z.strictObject({ channel: z.string().max(20).optional(), purpose: z.string().max(20).optional(), status: z.string().max(20).optional() }),
]);
const filterConditionSchema = z.strictObject({
  field: z.string().min(1).max(LOGICAL_ID_MAX + 1).regex(fieldOrRef("[a-z_]{1,40}"), "Unknown filter field."),
  op: z.string().min(1).max(40).regex(/^[a-z_]+$/),
  value: filterValueSchema.optional(),
});
/** A filter group in the CRM's filter language, with references in place of IDs. Depth and condition counts are checked in validate.ts. */
export const blueprintFilterSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.strictObject({ op: z.enum(["and", "or"]), conditions: z.array(z.union([blueprintFilterSchema, filterConditionSchema])).max(MAX_FILTER_CONDITIONS) }),
);

// ---------------------------------------------------------------------------
// Folders, tags, fields, values
// ---------------------------------------------------------------------------

export const folderSchema = z.strictObject({ id: idOf("folder"), kind: z.enum(BLUEPRINT_FOLDER_KINDS), name: name(80) });

export const tagSchema = z.strictObject({ id: idOf("tag"), name: name(60), color, description: nullableText(300), folder: refTo("folder").nullable() });

const optionSchema = z.strictObject({ value: z.string().trim().min(1).max(60), label: name(80) });

export const customFieldSchema = z.strictObject({
  id: idOf("customField"),
  entity: z.enum(FIELD_ENTITIES),
  key: z.string().regex(FIELD_KEY_RE, "Field keys are lower-case letters, numbers and _ (48 at most), starting with a letter."),
  label: name(80),
  type: z.enum(FIELD_TYPES),
  options: z.array(optionSchema).max(LIMITS.options),
  required: z.boolean(),
  helpText: nullableText(200),
  groupName: nullableText(60),
})
  .refine((f) => !["select", "multiselect"].includes(f.type) || f.options.length > 0, "Choice fields need at least one option.")
  .refine((f) => ["select", "multiselect"].includes(f.type) || f.options.length === 0, "Only choice fields have options.")
  .refine((f) => new Set(f.options.map((o) => o.value)).size === f.options.length, "Each option of a field needs its own value.");

export const customValueSchema = z.strictObject({
  id: idOf("customValue"),
  key: z.string().regex(FIELD_KEY_RE, "Value keys are lower-case letters, numbers and _ (48 at most), starting with a letter."),
  label: name(80),
  type: z.enum(CUSTOM_VALUE_TYPES),
  value: text(2000),
  required: z.boolean(),
  groupName: nullableText(60),
});

// ---------------------------------------------------------------------------
// Pipelines and stages
// ---------------------------------------------------------------------------

export const stageSchema = z.strictObject({
  id: idOf("stage"),
  name: name(60),
  kind: z.enum(["open", "won", "lost"]),
  probability: z.number().int().min(0).max(100).nullable(),
  color: color.nullable(),
});

export const pipelineSchema = z.strictObject({
  id: idOf("pipeline"),
  name: name(80),
  description: nullableText(300),
  isDefault: z.boolean(),
  stages: z.array(stageSchema).min(1).max(LIMITS.stagesPerPipeline),
})
  .refine((p) => p.stages.some((s) => s.kind === "open"), "A pipeline needs at least one open stage.")
  .refine((p) => p.stages.filter((s) => s.kind === "won").length <= 1 && p.stages.filter((s) => s.kind === "lost").length <= 1, "A pipeline has at most one won and one lost stage.")
  .refine((p) => new Set(p.stages.map((s) => s.name.trim().toLowerCase())).size === p.stages.length, "Stage names in a pipeline must differ.");

// ---------------------------------------------------------------------------
// Calendars and appointment types
// ---------------------------------------------------------------------------

const hoursSchema = z.strictObject({
  weekday: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
}).refine((h) => h.endMinute > h.startMinute, "Working hours must end after they start.");

const bookingQuestionSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Each question needs a short key of lower-case letters, numbers and _."),
  label: name(120),
  type: z.enum(["text", "textarea", "select"]),
  required: z.boolean(),
  options: z.array(name(100)).max(20).optional(),
})
  .refine((q) => q.type !== "select" || (q.options?.length ?? 0) > 0, "A choice question needs 1 to 20 options.")
  .refine((q) => q.type === "select" || q.options === undefined, "Only choice questions have options.")
  .refine((q) => !q.options || new Set(q.options.map((o) => o.toLowerCase())).size === q.options.length, "Each choice in a question is different.");

const httpsUrl = z.string().max(500).regex(/^https:\/\/[^\s<>"']{4,490}$/, "Links must be full https:// web addresses.");

/** Whether the runtime knows an IANA time zone (works in Node and in browsers). */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const appointmentTypeSchema = z.strictObject({
  id: idOf("appointmentType"),
  name: name(80),
  description: nullableText(1000),
  durationMinutes: z.number().int().min(5).max(720),
  slotIntervalMinutes: z.number().int().min(5).max(240).nullable(),
  bufferBeforeMinutes: z.number().int().min(0).max(240),
  bufferAfterMinutes: z.number().int().min(0).max(240),
  minNoticeMinutes: z.number().int().min(0).max(43200),
  maxDaysAhead: z.number().int().min(1).max(365),
  dailyLimit: z.number().int().min(1).max(100).nullable(),
  capacity: z.number().int().min(1).max(500),
  locationKind: z.enum(["phone", "video", "in_person", "custom", "none"]),
  locationDetail: nullableText(300),
  meetingProvider: z.enum(["none", "google_meet", "microsoft_teams", "custom_link"]),
  meetingLink: httpsUrl.nullable(),
  requiresConfirmation: z.boolean(),
  public: z.boolean(),
  questions: z.array(bookingQuestionSchema).max(LIMITS.questionsPerType),
  color: color.nullable(),
  confirmationMessage: nullableText(500),
  allowCustomerChanges: z.boolean(),
  changeCutoffMinutes: z.number().int().min(0).max(10080),
  requireEmail: z.boolean(),
  requirePhone: z.boolean(),
})
  .refine((t) => t.requireEmail || t.requirePhone, "Ask for at least an email address or a phone number, so the business can reach the person who booked.")
  .refine((t) => new Set(t.questions.map((q) => q.key)).size === t.questions.length, "Each booking question needs its own key.");

export const calendarSchema = z.strictObject({
  id: idOf("calendar"),
  name: name(80),
  description: nullableText(500),
  assignment: z.enum(["single", "round_robin", "collective"]),
  roundRobinMode: z.enum(["balanced", "priority"]),
  color: color.nullable(),
  folder: refTo("folder").nullable(),
  bookingIntro: nullableText(500),
  timezone: z.string().min(1).max(64).refine(isTimeZone, "Use an IANA time zone such as America/New_York.").nullable(),
  hours: z.array(hoursSchema).max(LIMITS.hoursPerCalendar),
  hosts: z.array(refTo("member")).max(LIMITS.calendarHosts),
  types: z.array(appointmentTypeSchema).min(1).max(LIMITS.typesPerCalendar),
})
  .refine((c) => c.assignment !== "single" || c.hosts.length <= 1, "A one-person calendar has at most one host. Use round robin or collective for a team.")
  .refine((c) => new Set(c.hosts).size === c.hosts.length, "Each host is listed once.");

// ---------------------------------------------------------------------------
// Smart Lists and assignment rules
// ---------------------------------------------------------------------------

export const smartListSchema = z.strictObject({
  id: idOf("smartList"),
  entity: z.enum(["contact", "company", "opportunity"]),
  name: name(80),
  description: nullableText(300),
  folder: refTo("folder").nullable(),
  filter: blueprintFilterSchema,
  columns: z.array(z.string().max(LOGICAL_ID_MAX + 1).regex(fieldOrRef("[a-z_]{2,40}"), "Unknown column.")).max(30),
  sort: z.strictObject({ by: z.string().regex(/^[a-z_]{2,40}$/).optional(), dir: z.enum(["asc", "desc"]).optional() }),
  isDefault: z.boolean(),
}).refine((s) => new Set(s.columns).size === s.columns.length, "Each column is listed once.");

export const assignmentRuleSchema = z.strictObject({
  id: idOf("assignmentRule"),
  name: name(80),
  entity: z.enum(["contact", "opportunity"]),
  conditions: blueprintFilterSchema,
  reassignOwned: z.boolean(),
  strategy: z.enum(ASSIGNMENT_STRATEGIES),
  respectWorkingHours: z.boolean(),
  fallback: z.enum(["unassigned", "fallback_user"]),
  fallbackMember: refTo("member").nullable(),
  members: z.array(z.strictObject({ member: refTo("member"), weight: z.number().int().min(1).max(100), priority: z.number().int().min(0).max(100) })).max(LIMITS.ruleMembers),
})
  .refine((r) => r.fallback !== "fallback_user" || r.fallbackMember !== null, "Choose the fallback person (a team member slot).")
  .refine((r) => r.fallback === "fallback_user" || r.fallbackMember === null, "Only a rule that falls back to a person names one.")
  .refine((r) => new Set(r.members.map((m) => m.member)).size === r.members.length, "Each member is listed once.");

// ---------------------------------------------------------------------------
// Forms: the native FormDraft with references
// ---------------------------------------------------------------------------

const nativeActions = draftSchema.shape.actions;
export const blueprintQuestionSchema = questionSchema.extend({
  key: z.string().regex(QUESTION_KEY_RE, "Answer keys are lower-case letters, numbers and _ (starting with a letter, up to 40)."),
  map: z.union([z.enum(CONTACT_TARGET_KEYS as [string, ...string[]]), refTo("customField")]).nullable().optional(),
});
export const blueprintFormDraftSchema = draftSchema.extend({
  questions: z.array(blueprintQuestionSchema).max(FORM_LIMITS.questions),
  actions: nativeActions.extend({
    tagIds: z.array(refTo("tag")).max(FORM_LIMITS.tags),
    opportunity: nativeActions.shape.opportunity.unwrap().extend({ pipelineId: refTo("pipeline"), stageId: refTo("stage") }).nullable(),
    assignmentRuleId: refTo("assignmentRule").nullable(),
  }),
});

export const formSchema = z.strictObject({
  id: idOf("form"),
  key: z.string().regex(FORM_KEY_RE, "Form keys are lower-case letters, numbers and single hyphens inside (48 at most)."),
  name: name(80),
  kind: z.enum(FORM_KINDS),
  purpose: z.enum(FORM_PURPOSES),
  folder: refTo("folder").nullable(),
  draft: blueprintFormDraftSchema,
  placeholder: z.boolean(),
});

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

export const messageTemplateSchema = z.strictObject({
  id: idOf("messageTemplate"),
  kind: z.enum(TEMPLATE_KINDS),
  key: z.string().regex(KEY_RE, "Template keys are lower-case letters, numbers, - and _ (48 at most)."),
  name: name(80),
  channel: z.enum(MESSAGE_CHANNELS).nullable(),
  purpose: z.enum(["service", "marketing"]),
  category: nullableText(40),
  folder: refTo("folder").nullable(),
  subject: z.string().max(200).nullable(),
  body: z.string().max(5000),
  whatsapp: z.strictObject({
    name: z.string().regex(/^[a-z0-9_]{1,512}$/, "WhatsApp template names are lower-case letters, numbers and _."),
    language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Use a WhatsApp language code such as en or en_US."),
    category: z.enum(["utility", "marketing", "authentication"]),
  }).nullable(),
  placeholder: z.boolean(),
})
  .refine((t) => t.kind === "canned_reply" || t.channel !== null, "A template has a channel (only canned replies work on any channel).")
  .refine((t) => t.placeholder || t.body.trim().length > 0, "A template needs a message.")
  .refine((t) => t.channel !== "sms" || t.body.length <= 1600, "SMS templates are at most 1,600 characters.")
  .refine((t) => t.channel !== "whatsapp" || t.whatsapp === null || t.body.length <= 1024, "WhatsApp templates submitted to Meta are at most 1,024 characters.")
  .refine((t) => t.whatsapp === null || (t.channel === "whatsapp" && t.kind === "template"), "Only WhatsApp templates carry WhatsApp details.")
  .refine((t) => (t.channel === "email" && t.kind === "template") || t.subject === null, "Only email templates have a subject.");

// ---------------------------------------------------------------------------
// Workflows: the native WorkflowDefinition with references
// ---------------------------------------------------------------------------

type AnyObject = z.ZodObject<z.ZodRawShape>;
const asObject = (s: unknown) => s as AnyObject;

const nativeFilters = asObject(triggerConfigSchema.shape.filters.unwrap());
const triggerFiltersSchema = nativeFilters.extend({
  tagIds: z.array(refTo("tag")).min(1).max(20).optional(),
  pipelineId: refTo("pipeline").optional(),
  stageIds: z.array(refTo("stage")).min(1).max(50).optional(),
  fromStageIds: z.array(refTo("stage")).min(1).max(50).optional(),
  calendarIds: z.array(refTo("calendar")).min(1).max(50).optional(),
  appointmentTypeIds: z.array(refTo("appointmentType")).min(1).max(50).optional(),
  assigneeIds: z.array(refTo("member")).min(1).max(50).optional(),
  formIds: z.array(refTo("form")).min(1).max(50).optional(),
  changedFields: z.array(z.string().trim().min(1).max(LOGICAL_ID_MAX + 1).regex(fieldOrRef("[a-z_]{1,40}"), "Unknown field.")).min(1).max(30).optional(),
});
const inboundSchema = asObject(triggerConfigSchema.shape.inbound.unwrap()).omit({ nonce: true });

/** A trigger as a package carries it: references in every ID filter, no inbound webhook nonce. */
export const blueprintTriggerSchema = triggerConfigSchema.extend({
  filters: triggerFiltersSchema.optional(),
  contactFilter: blueprintFilterSchema.nullable().optional(),
  inbound: inboundSchema.optional(),
});

const stepObject = (kind: StepKind) => asObject(STEP_KINDS[kind].schema);
const waitOptions = (STEP_KINDS.wait.schema as unknown as { options: AnyObject[] }).options;
const untilDate = waitOptions.find((o) => (o.shape.mode as unknown as { value?: string }).value === "until_date")!;

/** Each step kind's config as a package carries it: references in every ID slot, no template content hash. */
export const BLUEPRINT_STEP_CONFIG: Record<StepKind, z.ZodType> = {
  wait: z.union([...waitOptions.filter((o) => o !== untilDate), untilDate.extend({ fieldId: refTo("customField").optional() })] as unknown as [AnyObject, AnyObject, ...AnyObject[]]),
  branch: stepObject("branch").extend({ filter: blueprintFilterSchema }),
  add_tag: stepObject("add_tag").extend({ tagIds: z.array(refTo("tag")).min(1, "Choose at least one tag.").max(20) }),
  remove_tag: stepObject("remove_tag").extend({ tagIds: z.array(refTo("tag")).min(1, "Choose at least one tag.").max(20) }),
  assign: stepObject("assign").extend({ userId: refTo("member").optional(), ruleId: refTo("assignmentRule").optional() }),
  create_task: stepObject("create_task").extend({ userId: refTo("member").optional() }),
  update_field: stepObject("update_field").extend({ field: z.string().max(LOGICAL_ID_MAX + 1).regex(fieldOrRef("[a-z_]{1,40}"), "Choose a field.") }),
  create_opportunity: stepObject("create_opportunity").extend({ pipelineId: refTo("pipeline"), stageId: refTo("stage") }),
  move_stage: stepObject("move_stage").extend({ pipelineId: refTo("pipeline"), stageId: refTo("stage") }),
  send_message: stepObject("send_message").omit({ contentHash: true }).extend({ templateId: refTo("messageTemplate") }),
  request_review: stepObject("request_review").omit({ contentHash: true }).extend({ templateId: refTo("messageTemplate") }),
  notify_team: stepObject("notify_team").extend({ userIds: z.array(refTo("member")).max(20).optional() }),
  internal_note: STEP_KINDS.internal_note.schema,
  n8n: stepObject("n8n").extend({ mappingId: refTo("n8n") }),
  webhook: stepObject("webhook").extend({ subscriptionId: refTo("webhook") }),
  ai_task: STEP_KINDS.ai_task.schema,
  conversation_action: stepObject("conversation_action").extend({ userId: refTo("member").optional() }),
  end: STEP_KINDS.end.schema,
  // Automation Studio's integration steps use a connection, which belongs to one workspace (and holds its credentials): a package can't carry them.
  http_request: z.custom(() => false, "Steps that use a connection (HTTP request, Slack) can't be part of a Blueprint: each workspace sets up its own connections."),
  slack_message: z.custom(() => false, "Steps that use a connection (HTTP request, Slack) can't be part of a Blueprint: each workspace sets up its own connections."),
};

const stepKey = z.string().regex(STEP_KEY_RE, "Step keys are lower-case letters, numbers, - and _ (up to 40).");
export const blueprintStepSchema = z.strictObject({
  key: stepKey,
  kind: z.enum(STEP_KIND_LIST),
  name: z.string().trim().max(80).optional(),
  config: z.record(z.string(), z.unknown()),
  requireApproval: z.boolean().optional(),
  next: stepKey.nullable().optional(),
  branches: z.strictObject({ yes: stepKey.nullable().optional(), no: stepKey.nullable().optional() }).optional(),
  ui: z.strictObject({ x: z.number().finite().optional(), y: z.number().finite().optional(), collapsed: z.boolean().optional() }).optional(),
}).superRefine((s, ctx) => {
  const parsed = BLUEPRINT_STEP_CONFIG[s.kind].safeParse(s.config);
  if (!parsed.success) for (const i of parsed.error.issues.slice(0, 5)) ctx.addIssue({ code: "custom", path: ["config", ...i.path.map((p) => (typeof p === "symbol" ? String(p) : p))], message: i.message });
});

export const blueprintWorkflowDefinitionSchema = z.strictObject({
  trigger: blueprintTriggerSchema,
  steps: z.array(blueprintStepSchema).max(WORKFLOW_LIMITS.maxSteps),
});

export const workflowSchema = z.strictObject({
  id: idOf("workflow"),
  key: z.string().regex(KEY_RE, "Workflow keys are lower-case letters, numbers, - and _ (48 at most)."),
  name: name(80),
  description: nullableText(500),
  folder: refTo("folder").nullable(),
  hourlyRunLimit: z.number().int().min(1).max(10000),
  definition: blueprintWorkflowDefinitionSchema,
  placeholder: z.boolean(),
});

// ---------------------------------------------------------------------------
// Reports: the native report config with references
// ---------------------------------------------------------------------------

export const blueprintReportConfigSchema = z.strictObject({
  filters: z.strictObject({
    ...reportFiltersSchema.omit({ campaign: true, member: true, pipeline: true }).shape,
    member: refTo("member").optional(),
    pipeline: refTo("pipeline").optional(),
  }),
  sections: reportConfigSchema.shape.sections,
});

export const reportSchema = z.strictObject({
  id: idOf("report"),
  key: z.string().regex(FORM_KEY_RE, "Report keys are lower-case letters, numbers and single hyphens inside (48 at most)."),
  name: name(80),
  description: nullableText(300),
  folder: refTo("folder").nullable(),
  config: blueprintReportConfigSchema,
});

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

export const slotSchema = z.strictObject({
  id: z.string().max(LOGICAL_ID_MAX).refine(isLogicalId, "Not a valid slot ID.").refine((v) => ["member", "n8n", "webhook"].includes(typeOfId(v) ?? ""), "Slots are member.…, n8n.… or webhook.…"),
  label: name(80),
  description: nullableText(300),
});

export const assetsSchema = z.strictObject({
  folders: z.array(folderSchema).max(LIMITS.folders),
  tags: z.array(tagSchema).max(LIMITS.tags),
  customFields: z.array(customFieldSchema).max(LIMITS.customFields),
  customValues: z.array(customValueSchema).max(LIMITS.customValues),
  pipelines: z.array(pipelineSchema).max(LIMITS.pipelines),
  calendars: z.array(calendarSchema).max(LIMITS.calendars),
  smartLists: z.array(smartListSchema).max(LIMITS.smartLists),
  assignmentRules: z.array(assignmentRuleSchema).max(LIMITS.assignmentRules),
  forms: z.array(formSchema).max(LIMITS.forms),
  messageTemplates: z.array(messageTemplateSchema).max(LIMITS.messageTemplates),
  workflows: z.array(workflowSchema).max(LIMITS.workflows),
  reports: z.array(reportSchema).max(LIMITS.reports),
});

export const metaSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, "Keys are 3 to 64 lower-case letters, numbers and -."),
  name: name(80),
  description: text(1000),
  industry: z.enum(BLUEPRINT_INDUSTRIES),
});

export const settingsSchema = z.strictObject({ defaultCurrency: z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code such as USD.").nullable() });

export const contentSchema = z.strictObject({
  format: z.literal(BLUEPRINT_FORMAT),
  schemaVersion: z.literal(1),
  blueprint: metaSchema,
  settings: settingsSchema,
  slots: z.array(slotSchema).max(LIMITS.slots),
  assets: assetsSchema,
});

const idList = z.array(z.string().max(LOGICAL_ID_MAX)).max(5000);
export const manifestSchema = z.strictObject({
  counts: z.strictObject(Object.fromEntries(ASSET_SECTIONS.map((s) => [s, z.number().int().min(0)])) as Record<(typeof ASSET_SECTIONS)[number], z.ZodNumber>),
  assetIds: idList,
  dependencies: z.record(z.string().max(LOGICAL_ID_MAX), z.array(z.string().max(LOGICAL_ID_MAX)).max(500)),
  slotUse: z.record(z.string().max(LOGICAL_ID_MAX), z.array(z.string().max(LOGICAL_ID_MAX)).max(5000)),
  requirements: z.array(z.enum(REQUIREMENT_KEYS)).max(REQUIREMENT_KEYS.length),
});

export const packageFileSchema = contentSchema.extend({
  manifest: manifestSchema,
  integrity: z.strictObject({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[0-9a-f]{64}$/) }),
  exportedAt: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "exportedAt is an ISO date."),
  generator: z.string().max(80),
});

/** The schema for one top-level asset type. */
export const SECTION_SCHEMA = {
  folders: folderSchema, tags: tagSchema, customFields: customFieldSchema, customValues: customValueSchema, pipelines: pipelineSchema, calendars: calendarSchema,
  smartLists: smartListSchema, assignmentRules: assignmentRuleSchema, forms: formSchema, messageTemplates: messageTemplateSchema, workflows: workflowSchema, reports: reportSchema,
} as const;

/** Parses package content (no manifest or digest), throwing for the first problem. validate.ts gives every problem with readable paths. */
export function parseContent(input: unknown): BlueprintContent {
  return contentSchema.parse(input) as unknown as BlueprintContent;
}

export function parsePackageFile(input: unknown): BlueprintPackageFile {
  return packageFileSchema.parse(input) as unknown as BlueprintPackageFile;
}

/** A readable path for a Zod issue: "assets.tags[3].color". */
export function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), "");
}
