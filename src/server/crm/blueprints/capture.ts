import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { resolveCapabilities } from "@/server/crm/workspace";
import { authorizeBlueprintAction, type AgencyUser } from "@/server/crm/blueprints/access";
import { insertBlueprint } from "@/server/crm/blueprints/library";
import { readWorkspaceConfig, type NativeEntry, type WorkspaceConfig } from "@/server/crm/blueprints/native-io";
import { fromNative, suggestLogicalId, type CaptureResolver, type UnresolvedRef } from "@/lib/crm/blueprints/native";
import { dependencyGraph, listAssets, slotUsage, withDependencies } from "@/lib/crm/blueprints/refs";
import { validateContent, withheldValue, type ValidationIssue, type WithheldValue } from "@/lib/crm/blueprints/validate";
import {
  ASSET_SECTIONS, ASSET_TYPE_LABELS, BLUEPRINT_INDUSTRIES, SECTION_CAPABILITY, SECTION_LABELS, SECTION_TYPE, emptyBlueprint,
  type AnyAsset, type AssetSection, type AssetType, type BlueprintContent, type BlueprintIndustry, type NativeTypeMap, type RefTarget, type SlotAsset, type SlotKind,
} from "@/lib/crm/blueprints/types";
import { CAPTURE_ALWAYS_EXCLUDED, type CaptureCandidate, type CapturePreview } from "@/lib/crm/blueprints/views";
import { isGroup, type FilterCondition, type FilterGroup } from "@/lib/crm/filters";
import { ROLE_LABELS, type OrgRole } from "@/lib/permissions";
import type { CapabilityProvider, CrmMode } from "@/lib/crm/types";

// Capturing a reusable Blueprint from a client's Native CRM configuration, selectively. Configuration only: the readers in native-io never
// select contacts, companies, deals, messages, conversations, appointments, tasks, notes, files, submissions, credentials, tokens, payment
// details or AI memories, so none of it can reach a Blueprint. On top of that:
//
//  * People never travel. Hosts, assignment members, fallback people and workflow assignees become roles ("member.sales-rep") each
//    workspace maps for itself, labelled by role, never by name. Filter conditions on specific people or companies are left out, with a warning.
//  * Only team Smart Lists and team reports are captured (a private one belongs to one person).
//  * Configuration values keep their contents only when the agency asks (includeValues), and even then a value that looks like a
//    credential, code, a record ID of this workspace or contact details is left out (validate.ts → withheldValue).
//  * Every workspace ID becomes a logical ID (fromNative), and the result is validated like any package: an asset that fails is left out
//    with a warning rather than saved broken.
//
// The Blueprint is saved as a native draft with the client recorded as its source (source_org_id, named only to people who can reach that
// client); the capture is audited on the client's organization.

export interface CaptureInput {
  name: string;
  key?: string;
  description?: string;
  industry: BlueprintIndustry;
  sections: AssetSection[];
  /** Only these assets (by the logical IDs in the preview). Omitted: every capturable asset in the chosen sections. */
  assetIds?: string[];
  /** Keep configuration values' current values. Off by default: each client fills in their own. */
  includeValues: boolean;
}

const ROLE_SLOT_DESCRIPTION = "A person in the workspace this was captured from. Each workspace chooses who does this.";
const SLOT_DESCRIPTIONS: Record<SlotKind, string> = {
  member: ROLE_SLOT_DESCRIPTION,
  n8n: "An n8n automation. The agency verifies and maps one for each client.",
  webhook: "One of the client's own outbound webhook endpoints (each workspace adds its own, with its own signing secret).",
};

interface Captured {
  orgName: string;
  /** Everything capturable, converted (before selection). */
  content: BlueprintContent;
  candidates: CaptureCandidate[];
  /** Per asset: what was left out while converting it. */
  notes: Map<string, string[]>;
  warnings: string[];
}

interface CaptureOptions {
  includeValues: boolean;
}

/** Why a configuration value's contents were left out of a capture (validate.ts → withheldValue). */
const WITHHELD_NOTE: Record<WithheldValue, string> = {
  secret_name: "Its name suggests a credential, so its value was left out. Each workspace fills in its own.",
  too_long: "Its value is longer than 2,000 characters, so it was left out. Each workspace fills in its own.",
  secret: "Its value looked like a credential, so it was left out. Each workspace fills in its own.",
  unsafe: "Its value contained code, so it was left out. Each workspace fills in its own.",
  record_id: "Its value contained a record ID that only means something in this workspace, so it was left out.",
  personal: "Its value looks like contact details, which never travel in a Blueprint, so it was left out. Each workspace fills in its own.",
};

