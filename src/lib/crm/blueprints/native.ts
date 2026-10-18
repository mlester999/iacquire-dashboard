// The bridge between a Blueprint asset and a workspace record, for every asset type:
//
//   * toNative    logical → native: the record to write in a target workspace, every reference resolved to that workspace's own IDs
//                 (apply). Inbound webhook nonces are generated fresh and send steps are bound to the workspace's own template wording.
//   * fromNative  native → logical: the asset a workspace record becomes (capture), every workspace ID replaced by a logical reference.
//                 People become slots, and anything that names a customer record (a specific company or campaign) is left out and reported.
//   * nativeProjection / assetFingerprint: what is hashed to tell, later, whether the client customized a record (native_hash) or the
//                 Blueprint asset changed since it was applied (asset_hash). Hashing happens in src/server/crm/blueprints/access.ts.
//   * identityKey: how an asset is matched to an existing record in a workspace that never had it linked (conflict detection).
//
// Pure: the apply and capture engines do the reading and writing, these functions only translate.
import type { FilterGroup } from "@/lib/crm/filters";
import type { FormDraft } from "@/lib/crm/forms/spec";
import type { WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { reportKind, type ReportConfig } from "@/components/crm/reports/spec";
import type { FieldEntity } from "@/lib/crm/types";
import {
  mapColumnRefs, mapFilterRefs, mapFormDraftRefs, mapReportConfigRefs, mapWorkflowRefs, rewriteValueTokens, rewriteWorkflowTokens,
  type RefFinding, type RefMapper, type RefSite,
} from "@/lib/crm/blueprints/refs";
import {
  ID_PREFIX, LOGICAL_ID_MAX, REF_PREFIX, refId, toRef,
  type AssetType, type AssetTypeMap, type BlueprintFormDraft, type BlueprintReportConfig, type BlueprintWorkflowDefinition, type NativeTypeMap,
  type RefTarget, type SlotKind,
} from "@/lib/crm/blueprints/types";

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * What the apply engine knows about the target workspace while it writes. Every method answers for one reference; null means "not
 * available here" (a dependency that was blocked or skipped, a slot nobody mapped), and the reference is then left out and reported.
 */
export interface ApplyResolver {
  /** The workspace ID for a logical ID: an asset this apply created or linked, an existing matched record, or a mapped slot. */
  nativeId(logicalId: string): string | null;
  /** A custom field's key in the workspace (forms and "changed fields" filters name a field by key, not by ID). */
  fieldKey(logicalId: string): string | null;
  /** The workspace key for a package configuration value key ({{custom_values.<key>}}). Null keeps the token as written. */
  valueKey(packageKey: string): string | null;
  /** The content hash of a template's current wording in the workspace (send steps are bound to it). Null leaves it for the editor. */
  templateHash(logicalId: string): string | null;
  /** A new inbound webhook nonce. Nonces are never copied between workspaces. */
  newNonce(): string;
}

/**
 * What the capture engine knows about the source workspace. It has chosen a logical ID for every record it captures (suggestLogicalId) and
 * a slot for every person it will name; anything else answers null and is left out.
 */
export interface CaptureResolver {
  /** The logical ID for a workspace record or person (a slot ID for people, n8n mappings and webhook subscriptions). */
  logicalId(target: RefTarget, nativeId: string): string | null;
  /** The logical ID of a custom field named by key. */
  fieldByKey(entity: FieldEntity, key: string): string | null;
  /** The package key for a workspace configuration value key (normally the same key). Null keeps the token as written. */
  valueKey(nativeKey: string): string | null;
}

/** One reference that could not be translated: where, what it should point at, the value found, and whether the result is incomplete. */
export interface UnresolvedRef {
  path: string;
  target: RefTarget;
  value: string;
  required: boolean;
}

export interface Converted<T> {
  value: T;
  unresolved: UnresolvedRef[];
  /** Deliberate, documented changes the conversion made (for example a meeting link the workspace must still add). Safe to show. */
  notes: string[];
}

const toUnresolved = (f: RefFinding[]): UnresolvedRef[] => f.map((x) => ({ path: x.site.path, target: x.site.target, value: x.value, required: x.site.required }));

/** Turns package references into workspace values, encoding them as the native side writes them at each position. */
export function applyMapper(r: Pick<ApplyResolver, "nativeId" | "fieldKey">): RefMapper {
  return (value, site) => {
    if (!value.startsWith(REF_PREFIX)) return null;
    const id = refId(value);
    switch (site.encoding) {
      case "id":
        return r.nativeId(id);
      case "cf_id": {
        const n = r.nativeId(id);
        return n ? `cf:${n}` : null;
      }
      case "custom_key": {
        const k = r.fieldKey(id);
        return k ? `custom:${k}` : null;
      }
      case "cf_key": {
        const k = r.fieldKey(id);
        return k ? `cf:${k}` : null;
      }
    }
  };
}

/** Turns workspace values into package references. A customer record ("record" target) never resolves. */
export function captureMapper(r: CaptureResolver): RefMapper {
  return (value, site: RefSite) => {
    if (site.target === "record") return null;
    let id: string | null = null;
    switch (site.encoding) {
      case "id":
        id = r.logicalId(site.target, value);
        break;
      case "cf_id":
        id = value.startsWith("cf:") ? r.logicalId("customField", value.slice(3)) : null;
        break;
      case "custom_key":
        id = value.startsWith("custom:") ? r.fieldByKey(site.entity ?? "contact", value.slice(7)) : null;
        break;
      case "cf_key":
        id = value.startsWith("cf:") ? r.fieldByKey(site.entity ?? "contact", value.slice(3)) : null;
        break;
    }
    return id ? toRef(id) : null;
  };
}

// ---------------------------------------------------------------------------
// logical → native (apply)
// ---------------------------------------------------------------------------

export interface ToNativeOptions {
  /** The workspace ID of the parent: the pipeline of a stage, the calendar of an appointment type. */
  parentId?: string | null;
}

/** A reference on an asset's own column (folder, fallback member). */
function column(ref: string | null, path: string, target: RefTarget, r: ApplyResolver, out: UnresolvedRef[], required = false): string | null {
  if (!ref) return null;
  const n = ref.startsWith(REF_PREFIX) ? r.nativeId(refId(ref)) : null;
  if (!n) out.push({ path, target, value: ref, required });
  return n;
}

/** The workspace record for a package asset, with every reference resolved through `r`. */
export function toNative<T extends AssetType>(type: T, asset: AssetTypeMap[T], r: ApplyResolver, opts: ToNativeOptions = {}): Converted<NativeTypeMap[T]> {
  const un: UnresolvedRef[] = [];
  const notes: string[] = [];
  const mapper = applyMapper(r);
  const valueKey = (k: string) => r.valueKey(k);
  const parent = (what: RefTarget) => {
    if (!opts.parentId) un.push({ path: "parent", target: what, value: "", required: true });
    return opts.parentId ?? "";
  };
  let value: unknown;
  switch (type) {
    case "folder": {
      const a = asset as AssetTypeMap["folder"];
      value = { kind: a.kind, name: a.name };
      break;
    }
    case "tag": {
      const a = asset as AssetTypeMap["tag"];
      value = { name: a.name, color: a.color, description: a.description, folderId: column(a.folder, "folder", "folder", r, un) };
      break;
    }
    case "customField": {
      const a = asset as AssetTypeMap["customField"];
      value = { entity: a.entity, key: a.key, label: a.label, type: a.type, options: a.options.map((o) => ({ ...o })), required: a.required, helpText: a.helpText, groupName: a.groupName };
      break;
    }
    case "customValue": {
      const a = asset as AssetTypeMap["customValue"];
      value = { key: r.valueKey(a.key) ?? a.key, label: a.label, type: a.type, value: a.value, required: a.required, groupName: a.groupName };
      break;
    }
    case "pipeline": {
      const a = asset as AssetTypeMap["pipeline"];
      value = { name: a.name, description: a.description, isDefault: a.isDefault };
      break;
    }
    case "stage": {
      const a = asset as AssetTypeMap["stage"];
      value = { pipelineId: parent("pipeline"), name: a.name, kind: a.kind, probability: a.probability, color: a.color };
      break;
    }
    case "calendar": {
      const a = asset as AssetTypeMap["calendar"];
      const hostIds: string[] = [];
      a.hosts.forEach((h, i) => {
        const n = h.startsWith(REF_PREFIX) ? r.nativeId(refId(h)) : null;
        if (n) hostIds.push(n);
        else un.push({ path: `hosts[${i}]`, target: "member", value: h, required: false });
      });
      value = {
        name: a.name, description: a.description, assignment: a.assignment, roundRobinMode: a.roundRobinMode, color: a.color, folderId: column(a.folder, "folder", "folder", r, un),
        bookingIntro: a.bookingIntro, timezone: a.timezone, hoursTemplate: a.hours.map((h) => ({ ...h })), hostIds,
      };
      break;
    }
    case "appointmentType": {
      const { id: _id, ...rest } = asset as AssetTypeMap["appointmentType"];
      void _id;
      const t = { ...JSON.parse(JSON.stringify(rest)), calendarId: parent("calendar") } as NativeTypeMap["appointmentType"];
      // The database requires a link for a fixed-link meeting; until the workspace adds one the type offers no video link
      // (requirement "meeting_link" stays open).
      if (t.meetingProvider === "custom_link" && !t.meetingLink) {
        t.meetingProvider = "none";
        notes.push(`“${t.name}” uses a fixed meeting link the workspace must add, so it starts without one.`);
      }
      value = t;
      break;
    }
    case "smartList": {
      const a = asset as AssetTypeMap["smartList"];
      const filter = mapFilterRefs(a.filter, a.entity, "package", mapper, "filter");
      const columns = mapColumnRefs(a.columns, a.entity, "package", mapper, "columns");
      un.push(...toUnresolved(filter.unresolved), ...toUnresolved(columns.unresolved));
      value = { entity: a.entity, name: a.name, description: a.description, folderId: column(a.folder, "folder", "folder", r, un), filter: filter.value, columns: columns.value, sort: { ...a.sort }, isDefault: a.isDefault };
      break;
    }
    case "assignmentRule": {
      const a = asset as AssetTypeMap["assignmentRule"];
      const cond = mapFilterRefs(a.conditions, "contact", "package", mapper, "conditions");
      un.push(...toUnresolved(cond.unresolved));
      const members: Array<{ userId: string; weight: number; priority: number }> = [];
      a.members.forEach((m, i) => {
        const n = m.member.startsWith(REF_PREFIX) ? r.nativeId(refId(m.member)) : null;
        if (n) members.push({ userId: n, weight: m.weight, priority: m.priority });
        else un.push({ path: `members[${i}].member`, target: "member", value: m.member, required: false });
      });
      value = {
        name: a.name, entity: a.entity, conditions: { ...cond.value, reassignOwned: a.reassignOwned }, strategy: a.strategy, respectWorkingHours: a.respectWorkingHours,
        fallback: a.fallback, fallbackUserId: column(a.fallbackMember, "fallbackMember", "member", r, un, a.fallback === "fallback_user"), members,
      };
      break;
    }
    case "form": {
      const a = asset as AssetTypeMap["form"];
      const draft = mapFormDraftRefs(a.draft, "package", mapper, "draft");
      un.push(...toUnresolved(draft.unresolved));
      value = { key: a.key, name: a.name, kind: a.kind, purpose: a.purpose, folderId: column(a.folder, "folder", "folder", r, un), draft: draft.value };
      break;
    }
    case "messageTemplate": {
      const a = asset as AssetTypeMap["messageTemplate"];
      value = {
        kind: a.kind, key: a.key, name: a.name, channel: a.channel, purpose: a.purpose, category: a.category, folderId: column(a.folder, "folder", "folder", r, un),
        subject: a.subject === null ? null : rewriteValueTokens(a.subject, valueKey), body: rewriteValueTokens(a.body, valueKey), whatsapp: a.whatsapp ? { ...a.whatsapp } : null,
      };
      break;
    }
    case "workflow": {
      const a = asset as AssetTypeMap["workflow"];
      const mapped = mapWorkflowRefs(a.definition, "package", mapper, "definition");
      un.push(...toUnresolved(mapped.unresolved));
      const def = rewriteWorkflowTokens(mapped.value, valueKey) as unknown as WorkflowDefinition;
      bindWorkspaceValues(def, a.definition, r, un);
      value = { key: a.key, name: a.name, description: a.description, folderId: column(a.folder, "folder", "folder", r, un), hourlyRunLimit: a.hourlyRunLimit, draft: def };
      break;
    }
    case "report": {
      const a = asset as AssetTypeMap["report"];
      const cfg = mapReportConfigRefs(a.config, "package", mapper, "config");
      un.push(...toUnresolved(cfg.unresolved));
      const config = cfg.value as unknown as ReportConfig;
      value = { key: a.key, name: a.name, description: a.description, folderId: column(a.folder, "folder", "folder", r, un), report: reportKind(config.sections), config };
      break;
    }
  }
  return { value: value as NativeTypeMap[T], unresolved: un, notes };
}

/** The two workspace-only values a native definition needs: a fresh inbound nonce, and each send step's binding to its template's wording. */
function bindWorkspaceValues(def: WorkflowDefinition, source: BlueprintWorkflowDefinition, r: ApplyResolver, un: UnresolvedRef[]) {
  const trig = def.trigger as unknown as Record<string, unknown>;
  if (trig.inbound && typeof trig.inbound === "object") trig.inbound = { ...(trig.inbound as object), nonce: r.newNonce() };
  def.steps.forEach((s, i) => {
    if (s.kind !== "send_message" && s.kind !== "request_review") return;
    const ref = source.steps[i]?.config?.templateId;
    const c = s.config as unknown as Record<string, unknown>;
    const hash = typeof ref === "string" && ref.startsWith(REF_PREFIX) ? r.templateHash(refId(ref)) : null;
    if (hash) c.contentHash = hash;
    else {
      delete c.contentHash;
      if (typeof ref === "string") un.push({ path: `definition.steps[${i}].config.contentHash`, target: "messageTemplate", value: ref, required: true });
    }
  });
}

// ---------------------------------------------------------------------------
// native → logical (capture)
// ---------------------------------------------------------------------------

export interface FromNativeOptions {
  /** For a pipeline: its stages; for a calendar: its appointment types, each with the logical ID chosen for it, in order. */
  children?: Array<{ id: string; record: NativeTypeMap["stage"] | NativeTypeMap["appointmentType"] }>;
  /** A placeholder (only the name is known): forms, templates and workflows. */
  placeholder?: boolean;
}

function captureColumn(nativeId: string | null, path: string, target: RefTarget, r: CaptureResolver, out: UnresolvedRef[], required = false): string | null {
  if (!nativeId) return null;
  const id = r.logicalId(target, nativeId);
  if (!id) out.push({ path, target, value: nativeId, required });
  return id ? toRef(id) : null;
}

/** The package asset for a workspace record, with logical ID `id` and every workspace ID replaced through `r`. */
export function fromNative<T extends AssetType>(type: T, id: string, record: NativeTypeMap[T], r: CaptureResolver, opts: FromNativeOptions = {}): Converted<AssetTypeMap[T]> {
  const un: UnresolvedRef[] = [];
  const mapper = captureMapper(r);
  const valueKey = (k: string) => r.valueKey(k);
  let value: unknown;
  switch (type) {
    case "folder": {
      const n = record as NativeTypeMap["folder"];
      value = { id, kind: n.kind, name: n.name };
      break;
    }
    case "tag": {
      const n = record as NativeTypeMap["tag"];
      value = { id, name: n.name, color: n.color, description: n.description, folder: captureColumn(n.folderId, "folder", "folder", r, un) };
      break;
    }
    case "customField": {
      const n = record as NativeTypeMap["customField"];
      value = { id, entity: n.entity, key: n.key, label: n.label, type: n.type, options: n.options.map((o) => ({ value: o.value, label: o.label })), required: n.required, helpText: n.helpText, groupName: n.groupName };
      break;
    }
    case "customValue": {
      const n = record as NativeTypeMap["customValue"];
      value = { id, key: r.valueKey(n.key) ?? n.key, label: n.label, type: n.type, value: n.value, required: n.required, groupName: n.groupName };
      break;
    }
    case "pipeline": {
      const n = record as NativeTypeMap["pipeline"];
      const stages = (opts.children ?? []).map((c) => {
        const s = fromNative("stage", c.id, c.record as NativeTypeMap["stage"], r);
        un.push(...s.unresolved);
        return s.value;
      });
      value = { id, name: n.name, description: n.description, isDefault: n.isDefault, stages };
      break;
    }
    case "stage": {
      const n = record as NativeTypeMap["stage"];
      value = { id, name: n.name, kind: n.kind, probability: n.probability, color: n.color };
      break;
    }
    case "calendar": {
      const n = record as NativeTypeMap["calendar"];
      const hosts: string[] = [];
      n.hostIds.forEach((h, i) => {
        const slot = r.logicalId("member", h);
        if (slot) hosts.push(toRef(slot));
        else un.push({ path: `hosts[${i}]`, target: "member", value: h, required: false });
      });
      const types = (opts.children ?? []).map((c) => {
        const t = fromNative("appointmentType", c.id, c.record as NativeTypeMap["appointmentType"], r);
        un.push(...t.unresolved);
        return t.value;
      });
      value = {
        id, name: n.name, description: n.description, assignment: n.assignment, roundRobinMode: n.roundRobinMode, color: n.color, folder: captureColumn(n.folderId, "folder", "folder", r, un),
        bookingIntro: n.bookingIntro, timezone: n.timezone, hours: n.hoursTemplate.map((h) => ({ weekday: h.weekday, startMinute: h.startMinute, endMinute: h.endMinute })), hosts, types,
      };
      break;
    }
    case "appointmentType": {
      const { calendarId: _cal, ...rest } = record as NativeTypeMap["appointmentType"];
      void _cal;
      value = { id, ...JSON.parse(JSON.stringify(rest)) };
      break;
    }
    case "smartList": {
      const n = record as NativeTypeMap["smartList"];
      const filter = mapFilterRefs(n.filter, n.entity, "native", mapper, "filter");
      const columns = mapColumnRefs(n.columns, n.entity, "native", mapper, "columns");
      un.push(...toUnresolved(filter.unresolved), ...toUnresolved(columns.unresolved));
      value = {
        id, entity: n.entity, name: n.name, description: n.description, folder: captureColumn(n.folderId, "folder", "folder", r, un), filter: cleanFilter(filter.value), columns: columns.value,
        sort: n.sort?.by ? { by: n.sort.by, ...(n.sort.dir ? { dir: n.sort.dir } : {}) } : {}, isDefault: n.isDefault,
      };
      break;
    }
    case "assignmentRule": {
      const n = record as NativeTypeMap["assignmentRule"];
      const { reassignOwned, ...filter } = n.conditions ?? { op: "and", conditions: [] };
      const cond = mapFilterRefs(filter as FilterGroup, "contact", "native", mapper, "conditions");
      un.push(...toUnresolved(cond.unresolved));
      const members: Array<{ member: string; weight: number; priority: number }> = [];
      n.members.forEach((m, i) => {
        const slot = r.logicalId("member", m.userId);
        if (slot) members.push({ member: toRef(slot), weight: m.weight, priority: m.priority });
        else un.push({ path: `members[${i}].member`, target: "member", value: m.userId, required: false });
      });
      value = {
        id, name: n.name, entity: n.entity, conditions: cleanFilter(cond.value), reassignOwned: reassignOwned === true, strategy: n.strategy, respectWorkingHours: n.respectWorkingHours,
        fallback: n.fallback, fallbackMember: captureColumn(n.fallbackUserId, "fallbackMember", "member", r, un, n.fallback === "fallback_user"), members,
      };
      break;
    }
    case "form": {
      const n = record as NativeTypeMap["form"];
      const draft = mapFormDraftRefs(n.draft, "native", mapper, "draft");
      un.push(...toUnresolved(draft.unresolved));
      value = { id, key: n.key, name: n.name, kind: n.kind, purpose: n.purpose, folder: captureColumn(n.folderId, "folder", "folder", r, un), draft: draft.value as BlueprintFormDraft, placeholder: opts.placeholder === true };
      break;
    }
    case "messageTemplate": {
      const n = record as NativeTypeMap["messageTemplate"];
      value = {
        id, kind: n.kind, key: n.key, name: n.name, channel: n.channel, purpose: n.purpose, category: n.category, folder: captureColumn(n.folderId, "folder", "folder", r, un),
        subject: n.subject === null ? null : rewriteValueTokens(n.subject, valueKey), body: rewriteValueTokens(n.body, valueKey), whatsapp: n.whatsapp ? { ...n.whatsapp } : null,
        placeholder: opts.placeholder === true,
      };
      break;
    }
    case "workflow": {
      const n = record as NativeTypeMap["workflow"];
      const mapped = mapWorkflowRefs(n.draft, "native", mapper, "definition");
      un.push(...toUnresolved(mapped.unresolved));
      value = {
        id, key: n.key, name: n.name, description: n.description, folder: captureColumn(n.folderId, "folder", "folder", r, un), hourlyRunLimit: n.hourlyRunLimit,
        definition: stripWorkspaceValues(rewriteWorkflowTokens(mapped.value as unknown as BlueprintWorkflowDefinition, valueKey)), placeholder: opts.placeholder === true,
      };
      break;
    }
    case "report": {
      const n = record as NativeTypeMap["report"];
      const cfg = mapReportConfigRefs(n.config, "native", mapper, "config");
      un.push(...toUnresolved(cfg.unresolved));
      const config = cfg.value as unknown as BlueprintReportConfig & { filters: { campaign?: string } };
      delete config.filters.campaign;
      value = { id, key: n.key, name: n.name, description: n.description, folder: captureColumn(n.folderId, "folder", "folder", r, un), config };
      break;
    }
  }
  return { value: value as AssetTypeMap[T], unresolved: un, notes: [] };
}

/** A filter with only the language's own keys (op, conditions; field, op, value), so a native extra never reaches a strict package. */
function cleanFilter(g: FilterGroup): FilterGroup {
  return {
    op: g.op,
    conditions: (g.conditions ?? []).map((c) => ("conditions" in c && Array.isArray(c.conditions) ? cleanFilter(c as FilterGroup) : {
      field: (c as { field: string }).field, op: (c as { op: string }).op, ...((c as { value?: unknown }).value !== undefined ? { value: (c as { value?: unknown }).value } : {}),
    })),
  };
}

/** Removes the values that belong to one workspace: the inbound webhook nonce and send steps' content hashes. */
export function stripWorkspaceValues<T extends { trigger: object; steps: Array<{ kind: string; config: Record<string, unknown> }> }>(def: T): T {
  const out = JSON.parse(JSON.stringify(def)) as T;
  const trig = out.trigger as Record<string, unknown>;
  if (trig.inbound && typeof trig.inbound === "object") {
    const { nonce: _nonce, ...rest } = trig.inbound as Record<string, unknown>;
    void _nonce;
    trig.inbound = rest;
  }
  for (const s of out.steps) if ((s.kind === "send_message" || s.kind === "request_review") && s.config) delete s.config.contentHash;
  return out;
}

// ---------------------------------------------------------------------------
// Fingerprints: what customization and change detection hash
// ---------------------------------------------------------------------------

/** Drops references to people and connections (slots) and customer records: mapping them is setup, not customization. */
const dropMapped: RefMapper = (value, site) => (site.target === "member" || site.target === "n8n" || site.target === "webhook" || site.target === "record" ? null : value);

const sortedHours = (h: Array<{ weekday: number; startMinute: number; endMinute: number }>) =>
  [...h].map((x) => ({ weekday: x.weekday, startMinute: x.startMinute, endMinute: x.endMinute })).sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute || a.endMinute - b.endMinute);

