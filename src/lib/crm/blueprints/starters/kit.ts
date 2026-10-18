// Building blocks for iAcquire's own industry starter Blueprints. Every helper returns a plain asset in the package format
// (src/lib/crm/blueprints/types.ts) with references written as "@<logical id>", so a starter is ordinary package content and passes the
// same validation as any other Blueprint. Pure data: no I/O, no customer data, no people (people are mapping slots), no provider details.
//
// A typo in a reference (a stage or option that does not exist) throws while the starter module loads, so a broken starter can never be
// shipped silently; tests/crm-blueprints-starters.test.ts loads every starter and validates it.
import { slugValue, type FormKind, type FormPurpose, type FormQuestion, type NotifyRole } from "@/lib/crm/forms/spec";
import type { FilterCondition, FilterGroup } from "@/lib/crm/filters";
import type { CreatedVia, FieldEntity, FieldType } from "@/lib/crm/types";
import type { ReportSection } from "@/components/crm/reports/spec";
import type { AgentRoleKey } from "@/lib/agents";
import { slot } from "@/lib/crm/blueprints/builders";
import {
  BLUEPRINT_FORMAT, BLUEPRINT_SCHEMA_VERSION,
  type AppointmentTypeAsset, type AssignmentRuleAsset, type BlueprintAssets, type BlueprintContent, type BlueprintFolderKind, type BlueprintIndustry,
  type BlueprintReportFilters, type BlueprintWorkflowDefinition, type BookingQuestion, type CalendarAsset, type CustomFieldAsset, type CustomValueAsset,
  type CustomValueType, type FolderAsset, type FormAsset, type MessageTemplateAsset, type PipelineAsset, type ReportAsset, type SlotAsset, type SmartListAsset,
  type StageKind, type TagAsset, type WeeklyHours, type WorkflowAsset,
} from "@/lib/crm/blueprints/types";

/** The CRM's tag colours (TAG_COLORS in src/lib/crm/types.ts), by name. */
export const COLOR = {
  slate: "#64748b", blue: "#2563eb", cyan: "#0891b2", green: "#059669", lime: "#65a30d", amber: "#ca8a04", orange: "#ea580c", red: "#dc2626", pink: "#db2777", violet: "#7c3aed",
} as const;

/** "@<id>" for an asset or slot (or an ID). */
export const ref = (x: { id: string } | string): string => `@${typeof x === "string" ? x : x.id}`;

/** The last segment of a logical ID ("pipeline.buyers" → "buyers"). */
const lastSegment = (id: string) => id.split(".").slice(-1)[0];

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

export interface StarterMeta {
  key: string;
  name: string;
  description: string;
  industry: BlueprintIndustry;
}

export function starter(meta: StarterMeta, slots: SlotAsset[], assets: BlueprintAssets): BlueprintContent {
  return {
    format: BLUEPRINT_FORMAT,
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    blueprint: { key: meta.key, name: meta.name, description: meta.description, industry: meta.industry },
    // Each workspace keeps its own currency: a starter is used in many countries.
    settings: { defaultCurrency: null },
    slots,
    assets,
  };
}

/** A team member slot ("member.<segment>"): a role each workspace maps to one of its own people. */
export const memberSlot = (segment: string, label: string, description: string): SlotAsset => slot("member", segment, label, description);

// ---------------------------------------------------------------------------
// Folders, tags, fields, configuration values
// ---------------------------------------------------------------------------

export function folder(kind: BlueprintFolderKind, segment: string, name: string): FolderAsset {
  return { id: `folder.${kind.replace("_", "-")}.${segment}`, kind, name };
}

export function tag(segment: string, name: string, color: string, inFolder: FolderAsset, description: string | null = null): TagAsset {
  if (inFolder.kind !== "tag") throw new Error(`Tag ${segment} must be filed in a tag folder.`);
  return { id: `tag.${segment}`, name, color, description, folder: ref(inFolder) };
}

export interface FieldOptions {
  /** Choice labels; each value is the label's slug ("Within 3 months" → "within_3_months"). */
  options?: readonly string[];
  help?: string;
  group?: string;
}