/** The source label of a Blueprint captured from a client. Never the client's name: every agency person sees the library, assigned or not. */
export const CAPTURED_SOURCE_LABEL = "Captured from a client workspace";

// ---------------------------------------------------------------------------
// Reading and converting the workspace
// ---------------------------------------------------------------------------

/** Removes filter conditions that name specific people or companies (and groups left empty). Returns how many were removed. */
function withoutPeople(filter: FilterGroup): { filter: FilterGroup; removed: number } {
  let removed = 0;
  const walk = (g: FilterGroup): FilterGroup => {
    const conditions: Array<FilterCondition | FilterGroup> = [];
    for (const c of g.conditions ?? []) {
      if (isGroup(c)) {
        const inner = walk(c);
        if (inner.conditions.length) conditions.push(inner);
        continue;
      }
      if ((c.field === "owner" || c.field === "company") && c.op === "is_any_of") {
        removed++;
        continue;
      }
      conditions.push(c);
    }
    return { op: g.op, conditions };
  };
  return { filter: walk(filter), removed };
}

/** A workflow with an HTTP request or Slack message step: its connection is this workspace's own, so it never travels. */
const usesConnections = (record: unknown) =>
  ((record as { draft?: { steps?: Array<{ kind?: string }> } }).draft?.steps ?? []).some((st) => st.kind === "http_request" || st.kind === "slack_message");

