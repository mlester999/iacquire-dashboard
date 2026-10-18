// Everything a schema cannot express. Errors block saving a library draft, publishing, importing and applying; warnings are shown for a
// person to review.
//
//   1. Structure (schema.ts), size limits.
//   2. Logical IDs are unique; every reference resolves to an asset (or a declared slot) of the type its position allows, a folder of the
//      right kind, a custom field of the right record type, a stage of the pipeline next to it. Nothing names a customer record.
//   3. The CRM's own rules, run on a copy resolved to placeholder IDs: Smart List and assignment rule filters against the filter catalog,
//      forms through validateDraft, workflows through validateDefinition, templates through validateTemplate. What only stops a draft from
//      being published in a workspace is a warning (everything a Blueprint creates arrives as a draft); what makes a definition
//      inconsistent is an error.
//   4. Names and keys a workspace keeps unique are unique, so every asset has exactly one identity.
//   5. No string carries code, a credential, a database or GoHighLevel ID, and personal details are flagged.
import { contentSchema, issuePath } from "@/lib/crm/blueprints/schema";
import { assetRefs, assetTexts, listAssets, slotUsage, topologicalOrder, valueTokenKeys, type AssetEntry } from "@/lib/crm/blueprints/refs";
import { jsonBytes } from "@/lib/crm/blueprints/canonical";
import { toNative, type ApplyResolver } from "@/lib/crm/blueprints/native";
import { detectSecret } from "@/lib/secrets";
import { COMPANY_FILTER_FIELDS, CONTACT_FILTER_FIELDS, OPS_BY_KIND, checkFilterShape, customFieldOps, isGroup, opNeedsValue, type CatalogField, type FieldKind, type FilterCondition, type FilterGroup } from "@/lib/crm/filters";
import { formContextFrom, validateDraft } from "@/lib/crm/forms/spec";
import { OPPORTUNITY_CONDITION_FIELDS, validateDefinition, validationContextFrom } from "@/lib/crm/workflow/spec";
import { validateTemplate } from "@/lib/messaging/tokens";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { CREATED_VIA, LEAD_STATUSES } from "@/lib/crm/types";
import {
  ASSET_SECTIONS, ASSET_TYPE_LABELS, BLUEPRINT_MAX_ASSET_BYTES, SLOT_KIND_LABELS, BLUEPRINT_MAX_BYTES, FOLDER_KIND_FOR, ID_PREFIX, SECTION_LABELS, isRef, isSlotKind, refId, typeOfId,
  type AssetType, type BlueprintContent, type CustomFieldAsset, type FolderAsset, type FormAsset, type MessageTemplateAsset, type RefTarget, type WorkflowAsset,
} from "@/lib/crm/blueprints/types";

export interface ValidationIssue {
  severity: "error" | "warning";
  /** Stable machine code ("missing_ref", "secret", "native_form"…). */
  code: string;
  /** Where in the package: "assets.forms[2].draft.actions.tagIds[0]". */
  path: string;
  message: string;
  /** The asset it is about, when it is about one. */
  assetId: string | null;
}

