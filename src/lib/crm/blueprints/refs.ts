// Walking a Blueprint: every asset (nested stages and appointment types included), every place an asset refers to another asset or to a
// mapping slot, the dependency graph between assets, and configuration value tokens in texts. Pure functions shared by validation, the
// manifest, the diff, capture (native → logical) and the apply engine (logical → native).
//
// The walkers below are DIRECTION-AGNOSTIC: a package asset and its native record embed the same JSON shape (a FormDraft, a
// WorkflowDefinition, a filter, a report config) and differ only in the values at reference positions. Each walker visits exactly those
// positions (a RefSite: where, what it may point at, how the native side encodes it), hands the value to a RefMapper, and rebuilds the
// structure with what the mapper returns. The same walker therefore turns logical references into workspace IDs, workspace IDs into logical
// references, or just collects references for checking.
import { isGroup, type FilterCondition, type FilterGroup } from "@/lib/crm/filters";
import type { FormDraft } from "@/lib/crm/forms/spec";
import type { FieldEntity } from "@/lib/crm/types";
import {
  ASSET_SECTIONS, REF_PREFIX, SECTION_TYPE, isRef, refId, typeOfId,
  type AssetSection, type AssetType, type AnyAsset, type BlueprintContent, type BlueprintReportConfig, type BlueprintWorkflowDefinition, type CalendarAsset,
  type PipelineAsset, type RefTarget, type SlotKind,
} from "@/lib/crm/blueprints/types";

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface AssetEntry {
  id: string;
  type: AssetType;
  section: AssetSection;
  name: string;
  /** The pipeline of a stage, the calendar of an appointment type. */
  parentId: string | null;
  asset: AnyAsset;
}

/** Every asset in dependency (section) order, nested ones right after their parent. */
export function listAssets(content: Pick<BlueprintContent, "assets">): AssetEntry[] {
  const out: AssetEntry[] = [];
  for (const section of ASSET_SECTIONS) {
    for (const asset of content.assets[section] as AnyAsset[]) {
      const named = asset as { id: string; name?: string; label?: string; key?: string };
      out.push({ id: named.id, type: SECTION_TYPE[section], section, name: named.name ?? named.label ?? named.key ?? named.id, parentId: null, asset });
      if (section === "pipelines") for (const s of (asset as PipelineAsset).stages) out.push({ id: s.id, type: "stage", section, name: s.name, parentId: named.id, asset: s });
      if (section === "calendars") for (const t of (asset as CalendarAsset).types) out.push({ id: t.id, type: "appointmentType", section, name: t.name, parentId: named.id, asset: t });
    }
  }
  return out;
}

/** Assets by logical ID (the first one wins when an ID is duplicated; validation reports duplicates). */
export function indexAssets(content: Pick<BlueprintContent, "assets">): Map<string, AssetEntry> {
  const map = new Map<string, AssetEntry>();
  for (const e of listAssets(content)) if (!map.has(e.id)) map.set(e.id, e);
  return map;
}

// ---------------------------------------------------------------------------
// Reference sites and mappers
// ---------------------------------------------------------------------------

/**
 * How the native side writes a reference at a position:
 *   id          a bare workspace ID (tagIds, pipelineId, templateId, …)
 *   cf_id       "cf:<field id>" (filter fields, Smart List columns, "update field" steps)
 *   custom_key  "custom:<field key>" (a form question saved to a custom field)
 *   cf_key      "cf:<field key>" (a "contact details changed" trigger's changed fields)
 * The package side always writes "@<logical id>".
 */
export type RefEncoding = "id" | "cf_id" | "custom_key" | "cf_key";
export type RefSide = "package" | "native";

/** What happens at a position whose reference can't be resolved: left out of a list, set to null, the key removed, or an empty string. */
export type MissingRule = "drop" | "null" | "delete" | "empty";

export interface RefSite {
  /** Where, relative to the asset or native record: "draft.actions.tagIds[0]". */
  path: string;
  target: RefTarget;
  encoding: RefEncoding;
  /** Leaving it out makes the native definition incomplete (it can be saved as a draft but not published as is). */
  required: boolean;
  missing: MissingRule;
  /** Custom field references: the record type the field must belong to. */
  entity?: FieldEntity;
  /** Stage references tied to one pipeline: the pipeline reference next to it, written as the same side writes it (null: none given). */
  pipeline?: string | null;
}

