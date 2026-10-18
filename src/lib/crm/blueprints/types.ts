// iAcquire CRM Blueprints: reusable CRM configuration packages. The shared vocabulary for the server and the interface. No I/O here.
//
// A Blueprint holds configuration only: folders, tags, custom fields, configuration values, pipelines and stages, calendars and appointment
// types, Smart Lists, lead assignment rules, forms, message templates, draft workflows and report definitions. It never holds contacts,
// companies, deals, messages, conversations, appointments, credentials, provider tokens, payment details, AI memories or anything personal.
//
// Every asset embeds TODAY'S native format (the FormDraft of src/lib/crm/forms/spec.ts, the WorkflowDefinition of src/lib/crm/workflow/spec.ts,
// the crm_message_templates + version shape, the crm_report_definitions report + config, the crm_custom_values row …) with one change: every
// place that holds a record ID in a workspace holds a REFERENCE instead: "@" followed by a stable logical ID ("@tag.hot-lead",
// "@stage.sales.won", "@field.contact.budget"). A package therefore means the same thing in every workspace and every iAcquire environment,
// and applying it resolves each reference back to the target workspace's own record (src/lib/crm/blueprints/native.ts).
//
// People never travel. Wherever a native definition names a person (calendar hosts, owners in filters, task assignees, "notify" recipients,
// assignment rule members, a report's team member filter) the package names a MAPPING SLOT ("@member.closer") that each workspace maps to one
// of its own people. Workspace connections that carry secrets (an n8n mapping, an outbound webhook subscription) are slots too
// ("@n8n.lead-sync", "@webhook.crm-export"). An unmapped slot is a setup requirement, never a guess.

import type { CrmCapability, FieldEntity, FieldType } from "@/lib/crm/types";
import type { FilterGroup } from "@/lib/crm/filters";
import type { FormDraft, FormKind, FormPurpose } from "@/lib/crm/forms/spec";
import type { InboundWebhookConfig, TriggerConfig, WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import type { ReportConfig, ReportFilters } from "@/components/crm/reports/spec";

/** The package format identifier. A file without it is not an iAcquire Blueprint (a GoHighLevel snapshot link or export is not one). */
export const BLUEPRINT_FORMAT = "iacquire.crm-blueprint" as const;
/** The package format this build reads and writes. Older packages are upgraded by src/lib/crm/blueprints/migrate.ts. */
export const BLUEPRINT_SCHEMA_VERSION = 1 as const;
/** Largest package accepted (import, save, publish), in bytes of UTF-8 JSON. Also the default body limit of a Next.js server action. */
export const BLUEPRINT_MAX_BYTES = 1_000_000;
/** Largest single asset, in bytes of canonical JSON (the native draft columns allow 128 KB). */
export const BLUEPRINT_MAX_ASSET_BYTES = 131_072;
/** Written into exported packages so a support person can tell which build produced a file. */
export const BLUEPRINT_GENERATOR = "iAcquire CRM Blueprints";

// ---------------------------------------------------------------------------
// Industries and library vocabulary
// ---------------------------------------------------------------------------

export const BLUEPRINT_INDUSTRIES = [
  "real_estate", "restaurants", "home_services", "consulting", "healthcare_wellness", "automotive", "beauty_salons",
  "professional_services", "education_coaching", "general_services", "other",
] as const;
export type BlueprintIndustry = (typeof BLUEPRINT_INDUSTRIES)[number];
export const BLUEPRINT_INDUSTRY_LABELS: Record<BlueprintIndustry, string> = {
  real_estate: "Real Estate",
  restaurants: "Restaurants",
  home_services: "Home Services",
  consulting: "Consulting",
  healthcare_wellness: "Healthcare & Wellness",
  automotive: "Automotive Services",
  beauty_salons: "Beauty & Salons",
  professional_services: "Professional Services",
  education_coaching: "Education & Coaching",
  general_services: "General Service Businesses",
  other: "Other",
};

export const BLUEPRINT_STATUSES = ["draft", "published", "archived"] as const;
export type BlueprintStatus = (typeof BLUEPRINT_STATUSES)[number];

/** Where a Blueprint came from. Shown on every card so nobody mistakes an imported configuration for a native one. */
/** crm_blueprints.source_kind. A Blueprint captured from a client's workspace is "native" with that client as its source_org_id. */
export const BLUEPRINT_SOURCES = ["native", "starter", "ghl_import", "file_import"] as const;
export type BlueprintSource = (typeof BLUEPRINT_SOURCES)[number];
export const BLUEPRINT_SOURCE_LABELS: Record<BlueprintSource, string> = {
  native: "Native",
  starter: "iAcquire starter",
  ghl_import: "Imported from GoHighLevel",
  file_import: "Imported package",
};

// ---------------------------------------------------------------------------
// Asset sections, asset types and logical IDs
// ---------------------------------------------------------------------------

/**
 * Package sections, in dependency order: anything an asset refers to lives in the same or an earlier section, so applying sections in this
 * order always finds what a reference needs.
 */
export const ASSET_SECTIONS = [
  "folders", "tags", "customFields", "customValues", "pipelines", "calendars", "smartLists", "assignmentRules", "forms", "messageTemplates", "workflows", "reports",
] as const;
export type AssetSection = (typeof ASSET_SECTIONS)[number];

export const SECTION_LABELS: Record<AssetSection, string> = {
  folders: "Folders",
  tags: "Tags",
  customFields: "Custom fields",
  customValues: "Configuration values",
  pipelines: "Pipelines & stages",
  calendars: "Calendars & appointment types",
  smartLists: "Smart Lists",
  assignmentRules: "Lead assignment rules",
  forms: "Forms & surveys",
  messageTemplates: "Message templates",
  workflows: "Workflow drafts",
  reports: "Report definitions",
};

/** Asset types, including the nested ones (stages live in their pipeline, appointment types in their calendar). */
export const ASSET_TYPES = [
  "folder", "tag", "customField", "customValue", "pipeline", "stage", "calendar", "appointmentType", "smartList", "assignmentRule", "form",
  "messageTemplate", "workflow", "report",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  folder: "folder",
  tag: "tag",
  customField: "custom field",
  customValue: "configuration value",
  pipeline: "pipeline",
  stage: "stage",
  calendar: "calendar",
  appointmentType: "appointment type",
  smartList: "Smart List",
  assignmentRule: "assignment rule",
  form: "form",
  messageTemplate: "message template",
  workflow: "workflow",
  report: "report",
};

/** The top-level type each section holds. */
export const SECTION_TYPE: Record<AssetSection, AssetType> = {
  folders: "folder",
  tags: "tag",
  customFields: "customField",
  customValues: "customValue",
  pipelines: "pipeline",
  calendars: "calendar",
  smartLists: "smartList",
  assignmentRules: "assignmentRule",
  forms: "form",
  messageTemplates: "messageTemplate",
  workflows: "workflow",
  reports: "report",
};

/** The section an asset type lives in (nested types live in their parent's section). */
export const TYPE_SECTION: Record<AssetType, AssetSection> = {
  folder: "folders",
  tag: "tags",
  customField: "customFields",
  customValue: "customValues",
  pipeline: "pipelines",
  stage: "pipelines",
  calendar: "calendars",
  appointmentType: "calendars",
  smartList: "smartLists",
  assignmentRule: "assignmentRules",
  form: "forms",
  messageTemplate: "messageTemplates",
  workflow: "workflows",
  report: "reports",
};

/**
 * Which CRM capability owns a section. In a hybrid workspace a section whose capability GoHighLevel owns is blocked (never written twice).
 * Null: the section belongs to no capability (folders and configuration values are iAcquire-only settings).
 */
export const SECTION_CAPABILITY: Record<AssetSection, CrmCapability | null> = {
  folders: null,
  tags: "tags",
  customFields: "custom_fields",
  customValues: null,
  pipelines: "pipelines",
  calendars: "calendars",
  smartLists: "contacts",
  assignmentRules: "contacts",
  forms: "contacts",
  messageTemplates: "conversations",
  workflows: "workflows",
  reports: "reporting",
};

/** Mapping slots: what a workspace maps to its own people and connections. They are never assets and never carry an ID. */
export const SLOT_KINDS = ["member", "n8n", "webhook"] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];
export const SLOT_KIND_LABELS: Record<SlotKind, { label: string; description: string }> = {
  member: { label: "Team member", description: "A person in the client's workspace: a calendar host, an owner, a task assignee, someone to notify." },
  n8n: { label: "n8n automation", description: "An n8n workflow the agency verified and mapped to this client." },
  webhook: { label: "Webhook endpoint", description: "One of the client's own outbound webhook endpoints (each has its own signing secret)." },
};