export interface ValidationResult {
  ok: boolean;
  content: BlueprintContent | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Unsafe content, secrets, IDs and personal details
// ---------------------------------------------------------------------------

const UNSAFE: Array<[RegExp, string]> = [
  [/<\s*script\b/i, "contains a <script> tag"],
  [/<\s*(iframe|object|embed|form|meta|link|style|svg|base|frame|frameset|applet)\b/i, "contains HTML that could run or load content"],
  [/\bon[a-z]{3,20}\s*=/i, "contains an HTML event handler"],
  [/(javascript|vbscript|livescript)\s*:/i, "contains a script link"],
  [/data\s*:\s*text\/html/i, "contains an embedded HTML document"],
  [/<\?php|<%[=@]?|%>/i, "contains server-side code"],
  [/\{\{\{|\{%|%\}|\$\{[^}]*\}/, "contains template code iAcquire does not run"],
];

/** Shapes detectSecret (src/lib/secrets.ts) does not know that matter for CRM packages. */
const EXTRA_SECRETS: Array<[RegExp, string]> = [
  [/\bpit-[0-9a-f]{8}-[0-9a-f]{4}-/i, "a GoHighLevel private integration token"],
  [/\bAC[0-9a-f]{32}\b/, "a Twilio account credential"],
];

const UUID_ANYWHERE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
/** GoHighLevel record IDs: 20 mixed-case letters and digits, or 24 hex characters. */
const GHL_ID = /\b(?=[A-Za-z0-9]{20}\b)(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{20}\b|\b[0-9a-f]{24}\b/;
const EMAIL = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const PHONE = /(?:\+|\b00)[1-9][0-9 ().-]{7,18}[0-9]\b|\(\d{3}\)\s*\d{3}[-.\s]\d{4}\b|\b\d{3}[-.]\d{3}[-.]\d{4}\b/;
const SAFE_EMAIL = /@(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|example|invalid|localhost))$/i;

export type ContentFindingKind = "unsafe" | "secret" | "database_id" | "ghl_id" | "personal";

export interface ContentFinding {
  kind: ContentFindingKind;
  message: string;
}

/**
 * What is wrong with one string, if anything: code, a credential, a database or GoHighLevel ID, or what may be a person's details. Used on
 * every string of a package, and by importers on source values before they become assets.
 */
export function scanText(value: string): ContentFinding[] {
  const out: ContentFinding[] = [];
  for (const [re, what] of UNSAFE) if (re.test(value)) out.push({ kind: "unsafe", message: `It ${what}. Blueprints hold plain text only.` });
  const secret = detectSecret(value);
  const extra = EXTRA_SECRETS.find(([re]) => re.test(value));
  if (secret || extra) {
    out.push({ kind: "secret", message: `It looks like ${secret?.label ?? extra![1]}. Credentials never go in a Blueprint; each workspace connects its own providers.` });
  }
  if (UUID_ANYWHERE.test(value)) out.push({ kind: "database_id", message: "It contains a database ID. A Blueprint refers to things by logical reference (such as @tag.hot-lead), never by a workspace's own IDs." });
  if (GHL_ID.test(value)) out.push({ kind: "ghl_id", message: "It contains what looks like a GoHighLevel record ID. Converted configuration must not keep GoHighLevel IDs." });
  const emails = (value.match(EMAIL) ?? []).filter((e) => !SAFE_EMAIL.test(e));
  if (emails.length) out.push({ kind: "personal", message: `It contains an email address (${emails[0]}). Make sure it isn't a person's details; business details belong in a configuration value each workspace fills in.` });
  if (PHONE.test(value)) out.push({ kind: "personal", message: "It contains a phone number. Make sure it isn't a person's details; business details belong in a configuration value each workspace fills in." });
  return out;
}

/** A configuration value named like a credential (an API key, a token, a password, a webhook…): its contents never travel. */
export const SECRET_NAME = /(api[\s_-]?key|secret|token|password|passwd|\bpwd\b|\bpin\b|private[\s_-]?key|client[\s_-]?(id|secret)|\b(o?auth|authentication|authorization)\b|bearer|webhook|signing|credential|licen[cs]e[\s_-]?key)/i;

/** The longest configuration value whose contents a Blueprint keeps. */
export const MAX_TRAVELLING_VALUE = 2000;

export type WithheldValue = "secret_name" | "too_long" | "secret" | "unsafe" | "record_id" | "personal";

/**
 * Why a configuration value's contents can't travel in a Blueprint, or null when they may: a name that suggests a credential, a value
 * longer than MAX_TRAVELLING_VALUE, code, a credential, a record ID of the source, or what looks like contact details (which never travel:
 * each workspace fills in its own). The rule every importer (native capture, GoHighLevel) applies before a value becomes part of an asset.
 */
export function withheldValue(name: string, key: string, value: string): WithheldValue | null {
  if (!value || !value.trim()) return null;
  if (SECRET_NAME.test(name) || SECRET_NAME.test(key)) return "secret_name";
  if (value.length > MAX_TRAVELLING_VALUE) return "too_long";
  const findings = scanText(value);
  if (findings.some((f) => f.kind === "secret")) return "secret";
  if (findings.some((f) => f.kind === "unsafe")) return "unsafe";
  if (findings.some((f) => f.kind === "ghl_id" || f.kind === "database_id")) return "record_id";
  if (findings.some((f) => f.kind === "personal")) return "personal";
  return null;
}

function walkStrings(node: unknown, path: string, visit: (value: string, path: string) => void) {
  if (typeof node === "string") visit(node, path);
  else if (Array.isArray(node)) node.forEach((n, i) => walkStrings(n, `${path}[${i}]`, visit));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walkStrings(v, path ? `${path}.${k}` : k, visit);
}

// ---------------------------------------------------------------------------
// Placeholder resolution: the package resolved to stand-in IDs, so the CRM's own validators can run on it
// ---------------------------------------------------------------------------

const STANDIN_HASH = "0".repeat(64);
const standinId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

interface Standins {
  ids: Map<string, string>;
  resolver: ApplyResolver;
}

function standins(content: BlueprintContent, entries: AssetEntry[]): Standins {
  const ids = new Map<string, string>();
  for (const e of entries) if (!ids.has(e.id)) ids.set(e.id, standinId(ids.size + 1));
  for (const s of content.slots) if (!ids.has(s.id)) ids.set(s.id, standinId(ids.size + 1));
  const fields = new Map(content.assets.customFields.map((f) => [f.id, f.key]));
  return {
    ids,
    resolver: {
      nativeId: (id) => ids.get(id) ?? null,
      fieldKey: (id) => fields.get(id) ?? null,
      valueKey: (k) => k,
      templateHash: () => STANDIN_HASH,
      newNonce: () => "blueprint-validation-nonce",
    },
  };
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

const FORM_ERROR_CODES = new Set(["invalid_draft", "invalid_key", "duplicate_key", "duplicate_option", "duplicate_map", "invalid_map", "missing_field", "missing_tag", "missing_pipeline", "missing_stage", "missing_rule"]);
const WORKFLOW_ERROR_CODES = new Set([
  "invalid_definition", "invalid_trigger", "unknown_step", "duplicate_key", "missing_step", "invalid_link", "cycle", "too_many_steps", "too_deep",
  "missing_tag", "missing_field", "missing_pipeline", "missing_stage", "missing_template", "template_changed", "missing_user", "missing_calendar", "missing_form",
  "missing_rule", "missing_n8n", "missing_webhook",
]);

const TARGET_LABEL = (t: RefTarget) => (t === "record" ? "customer record" : isSlotKind(t) ? `${SLOT_KIND_LABELS[t].label.toLowerCase()} slot` : ASSET_TYPE_LABELS[t]);

/** Validates package content: structure first (stops there if it fails), then references, the CRM's own rules, uniqueness and content safety. */
export function validateContent(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, path: string, message: string, assetId: string | null = null) => errors.push({ severity: "error", code, path, message, assetId });
  const warn = (code: string, path: string, message: string, assetId: string | null = null) => warnings.push({ severity: "warning", code, path, message, assetId });

  const parsed = contentSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 50)) err("schema", issuePath(issue.path), issue.message);
    return { ok: false, content: null, errors, warnings };
  }
  const content = parsed.data as unknown as BlueprintContent;