/**
 * What a workspace record's customization fingerprint covers: the columns a Blueprint controls, without the workspace's own state (status,
 * slugs, positions, defaults, approvals, owners, the parent's ID), without people and connections mapped during setup, and without
 * workspace-only values (inbound nonces, template content hashes, editor layout). Hash it right after a write (native_hash); a later
 * different hash means the client changed the record.
 */
export function nativeProjection<T extends AssetType>(type: T, record: NativeTypeMap[T]): Record<string, unknown> {
  switch (type) {
    case "folder": {
      const n = record as NativeTypeMap["folder"];
      return { kind: n.kind, name: n.name };
    }
    case "tag": {
      const n = record as NativeTypeMap["tag"];
      return { name: n.name, color: n.color, description: n.description ?? null, folderId: n.folderId ?? null };
    }
    case "customField": {
      const n = record as NativeTypeMap["customField"];
      return { entity: n.entity, key: n.key, label: n.label, type: n.type, options: n.options.map((o) => ({ value: o.value, label: o.label })), required: n.required, helpText: n.helpText ?? null, groupName: n.groupName ?? null };
    }
    case "customValue": {
      const n = record as NativeTypeMap["customValue"];
      return { key: n.key, label: n.label, type: n.type, value: n.value, required: n.required, groupName: n.groupName ?? null };
    }
    case "pipeline": {
      const n = record as NativeTypeMap["pipeline"];
      return { name: n.name, description: n.description ?? null };
    }
    case "stage": {
      const n = record as NativeTypeMap["stage"];
      return { name: n.name, kind: n.kind, probability: n.probability ?? null, color: n.color ?? null };
    }
    case "calendar": {
      const n = record as NativeTypeMap["calendar"];
      return {
        name: n.name, description: n.description ?? null, assignment: n.assignment, roundRobinMode: n.roundRobinMode, color: n.color ?? null, folderId: n.folderId ?? null,
        bookingIntro: n.bookingIntro ?? null, timezone: n.timezone ?? null, hoursTemplate: sortedHours(n.hoursTemplate ?? []),
      };
    }
    case "appointmentType": {
      // Whether a type is offered for online booking is the workspace's own switch (a Blueprint sets it only when it creates the type, and
      // never on a calendar that already takes bookings), so turning booking on or off isn't a customization and is never overwritten.
      const { calendarId: _cal, public: _public, ...rest } = record as NativeTypeMap["appointmentType"];
      void _cal;
      void _public;
      return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
    }
    case "smartList": {
      const n = record as NativeTypeMap["smartList"];
      return {
        entity: n.entity, name: n.name, description: n.description ?? null, folderId: n.folderId ?? null, filter: mapFilterRefs(n.filter, n.entity, "native", dropMapped).value,
        columns: [...n.columns], sort: n.sort ?? {},
      };
    }
    case "assignmentRule": {
      const n = record as NativeTypeMap["assignmentRule"];
      const { reassignOwned, ...filter } = n.conditions ?? { op: "and", conditions: [] };
      return {
        name: n.name, entity: n.entity, conditions: mapFilterRefs(filter as FilterGroup, "contact", "native", dropMapped).value, reassignOwned: reassignOwned === true,
        strategy: n.strategy, respectWorkingHours: n.respectWorkingHours, fallback: n.fallback,
      };
    }
    case "form": {
      const n = record as NativeTypeMap["form"];
      return { key: n.key, name: n.name, kind: n.kind, purpose: n.purpose, folderId: n.folderId ?? null, draft: n.draft as FormDraft };
    }
    case "messageTemplate": {
      const n = record as NativeTypeMap["messageTemplate"];
      return { kind: n.kind, key: n.key, name: n.name, channel: n.channel, purpose: n.purpose, category: n.category ?? null, folderId: n.folderId ?? null, subject: n.subject ?? null, body: n.body };
    }
    case "workflow": {
      const n = record as NativeTypeMap["workflow"];
      const stripped = stripWorkspaceValues(n.draft as unknown as { trigger: object; steps: Array<{ kind: string; config: Record<string, unknown> }> });
      for (const s of stripped.steps as Array<Record<string, unknown>>) delete s.ui;
      return { key: n.key, name: n.name, description: n.description ?? null, folderId: n.folderId ?? null, hourlyRunLimit: n.hourlyRunLimit, draft: mapWorkflowRefs(stripped, "native", dropMapped).value };
    }
    case "report": {
      const n = record as NativeTypeMap["report"];
      return { key: n.key, name: n.name, description: n.description ?? null, folderId: n.folderId ?? null, report: n.report, config: mapReportConfigRefs(n.config, "native", dropMapped).value };
    }
  }
  return {};
}