/**
 * What a reference can point at: an asset, a mapping slot, or (only ever found while capturing a workspace) a customer record such as a
 * specific company or campaign, which can never travel in a Blueprint.
 */
export type RefTarget = AssetType | SlotKind | "record";

/** Every logical ID starts with its type's prefix, so a reference can be type-checked without looking it up. */
export const ID_PREFIX: Record<AssetType | SlotKind, string> = {
  folder: "folder",
  tag: "tag",
  customField: "field",
  customValue: "value",
  pipeline: "pipeline",
  stage: "stage",
  calendar: "calendar",
  appointmentType: "apptype",
  smartList: "list",
  assignmentRule: "rule",
  form: "form",
  messageTemplate: "template",
  workflow: "workflow",
  report: "report",
  member: "member",
  n8n: "n8n",
  webhook: "webhook",
};

/**
 * How each type's logical ID is formed (native.ts → suggestLogicalId builds them for captured records). Any ID with the right prefix is
 * valid; these are the conventions, chosen so an ID reads as what it is and stays the same in every workspace and every version.
 */
export const LOGICAL_ID_SCHEMES: Record<AssetType | SlotKind, string> = {
  folder: "folder.<kind>.<name>",
  tag: "tag.<name>",
  customField: "field.<record type>.<key>",
  customValue: "value.<key>",
  pipeline: "pipeline.<name>",
  stage: "stage.<pipeline>.<name>",
  calendar: "calendar.<name>",
  appointmentType: "apptype.<calendar>.<name>",
  smartList: "list.<name>",
  assignmentRule: "rule.<name>",
  form: "form.<key>",
  messageTemplate: "template.<key>",
  workflow: "workflow.<key>",
  report: "report.<key>",
  member: "member.<role>",
  n8n: "n8n.<automation>",
  webhook: "webhook.<endpoint>",
};

/** One segment of a logical ID: lower-case letters, digits, "_" and "-" inside, 1 to 48 characters. */
export const ID_SEGMENT = "[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?";
/** The longest logical ID. */
export const LOGICAL_ID_MAX = 96;
/**
 * "tag.hot-lead", "stage.sales.won", "field.contact.budget", "member.closer": a prefix and one to three segments, at most 96 characters
 * (checked separately with LOGICAL_ID_MAX). Asset IDs are written bare; a reference is the same ID with REF_PREFIX in front.
 */
export const LOGICAL_ID = new RegExp(
  `^(${Object.values(ID_PREFIX).join("|")})(\\.${ID_SEGMENT}){1,3}$`,
);
/** Marks a reference: "@tag.vip". Inside embedded native JSON this is the only way a string names another asset or a slot. */
export const REF_PREFIX = "@";