  const size = jsonBytes(content);
  if (size > BLUEPRINT_MAX_BYTES) err("too_large", "", `The Blueprint is ${Math.ceil(size / 1000)} KB; the limit is ${BLUEPRINT_MAX_BYTES / 1000} KB.`);

  // Where each asset lives, for readable paths.
  const entries = listAssets(content);
  const base = new Map<string, string>();
  for (const section of ASSET_SECTIONS) {
    (content.assets[section] as Array<{ id: string; stages?: Array<{ id: string }>; types?: Array<{ id: string }> }>).forEach((a, i) => {
      const p = `assets.${section}[${i}]`;
      if (!base.has(a.id)) base.set(a.id, p);
      a.stages?.forEach((s, j) => { if (!base.has(s.id)) base.set(s.id, `${p}.stages[${j}]`); });
      a.types?.forEach((t, j) => { if (!base.has(t.id)) base.set(t.id, `${p}.types[${j}]`); });
    });
  }
  const at = (id: string, rel: string) => (rel ? `${base.get(id) ?? id}.${rel}` : base.get(id) ?? id);

  for (const e of entries) {
    if (e.parentId) continue;
    const bytes = jsonBytes(e.asset);
    if (bytes > BLUEPRINT_MAX_ASSET_BYTES) err("asset_too_large", at(e.id, ""), `“${e.name}” is ${Math.ceil(bytes / 1000)} KB; one asset can be at most ${BLUEPRINT_MAX_ASSET_BYTES / 1024} KB.`, e.id);
  }