export function field(entity: FieldEntity, key: string, label: string, type: FieldType, opts: FieldOptions = {}): CustomFieldAsset {
  return {
    id: `field.${entity}.${key}`, entity, key, label, type,
    options: (opts.options ?? []).map((l) => ({ value: slugValue(l), label: l })),
    required: false, helpText: opts.help ?? null, groupName: opts.group ?? null,
  };
}

/** A choice field's stored value for one of its labels (throws for a label the field doesn't have). */
export function optionValue(f: CustomFieldAsset, label: string): string {
  const o = f.options.find((x) => x.label === label);
  if (!o) throw new Error(`${f.id} has no option “${label}”.`);
  return o.value;
}

/** A business detail each workspace fills in itself (an address, a booking link). Starters never carry a value. */
export function configValue(key: string, label: string, type: CustomValueType, group: string | null = null): CustomValueAsset {
  return { id: `value.${key}`, key, label, type, value: "", required: true, groupName: group };
}

/** "{{custom_values.<key>}}" for a configuration value. */
export const cv = (v: CustomValueAsset): string => `{{custom_values.${v.key}}}`;

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export type StageSpec = [segment: string, name: string, kind: StageKind, probability: number | null, color?: string];

export function pipeline(segment: string, name: string, description: string, isDefault: boolean, stages: StageSpec[]): PipelineAsset {
  return {
    id: `pipeline.${segment}`, name, description, isDefault,
    stages: stages.map(([s, n, kind, probability, color]) => ({ id: `stage.${segment}.${s}`, name: n, kind, probability, color: color ?? null })),
  };
}

/** "@stage.<pipeline>.<segment>", checked against the pipeline's own stages. */
export function stageRef(p: PipelineAsset, segment: string): string {
  const id = `stage.${lastSegment(p.id)}.${segment}`;
  if (!p.stages.some((s) => s.id === id)) throw new Error(`${p.id} has no stage ${segment}.`);
  return ref(id);
}

// ---------------------------------------------------------------------------
// Calendars and appointment types
// ---------------------------------------------------------------------------

const minuteOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** The same working window on several weekdays (0 = Sunday), as calendars store their suggested hours. */
export const weekly = (weekdays: number[], from: string, to: string): WeeklyHours[] =>
  weekdays.map((weekday) => ({ weekday, startMinute: minuteOf(from), endMinute: minuteOf(to) }));

export const MON_FRI = [1, 2, 3, 4, 5];
export const MON_SAT = [1, 2, 3, 4, 5, 6];
export const TUE_SAT = [2, 3, 4, 5, 6];

/** Booking questions. */
export const ask = {
  text: (key: string, label: string, required = false): BookingQuestion => ({ key, label, type: "text", required }),
  long: (key: string, label: string, required = false): BookingQuestion => ({ key, label, type: "textarea", required }),
  choice: (key: string, label: string, options: string[], required = true): BookingQuestion => ({ key, label, type: "select", required, options }),
};

export type TypeOptions = Partial<Omit<AppointmentTypeAsset, "id" | "name" | "meetingLink">>;

/** An appointment type with sensible defaults. Never a fixed meeting link: video types use the host's own connected calendar. */
function appointmentType(calendarSegment: string, segment: string, name: string, opts: TypeOptions): AppointmentTypeAsset {
  return {
    id: `apptype.${calendarSegment}.${segment}`, name, description: null, durationMinutes: 30, slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
    minNoticeMinutes: 240, maxDaysAhead: 60, dailyLimit: null, capacity: 1, locationKind: "phone", locationDetail: null, meetingProvider: "none",
    requiresConfirmation: false, public: true, questions: [], color: null, confirmationMessage: null, allowCustomerChanges: true, changeCutoffMinutes: 240,
    requireEmail: true, requirePhone: true, ...opts, meetingLink: null,
  };
}