export const isLogicalId = (v: unknown): v is string => typeof v === "string" && v.length <= LOGICAL_ID_MAX && LOGICAL_ID.test(v);
/** Whether a string is a well-formed reference ("@" + logical ID). */
export const isRef = (v: unknown): boolean => typeof v === "string" && v.startsWith(REF_PREFIX) && isLogicalId(v.slice(1));
/** "@tag.vip" → "tag.vip". */
export const refId = (ref: string): string => (ref.startsWith(REF_PREFIX) ? ref.slice(1) : ref);
/** "tag.vip" → "@tag.vip". */
export const toRef = (id: string): string => `${REF_PREFIX}${refId(id)}`;

/** The asset type or slot kind a logical ID (or reference) names, from its prefix. */
export function typeOfId(idOrRef: string): AssetType | SlotKind | null {
  const prefix = refId(idOrRef).split(".")[0];
  const found = (Object.entries(ID_PREFIX) as Array<[AssetType | SlotKind, string]>).find(([, p]) => p === prefix);
  return found ? found[0] : null;
}

export const isSlotKind = (v: unknown): v is SlotKind => typeof v === "string" && (SLOT_KINDS as readonly string[]).includes(v);
export const isAssetType = (v: unknown): v is AssetType => typeof v === "string" && (ASSET_TYPES as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Folders, tags, fields, values
// ---------------------------------------------------------------------------

/** crm_folders kinds a Blueprint can carry (campaign folders hold campaigns, which are never configuration). */
export const BLUEPRINT_FOLDER_KINDS = ["smart_list", "tag", "template", "workflow", "form", "calendar", "report"] as const;
export type BlueprintFolderKind = (typeof BLUEPRINT_FOLDER_KINDS)[number];
/** The folder kind an asset type's `folder` reference must point at. */
export const FOLDER_KIND_FOR: Partial<Record<AssetType, BlueprintFolderKind>> = {
  tag: "tag", smartList: "smart_list", messageTemplate: "template", workflow: "workflow", form: "form", calendar: "calendar", report: "report",
};

/** A crm_folders row. Folders only organize; they never change who can see a record. */
export interface FolderAsset {
  id: string;
  kind: BlueprintFolderKind;
  name: string;
}

/** A crm_tags row. */
export interface TagAsset {
  id: string;
  name: string;
  /** Lower-case #rrggbb. */
  color: string;
  description: string | null;
  /** "@folder.…" of kind "tag", or null. */
  folder: string | null;
}

export interface FieldOption {
  value: string;
  label: string;
}

/** A crm_custom_fields row. Its identity in a workspace is (entity, key), including archived fields (which are restored, not duplicated). */
export interface CustomFieldAsset {
  id: string;
  entity: FieldEntity;
  /** `^[a-z][a-z0-9_]{0,47}$`. Forms and "changed fields" triggers name a field by this key. */
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  required: boolean;
  helpText: string | null;
  groupName: string | null;
}

export const CUSTOM_VALUE_TYPES = ["text", "url", "phone", "email", "number", "color"] as const;
export type CustomValueType = (typeof CUSTOM_VALUE_TYPES)[number];

/**
 * A crm_custom_values row: a workspace configuration value used in texts as {{custom_values.<key>}}. Never a secret. Texts in a package keep
 * the package's own key in their tokens; applying rewrites a token only when the workspace's value has another key (a "copy" decision).
 */
export interface CustomValueAsset {
  id: string;
  key: string;
  label: string;
  type: CustomValueType;
  /** An example or default. Empty when each business fills in its own. */
  value: string;
  /** The business must fill this in before texts that use it are sent. */
  required: boolean;
  groupName: string | null;
}

// ---------------------------------------------------------------------------
// Pipelines and stages
// ---------------------------------------------------------------------------

export type StageKind = "open" | "won" | "lost";

/** A crm_pipeline_stages row. Its order in `stages` is its position. */
export interface StageAsset {
  id: string;
  name: string;
  kind: StageKind;
  probability: number | null;
  color: string | null;
}

/** A native crm_pipelines row and its stages. */
export interface PipelineAsset {
  id: string;
  name: string;
  description: string | null;
  /** Become the workspace's default pipeline when it has none (never replaces the client's own default). */
  isDefault: boolean;
  stages: StageAsset[];
}

// ---------------------------------------------------------------------------
// Calendars and appointment types
// ---------------------------------------------------------------------------

/** One weekly working window, exactly as crm_calendars.hours_template and crm_availability_rules store it. */
export interface WeeklyHours {
  /** 0 = Sunday. */
  weekday: number;
  /** Minutes after midnight in the calendar's time zone (0 to 1439). */
  startMinute: number;
  /** 1 to 1440, after startMinute. */
  endMinute: number;
}

/** A booking question as crm_appointment_types.questions stores it. */
export interface BookingQuestion {
  key: string;
  label: string;
  type: "text" | "textarea" | "select";
  required: boolean;
  options?: string[];
}

export type LocationKind = "phone" | "video" | "in_person" | "custom" | "none";
export type MeetingProvider = "none" | "google_meet" | "microsoft_teams" | "custom_link";

/** A crm_appointment_types row (every column a workspace configures; slug and position are the workspace's own). */
export interface AppointmentTypeAsset {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  slotIntervalMinutes: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  dailyLimit: number | null;
  capacity: number;
  locationKind: LocationKind;
  locationDetail: string | null;
  meetingProvider: MeetingProvider;
  /** A fixed https:// link. Null with meetingProvider "custom_link" leaves a "meeting link" setup requirement. */
  meetingLink: string | null;
  requiresConfirmation: boolean;
  /** Shown on the calendar's booking page once the calendar is verified and public. */
  public: boolean;
  questions: BookingQuestion[];
  color: string | null;
  confirmationMessage: string | null;
  allowCustomerChanges: boolean;
  changeCutoffMinutes: number;
  requireEmail: boolean;
  requirePhone: boolean;
}

/**
 * A crm_calendars row and its appointment types. Hosts are people, so the package names host slots ("@member.…"), and the weekly hours are
 * the template hosts start from. A calendar from a Blueprint is created as a draft: it takes no bookings until its hosts, hours, time zone,
 * provider connections and booking behaviour are verified in that workspace (see REQUIREMENT_KEYS).
 */
export interface CalendarAsset {
  id: string;
  name: string;
  description: string | null;
  assignment: "single" | "round_robin" | "collective";
  roundRobinMode: "balanced" | "priority";
  color: string | null;
  /** "@folder.…" of kind "calendar", or null. */
  folder: string | null;
  bookingIntro: string | null;
  /** IANA time zone for `hours`. Null: the workspace's own time zone. */
  timezone: string | null;
  hours: WeeklyHours[];
  /** "@member.…" slots for the hosts. Empty: the workspace picks its hosts during setup. */
  hosts: string[];
  types: AppointmentTypeAsset[];
}

// ---------------------------------------------------------------------------
// Smart Lists and assignment rules (filters with references)
// ---------------------------------------------------------------------------

/**
 * A Smart List filter in the CRM's own filter language (src/lib/crm/filters.ts), with references in place of IDs: a custom-field condition
 * names "@field.contact.budget" as its field (natively "cf:<id>"), tag values are "@tag.…", "in stage" / "in pipeline" values "@stage.…" /
 * "@pipeline.…", owner values "@member.…". A condition on specific companies can never travel.
 */
export type BlueprintFilter = FilterGroup;

export type SmartListEntity = "contact" | "company" | "opportunity";

/** A crm_smart_lists row. Blueprint Smart Lists are always shared with the team; the workspace's first owner owns them. */
export interface SmartListAsset {
  id: string;
  entity: SmartListEntity;
  name: string;
  description: string | null;
  /** "@folder.…" of kind "smart_list", or null. */
  folder: string | null;
  filter: BlueprintFilter;
  /** Built-in column keys, or "@field.…" (natively "cf:<id>"). */
  columns: string[];
  sort: { by?: string; dir?: "asc" | "desc" };
  /** Become the default list for its record type when the workspace has none. */
  isDefault: boolean;
}

export const ASSIGNMENT_STRATEGIES = ["round_robin", "weighted", "priority", "keep_existing_owner"] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];