  // Unique logical IDs across assets (nested ones included) and slots.
  const seen = new Map<string, number>();
  for (const id of [...entries.map((e) => e.id), ...content.slots.map((s) => s.id)]) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) err("duplicate_id", base.get(id) ?? "slots", `The ID "${id}" is used ${n} times. Every asset and slot needs its own.`, id);

  const index = new Map<string, AssetEntry>();
  for (const e of entries) if (!index.has(e.id)) index.set(e.id, e);
  const slots = new Set(content.slots.map((s) => s.id));
  const fieldById = new Map(content.assets.customFields.map((f) => [f.id, f]));

  // ---- references ----
  for (const e of entries) {
    for (const { site, value } of assetRefs(e)) {
      const p = at(e.id, site.path);
      if (site.target === "record") {
        err("not_portable", p, "This names a specific customer record (a company or campaign), which can never be part of a Blueprint.", e.id);
        continue;
      }
      if (!isRef(value)) {
        err("invalid_ref", p, `"${value.slice(0, 60)}" isn't a reference. Use one such as @${ID_PREFIX[site.target as AssetType] ?? site.target}.example, never a database or GoHighLevel ID.`, e.id);
        continue;
      }
      const id = refId(value);
      const kind = typeOfId(id);
      if (kind !== site.target) {
        err("wrong_type", p, `${value} names ${kind ? `a ${TARGET_LABEL(kind)}` : "nothing iAcquire knows"}, but this place takes a ${TARGET_LABEL(site.target)}.`, e.id);
        continue;
      }
      if (isSlotKind(kind)) {
        if (!slots.has(id)) err("undeclared_slot", p, `${value} isn't one of this Blueprint's mapping slots. Add it to the slots list.`, e.id);
        continue;
      }
      const found = index.get(id);
      if (!found) {
        err("missing_ref", p, `Refers to ${value}, which is not in this Blueprint.`, e.id);
        continue;
      }
      if (site.path === "folder") {
        const want = FOLDER_KIND_FOR[e.type];
        const folder = found.asset as FolderAsset;
        if (want && folder.kind !== want) err("wrong_folder_kind", p, `The folder “${folder.name}” holds ${folder.kind.replace("_", " ")}s, not ${want.replace("_", " ")}s.`, e.id);
      }
      if (site.target === "customField" && site.entity && (found.asset as CustomFieldAsset).entity !== site.entity) {
        const f = found.asset as CustomFieldAsset;
        err("wrong_entity", p, `“${f.label}” is a ${f.entity} field; this place takes a ${site.entity} field.`, e.id);
      }
      if (site.target === "stage" && site.pipeline && isRef(site.pipeline) && found.parentId !== refId(site.pipeline)) {
        err("stage_not_in_pipeline", p, `${value} isn't a stage of ${site.pipeline}.`, e.id);
      }
    }
  }

  // Section order makes cycles impossible for the asset types that exist today; a future type that could form one is caught here.
  const cycle = topologicalOrder(content).cycle;
  if (cycle) err("dependency_cycle", base.get(cycle[0]) ?? "", `These assets depend on each other in a circle: ${cycle.join(" → ")}.`, cycle[0]);

  // ---- the CRM's own rules, on the stand-in copy ----
  const stand = standins(content, entries);
  const sid = (id: string) => stand.ids.get(id)!;
  const pipelinesCtx = content.assets.pipelines.map((p) => ({ id: sid(p.id), stages: p.stages.map((s) => ({ id: sid(s.id), kind: s.kind })) }));
  const rulesCtx = content.assets.assignmentRules.map((r) => ({ id: sid(r.id), entity: r.entity }));
  const valueKeys = new Set(content.assets.customValues.map((v) => v.key));

  const formCtx = formContextFrom({
    tags: content.assets.tags.map((t) => ({ id: sid(t.id) })),
    pipelines: pipelinesCtx,
    contactFields: content.assets.customFields.filter((f) => f.entity === "contact").map((f) => ({ key: f.key, type: f.type, label: f.label, options: f.options })),
    assignmentRules: rulesCtx,
  });
  const workflowCtx = validationContextFrom({
    tags: content.assets.tags.map((t) => ({ id: sid(t.id) })),
    users: content.slots.filter((s) => typeOfId(s.id) === "member").map((s) => ({ id: sid(s.id) })),
    pipelines: pipelinesCtx,
    fields: content.assets.customFields.map((f) => ({ id: sid(f.id), entity: f.entity, type: f.type, key: f.key })),
    templates: content.assets.messageTemplates.filter((t) => t.channel).map((t) => ({ id: sid(t.id), contentHash: STANDIN_HASH, channel: t.channel! })),
    n8nMappings: content.slots.filter((s) => typeOfId(s.id) === "n8n").map((s) => ({ id: sid(s.id) })),
    webhookSubscriptions: content.slots.filter((s) => typeOfId(s.id) === "webhook").map((s) => ({ id: sid(s.id) })),
    assignmentRules: rulesCtx,
    // Which AI employees a workspace includes is a setup requirement ("ai_employee" for senders, "hermes" for AI tasks), not a Blueprint error.
    agents: AGENT_ROLE_KEYS.map((roleKey) => ({ roleKey })),
    calendars: content.assets.calendars.map((c) => ({ id: sid(c.id) })),
    appointmentTypes: content.assets.calendars.flatMap((c) => c.types.map((t) => ({ id: sid(t.id) }))),
    forms: content.assets.forms.map((f) => ({ id: sid(f.id) })),
    customValues: content.assets.customValues.map((v) => ({ key: v.key })),
  });

  const filterChecks = (filter: FilterGroup, subject: "contact" | "company" | "opportunity", path: string, owner: string, opts: { rule?: boolean } = {}) => {
    const shape = checkFilterShape(filter);
    if (shape) err("filter", path, shape, owner);
    const catalog = new Map<string, Pick<CatalogField, "label" | "kind">>(
      (subject === "contact" ? CONTACT_FILTER_FIELDS : subject === "company" ? COMPANY_FILTER_FIELDS : OPPORTUNITY_CONDITION_FIELDS).map((f) => [f.key, f]),
    );
    const walk = (g: FilterGroup, p: string) => g.conditions.forEach((c, i) => (isGroup(c) ? walk(c, `${p}.conditions[${i}]`) : check(c, `${p}.conditions[${i}]`)));
    const check = (c: FilterCondition, p: string) => {
      if (c.field.startsWith("@")) {
        const f = fieldById.get(refId(c.field));
        if (subject === "opportunity") err("filter", p, "Deal conditions can't use custom fields.", owner);
        else if (f && !customFieldOps(f.type).includes(c.op)) err("filter", p, `“${f.label}” can't be compared with "${c.op}".`, owner);
        return;
      }
      const def = catalog.get(c.field);
      if (!def) return err("filter", p, `"${c.field}" isn't a field this list can filter on.`, owner);
      if (!OPS_BY_KIND[def.kind as FieldKind].includes(c.op)) return err("filter", p, `“${def.label}” can't be compared with "${c.op}".`, owner);
      if (opNeedsValue(def.kind as FieldKind, c.op) && (c.value === undefined || c.value === null || c.value === "" || (Array.isArray(c.value) && !c.value.length))) {
        return err("filter", p, `Choose a value for “${def.label}”.`, owner);
      }
      if (c.field === "company" && c.op === "is_any_of") return err("not_portable", p, "This condition names specific companies, which can never be part of a Blueprint.", owner);
      if (opts.rule && c.op === "is_me") return err("filter", p, "An assignment rule has no “me”: choose the people instead.", owner);
      const allowed = c.field === "lead_status" ? LEAD_STATUSES : c.field === "created_via" ? CREATED_VIA : null;
      if (allowed) for (const v of Array.isArray(c.value) ? c.value : [c.value]) if (!(allowed as readonly unknown[]).includes(v)) err("filter", p, `"${String(v)}" isn't a ${def.label.toLowerCase()}.`, owner);
    };
    walk(filter, path);
  };

  for (const [i, s] of content.assets.smartLists.entries()) filterChecks(s.filter, s.entity, `assets.smartLists[${i}].filter`, s.id);
  for (const [i, r] of content.assets.assignmentRules.entries()) filterChecks(r.conditions, "contact", `assets.assignmentRules[${i}].conditions`, r.id, { rule: true });

  content.assets.forms.forEach((f: FormAsset, i) => {
    const native = toNative("form", f, stand.resolver);
    for (const issue of validateDraft(native.value.draft, formCtx, { kind: f.kind })) {
      const path = `assets.forms[${i}].draft.${issue.area}${issue.question ? `(${issue.question})` : ""}`;
      const blocking = issue.level === "error" && !f.placeholder && FORM_ERROR_CODES.has(issue.code);
      (blocking ? err : warn)("native_form", path, issue.level === "error" && !blocking ? `${issue.message} (It can't be published in a workspace until this is fixed.)` : issue.message, f.id);
    }
  });

  content.assets.workflows.forEach((w: WorkflowAsset, i) => {
    const native = toNative("workflow", w, stand.resolver);
    for (const issue of validateDefinition(native.value.draft, workflowCtx)) {
      const step = issue.stepKey ? w.definition.steps.findIndex((s) => s.key === issue.stepKey) : -1;
      const path = `assets.workflows[${i}].definition${step >= 0 ? `.steps[${step}]` : ""}${issue.path ? `.${issue.path}` : ""}`;
      const valueToken = issue.code === "unknown_token" && /custom_values\./.test(issue.message);
      const blocking = issue.level === "error" && !w.placeholder && WORKFLOW_ERROR_CODES.has(issue.code) && !valueToken;
      (blocking ? err : warn)("native_workflow", path, issue.level === "error" && !blocking ? `${issue.message} (It can't be published in a workspace until this is fixed.)` : issue.message, w.id);
    }
    if (w.placeholder && w.definition.steps.length) warn("placeholder", `assets.workflows[${i}]`, "A placeholder workflow has steps; mark it as complete once it has been rebuilt.", w.id);
  });

  content.assets.messageTemplates.forEach((t: MessageTemplateAsset, i) => {
    if (t.placeholder && !t.body.trim()) return;
    const check = validateTemplate(t.body, t.subject, t.channel, { purpose: t.purpose, kind: t.kind, customValues: [...valueKeys] });
    for (const issue of check.errors) {
      const path = `assets.messageTemplates[${i}].${issue.field}`;
      if (issue.code === "unknown_custom_value") warn("unknown_value_token", path, `${issue.token ?? "A configuration value"} isn't one of this Blueprint's configuration values, so the workspace must already have it.`, t.id);
      else (t.placeholder ? warn : err)("native_template", path, issue.message, t.id);
    }
    for (const issue of check.warnings) warn("native_template", `assets.messageTemplates[${i}].${issue.field}`, issue.message, t.id);
  });

  // Configuration value tokens in workflow texts that the package doesn't define (templates are covered above).
  for (const e of entries) {
    if (e.type !== "workflow") continue;
    for (const k of valueTokenKeys(...assetTexts(e))) {
      if (!valueKeys.has(k)) warn("unknown_value_token", at(e.id, "definition"), `{{custom_values.${k}}} isn't one of this Blueprint's configuration values, so the workspace must already have it.`, e.id);
    }
  }

  // ---- identities: names and keys a workspace keeps unique ----
  const dupes = <T extends { id: string }>(items: T[], keyOf: (x: T) => string, label: (x: T) => string, path: string, what: string) => {
    const groups = new Map<string, T[]>();
    for (const x of items) groups.set(keyOf(x), [...(groups.get(keyOf(x)) ?? []), x]);
    for (const xs of groups.values()) if (xs.length > 1) err("duplicate_name", path, `${xs.length} ${what} are called “${label(xs[0])}”. Each needs its own, so it matches exactly one record in a workspace.`, xs[1].id);
  };
  const lower = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const A = content.assets;
  dupes(A.folders, (f) => `${f.kind}:${lower(f.name)}`, (f) => f.name, "assets.folders", "folders of one kind");
  dupes(A.tags, (t) => lower(t.name), (t) => t.name, "assets.tags", "tags");
  dupes(A.customFields, (f) => `${f.entity}:${f.key}`, (f) => f.key, "assets.customFields", "fields of one record type");
  dupes(A.customValues, (v) => v.key, (v) => v.key, "assets.customValues", "configuration values");
  dupes(A.pipelines, (x) => lower(x.name), (x) => x.name, "assets.pipelines", "pipelines");
  dupes(A.calendars, (c) => lower(c.name), (c) => c.name, "assets.calendars", "calendars");
  A.calendars.forEach((c, i) => dupes(c.types, (t) => lower(t.name), (t) => t.name, `assets.calendars[${i}].types`, "appointment types in one calendar"));
  dupes(A.smartLists, (s) => `${s.entity}:${lower(s.name)}`, (s) => s.name, "assets.smartLists", "Smart Lists of one record type");
  dupes(A.assignmentRules, (r) => `${r.entity}:${lower(r.name)}`, (r) => r.name, "assets.assignmentRules", "assignment rules of one record type");
  dupes(A.forms, (f) => f.key, (f) => f.key, "assets.forms", "forms");
  dupes(A.messageTemplates, (t) => t.key, (t) => t.key, "assets.messageTemplates", "templates and canned replies");
  dupes(A.workflows, (w) => w.key, (w) => w.key, "assets.workflows", "workflows");
  dupes(A.reports, (r) => r.key, (r) => r.key, "assets.reports", "reports");
  if (A.pipelines.filter((x) => x.isDefault).length > 1) err("duplicate_default", "assets.pipelines", "Only one pipeline can be the default.");
  for (const entity of ["contact", "company", "opportunity"] as const) {
    if (A.smartLists.filter((s) => s.entity === entity && s.isDefault).length > 1) err("duplicate_default", "assets.smartLists", `Only one ${entity} Smart List can be the default.`);
  }

  // ---- slots ----
  for (const [slot, users] of Object.entries(slotUsage(content))) {
    if (slots.has(slot) && !users.length) warn("unused_slot", "slots", `The slot ${slot} isn't used by any asset. Remove it, or use it.`, slot);
  }

  // ---- content safety over every string ----
  walkStrings(content, "", (value, path) => {
    for (const f of scanText(value)) {
      const m = /^assets\.(\w+)\[(\d+)\](?:\.(stages|types)\[(\d+)\])?/.exec(path);
      let owner: string | null = null;
      if (m) {
        const top = (content.assets[m[1] as keyof typeof content.assets] as Array<{ id: string; stages?: Array<{ id: string }>; types?: Array<{ id: string }> }>)[Number(m[2])];
        owner = m[3] ? (top?.[m[3] as "stages" | "types"]?.[Number(m[4])]?.id ?? top?.id ?? null) : (top?.id ?? null);
      }
      if (f.kind === "personal") warn("personal", path, f.message, owner);
      else err(f.kind, path, f.message, owner);
    }
  });

  return { ok: errors.length === 0, content, errors, warnings };
}

/** Validates and returns the content, or throws one readable message listing the first errors. */
export function assertValidContent(input: unknown): BlueprintContent {
  const r = validateContent(input);
  if (!r.ok || !r.content) {
    const first = r.errors.slice(0, 3).map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join(" ");
    throw new BlueprintValidationError(first || "This Blueprint isn't valid.", r.errors);
  }
  return r.content;
}

export class BlueprintValidationError extends Error {
  constructor(message: string, readonly issues: ValidationIssue[]) {
    super(message);
    this.name = "BlueprintValidationError";
  }
}

/** A one-line summary per section of what failed validation, for compact screens. */
export function summarizeIssues(issues: readonly ValidationIssue[]): string[] {
  const by = new Map<string, number>();
  for (const i of issues) {
    const m = /^assets\.(\w+)/.exec(i.path);
    const label = m && m[1] in SECTION_LABELS ? SECTION_LABELS[m[1] as keyof typeof SECTION_LABELS] : "Details";
    by.set(label, (by.get(label) ?? 0) + 1);
  }
  return [...by.entries()].map(([label, n]) => `${label}: ${n} ${n === 1 ? "issue" : "issues"}`);
}