/** Translates one reference value. Returning null means it can't be resolved: it is left out (see MissingRule) and reported. */
export type RefMapper = (value: string, site: RefSite) => string | null;

export interface RefFinding {
  site: RefSite;
  /** The value as found. */
  value: string;
}

export interface RefMapResult<T> {
  value: T;
  /** Every reference the mapper could not resolve, with where it was. */
  unresolved: RefFinding[];
}

/** Whether a value at a position is a reference on that side. ID positions always are; field positions only when they are encoded as one. */
function isRefAt(value: unknown, site: Pick<RefSite, "encoding">, side: RefSide): value is string {
  if (typeof value !== "string" || !value) return false;
  if (side === "package") return site.encoding === "id" ? true : value.startsWith(REF_PREFIX);
  switch (site.encoding) {
    case "id":
      return true;
    case "cf_id":
    case "cf_key":
      return value.startsWith("cf:");
    case "custom_key":
      return value.startsWith("custom:");
  }
}

/** One walk: the side being read, the mapper, and where unresolved references are collected. */
class Walk {
  readonly unresolved: RefFinding[] = [];
  constructor(readonly side: RefSide, readonly fn: RefMapper) {}

  map(value: string, site: RefSite): string | null {
    const out = this.fn(value, site);
    if (out === null) this.unresolved.push({ site, value });
    return out;
  }

  /** A single reference on `obj[key]`; applies the site's missing rule. */
  one(obj: Record<string, unknown>, key: string, site: Omit<RefSite, "missing"> & { missing?: MissingRule }): void {
    const v = obj[key];
    if (!isRefAt(v, site, this.side)) return;
    const full: RefSite = { missing: "delete", ...site };
    const out = this.map(v, full);
    if (out !== null) obj[key] = out;
    else if (full.missing === "null") obj[key] = null;
    else if (full.missing === "empty") obj[key] = "";
    else delete obj[key];
  }