/**
 * A crm_assignment_rules row and its members. Members are people, so they are "@member.…" slots. A rule from a Blueprint arrives switched
 * on only when every member (and the fallback person, if any) is mapped when it is applied and it has someone to assign to, or when it only
 * keeps existing owners; otherwise switched off (requirement "assignment_members"). Conditions are a contact filter (a deal rule checks the
 * deal's contact).
 */
export interface AssignmentRuleAsset {
  id: string;
  name: string;
  entity: "contact" | "opportunity";
  conditions: BlueprintFilter;
  /** Kept next to the filter in crm_assignment_rules.conditions natively ({ op, conditions, reassignOwned }). */
  reassignOwned: boolean;
  strategy: AssignmentStrategy;
  respectWorkingHours: boolean;
  fallback: "unassigned" | "fallback_user";
  /** "@member.…" when fallback is "fallback_user". */
  fallbackMember: string | null;
  members: Array<{ member: string; weight: number; priority: number }>;
}

// ---------------------------------------------------------------------------
// Forms, message templates, workflows, reports (embedded native formats)
// ---------------------------------------------------------------------------

/**
 * A native FormDraft (src/lib/crm/forms/spec.ts) with references: actions.tagIds holds "@tag.…", actions.opportunity.pipelineId / stageId
 * "@pipeline.…" / "@stage.…", actions.assignmentRuleId "@rule.…", and a question saved to a custom field maps to "@field.contact.…"
 * (natively "custom:<key>"). Everything else is exactly the native draft.
 */
export type BlueprintFormDraft = FormDraft;

/** A crm_forms row (its working draft). A form from a Blueprint arrives as a draft; publishing it is the workspace's own step. */
export interface FormAsset {
  id: string;
  /** crm_forms.key: `^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$`, the hosted page's address. */
  key: string;
  name: string;
  kind: FormKind;
  purpose: FormPurpose;
  /** "@folder.…" of kind "form", or null. */
  folder: string | null;
  draft: BlueprintFormDraft;
  /** Only the name is known (for example a GoHighLevel form, whose questions the API does not expose). It must be rebuilt before use. */
  placeholder: boolean;
}