export interface CalendarOptions {
  description: string;
  assignment: CalendarAsset["assignment"];
  roundRobinMode?: CalendarAsset["roundRobinMode"];
  color?: string | null;
  folder?: FolderAsset | null;
  bookingIntro: string;
  hours: WeeklyHours[];
  hosts: SlotAsset[];
}

export function calendar(
  segment: string, name: string, opts: CalendarOptions,
  types: (type: (segment: string, name: string, opts: TypeOptions) => AppointmentTypeAsset) => AppointmentTypeAsset[],
): CalendarAsset {
  return {
    id: `calendar.${segment}`, name, description: opts.description, assignment: opts.assignment, roundRobinMode: opts.roundRobinMode ?? "balanced",
    color: opts.color ?? null, folder: opts.folder ? ref(opts.folder) : null, bookingIntro: opts.bookingIntro,
    // The workspace's own time zone: a starter never assumes where the business is.
    timezone: null, hours: opts.hours, hosts: opts.hosts.map(ref),
    types: types((s, n, o) => appointmentType(segment, s, n, o)),
  };
}

// ---------------------------------------------------------------------------
// Smart Lists and assignment rules (the CRM's own filter language)
// ---------------------------------------------------------------------------

export const all = (...conditions: Array<FilterCondition | FilterGroup>): FilterGroup => ({ op: "and", conditions });
export const anyOf = (...conditions: Array<FilterCondition | FilterGroup>): FilterGroup => ({ op: "or", conditions });
export const where = (fieldKey: string, op: string, value?: unknown): FilterCondition => (value === undefined ? { field: fieldKey, op } : { field: fieldKey, op, value });

export const has = {
  anyTag: (...tags: TagAsset[]) => where("tags", "has_any", tags.map(ref)),
  noTag: (...tags: TagAsset[]) => where("tags", "has_none", tags.map(ref)),
  status: (...statuses: string[]) => where("lead_status", "in", statuses),
  createdWithinDays: (days: number) => where("created_at", "within_last_days", days),
  noReplyForDays: (days: number) => where("conversation", "no_reply_in_days", days),
  upcomingAppointment: () => where("appointments", "has_upcoming"),
  noAppointments: () => where("appointments", "has_none"),
  openDeal: () => where("opportunity", "has_open"),
  wonDeal: () => where("opportunity", "has_won"),
  inStages: (p: PipelineAsset, ...segments: string[]) => where("opportunity", "in_stage", segments.map((s) => stageRef(p, s))),
  unassigned: () => where("owner", "is_unassigned"),
  noActivityForDays: (days: number) => where("last_activity_at", "more_than_days_ago", days),
  marketingConsent: (channel: "email" | "sms" | "whatsapp") => where("consent", "is", { channel, purpose: "marketing", status: "granted" }),
  field: (f: CustomFieldAsset, op: string, value?: unknown) => where(ref(f), op, value),
  /** A choice field set to one of these labels. */
  choice: (f: CustomFieldAsset, ...labels: string[]) => where(ref(f), "in", labels.map((l) => optionValue(f, l))),
};

export function smartList(
  segment: string, name: string, description: string, inFolder: FolderAsset, filter: FilterGroup, columns: Array<string | CustomFieldAsset>,
  sort: SmartListAsset["sort"] = { by: "created_at", dir: "desc" },
): SmartListAsset {
  if (inFolder.kind !== "smart_list") throw new Error(`Smart List ${segment} must be filed in a Smart List folder.`);
  return {
    id: `list.${segment}`, entity: "contact", name, description, folder: ref(inFolder), filter,
    columns: columns.map((c) => (typeof c === "string" ? c : ref(c))), sort, isDefault: false,
  };
}

/**
 * A contact assignment rule (round robin). It arrives switched on when it has member roles and each one is mapped to someone as the starter
 * is applied; otherwise switched off, until the workspace adds its own people and turns it on.
 */
export function assignmentRule(segment: string, name: string, conditions: FilterGroup, members: SlotAsset[]): AssignmentRuleAsset {
  return {
    id: `rule.${segment}`, name, entity: "contact", conditions, reassignOwned: false, strategy: "round_robin", respectWorkingHours: true,
    fallback: "unassigned", fallbackMember: null, members: members.map((m, i) => ({ member: ref(m), weight: 1, priority: i })),
  };
}