/**
 * What an asset's change fingerprint covers (asset_hash): the asset as the package states it, without its nested children (stages and
 * appointment types have fingerprints of their own). A later different hash means the Blueprint changed that asset.
 */
export function assetFingerprint<T extends AssetType>(type: T, asset: AssetTypeMap[T]): Record<string, unknown> {
  const a = JSON.parse(JSON.stringify(asset)) as Record<string, unknown>;
  if (type === "pipeline") delete a.stages;
  if (type === "calendar") delete a.types;
  return a;
}

// ---------------------------------------------------------------------------
// Identity in a target workspace
// ---------------------------------------------------------------------------

/** How each type is matched to an existing workspace record that was never linked to this Blueprint. */
export const IDENTITY: Record<AssetType, { scope: "workspace" | "parent"; describe: string }> = {
  folder: { scope: "workspace", describe: "A folder of the same kind with the same name (ignoring case)." },
  tag: { scope: "workspace", describe: "A tag with the same name (ignoring case)." },
  customField: { scope: "workspace", describe: "A field of the same record type with the same key, archived fields included (they are restored, not duplicated)." },
  customValue: { scope: "workspace", describe: "A configuration value with the same key." },
  pipeline: { scope: "workspace", describe: "An active iAcquire pipeline with the same name (ignoring case)." },
  stage: { scope: "parent", describe: "A stage of the matched pipeline with the same name (ignoring case)." },
  calendar: { scope: "workspace", describe: "A calendar that isn't archived with the same name (ignoring case)." },
  appointmentType: { scope: "parent", describe: "An appointment type of the matched calendar with the same name (ignoring case)." },
  smartList: { scope: "workspace", describe: "A team Smart List of the same record type with the same name (ignoring case)." },
  assignmentRule: { scope: "workspace", describe: "An assignment rule for the same record type with the same name (ignoring case)." },
  form: { scope: "workspace", describe: "A form that isn't archived with the same key." },
  messageTemplate: { scope: "workspace", describe: "A template or canned reply that isn't archived with the same key." },
  workflow: { scope: "workspace", describe: "A workflow that isn't archived with the same key." },
  report: { scope: "workspace", describe: "A saved report that isn't archived with the same key." },
};

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The identity of an asset or a native record (both shapes carry the same name / key / entity / kind fields). Two values with the same
 * identity key (within the same parent, for stages and appointment types) are the same thing in a workspace.
 */