export const TEMPLATE_KINDS = ["template", "canned_reply"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export const MESSAGE_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/**
 * A crm_message_templates row with its current version's wording (crm_message_template_versions.subject / body). It always arrives as a
 * draft: the workspace's own owner approves wording for automated use. The link to a Meta-approved WhatsApp template
 * (whatsapp_template_id) is the workspace's own; the package carries the name, language and category to submit for approval.
 */
export interface MessageTemplateAsset {
  id: string;
  kind: TemplateKind;
  /** `^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$`, unique among templates and canned replies. */
  key: string;
  name: string;
  /** Null only for a canned reply that works on any channel. */
  channel: MessageChannel | null;
  purpose: "service" | "marketing";
  category: string | null;
  /** "@folder.…" of kind "template", or null. */
  folder: string | null;
  subject: string | null;
  body: string;
  whatsapp: { name: string; language: string; category: "utility" | "marketing" | "authentication" } | null;
  placeholder: boolean;
}

/**
 * A native WorkflowDefinition (src/lib/crm/workflow/spec.ts) with references in every ID slot (see REFERENCE_FIELDS in refs.ts), and without
 * the two values that belong to one workspace: the inbound webhook nonce (a new one is generated on apply) and a send step's content hash
 * (bound on apply to the workspace's own template wording).
 */
export interface BlueprintWorkflowDefinition {
  trigger: Omit<TriggerConfig, "inbound"> & { inbound?: Omit<InboundWebhookConfig, "nonce"> };
  steps: Array<Omit<WorkflowStep, "config"> & { config: Record<string, unknown> }>;
}

/**
 * A crm_workflows row (its working draft). Workflows from a Blueprint always arrive as drafts: nothing runs and nothing is sent until the
 * workspace connects its providers, maps its slots, and its owner approves the exact version.
 */
export interface WorkflowAsset {
  id: string;
  /** `^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$`. */
  key: string;
  name: string;
  description: string | null;
  /** "@folder.…" of kind "workflow", or null. */
  folder: string | null;
  hourlyRunLimit: number;
  definition: BlueprintWorkflowDefinition;
  /** Only the name is known (a GoHighLevel workflow, whose steps the API does not expose). It must be rebuilt before use. */
  placeholder: boolean;
}

/** A saved report's filters with references: member "@member.…", pipeline "@pipeline.…". A campaign filter never travels. */
export type BlueprintReportFilters = Omit<ReportFilters, "campaign">;
export interface BlueprintReportConfig {
  filters: BlueprintReportFilters;
  sections: ReportConfig["sections"];
}

/** A crm_report_definitions row (report = the built-in report its sections make, config = its filters and sections). Shared with the team. */
export interface ReportAsset {
  id: string;
  /** `^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$`. */
  key: string;
  name: string;
  description: string | null;
  /** "@folder.…" of kind "report", or null. */
  folder: string | null;
  config: BlueprintReportConfig;
}

/** A mapping slot declared by the package: what each workspace maps to one of its own people or connections. */
export interface SlotAsset {
  /** "member.closer", "n8n.lead-sync", "webhook.crm-export". */
  id: string;
  label: string;
  description: string | null;
}

export interface BlueprintAssets {
  folders: FolderAsset[];
  tags: TagAsset[];
  customFields: CustomFieldAsset[];
  customValues: CustomValueAsset[];
  pipelines: PipelineAsset[];
  calendars: CalendarAsset[];
  smartLists: SmartListAsset[];
  assignmentRules: AssignmentRuleAsset[];
  forms: FormAsset[];
  messageTemplates: MessageTemplateAsset[];
  workflows: WorkflowAsset[];
  reports: ReportAsset[];
}

/** The asset shape of each type. */
export interface AssetTypeMap {
  folder: FolderAsset;
  tag: TagAsset;
  customField: CustomFieldAsset;
  customValue: CustomValueAsset;
  pipeline: PipelineAsset;
  stage: StageAsset;
  calendar: CalendarAsset;
  appointmentType: AppointmentTypeAsset;
  smartList: SmartListAsset;
  assignmentRule: AssignmentRuleAsset;
  form: FormAsset;
  messageTemplate: MessageTemplateAsset;
  workflow: WorkflowAsset;
  report: ReportAsset;
}
export type AnyAsset = AssetTypeMap[AssetType];

export interface BlueprintMeta {
  /** Library key, `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`. */
  key: string;
  name: string;
  description: string;
  industry: BlueprintIndustry;
}

export interface BlueprintSettings {
  /** ISO 4217 currency for new deals. Null keeps the workspace's own. */
  defaultCurrency: string | null;
}

/** What a package is made of. This is what is stored, versioned, digested and applied. */
export interface BlueprintContent {
  format: typeof BLUEPRINT_FORMAT;
  schemaVersion: typeof BLUEPRINT_SCHEMA_VERSION;
  blueprint: BlueprintMeta;
  settings: BlueprintSettings;
  slots: SlotAsset[];
  assets: BlueprintAssets;
}

/** Computed from the content and checked on import (src/lib/crm/blueprints/requirements.ts → computeManifest). */
export interface BlueprintManifest {
  counts: Record<AssetSection, number>;
  /** Every logical ID in the package (assets, nested assets and slots), sorted. */
  assetIds: string[];
  /** For each asset with dependencies, the asset IDs it depends on (sorted). Slots are listed under `slotUse`. */
  dependencies: Record<string, string[]>;
  /** For each declared slot, the asset IDs that use it (sorted). */
  slotUse: Record<string, string[]>;
  requirements: RequirementKey[];
}

/** An exported package: the content plus a manifest and an integrity digest (sha256 over canonical JSON of the content). */
export interface BlueprintPackageFile extends BlueprintContent {
  manifest: BlueprintManifest;
  integrity: { algorithm: "sha256"; digest: string };
  exportedAt: string;
  generator: string;
}

export const EMPTY_ASSETS = (): BlueprintAssets => ({
  folders: [], tags: [], customFields: [], customValues: [], pipelines: [], calendars: [], smartLists: [], assignmentRules: [], forms: [], messageTemplates: [],
  workflows: [], reports: [],
});

export function emptyBlueprint(meta: BlueprintMeta): BlueprintContent {
  return { format: BLUEPRINT_FORMAT, schemaVersion: BLUEPRINT_SCHEMA_VERSION, blueprint: meta, settings: { defaultCurrency: null }, slots: [], assets: EMPTY_ASSETS() };
}

// ---------------------------------------------------------------------------
// Native records: the workspace side of each asset (what the apply engine writes and the capture engine reads)
// ---------------------------------------------------------------------------
//
// Each shape lists exactly the columns (camelCased) a Blueprint asset controls, with workspace IDs in every reference slot. The apply engine
// maps them onto INSERT/UPDATE statements; the capture engine builds them from rows. Columns a workspace owns itself (status, slugs,
// positions, approvals, owners, published versions, archived_at) are not part of them.

export interface NativeFolder { kind: BlueprintFolderKind; name: string }
export interface NativeTag { name: string; color: string; description: string | null; folderId: string | null }
export interface NativeCustomField {
  entity: FieldEntity; key: string; label: string; type: FieldType; options: FieldOption[]; required: boolean; helpText: string | null; groupName: string | null;
}
export interface NativeCustomValue { key: string; label: string; type: CustomValueType; value: string; required: boolean; groupName: string | null }
/** A crm_pipelines row with provider 'native'. */
export interface NativePipeline { name: string; description: string | null; isDefault: boolean }
/** A crm_pipeline_stages row. Its position is its index among the pipeline's stages. */
export interface NativeStage { pipelineId: string; name: string; kind: StageKind; probability: number | null; color: string | null }
/**
 * A crm_calendars row. `folderId`, `timezone` and `hoursTemplate` are the columns migration 0035 adds (folder_id, timezone, hours_template);
 * the calendar itself is inserted with status 'draft', public false, is_default false and origin 'blueprint'. `hostIds` become
 * crm_calendar_members rows (people: never part of the customization fingerprint).
 */
export interface NativeCalendar {
  name: string; description: string | null; assignment: CalendarAsset["assignment"]; roundRobinMode: CalendarAsset["roundRobinMode"]; color: string | null;
  folderId: string | null; bookingIntro: string | null; timezone: string | null; hoursTemplate: WeeklyHours[]; hostIds: string[];
}
/** A crm_appointment_types row. */
export interface NativeAppointmentType extends Omit<AppointmentTypeAsset, "id"> { calendarId: string }
/** A crm_smart_lists row (visibility 'team'). */
export interface NativeSmartList {
  entity: SmartListEntity; name: string; description: string | null; folderId: string | null; filter: FilterGroup; columns: string[];
  sort: { by?: string; dir?: "asc" | "desc" }; isDefault: boolean;
}
/** A crm_assignment_rules row and its crm_assignment_members rows. */
export interface NativeAssignmentRule {
  name: string; entity: "contact" | "opportunity"; conditions: FilterGroup & { reassignOwned?: boolean }; strategy: AssignmentStrategy; respectWorkingHours: boolean;
  fallback: "unassigned" | "fallback_user"; fallbackUserId: string | null; members: Array<{ userId: string; weight: number; priority: number }>;
}
/** A crm_forms row (its draft column). */
export interface NativeForm { key: string; name: string; kind: FormKind; purpose: FormPurpose; folderId: string | null; draft: FormDraft }
/** A crm_message_templates row and its current crm_message_template_versions row. */
export interface NativeMessageTemplate {
  kind: TemplateKind; key: string; name: string; channel: MessageChannel | null; purpose: "service" | "marketing"; category: string | null; folderId: string | null;
  subject: string | null; body: string; whatsapp: MessageTemplateAsset["whatsapp"];
}
/** A crm_workflows row (its draft column). */
export interface NativeWorkflow { key: string; name: string; description: string | null; folderId: string | null; hourlyRunLimit: number; draft: WorkflowDefinition }
/** A crm_report_definitions row (visibility 'team'). `report` is reportKind(config.sections). */
export interface NativeReport { key: string; name: string; description: string | null; folderId: string | null; report: string; config: ReportConfig }

export interface NativeTypeMap {
  folder: NativeFolder;
  tag: NativeTag;
  customField: NativeCustomField;
  customValue: NativeCustomValue;
  pipeline: NativePipeline;
  stage: NativeStage;
  calendar: NativeCalendar;
  appointmentType: NativeAppointmentType;
  smartList: NativeSmartList;
  assignmentRule: NativeAssignmentRule;
  form: NativeForm;
  messageTemplate: NativeMessageTemplate;
  workflow: NativeWorkflow;
  report: NativeReport;
}
export type AnyNativeRecord = NativeTypeMap[AssetType];

// ---------------------------------------------------------------------------
// Setup requirements: what a workspace must connect, map, fill in, rebuild or approve after a Blueprint is applied.
// A requirement is never satisfied by applying a Blueprint; it is satisfied by evidence in that workspace.
// ---------------------------------------------------------------------------

export const REQUIREMENT_KEYS = [
  "calendar_hosts", "calendar_verification", "google_calendar", "microsoft_calendar", "meeting_link",
  "email_provider", "sms_provider", "whatsapp_provider", "whatsapp_template_approval", "template_approval",
  "member_mapping", "assignment_members", "n8n_mapping", "webhook_endpoints", "ai_employee", "hermes", "voice_provider", "review_links", "payment_provider",
  "custom_values", "form_rebuild", "template_rebuild", "workflow_rebuild", "form_publishing", "workflow_activation", "website_import",
] as const;
export type RequirementKey = (typeof REQUIREMENT_KEYS)[number];

export type RequirementKind = "connect" | "map" | "fill" | "rebuild" | "approve" | "verify";

export interface RequirementInfo {
  label: string;
  description: string;
  kind: RequirementKind;
  /** Where in the client's CRM it is done, relative to the CRM base ("/calendars"). Null: an agency task. */
  path: string | null;
  /** Who usually does it. */
  owner: "client" | "agency" | "either";
}

export const REQUIREMENT_INFO: Record<RequirementKey, RequirementInfo> = {
  calendar_hosts: { label: "Assign calendar hosts", description: "Choose who takes each calendar's appointments. Blueprints never carry people.", kind: "map", path: "/calendars", owner: "either" },
  calendar_verification: { label: "Verify and activate calendars", description: "Check hosts, working hours, time zone, connected calendars and booking behaviour, then activate. Draft calendars take no bookings.", kind: "verify", path: "/calendars", owner: "either" },
  google_calendar: { label: "Connect Google Calendar", description: "An appointment type uses Google Meet. Each host connects their own Google account.", kind: "connect", path: "/calendar-connections", owner: "client" },
  microsoft_calendar: { label: "Connect Microsoft 365", description: "An appointment type uses Microsoft Teams. Each host connects their own Microsoft account.", kind: "connect", path: "/calendar-connections", owner: "client" },
  meeting_link: { label: "Add meeting links", description: "An appointment type uses a fixed video link that this business must provide.", kind: "fill", path: "/calendars", owner: "client" },
  email_provider: { label: "Connect an email sender", description: "Email templates need a verified sending domain before anything can be sent.", kind: "connect", path: "/settings/communications", owner: "either" },
  sms_provider: { label: "Connect an SMS sender", description: "SMS templates need a registered sender number before anything can be sent.", kind: "connect", path: "/settings/communications", owner: "either" },
  whatsapp_provider: { label: "Connect WhatsApp Business", description: "WhatsApp templates need the client's own WhatsApp Business account.", kind: "connect", path: "/settings/communications", owner: "either" },
  whatsapp_template_approval: { label: "Submit WhatsApp templates for approval", description: "Meta must approve each WhatsApp template for the client's own account before it can be used.", kind: "approve", path: "/templates", owner: "either" },
  template_approval: { label: "Approve message wording", description: "Templates arrive as drafts. Someone in the client's workspace approves the wording before any automated message uses it.", kind: "approve", path: "/templates", owner: "client" },
  member_mapping: { label: "Choose the people", description: "Some settings name a role (an owner, an assignee, someone to notify). Map each one to a person in this workspace.", kind: "map", path: null, owner: "either" },
  assignment_members: { label: "Add people to assignment rules", description: "A lead assignment rule arrives switched off unless all its people were mapped when it was applied. Add its people here, then switch it on.", kind: "map", path: "/settings/assignment", owner: "either" },
  n8n_mapping: { label: "Map n8n automations", description: "A workflow step hands off to n8n. The agency verifies and maps an n8n workflow for this client.", kind: "map", path: null, owner: "agency" },
  webhook_endpoints: { label: "Add webhook endpoints", description: "A workflow step sends data to another system. The client adds that endpoint (with its own signing secret).", kind: "connect", path: "/settings/api", owner: "either" },
  ai_employee: { label: "Include the AI employees messages are sent as", description: "Workflow messages go out under an AI employee's name. Each one must be included in this client's workspace. It is only the sender; no AI task runs.", kind: "map", path: "/settings/ai-tools", owner: "agency" },
  hermes: { label: "Connect the AI employees that do tasks", description: "A workflow asks an AI employee to do a task. That AI employee must be included, connected to its AI service and pass its connection check for this client.", kind: "connect", path: "/settings/ai-tools", owner: "agency" },
  voice_provider: { label: "Connect a voice provider", description: "A workflow starts from calls. Call events need a connected voice provider.", kind: "connect", path: "/calls", owner: "either" },
  review_links: { label: "Add review links", description: "A workflow requests reviews. The client adds the public review pages people are sent to.", kind: "fill", path: "/reviews", owner: "client" },
  payment_provider: { label: "Connect a payment provider", description: "Collecting payments needs the client's own payment provider. iAcquire does not take payments on a client's behalf.", kind: "connect", path: null, owner: "client" },
  custom_values: { label: "Fill in configuration values", description: "Some texts use details only this business can provide (an address, opening hours, a booking link).", kind: "fill", path: "/settings/values", owner: "client" },
  form_rebuild: { label: "Rebuild placeholder forms", description: "Only the names of these forms could be brought over. Their questions must be added before use.", kind: "rebuild", path: "/forms", owner: "either" },
  template_rebuild: { label: "Rebuild placeholder templates", description: "Only the names of these templates could be brought over. Their wording must be written before use.", kind: "rebuild", path: "/templates", owner: "either" },
  workflow_rebuild: { label: "Rebuild placeholder workflows", description: "Only the names of these workflows could be brought over. Their steps must be rebuilt before use.", kind: "rebuild", path: "/workflows", owner: "either" },
  form_publishing: { label: "Review and publish forms", description: "Forms arrive as drafts and take no submissions until they are published in this workspace.", kind: "approve", path: "/forms", owner: "client" },
  workflow_activation: { label: "Review workflow drafts", description: "Workflows arrive as drafts and never run on their own. Activation needs connected providers, mapped people and the owner's approval.", kind: "approve", path: "/workflows", owner: "client" },
  website_import: { label: "Rebuild website pages", description: "Website pages are candidates for Website Studio. Nothing is published automatically.", kind: "rebuild", path: null, owner: "agency" },
};

/** One requirement with exactly what it is about: the assets and slots involved, and plain notes. */
export interface RequirementDetail {
  key: RequirementKey;
  assetIds: string[];
  slots: string[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Compatibility report (GoHighLevel import, package import, capture)
// ---------------------------------------------------------------------------

/**
 * ready: fully representable and will be created. converted: saved as a complete native definition. needs_mapping: converted, but something
 * must be chosen per workspace (hosts, people, a value). needs_connection: converted, but it depends on a provider that is not connected.
 * manual_review: only partly converted (for example a name-only placeholder), so a person must finish it. unsupported: cannot be represented
 * natively. failed: could not be read or validated.
 */
export const COMPAT_STATUSES = ["ready", "converted", "needs_mapping", "needs_connection", "manual_review", "unsupported", "failed"] as const;
export type CompatStatus = (typeof COMPAT_STATUSES)[number];
export const COMPAT_LABELS: Record<CompatStatus, string> = {
  ready: "Ready",
  converted: "Converted",
  needs_mapping: "Needs mapping",
  needs_connection: "Needs connection",
  manual_review: "Manual review",
  unsupported: "Unsupported",
  failed: "Failed",
};
export const COMPAT_TONES: Record<CompatStatus, "success" | "primary" | "warning" | "danger" | "neutral" | "violet"> = {
  ready: "primary",
  converted: "success",
  needs_mapping: "warning",
  needs_connection: "violet",
  manual_review: "warning",
  unsupported: "neutral",
  failed: "danger",
};

export interface CompatItem {
  /** What the source called it: a GoHighLevel kind ("calendar", "workflow"), or a package section. */
  sourceKind: string;
  name: string;
  status: CompatStatus;
  /** The logical ID created for it, when it became (part of) an asset. */
  assetId: string | null;
  assetType: AssetType | null;
  /** True when only a name or placeholder was produced. Such items are never "ready" or "converted". */
  placeholder: boolean;
  /** Plain-language notes: what was converted, what was dropped and why. */
  notes: string[];
  requirements: RequirementKey[];
  /** Logical IDs this item needed that are not in the result. */
  missingDependencies: string[];
}

export interface CompatSummary {
  discovered: number;
  fullySupported: number;
  partiallySupported: number;
  unsupported: number;
  failed: number;
  missingDependencies: number;
  conflicts: number;
  needsMapping: number;
  needsConnection: number;
  manualReview: number;
  byStatus: Record<CompatStatus, number>;
}

export interface CompatReport {
  items: CompatItem[];
  summary: CompatSummary;
  /** Source-level notes (for example "Smart Lists cannot be listed through the GoHighLevel API"). */
  limitations: string[];
  /** Kinds that could not be read at all, with the reason (missing scope, error). */
  unavailable: Array<{ sourceKind: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Applying a Blueprint to a workspace
// ---------------------------------------------------------------------------

/**
 * add_missing: create what the workspace lacks and leave everything that already exists untouched.
 * update_compatible: also update existing assets where the change keeps the client's data valid (adding options or stages, new wording on an
 * unchanged draft); anything else is a conflict for a person to decide. Neither strategy ever deletes or silently overwrites a customization.
 */
export const APPLY_STRATEGIES = ["add_missing", "update_compatible"] as const;
export type ApplyStrategy = (typeof APPLY_STRATEGIES)[number];

export const PLAN_ACTIONS = ["create", "update", "link", "unchanged", "skip", "conflict", "blocked"] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];
export const PLAN_ACTION_LABELS: Record<PlanAction, string> = {
  create: "Create",
  update: "Update",
  link: "Already matches",
  unchanged: "Up to date",
  skip: "Skip (keep existing)",
  conflict: "Needs a decision",
  blocked: "Blocked",
};

/** A person's choice for one conflicting asset. copy creates the Blueprint's version alongside the client's own, under a new name or key. */
export const CONFLICT_DECISIONS = ["skip", "update", "copy"] as const;
export type ConflictDecision = (typeof CONFLICT_DECISIONS)[number];

export interface PlanItem {
  assetId: string;
  assetType: AssetType;
  section: AssetSection;
  name: string;
  action: PlanAction;
  /** Why this action: plain language, safe to show the agency and the client. */
  reason: string;
  /** The workspace record this matches, when there is one. */
  existing: { id: string; name: string } | null;
  /** Field-level differences between the workspace record and the Blueprint asset. */
  changes: string[];
  /** For conflicts: the decision applied, when one was given. */
  decision: ConflictDecision | null;
  /**
   * For conflicts, decided or not: whether "update" (use the Blueprint's version) can be taken, replacing the workspace's record in place or
   * adding it again. False where it can't (a field whose type would change with values stored, say: keep it or add a copy) and on every item
   * that isn't a conflict.
   */
  updatable: boolean;
  dependsOn: string[];
  /** References that could not be resolved in this workspace (slots not mapped, dependencies blocked). */
  unresolved: string[];
}

export interface ApplyOptions {
  strategy: ApplyStrategy;
  /** Only these sections. Omitted: every section. */
  sections?: AssetSection[];
  /** Only these assets (and what they depend on). Omitted: every asset in the chosen sections. */
  assetIds?: string[];
  /** Decisions for conflicting assets, by logical ID. */
  decisions?: Record<string, ConflictDecision>;
  /** Slot mappings chosen for this workspace: slot ID → the workspace's user, n8n mapping or webhook subscription ID. */
  slotMappings?: Record<string, string>;
}

export interface ApplicationPlan {
  orgId: string;
  blueprintId: string;
  versionId: string;
  version: number;
  mode: "initial" | "update";
  options: ApplyOptions;
  items: PlanItem[];
  counts: Record<PlanAction, number>;
  requirements: RequirementKey[];
  warnings: string[];
  /** Digest of every planned action (access.ts → planDigest). Confirming checks it again, so a workspace that changed is re-previewed. */
  digest: string;
}

export const APPLICATION_STATUSES = ["applied", "partially_applied", "failed", "rolled_back", "partially_rolled_back"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