// ---------------------------------------------------------------------------
// Forms and surveys (the native FormDraft)
// ---------------------------------------------------------------------------

interface QuestionOptions {
  required?: boolean;
  help?: string;
  placeholder?: string;
  width?: "full" | "half";
}

const question = (key: string, type: FormQuestion["type"], label: string, o: QuestionOptions, extra: Partial<FormQuestion> = {}): FormQuestion => ({
  key, type, label, required: o.required ?? false, ...(o.help ? { help: o.help } : {}), ...(o.placeholder ? { placeholder: o.placeholder } : {}), width: o.width ?? "full", ...extra,
});

/** Form questions. Answers saved to a custom field use that field's own choices, so they always fit. */
export const fq = {
  firstName: (): FormQuestion => question("first_name", "short_text", "First name", { required: true, width: "half" }, { map: "contact.first_name" }),
  lastName: (required = false): FormQuestion => question("last_name", "short_text", "Last name", { required, width: "half" }, { map: "contact.last_name" }),
  email: (required = true): FormQuestion => question("email", "email", "Email", { required, width: "half" }, { map: "contact.email" }),
  phone: (required = false, label = "Mobile number"): FormQuestion => question("phone", "phone", label, { required, width: "half" }, { map: "contact.phone" }),
  city: (label = "Town or city"): FormQuestion => question("city", "short_text", label, { width: "half" }, { map: "contact.city" }),
  postalCode: (label = "Postcode or ZIP code"): FormQuestion => question("postal_code", "short_text", label, { width: "half" }, { map: "contact.postal_code" }),
  address: (label = "Street address"): FormQuestion => question("address", "short_text", label, {}, { map: "contact.address_line1" }),
  /** Records the campaign a visitor came from, when the link had one. */
  utmSource: (): FormQuestion => ({ key: "utm_source", type: "hidden", label: "Campaign source", required: false, source: { kind: "param", param: "utm_source" } }),
  text: (key: string, label: string, o: QuestionOptions & { field?: CustomFieldAsset } = {}): FormQuestion =>
    question(key, "short_text", label, o, o.field ? { map: ref(o.field) } : {}),
  long: (key: string, label: string, o: QuestionOptions & { field?: CustomFieldAsset } = {}): FormQuestion =>
    question(key, "long_text", label, o, o.field ? { map: ref(o.field) } : {}),
  number: (key: string, label: string, o: QuestionOptions & { field?: CustomFieldAsset; min?: number; max?: number; integer?: boolean } = {}): FormQuestion =>
    question(key, "number", label, o, {
      ...(o.field ? { map: ref(o.field) } : {}),
      ...(o.min !== undefined || o.max !== undefined || o.integer ? { validation: { ...(o.min !== undefined ? { min: o.min } : {}), ...(o.max !== undefined ? { max: o.max } : {}), ...(o.integer ? { integer: true } : {}) } } : {}),
    }),
  date: (key: string, label: string, o: QuestionOptions & { field?: CustomFieldAsset } = {}): FormQuestion => question(key, "date", label, o, o.field ? { map: ref(o.field) } : {}),
  /** One answer, saved to a choice field (with exactly its choices). */
  choice: (key: string, label: string, f: CustomFieldAsset, o: QuestionOptions & { display?: "dropdown" | "radio" } = {}): FormQuestion => {
    if (f.type !== "select") throw new Error(`${f.id} is not a single-choice field.`);
    return question(key, "single_choice", label, o, { options: f.options.map((x) => ({ ...x })), display: o.display ?? "dropdown", map: ref(f) });
  },
  /** Several answers, saved to a multiple-choice field. */
  multi: (key: string, label: string, f: CustomFieldAsset, o: QuestionOptions = {}): FormQuestion => {
    if (f.type !== "multiselect") throw new Error(`${f.id} is not a multiple-choice field.`);
    return question(key, "multiple_choice", label, o, { options: f.options.map((x) => ({ ...x })), map: ref(f) });
  },
  /** One answer from a list that is kept with the submission only (a survey rating). */
  pick: (key: string, label: string, options: string[], o: QuestionOptions & { display?: "dropdown" | "radio" } = {}): FormQuestion =>
    question(key, "single_choice", label, o, { options: options.map((l) => ({ value: slugValue(l), label: l })), display: o.display ?? "radio" }),
};