export function identityKey(type: AssetType, x: { name?: string; key?: string; entity?: string; kind?: string }): string {
  switch (type) {
    case "folder":
      return `${x.kind}:${norm(x.name)}`;
    case "customField":
      return `${x.entity}:${x.key}`;
    case "customValue":
      return `${x.key}`;
    case "smartList":
    case "assignmentRule":
      return `${x.entity}:${norm(x.name)}`;
    case "form":
    case "messageTemplate":
    case "workflow":
    case "report":
      return `${x.key}`;
    default:
      return norm(x.name);
  }
}

// ---------------------------------------------------------------------------
// Copies ("copy" conflict decisions) and logical IDs for captured records
// ---------------------------------------------------------------------------

/** The longest name each type allows. */
export const NAME_MAX: Record<AssetType, number> = {
  folder: 80, tag: 60, customField: 80, customValue: 80, pipeline: 80, stage: 60, calendar: 80, appointmentType: 80, smartList: 80, assignmentRule: 80, form: 80,
  messageTemplate: 80, workflow: 80, report: 80,
};

/** "Name (Blueprint)", then "Name (Blueprint 2)" …, within the type's length limit and not in `taken` (lower-cased names). */
export function copyName(type: AssetType, name: string, taken: ReadonlySet<string>): string {
  const max = NAME_MAX[type];
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? " (Blueprint)" : ` (Blueprint ${i})`;
    const candidate = `${name.trim().slice(0, max - suffix.length)}${suffix}`;
    if (!taken.has(norm(candidate))) return candidate;
  }
  return `${name.trim().slice(0, max - 14)} (Blueprint *)`;
}

