// The Blueprint editor's rules that aren't drawing: new assets with logical IDs generated from their names (and never changed afterwards),
// what refers to an asset before it is removed, removing an asset with or without the references to it, renaming a configuration value's
// key everywhere its token is used, where a validation issue belongs, and the size check a save makes before it is sent. Pure (no
// "use client"), so the screens and the tests share it.
import { emptyDraft } from "@/lib/crm/forms/spec";
import { DEFAULT_CONTACT_COLUMNS } from "@/lib/crm/filters";
import { TAG_COLORS, type FieldEntity } from "@/lib/crm/types";
import { jsonBytes } from "@/lib/crm/blueprints/canonical";
import { idSegment, suggestLogicalId } from "@/lib/crm/blueprints/native";
import {
  assetRefs, assetTexts, listAssets, mapColumnRefs, mapFilterRefs, mapFormDraftRefs, mapReportConfigRefs, mapWorkflowRefs, rewriteValueTokens, rewriteWorkflowTokens,
  slotUsage, valueTokenKeys, type AssetEntry, type RefMapper,
} from "@/lib/crm/blueprints/refs";
import type { ValidationIssue } from "@/lib/crm/blueprints/validate";
import {
  ASSET_SECTIONS, BLUEPRINT_MAX_BYTES, SECTION_TYPE, refId, typeOfId,
  type AppointmentTypeAsset, type AssetSection, type AssetType, type AssetTypeMap, type BlueprintContent, type BlueprintFolderKind, type CalendarAsset, type PipelineAsset,
  type SlotAsset, type SlotKind, type StageAsset,
} from "@/lib/crm/blueprints/types";

/** The editor's own places besides the twelve asset sections: the Blueprint's details and the roles (mapping slots) it names. */
export type EditorSection = "details" | "slots" | AssetSection;
export const EDITOR_SECTIONS: readonly EditorSection[] = ["details", "slots", ...ASSET_SECTIONS];
export const isEditorSection = (v: unknown): v is EditorSection => typeof v === "string" && (EDITOR_SECTIONS as readonly string[]).includes(v);

type TopAsset<S extends AssetSection> = BlueprintContent["assets"][S][number];

/**
 * The editor section a CRM screen path stands for. The CRM's own builders (reused here) link to CRM screens ("/tags", "/settings/assignment");
 * inside the Blueprint editor those links open the matching section. Null: no section matches.
 */
