import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { loadWorkspace, resolveCapabilities } from "@/server/crm/workspace";
import { compileCompanyFilter, compileContactFilter, type CustomFieldMeta } from "@/server/crm/filter-sql";
import { compileOpportunityFilter } from "@/server/crm/workflows/conditions";
import { activeWorkflowsUsingField } from "@/server/crm/workflows/references";
import { loadCustomFieldMetas } from "@/server/crm/directory";
import { parseHoursTemplate } from "@/server/calendars/setup";
import { templateContentHash } from "@/server/crm/message-templates";
import {
  assertIdempotencyKey, assetHash, authorizeBlueprintAction, canDoBlueprint, contentDigest, isUuid, lockClientForBlueprint, nativeHash, newInboundNonce, planDigest,
  type AgencyUser,
} from "@/server/crm/blueprints/access";
import {
  createRecord, deleteRecord, inUseReason, readEntry, readWorkspaceConfig, templateContent, updateRecord, type NativeEntry, type WorkspaceConfig, type WriteContext,
} from "@/server/crm/blueprints/native-io";
import { changedFields } from "@/lib/crm/blueprints/diff";
import { migrateToCurrent, FormatError } from "@/lib/crm/blueprints/migrate";
import { ENVELOPE_KEYS } from "@/lib/crm/blueprints/package";
import { assetDependencies, listAssets, slotUsage, withDependencies, type AssetEntry } from "@/lib/crm/blueprints/refs";
import { requirementDetails } from "@/lib/crm/blueprints/requirements";
import { validateContent } from "@/lib/crm/blueprints/validate";
import { copyKey, copyName, identityKey, nativeProjection, toNative, type ApplyResolver, type UnresolvedRef } from "@/lib/crm/blueprints/native";
import {
  APPLY_STRATEGIES, ASSET_SECTIONS, ASSET_TYPE_LABELS, BLUEPRINT_SCHEMA_VERSION, CONFLICT_DECISIONS, PLAN_ACTIONS, SECTION_CAPABILITY, SECTION_LABELS, SLOT_KIND_LABELS, isSlotKind, typeOfId,
  type ApplicationPlan, type ApplicationStatus, type ApplyOptions, type AssetSection, type AssetType, type AssetTypeMap, type BlueprintContent, type ConflictDecision,
  type NativeTypeMap, type PlanAction, type PlanItem, type SlotKind,
} from "@/lib/crm/blueprints/types";
import type { ApplicationDetail, ApplicationItemView, ApplicationSummary, ApplyPreview, ApplyResult, RollbackResult, SlotMappingView } from "@/lib/crm/blueprints/views";
import { normalizeCustomValue } from "@/lib/crm/custom-values";
import { readDraft } from "@/lib/crm/forms/spec";
import { parseFilter, type FilterGroup } from "@/lib/crm/filters";
import { validateTemplate } from "@/lib/messaging/tokens";
import { reportConfigSchema } from "@/components/crm/reports/spec";
import { liveUpdateAvailable } from "@/server/crm/blueprints/library";
import { pickUpSetupEvidence } from "@/server/setup/evidence-pickup";
import type { CapabilityProvider, CrmCapability, CrmMode } from "@/lib/crm/types";

// Applying a published Blueprint version to one client workspace.
//
//  * planApplication / previewApplication: a dry run. Nothing is written. Every asset gets an action (create, link, unchanged, update,
//    skip, conflict, blocked) with the reason in plain words, the record it matches and what differs, and the whole plan gets a digest.
//  * applyBlueprint / applyContentInTx: one transaction under the workspace's Blueprint lock. The plan is made again there; if its digest
//    differs from the one the person confirmed, nothing is applied ("Preview again"). Each asset is written in its own savepoint, so one
//    that fails is recorded and skipped without undoing the others. Records are independent copies in the client's workspace, linked to the
//    asset they came from with two fingerprints (the asset as applied, the record as written), which is how a later apply tells a record the
//    client customized from one it may update. The same confirmation (idempotency key) submitted twice returns the first application.
//  * rollbackApplication: only the newest live application of a Blueprint in a workspace. Created records are deleted only when unchanged
//    since and unused (a copy's or re-added record's asset is linked back to the workspace's own record); updated records are restored only
//    when unchanged since, when the data stored since still fits the earlier version, and when that doesn't take back an approval given
//    since; everything else is kept, with the reason.
//
// Nothing is ever deleted by applying. Calendars arrive as drafts (no bookings until verified), appointment types added to a calendar that
// already takes bookings with online booking off, workflows and templates as drafts, forms unpublished, assignment rules switched off unless
// all their people are mapped when applied (a rule that only keeps existing owners needs nobody, so it arrives on). People never travel: hosts, owners and assignees are mapping
// slots the workspace fills in. A workspace on GoHighLevel is refused; in a hybrid workspace the sections GoHighLevel owns are blocked.

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlanInput {
  blueprintId: string;
  /** A published version. Omitted: the latest published version. */
  version?: number;
  options: ApplyOptions;
}

export interface ApplyInput extends PlanInput {
  version: number;
  /** The digest of the plan the person confirmed. If the workspace changed since, the apply is refused and must be previewed again. */
  planDigest: string;
  /** One per confirmation; resubmitting the same key returns the first result. */
  idempotencyKey: string;
}

const LOCK = "select pg_advisory_xact_lock(hashtext('crm-blueprint:' || $1::text))";
const CHANGED_SINCE_PREVIEW = "The workspace changed since the preview. Preview again.";
const MAX_PIPELINES = 25;
const MAX_STAGES = 30;
const MAX_WORKFLOWS = 500;
const MAX_REPORTS = 200;
const MAX_VALUES = 200;
const MAX_RULES = 50;

// ---------------------------------------------------------------------------
// Loading a published version
// ---------------------------------------------------------------------------

interface LoadedVersion {
  blueprintId: string;
  blueprintKey: string;
  blueprintName: string;
  versionId: string;
  version: number;
  latestVersion: number | null;
  content: BlueprintContent;
}

/**
 * A published version as stored, checked again before use: its integrity digest, a format upgrade when it was published by an older
 * build, and full validation. An archived Blueprint isn't applied.
 */
async function loadVersion(db: Queryable, blueprintId: string, version?: number | null, opts: { versionId?: string } = {}): Promise<LoadedVersion> {
  if (!isUuid(blueprintId)) throw new AppError("not_found", "Blueprint not found.");
  const b = (await db.query<{ id: string; key: string; name: string; status: string; current_version: number | null }>(
    "select id, key, name, status, current_version from crm_blueprints where id = $1",
    [blueprintId],
  )).rows[0];
  if (!b) throw new AppError("not_found", "Blueprint not found.");
  if (b.status === "archived") throw new AppError("conflict", "This Blueprint is archived. Restore it in the library before applying it.");
  const wanted = version ?? b.current_version;
  if (!wanted && !opts.versionId) throw new AppError("conflict", "This Blueprint has no published version yet. Publish it first: only published versions are applied.");
  const v = (await db.query<{ id: string; version: number; package: Record<string, unknown>; digest: string; schema_version: number }>(
    opts.versionId
      ? "select id, version, package, digest, schema_version from crm_blueprint_versions where blueprint_id = $1 and id = $2::uuid"
      : "select id, version, package, digest, schema_version from crm_blueprint_versions where blueprint_id = $1 and version = $2",
    [blueprintId, opts.versionId ?? wanted],
  )).rows[0];
  if (!v) throw new AppError("not_found", "That version of the Blueprint doesn't exist.");
  if (contentDigest(v.package as unknown as BlueprintContent) !== v.digest) {
    throw new AppError("conflict", "This published version failed its integrity check, so it isn't applied. Publish the Blueprint again.");
  }
  let raw: Record<string, unknown> = v.package;
  if (Number(raw.schemaVersion) !== BLUEPRINT_SCHEMA_VERSION) {
    try {
      raw = migrateToCurrent(raw).value;
    } catch (err) {
      if (err instanceof FormatError) throw new AppError("conflict", `This version can't be applied: ${err.message}`);
      throw err;
    }
  }
  const content: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(raw)) if (!(ENVELOPE_KEYS as readonly string[]).includes(k)) content[k] = val;
  const checked = validateContent(content);
  if (!checked.ok || !checked.content) {
    throw new AppError("conflict", `This version can't be applied: ${checked.errors[0]?.message ?? "it isn't a valid Blueprint."}`);
  }
  return { blueprintId: b.id, blueprintKey: b.key, blueprintName: b.name, versionId: v.id, version: v.version, latestVersion: b.current_version, content: checked.content };
}

// ---------------------------------------------------------------------------
// The workspace as the planner sees it
// ---------------------------------------------------------------------------

interface LinkRow {
  assetId: string;
  assetType: string;
  nativeId: string;
  appliedVersion: number;
  assetHash: string;
  nativeHash: string;
  applicationId: string;
}

interface WorkspaceState {
  orgId: string;
  orgName: string;
  timezone: string;
  mode: CrmMode;
  switching: boolean;
  capabilities: Record<CrmCapability, CapabilityProvider>;
  defaultCallingCode: string | null;
  config: WorkspaceConfig;
  links: Map<string, LinkRow>;
  /** native ID → the asset of this Blueprint linked to it. */
  linkedNative: Map<string, string>;
  hasLiveApplication: boolean;
  /** People who can be given records: the same rule as assignment and workflow pickers (active members who can see contacts). */
  people: Map<string, string>;
  n8n: Map<string, string>;
  webhooks: Map<string, string>;
  firstOwnerId: string | null;
  /** Slot mappings remembered from the latest application of this Blueprint here. */
  rememberedSlots: Record<string, string>;
}

/** Active members who can own records (owner, or a role/override with contacts.view), as src/server/crm/assignment.ts decides. */
const CAN_OWN = `(m.status = 'active' and u.status = 'active' and (m.role = 'owner' or coalesce(
  (select o.effect = 'grant' from member_permission_overrides o where o.org_id = m.org_id and o.user_id = m.user_id and o.permission = 'contacts.view'),
  exists (select 1 from role_permissions rp where rp.role = m.role and rp.permission = 'contacts.view'))))`;

async function readMode(db: Queryable, orgId: string) {
  const ws = (await db.query<{ mode: CrmMode; switching: boolean; default_calling_code: string | null }>(
    "select mode, switching, default_calling_code from crm_workspaces where org_id = $1",
    [orgId],
  )).rows[0];
  const caps = await db.query<{ capability: string; provider: CapabilityProvider }>("select capability, provider from crm_capability_providers where org_id = $1", [orgId]);
  const mode: CrmMode = ws?.mode ?? "native";
  return { mode, switching: ws?.switching === true, defaultCallingCode: ws?.default_calling_code ?? null, capabilities: resolveCapabilities(mode, caps.rows) };
}