/** Which key alphabet a keyed type uses: fields and values use "_", forms and reports "-", templates and workflows either. */
const KEY_SEPARATOR: Partial<Record<AssetType, "_" | "-">> = { customField: "_", customValue: "_", form: "-", report: "-", messageTemplate: "_", workflow: "_" };

/** "key_2", "key_3" … (or "key-2" for forms and reports), at most 48 characters and not in `taken`. */
export function copyKey(type: AssetType, key: string, taken: ReadonlySet<string>): string {
  const sep = KEY_SEPARATOR[type] ?? "_";
  for (let i = 2; i < 1000; i++) {
    const suffix = `${sep}${i}`;
    const candidate = `${key.slice(0, 48 - suffix.length).replace(/[-_]+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${key.slice(0, 40)}${sep}${Date.now() % 100000}`;
}

/** A logical ID segment from any text: lower-case letters, digits, "-" and "_", 1 to `max` characters ("x" when nothing is left). */
export function idSegment(text: string, max = 40): string {
  const s = (text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, max)
    .replace(/[-_]+$/g, "");
  return s || "x";
}

/**
 * A logical ID for a captured record that is not in `taken` (which it is added to): "tag.<name>", "field.<entity>.<key>",
 * "stage.<pipeline>.<name>", "form.<key>" … `parentSegment` is the parent's last segment for stages and appointment types.
 */
export function suggestLogicalId(
  type: AssetType | SlotKind,
  x: { name?: string; key?: string; entity?: string; kind?: string; label?: string },
  taken: Set<string>,
  parentSegment?: string,
): string {
  const prefix = ID_PREFIX[type];
  let parts: string[];
  switch (type) {
    case "folder":
      parts = [idSegment(x.kind ?? "folder", 20), idSegment(x.name ?? "", 40)];
      break;
    case "customField":
      parts = [idSegment(x.entity ?? "contact", 20), idSegment(x.key ?? x.label ?? "", 48)];
      break;
    case "customValue":
    case "form":
    case "messageTemplate":
    case "workflow":
    case "report":
      parts = [idSegment(x.key ?? x.name ?? "", 48)];
      break;
    case "stage":
    case "appointmentType":
      parts = [idSegment(parentSegment ?? "x", 40), idSegment(x.name ?? "", 40)];
      break;
    default:
      parts = [idSegment(x.name ?? x.label ?? "", 48)];
  }
  const base = `${prefix}.${parts.join(".")}`.slice(0, LOGICAL_ID_MAX).replace(/[-_.]+$/, "");
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base.slice(0, LOGICAL_ID_MAX - String(i).length - 1).replace(/[-_.]+$/, "")}-${i}`;
  taken.add(id);
  return id;
}