export function sectionForPath(path: string): EditorSection | null {
  const p = path.replace(/^\/+|\/+$/g, "").split(/[?#]/)[0];
  const map: Record<string, EditorSection> = {
    tags: "tags", fields: "customFields", "settings/values": "customValues", pipelines: "pipelines", calendars: "calendars", "smart-lists": "smartLists",
    "settings/assignment": "assignmentRules", forms: "forms", templates: "messageTemplates", workflows: "workflows", reports: "reports", "settings/api": "slots",
  };
  if (map[p]) return map[p];
  if (isEditorSection(p)) return p;
  return null;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---------------------------------------------------------------------------
// Logical IDs and keys
// ---------------------------------------------------------------------------

/** Every logical ID in use: assets, nested stages and appointment types, and slots. */
export function takenIds(content: BlueprintContent): Set<string> {
  return new Set([...listAssets(content).map((e) => e.id), ...content.slots.map((s) => s.id)]);
}

/** The last segment of a logical ID ("pipeline.sales" → "sales"), used as the parent part of a stage's or appointment type's ID. */
export const lastSegment = (id: string) => id.split(".").pop() ?? id;

/**
 * A new logical ID for an asset, generated from what it is called (its name, or its key for keyed types), following LOGICAL_ID_SCHEMES.
 * It is generated once, when the asset is created: renaming the asset later keeps its ID, so every reference to it keeps working.
 */
export function newLogicalId(
  content: BlueprintContent,
  type: AssetType | SlotKind,
  seed: { name?: string; key?: string; entity?: string; kind?: string; label?: string },
  parentId?: string,
  extraTaken: Iterable<string> = [],
): string {
  const taken = takenIds(content);
  for (const id of extraTaken) taken.add(id);
  return suggestLogicalId(type, seed, taken, parentId ? lastSegment(parentId) : undefined);
}

/** Which key alphabet each keyed type uses (the native columns' own rules). */
const KEY_STYLE: Partial<Record<AssetType, "underscore" | "hyphen" | "either">> = {
  customField: "underscore", customValue: "underscore", form: "hyphen", report: "hyphen", messageTemplate: "either", workflow: "either",
};

/** A key from a name, in the alphabet the type's native column accepts, not in `taken` ("Budget range" → "budget_range" or "budget-range"). */
export function keyFromName(type: AssetType, name: string, taken: Iterable<string>): string {
  const style = KEY_STYLE[type] ?? "underscore";
  const used = new Set(taken);
  let base = idSegment(name, 48);
  if (style === "underscore") {
    base = base.replace(/-+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    if (!/^[a-z]/.test(base)) base = `x_${base}`.replace(/_+$/g, "");
  } else if (style === "hyphen") {
    base = base.replace(/_+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  }
  base = base.slice(0, 48).replace(/[-_]+$/g, "") || "item";
  if (!used.has(base)) return base;
  const sep = style === "hyphen" ? "-" : "_";
  for (let i = 2; i < 1000; i++) {
    const suffix = `${sep}${i}`;
    const candidate = `${base.slice(0, 48 - suffix.length).replace(/[-_]+$/g, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 40)}${sep}${used.size + 1}`;
}

/** The keys a keyed section already uses (fields per record type). */
export function keysIn(content: BlueprintContent, section: AssetSection, entity?: FieldEntity): string[] {
  const list = content.assets[section] as Array<{ key?: string; entity?: string }>;
  return list.filter((a) => (section === "customFields" ? a.entity === entity : true)).map((a) => a.key ?? "").filter(Boolean);
}

// ---------------------------------------------------------------------------
// New assets: a sensible, valid starting point for each type
// ---------------------------------------------------------------------------

export interface NewAssetInput {
  name: string;
  /** Keyed types: the key to use (generated from the name when empty). */
  key?: string;
  entity?: FieldEntity | "contact" | "company" | "opportunity";
  kind?: BlueprintFolderKind;
}

const WEEKDAY_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));

/** A new appointment type for a calendar, with an ID under that calendar. */
export function newAppointmentType(content: BlueprintContent, calendarId: string, name: string, extraTaken: Iterable<string> = []): AppointmentTypeAsset {
  return {
    id: newLogicalId(content, "appointmentType", { name }, calendarId, extraTaken),
    name: name.trim().slice(0, 80) || "Appointment",
    description: null, durationMinutes: 30, slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 120, maxDaysAhead: 60, dailyLimit: null,
    capacity: 1, locationKind: "phone", locationDetail: null, meetingProvider: "none", meetingLink: null, requiresConfirmation: false, public: true, questions: [], color: null,
    confirmationMessage: null, allowCustomerChanges: true, changeCutoffMinutes: 1440, requireEmail: true, requirePhone: false,
  };
}

/** A new stage for a pipeline, with an ID under that pipeline. */
export function newStage(content: BlueprintContent, pipelineId: string, name: string, kind: StageAsset["kind"] = "open", extraTaken: Iterable<string> = []): StageAsset {
  return { id: newLogicalId(content, "stage", { name }, pipelineId, extraTaken), name: name.trim().slice(0, 60) || "Stage", kind, probability: null, color: null };
}

/** A new top-level asset of a section, valid on its own where the type allows (a template still needs its wording). */
export function newAsset<S extends AssetSection>(content: BlueprintContent, section: S, input: NewAssetInput): TopAsset<S> {
  const type = SECTION_TYPE[section];
  const name = input.name.replace(/\s+/g, " ").trim();
  const keyed = KEY_STYLE[type] !== undefined;
  const entity = (input.entity ?? "contact") as FieldEntity;
  const key = keyed ? (input.key?.trim() || keyFromName(type, name, keysIn(content, section, entity))) : undefined;
  const id = newLogicalId(content, type, { name, key, entity, kind: input.kind, label: name });
  let asset: unknown;
  switch (section) {
    case "folders":
      asset = { id, kind: input.kind ?? "tag", name: name.slice(0, 80) };
      break;
    case "tags":
      asset = { id, name: name.slice(0, 60), color: TAG_COLORS[content.assets.tags.length % TAG_COLORS.length], description: null, folder: null };
      break;
    case "customFields":
      asset = { id, entity, key, label: name.slice(0, 80), type: "text", options: [], required: false, helpText: null, groupName: null };
      break;
    case "customValues":
      asset = { id, key, label: name.slice(0, 80), type: "text", value: "", required: false, groupName: null };
      break;
    case "pipelines": {
      const stages: StageAsset[] = [];
      for (const [stageName, kind] of [["New", "open"], ["Qualified", "open"], ["Won", "won"], ["Lost", "lost"]] as const) {
        stages.push(newStage(content, id, stageName, kind, stages.map((x) => x.id)));
      }
      asset = { id, name: name.slice(0, 80), description: null, isDefault: !content.assets.pipelines.some((p) => p.isDefault), stages } satisfies PipelineAsset;
      break;
    }
    case "calendars": {
      const type0 = newAppointmentType(content, id, "Consultation", [id]);
      asset = {
        id, name: name.slice(0, 80), description: null, assignment: "single", roundRobinMode: "balanced", color: null, folder: null, bookingIntro: null, timezone: null,
        hours: WEEKDAY_HOURS.map((h) => ({ ...h })), hosts: [], types: [type0],
      } satisfies CalendarAsset;
      break;
    }
    case "smartLists": {
      const listEntity = (input.entity ?? "contact") as "contact" | "company" | "opportunity";
      asset = {
        id, entity: listEntity, name: name.slice(0, 80), description: null, folder: null, filter: { op: "and", conditions: [] },
        columns: listEntity === "contact" ? [...DEFAULT_CONTACT_COLUMNS] : [], sort: listEntity === "contact" ? { by: "created_at", dir: "desc" } : {}, isDefault: false,
      };
      break;
    }
    case "assignmentRules":
      asset = {
        id, name: name.slice(0, 80), entity: input.entity === "opportunity" ? "opportunity" : "contact", conditions: { op: "and", conditions: [] }, reassignOwned: false,
        strategy: "round_robin", respectWorkingHours: false, fallback: "unassigned", fallbackMember: null, members: [],
      };
      break;
    case "forms":
      asset = { id, key, name: name.slice(0, 80), kind: "form", purpose: "contact", folder: null, draft: emptyDraft("form"), placeholder: false };
      break;
    case "messageTemplates":
      asset = { id, kind: "template", key, name: name.slice(0, 80), channel: "email", purpose: "service", category: null, folder: null, subject: "", body: "", whatsapp: null, placeholder: false };
      break;
    case "workflows":
      asset = { id, key, name: name.slice(0, 80), description: null, folder: null, hourlyRunLimit: 500, definition: { trigger: { type: "manual" }, steps: [] }, placeholder: false };
      break;
    case "reports":
      asset = { id, key, name: name.slice(0, 80), description: null, folder: null, config: { filters: { range: "30d" }, sections: ["leads"] } };
      break;
  }
  return asset as TopAsset<S>;
}

/** A new mapping slot ("member.closer" labelled "Closer"). */
export function newSlot(content: BlueprintContent, kind: SlotKind, label: string, description: string | null = null): SlotAsset {
  const clean = label.replace(/\s+/g, " ").trim().slice(0, 80);
  return { id: newLogicalId(content, kind, { name: clean, label: clean }), label: clean || kind, description };
}

// ---------------------------------------------------------------------------
// Editing helpers
// ---------------------------------------------------------------------------

export function withSection<S extends AssetSection>(content: BlueprintContent, section: S, list: Array<TopAsset<S>>): BlueprintContent {
  return { ...content, assets: { ...content.assets, [section]: list } };
}

/** Replaces one top-level asset (by ID) with what `update` returns. */
export function updateAsset<S extends AssetSection>(content: BlueprintContent, section: S, id: string, update: (a: TopAsset<S>) => TopAsset<S>): BlueprintContent {
  const list = content.assets[section] as Array<TopAsset<S>>;
  return withSection(content, section, list.map((a) => (a.id === id ? update(a) : a)));
}

export function addAsset<S extends AssetSection>(content: BlueprintContent, section: S, asset: TopAsset<S>): BlueprintContent {
  return withSection(content, section, [...(content.assets[section] as Array<TopAsset<S>>), asset]);
}

/** Moves an item of a list one place up or down; out-of-range moves return the list unchanged. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const j = index + delta;
  if (index < 0 || index >= list.length || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

// ---------------------------------------------------------------------------
// What refers to an asset, and removing it
// ---------------------------------------------------------------------------

export interface AssetReference {
  /** The top-level asset that holds the reference (a stage's references are its pipeline's, and so on). */
  assetId: string;
  assetType: AssetType;
  section: AssetSection;
  name: string;
  /** Where inside it ("draft.actions.tagIds[0]"), or the token for a configuration value. */
  places: string[];
  /** A reference ("@tag.vip"), a {{custom_values.key}} token in a text, or the use of a role (slot). */
  kind: "reference" | "token";
}

/** An asset's own ID and the IDs nested in it (a pipeline's stages, a calendar's appointment types). */
export function idsWithChildren(content: BlueprintContent, id: string): string[] {
  const out = [id];
  for (const p of content.assets.pipelines) if (p.id === id) out.push(...p.stages.map((s) => s.id));
  for (const c of content.assets.calendars) if (c.id === id) out.push(...c.types.map((t) => t.id));
  return out;
}

/** The top-level asset an entry belongs to (itself, or its pipeline / calendar). */
const topOf = (e: AssetEntry) => e.parentId ?? e.id;

/**
 * Everything that refers to any of `ids` (assets or slots), grouped by the top-level asset that holds the reference. Configuration values
 * are also "used" by every text that contains their {{custom_values.<key>}} token. The assets being removed themselves are not listed.
 */
export function referencesTo(content: BlueprintContent, ids: Iterable<string>): AssetReference[] {
  const wanted = new Set(ids);
  const removedTops = new Set([...wanted].filter((id) => !typeOfId(id) || !["member", "n8n", "webhook"].includes(typeOfId(id)!)));
  const keys = new Set(content.assets.customValues.filter((v) => wanted.has(v.id)).map((v) => v.key));
  const entries = listAssets(content);
  const byTop = new Map<string, AssetReference>();
  const tops = new Map(entries.filter((e) => !e.parentId).map((e) => [e.id, e]));
  const note = (e: AssetEntry, place: string, kind: AssetReference["kind"]) => {
    const top = tops.get(topOf(e))!;
    if (removedTops.has(top.id)) return;
    const ref = byTop.get(top.id) ?? { assetId: top.id, assetType: top.type, section: top.section, name: top.name, places: [], kind };
    const where = e.parentId ? `${e.name}: ${place}` : place;
    if (!ref.places.includes(where)) ref.places.push(where);
    if (kind === "reference") ref.kind = "reference";
    byTop.set(top.id, ref);
  };
  for (const e of entries) {
    for (const r of assetRefs(e)) if (r.value.startsWith("@") && wanted.has(refId(r.value))) note(e, r.site.path, "reference");
    if (keys.size) for (const k of valueTokenKeys(...assetTexts(e))) if (keys.has(k)) note(e, `{{custom_values.${k}}}`, "token");
  }
  return [...byTop.values()].sort((a, b) => ASSET_SECTIONS.indexOf(a.section) - ASSET_SECTIONS.indexOf(b.section) || a.name.localeCompare(b.name));
}

/**
 * One asset (package side) with every reference passed through `fn`: its own columns (folder, calendar hosts, rule members and fallback
 * person) and everything embedded (filters, columns, form drafts, workflow definitions, report filters). A null answer clears the reference
 * the way the native side leaves it out (refs.ts MissingRule): a list loses the entry, an optional link becomes empty.
 */
export function mapAssetReferences<T extends AssetType>(type: T, asset: AssetTypeMap[T], fn: RefMapper): AssetTypeMap[T] {
  const a = clone(asset) as unknown as Record<string, unknown>;
  const keep = (v: unknown, path: string, target: Parameters<RefMapper>[1]["target"]) => typeof v === "string" && fn(v, { path, target, encoding: "id", required: false, missing: "drop" }) !== null;
  if (type !== "folder" && typeof a.folder === "string" && !keep(a.folder, "folder", "folder")) a.folder = null;
  switch (type) {
    case "calendar":
      a.hosts = (a.hosts as string[]).filter((h, i) => keep(h, `hosts[${i}]`, "member"));
      break;
    case "smartList": {
      const entity = a.entity as FieldEntity;
      a.filter = mapFilterRefs(a.filter as never, entity, "package", fn, "filter").value;
      a.columns = mapColumnRefs(a.columns as string[], entity, "package", fn, "columns").value;
      break;
    }
    case "assignmentRule":
      a.conditions = mapFilterRefs(a.conditions as never, "contact", "package", fn, "conditions").value;
      a.members = (a.members as Array<{ member: string }>).filter((m, i) => keep(m.member, `members[${i}].member`, "member"));
      if (typeof a.fallbackMember === "string" && !keep(a.fallbackMember, "fallbackMember", "member")) {
        // Without the person it fell back to, the rule leaves the record unassigned instead.
        a.fallbackMember = null;
        a.fallback = "unassigned";
      }
      break;
    case "form":
      a.draft = mapFormDraftRefs(a.draft as never, "package", fn, "draft").value;
      break;
    case "workflow":
      a.definition = mapWorkflowRefs(a.definition as never, "package", fn, "definition").value;
      break;
    case "report":
      a.config = mapReportConfigRefs(a.config as never, "package", fn, "config").value;
      break;
  }
  return a as unknown as AssetTypeMap[T];
}

/** The content with every reference to `ids` cleared everywhere (see mapAssetReferences). Configuration value tokens in texts are kept. */
export function stripReferences(content: BlueprintContent, ids: Iterable<string>): BlueprintContent {
  const gone = new Set(ids);
  const fn: RefMapper = (value) => (value.startsWith("@") && gone.has(refId(value)) ? null : value);
  const assets = { ...content.assets } as Record<AssetSection, unknown[]>;
  for (const section of ASSET_SECTIONS) {
    const type = SECTION_TYPE[section];
    assets[section] = (content.assets[section] as unknown[]).map((a) => mapAssetReferences(type, a as AssetTypeMap[typeof type], fn));
  }
  return { ...content, assets: assets as unknown as BlueprintContent["assets"] };
}

/**
 * Removes an asset (top-level, or a stage / appointment type from its parent) or a slot. With `stripRefs`, every reference to it (and to
 * what is nested in it) is cleared first; without, references are left dangling, and validation lists them for a person to fix.
 */
export function removeAsset(content: BlueprintContent, id: string, opts: { stripRefs: boolean }): BlueprintContent {
  const ids = idsWithChildren(content, id);
  let next = opts.stripRefs ? stripReferences(content, ids) : content;
  const kind = typeOfId(id);
  if (kind === "member" || kind === "n8n" || kind === "webhook") return { ...next, slots: next.slots.filter((s) => s.id !== id) };
  if (kind === "stage") {
    next = withSection(next, "pipelines", next.assets.pipelines.map((p) => ({ ...p, stages: p.stages.filter((s) => s.id !== id) })));
    return next;
  }
  if (kind === "appointmentType") {
    return withSection(next, "calendars", next.assets.calendars.map((c) => ({ ...c, types: c.types.filter((t) => t.id !== id) })));
  }
  const assets = { ...next.assets } as Record<AssetSection, Array<{ id: string }>>;
  for (const section of ASSET_SECTIONS) assets[section] = assets[section].filter((a) => a.id !== id);
  next = { ...next, assets: assets as unknown as BlueprintContent["assets"] };
  return next;
}

/** The roles a Blueprint names and how many assets use each (unused roles are worth removing). */
export function slotUseCounts(content: BlueprintContent): Record<string, number> {
  return Object.fromEntries(Object.entries(slotUsage(content)).map(([k, v]) => [k, v.length]));
}

/**
 * Changes a configuration value's key and rewrites its {{custom_values.<key>}} token in every template and workflow text, so nothing that
 * used it is left pointing at a key the Blueprint no longer has.
 */
export function renameValueKey(content: BlueprintContent, valueId: string, nextKey: string): BlueprintContent {
  const value = content.assets.customValues.find((v) => v.id === valueId);
  if (!value || value.key === nextKey) return content;
  const from = value.key;
  const map = (k: string) => (k === from ? nextKey : null);
  return {
    ...content,
    assets: {
      ...content.assets,
      customValues: content.assets.customValues.map((v) => (v.id === valueId ? { ...v, key: nextKey } : v)),
      messageTemplates: content.assets.messageTemplates.map((t) => ({
        ...t, subject: t.subject === null ? null : rewriteValueTokens(t.subject, map), body: rewriteValueTokens(t.body, map),
      })),
      workflows: content.assets.workflows.map((w) => ({ ...w, definition: rewriteWorkflowTokens(w.definition as never, map) as typeof w.definition })),
    },
  };
}

// ---------------------------------------------------------------------------
// Where a validation issue belongs
// ---------------------------------------------------------------------------

export interface IssueLocation {
  section: EditorSection;
  /** The top-level asset, when the issue is about one. */
  assetId: string | null;
  /** The stage or appointment type inside it, when the issue is about one. */
  nestedId: string | null;
}

const PATH = /^assets\.(\w+)\[(\d+)\](?:\.(stages|types)\[(\d+)\])?/;

/** Which editor section, asset and nested asset an issue is about, from its path (or, failing that, its asset ID). */
export function issueLocation(issue: Pick<ValidationIssue, "path" | "assetId">, content: BlueprintContent): IssueLocation {
  const m = PATH.exec(issue.path ?? "");
  if (m && (ASSET_SECTIONS as readonly string[]).includes(m[1])) {
    const section = m[1] as AssetSection;
    const top = (content.assets[section] as Array<{ id: string; stages?: Array<{ id: string }>; types?: Array<{ id: string }> }>)[Number(m[2])];
    const nested = m[3] ? top?.[m[3] as "stages" | "types"]?.[Number(m[4])]?.id ?? null : null;
    return { section, assetId: top?.id ?? null, nestedId: nested };
  }
  if (issue.assetId) {
    const kind = typeOfId(issue.assetId);
    if (kind === "member" || kind === "n8n" || kind === "webhook") return { section: "slots", assetId: issue.assetId, nestedId: null };
    const e = listAssets(content).find((x) => x.id === issue.assetId);
    if (e) return { section: e.section, assetId: e.parentId ?? e.id, nestedId: e.parentId ? e.id : null };
  }
  const head = /^assets\.(\w+)/.exec(issue.path ?? "")?.[1];
  if (head && (ASSET_SECTIONS as readonly string[]).includes(head)) return { section: head as AssetSection, assetId: null, nestedId: null };
  if ((issue.path ?? "").startsWith("slots")) return { section: "slots", assetId: null, nestedId: null };
  return { section: "details", assetId: null, nestedId: null };
}

export interface IssueIndex {
  bySection: Record<EditorSection, { errors: number; warnings: number }>;
  byAsset: Map<string, ValidationIssue[]>;
  located: Array<ValidationIssue & IssueLocation>;
}

export function indexIssues(issues: readonly ValidationIssue[], content: BlueprintContent): IssueIndex {
  const bySection = Object.fromEntries(EDITOR_SECTIONS.map((s) => [s, { errors: 0, warnings: 0 }])) as IssueIndex["bySection"];
  const byAsset = new Map<string, ValidationIssue[]>();
  const located: IssueIndex["located"] = [];
  for (const i of issues) {
    const loc = issueLocation(i, content);
    const c = bySection[loc.section];
    if (i.severity === "error") c.errors++;
    else c.warnings++;
    for (const key of [loc.assetId, loc.nestedId]) if (key) byAsset.set(key, [...(byAsset.get(key) ?? []), i]);
    located.push({ ...i, ...loc });
  }
  return { bySection, byAsset, located };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Validation codes that stop a draft from being stored at all (the library's own rule, src/server/crm/blueprints/library/content.ts, which
 * decides on the server): structure, size, code and credentials. Everything else can sit in a working draft and only blocks publishing.
 */
export const SAVE_BLOCKING_CODES: ReadonlySet<string> = new Set(["schema", "too_large", "asset_too_large", "secret", "unsafe"]);

/** The issues that would stop a save. */
export const saveBlockers = (errors: readonly ValidationIssue[]) => errors.filter((e) => SAVE_BLOCKING_CODES.has(e.code));

/** UTF-8 size of the JSON a save sends. */
export function draftBytes(content: BlueprintContent): number {
  return jsonBytes(content);
}

/** Why a draft can't be sent, or null: the package limit (1 MB) keeps a save well under the 2 MB server action limit. */
export function saveSizeProblem(content: BlueprintContent): string | null {
  const bytes = draftBytes(content);
  if (bytes <= BLUEPRINT_MAX_BYTES) return null;
  return `This Blueprint is ${Math.ceil(bytes / 1000).toLocaleString("en-US")} KB; a Blueprint can be at most ${(BLUEPRINT_MAX_BYTES / 1000).toLocaleString("en-US")} KB. Remove assets or shorten long texts, then save.`;
}

/** Whether the metadata on the library card (name, description, industry) differs from what the draft now says. */
export function detailsChanged(row: { name: string; description: string; industry: string }, content: BlueprintContent): boolean {
  const b = content.blueprint;
  return row.name !== b.name || row.description !== b.description || row.industry !== b.industry;
}