async function loadState(db: Queryable, org: { id: string; name: string; timezone: string }, blueprintId: string): Promise<WorkspaceState> {
  const orgId = org.id;
  const mode = await readMode(db, orgId);
  const config = await readWorkspaceConfig(db, orgId);
  const links = new Map<string, LinkRow>();
  const linkedNative = new Map<string, string>();
  for (const l of (await db.query<{ asset_id: string; asset_type: string; native_id: string; applied_version: number; asset_hash: string; native_hash: string; application_id: string }>(
    "select asset_id, asset_type, native_id, applied_version, asset_hash, native_hash, application_id from crm_blueprint_links where org_id = $1 and blueprint_id = $2",
    [orgId, blueprintId],
  )).rows) {
    links.set(l.asset_id, { assetId: l.asset_id, assetType: l.asset_type, nativeId: l.native_id, appliedVersion: l.applied_version, assetHash: l.asset_hash, nativeHash: l.native_hash, applicationId: l.application_id });
    linkedNative.set(l.native_id, l.asset_id);
  }
  const live = (await db.query<{ summary: { slotMappings?: Record<string, string> } }>(
    "select summary from crm_blueprint_applications where org_id = $1 and blueprint_id = $2 and status in ('applied', 'partially_applied') order by created_at desc, id desc limit 1",
    [orgId, blueprintId],
  )).rows[0];
  const people = new Map((await db.query<{ id: string; name: string }>(
    `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name from organization_memberships m join users u on u.id = m.user_id
     where m.org_id = $1 and ${CAN_OWN} order by lower(coalesce(nullif(u.full_name, ''), u.email::text))`,
    [orgId],
  )).rows.map((r) => [r.id, r.name]));
  const n8n = new Map((await db.query<{ id: string; template_key: string; workflow_id: string }>(
    "select id, template_key, workflow_id from automation_template_mappings where org_id = $1 and status = 'verified' order by template_key, workflow_id",
    [orgId],
  )).rows.map((r) => [r.id, r.template_key === "agency-approved" ? `n8n workflow ${r.workflow_id}` : r.template_key]));
  const webhooks = new Map((await db.query<{ id: string; name: string }>("select id, name from crm_webhook_subscriptions where org_id = $1 and active order by lower(name)", [orgId])).rows.map((r) => [r.id, r.name]));
  const owner = (await db.query<{ user_id: string }>(
    `select m.user_id from organization_memberships m join users u on u.id = m.user_id
     where m.org_id = $1 and m.role = 'owner' and m.status = 'active' and u.status = 'active' order by m.created_at, m.user_id limit 1`,
    [orgId],
  )).rows[0];
  return {
    orgId, orgName: org.name, timezone: org.timezone || "UTC", ...mode, config, links, linkedNative, hasLiveApplication: Boolean(live), people, n8n, webhooks,
    firstOwnerId: owner?.user_id ?? null, rememberedSlots: live?.summary?.slotMappings ?? {},
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Checks the options against the package and the workspace. Slot mappings must name this workspace's own people and connections. The
 * mappings chosen at an earlier application of this Blueprint here still hold (so an update never drops the people a workflow names),
 * unless the options map a role again or clear it with an empty value; the plan, its digest and the application use the merged result.
 */
function checkOptions(options: ApplyOptions, content: BlueprintContent, state: WorkspaceState): ApplyOptions {
  if (!options || typeof options !== "object") throw new AppError("invalid_input", "Choose how to apply this Blueprint.");
  if (!(APPLY_STRATEGIES as readonly string[]).includes(options.strategy)) throw new AppError("invalid_input", "Choose Add missing or Update compatible.");
  const sections = options.sections?.length ? [...new Set(options.sections)] : undefined;
  if (sections?.some((s) => !(ASSET_SECTIONS as readonly string[]).includes(s))) throw new AppError("invalid_input", "Choose sections from the list.");
  const index = new Set(listAssets(content).map((e) => e.id));
  const assetIds = options.assetIds?.length ? [...new Set(options.assetIds)] : undefined;
  if (assetIds && (assetIds.length > 2000 || assetIds.some((id) => !index.has(id)))) throw new AppError("invalid_input", "One of the chosen items isn't in this version of the Blueprint.");
  const decisions: Record<string, ConflictDecision> = {};
  for (const [id, d] of Object.entries(options.decisions ?? {})) {
    if (!index.has(id) || !(CONFLICT_DECISIONS as readonly string[]).includes(d)) throw new AppError("invalid_input", "A decision names something that isn't in this Blueprint.");
    decisions[id] = d;
  }
  const declared = new Map(content.slots.map((s) => [s.id, s]));
  const slotMappings: Record<string, string> = {};
  const known = (slotId: string, target: string) => {
    const kind = typeOfId(slotId) as SlotKind;
    return (kind === "member" ? state.people : kind === "n8n" ? state.n8n : state.webhooks).has(target);
  };
  for (const [slotId, target] of Object.entries(state.rememberedSlots)) if (declared.has(slotId) && isUuid(target) && known(slotId, target)) slotMappings[slotId] = target;
  for (const [slotId, target] of Object.entries(options.slotMappings ?? {})) {
    const slot = declared.get(slotId);
    if (!slot) throw new AppError("invalid_input", "A mapping names a role this Blueprint doesn't have.");
    if (!target) {
      delete slotMappings[slotId];
      continue;
    }
    const kind = typeOfId(slotId) as SlotKind;
    if (!isUuid(target) || !known(slotId, target)) {
      const what = kind === "member" ? "an active person in this workspace who can own records" : kind === "n8n" ? "a verified n8n automation for this client" : "an active webhook endpoint of this workspace";
      throw new AppError("invalid_input", `Choose ${what} for “${slot.label}”.`);
    }
    slotMappings[slotId] = target;
  }
  return {
    strategy: options.strategy,
    ...(sections ? { sections: ASSET_SECTIONS.filter((s) => sections.includes(s)) } : {}),
    ...(assetIds ? { assetIds: [...assetIds].sort() } : {}),
    ...(Object.keys(decisions).length ? { decisions } : {}),
    ...(Object.keys(slotMappings).length ? { slotMappings } : {}),
  };
}

/** The assets this apply writes: the chosen sections, narrowed to the chosen assets and what they depend on. The rest is only looked up. */
function selection(content: BlueprintContent, options: ApplyOptions): Set<string> {
  const entries = listAssets(content);
  const sections = options.sections?.length ? new Set<AssetSection>(options.sections) : null;
  let ids = entries.filter((e) => !sections || sections.has(e.section)).map((e) => e.id);
  if (options.assetIds?.length) {
    const closure = withDependencies(content, options.assetIds);
    ids = ids.filter((id) => closure.has(id));
  }
  return new Set(ids);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** How a logical ID resolves in the workspace while planning or applying. */
interface Res {
  nativeId: string;
  /** Created by this apply (a stand-in ID while planning). */
  planned: boolean;
  fieldKey?: string;
  valueKey?: string;
  contentHash?: string | null;
}

type Op =
  | {
    kind: "create"; asset: AssetTypeMap[AssetType]; recreate: boolean; copy: boolean; position?: number; makeDefault?: boolean; active?: boolean;
    /** Appointment types added to a calendar that already takes bookings: created with online booking off. */
    private?: boolean;
  }
  | { kind: "update"; entry: NativeEntry; restore: boolean }
  | { kind: "link"; entry: NativeEntry }
  | { kind: "none"; entry: NativeEntry | null };

interface PlanResult {
  plan: ApplicationPlan;
  ops: Map<string, Op>;
  entries: Map<string, AssetEntry>;
  warnings: string[];
}

interface Analysis {
  action: PlanAction;
  reason: string;
  existing: NativeEntry | null;
  changes: string[];
  decision: ConflictDecision | null;
  op: Op;
  /** Conflicts only: "update" can be taken for it (PlanItem.updatable). False when left out. */
  updatable?: boolean;
}

const lower =(s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const label = (type: AssetType) => ASSET_TYPE_LABELS[type];
const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");

/** The Blueprint's record after the same normalizations the CRM applies when it saves one, so fingerprints compare like with like. */
function prepare<T extends AssetType>(type: T, record: NativeTypeMap[T], state: WorkspaceState, notes: string[]): NativeTypeMap[T] {
  const r = JSON.parse(JSON.stringify(record)) as NativeTypeMap[T];
  switch (type) {
    case "customField": {
      const f = r as NativeTypeMap["customField"];
      if (f.type !== "select" && f.type !== "multiselect") f.options = [];
      break;
    }
    case "customValue": {
      const v = r as NativeTypeMap["customValue"];
      const n = normalizeCustomValue(v.type, v.value, { defaultCallingCode: state.defaultCallingCode });
      if (n.ok) v.value = n.value;
      else {
        notes.push(`The example for “${v.label}” isn't valid here (${n.error}), so it starts empty.`);
        v.value = "";
      }
      break;
    }
    case "calendar": {
      const c = r as NativeTypeMap["calendar"];
      c.hoursTemplate = parseHoursTemplate(c.hoursTemplate);
      // Hosts are people: a calendar from a Blueprint never gets hosts here; the workspace assigns its own.
      c.hostIds = [];
      break;
    }
    case "appointmentType": {
      const t = r as NativeTypeMap["appointmentType"];
      t.questions = t.questions.map((q) => ({ key: q.key, label: q.label.trim(), type: q.type, required: q.required === true, ...(q.type === "select" ? { options: (q.options ?? []).map((o) => o.trim()) } : {}) }));
      break;
    }
    case "smartList": {
      const l = r as NativeTypeMap["smartList"];
      l.sort = l.sort?.by ? { by: l.sort.by, dir: l.sort.dir === "asc" ? "asc" : "desc" } : {};
      l.columns = [...new Set(l.columns)].slice(0, 30);
      break;
    }
    case "assignmentRule": {
      const a = r as NativeTypeMap["assignmentRule"];
      const reassign = a.strategy !== "keep_existing_owner" && a.conditions.reassignOwned === true;
      a.conditions = { op: a.conditions.op, conditions: a.conditions.conditions, reassignOwned: reassign };
      if (a.fallback === "fallback_user" && !a.fallbackUserId) {
        a.fallback = "unassigned";
        notes.push(`“${a.name}” gives records to a fallback person who isn't mapped yet, so it falls back to leaving them unassigned until someone is chosen.`);
      }
      const seen = new Set<string>();
      a.members = a.members.filter((m) => (seen.has(m.userId) ? false : (seen.add(m.userId), true)));
      break;
    }
    case "form": {
      const f = r as NativeTypeMap["form"];
      f.draft = readDraft(f.draft, f.kind);
      break;
    }
    case "messageTemplate": {
      const t = r as NativeTypeMap["messageTemplate"];
      t.body = t.body.replace(/\r\n?/g, "\n");
      t.subject = t.channel === "email" && t.kind === "template" ? (t.subject ?? "").replace(/\r\n?/g, "\n").trim() : null;
      if (t.kind === "canned_reply") t.purpose = "service";
      break;
    }
  }
  return r;
}

/** Field-level differences between a workspace record and the Blueprint's version of it (what the preview shows). */
function differences(type: AssetType, existing: NativeTypeMap[AssetType], next: NativeTypeMap[AssetType]): string[] {
  return changedFields(nativeProjection(type, existing), nativeProjection(type, next));
}

const equivalent = (type: AssetType, a: NativeTypeMap[AssetType], b: NativeTypeMap[AssetType]) => differences(type, a, b).length === 0;

/**
 * Whether updating a record the client never linked to this Blueprint only adds to it: empty values filled in, choices or columns added.
 * Anything that would change or remove what the workspace set is not additive, so it needs a person's decision.
 */
function additiveOnly(type: AssetType, existing: NativeTypeMap[AssetType], next: NativeTypeMap[AssetType]): { ok: boolean; changes: string[] } {
  const a = nativeProjection(type, existing);
  const b = nativeProjection(type, next);
  const changes = changedFields(a, b);
  const ok = changes.every((k) => {
    if (isEmpty(a[k])) return true;
    if (k === "options" && Array.isArray(a[k]) && Array.isArray(b[k])) {
      const have = new Map((b[k] as Array<{ value: string; label: string }>).map((o) => [o.value, o.label]));
      return (a[k] as Array<{ value: string; label: string }>).every((o) => have.get(o.value) === o.label);
    }
    if (k === "columns" && Array.isArray(a[k]) && Array.isArray(b[k])) return (a[k] as string[]).every((c) => (b[k] as string[]).includes(c));
    return false;
  });
  return { ok, changes };
}

/**
 * Whether writing `next` over `existing` would leave the client's data invalid (a field type change with values, a choice in use removed,
 * a stage's meaning changed under its deals, a one-host calendar with several hosts, a canned reply turned into a template…). Returns the
 * reason, or null when it is safe. Applying and rolling back both use it (a rollback writes the earlier version over the current one).
 */
async function dataProblem(db: Queryable, state: Pick<WorkspaceState, "orgId" | "config">, type: AssetType, existing: NativeEntry, next: NativeTypeMap[AssetType]): Promise<string | null> {
  const orgId = state.orgId;
  switch (type) {
    case "customField": {
      const cur = existing.record as NativeTypeMap["customField"];
      const nf = next as NativeTypeMap["customField"];
      const values = Number((await db.query<{ n: string }>("select count(*)::text as n from crm_field_values where org_id = $1 and field_id = $2", [orgId, existing.id])).rows[0].n);
      if (nf.type !== cur.type && values > 0) return `“${cur.label}” already holds values as ${article(cur.type)} ${cur.type} field, so its type can't change to ${nf.type}.`;
      const removed = cur.options.filter((o) => !nf.options.some((x) => x.value === o.value)).map((o) => o.value);
      if (removed.length && values > 0) {
        const used = await db.query("select 1 from crm_field_values where field_id = $1 and (value_text = any($2::text[]) or value_list && $2::text[]) limit 1", [existing.id, removed]);
        if (used.rows.length) return `A choice the Blueprint drops from “${cur.label}” is still used by records here.`;
      }
      if (removed.length && (await activeWorkflowsUsingField(db, orgId, existing.id, removed)).length) return `A choice the Blueprint drops from “${cur.label}” is used by an active workflow here.`;
      return null;
    }
    case "stage": {
      const cur = existing.record as NativeTypeMap["stage"];
      const ns = next as NativeTypeMap["stage"];
      if (ns.kind !== cur.kind) {
        const used = await db.query("select 1 from crm_opportunities where org_id = $1 and stage_ref = $2 limit 1", [orgId, existing.id]);
        if (used.rows.length) return `Deals are in “${cur.name}”, so whether it means open, won or lost can't change.`;
        const siblings = state.config.entries.stage.filter((s) => s.parentId === existing.parentId && !s.archived && s.id !== existing.id);
        if (ns.kind !== "open" && siblings.some((s) => s.record.kind === ns.kind)) return `This pipeline already has ${article(ns.kind)} ${ns.kind === "won" ? "Won" : "Lost"} stage.`;
        if (cur.kind === "open" && !siblings.some((s) => s.record.kind === "open")) return "A pipeline needs at least one open stage.";
      }
      return null;
    }
    case "calendar": {
      const nc = next as NativeTypeMap["calendar"];
      if (nc.assignment === "single" && (existing.meta.memberCount ?? 0) > 1) return `“${existing.name}” has several hosts here, so it can't become a one-person calendar.`;
      return null;
    }
    case "appointmentType": {
      const cur = existing.record as NativeTypeMap["appointmentType"];
      const nt = next as NativeTypeMap["appointmentType"];
      if ((cur.capacity === 1) !== (nt.capacity === 1)) {
        const live = await db.query("select 1 from appointment_refs where appointment_type_id = $1 and status in ('new', 'confirmed') and end_at > now() limit 1", [existing.id]);
        if (live.rows.length) return "Upcoming appointments use this type, so it can't switch between one-to-one and group.";
      }
      return null;
    }
    case "form": {
      const cur = existing.record as NativeTypeMap["form"];
      if ((next as NativeTypeMap["form"]).kind !== cur.kind && existing.meta.publishedVersionId) return `“${cur.name}” is published here, so it can't switch between a form and a survey.`;
      return null;
    }
    case "messageTemplate": {
      // As the template service: a canned reply and a message template are different records (a template has a channel, a purpose and
      // approval), so one never becomes the other in place.
      const cur = existing.record as NativeTypeMap["messageTemplate"];
      const nt = next as NativeTypeMap["messageTemplate"];
      const what = (k: string) => (k === "canned_reply" ? "a canned reply" : "a message template");
      if (nt.kind !== cur.kind) return `“${existing.name}” is ${what(cur.kind)} here, so it can't become ${what(nt.kind)}.`;
      return null;
    }
  }
  return null;
}

/** A name or key another record of the same kind already has, which a rename would collide with. */
function nameTaken(state: WorkspaceState, type: AssetType, existing: NativeEntry, next: NativeTypeMap[AssetType]): string | null {
  const same = (state.config.entries[type] as NativeEntry[]).filter((x) => x.id !== existing.id && !x.archived && x.parentId === existing.parentId);
  const id = identityKey(type, next as never);
  if (identityKey(type, existing.record as never) === id) return null;
  const clash = same.find((x) => {
    if (type === "smartList" && x.meta.visibility !== "team") return false;
    return identityKey(type, x.record as never) === id;
  });
  return clash ? `Another ${label(type)} here is already called “${clash.name}”.` : null;
}

/** The copy's name and key, free among the workspace's records and this plan's own creations. */
function copied<T extends AssetType>(type: T, asset: AssetTypeMap[T], taken: Taken, parentNative: string | null): AssetTypeMap[T] {
  const a = { ...(asset as unknown as Record<string, unknown>) } as Record<string, unknown>;
  const scope = scopeKey(type, asset as never, parentNative);
  if (type === "customField" || type === "customValue" || type === "form" || type === "messageTemplate" || type === "workflow" || type === "report") {
    const keys = taken.keys(type, scope);
    a.key = copyKey(type, String(a.key), keys);
    keys.add(String(a.key));
  }
  const nameKey = type === "customField" || type === "customValue" ? "label" : "name";
  const names = taken.names(type, scope);
  a[nameKey] = copyName(type, String(a[nameKey]), names);
  names.add(lower(String(a[nameKey])));
  return a as unknown as AssetTypeMap[T];
}

/** Where a name has to be unique: folders per kind, fields per record type, Smart Lists and rules per record type, stages and types per parent. */
function scopeKey(type: AssetType, x: { kind?: string; entity?: string }, parentNative: string | null): string {
  if (type === "folder") return String(x.kind);
  if (type === "customField" || type === "smartList" || type === "assignmentRule") return String(x.entity);
  if (type === "stage" || type === "appointmentType") return parentNative ?? "";
  return "";
}

/** Names and keys already used per type and scope (lower-cased names), growing as the plan creates records. */
class Taken {
  private readonly nameSets = new Map<string, Set<string>>();
  private readonly keySets = new Map<string, Set<string>>();
  constructor(private readonly config: WorkspaceConfig) {}
  names(type: AssetType, scope: string): Set<string> {
    const k = `${type}|${scope}`;
    let s = this.nameSets.get(k);
    if (!s) {
      s = new Set((this.config.entries[type] as NativeEntry[]).filter((e) => !e.archived && scopeOfEntry(type, e) === scope).map((e) => lower(type === "customField" || type === "customValue" ? (e.record as { label: string }).label : e.name)));
      this.nameSets.set(k, s);
    }
    return s;
  }
  keys(type: AssetType, scope: string): Set<string> {
    const k = `${type}|${scope}`;
    let s = this.keySets.get(k);
    if (!s) {
      // Custom field keys stay taken while archived (the database keeps them unique); the others only among records that aren't archived.
      s = new Set((this.config.entries[type] as NativeEntry[]).filter((e) => (type === "customField" || !e.archived) && scopeOfEntry(type, e) === scope).map((e) => String((e.record as { key?: string }).key)));
      this.keySets.set(k, s);
    }
    return s;
  }
}

function scopeOfEntry(type: AssetType, e: NativeEntry): string {
  return scopeKey(type, e.record as { kind?: string; entity?: string }, e.parentId);
}

/** A record of the workspace with the same identity (within the parent for stages and appointment types), and whether it is spoken for. */
function findByIdentity(state: WorkspaceState, entry: AssetEntry, parentNative: string | null): { match: NativeEntry | null; linkedTo: string | null } {
  const key = identityKey(entry.type, entry.asset as never);
  const candidates = (state.config.entries[entry.type] as NativeEntry[]).filter((e) => {
    if (entry.type === "stage" || entry.type === "appointmentType") {
      if (!parentNative || e.parentId !== parentNative || e.archived) return false;
    } else if (entry.type === "customField") {
      // Archived fields count: a field the workspace archived is restored rather than duplicated.
    } else if (entry.type === "smartList") {
      if (e.archived || e.meta.visibility !== "team") return false;
    } else if (e.archived) return false;
    return identityKey(entry.type, e.record as never) === key;
  });
  const match = candidates.find((c) => !c.archived) ?? candidates[0] ?? null;
  if (!match) return { match: null, linkedTo: null };
  const other = state.linkedNative.get(match.id);
  return { match, linkedTo: other && other !== entry.id ? other : null };
}

interface PlanContext {
  db: Queryable;
  state: WorkspaceState;
  loaded: LoadedVersion;
  options: ApplyOptions;
}

/**
 * The plan: one item per asset the apply would write, in dependency order, with the action, the reason and the record it matches. Pure
 * reads; the same inputs always give the same plan and digest.
 */
async function buildPlan(ctx: PlanContext): Promise<PlanResult> {
  const { db, state, loaded, options } = ctx;
  const content = loaded.content;
  const entries = listAssets(content);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const selected = selection(content, options);
  const strategy = options.strategy;
  const decisions = options.decisions ?? {};
  const slots = options.slotMappings ?? {};
  const taken = new Taken(state.config);
  const resolutions = new Map<string, Res>();
  const valueKeys = new Map<string, string>();
  const ops = new Map<string, Op>();
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  /** Appointment types created on a calendar of the workspace that already takes bookings (they arrive with online booking off). */
  const liveCalendarTypes: string[] = [];
  let standins = 0;
  const standin = () => `00000000-0000-4000-8000-${(++standins).toString(16).padStart(12, "0")}`;

  // Counters for the workspace's own limits, growing with what this plan creates.
  const activeCount = (type: AssetType, pred: (e: NativeEntry) => boolean = () => true) => (state.config.entries[type] as NativeEntry[]).filter((e) => !e.archived && pred(e)).length;
  const counts = {
    pipelines: activeCount("pipeline"),
    workflows: activeCount("workflow"),
    reports: activeCount("report"),
    values: state.config.entries.customValue.length,
    rules: { contact: activeCount("assignmentRule", (e) => (e.record as NativeTypeMap["assignmentRule"]).entity === "contact"), opportunity: activeCount("assignmentRule", (e) => (e.record as NativeTypeMap["assignmentRule"]).entity === "opportunity") },
  };
  let pipelineDefault = state.config.entries.pipeline.some((p) => !p.archived && p.meta.isDefault);
  const listDefault = new Set(state.config.entries.smartList.filter((l) => !l.archived && l.meta.isDefault).map((l) => l.record.entity));
  const fieldMetas = new Map<string, CustomFieldMeta>(state.config.entries.customField.filter((f) => !f.archived).map((f) => [f.id, { id: f.id, entity: f.record.entity, type: f.record.type, options: f.record.options }]));
  const valueCatalog = new Map(state.config.entries.customValue.map((v) => [v.record.key, { key: v.record.key, label: v.record.label, required: v.record.required, group: v.record.groupName, value: v.record.value }]));

  const slotTarget = (id: string): string | null => {
    const kind = typeOfId(id);
    return kind && isSlotKind(kind) ? slots[id] ?? null : null;
  };
  const resolver: ApplyResolver = {
    nativeId: (id) => slotTarget(id) ?? resolutions.get(id)?.nativeId ?? null,
    fieldKey: (id) => resolutions.get(id)?.fieldKey ?? null,
    valueKey: (k) => valueKeys.get(k) ?? null,
    templateHash: (id) => resolutions.get(id)?.contentHash ?? null,
    newNonce: () => "blueprint-plan-nonce",
  };

  const resolveTo = (e: AssetEntry, n: NativeEntry, extra: Partial<Res> = {}) => {
    const r: Res = { nativeId: n.id, planned: false, ...extra };
    if (e.type === "customField") r.fieldKey = (n.record as NativeTypeMap["customField"]).key;
    if (e.type === "customValue") {
      r.valueKey = (n.record as NativeTypeMap["customValue"]).key;
      valueKeys.set((e.asset as AssetTypeMap["customValue"]).key, r.valueKey);
    }
    if (e.type === "messageTemplate" && r.contentHash === undefined) r.contentHash = n.meta.contentHash ?? null;
    resolutions.set(e.id, r);
  };

  /** The record an asset that isn't written now resolves to: its live linked record, else a record with the same identity. */
  const resolveExisting = (e: AssetEntry) => {
    const parent = e.parentId ? resolutions.get(e.parentId) : null;
    if (e.parentId && (!parent || parent.planned)) return;
    const link = state.links.get(e.id);
    const linked = link ? state.config.byId.get(link.nativeId) : undefined;
    if (linked && linked.type === e.type && !linked.archived) return resolveTo(e, linked);
    const { match } = findByIdentity(state, e, parent?.nativeId ?? null);
    if (match && !match.archived) resolveTo(e, match);
  };

  for (const e of entries) {
    if (!selected.has(e.id)) {
      resolveExisting(e);
      continue;
    }
    const parentRes = e.parentId ? resolutions.get(e.parentId) ?? null : null;
    const item: PlanItem = {
      assetId: e.id, assetType: e.type, section: e.section, name: e.name, action: "blocked", reason: "", existing: null, changes: [], decision: null,
      updatable: false, dependsOn: assetDependencies(e, content), unresolved: [],
    };
    const finish = (a: Analysis) => {
      item.action = a.action;
      item.reason = a.reason;
      item.existing = a.existing ? { id: a.existing.id, name: a.existing.name } : null;
      item.changes = a.changes;
      item.decision = a.decision;
      item.updatable = a.updatable ?? false;
      ops.set(e.id, a.op);
      items.push(item);
    };
    const blocked = (reason: string, existing: NativeEntry | null = null, refs: UnresolvedRef[] = []) => {
      if (refs.length) item.unresolved = [...new Set(refs.map((u) => u.value.replace(/^@/, "")).filter(Boolean))];
      // What a blocked asset resolves to stays usable by the others, and the apply resolves it exactly as the plan did (op.entry), so the
      // preview never promises a dependent that the apply then skips.
      let entry: NativeEntry | null = existing;
      if (existing && !existing.archived) resolveTo(e, existing);
      else {
        resolveExisting(e);
        const r = resolutions.get(e.id);
        if (r && !r.planned) entry = state.config.byId.get(r.nativeId) ?? existing;
      }
      finish({ action: "blocked", reason, existing, changes: [], decision: null, op: { kind: "none", entry } });
    };

    // GoHighLevel owns this section here: nothing is written twice.
    const cap = SECTION_CAPABILITY[e.section];
    if (state.mode === "hybrid" && cap && state.capabilities[cap] === "ghl") {
      blocked(`${SECTION_LABELS[e.section]} are managed in GoHighLevel for this workspace, so the Blueprint doesn't change them.`);
      continue;
    }
    if (e.parentId && !parentRes) {
      blocked(`Its ${e.type === "stage" ? "pipeline" : "calendar"} isn't applied, so it can't be either.`);
      continue;
    }
    const parentNative = parentRes?.nativeId ?? null;
    const parentCreated = Boolean(parentRes?.planned);
    /** For an appointment type: the workspace's existing calendar it goes into, when that calendar already takes bookings. */
    const liveParent = (): NativeEntry | null => {
      if (e.type !== "appointmentType" || parentCreated || !parentNative) return null;
      const cal = state.config.byId.get(parentNative);
      return cal && cal.type === "calendar" && cal.meta.status === "active" ? cal : null;
    };

    // The Blueprint's record for this asset, resolved in this workspace, plus what couldn't be resolved.
    const nativeFor = (asset: AssetTypeMap[AssetType]) => {
      const notes: string[] = [];
      const converted = toNative(e.type, asset as never, resolver, { parentId: parentNative });
      notes.push(...converted.notes);
      const record = prepare(e.type, converted.value as NativeTypeMap[AssetType], state, notes);
      return { record, unresolved: converted.unresolved, notes };
    };
    const blockingRefs = (unresolved: UnresolvedRef[]) => unresolved.filter((u) => {
      if (u.path === "folder" || u.target === "record") return false;
      if (u.path === "parent") return true;
      if (isSlotKind(u.target)) {
        // People and connections are mapped during setup; only a Smart List, rule condition or report filter that names one can't be kept without it.
        return (e.type === "smartList" && u.path.startsWith("filter")) || (e.type === "assignmentRule" && u.path.startsWith("conditions")) || (e.type === "report" && u.path.startsWith("config"));
      }
      return true;
    });
    const describeRef = (u: UnresolvedRef) => {
      if (u.target === "member" || u.target === "n8n" || u.target === "webhook") {
        const slot = content.slots.find((s) => `@${s.id}` === u.value);
        return `${SLOT_KIND_LABELS[u.target].label.toLowerCase()} “${slot?.label ?? u.value.slice(1)}”`;
      }
      const dep = byId.get(u.value.replace(/^@/, ""));
      return dep ? `the ${label(dep.type)} “${dep.name}”` : `${u.value}`;
    };
    const slotNotes = (unresolved: UnresolvedRef[]) => [...new Set(unresolved.filter((u) => isSlotKind(u.target)).map((u) => u.value.replace(/^@/, "")))];

    /** Checks a record that will be written against the CRM's own rules that a draft must still meet. Returns the problem, or null. */
    const writeProblem = (record: NativeTypeMap[AssetType], creating: boolean): string | null => {
      switch (e.type) {
        case "smartList":
        case "assignmentRule": {
          const filter: FilterGroup = e.type === "smartList" ? (record as NativeTypeMap["smartList"]).filter : { op: (record as NativeTypeMap["assignmentRule"]).conditions.op, conditions: (record as NativeTypeMap["assignmentRule"]).conditions.conditions };
          try {
            parseFilter(filter);
            const c = { params: [state.orgId] as unknown[], userId: null, timezone: state.timezone, customFields: fieldMetas };
            const entity = e.type === "smartList" ? (record as NativeTypeMap["smartList"]).entity : "contact";
            if (entity === "company") compileCompanyFilter(filter, c);
            else if (entity === "opportunity") compileOpportunityFilter(filter, c);
            else compileContactFilter(filter, c);
          } catch (err) {
            return `Its conditions don't work in this workspace: ${err instanceof Error ? err.message : "the filter isn't valid."}`;
          }
          if (e.type === "assignmentRule" && creating) {
            const entity = (record as NativeTypeMap["assignmentRule"]).entity;
            if (counts.rules[entity] >= MAX_RULES) return `A workspace can have at most ${MAX_RULES} rules for each kind of record.`;
          }
          return null;
        }
        case "report": {
          const parsed = reportConfigSchema.safeParse((record as NativeTypeMap["report"]).config);
          if (!parsed.success) return `Its filters don't work in this workspace: ${parsed.error.issues[0]?.message ?? "check the report's filters."}`;
          if (creating && counts.reports >= MAX_REPORTS) return `This workspace already has ${MAX_REPORTS} saved reports.`;
          return null;
        }
        case "messageTemplate": {
          const t = record as NativeTypeMap["messageTemplate"];
          if ((e.asset as AssetTypeMap["messageTemplate"]).placeholder && !t.body.trim()) return null;
          const check = validateTemplate(t.body, t.subject, t.channel, { purpose: t.purpose, kind: t.kind, customValues: [...valueCatalog.values()] });
          return check.ok ? null : `Its wording can't be saved here: ${check.errors[0].message}`;
        }
        case "pipeline":
          return creating && counts.pipelines >= MAX_PIPELINES ? `A workspace can have up to ${MAX_PIPELINES} active pipelines.` : null;
        case "workflow":
          return creating && counts.workflows >= MAX_WORKFLOWS ? `This workspace has ${MAX_WORKFLOWS} workflows already.` : null;
        case "customValue":
          return creating && counts.values >= MAX_VALUES ? `A workspace can have up to ${MAX_VALUES} configuration values.` : null;
        case "stage": {
          if (!creating || parentCreated) return null;
          const s = record as NativeTypeMap["stage"];
          const siblings = state.config.entries.stage.filter((x) => x.parentId === parentNative && !x.archived);
          const plannedSiblings = items.filter((i) => i.assetType === "stage" && ops.get(i.assetId)?.kind === "create" && byId.get(i.assetId)?.parentId === e.parentId);
          if (siblings.length + plannedSiblings.length >= MAX_STAGES) return `A pipeline has at most ${MAX_STAGES} stages.`;
          if (s.kind !== "open" && (siblings.some((x) => x.record.kind === s.kind) || plannedSiblings.some((i) => (byId.get(i.assetId)!.asset as AssetTypeMap["stage"]).kind === s.kind))) {
            return `This pipeline already has ${article(s.kind)} ${s.kind === "won" ? "Won" : "Lost"} stage, and a pipeline has only one.`;
          }
          return null;
        }
      }
      return null;
    };

    /** Records the plan's effect of creating this asset (or a copy) so later assets can refer to it. */
    const plannedCreate = (asset: AssetTypeMap[AssetType], record: NativeTypeMap[AssetType], opts: { copy: boolean; recreate: boolean }): Op => {
      const r: Res = { nativeId: standin(), planned: true };
      if (e.type === "customField") {
        const f = record as NativeTypeMap["customField"];
        r.fieldKey = f.key;
        fieldMetas.set(r.nativeId, { id: r.nativeId, entity: f.entity, type: f.type, options: f.options });
        taken.keys("customField", f.entity).add(f.key);
      }
      if (e.type === "customValue") {
        const v = record as NativeTypeMap["customValue"];
        r.valueKey = v.key;
        valueKeys.set((e.asset as AssetTypeMap["customValue"]).key, v.key);
        valueCatalog.set(v.key, { key: v.key, label: v.label, required: v.required, group: v.groupName, value: v.value });
        counts.values++;
      }
      if (e.type === "messageTemplate") {
        const t = record as NativeTypeMap["messageTemplate"];
        r.contentHash = templateContentHash(t.channel, t.subject, t.body);
      }
      if (e.type === "pipeline") counts.pipelines++;
      if (e.type === "workflow") counts.workflows++;
      if (e.type === "report") counts.reports++;
      if (e.type === "assignmentRule") counts.rules[(record as NativeTypeMap["assignmentRule"]).entity]++;
      const scope = scopeKey(e.type, record as never, parentNative);
      taken.names(e.type, scope).add(lower(e.type === "customField" || e.type === "customValue" ? (record as { label: string }).label : (record as { name: string }).name));
      if ("key" in (record as object) && e.type !== "customField") taken.keys(e.type, scope).add(String((record as { key: string }).key));
      resolutions.set(e.id, r);
      const op: Op = { kind: "create", asset, copy: opts.copy, recreate: opts.recreate };
      if (e.type === "stage" && parentCreated) {
        // A pipeline this apply creates gets its stages in the Blueprint's own order.
        const index = content.assets.pipelines.find((p) => p.id === e.parentId)?.stages.findIndex((s) => s.id === e.id) ?? -1;
        op.position = Math.max(0, index) + 1;
      }
      if (e.type === "pipeline") {
        const wants = (e.asset as AssetTypeMap["pipeline"]).isDefault;
        const noneAtAll = counts.pipelines === 1 && !state.config.entries.pipeline.some((p) => !p.archived);
        op.makeDefault = !pipelineDefault && (wants || noneAtAll);
        if (op.makeDefault) pipelineDefault = true;
      }
      if (e.type === "smartList") {
        const l = record as NativeTypeMap["smartList"];
        op.makeDefault = l.isDefault && !listDefault.has(l.entity);
        if (op.makeDefault) listDefault.add(l.entity);
      }
      if (e.type === "assignmentRule") {
        const a = e.asset as AssetTypeMap["assignmentRule"];
        const rec = record as NativeTypeMap["assignmentRule"];
        const allMapped = rec.members.length === a.members.length && (a.fallback !== "fallback_user" || Boolean(rec.fallbackUserId));
        op.active = allMapped && (a.strategy === "keep_existing_owner" || rec.members.length > 0);
      }
      if (e.type === "appointmentType" && liveParent()) {
        // The workspace's calendar already takes bookings, so a new type would be bookable at once, without the checks a draft calendar
        // passes before it goes live (hosts' connections, a meeting link). It arrives with online booking off for the workspace to turn on.
        op.private = true;
        if (!liveCalendarTypes.includes(String((record as NativeTypeMap["appointmentType"]).name))) liveCalendarTypes.push(String((record as NativeTypeMap["appointmentType"]).name));
      }
      return op;
    };
    const privateNote = (op: Op) => {
      const cal = op.kind === "create" && op.private ? liveParent() : null;
      return cal ? ` It is added to the workspace's live calendar “${cal.name}” with online booking off; turn booking on after checking its location and meeting link.` : "";
    };

    /** Decides a conflict with the person's decision, if one was given. */
    const conflict = (reason: string, existing: NativeEntry | null, changes: string[], replaceable: boolean, record: NativeTypeMap[AssetType] | null, removed: boolean) => {
      const d = decisions[e.id];
      // Whether "update" can be taken here; every outcome of the conflict carries it, so a decided one still offers exactly what it can take.
      const updatable = replaceable && !!record;
      if (d === "skip") {
        if (existing && !existing.archived) resolveTo(e, existing);
        return finish({ action: "skip", reason: `${reason} Kept as it is, as decided.`, existing, changes, decision: "skip", op: { kind: "none", entry: existing }, updatable });
      }
      if (d === "copy") {
        const asset = copied(e.type, e.asset, taken, parentNative);
        const n = nativeFor(asset);
        const missing = blockingRefs(n.unresolved);
        if (missing.length) return blocked(`It needs ${missing.map(describeRef).join(", ")}, which ${missing.length === 1 ? "isn't" : "aren't"} available in this workspace.`, existing, missing);
        const problem = writeProblem(n.record, true);
        if (problem) return blocked(problem, existing);
        item.unresolved = slotNotes(n.unresolved);
        const cname = (asset as { name?: string; label?: string }).name ?? (asset as { label?: string }).label;
        const op = plannedCreate(asset, n.record, { copy: true, recreate: false });
        return finish({ action: "create", reason: `${reason} The Blueprint's version is added alongside as “${cname}”, as decided.${privateNote(op)}`, existing, changes, decision: "copy", op, updatable });
      }
      if (d === "update" && updatable && record) {
        if (removed) {
          const op = plannedCreate(e.asset, record, { copy: false, recreate: true });
          return finish({ action: "create", reason: `${reason} It is added again, as decided.${privateNote(op)}`, existing: null, changes, decision: "update", op, updatable });
        }
        if (existing && e.type === "messageTemplate") resolveTo(e, existing, { contentHash: templateContentHash((record as NativeTypeMap["messageTemplate"]).channel, (record as NativeTypeMap["messageTemplate"]).subject, (record as NativeTypeMap["messageTemplate"]).body) });
        else if (existing) resolveTo(e, existing);
        return finish({ action: "update", reason: `${reason} The Blueprint's version replaces it, as decided.`, existing, changes, decision: "update", op: { kind: "update", entry: existing!, restore: Boolean(existing?.archived) }, updatable });
      }
      if (existing && !existing.archived) resolveTo(e, existing);
      const how = updatable ? "Choose to keep the workspace's version, replace it, or add the Blueprint's as a copy." : "It can't be replaced in place: keep the workspace's version, or add the Blueprint's as a copy.";
      return finish({ action: "conflict", reason: `${reason} ${how}`, existing, changes, decision: null, op: { kind: "none", entry: existing }, updatable });
    };

    const link = state.links.get(e.id);
    const linked = link ? state.config.byId.get(link.nativeId) : undefined;
    const alive = linked && linked.type === e.type && !linked.archived ? linked : null;
    const currentAssetHash = assetHash(e.type, e.asset as never);

    // ---- created by this Blueprint before ----
    if (link && !parentCreated) {
      const changed = currentAssetHash !== link.assetHash;
      if (!alive) {
        const removedReason = `The ${label(e.type)} this Blueprint added before was ${linked ? "archived" : "deleted"} in this workspace.`;
        if (!changed) {
          finish({ action: "skip", reason: `${removedReason} It stays that way.`, existing: null, changes: [], decision: null, op: { kind: "none", entry: null } });
          continue;
        }
        const n = nativeFor(e.asset);
        if (linked && linked.type === "customField" && linked.archived) {
          // A field keeps its key while archived: "update" restores it with the Blueprint's settings rather than adding a second one.
          const problem = blockingRefs(n.unresolved).length ? "Something it needs isn't available here." : (await dataProblem(db, state, e.type, linked, n.record)) ?? writeProblem(n.record, false);
          conflict(`${removedReason} The Blueprint has changed it since.`, linked, differences(e.type, linked.record, n.record), !problem, n.record, false);
          continue;
        }
        const { match } = findByIdentity(state, e, parentNative);
        const canRecreate = !match && !writeProblem(n.record, true) && !blockingRefs(n.unresolved).length;
        conflict(`${removedReason} The Blueprint has changed it since.`, null, [], canRecreate, canRecreate ? n.record : null, true);
        continue;
      }
      const customized = nativeHash(e.type, alive.record as never) !== link.nativeHash;
      if (!changed) {
        resolveTo(e, alive);
        finish({
          action: "unchanged", reason: customized ? "Up to date. It was changed in this workspace since, and stays as it is." : "Up to date: the Blueprint hasn't changed it since it was applied.",
          existing: alive, changes: [], decision: null, op: { kind: "none", entry: alive },
        });
        continue;
      }
      const n = nativeFor(e.asset);
      const changes = differences(e.type, alive.record, n.record);
      if (strategy === "add_missing") {
        resolveTo(e, alive);
        finish({ action: "skip", reason: "The Blueprint changed it, and Add missing keeps the workspace's version.", existing: alive, changes, decision: null, op: { kind: "none", entry: alive } });
        continue;
      }
      const refs = blockingRefs(n.unresolved);
      if (refs.length) {
        blocked(`It needs ${refs.map(describeRef).join(", ")}, which ${refs.length === 1 ? "isn't" : "aren't"} available in this workspace.`, alive, refs);
        continue;
      }
      const problem = (await dataProblem(db, state, e.type, alive, n.record)) ?? nameTaken(state, e.type, alive, n.record) ?? writeProblem(n.record, false);
      if (customized) {
        conflict("It was changed in this workspace since the Blueprint added it.", alive, changes, !problem, n.record, false);
        continue;
      }
      if (problem) {
        conflict(`The Blueprint's change can't be made safely: ${problem}`, alive, changes, false, null, false);
        continue;
      }
      if (e.type === "messageTemplate" && alive.meta.status === "approved") {
        conflict("It was approved in this workspace. Updating its wording moves it back to draft until someone approves it again.", alive, changes, true, n.record, false);
        continue;
      }
      item.unresolved = slotNotes(n.unresolved);
      if (e.type === "messageTemplate") resolveTo(e, alive, { contentHash: templateContentHash((n.record as NativeTypeMap["messageTemplate"]).channel, (n.record as NativeTypeMap["messageTemplate"]).subject, (n.record as NativeTypeMap["messageTemplate"]).body) });
      else resolveTo(e, alive);
      finish({ action: "update", reason: "The Blueprint changed it and the workspace hasn't, so it is updated.", existing: alive, changes, decision: null, op: { kind: "update", entry: alive, restore: false } });
      continue;
    }

    // ---- never linked: create, adopt an equivalent record, or decide about the workspace's own ----
    const { match, linkedTo } = parentCreated ? { match: null, linkedTo: null } : findByIdentity(state, e, parentNative);
    const n = nativeFor(e.asset);
    const refs = blockingRefs(n.unresolved);
    if (!match) {
      if (refs.length) {
        blocked(`It needs ${refs.map(describeRef).join(", ")}, which ${refs.length === 1 ? "isn't" : "aren't"} available in this workspace.`, null, refs);
        continue;
      }
      const problem = writeProblem(n.record, true);
      if (problem) {
        blocked(problem);
        continue;
      }
      item.unresolved = slotNotes(n.unresolved);
      for (const note of n.notes) if (!warnings.includes(note)) warnings.push(note);
      const op = plannedCreate(e.asset, n.record, { copy: false, recreate: false });
      finish({ action: "create", reason: `The workspace has no ${label(e.type)} like this yet.${privateNote(op)}`, existing: null, changes: [], decision: null, op });
      continue;
    }
    if (linkedTo) {
      conflict(`The ${label(e.type)} “${match.name}” already came from another part of this Blueprint.`, match, [], false, null, false);
      continue;
    }
    if (refs.length) {
      blocked(`It needs ${refs.map(describeRef).join(", ")}, which ${refs.length === 1 ? "isn't" : "aren't"} available in this workspace.`, match, refs);
      continue;
    }
    item.unresolved = slotNotes(n.unresolved);
    const changes = differences(e.type, match.record, n.record);
    if (match.archived) {
      // An archived custom field with this key: restored rather than duplicated (values it still holds come back with it).
      const problem = (await dataProblem(db, state, e.type, match, n.record)) ?? writeProblem(n.record, false);
      if (problem) {
        conflict(`The workspace has an archived field with this key. ${problem}`, match, changes, false, null, false);
        continue;
      }
      resolveTo(e, match);
      finish({ action: "update", reason: "The workspace has an archived field with this key, so it is restored with the Blueprint's settings instead of being added twice.", existing: match, changes, decision: null, op: { kind: "update", entry: match, restore: true } });
      continue;
    }
    if (equivalent(e.type, match.record, n.record)) {
      resolveTo(e, match);
      finish({ action: "link", reason: `The workspace already has this ${label(e.type)} exactly as the Blueprint has it, so it is adopted as is.`, existing: match, changes: [], decision: null, op: { kind: "link", entry: match } });
      continue;
    }
    if (strategy === "add_missing") {
      resolveTo(e, match);
      finish({ action: "skip", reason: `The workspace already has ${article(label(e.type))} ${label(e.type)} called “${match.name}”. Add missing keeps it as it is.`, existing: match, changes, decision: null, op: { kind: "none", entry: match } });
      continue;
    }
    const problem = (await dataProblem(db, state, e.type, match, n.record)) ?? writeProblem(n.record, false);
    const additive = additiveOnly(e.type, match.record, n.record);
    if (!problem && additive.ok && !(e.type === "messageTemplate" && match.meta.status === "approved")) {
      if (e.type === "messageTemplate") resolveTo(e, match, { contentHash: templateContentHash((n.record as NativeTypeMap["messageTemplate"]).channel, (n.record as NativeTypeMap["messageTemplate"]).subject, (n.record as NativeTypeMap["messageTemplate"]).body) });
      else resolveTo(e, match);
      finish({ action: "update", reason: `The workspace's “${match.name}” only gains what the Blueprint adds (${additive.changes.join(", ")}); nothing it has is changed.`, existing: match, changes, decision: null, op: { kind: "update", entry: match, restore: false } });
      continue;
    }
    conflict(`The workspace already has its own ${label(e.type)} “${match.name}”, and it differs from the Blueprint's (${changes.join(", ") || "settings"}).${problem ? ` ${problem}` : ""}`, match, changes, !problem, n.record, false);
  }

  // Plain-language notes for the preview.
  const unmapped = [...new Set(items.flatMap((i) => i.unresolved))].filter((s) => isSlotKind(typeOfId(s) ?? ""));
  if (unmapped.length) {
    const names = unmapped.map((s) => content.slots.find((x) => x.id === s)?.label ?? s);
    warnings.push(`${names.length === 1 ? "One role isn't" : `${names.length} roles aren't`} mapped to this workspace yet (${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}). Settings that name ${names.length === 1 ? "it" : "them"} are left for the workspace to choose.`);
  }
  if (items.some((i) => i.assetType === "calendar" && i.action === "create")) warnings.push("Calendars arrive as drafts: they take no bookings until hosts, hours, time zone and connections are verified and someone activates them.");
  if (liveCalendarTypes.length) {
    warnings.push(`${liveCalendarTypes.length === 1 ? "One appointment type goes" : `${liveCalendarTypes.length} appointment types go`} into a calendar that already takes bookings, so ${liveCalendarTypes.length === 1 ? "it arrives" : "they arrive"} with online booking off (${liveCalendarTypes.slice(0, 5).join(", ")}${liveCalendarTypes.length > 5 ? "…" : ""}). Turn booking on once the location, meeting link and hosts' connections are checked.`);
  }
  if (items.some((i) => i.assetType === "workflow" && (i.action === "create" || i.action === "update"))) warnings.push("Workflows arrive as drafts and never run on their own. Publishing and activating one is the workspace owner's decision.");
  if (items.some((i) => i.assetType === "messageTemplate" && i.action === "create" && content.assets.messageTemplates.find((t) => t.id === i.assetId)?.channel === "whatsapp")) {
    warnings.push("WhatsApp templates are created as drafts. Meta must approve each one for the client's own WhatsApp Business account before it can be sent.");
  }
  if (items.some((i) => i.assetType === "assignmentRule" && i.action === "create" && (ops.get(i.assetId) as { active?: boolean })?.active === false)) {
    warnings.push("Lead assignment rules whose people aren't all mapped arrive switched off.");
  }
  // A rule whose people are all mapped (or that needs nobody) arrives switched on and assigns new records at once: say which, by the name
  // it gets in the workspace (a copy's own name).
  const rulesOn = items.flatMap((i) => {
    const op = ops.get(i.assetId);
    return i.assetType === "assignmentRule" && i.action === "create" && op?.kind === "create" && op.active === true ? [(op.asset as AssetTypeMap["assignmentRule"]).name] : [];
  });
  if (rulesOn.length) {
    const one = rulesOn.length === 1;
    warnings.push(`${one ? "One lead assignment rule arrives" : `${rulesOn.length} lead assignment rules arrive`} switched on, because ${one ? "its" : "their"} people are all mapped or ${one ? "it needs" : "they need"} nobody (${rulesOn.slice(0, 5).join(", ")}${rulesOn.length > 5 ? "…" : ""}). ${one ? "It starts" : "They start"} assigning new contacts or deals as soon as this is applied.`);
  }
  if (state.mode === "hybrid") warnings.push("This workspace shares its CRM with GoHighLevel: sections GoHighLevel manages are left untouched.");

  const counts2 = Object.fromEntries(PLAN_ACTIONS.map((a) => [a, items.filter((i) => i.action === a).length])) as Record<PlanAction, number>;
  const sectionsApplied = options.sections?.length ? options.sections : undefined;
  const plan: ApplicationPlan = {
    orgId: state.orgId,
    blueprintId: loaded.blueprintId,
    versionId: loaded.versionId,
    version: loaded.version,
    mode: state.hasLiveApplication || state.links.size ? "update" : "initial",
    options,
    items,
    counts: counts2,
    requirements: requirementDetails(content, sectionsApplied).map((d) => d.key),
    warnings,
    digest: planDigest({ versionId: loaded.versionId, options, items: items.map((i) => ({ assetId: i.assetId, action: i.action, existingId: i.existing?.id ?? null, decision: i.decision })) }),
  };
  return { plan, ops, entries: byId, warnings };
}

/** Refuses a workspace that can't take a Blueprint at all. */
function assertApplicable(state: WorkspaceState) {
  if (state.mode === "ghl") {
    throw new AppError("conflict", "This client uses GoHighLevel as its CRM, so a Blueprint can't be applied to it. Move the client to iAcquire CRM (or hybrid) first.");
  }
  if (state.switching) throw new AppError("conflict", "This client's CRM provider is being switched right now. Apply the Blueprint once the switch has finished.");
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/** Dry run. Writes nothing. Staff can preview for clients they are assigned to; applying needs crm.blueprints.apply. */
export async function planApplication(user: AgencyUser, orgId: string, input: PlanInput): Promise<ApplicationPlan> {
  return (await previewApplication(user, orgId, input)).plan;
}

/** The dry run with everything the confirmation screen shows: the plan, the roles to map with this workspace's candidates, the setup that follows. */
export async function previewApplication(user: AgencyUser, orgId: string, input: PlanInput): Promise<ApplyPreview> {
  return withSystem(async (db) => {
    const org = await authorizeBlueprintAction(db, user, "preview_apply", orgId);
    const loaded = await loadVersion(db, input.blueprintId, input.version);
    const state = await loadState(db, org!, loaded.blueprintId);
    assertApplicable(state);
    const options = checkOptions(input.options, loaded.content, state);
    const { plan } = await buildPlan({ db, state, loaded, options });
    return {
      plan,
      slots: slotViews(loaded.content, state, options),
      requirementDetails: requirementDetails(loaded.content, options.sections),
      workspace: {
        mode: state.mode,
        switching: state.switching,
        blockedSections: state.mode === "hybrid"
          ? ASSET_SECTIONS.flatMap((s) => {
            const cap = SECTION_CAPABILITY[s];
            return cap && state.capabilities[cap] === "ghl" ? [{ section: s, reason: `${SECTION_LABELS[s]} are managed in GoHighLevel for this workspace.` }] : [];
          })
          : [],
      },
    };
  });
}

function slotViews(content: BlueprintContent, state: WorkspaceState, options: ApplyOptions): SlotMappingView[] {
  const use = slotUsage(content);
  const names = new Map(listAssets(content).map((e) => [e.id, e.name]));
  return content.slots.map((s) => {
    const kind = typeOfId(s.id) as SlotKind;
    const source = kind === "member" ? state.people : kind === "n8n" ? state.n8n : state.webhooks;
    // `options` are already merged with the mappings remembered from the last application (checkOptions), so a role the person cleared
    // stays cleared here.
    const mappedTo = options.slotMappings?.[s.id] ?? null;
    return {
      slotId: s.id, kind, label: s.label, description: s.description,
      usedBy: (use[s.id] ?? []).map((assetId) => ({ assetId, name: names.get(assetId) ?? assetId })),
      candidates: [...source.entries()].map(([id, name]) => ({ id, name })),
      mappedTo,
    };
  });
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** Applies a published version the person previewed and confirmed. */
export async function applyBlueprint(user: AgencyUser, orgId: string, input: ApplyInput, opts: { via?: "agency" | "onboarding" } = {}): Promise<ApplyResult> {
  const key = assertIdempotencyKey(input.idempotencyKey);
  if (!Number.isInteger(input.version) || input.version < 1) throw new AppError("invalid_input", "Choose a published version to apply.");
  if (typeof input.planDigest !== "string" || !/^[0-9a-f]{64}$/.test(input.planDigest)) throw new AppError("invalid_input", "Preview the changes first, then confirm them.");
  let result: ApplyResult;
  try {
    result = await withSystem(async (db) => {
      await authorizeBlueprintAction(db, user, "apply", orgId);
      await db.query(LOCK, [orgId]);
      const replay = await findReplay(db, orgId, key, input.blueprintId);
      if (replay) return { application: await summaryFor(db, user, replay), replayed: true };
      const loaded = await loadVersion(db, input.blueprintId, input.version);
      return applyContentInTx(db, user, orgId, {
        blueprintId: loaded.blueprintId, versionId: loaded.versionId, version: loaded.version, blueprintName: loaded.blueprintName, content: loaded.content,
        options: input.options, idempotencyKey: key, via: opts.via ?? "agency", expectedDigest: input.planDigest,
      });
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    // The whole transaction failed: nothing was applied. Keep a record of the attempt (without the error's internals) for the history.
    await recordFailedApplication(user, orgId, input, err).catch(() => undefined);
    throw new AppError("internal", "Applying the Blueprint failed, and nothing was changed. Try again; if it keeps failing, contact iAcquire support.");
  }
  // Committed: the Setup Center's Blueprint and manifest checks see it now rather than at the next scheduled pass (never failing the apply).
  if (!result.replayed) await pickUpSetupEvidence(orgId, "a Blueprint apply");
  return result;
}

async function findReplay(db: Queryable, orgId: string, key: string, blueprintId: string): Promise<AppRow | null> {
  const row = (await db.query<AppRow>(`${APP_SELECT} where a.org_id = $1 and a.idempotency_key = $2`, [orgId, key])).rows[0];
  if (!row) return null;
  if (row.blueprint_id !== blueprintId) throw new AppError("conflict", "This confirmation was already used for another Blueprint. Preview again.");
  return row;
}

async function recordFailedApplication(user: AgencyUser, orgId: string, input: ApplyInput, err: unknown): Promise<void> {
  await withSystem(async (db) => {
    const org = await authorizeBlueprintAction(db, user, "apply", orgId);
    const v = (await db.query<{ id: string; name: string }>(
      "select v.id, b.name from crm_blueprint_versions v join crm_blueprints b on b.id = v.blueprint_id where v.blueprint_id = $1 and v.version = $2",
      [input.blueprintId, input.version],
    )).rows[0];
    if (!v || !org) return;
    const kind = err instanceof Error ? err.name.slice(0, 40) : "error";
    const live = await db.query("select 1 from crm_blueprint_applications where org_id = $1 and blueprint_id = $2 and status in ('applied', 'partially_applied') limit 1", [orgId, input.blueprintId]);
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_blueprint_applications (org_id, blueprint_id, version_id, version, blueprint_name, mode, strategy, sections, status, plan_digest, summary, requirements,
         idempotency_key, requested_by, requested_via, error, completed_at)
       values ($1, $2, $3, $4, $5, $13, $6, $7, 'failed', $8, $9, '{}', $10, $11, 'agency', $12, now()) returning id`,
      [orgId, input.blueprintId, v.id, input.version, v.name.slice(0, 80), (APPLY_STRATEGIES as readonly string[]).includes(input.options?.strategy) ? input.options.strategy : "add_missing",
        (input.options?.sections ?? []).filter((s) => (ASSET_SECTIONS as readonly string[]).includes(s)), input.planDigest, JSON.stringify({ failure: kind }),
        `${input.idempotencyKey.slice(0, 80)}.failed.${crypto.randomBytes(6).toString("hex")}`, user.id,
        "The apply stopped because of an unexpected error. Nothing was changed.", live.rows.length ? "update" : "initial"],
    );
    await recordAudit({
      orgId, actorUserId: user.id, actorKind: "agency", action: "crm.blueprint_apply_failed", targetType: "crm_blueprint_application", targetId: rows[0].id, result: "failure",
      metadata: { blueprintId: input.blueprintId, version: input.version, failure: kind },
    }, db);
  });
}

/**
 * Plans and applies inside the caller's transaction (used by onboarding right after a client is created, and by applyBlueprint). The
 * person and the client are authorized again here, the content must be the published version it claims to be, and the work runs under the
 * workspace's Blueprint lock. `expectedDigest`: the digest the person confirmed; a different plan now is refused.
 */
export async function applyContentInTx(db: Queryable, user: AgencyUser, orgId: string, input: {
  blueprintId: string;
  versionId: string;
  version: number;
  blueprintName: string;
  content: BlueprintContent;
  options: ApplyOptions;
  idempotencyKey: string;
  via: "agency" | "onboarding";
  expectedDigest?: string;
}): Promise<ApplyResult> {
  const key = assertIdempotencyKey(input.idempotencyKey);
  const org = (await authorizeBlueprintAction(db, user, "apply", orgId))!;
  await db.query(LOCK, [orgId]);
  const replay = await findReplay(db, orgId, key, input.blueprintId);
  if (replay) return { application: await summaryFor(db, user, replay), replayed: true };

  const loaded = await loadVersion(db, input.blueprintId, null, { versionId: input.versionId });
  if (loaded.version !== input.version || contentDigest(loaded.content) !== contentDigest(input.content)) {
    throw new AppError("conflict", "This Blueprint content doesn't match the published version it names. Preview again.");
  }
  const state = await loadState(db, org, loaded.blueprintId);
  assertApplicable(state);
  const options = checkOptions(input.options, loaded.content, state);
  const planned = await buildPlan({ db, state, loaded, options });
  if (input.expectedDigest !== undefined && input.expectedDigest !== planned.plan.digest) throw new AppError("conflict", CHANGED_SINCE_PREVIEW);

  const ws = await loadWorkspace(db, orgId);
  const wctx: WriteContext = {
    db, orgId, userId: user.id, listOwnerId: state.firstOwnerId ?? user.id, reportOwnerId: state.firstOwnerId, defaultCallingCode: ws.defaultCallingCode,
  };
  const plan = planned.plan;
  const { rows } = await db.query<{ id: string }>(
    `insert into crm_blueprint_applications (org_id, blueprint_id, version_id, version, blueprint_name, mode, strategy, sections, status, plan_digest, summary, requirements,
       idempotency_key, requested_by, requested_via)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'applied', $9, '{}', $10, $11, $12, $13) returning id`,
    [orgId, loaded.blueprintId, loaded.versionId, loaded.version, (input.blueprintName || loaded.blueprintName).slice(0, 80), plan.mode, options.strategy, options.sections ?? [],
      plan.digest, plan.requirements, key, user.id, input.via],
  );
  const applicationId = rows[0].id;
  const outcomes = await execute(db, { state, loaded, options, planned, wctx, applicationId });

  // The workspace's starting currency, only for a first application to a workspace with no deals yet.
  const currency = loaded.content.settings.defaultCurrency;
  if (currency && plan.mode === "initial") {
    const deals = await db.query("select 1 from crm_opportunities where org_id = $1 and provider = 'native' limit 1", [orgId]);
    if (!deals.rows.length) await db.query("update crm_workspaces set default_currency = $2 where org_id = $1", [orgId, currency]);
  }
  await db.query(
    "update crm_workspaces set blueprint_key = $2, initialized_at = coalesce(initialized_at, now()), updated_by = $3 where org_id = $1",
    [orgId, `${loaded.blueprintKey}@${loaded.version}`.slice(0, 80), user.id],
  );
  const status: ApplicationStatus = outcomes.failed ? "partially_applied" : "applied";
  const summary = {
    counts: plan.counts,
    outcomes: outcomes.byOutcome,
    slotMappings: options.slotMappings ?? {},
    // An apply narrowed to some assets covers only those: marked so a later update review doesn't treat it as the whole version.
    ...(options.assetIds?.length ? { narrowed: true } : {}),
    warnings: plan.warnings.slice(0, 10).map((w) => w.slice(0, 300)),
  };
  await db.query("update crm_blueprint_applications set status = $3, summary = $4, completed_at = now() where id = $1 and org_id = $2", [applicationId, orgId, status, JSON.stringify(summary)]);
  await recordAudit({
    orgId, actorUserId: user.id, actorKind: "agency", action: "crm.blueprint_applied", targetType: "crm_blueprint_application", targetId: applicationId, result: "success",
    metadata: { blueprintId: loaded.blueprintId, version: loaded.version, strategy: options.strategy, mode: plan.mode, via: input.via, created: plan.counts.create, updated: plan.counts.update, failed: outcomes.failed },
  }, db);
  const added = (outcomes.byOutcome.applied ?? 0);
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "crm_blueprint_applied",
    severity: outcomes.failed ? "warning" : "info",
    title: `CRM setup added: ${loaded.blueprintName}`.slice(0, 200),
    body: `${added} ${added === 1 ? "item was" : "items were"} added or updated in your CRM${outcomes.failed ? `, and ${outcomes.failed} couldn't be` : ""}. Calendars, templates and workflows arrive as drafts; the setup checklist shows what still needs you.`,
    link: "/crm/settings/blueprints",
    dedupeKey: `crm-blueprint:${applicationId}`,
  });
  const row = (await db.query<AppRow>(`${APP_SELECT} where a.id = $1 and a.org_id = $2`, [applicationId, orgId])).rows[0];
  return { application: await summaryFor(db, user, row), replayed: false };
}

interface ExecContext {
  state: WorkspaceState;
  loaded: LoadedVersion;
  options: ApplyOptions;
  planned: PlanResult;
  wctx: WriteContext;
  applicationId: string;
}

const MAX_BEFORE_BYTES = 60_000;

/** Writes every planned item in its own savepoint and records what happened to each. */
async function execute(db: Queryable, x: ExecContext): Promise<{ failed: number; byOutcome: Record<string, number> }> {
  const { state, loaded, planned, wctx, applicationId } = x;
  const orgId = state.orgId;
  const slots = x.options.slotMappings ?? {};
  const res = new Map<string, Res>();
  const valueKeys = new Map<string, string>();
  const failed = new Set<string>();
  const byOutcome: Record<string, number> = {};
  let fieldMetas = await loadCustomFieldMetas(db, orgId);

  // Resolutions start from what the plan found already in the workspace; created records are added as they are written.
  const setExisting = (assetId: string, n: NativeEntry, contentHash?: string | null) => {
    const r: Res = { nativeId: n.id, planned: false };
    if (n.type === "customField") r.fieldKey = (n.record as NativeTypeMap["customField"]).key;
    if (n.type === "customValue") {
      r.valueKey = (n.record as NativeTypeMap["customValue"]).key;
      const e = planned.entries.get(assetId);
      if (e) valueKeys.set((e.asset as AssetTypeMap["customValue"]).key, r.valueKey);
    }
    if (n.type === "messageTemplate") r.contentHash = contentHash ?? n.meta.contentHash ?? null;
    res.set(assetId, r);
  };
  // Assets outside this apply resolve exactly as the plan resolved them (linked record, else the same identity).
  const inPlan = new Set(planned.plan.items.map((i) => i.assetId));
  for (const e of planned.entries.values()) {
    if (inPlan.has(e.id)) continue;
    const parent = e.parentId ? res.get(e.parentId) : null;
    if (e.parentId && !parent) continue;
    const link = state.links.get(e.id);
    const linked = link ? state.config.byId.get(link.nativeId) : undefined;
    if (linked && linked.type === e.type && !linked.archived) {
      setExisting(e.id, linked);
      continue;
    }
    const { match } = findByIdentity(state, e, parent?.nativeId ?? null);
    if (match && !match.archived) setExisting(e.id, match);
  }

  const resolver: ApplyResolver = {
    nativeId: (id) => {
      const kind = typeOfId(id);
      if (kind && isSlotKind(kind)) return slots[id] ?? null;
      return res.get(id)?.nativeId ?? null;
    },
    fieldKey: (id) => res.get(id)?.fieldKey ?? null,
    valueKey: (k) => valueKeys.get(k) ?? null,
    templateHash: (id) => res.get(id)?.contentHash ?? null,
    newNonce: () => newInboundNonce(),
  };

  const upsertLink = (assetId: string, type: AssetType, nativeId: string, aHash: string, nHash: string) => db.query(
    `insert into crm_blueprint_links (org_id, blueprint_id, asset_id, asset_type, native_id, applied_version, asset_hash, native_hash, application_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (org_id, blueprint_id, asset_id) do update set asset_type = excluded.asset_type, native_id = excluded.native_id, applied_version = excluded.applied_version,
       asset_hash = excluded.asset_hash, native_hash = excluded.native_hash, application_id = excluded.application_id`,
    [orgId, loaded.blueprintId, assetId, type, nativeId, loaded.version, aHash, nHash, applicationId],
  );
  const previousLink = (assetId: string) => {
    const l = state.links.get(assetId);
    return l ? { assetType: l.assetType, nativeId: l.nativeId, appliedVersion: l.appliedVersion, assetHash: l.assetHash, nativeHash: l.nativeHash, applicationId: l.applicationId } : null;
  };

  for (const [position, item] of planned.plan.items.entries()) {
    const e = planned.entries.get(item.assetId)!;
    const op = planned.ops.get(item.assetId)!;
    let outcome: ApplicationItemView["outcome"] = "skipped";
    let nativeId: string | null = op.kind === "none" ? op.entry?.id ?? null : op.kind === "create" ? null : op.entry.id;
    let before: Record<string, unknown> | null = null;
    let afterHash: string | null = null;
    let message: string = item.reason;

    if (op.kind === "none") {
      // Unchanged, skipped, undecided conflicts and blocked items: nothing is written. What they resolve to stays usable by the others.
      if (op.entry && !op.entry.archived) setExisting(item.assetId, op.entry);
      if (item.action === "conflict") message = `Needs a decision, so it was left as it is. ${item.reason}`;
    } else {
      await db.query("savepoint bp_item");
      try {
        const parentId = e.parentId ? res.get(e.parentId)?.nativeId ?? null : null;
        if (e.parentId && !parentId) throw new SkipItem("Its parent couldn't be applied, so neither could this.");
        const asset = op.kind === "create" ? op.asset : e.asset;
        const converted = toNative(e.type, asset as never, resolver, { parentId });
        const notes: string[] = [...converted.notes];
        let record = prepare(e.type, converted.value as NativeTypeMap[AssetType], state, notes);
        const missing = converted.unresolved.filter((u) => u.path === "parent" || (!isSlotKind(u.target) && u.target !== "record" && u.path !== "folder"));
        if (missing.length) {
          const deps = [...new Set(missing.map((u) => u.value.replace(/^@/, "")))].map((id) => planned.entries.get(id)?.name ?? id);
          throw new SkipItem(`Not applied, because something it needs couldn't be applied first: ${deps.slice(0, 3).join(", ")}.`);
        }
        if ((e.type === "smartList" || e.type === "assignmentRule") && op.kind !== "link") {
          // The filter compiler checks the resolved conditions against this workspace's fields as they are now (fields this apply created included).
          fieldMetas = await loadCustomFieldMetas(db, orgId);
          compileFor(e.type, record, state, fieldMetas);
        }
        const aHash = assetHash(e.type, e.asset as never);
        if (op.kind === "create") {
          if (op.private && e.type === "appointmentType") record = { ...(record as NativeTypeMap["appointmentType"]), public: false } as NativeTypeMap[AssetType];
          const id = await createRecord(wctx, e.type, record, { makeDefault: op.makeDefault, position: op.position, active: op.active });
          const after = await readEntry(db, orgId, e.type, id);
          if (!after) throw new Error("The record wasn't readable after it was written.");
          afterHash = nativeHash(e.type, after.record as never);
          await upsertLink(item.assetId, e.type, id, aHash, afterHash);
          const prev = previousLink(item.assetId);
          before = prev ? { link: prev } : null;
          nativeId = id;
          setExisting(item.assetId, after);
          message = op.copy ? `Added as “${after.name}”, next to the workspace's own.` : op.recreate ? "Added again." : e.type === "calendar" ? "Added as a draft calendar (no bookings until it is verified and activated)." : "Added.";
          if (e.type === "assignmentRule" && !op.active) message = "Added, switched off until its people are mapped.";
          else if (e.type === "assignmentRule") {
            const rule = record as NativeTypeMap["assignmentRule"];
            message = `${message} Switched on: ${rule.members.length ? "its people are mapped" : "it keeps the existing owner"}, so it starts working on new ${rule.entity === "opportunity" ? "deals" : "contacts"} straight away.`;
          }
          if (op.private && e.type === "appointmentType") message = `${message} Online booking is off because its calendar already takes bookings: turn it on after checking its location and meeting link.`;
        } else if (op.kind === "update") {
          const cur = op.entry;
          if (e.type === "assignmentRule") {
            // People stay the workspace's own: a fallback person nobody mapped keeps the workspace's choice.
            const r = record as NativeTypeMap["assignmentRule"];
            const was = cur.record as NativeTypeMap["assignmentRule"];
            if ((e.asset as AssetTypeMap["assignmentRule"]).fallback === "fallback_user" && !r.fallbackUserId && was.fallbackUserId) {
              record = { ...r, fallback: "fallback_user", fallbackUserId: was.fallbackUserId } as NativeTypeMap[AssetType];
            }
          }
          await updateRecord(wctx, cur, record, cur.type === "customField" ? { archived: false } : {});
          const after = await readEntry(db, orgId, e.type, cur.id);
          if (!after) throw new Error("The record wasn't readable after it was written.");
          afterHash = nativeHash(e.type, after.record as never);
          await upsertLink(item.assetId, e.type, cur.id, aHash, afterHash);
          const snapshot = { record: cur.record, archived: cur.archived, link: previousLink(item.assetId) };
          before = JSON.stringify(snapshot).length <= MAX_BEFORE_BYTES ? snapshot : null;
          setExisting(item.assetId, after);
          message = op.restore ? "Restored from the archive with the Blueprint's settings." : "Updated.";
          if (!before) message += " (It is too large to keep a copy of the earlier version, so this change can't be rolled back.)";
        } else {
          // Adopted: the workspace already had it exactly as the Blueprint does.
          const cur = op.entry;
          afterHash = nativeHash(e.type, cur.record as never);
          await upsertLink(item.assetId, e.type, cur.id, aHash, afterHash);
          before = { link: previousLink(item.assetId) };
          setExisting(item.assetId, cur);
          message = "Already in the workspace exactly as the Blueprint has it; adopted as is.";
        }
        if (notes.length) message = `${message} ${notes.join(" ")}`;
        outcome = "applied";
        await db.query("release savepoint bp_item");
      } catch (err) {
        await db.query("rollback to savepoint bp_item");
        if (!(err instanceof SkipItem)) failed.add(item.assetId);
        outcome = err instanceof SkipItem ? "skipped" : "failed";
        message = err instanceof SkipItem || err instanceof AppError ? err.message : `It couldn't be written: ${safeDbMessage(err)}`;
        nativeId = op.kind === "create" ? null : nativeId;
        before = null;
        afterHash = null;
        // A record that failed to update (or to be adopted) is still there, unchanged: what refers to it still can.
        if (op.kind === "create" || op.entry.archived) res.delete(item.assetId);
        else setExisting(item.assetId, op.entry);
      }
    }
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
    await db.query(
      `insert into crm_blueprint_application_items (org_id, application_id, asset_id, asset_type, section, name, action, outcome, native_id, before, after_hash, message, position)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [orgId, applicationId, item.assetId, item.assetType, item.section, item.name.slice(0, 200), item.action, outcome, nativeId, before ? JSON.stringify(before) : null, afterHash, message.slice(0, 500), position],
    );
  }
  return { failed: failed.size, byOutcome };
}

class SkipItem extends Error {}

/** A database error described without its parameters or values (never echoed to a person). */
function safeDbMessage(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === "23505") return "another record already uses this name or key.";
  if (code === "23514") return "it breaks one of the workspace's rules.";
  if (code === "23503") return "something it refers to no longer exists.";
  return "the database refused it.";
}

function compileFor(type: "smartList" | "assignmentRule", record: NativeTypeMap[AssetType], state: WorkspaceState, metas: Map<string, CustomFieldMeta>) {
  const c = { params: [state.orgId] as unknown[], userId: null, timezone: state.timezone, customFields: metas };
  if (type === "smartList") {
    const l = record as NativeTypeMap["smartList"];
    const filter = parseFilter(l.filter);
    if (l.entity === "company") compileCompanyFilter(filter, c);
    else if (l.entity === "opportunity") compileOpportunityFilter(filter, c);
    else compileContactFilter(filter, c);
  } else {
    const r = record as NativeTypeMap["assignmentRule"];
    compileContactFilter(parseFilter({ op: r.conditions.op, conditions: r.conditions.conditions }), c);
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

type LinkSnapshot = Omit<LinkRow, "assetId">;

interface ItemRow {
  asset_id: string;
  asset_type: AssetType;
  section: AssetSection;
  name: string;
  action: PlanAction;
  outcome: ApplicationItemView["outcome"];
  native_id: string | null;
  before: { record?: NativeTypeMap[AssetType]; archived?: boolean; link?: LinkSnapshot | null } | null;
  after_hash: string | null;
  message: string | null;
  position: number;
}

/**
 * Whether writing a template's earlier version back would take its approval away (the rule the writer applies, as editing by hand does:
 * different wording or a different purpose).
 */
function restoreUnapproves(e: NativeEntry, before: NativeTypeMap["messageTemplate"]): boolean {
  const cur = e.record as NativeTypeMap["messageTemplate"];
  const purpose = before.kind === "canned_reply" ? "service" : before.purpose;
  return templateContent(before).hash !== e.meta.contentHash || purpose !== cur.purpose;
}

/** Undoes what an application created or changed, where nothing was changed or used since. Keeps everything else and says why. */
export async function rollbackApplication(user: AgencyUser, orgId: string, applicationId: string): Promise<RollbackResult> {
  if (!isUuid(applicationId)) throw new AppError("not_found", "Application not found.");
  const result = await rollbackApplicationTx(user, orgId, applicationId);
  // Committed: the Setup Center's Blueprint checks see the rollback now rather than at the next scheduled pass (never failing the rollback).
  await pickUpSetupEvidence(orgId, "a Blueprint rollback");
  return result;
}

function rollbackApplicationTx(user: AgencyUser, orgId: string, applicationId: string): Promise<RollbackResult> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "rollback", orgId);
    await db.query(LOCK, [orgId]);
    const app = (await db.query<AppRow>(`${APP_SELECT} where a.id = $1 and a.org_id = $2 for update of a`, [applicationId, orgId])).rows[0];
    if (!app) throw new AppError("not_found", "Application not found.");
    if (app.status !== "applied" && app.status !== "partially_applied") throw new AppError("conflict", "Only an application that is still in place can be rolled back.");
    const newer = await db.query(
      `select 1 from crm_blueprint_applications where org_id = $1 and blueprint_id = $2 and status in ('applied', 'partially_applied') and id <> $3
       and (created_at, id) > ($4::timestamptz, $3::uuid) limit 1`,
      [orgId, app.blueprint_id, applicationId, app.created_at],
    );
    if (newer.rows.length) throw new AppError("conflict", "Only the most recent application of this Blueprint can be rolled back. Roll back the newer one first.");

    const items = (await db.query<ItemRow>(
      "select asset_id, asset_type, section, name, action, outcome, native_id, before, after_hash, message, position from crm_blueprint_application_items where application_id = $1 and org_id = $2 order by position desc",
      [applicationId, orgId],
    )).rows;
    const config = await readWorkspaceConfig(db, orgId);
    const owner = (await db.query<{ user_id: string }>("select user_id from organization_memberships where org_id = $1 and role = 'owner' and status = 'active' order by created_at limit 1", [orgId])).rows[0];
    const ws = await loadWorkspace(db, orgId);
    const wctx: WriteContext = { db, orgId, userId: user.id, listOwnerId: owner?.user_id ?? user.id, reportOwnerId: owner?.user_id ?? null, defaultCallingCode: ws.defaultCallingCode };
    const results = new Map<string, { outcome: ApplicationItemView["outcome"]; message: string }>();
    const kept: RollbackResult["kept"] = [];
    const deleted = new Set<string>();
    let rolledBack = 0;
    const createdByParent = new Map<string, ItemRow[]>();
    const createdIds = new Set(items.filter((i) => i.action === "create" && i.outcome === "applied" && i.native_id).map((i) => i.native_id!));

    const removeLink = (assetId: string) => db.query("delete from crm_blueprint_links where org_id = $1 and blueprint_id = $2 and asset_id = $3 and application_id = $4", [orgId, app.blueprint_id, assetId, applicationId]);
    const restoreLink = async (assetId: string, link: LinkSnapshot | null | undefined) => {
      if (!link) return removeLink(assetId);
      await db.query(
        `update crm_blueprint_links set asset_type = $4, native_id = $5, applied_version = $6, asset_hash = $7, native_hash = $8, application_id = $9
         where org_id = $1 and blueprint_id = $2 and asset_id = $3`,
        [orgId, app.blueprint_id, assetId, link.assetType, link.nativeId, link.appliedVersion, link.assetHash, link.nativeHash, link.applicationId],
      );
    };
    // What one step decided, recorded only once its savepoint is released (a step that fails leaves no half-recorded outcome behind).
    let batch: Array<{ item: ItemRow; outcome: "kept" | "rolled_back"; message: string; deletedId?: string }> = [];
    const keep = (i: ItemRow, reason: string) => {
      batch.push({ item: i, outcome: "kept", message: reason });
    };
    const done = (i: ItemRow, message: string, deletedId?: string) => {
      batch.push({ item: i, outcome: "rolled_back", message, deletedId });
      if (deletedId) deleted.add(deletedId);
    };
    const flush = () => {
      for (const b of batch) {
        results.set(b.item.asset_id, { outcome: b.outcome, message: b.message.slice(0, 500) });
        if (b.outcome === "kept") kept.push({ assetId: b.item.asset_id, name: b.item.name, reason: b.message });
        else rolledBack++;
      }
      batch = [];
    };
    const discard = () => {
      for (const b of batch) if (b.deletedId) deleted.delete(b.deletedId);
      batch = [];
    };
    const current = (i: ItemRow) => {
      const e = i.native_id ? config.byId.get(i.native_id) : undefined;
      return e && e.type === i.asset_type ? e : null;
    };
    const unchanged = (i: ItemRow, e: NativeEntry) => Boolean(i.after_hash) && nativeHash(e.type, e.record as never) === i.after_hash;

    /**
     * A created record's link goes back to what it was before this application: a copy or a re-added record leaves the asset linked to the
     * workspace's own (customized, archived or deleted) record again, so a later apply still recognizes it; a first creation drops the link.
     */
    const unlinkCreated = (i: ItemRow) => restoreLink(i.asset_id, i.before?.link ?? null);

    /** Deletes one created record when it is unchanged and unused (a stage only while its pipeline keeps an open stage). */
    const removeCreated = async (i: ItemRow) => {
      const e = current(i);
      if (!e) {
        await unlinkCreated(i);
        return done(i, "It had already been removed from the workspace.");
      }
      if (!unchanged(i, e)) return keep(i, "It was changed in this workspace after the Blueprint added it.");
      const reason = await inUseReason(db, orgId, e, [...deleted]);
      if (reason) return keep(i, reason);
      if (e.type === "stage") {
        const open = config.entries.stage.filter((s) => s.parentId === e.parentId && !s.archived && !deleted.has(s.id) && s.id !== e.id && s.record.kind === "open");
        if ((e.record as NativeTypeMap["stage"]).kind === "open" && !open.length) return keep(i, "Its pipeline needs at least one open stage.");
      }
      await deleteRecord(wctx, e);
      await unlinkCreated(i);
      done(i, "Removed.", e.id);
    };

    for (const i of items) {
      if (i.outcome !== "applied") continue;
      await db.query("savepoint bp_rollback");
      try {
        if (i.action === "create") {
          const e = current(i);
          // A stage or appointment type of a pipeline or calendar this same application created is decided together with its parent.
          if (e && e.parentId && createdIds.has(e.parentId) && (i.asset_type === "stage" || i.asset_type === "appointmentType")) {
            createdByParent.set(e.parentId, [...(createdByParent.get(e.parentId) ?? []), i]);
          } else if (e && (e.type === "pipeline" || e.type === "calendar")) {
            const children = createdByParent.get(e.id) ?? [];
            const childType = e.type === "pipeline" ? "stage" : "appointmentType";
            const live = (config.entries[childType] as NativeEntry[]).filter((c) => c.parentId === e.id && !c.archived);
            const childIds = new Set(children.map((c) => c.native_id));
            let reason: string | null = !unchanged(i, e) ? "It was changed in this workspace after the Blueprint added it." : null;
            if (!reason && live.some((c) => !childIds.has(c.id))) reason = `The workspace added its own ${childType === "stage" ? "stages" : "appointment types"} to it.`;
            if (!reason) reason = await inUseReason(db, orgId, e, [...deleted]);
            for (const c of children) {
              if (reason) break;
              const ce = current(c);
              if (ce && !unchanged(c, ce)) reason = `Its ${childType === "stage" ? "stage" : "appointment type"} “${c.name}” was changed in this workspace.`;
              else if (ce) {
                const r = await inUseReason(db, orgId, ce, [...deleted, e.id]);
                if (r) reason = `${c.name}: ${r}`;
              }
            }
            if (!reason) {
              await deleteRecord(wctx, e);
              for (const c of children) {
                await unlinkCreated(c);
                done(c, "Removed with its parent.", c.native_id ?? undefined);
              }
              await unlinkCreated(i);
              done(i, "Removed.", e.id);
            } else {
              keep(i, reason);
              // The pipeline or calendar stays, so it stays whole: removing its unused stages (a Won or Lost stage) or types would leave
              // the client's working pipeline or calendar broken.
              const parentWord = e.type === "pipeline" ? "pipeline" : "calendar";
              for (const c of children) keep(c, `Its ${parentWord} “${e.name}” stays, so it stays with it.`);
            }
          } else await removeCreated(i);
        } else if (i.action === "update") {
          const e = current(i);
          if (!e) keep(i, "It was removed from this workspace since.");
          else if (!unchanged(i, e)) keep(i, "It was changed in this workspace after the Blueprint updated it.");
          else if (!i.before?.record) keep(i, "No copy of the earlier version was kept, so it stays as it is.");
          else if (i.asset_type === "messageTemplate" && e.meta.status === "approved" && restoreUnapproves(e, i.before.record as NativeTypeMap["messageTemplate"])) {
            keep(i, "It was approved in this workspace after the Blueprint updated it. Restoring the earlier wording would send it back to draft, so it stays as it is.");
          } else {
            // The same safety checks as applying: data the workspace stored since (values of a new choice or type, deals in a stage,
            // upcoming appointments) must still fit the earlier version. Records this rollback already removed don't count as siblings.
            const remaining = { orgId, config: { ...config, entries: { ...config.entries, stage: config.entries.stage.filter((s) => !deleted.has(s.id)) } } };
            const problem = await dataProblem(db, remaining, i.asset_type, e, i.before.record);
            if (problem) keep(i, `${problem} It stays as the Blueprint left it.`);
            else {
              await updateRecord(wctx, e, i.before.record, i.asset_type === "customField" ? { archived: i.before.archived === true } : {});
              await restoreLink(i.asset_id, i.before.link ?? null);
              done(i, "Restored to how it was before the Blueprint changed it.");
            }
          }
        } else if (i.action === "link") {
          await restoreLink(i.asset_id, i.before?.link ?? null);
          done(i, "No longer linked to the Blueprint. The record stays as it is: it was the workspace's own.");
        }
        await db.query("release savepoint bp_rollback");
        flush();
      } catch (err) {
        await db.query("rollback to savepoint bp_rollback");
        discard();
        const reason = err instanceof AppError ? err.message : `It couldn't be rolled back: ${safeDbMessage(err)}`;
        keep(i, reason);
        if (i.native_id) for (const c of createdByParent.get(i.native_id) ?? []) keep(c, reason);
        flush();
      }
    }
    // Children deferred to a parent that isn't being rolled back here (it had failed when applied) are judged on their own.
    for (const children of createdByParent.values()) {
      for (const c of children) {
        if (results.has(c.asset_id)) continue;
        await db.query("savepoint bp_rollback");
        try {
          await removeCreated(c);
          await db.query("release savepoint bp_rollback");
          flush();
        } catch (err) {
          await db.query("rollback to savepoint bp_rollback");
          discard();
          keep(c, err instanceof AppError ? err.message : `It couldn't be rolled back: ${safeDbMessage(err)}`);
          flush();
        }
      }
    }
    for (const [assetId, r] of results) {
      await db.query("update crm_blueprint_application_items set outcome = $3, message = $4 where application_id = $1 and org_id = $2 and asset_id = $5", [applicationId, orgId, r.outcome, r.message, assetId]);
    }
    const status: ApplicationStatus = kept.length ? "partially_rolled_back" : "rolled_back";
    await db.query("update crm_blueprint_applications set status = $3, rolled_back_at = now(), rolled_back_by = $4 where id = $1 and org_id = $2", [applicationId, orgId, status, user.id]);
    // The workspace's Blueprint marker follows what is still in place.
    const remaining = (await db.query<{ key: string; version: number }>(
      `select b.key, a.version from crm_blueprint_applications a join crm_blueprints b on b.id = a.blueprint_id
       where a.org_id = $1 and a.status in ('applied', 'partially_applied') order by a.created_at desc, a.id desc limit 1`,
      [orgId],
    )).rows[0];
    await db.query("update crm_workspaces set blueprint_key = $2, updated_by = $3 where org_id = $1", [orgId, remaining ? `${remaining.key}@${remaining.version}`.slice(0, 80) : null, user.id]);
    await recordAudit({
      orgId, actorUserId: user.id, actorKind: "agency", action: "crm.blueprint_rolled_back", targetType: "crm_blueprint_application", targetId: applicationId, result: "success",
      metadata: { blueprintId: app.blueprint_id, version: app.version, rolledBack, kept: kept.length, status },
    }, db);
    await notifyOrgRoles(db, orgId, ["owner", "admin"], {
      kind: "crm_blueprint_applied",
      severity: "info",
      title: `CRM setup rolled back: ${app.blueprint_name}`.slice(0, 200),
      body: kept.length
        ? `${rolledBack} ${rolledBack === 1 ? "item was" : "items were"} undone. ${kept.length} ${kept.length === 1 ? "was" : "were"} kept because your team changed or used ${kept.length === 1 ? "it" : "them"}.`
        : `${rolledBack} ${rolledBack === 1 ? "item was" : "items were"} undone. Nothing your team changed or used was touched.`,
      link: "/crm/settings/blueprints",
      dedupeKey: `crm-blueprint-rollback:${applicationId}`,
    });
    return { status, rolledBack, kept };
  });
}

// ---------------------------------------------------------------------------
// Reading applications
// ---------------------------------------------------------------------------

interface AppRow {
  id: string;
  org_id: string;
  org_name: string;
  blueprint_id: string;
  blueprint_name: string;
  version: number;
  latest_version: number | null;
  mode: "initial" | "update";
  strategy: ApplicationSummary["strategy"];
  status: ApplicationStatus;
  summary: { counts?: Partial<Record<PlanAction, number>> } | null;
  requirements: string[];
  requested_by_name: string | null;
  requested_via: "agency" | "onboarding";
  created_at: Date;
  rolled_back_at: Date | null;
  error: string | null;
}

const APP_SELECT = `
  select a.id, a.org_id, o.name as org_name, a.blueprint_id, a.blueprint_name, a.version, b.current_version as latest_version, a.mode, a.strategy, a.status, a.summary,
         a.requirements, coalesce(nullif(u.full_name, ''), u.email::text) as requested_by_name, a.requested_via, a.created_at, a.rolled_back_at, a.error
  from crm_blueprint_applications a
  join organizations o on o.id = a.org_id
  join crm_blueprints b on b.id = a.blueprint_id
  left join users u on u.id = a.requested_by`;

async function summaryFor(db: Queryable, user: AgencyUser, r: AppRow): Promise<ApplicationSummary> {
  // The newest live application of its Blueprint in the workspace: the only one a rollback accepts, and the one that says whether part of
  // the latest version is still to apply (the same coverage the library's application list works out, so a section-limited update keeps
  // offering the rest of the version from the detail view and the apply result too). Every other row: false.
  let newestLive = false;
  if (r.status === "applied" || r.status === "partially_applied") {
    const newer = await db.query(
      `select 1 from crm_blueprint_applications where org_id = $1 and blueprint_id = $2 and status in ('applied', 'partially_applied') and id <> $3
       and (created_at, id) > ($4::timestamptz, $3::uuid) limit 1`,
      [r.org_id, r.blueprint_id, r.id, r.created_at],
    );
    newestLive = !newer.rows.length;
  }
  const canRollBack = newestLive && canDoBlueprint(user, "rollback");
  const updateAvailable = newestLive && (await liveUpdateAvailable(db, r.org_id, r.blueprint_id, r.latest_version));
  return {
    id: r.id, orgId: r.org_id, orgName: r.org_name, blueprintId: r.blueprint_id, blueprintName: r.blueprint_name, version: r.version, latestVersion: r.latest_version,
    mode: r.mode, strategy: r.strategy, status: r.status, counts: r.summary?.counts ?? {}, requestedBy: r.requested_by_name, requestedVia: r.requested_via,
    createdAt: new Date(r.created_at).toISOString(), rolledBackAt: r.rolled_back_at ? new Date(r.rolled_back_at).toISOString() : null, canRollBack, updateAvailable,
  };
}

export async function getApplication(user: AgencyUser, orgId: string, applicationId: string): Promise<ApplicationDetail> {
  if (!isUuid(applicationId)) throw new AppError("not_found", "Application not found.");
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "inspect");
    // Reading what was applied to one client is client work: the person must reach that client (staff only where assigned).
    await lockClientForBlueprint(db, user, orgId);
    const r = (await db.query<AppRow>(`${APP_SELECT} where a.id = $1 and a.org_id = $2`, [applicationId, orgId])).rows[0];
    if (!r) throw new AppError("not_found", "Application not found.");
    const items = (await db.query<ItemRow>(
      "select asset_id, asset_type, section, name, action, outcome, native_id, null::jsonb as before, null::text as after_hash, message, position from crm_blueprint_application_items where application_id = $1 and org_id = $2 order by position",
      [applicationId, orgId],
    )).rows;
    return {
      ...(await summaryFor(db, user, r)),
      requirements: r.requirements as ApplicationDetail["requirements"],
      items: items.map((i) => ({ assetId: i.asset_id, assetType: i.asset_type, section: i.section, name: i.name, action: i.action, outcome: i.outcome, nativeId: i.native_id, message: i.message })),
      error: r.error,
    };
  });
}

/** Applications of Blueprints to one client, newest first (for the client's CRM page and onboarding). Trusted: the caller authorized the reader. */
export async function listApplicationsForOrg(db: Queryable, user: AgencyUser, orgId: string, limit = 50): Promise<ApplicationSummary[]> {
  const rows = (await db.query<AppRow>(`${APP_SELECT} where a.org_id = $1 order by a.created_at desc, a.id desc limit $2`, [orgId, Math.min(200, Math.max(1, limit))])).rows;
  const out: ApplicationSummary[] = [];
  for (const r of rows) out.push(await summaryFor(db, user, r));
  return out;
}