async function readCapture(db: Queryable, orgId: string, opts: CaptureOptions): Promise<Captured> {
  const org = (await db.query<{ name: string; kind: string }>("select name, kind from organizations where id = $1", [orgId])).rows[0];
  const ws = (await db.query<{ mode: CrmMode }>("select mode from crm_workspaces where org_id = $1", [orgId])).rows[0];
  const mode: CrmMode = ws?.mode ?? "native";
  if (mode === "ghl") throw new AppError("conflict", "This client's CRM is GoHighLevel, so there is no native configuration to capture. Import it from GoHighLevel instead.");
  const caps = resolveCapabilities(mode, (await db.query<{ capability: string; provider: CapabilityProvider }>("select capability, provider from crm_capability_providers where org_id = $1", [orgId])).rows);
  const ghlOwned = (s: AssetSection) => mode === "hybrid" && SECTION_CAPABILITY[s] !== null && caps[SECTION_CAPABILITY[s]!] === "ghl";

  // Live versions: what the client actually uses (a published form, an approved template, a running workflow's published version).
  const config: WorkspaceConfig = await readWorkspaceConfig(db, orgId, { live: true });
  const roles = new Map((await db.query<{ user_id: string; role: OrgRole }>(
    "select m.user_id, m.role from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.status = 'active' and u.status = 'active' order by m.created_at, m.user_id",
    [orgId],
  )).rows.map((r) => [r.user_id, r.role]));
  const n8n = new Map((await db.query<{ id: string; template_key: string }>("select id, template_key from automation_template_mappings where org_id = $1 and status = 'verified'", [orgId])).rows.map((r) => [r.id, r.template_key]));
  const hooks = new Map((await db.query<{ id: string; name: string }>("select id, name from crm_webhook_subscriptions where org_id = $1", [orgId])).rows.map((r) => [r.id, r.name]));

  const warnings: string[] = [];
  const notes = new Map<string, string[]>();
  const note = (id: string, text: string) => notes.set(id, [...(notes.get(id) ?? []), text]);
  const candidates: CaptureCandidate[] = [];
  const taken = new Set<string>();
  const logical = new Map<string, string>();
  const capturable = new Map<string, NativeEntry>();

  // Logical IDs for every record that can travel, parents before their children.
  const live = <T extends AssetType>(t: T) => (config.entries[t] as Array<NativeEntry<T>>).filter((e) => !e.archived);
  const assign = (e: NativeEntry, parentSegment?: string) => {
    const r = e.record as { name?: string; key?: string; entity?: string; kind?: string; label?: string };
    const id = suggestLogicalId(e.type, { name: r.name ?? r.label ?? e.name, key: r.key, entity: r.entity, kind: r.kind, label: r.label }, taken, parentSegment);
    logical.set(e.id, id);
    capturable.set(e.id, e);
    return id;
  };
  const top: Array<{ section: AssetSection; entry: NativeEntry; note: string | null; ok: boolean }> = [];
  for (const section of ASSET_SECTIONS) {
    const type = SECTION_TYPE[section];
    for (const e of live(type)) {
      if (ghlOwned(section)) {
        top.push({ section, entry: e, note: `${SECTION_LABELS[section]} are managed in GoHighLevel for this client, so they aren't captured from iAcquire.`, ok: false });
        continue;
      }
      if (type === "smartList" && e.meta.visibility !== "team") {
        top.push({ section, entry: e, note: "Private to one person, so it isn't captured. Share it with the team first to include it.", ok: false });
        continue;
      }
      if (type === "report" && e.meta.visibility !== "team") {
        top.push({ section, entry: e, note: "A private report belongs to one person, so it isn't captured. Share it with the team first to include it.", ok: false });
        continue;
      }
      if (type === "workflow" && usesConnections(e.record)) {
        top.push({ section, entry: e, note: "Calls an outside system through a connection (an HTTP request or a Slack message). A connection and its credentials belong to one workspace only, so this workflow isn't captured.", ok: false });
        continue;
      }
      const id = assign(e);
      const segment = id.split(".").slice(-1)[0];
      if (type === "pipeline") for (const s of live("stage").filter((x) => x.parentId === e.id)) assign(s, segment);
      if (type === "calendar") for (const t of live("appointmentType").filter((x) => x.parentId === e.id)) assign(t, segment);
      top.push({ section, entry: e, note: null, ok: true });
    }
  }

  // People become roles, labelled by role (never by name); connections become mapping slots.
  const slots = new Map<string, SlotAsset>();
  const slotTaken = new Set<string>();
  const slotFor = new Map<string, string>();
  const slotOf = (kind: SlotKind, nativeId: string): string | null => {
    const known = slotFor.get(`${kind}:${nativeId}`);
    if (known) return known;
    let labelText: string;
    if (kind === "member") {
      const role = roles.get(nativeId);
      if (!role) return null;
      labelText = ROLE_LABELS[role] ?? "Team member";
    } else if (kind === "n8n") {
      const m = n8n.get(nativeId);
      if (m === undefined) return null;
      labelText = m && m !== "agency-approved" ? m : "n8n automation";
    } else {
      const h = hooks.get(nativeId);
      if (h === undefined) return null;
      labelText = h || "Webhook endpoint";
    }
    const clean = labelText.replace(/\s+/g, " ").trim().slice(0, 60) || "Role";
    const id = suggestLogicalId(kind, { label: clean }, slotTaken);
    const n = [...slots.values()].filter((s) => s.label === clean || s.label.startsWith(`${clean} `)).length;
    slots.set(id, { id, label: n ? `${clean} ${n + 1}` : clean, description: SLOT_DESCRIPTIONS[kind] });
    slotFor.set(`${kind}:${nativeId}`, id);
    return id;
  };

  const fieldsByKey = new Map(live("customField").filter((f) => capturable.has(f.id)).map((f) => [`${f.record.entity}:${f.record.key}`, logical.get(f.id)!]));
  const resolver: CaptureResolver = {
    logicalId: (target: RefTarget, nativeId: string) => {
      if (target === "record") return null;
      if (target === "member" || target === "n8n" || target === "webhook") return slotOf(target, nativeId);
      const e = capturable.get(nativeId);
      return e && e.type === target ? logical.get(nativeId) ?? null : null;
    },
    fieldByKey: (entity, key) => fieldsByKey.get(`${entity}:${key}`) ?? null,
    valueKey: (k) => k,
  };

  const content = emptyBlueprint({ key: "capture", name: org?.name?.slice(0, 80) || "Captured", description: "", industry: "other" });
  const describe = (u: UnresolvedRef) => (u.target === "record" ? "a specific customer record" : u.target === "member" ? "a person who isn't an active member any more" : `${ASSET_TYPE_LABELS[u.target as AssetType] ?? u.target} that isn't captured`);

  for (const t of top) {
    if (!t.ok) {
      candidates.push({ assetId: suggestLogicalId(t.entry.type, { name: t.entry.name, key: (t.entry.record as { key?: string }).key, entity: (t.entry.record as { entity?: string }).entity }, new Set(taken)), assetType: t.entry.type, section: t.section, name: t.entry.name, note: t.note, capturable: false, dependsOn: [] });
      continue;
    }
    const e = t.entry;
    const id = logical.get(e.id)!;
    const record = JSON.parse(JSON.stringify(e.record)) as NativeTypeMap[AssetType];
    // Conditions on specific people or companies never travel.
    if (e.type === "smartList" || e.type === "assignmentRule") {
      const r = record as NativeTypeMap["smartList"] | NativeTypeMap["assignmentRule"];
      const source = e.type === "smartList" ? (r as NativeTypeMap["smartList"]).filter : (r as NativeTypeMap["assignmentRule"]).conditions;
      const cleaned = withoutPeople(source);
      if (cleaned.removed) note(id, `${cleaned.removed === 1 ? "A condition" : `${cleaned.removed} conditions`} on specific people or companies ${cleaned.removed === 1 ? "was" : "were"} left out.`);
      if (e.type === "smartList") (record as NativeTypeMap["smartList"]).filter = cleaned.filter;
      else (record as NativeTypeMap["assignmentRule"]).conditions = { ...cleaned.filter, ...((r as NativeTypeMap["assignmentRule"]).conditions.reassignOwned ? { reassignOwned: true } : {}) };
    }
    if (e.type === "workflow") {
      const w = record as NativeTypeMap["workflow"];
      let removed = 0;
      if (w.draft.trigger?.contactFilter) {
        const c = withoutPeople(w.draft.trigger.contactFilter);
        removed += c.removed;
        w.draft.trigger.contactFilter = c.filter;
      }
      for (const s of w.draft.steps ?? []) {
        const cfg = s.config as unknown as { filter?: FilterGroup };
        if (s.kind === "branch" && cfg.filter) {
          const c = withoutPeople(cfg.filter);
          removed += c.removed;
          cfg.filter = c.filter;
        }
      }
      if (removed) note(id, `${removed === 1 ? "A condition" : `${removed} conditions`} on specific people or companies ${removed === 1 ? "was" : "were"} left out of its filters.`);
      if (e.meta.live) note(id, "The published version this workspace runs was captured; it arrives as a draft wherever it is applied.");
    }
    if (e.type === "report") {
      const r = record as NativeTypeMap["report"];
      const f = r.config.filters as Record<string, unknown>;
      if (f.member) {
        delete f.member;
        note(id, "Its filter on one team member was left out.");
      }
      if (f.campaign) note(id, "Its filter on one campaign was left out.");
    }
    if (e.type === "customValue") {
      const v = record as NativeTypeMap["customValue"];
      if (!opts.includeValues) v.value = "";
      else {
        // The same rule as the GoHighLevel importer: credentials, code, this workspace's record IDs and contact details never travel. Only
        // the value is left out, never the whole configuration value.
        const withheld = withheldValue(v.label, v.key, v.value);
        if (withheld) {
          v.value = "";
          note(id, WITHHELD_NOTE[withheld]);
        }
      }
    }
    if (e.type === "form" && e.meta.live) note(id, "The published version visitors see was captured; it arrives unpublished wherever it is applied.");
    if (e.type === "messageTemplate" && e.meta.status === "approved") note(id, "The approved wording was captured; it arrives as a draft for each workspace to approve.");
    if (e.type === "calendar" && (record as NativeTypeMap["calendar"]).hostIds.length) note(id, "Its hosts become roles that each workspace maps to its own people.");

    const children = e.type === "pipeline"
      ? live("stage").filter((s) => s.parentId === e.id).map((s) => ({ id: logical.get(s.id)!, record: s.record }))
      : e.type === "calendar" ? live("appointmentType").filter((x) => x.parentId === e.id).map((x) => ({ id: logical.get(x.id)!, record: x.record })) : undefined;
    // A form without questions, a template without wording or a workflow without steps is only a name: it travels as a placeholder, so
    // wherever it is applied it is reported for rebuilding and never mistaken for a finished definition.
    const placeholder = (e.type === "form" && !(record as NativeTypeMap["form"]).draft.questions.length)
      || (e.type === "messageTemplate" && !(record as NativeTypeMap["messageTemplate"]).body.trim())
      || (e.type === "workflow" && !(record as NativeTypeMap["workflow"]).draft.steps.length);
    if (placeholder) note(id, "It has no content yet, so it is captured as a placeholder to be rebuilt.");
    const converted = fromNative(e.type, id, record as never, resolver, { children, placeholder });
    for (const u of converted.unresolved) note(id, `A reference to ${describe(u)} was left out (${u.path}).`);
    (content.assets[t.section] as AnyAsset[]).push(converted.value as AnyAsset);
    candidates.push({ assetId: id, assetType: e.type, section: t.section, name: e.name, note: (notes.get(id) ?? []).join(" ") || null, capturable: true, dependsOn: [] });
  }
  content.slots = [...slots.values()];
  const graph = dependencyGraph(content);
  for (const c of candidates) if (c.capturable) c.dependsOn = graph[c.assetId] ?? [];
  if (!opts.includeValues && content.assets.customValues.length) warnings.push("Configuration values are captured without their contents; each workspace fills in its own. Include values to keep them.");
  return { orgName: org?.name ?? "", content, candidates, notes, warnings };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export async function previewCapture(user: AgencyUser, orgId: string): Promise<CapturePreview> {
  return withSystem(async (db) => {
    const org = await authorizeBlueprintAction(db, user, "capture", orgId);
    const captured = await readCapture(db, orgId, { includeValues: false });
    return {
      orgId,
      orgName: org?.name ?? captured.orgName,
      candidates: captured.candidates,
      alwaysExcluded: [...CAPTURE_ALWAYS_EXCLUDED],
      warnings: captured.warnings,
    };
  });
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Only the chosen assets and everything they need, with only the slots they use. */
function narrow(content: BlueprintContent, keep: Set<string>): BlueprintContent {
  const out: BlueprintContent = { ...content, assets: { ...content.assets }, slots: [] };
  for (const section of ASSET_SECTIONS) {
    const list = (content.assets[section] as Array<{ id: string; stages?: Array<{ id: string }>; types?: Array<{ id: string }> }>)
      .filter((a) => keep.has(a.id))
      .map((a) => (a.stages ? { ...a, stages: a.stages.filter((s) => keep.has(s.id)) } : a.types ? { ...a, types: a.types.filter((t) => keep.has(t.id)) } : a));
    (out.assets as unknown as Record<string, unknown[]>)[section] = list;
  }
  const used = slotUsage({ assets: out.assets, slots: content.slots });
  out.slots = content.slots.filter((s) => (used[s.id] ?? []).length > 0);
  return out;
}

/**
 * Validates the captured content and leaves out every asset that fails (and, through the next round, whatever depended on it), so what is
 * saved is a valid package. Returns the content and a warning per asset left out.
 */
function keepValid(content: BlueprintContent): { content: BlueprintContent; dropped: ValidationIssue[]; warnings: ValidationIssue[] } {
  let current = content;
  const dropped: ValidationIssue[] = [];
  for (let round = 0; round < 25; round++) {
    const v = validateContent(current);
    if (v.ok && v.content) return { content: v.content, dropped, warnings: v.warnings };
    // Structural (schema) problems name a path rather than an asset: find the asset at that path.
    for (const e of v.errors) if (!e.assetId) e.assetId = assetAtPath(current, e.path);
    const bad = new Set(v.errors.map((e) => e.assetId).filter((id): id is string => Boolean(id)));
    const unowned = v.errors.filter((e) => !e.assetId);
    if (!bad.size) {
      throw new AppError("invalid_input", `This configuration can't be captured as a Blueprint: ${unowned[0]?.message ?? "it isn't valid."}`);
    }
    const names = new Map(listAssets(current).map((a) => [a.id, a.name]));
    for (const id of bad) {
      const first = v.errors.find((e) => e.assetId === id)!;
      dropped.push({ severity: "warning", code: "left_out", path: first.path, message: `“${names.get(id) ?? id}” was left out: ${first.message}`, assetId: id });
    }
    const keep = new Set(listAssets(current).map((a) => a.id).filter((id) => !bad.has(id)));
    current = narrow(current, keep);
  }
  throw new AppError("invalid_input", "This configuration can't be captured as a Blueprint. Try fewer sections.");
}

/** The asset a package path is about ("assets.workflows[2].definition…" → that workflow; a stage's or type's own path → that child). */
function assetAtPath(content: BlueprintContent, path: string): string | null {
  const m = /^assets\.(\w+)\[(\d+)\](?:\.(stages|types)\[(\d+)\])?/.exec(path);
  if (!m || !(ASSET_SECTIONS as readonly string[]).includes(m[1])) return null;
  const top = (content.assets[m[1] as AssetSection] as Array<{ id: string; stages?: Array<{ id: string }>; types?: Array<{ id: string }> }>)[Number(m[2])];
  if (!top) return null;
  return m[3] ? (top[m[3] as "stages" | "types"]?.[Number(m[4])]?.id ?? top.id) : top.id;
}

const BLUEPRINT_KEY = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
function keyFrom(name: string): string {
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56).replace(/-+$/g, "");
  return slug.length >= 3 ? slug : `${slug || "captured"}-blueprint`;
}

/** Creates a new draft Blueprint from the client's configuration. */
export async function captureFromClient(user: AgencyUser, orgId: string, input: CaptureInput): Promise<{ blueprintId: string; warnings: ValidationIssue[] }> {
  const name = (input.name ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw new AppError("invalid_input", "Name the Blueprint (up to 80 characters).");
  if (!(BLUEPRINT_INDUSTRIES as readonly string[]).includes(input.industry)) throw new AppError("invalid_input", "Choose an industry.");
  const sections = [...new Set(input.sections ?? [])];
  if (!sections.length || sections.some((s) => !(ASSET_SECTIONS as readonly string[]).includes(s))) throw new AppError("invalid_input", "Choose at least one part of the CRM to capture.");
  const key = input.key?.trim() ? input.key.trim() : keyFrom(name);
  if (!BLUEPRINT_KEY.test(key)) throw new AppError("invalid_input", "The key uses lower-case letters, numbers and hyphens (3 to 64 characters).");
  const description = (input.description ?? "").trim().slice(0, 1000);

  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "capture", orgId);
    const captured = await readCapture(db, orgId, { includeValues: input.includeValues === true });
    const known = new Map(captured.candidates.map((c) => [c.assetId, c]));
    const all = listAssets(captured.content);
    const allIds = new Set(all.map((a) => a.id));
    let chosen: string[];
    if (input.assetIds?.length) {
      const unknown = input.assetIds.filter((id) => !allIds.has(id));
      if (unknown.length) {
        const blocked = unknown.map((id) => known.get(id)).find((c) => c && !c.capturable);
        throw new AppError("invalid_input", blocked ? `“${blocked.name}” can't be captured: ${blocked.note}` : "One of the chosen items isn't in this client's CRM any more. Preview again.");
      }
      chosen = input.assetIds.filter((id) => sections.includes(all.find((a) => a.id === id)!.section));
    } else chosen = all.filter((a) => !a.parentId && sections.includes(a.section)).map((a) => a.id);
    if (!chosen.length) throw new AppError("invalid_input", "Nothing in the chosen sections can be captured from this client's CRM.");

    // What the chosen assets depend on comes too (a workflow's tags, a form's pipeline), whatever its section.
    const keep = withDependencies(captured.content, chosen);
    const narrowed = narrow(captured.content, keep);
    narrowed.blueprint = { key, name, description, industry: input.industry };
    const valid = keepValid(narrowed);
    const remaining = listAssets(valid.content).filter((a) => !a.parentId).length;
    if (!remaining) throw new AppError("invalid_input", `Nothing could be captured. ${valid.dropped[0]?.message ?? ""}`.trim());

    const conversionNotes: ValidationIssue[] = [];
    for (const a of listAssets(valid.content)) {
      for (const text of captured.notes.get(a.id) ?? []) conversionNotes.push({ severity: "warning", code: "captured_note", path: "", message: `“${a.name}”: ${text}`, assetId: a.id });
    }
    const added = [...keep].filter((id) => !chosen.includes(id) && !listAssets(captured.content).find((a) => a.id === id)?.parentId);
    const extras: ValidationIssue[] = added.length
      ? [{ severity: "warning", code: "dependencies_added", path: "", message: `${added.length} ${added.length === 1 ? "item was" : "items were"} added because the chosen ones need ${added.length === 1 ? "it" : "them"}.`, assetId: null }]
      : [];
    const generalWarnings: ValidationIssue[] = captured.warnings.map((w) => ({ severity: "warning", code: "capture", path: "", message: w, assetId: null }));

    // source_org_id records which client; the library names it only to people who can reach that client (getBlueprint's provenance).
    const saved = await insertBlueprint(db, user, { content: valid.content, source: "native", sourceLabel: CAPTURED_SOURCE_LABEL, sourceOrgId: orgId });
    const counts = Object.fromEntries(ASSET_SECTIONS.map((s) => [s, valid.content.assets[s].length]).filter(([, n]) => Number(n) > 0));
    await recordAudit({
      orgId, actorUserId: user.id, actorKind: "agency", action: "crm.blueprint_captured", targetType: "crm_blueprint", targetId: saved.id, result: "success",
      metadata: { blueprintKey: saved.key, sections, counts, includeValues: input.includeValues === true, leftOut: valid.dropped.length },
    }, db);
    return { blueprintId: saved.id, warnings: [...generalWarnings, ...extras, ...valid.dropped, ...conversionNotes, ...valid.warnings] };
  });
}