export interface FormSpec {
  key: string;
  name: string;
  kind?: FormKind;
  purpose: FormPurpose;
  folder: FolderAsset;
  title: string;
  intro: string;
  submitLabel: string;
  questions: FormQuestion[];
  /** The words next to the required consent box. They must name each channel they cover (email, text message, WhatsApp). */
  consent: string;
  /** A separate, optional marketing opt-in, with its own wording that names its channel. */
  marketing?: string;
  tags: TagAsset[];
  deal?: { pipeline: PipelineAsset; stage: string; name: string; valueQuestion?: string };
  notify?: NotifyRole[];
  /** Also tell the contact's owner about each submission (default yes). */
  notifyContactOwner?: boolean;
  thanks: string;
}

export function form(spec: FormSpec): FormAsset {
  if (spec.folder.kind !== "form") throw new Error(`Form ${spec.key} must be filed in a form folder.`);
  return {
    id: `form.${spec.key}`, key: spec.key, name: spec.name, kind: spec.kind ?? "form", purpose: spec.purpose, folder: ref(spec.folder), placeholder: false,
    draft: {
      questions: spec.questions,
      consent: { text: spec.consent, marketing: { enabled: Boolean(spec.marketing), text: spec.marketing ?? "" } },
      actions: {
        tagIds: spec.tags.map(ref),
        opportunity: spec.deal
          ? { pipelineId: ref(spec.deal.pipeline), stageId: stageRef(spec.deal.pipeline, spec.deal.stage), name: spec.deal.name, valueQuestion: spec.deal.valueQuestion ?? null }
          : null,
        assignmentRuleId: null,
        notify: { roles: spec.notify ?? ["owner", "admin"], contactOwner: spec.notifyContactOwner ?? true },
        after: { kind: "message", message: spec.thanks },
      },
      settings: { title: spec.title, intro: spec.intro, submitLabel: spec.submitLabel },
    },
  };
}

// ---------------------------------------------------------------------------
// Message templates (drafts: the workspace approves wording and connects senders)
// ---------------------------------------------------------------------------

type Purpose = "service" | "marketing";

const template = (key: string, name: string, channel: MessageTemplateAsset["channel"], purpose: Purpose, inFolder: FolderAsset, subject: string | null, body: string, category: string | null, kind: MessageTemplateAsset["kind"] = "template", whatsapp: MessageTemplateAsset["whatsapp"] = null): MessageTemplateAsset => {
  if (inFolder.kind !== "template") throw new Error(`Template ${key} must be filed in a template folder.`);
  return { id: `template.${key}`, kind, key, name, channel, purpose, category, folder: ref(inFolder), subject, body, whatsapp, placeholder: false };
};

export const msg = {
  email: (key: string, name: string, purpose: Purpose, inFolder: FolderAsset, subject: string, body: string, category: string | null = null) =>
    template(key, name, "email", purpose, inFolder, subject, body, category),
  /** SMS bodies stay in the plain SMS alphabet (no curly quotes, dashes or emoji) so each segment holds 160 characters. */
  sms: (key: string, name: string, purpose: Purpose, inFolder: FolderAsset, body: string, category: string | null = null) =>
    template(key, name, "sms", purpose, inFolder, null, body, category),
  /** A WhatsApp template, with the name and category the workspace submits to Meta for its own account. */
  whatsapp: (key: string, name: string, purpose: Purpose, inFolder: FolderAsset, body: string, category: string | null = null) =>
    template(key, name, "whatsapp", purpose, inFolder, null, body, category, "template", { name: key, language: "en", category: purpose === "marketing" ? "marketing" : "utility" }),
  /** A canned reply the team inserts into a conversation on any channel. */
  canned: (key: string, name: string, inFolder: FolderAsset, body: string, category: string | null = null) =>
    template(key, name, null, "service", inFolder, null, body, category, "canned_reply"),
};

