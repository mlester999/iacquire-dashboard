// Lets the CRM's own builders edit a Blueprint. The native form builder, workflow builder and filter builder pick from a workspace's records
// by ID, and the CRM's own checks expect those IDs to be database IDs (UUIDs). Here they pick from the package itself: each asset and role
// gets a stand-in UUID derived from its logical ID (the same one every time, so nothing has to be remembered), the builder works on the
// native shape with those IDs, and every change is turned straight back into the package's references with the contract's own toNative /
// fromNative. The native encodings around custom fields ("cf:<id>", "custom:<key>", "cf:<key>") and the two workspace-only values (an
// inbound webhook nonce, a send step's template binding) are handled the same way. Stand-in IDs never leave the browser. Pure.
import { CONTACT_FILTER_FIELDS, COMPANY_FILTER_FIELDS, OPS_BY_KIND, customFieldOps, isGroup, type FilterGroup } from "@/lib/crm/filters";
import type { FormDraft } from "@/lib/crm/forms/spec";
import type { WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { AGENT_ROLES } from "@/lib/agents";
import { applyMapper, captureMapper, fromNative, toNative, type ApplyResolver, type CaptureResolver, type UnresolvedRef } from "@/lib/crm/blueprints/native";
import { assetRefs, listAssets, mapFilterRefs } from "@/lib/crm/blueprints/refs";
import { refId, toRef, typeOfId, type AnyAsset, type AssetType, type BlueprintContent, type FormAsset, type WorkflowAsset } from "@/lib/crm/blueprints/types";
import type { FormBuilderOptions } from "@/components/crm/forms/types";
import type { EditorOptions } from "@/components/crm/workflows/types";
import type { FilterOptions } from "@/components/crm/filter-builder";
import type { NameSource } from "@/components/crm/workflows/summaries";
import { kindChoices, type KindChoice } from "@/components/crm/workflows/editor-logic";

/** The content hash every send step and template shares while editing: the real binding is made in each workspace when it is applied. */
export const EDITOR_TEMPLATE_HASH = "0".repeat(64);
const EDITOR_NONCE = "blueprint-editor-nonce";

// ---------------------------------------------------------------------------
// Stand-in IDs
// ---------------------------------------------------------------------------

/** 53-bit string hash (cyrb53), seeded. */
function hash53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * The stand-in UUID the builders use for a logical ID: always the same for the same ID, shaped as a version 4 UUID so the CRM's own checks
 * accept it. 106 hashed bits make two IDs of one package sharing a stand-in practically impossible (and the reverse map would notice).
 */
export function standinId(logicalId: string): string {
  const hex = (n: number, len: number) => n.toString(16).padStart(len, "0").slice(-len);
  const a = hex(hash53(logicalId, 1), 14);
  const b = hex(hash53(logicalId, 2), 14);
  const c = hex(hash53(logicalId, 3), 14);
  const variant = "89ab"[parseInt(c[0], 16) % 4];
  return `${a.slice(0, 8)}-${a.slice(8, 12)}-4${b.slice(0, 3)}-${variant}${b.slice(3, 6)}-${b.slice(6, 14)}${c.slice(1, 5)}`;
}

/** The key a field the package doesn't define is named by while editing (a field position that names it by key keeps the reference). */
const missingFieldKey = (id: string) => `missing_${hash53(id, 7).toString(36)}`;

interface Reverse {
  ids: Map<string, string>;
  keys: Map<string, string>;
}

/** Stand-in → logical ID for every asset and role of the package, and every reference the asset being edited makes (dangling ones too). */
function reverseIds(content: BlueprintContent, asset?: { type: AssetType; asset: AnyAsset }): Reverse {
  const ids = new Map<string, string>();
  const keys = new Map<string, string>();
  const add = (id: string) => ids.set(standinId(id), id);
  for (const e of listAssets(content)) add(e.id);
  for (const s of content.slots) add(s.id);
  if (asset) {
    for (const r of assetRefs(asset)) {
      if (!r.value.startsWith("@")) continue;
      add(refId(r.value));
      if (r.site.target === "customField") keys.set(missingFieldKey(refId(r.value)), refId(r.value));
    }
  }
  return { ids, keys };
}

/** Package → builder: every reference becomes its stand-in UUID, in the encoding the native side writes at that position. */
function editorResolver(content: BlueprintContent): ApplyResolver {
  const keys = new Map(content.assets.customFields.map((f) => [f.id, f.key]));
  return {
    nativeId: (id) => standinId(id),
    fieldKey: (id) => keys.get(id) ?? missingFieldKey(id),
    valueKey: () => null,
    templateHash: () => EDITOR_TEMPLATE_HASH,
    newNonce: () => EDITOR_NONCE,
  };
}

/** Builder → package: a stand-in UUID is the reference it stands for; a field named by key is the package's field with that key. */
function packageResolver(content: BlueprintContent, reverse: Reverse): CaptureResolver {
  return {
    logicalId: (_target, nativeId) => reverse.ids.get(nativeId.toLowerCase()) ?? (nativeId.startsWith("@") ? refId(nativeId) : null),
    fieldByKey: (entity, key) => content.assets.customFields.find((f) => f.entity === entity && f.key === key)?.id ?? reverse.keys.get(key) ?? null,
    valueKey: () => null,
  };
}

/** How an option names an asset or role: the builders' stand-in UUID (default), or the reference itself (for readable summaries). */
export type IdStyle = "standin" | "ref";
const idFor = (style: IdStyle) => (id: string) => (style === "standin" ? standinId(id) : toRef(id));

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export interface Bridged<T> {
  value: T;
  /** References that point at nothing in this Blueprint (the builder shows them as missing; they are kept as they are). */
  unresolved: UnresolvedRef[];
}

/** References of an asset that point at nothing in the package, with those the conversion itself couldn't place, each once. */
function danglingOf(content: BlueprintContent, entry: { type: AssetType; asset: AnyAsset }, extra: UnresolvedRef[]): UnresolvedRef[] {
  const known = new Set([...listAssets(content).map((e) => e.id), ...content.slots.map((s) => s.id)]);
  const out = new Map<string, UnresolvedRef>();
  for (const u of extra) out.set(u.path, u);
  for (const r of assetRefs(entry)) {
    if (r.value.startsWith("@") && !known.has(refId(r.value))) out.set(r.site.path, { path: r.site.path, target: r.site.target, value: r.value, required: r.site.required });
  }
  return [...out.values()];
}

/** A package form's draft as the native form builder edits it (stand-in IDs; questions saved to fields as "custom:<key>"). */
export function formToEditor(form: FormAsset, content: BlueprintContent): Bridged<FormDraft> {
  const out = toNative("form", form, editorResolver(content));
  return { value: out.value.draft, unresolved: danglingOf(content, { type: "form", asset: form }, out.unresolved) };
}

/** The native form builder's draft back as the package draft (references for tags, deal, rule and fields). */
export function formFromEditor(draft: FormDraft, form: FormAsset, content: BlueprintContent): FormAsset["draft"] {
  const native = { key: form.key, name: form.name, kind: form.kind, purpose: form.purpose, folderId: null, draft };
  return fromNative("form", form.id, native, packageResolver(content, reverseIds(content, { type: "form", asset: form }))).value.draft;
}

/** What the native form builder may pick from: the package's own tags, pipelines, contact fields and assignment rules. */
export function formOptionsFor(content: BlueprintContent, style: IdStyle = "standin"): FormBuilderOptions {
  const a = content.assets;
  const id = idFor(style);
  return {
    tags: a.tags.map((t) => ({ id: id(t.id), name: t.name, color: t.color })),
    pipelines: a.pipelines.map((p) => ({ id: id(p.id), name: p.name, stages: p.stages.map((s) => ({ id: id(s.id), name: s.name, kind: s.kind })) })),
    contactFields: a.customFields.filter((f) => f.entity === "contact").map((f) => ({ id: id(f.id), key: f.key, label: f.label, type: f.type, options: f.options })),
    assignmentRules: a.assignmentRules.map((r) => ({ id: id(r.id), name: r.name, entity: r.entity, active: true })),
    assignmentRuleRefs: a.assignmentRules.map((r) => ({ id: id(r.id), entity: r.entity })),
    folders: a.folders.filter((f) => f.kind === "form").map((f) => ({ id: id(f.id), name: f.name })),
    contactsProblem: null,
    orgSlug: "",
  };
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/** A package workflow's definition as the native workflow builder edits it (stand-in IDs, send steps bound to the stand-in wording). */
export function workflowToEditor(workflow: WorkflowAsset, content: BlueprintContent): Bridged<WorkflowDefinition> {
  const out = toNative("workflow", workflow, editorResolver(content));
  return { value: out.value.draft, unresolved: danglingOf(content, { type: "workflow", asset: workflow }, out.unresolved.filter((u) => !u.path.endsWith("contentHash"))) };
}

/** The native builder's definition back as the package definition: references kept, the nonce and template bindings removed. */
export function workflowFromEditor(def: WorkflowDefinition, workflow: WorkflowAsset, content: BlueprintContent): WorkflowAsset["definition"] {
  const native = { key: workflow.key, name: workflow.name, description: workflow.description, folderId: null, hourlyRunLimit: workflow.hourlyRunLimit, draft: def };
  return fromNative("workflow", workflow.id, native, packageResolver(content, reverseIds(content, { type: "workflow", asset: workflow }))).value.definition;
}

/**
 * What the native workflow builder may pick from. People, n8n automations and webhook endpoints are the package's roles (slots); AI
 * employees are the iAcquire roles by name. None of them is checked for a connection here: that happens in each client's workspace, and the
 * setup checklist lists what it must connect or map.
 */
export function workflowOptionsFor(content: BlueprintContent, style: IdStyle = "standin"): EditorOptions {
  const a = content.assets;
  const id = idFor(style);
  const field = (f: (typeof a.customFields)[number]) => ({ id: id(f.id), key: f.key, label: f.label, type: f.type, options: f.options });
  const slots = (kind: "member" | "n8n" | "webhook") => content.slots.filter((s) => typeOfId(s.id) === kind);
  const ready = a.messageTemplates.filter((t) => t.channel && !t.placeholder && t.kind === "template");
  return {
    tags: a.tags.map((t) => ({ id: id(t.id), name: t.name, color: t.color })),
    members: slots("member").map((s) => ({ id: id(s.id), name: s.label, role: "Role" })),
    pipelines: a.pipelines.map((p) => ({ id: id(p.id), name: p.name, stages: p.stages.map((s) => ({ id: id(s.id), name: s.name, kind: s.kind })) })),
    contactFields: a.customFields.filter((f) => f.entity === "contact").map(field),
    opportunityFields: a.customFields.filter((f) => f.entity === "opportunity").map(field),
    assignmentRules: a.assignmentRules.map((r) => ({ id: id(r.id), name: r.name, entity: r.entity, active: true })),
    assignmentRuleRefs: a.assignmentRules.map((r) => ({ id: id(r.id), entity: r.entity })),
    templates: ready.map((t) => ({
      id: id(t.id), key: t.key, name: t.name, channel: t.channel!, purpose: t.purpose, version: 1, subject: t.subject, body: t.body, contentHash: EDITOR_TEMPLATE_HASH,
    })),
    unapprovedTemplates: a.messageTemplates.filter((t) => t.channel && t.kind === "template" && t.placeholder).map((t) => ({ id: id(t.id), name: `${t.name} (no wording yet)`, channel: t.channel })),
    n8nMappings: slots("n8n").map((s) => ({ id: id(s.id), label: s.label, workflowId: "", problem: null })),
    webhooks: slots("webhook").map((s) => ({ id: id(s.id), name: s.label, host: "each client's own endpoint", active: true })),
    employees: AGENT_ROLES.map((r) => ({ roleKey: r.key, name: r.name, mode: "assisted", enabled: true, ready: true, connected: true, liveRuns: true })),
    calendars: a.calendars.map((c) => ({ id: id(c.id), name: c.name })),
    appointmentTypes: a.calendars.flatMap((c) => c.types.map((t) => ({ id: id(t.id), name: a.calendars.length > 1 ? `${c.name}: ${t.name}` : t.name, calendarId: id(c.id) }))),
    forms: a.forms.map((f) => ({ id: id(f.id), name: f.name, status: "draft" })),
    customValues: a.customValues.map((v) => ({ key: v.key, label: v.label })),
    folders: a.folders.filter((f) => f.kind === "workflow").map((f) => ({ id: id(f.id), name: f.name })),
  };
}

/** The step kinds "+" offers, with notes in this Blueprint's terms (what to add to the Blueprint first), never a workspace's. */
export function blueprintKindChoices(options: EditorOptions): KindChoice[] {
  const note = (k: string): string | null => {
    if (k === "send_message" && !options.templates.length) return "Add a message template with its wording to this Blueprint first.";
    if (k === "request_review" && !options.templates.some((t) => /\{\{\s*review\.link\s*\}\}/.test(t.body))) return "Add a review request template (with {{review.link}}) to this Blueprint first.";
    if (k === "n8n" && !options.n8nMappings.length) return "Add an n8n automation role first (Roles).";
    if (k === "webhook" && !options.webhooks.length) return "Add a webhook endpoint role first (Roles).";
    if ((k === "create_opportunity" || k === "move_stage") && !options.pipelines.length) return "Add a pipeline to this Blueprint first.";
    if ((k === "add_tag" || k === "remove_tag") && !options.tags.length) return "Add tags to this Blueprint first.";
    return null;
  };
  return kindChoices(options).map((c) => ({ ...c, note: note(c.kind) }));
}

/** Names for readable summaries of package conditions (whose values are references). */
export function namesSourceFor(content: BlueprintContent): NameSource {
  return workflowOptionsFor(content, "ref");
}

// ---------------------------------------------------------------------------
// Filters (Smart Lists, assignment rule conditions)
// ---------------------------------------------------------------------------
//
// The filter builder doesn't check IDs, so its choices are the references themselves; only custom field conditions take the native
// "cf:<id>" encoding ("cf:@field.contact.budget").

export type FilterEntity = "contact" | "company";

const refResolver = (content: BlueprintContent): ApplyResolver => ({ ...editorResolver(content), nativeId: (id) => toRef(id) });

/** A package filter as the Smart List filter builder edits it (custom field conditions as "cf:@field…"). */
export function filterToBuilder(filter: FilterGroup, entity: FilterEntity, content: BlueprintContent): FilterGroup {
  return mapFilterRefs(filter, entity, "package", applyMapper(refResolver(content))).value;
}

/** The filter builder's filter back as the package filter. */
export function filterFromBuilder(filter: FilterGroup, entity: FilterEntity, content: BlueprintContent): FilterGroup {
  return mapFilterRefs(filter, entity, "native", captureMapper(packageResolver(content, { ids: new Map(), keys: new Map() }))).value;
}

/** What the filter builder may pick from: the package's tags, roles, pipelines and the custom fields of that record type. */
export function filterOptionsFor(content: BlueprintContent, entity: FilterEntity): FilterOptions {
  const a = content.assets;
  return {
    tags: a.tags.map((t) => ({ id: toRef(t.id), name: t.name, color: t.color })),
    members: content.slots.filter((s) => typeOfId(s.id) === "member").map((s) => ({ id: toRef(s.id), name: s.label })),
    pipelines: a.pipelines.map((p) => ({ id: toRef(p.id), name: p.name, stages: p.stages.map((s) => ({ id: toRef(s.id), name: s.name })) })),
    customFields: a.customFields.filter((f) => f.entity === entity).map((f) => ({ id: toRef(f.id), label: f.label, type: f.type, options: f.options })),
  };
}

/**
 * Why a filter can't be edited with the builder (it can still be read), or null when it can. The builder edits a safe subset of the filter
 * language: contacts and companies, groups at most two levels deep, fields and operators the builder itself offers, custom fields of this
 * Blueprint. Anything else (a deal list, a condition on specific companies, a field this Blueprint doesn't define) is shown read-only, so
 * editing can never quietly drop part of a condition.
 */
export function filterEditProblem(filter: FilterGroup, entity: "contact" | "company" | "opportunity", content: BlueprintContent): string | null {
  if (entity === "opportunity") return "Deal Smart Lists are shown as a summary here. Their conditions use the deal fields, which this builder doesn't edit.";
  const catalog = new Map((entity === "company" ? COMPANY_FILTER_FIELDS : CONTACT_FILTER_FIELDS).map((f) => [f.key, f]));
  const fields = new Map(content.assets.customFields.filter((f) => f.entity === entity).map((f) => [f.id, f]));
  let problem: string | null = null;
  const walk = (g: FilterGroup, depth: number) => {
    if (problem) return;
    if (depth > 2) {
      problem = "It has groups inside groups more than two levels deep, which the builder doesn't show.";
      return;
    }
    for (const c of g.conditions ?? []) {
      if (problem) return;
      if (isGroup(c)) {
        walk(c, depth + 1);
        continue;
      }
      if (c.field.startsWith("@")) {
        const f = fields.get(refId(c.field));
        if (!f) problem = `A condition uses ${c.field}, which isn't a ${entity} field of this Blueprint.`;
        else if (!customFieldOps(f.type).includes(c.op)) problem = `A condition compares “${f.label}” in a way the builder doesn't offer ("${c.op}").`;
        continue;
      }
      const def = catalog.get(c.field);
      if (!def) problem = `A condition uses "${c.field}", which the builder doesn't offer for ${entity === "company" ? "companies" : "contacts"}.`;
      else if (!OPS_BY_KIND[def.kind].includes(c.op) || (def.kind === "company" && c.op === "is_any_of")) problem = `A condition on “${def.label}” uses "${c.op}", which the builder doesn't offer.`;
    }
  };
  walk(filter, 1);
  return problem;
}