  /** A list of references on `obj[key]` (or a single string where a list is also accepted); unresolved entries are left out. */
  list(obj: Record<string, unknown>, key: string, site: Omit<RefSite, "missing" | "path"> & { path: string }, opts: { allowString?: boolean; refsOnly?: boolean } = {}): void {
    const v = obj[key];
    if (typeof v === "string" && opts.allowString) {
      if (!isRefAt(v, site, this.side)) return;
      const out = this.map(v, { ...site, missing: "delete" });
      if (out !== null) obj[key] = out;
      else delete obj[key];
      return;
    }
    if (!Array.isArray(v)) return;
    const next: unknown[] = [];
    v.forEach((item, i) => {
      if (!isRefAt(item, site, this.side)) {
        // Mixed lists (changed fields, columns) keep their built-in entries; ID lists keep nothing that isn't a string.
        if (opts.refsOnly && typeof item === "string") next.push(item);
        else if (!opts.refsOnly && typeof item !== "string") next.push(item);
        return;
      }
      const out = this.map(item, { ...site, path: `${site.path}[${i}]`, missing: "drop" });
      if (out !== null) next.push(out);
    });
    obj[key] = next;
  }
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

// ---------------------------------------------------------------------------
// Filters (Smart Lists, assignment rule conditions, workflow trigger filters and branches)
// ---------------------------------------------------------------------------

/** Which record type a filter is about: contacts and companies use the Smart List catalog, deals the workflow deal-condition catalog. */
export type FilterSubject = "contact" | "company" | "opportunity";

/** What a condition's value refers to, for a built-in field and operator, or null when the value is plain data. */
export function filterValueTarget(subject: FilterSubject, field: string, op: string): RefTarget | null {
  if (field === "tags") return "tag";
  if (field === "owner") return op === "is_any_of" ? "member" : null;
  if (subject === "contact") {
    if (field === "opportunity") return op === "in_stage" ? "stage" : op === "in_pipeline" ? "pipeline" : null;
    if (field === "company") return op === "is_any_of" ? "record" : null;
  }
  if (subject === "opportunity") {
    if (field === "pipeline") return "pipeline";
    if (field === "stage") return "stage";
  }
  return null;
}

function walkCondition(c: FilterCondition, subject: FilterSubject, w: Walk, path: string): FilterCondition {
  const out = { ...c } as FilterCondition & Record<string, unknown>;
  const fieldSite = { path: `${path}.field`, target: "customField" as const, encoding: "cf_id" as const, required: true, entity: (subject === "company" ? "company" : subject === "opportunity" ? "opportunity" : "contact") as FieldEntity };
  const fieldIsRef = isRefAt(c.field, fieldSite, w.side);
  w.one(out, "field", fieldSite);
  if (!fieldIsRef) {
    const target = filterValueTarget(subject, c.field, c.op);
    if (target) w.list(out, "value", { path: `${path}.value`, target, encoding: "id", required: true }, { allowString: true });
  }
  return out;
}

function walkFilter(g: FilterGroup, subject: FilterSubject, w: Walk, path: string): FilterGroup {
  const out = { ...g } as FilterGroup;
  out.conditions = (g.conditions ?? []).map((c, i) => (isGroup(c) ? walkFilter(c, subject, w, `${path}.conditions[${i}]`) : walkCondition(c, subject, w, `${path}.conditions[${i}]`)));
  return out;
}

/** Maps every reference in a filter. The filter is copied; other keys next to it (an assignment rule's reassignOwned) are kept. */
export function mapFilterRefs(filter: FilterGroup, subject: FilterSubject, side: RefSide, fn: RefMapper, path = "filter"): RefMapResult<FilterGroup> {
  const w = new Walk(side, fn);
  const value = walkFilter(clone(filter), subject, w, path);
  return { value, unresolved: w.unresolved };
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function walkFormDraft(d: FormDraft, w: Walk, path: string): FormDraft {
  const out = clone(d);
  (out.questions ?? []).forEach((q, i) => {
    w.one(q as unknown as Record<string, unknown>, "map", { path: `${path}.questions[${i}].map`, target: "customField", encoding: "custom_key", required: false, missing: "null", entity: "contact" });
  });
  const a = rec(out.actions);
  if (a) {
    w.list(a, "tagIds", { path: `${path}.actions.tagIds`, target: "tag", encoding: "id", required: false });
    const o = rec(a.opportunity);
    if (o) {
      const pipeline = typeof o.pipelineId === "string" ? o.pipelineId : null;
      w.one(o, "pipelineId", { path: `${path}.actions.opportunity.pipelineId`, target: "pipeline", encoding: "id", required: true, missing: "empty" });
      w.one(o, "stageId", { path: `${path}.actions.opportunity.stageId`, target: "stage", encoding: "id", required: true, missing: "empty", pipeline });
    }
    w.one(a, "assignmentRuleId", { path: `${path}.actions.assignmentRuleId`, target: "assignmentRule", encoding: "id", required: false, missing: "null" });
  }
  return out;
}

/** Maps every reference in a form draft (questions saved to custom fields, tags, the deal's pipeline and stage, the assignment rule). */
export function mapFormDraftRefs(draft: FormDraft, side: RefSide, fn: RefMapper, path = "draft"): RefMapResult<FormDraft> {
  const w = new Walk(side, fn);
  return { value: walkFormDraft(draft, w, path), unresolved: w.unresolved };
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type AnyDefinition = { trigger: Record<string, unknown>; steps: Array<Record<string, unknown>> };

function walkWorkflow(def: AnyDefinition, w: Walk, path: string): AnyDefinition {
  const out = clone(def);
  const t = rec(out.trigger) ?? {};
  const f = rec(t.filters);
  if (f) {
    const fp = `${path}.trigger.filters`;
    const pipeline = typeof f.pipelineId === "string" ? f.pipelineId : null;
    w.list(f, "tagIds", { path: `${fp}.tagIds`, target: "tag", encoding: "id", required: true });
    w.one(f, "pipelineId", { path: `${fp}.pipelineId`, target: "pipeline", encoding: "id", required: true });
    w.list(f, "stageIds", { path: `${fp}.stageIds`, target: "stage", encoding: "id", required: true, pipeline });
    w.list(f, "fromStageIds", { path: `${fp}.fromStageIds`, target: "stage", encoding: "id", required: true, pipeline });
    w.list(f, "calendarIds", { path: `${fp}.calendarIds`, target: "calendar", encoding: "id", required: true });
    w.list(f, "appointmentTypeIds", { path: `${fp}.appointmentTypeIds`, target: "appointmentType", encoding: "id", required: true });
    w.list(f, "assigneeIds", { path: `${fp}.assigneeIds`, target: "member", encoding: "id", required: true });
    w.list(f, "formIds", { path: `${fp}.formIds`, target: "form", encoding: "id", required: true });
    w.list(f, "changedFields", { path: `${fp}.changedFields`, target: "customField", encoding: "cf_key", required: true, entity: "contact" }, { refsOnly: true });
  }
  if (rec(t.contactFilter)) t.contactFilter = walkFilter(t.contactFilter as unknown as FilterGroup, "contact", w, `${path}.trigger.contactFilter`);
  (out.steps ?? []).forEach((s, i) => {
    const c = rec(s.config);
    if (!c) return;
    const sp = `${path}.steps[${i}].config`;
    switch (s.kind) {
      case "wait":
        if (c.mode === "until_date") {
          const entity: FieldEntity = c.source === "opportunity_field" ? "opportunity" : "contact";
          w.one(c, "fieldId", { path: `${sp}.fieldId`, target: "customField", encoding: "id", required: true, entity });
        }
        break;
      case "branch":
        if (rec(c.filter)) c.filter = walkFilter(c.filter as unknown as FilterGroup, c.subject === "opportunity" ? "opportunity" : "contact", w, `${sp}.filter`);
        break;
      case "add_tag":
      case "remove_tag":
        w.list(c, "tagIds", { path: `${sp}.tagIds`, target: "tag", encoding: "id", required: true });
        break;
      case "assign":
        w.one(c, "userId", { path: `${sp}.userId`, target: "member", encoding: "id", required: c.to === "user" });
        w.one(c, "ruleId", { path: `${sp}.ruleId`, target: "assignmentRule", encoding: "id", required: c.to === "rule" });
        break;
      case "create_task":
        w.one(c, "userId", { path: `${sp}.userId`, target: "member", encoding: "id", required: c.assignee === "user" });
        break;
      case "update_field":
        w.one(c, "field", { path: `${sp}.field`, target: "customField", encoding: "cf_id", required: true, entity: c.subject === "opportunity" ? "opportunity" : "contact" });
        break;
      case "create_opportunity":
      case "move_stage": {
        const pipeline = typeof c.pipelineId === "string" ? c.pipelineId : null;
        w.one(c, "pipelineId", { path: `${sp}.pipelineId`, target: "pipeline", encoding: "id", required: true });
        w.one(c, "stageId", { path: `${sp}.stageId`, target: "stage", encoding: "id", required: true, pipeline });
        break;
      }
      case "send_message":
      case "request_review":
        w.one(c, "templateId", { path: `${sp}.templateId`, target: "messageTemplate", encoding: "id", required: true });
        break;
      case "notify_team":
        w.list(c, "userIds", { path: `${sp}.userIds`, target: "member", encoding: "id", required: false });
        break;
      case "conversation_action":
        w.one(c, "userId", { path: `${sp}.userId`, target: "member", encoding: "id", required: c.action === "assign_person" });
        break;
      case "n8n":
        w.one(c, "mappingId", { path: `${sp}.mappingId`, target: "n8n", encoding: "id", required: true });
        break;
      case "webhook":
        w.one(c, "subscriptionId", { path: `${sp}.subscriptionId`, target: "webhook", encoding: "id", required: true });
        break;
    }
  });
  return out;
}

/**
 * Maps every reference in a workflow definition: trigger filters (tags, pipeline, stages, calendars, appointment types, assignees, forms,
 * changed custom fields), the contact filter, and each step's config (fields, filters, tags, people, rules, pipelines, stages, templates,
 * n8n mappings, webhook endpoints). Works on a package definition or a native one.
 */
export function mapWorkflowRefs<T extends BlueprintWorkflowDefinition | { trigger: object; steps: object[] }>(def: T, side: RefSide, fn: RefMapper, path = "definition"): RefMapResult<T> {
  const w = new Walk(side, fn);
  return { value: walkWorkflow(def as unknown as AnyDefinition, w, path) as unknown as T, unresolved: w.unresolved };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Maps a saved report's member and pipeline filters. A native campaign filter is a customer record: it never resolves to a package reference. */
export function mapReportConfigRefs<T extends BlueprintReportConfig | { filters: object; sections: unknown[] }>(config: T, side: RefSide, fn: RefMapper, path = "config"): RefMapResult<T> {
  const w = new Walk(side, fn);
  const out = clone(config) as unknown as { filters: Record<string, unknown> };
  const f = rec(out.filters);
  if (f) {
    w.one(f, "member", { path: `${path}.filters.member`, target: "member", encoding: "id", required: false });
    w.one(f, "pipeline", { path: `${path}.filters.pipeline`, target: "pipeline", encoding: "id", required: false });
    if (side === "native") w.one(f, "campaign", { path: `${path}.filters.campaign`, target: "record", encoding: "id", required: false });
  }
  return { value: out as unknown as T, unresolved: w.unresolved };
}

/** Maps Smart List columns: custom field columns are "@field.…" in a package and "cf:<field id>" natively; built-in columns stay. */
export function mapColumnRefs(columns: string[], entity: FieldEntity, side: RefSide, fn: RefMapper, path = "columns"): RefMapResult<string[]> {
  const w = new Walk(side, fn);
  const holder: Record<string, unknown> = { columns: [...columns] };
  w.list(holder, "columns", { path, target: "customField", encoding: "cf_id", required: false, entity }, { refsOnly: true });
  return { value: holder.columns as string[], unresolved: w.unresolved };
}

// ---------------------------------------------------------------------------
// Every reference of one package asset
// ---------------------------------------------------------------------------

const collect = (into: RefFinding[]): RefMapper => (value, site) => {
  into.push({ site, value });
  return value;
};

function topLevel(into: RefFinding[], obj: Record<string, unknown>, key: string, site: Omit<RefSite, "missing" | "path">) {
  const v = obj[key];
  if (typeof v === "string" && v) into.push({ site: { ...site, path: key, missing: "null" }, value: v });
}

/**
 * Every reference a package asset makes (not counting its nested children, which are entries of their own), with where it is. Covers the
 * asset's own columns (folder, hosts, members) and everything embedded (filters, drafts, definitions, report configs).
 */
export function assetRefs(entry: Pick<AssetEntry, "type" | "asset">): RefFinding[] {
  const out: RefFinding[] = [];
  const a = entry.asset as unknown as Record<string, unknown>;
  const fn = collect(out);
  if (entry.type !== "folder") topLevel(out, a, "folder", { target: "folder", encoding: "id", required: false });
  switch (entry.type) {
    case "calendar":
      ((a.hosts as string[]) ?? []).forEach((h, i) => out.push({ site: { path: `hosts[${i}]`, target: "member", encoding: "id", required: false, missing: "drop" }, value: h }));
      break;
    case "smartList": {
      const entity = a.entity as FieldEntity;
      mapFilterRefs(a.filter as FilterGroup, entity, "package", fn, "filter");
      mapColumnRefs((a.columns as string[]) ?? [], entity, "package", fn, "columns");
      break;
    }
    case "assignmentRule":
      mapFilterRefs(a.conditions as FilterGroup, "contact", "package", fn, "conditions");
      topLevel(out, a, "fallbackMember", { target: "member", encoding: "id", required: a.fallback === "fallback_user" });
      ((a.members as Array<{ member: string }>) ?? []).forEach((m, i) => out.push({ site: { path: `members[${i}].member`, target: "member", encoding: "id", required: false, missing: "drop" }, value: m.member }));
      break;
    case "form":
      mapFormDraftRefs(a.draft as FormDraft, "package", fn, "draft");
      break;
    case "workflow":
      mapWorkflowRefs(a.definition as BlueprintWorkflowDefinition, "package", fn, "definition");
      break;
    case "report":
      mapReportConfigRefs(a.config as BlueprintReportConfig, "package", fn, "config");
      break;
  }
  return out;
}

/**
 * Normalizes a reference path for documentation and tests: indexes become [], nested filter groups "**", and a filter condition's single
 * value counts as a one-item list (the filter language accepts both).
 */
export function sitePattern(path: string): string {
  return path.replace(/\[\d+\]/g, "[]").replace(/(\.conditions\[\])+/g, ".**").replace(/\.value$/, ".value[]");
}

/**
 * Every place each asset type can hold a reference, as sitePattern() writes it, and what it points at. Documentation for agencies and
 * engineers, and the contract the walkers are tested against: a reference found anywhere else is a bug.
 */
export const REFERENCE_FIELDS: Record<AssetType, ReadonlyArray<{ path: string; target: RefTarget; native: string }>> = {
  folder: [],
  tag: [{ path: "folder", target: "folder", native: "crm_tags.folder_id" }],
  customField: [],
  customValue: [],
  pipeline: [],
  stage: [],
  calendar: [
    { path: "folder", target: "folder", native: "crm_calendars.folder_id" },
    { path: "hosts[]", target: "member", native: "crm_calendar_members.user_id" },
  ],
  appointmentType: [],
  smartList: [
    { path: "folder", target: "folder", native: "crm_smart_lists.folder_id" },
    { path: "filter.**.field", target: "customField", native: "filter condition field \"cf:<field id>\"" },
    { path: "filter.**.value[]", target: "tag", native: "tags condition values (tag ids)" },
    { path: "filter.**.value[]", target: "member", native: "owner \"is any of\" values (user ids)" },
    { path: "filter.**.value[]", target: "stage", native: "opportunity \"in stage\" / deal stage values (stage ids)" },
    { path: "filter.**.value[]", target: "pipeline", native: "opportunity \"in pipeline\" / deal pipeline values (pipeline ids)" },
    { path: "filter.**.value[]", target: "record", native: "company \"is any of\" values (company ids): never portable" },
    { path: "columns[]", target: "customField", native: "crm_smart_lists.columns \"cf:<field id>\"" },
  ],
  assignmentRule: [
    { path: "conditions.**.field", target: "customField", native: "crm_assignment_rules.conditions \"cf:<field id>\"" },
    { path: "conditions.**.value[]", target: "tag", native: "tags condition values" },
    { path: "conditions.**.value[]", target: "member", native: "owner values" },
    { path: "conditions.**.value[]", target: "stage", native: "opportunity \"in stage\" values" },
    { path: "conditions.**.value[]", target: "pipeline", native: "opportunity \"in pipeline\" values" },
    { path: "fallbackMember", target: "member", native: "crm_assignment_rules.fallback_user_id" },
    { path: "members[].member", target: "member", native: "crm_assignment_members.user_id" },
  ],
  form: [
    { path: "folder", target: "folder", native: "crm_forms.folder_id" },
    { path: "draft.questions[].map", target: "customField", native: "question map \"custom:<field key>\"" },
    { path: "draft.actions.tagIds[]", target: "tag", native: "actions.tagIds" },
    { path: "draft.actions.opportunity.pipelineId", target: "pipeline", native: "actions.opportunity.pipelineId" },
    { path: "draft.actions.opportunity.stageId", target: "stage", native: "actions.opportunity.stageId" },
    { path: "draft.actions.assignmentRuleId", target: "assignmentRule", native: "actions.assignmentRuleId" },
  ],
  messageTemplate: [{ path: "folder", target: "folder", native: "crm_message_templates.folder_id" }],
  workflow: [
    { path: "folder", target: "folder", native: "crm_workflows.folder_id" },
    { path: "definition.trigger.filters.tagIds[]", target: "tag", native: "trigger filters.tagIds" },
    { path: "definition.trigger.filters.pipelineId", target: "pipeline", native: "trigger filters.pipelineId" },
    { path: "definition.trigger.filters.stageIds[]", target: "stage", native: "trigger filters.stageIds" },
    { path: "definition.trigger.filters.fromStageIds[]", target: "stage", native: "trigger filters.fromStageIds" },
    { path: "definition.trigger.filters.calendarIds[]", target: "calendar", native: "trigger filters.calendarIds" },
    { path: "definition.trigger.filters.appointmentTypeIds[]", target: "appointmentType", native: "trigger filters.appointmentTypeIds" },
    { path: "definition.trigger.filters.assigneeIds[]", target: "member", native: "trigger filters.assigneeIds" },
    { path: "definition.trigger.filters.formIds[]", target: "form", native: "trigger filters.formIds" },
    { path: "definition.trigger.filters.changedFields[]", target: "customField", native: "trigger filters.changedFields \"cf:<field key>\"" },
    { path: "definition.trigger.contactFilter.**.field", target: "customField", native: "contact filter \"cf:<field id>\"" },
    { path: "definition.trigger.contactFilter.**.value[]", target: "tag", native: "contact filter tag values" },
    { path: "definition.trigger.contactFilter.**.value[]", target: "member", native: "contact filter owner values" },
    { path: "definition.trigger.contactFilter.**.value[]", target: "stage", native: "contact filter stage values" },
    { path: "definition.trigger.contactFilter.**.value[]", target: "pipeline", native: "contact filter pipeline values" },
    { path: "definition.steps[].config.fieldId", target: "customField", native: "wait until a date field" },
    { path: "definition.steps[].config.filter.**.field", target: "customField", native: "if / else condition \"cf:<field id>\"" },
    { path: "definition.steps[].config.filter.**.value[]", target: "tag", native: "if / else tag values" },
    { path: "definition.steps[].config.filter.**.value[]", target: "member", native: "if / else owner values" },
    { path: "definition.steps[].config.filter.**.value[]", target: "stage", native: "if / else stage values" },
    { path: "definition.steps[].config.filter.**.value[]", target: "pipeline", native: "if / else pipeline values" },
    { path: "definition.steps[].config.tagIds[]", target: "tag", native: "add / remove tag" },
    { path: "definition.steps[].config.userId", target: "member", native: "assign owner / create task assignee" },
    { path: "definition.steps[].config.ruleId", target: "assignmentRule", native: "assign by rule" },
    { path: "definition.steps[].config.field", target: "customField", native: "update field \"cf:<field id>\"" },
    { path: "definition.steps[].config.pipelineId", target: "pipeline", native: "create deal / move stage" },
    { path: "definition.steps[].config.stageId", target: "stage", native: "create deal / move stage" },
    { path: "definition.steps[].config.templateId", target: "messageTemplate", native: "send message / request review" },
    { path: "definition.steps[].config.userIds[]", target: "member", native: "notify team people" },
    { path: "definition.steps[].config.mappingId", target: "n8n", native: "n8n mapping" },
    { path: "definition.steps[].config.subscriptionId", target: "webhook", native: "outbound webhook subscription" },
  ],
  report: [
    { path: "folder", target: "folder", native: "crm_report_definitions.folder_id" },
    { path: "config.filters.member", target: "member", native: "config.filters.member" },
    { path: "config.filters.pipeline", target: "pipeline", native: "config.filters.pipeline" },
  ],
};

// ---------------------------------------------------------------------------
// Configuration value tokens
// ---------------------------------------------------------------------------

const VALUE_TOKEN = /\{\{\s*custom_values\.([a-z][a-z0-9_]{0,47})\s*\}\}/g;

/** The configuration value keys texts use ({{custom_values.<key>}}), in order of first appearance. */
export function valueTokenKeys(...texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(VALUE_TOKEN)) seen.add(m[1]);
  return [...seen];
}

/** Rewrites {{custom_values.<key>}} tokens. `map` returns the new key, or null to keep the token exactly as written. */
export function rewriteValueTokens(text: string, map: (key: string) => string | null): string {
  return text.replace(VALUE_TOKEN, (whole, key: string) => {
    const next = map(key);
    return next && next !== key ? `{{custom_values.${next}}}` : whole;
  });
}

/** The texts of a workflow definition that may hold tokens: task titles and descriptions, notifications, notes and deal names. */
const WORKFLOW_TEXT_KEYS: Record<string, string[]> = {
  create_task: ["title", "description"],
  notify_team: ["title", "body"],
  internal_note: ["body"],
  create_opportunity: ["name"],
};

export function workflowTexts(def: { steps: Array<{ kind: string; config: Record<string, unknown> }> }): string[] {
  const out: string[] = [];
  for (const s of def.steps ?? []) for (const k of WORKFLOW_TEXT_KEYS[s.kind] ?? []) if (typeof s.config?.[k] === "string") out.push(s.config[k] as string);
  return out;
}

/** A copy of a workflow definition with its texts' value tokens rewritten. */
export function rewriteWorkflowTokens<T extends { steps: Array<{ kind: string; config: Record<string, unknown> }> }>(def: T, map: (key: string) => string | null): T {
  const out = clone(def);
  for (const s of out.steps ?? []) for (const k of WORKFLOW_TEXT_KEYS[s.kind] ?? []) if (typeof s.config?.[k] === "string") s.config[k] = rewriteValueTokens(s.config[k] as string, map);
  return out;
}

/** Every text of an asset that may hold configuration value tokens. */
export function assetTexts(entry: Pick<AssetEntry, "type" | "asset">): string[] {
  const a = entry.asset as unknown as Record<string, unknown>;
  if (entry.type === "messageTemplate") return [a.subject as string | null, a.body as string].filter((x): x is string => typeof x === "string");
  if (entry.type === "workflow") return workflowTexts(a.definition as { steps: Array<{ kind: string; config: Record<string, unknown> }> });
  return [];
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** The asset IDs one asset depends on: its parent, the assets it references, and configuration values its texts use (by key). */
export function assetDependencies(entry: AssetEntry, content: Pick<BlueprintContent, "assets">): string[] {
  const deps = new Set<string>();
  if (entry.parentId) deps.add(entry.parentId);
  for (const r of assetRefs(entry)) {
    if (!isRef(r.value)) continue;
    const t = typeOfId(r.value);
    if (t && !isSlotPrefix(t)) deps.add(refId(r.value));
  }
  const values = new Map(content.assets.customValues.map((v) => [v.key, v.id]));
  for (const k of valueTokenKeys(...assetTexts(entry))) {
    const id = values.get(k);
    if (id) deps.add(id);
  }
  deps.delete(entry.id);
  return [...deps].sort();
}

const isSlotPrefix = (t: string): t is SlotKind => t === "member" || t === "n8n" || t === "webhook";

/** For each asset with dependencies, the asset IDs it depends on (sorted). */
export function dependencyGraph(content: Pick<BlueprintContent, "assets">): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  for (const e of listAssets(content)) {
    const deps = assetDependencies(e, content);
    if (deps.length) graph[e.id] = deps;
  }
  return graph;
}

/** For each declared slot, the assets that use it (sorted). Undeclared slots that are used are listed too, so validation can report them. */
export function slotUsage(content: Pick<BlueprintContent, "assets" | "slots">): Record<string, string[]> {
  const use: Record<string, Set<string>> = {};
  for (const s of content.slots ?? []) use[s.id] = new Set();
  for (const e of listAssets(content)) {
    for (const r of assetRefs(e)) {
      if (!isRef(r.value)) continue;
      const t = typeOfId(r.value);
      if (t && isSlotPrefix(t)) (use[refId(r.value)] ??= new Set()).add(e.id);
    }
  }
  return Object.fromEntries(Object.entries(use).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, [...v].sort()]));
}

/** Everything `ids` depend on, transitively, including the ids themselves and the nested children of any pipeline or calendar included. */
export function withDependencies(content: Pick<BlueprintContent, "assets">, ids: Iterable<string>): Set<string> {
  const graph = dependencyGraph(content);
  const children = new Map<string, string[]>();
  for (const e of listAssets(content)) if (e.parentId) children.set(e.parentId, [...(children.get(e.parentId) ?? []), e.id]);
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const d of graph[id] ?? []) stack.push(d);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

/** The assets that depend on `id`, directly or through others (what a removal or a blocked asset affects). */
export function dependents(content: Pick<BlueprintContent, "assets">, id: string): string[] {
  const graph = dependencyGraph(content);
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const [k, deps] of Object.entries(graph)) if (deps.includes(cur) && !out.has(k)) {
      out.add(k);
      stack.push(k);
    }
  }
  return [...out].sort();
}

/**
 * Assets ordered so every dependency comes first (stable: section order otherwise). Returns the IDs on a cycle when there is one; package
 * sections are ordered so a valid package never has one.
 */
export function topologicalOrder(content: Pick<BlueprintContent, "assets">): { order: AssetEntry[]; cycle: string[] | null } {
  const entries = listAssets(content);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const graph = dependencyGraph(content);
  const state = new Map<string, 1 | 2>();
  const order: AssetEntry[] = [];
  let cycle: string[] | null = null;
  const visit = (id: string, path: string[]) => {
    if (cycle) return;
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) {
      cycle = path.slice(path.indexOf(id));
      return;
    }
    state.set(id, 1);
    for (const d of graph[id] ?? []) if (byId.has(d)) visit(d, [...path, d]);
    state.set(id, 2);
    const e = byId.get(id);
    if (e) order.push(e);
  };
  for (const e of entries) visit(e.id, [e.id]);
  return { order, cycle };
}