/** The sentence every marketing email ends with: the unsubscribe link itself is added under every marketing email when it is sent. */
export const EMAIL_UNSUBSCRIBE = "You can unsubscribe at any time with the link at the bottom of this email.";
/** The sentence every marketing text ends with. */
export const SMS_STOP = "Reply STOP to opt out.";

// ---------------------------------------------------------------------------
// Workflow drafts (the native WorkflowDefinition)
// ---------------------------------------------------------------------------

type Trigger = BlueprintWorkflowDefinition["trigger"];
export type Step = BlueprintWorkflowDefinition["steps"][number];
type Unit = "minutes" | "hours" | "days";

export const when = {
  /** A tag is added to a contact (a form adds it, or someone in the team). */
  tagAdded: (tags: TagAsset[], reentry: Trigger["reentry"] = "once"): Trigger => ({ type: "contact.tag_added", filters: { tagIds: tags.map(ref) }, reentry }),
  appointment: (type: "appointment.booked" | "appointment.no_show" | "appointment.showed" | "appointment.cancelled", calendars: CalendarAsset[]): Trigger =>
    ({ type, filters: { calendarIds: calendars.map(ref) } }),
  formSubmitted: (forms: FormAsset[]): Trigger => ({ type: "form.submitted", filters: { formIds: forms.map(ref) } }),
  stageReached: (p: PipelineAsset, ...segments: string[]): Trigger => ({ type: "opportunity.stage_changed", filters: { pipelineId: ref(p), stageIds: segments.map((s) => stageRef(p, s)) } }),
  dealWon: (p: PipelineAsset): Trigger => ({ type: "opportunity.won", filters: { pipelineId: ref(p) } }),
  contactCreated: (via: CreatedVia[]): Trigger => ({ type: "contact.created", filters: { createdVia: via } }),
  fieldChanged: (...fields: CustomFieldAsset[]): Trigger => ({ type: "contact.updated", filters: { changedFields: fields.map(ref) } }),
  /** Someone in the team starts it for a contact. Every marketing message in a starter is sent this way, never on an event. */
  manual: (): Trigger => ({ type: "manual" }),
};

export interface TaskOptions {
  description?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  due?: [number, Unit];
  /** The contact's owner (default), a team member slot, or nobody yet. */
  assignee?: "contact_owner" | "none" | SlotAsset;
  linkOpportunity?: boolean;
}

export const step = {
  /** Sends one of the starter's own templates on that template's channel. */
  send: (key: string, t: MessageTemplateAsset, next: string | null, sendAs: AgentRoleKey = "sales_assistant"): Step => {
    if (!t.channel) throw new Error(`${t.id} has no channel, so a workflow can't send it.`);
    return { key, kind: "send_message", config: { templateId: ref(t), channel: t.channel, sendAs, businessHoursOnly: true }, next };
  },
  review: (key: string, t: MessageTemplateAsset, next: string | null = null): Step => {
    if (!t.channel || !t.body.includes("{{review.link}}")) throw new Error(`${t.id} can't be used for review requests.`);
    return { key, kind: "request_review", config: { templateId: ref(t), channel: t.channel, businessHoursOnly: true }, next };
  },
  wait: (key: string, amount: number, unit: Unit, next: string | null): Step => ({ key, kind: "wait", config: { mode: "duration", amount, unit }, next }),
  /** Waits until a while before the appointment that started the run (carries on at once when that time has passed). */
  beforeAppointment: (key: string, amount: number, unit: Unit, next: string | null): Step =>
    ({ key, kind: "wait", config: { mode: "until_date", source: "appointment_start", offset: { amount, unit, direction: "before" }, ifMissing: "end" }, next }),
  /** Waits until a while before (or after) the date in a contact date field; ends the run when the contact has no date. */
  untilField: (key: string, f: CustomFieldAsset, amount: number, unit: Unit, direction: "before" | "after", next: string | null): Step =>
    ({ key, kind: "wait", config: { mode: "until_date", source: "contact_field", fieldId: ref(f), offset: { amount, unit, direction }, ifMissing: "end" }, next }),
  task: (key: string, title: string, o: TaskOptions, next: string | null): Step => {
    const a = o.assignee ?? "contact_owner";
    const config: Record<string, unknown> = {
      title, priority: o.priority ?? "normal", assignee: typeof a === "string" ? a : "user",
      ...(typeof a === "string" ? {} : { userId: ref(a) }),
      ...(o.description ? { description: o.description } : {}),
      ...(o.due ? { dueIn: { amount: o.due[0], unit: o.due[1] } } : {}),
      ...(o.linkOpportunity ? { linkOpportunity: true } : {}),
    };
    return { key, kind: "create_task", config, next };
  },
  notify: (key: string, title: string, o: { body?: string; roles?: Array<"owner" | "admin">; people?: SlotAsset[] }, next: string | null): Step => ({
    key, kind: "notify_team", next,
    config: { roles: o.roles ?? ["owner", "admin"], ...(o.people?.length ? { userIds: o.people.map(ref) } : {}), title, ...(o.body ? { body: o.body } : {}) },
  }),
  /** Continues down "yes" when the contact hasn't sent a message since the run started. */
  ifNoReply: (key: string, yes: string | null, no: string | null): Step =>
    ({ key, kind: "branch", config: { subject: "contact", filter: { op: "and", conditions: [] }, reply: "not_replied" }, branches: { yes, no } }),
  ifContact: (key: string, filter: FilterGroup, yes: string | null, no: string | null): Step =>
    ({ key, kind: "branch", config: { subject: "contact", filter, reply: null }, branches: { yes, no } }),
  addTag: (key: string, tags: TagAsset[], next: string | null): Step => ({ key, kind: "add_tag", config: { tagIds: tags.map(ref) }, next }),
  removeTag: (key: string, tags: TagAsset[], next: string | null): Step => ({ key, kind: "remove_tag", config: { tagIds: tags.map(ref) }, next }),
  leadStatus: (key: string, status: "new" | "open" | "contacted" | "qualified" | "unqualified" | "customer" | "inactive", next: string | null): Step =>
    ({ key, kind: "update_field", config: { subject: "contact", field: "lead_status", value: status }, next }),
  moveStage: (key: string, p: PipelineAsset, segment: string, next: string | null): Step =>
    ({ key, kind: "move_stage", config: { pipelineId: ref(p), stageId: stageRef(p, segment) }, next }),
  note: (key: string, subject: "contact" | "opportunity", body: string, next: string | null): Step => ({ key, kind: "internal_note", config: { subject, body }, next }),
  end: (key = "done"): Step => ({ key, kind: "end", config: {} }),
};

export function workflow(key: string, name: string, description: string, inFolder: FolderAsset, trigger: Trigger, steps: Step[]): WorkflowAsset {
  if (inFolder.kind !== "workflow") throw new Error(`Workflow ${key} must be filed in a workflow folder.`);
  return { id: `workflow.${key}`, key, name, description, folder: ref(inFolder), hourlyRunLimit: 100, definition: { trigger, steps }, placeholder: false };
}

// ---------------------------------------------------------------------------
// Report definitions
// ---------------------------------------------------------------------------

export function report(key: string, name: string, description: string, inFolder: FolderAsset, sections: ReportSection[], filters: BlueprintReportFilters = { range: "30d" }): ReportAsset {
  if (inFolder.kind !== "report") throw new Error(`Report ${key} must be filed in a report folder.`);
  return { id: `report.${key}`, key, name, description, folder: ref(inFolder), config: { filters, sections } };
}

/** A pipeline filter for a report. */
export const forPipeline = (p: PipelineAsset, range: BlueprintReportFilters["range"] = "90d"): BlueprintReportFilters => ({ range, pipeline: ref(p) });
