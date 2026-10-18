import "server-only";
import { AppError } from "@/server/errors";
import { dependencyGraph, listAssets, slotUsage, withDependencies } from "@/lib/crm/blueprints/refs";
import { compatibilityBadge, reportForContent } from "@/lib/crm/blueprints/report";
import { deriveRequirements, modulesOf, requirementDetails, sectionCounts, totalAssets } from "@/lib/crm/blueprints/requirements";
import { validateContent, type ValidationIssue } from "@/lib/crm/blueprints/validate";
import type { AssetChange, BlueprintDiff } from "@/lib/crm/blueprints/diff";
import {
  ASSET_SECTIONS, SECTION_LABELS,
  type AssetSection, type BlueprintContent, type BlueprintMeta, type CompatSummary, type RequirementKey,
} from "@/lib/crm/blueprints/types";
import type { AssetView, ModuleView } from "@/lib/crm/blueprints/views";

// Pure helpers behind the agency library (src/server/crm/blueprints/library.ts): what a draft must pass before it is stored, choosing a
// subset of a package with everything it depends on, library keys, the facts a card shows, and the change list a published version keeps.

/** The library key format (crm_blueprints.key): 3 to 64 lower-case letters, digits and "-", starting and ending with a letter or digit. */
export const BLUEPRINT_KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * Problems that stop a draft from being stored at all. Everything else (a dangling reference, a form the CRM would not accept yet, a
 * duplicate name) can sit in a working draft and only blocks publishing, but structure, size, code and credentials never reach the database.
 */
export const SAVE_BLOCKING_CODES: ReadonlySet<string> = new Set(["schema", "too_large", "asset_too_large", "secret", "unsafe"]);

export interface CheckedDraft {
  content: BlueprintContent;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** One readable message for the first few issues ("assets.tags[0].name: …"). */
export function describeIssues(issues: readonly ValidationIssue[], max = 3): string {
  const lines = issues.slice(0, max).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
  const more = issues.length > max ? ` (and ${issues.length - max} more)` : "";
  return `${lines.join(" ")}${more}`;
}

/**
 * Validates content that is about to be stored as a working draft. Returns the parsed content (names trimmed, exactly the schema's shape)
 * with every remaining issue, or refuses when the content can't be stored at all (see SAVE_BLOCKING_CODES).
 */
export function checkDraft(input: unknown): CheckedDraft {
  const v = validateContent(input);
  const blocking = v.errors.filter((e) => SAVE_BLOCKING_CODES.has(e.code));
  if (!v.content || blocking.length) {
    const issues = blocking.length ? blocking : v.errors;
    throw new AppError("invalid_input", `This Blueprint can't be saved. ${describeIssues(issues)}`.trim());
  }
  return { content: v.content, errors: v.errors, warnings: v.warnings };
}

/** The content with other library details (the key always stays the library's own). */
export function withMeta(content: BlueprintContent, meta: BlueprintMeta): BlueprintContent {
  return { ...content, blueprint: { key: meta.key, name: meta.name, description: meta.description, industry: meta.industry } };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** A library key from a name: "Home Services – Roofing" → "home-services-roofing". Always matches BLUEPRINT_KEY_RE. */
export function keyFromName(name: string): string {
  const slug = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");
  return slug.length >= 3 ? slug : slug ? `${slug}-blueprint` : "blueprint";
}

/** "key-2", "key-3" … within the 64-character limit. */
export function suffixKey(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${base.slice(0, 64 - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

// ---------------------------------------------------------------------------
// Choosing part of a package
// ---------------------------------------------------------------------------

/**
 * Only the given assets and everything they depend on (a pipeline's stages travel with it; a form brings the tags and fields it uses), plus
 * the mapping slots those assets name. Unknown IDs are refused rather than ignored, so a stale selection never silently saves less.
 */
export function selectAssets(content: BlueprintContent, assetIds: readonly string[]): BlueprintContent {
  const known = new Set([...listAssets(content).map((e) => e.id)]);
  const unknown = assetIds.filter((id) => !known.has(id));
  if (unknown.length) throw new AppError("invalid_input", `These assets aren't in this import: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? "…" : ""}.`);
  if (!assetIds.length) throw new AppError("invalid_input", "Choose at least one asset to keep.");
  const keep = withDependencies(content, assetIds);
  const assets = { ...content.assets };
  for (const section of ASSET_SECTIONS) {
    (assets as Record<AssetSection, unknown[]>)[section] = (content.assets[section] as Array<{ id: string }>).filter((a) => keep.has(a.id));
  }
  const pruned: BlueprintContent = { ...content, assets };
  const used = slotUsage(pruned);
  return { ...pruned, slots: content.slots.filter((s) => (used[s.id] ?? []).length > 0) };
}

// ---------------------------------------------------------------------------
// What a library card and the inspection panel show
// ---------------------------------------------------------------------------

export interface ContentFacts {
  modules: ModuleView[];
  totalAssets: number;
  compatibility: "ready" | "needs_attention" | "partial";
  compatibilityNotes: string[];
  requirements: RequirementKey[];
}

/**
 * Modules, size, compatibility and requirements of stored content. A stored package that can no longer be read (written by hand into the
 * database, or by an older build) is shown as partial with a plain note instead of breaking the whole library.
 */
export function contentFacts(content: BlueprintContent, importSummary?: Partial<CompatSummary> | null): ContentFacts {
  try {
    const badge = compatibilityBadge(reportForContent(content));
    const notes = [...badge.notes];
    const lost = Number(importSummary?.unsupported ?? 0) + Number(importSummary?.failed ?? 0);
    if (lost > 0) notes.push(`${lost} ${lost === 1 ? "item" : "items"} from the source couldn't be brought over`);
    return { modules: modulesOf(content), totalAssets: totalAssets(content), compatibility: badge.status, compatibilityNotes: notes, requirements: deriveRequirements(content) };
  } catch {
    return { modules: [], totalAssets: 0, compatibility: "partial", compatibilityNotes: ["The stored content can't be read. Open it and save it again."], requirements: [] };
  }
}

/** Every asset as the inspection panel shows it: what it depends on, what uses it, the slots it names and what it still needs. */
export function assetViews(content: BlueprintContent): AssetView[] {
  const entries = listAssets(content);
  const graph = dependencyGraph(content);
  const usedBy = new Map<string, string[]>();
  for (const [id, deps] of Object.entries(graph)) for (const d of deps) usedBy.set(d, [...(usedBy.get(d) ?? []), id]);
  const slotsOf = new Map<string, string[]>();
  for (const [slot, users] of Object.entries(slotUsage(content))) for (const u of users) slotsOf.set(u, [...(slotsOf.get(u) ?? []), slot]);
  const reqs = new Map<string, RequirementKey[]>();
  for (const d of requirementDetails(content)) for (const id of d.assetIds) reqs.set(id, [...(reqs.get(id) ?? []), d.key]);
  return entries.map((e) => ({
    id: e.id,
    type: e.type,
    section: e.section,
    name: e.name,
    parentId: e.parentId,
    dependsOn: graph[e.id] ?? [],
    usedBy: [...(usedBy.get(e.id) ?? [])].sort(),
    slots: [...(slotsOf.get(e.id) ?? [])].sort(),
    requirements: reqs.get(e.id) ?? [],
    placeholder: Boolean((e.asset as { placeholder?: boolean }).placeholder),
  }));
}

// ---------------------------------------------------------------------------
// Published versions: change lists and summaries
// ---------------------------------------------------------------------------

/** crm_blueprint_versions.changes holds at most 128 KB; this leaves room for the jsonb overhead. */
const CHANGES_MAX_BYTES = 120_000;

/**
 * The change list a version keeps: the diff's asset changes, with field details shortened and, for an enormous change, the tail dropped,
 * so it always fits the column. The change summary text is computed from the full diff, so it stays exact either way.
 */
export function capChanges(changes: readonly AssetChange[]): AssetChange[] {
  const size = (xs: unknown) => new TextEncoder().encode(JSON.stringify(xs)).length;
  let out: AssetChange[] = changes.map((c) => ({ ...c, fields: c.fields.slice(0, 20).map((f) => f.slice(0, 200)) }));
  if (size(out) <= CHANGES_MAX_BYTES) return out;
  out = out.map((c) => ({ ...c, fields: [] }));
  while (out.length && size(out) > CHANGES_MAX_BYTES) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

/** What a first version holds, in one line: "First version: 2 pipelines, 12 tags, 3 forms." */
export function firstVersionSummary(content: BlueprintContent): string {
  const parts = modulesOf(content).map((m) => `${m.count} ${m.label.toLowerCase()}`);
  return parts.length ? `First version: ${parts.join(", ")}.` : "First version.";
}

/** The change summary written when the publisher gives none. */
export function autoChangeSummary(diff: BlueprintDiff | null, content: BlueprintContent): string {
  if (!diff) return firstVersionSummary(content);
  return diff.summary.length ? `${diff.summary.join(". ")}.` : "No asset changes.";
}

/** One line per section from a version's stored change list ("Tags: 2 added, 1 changed"); a first version says so. */
export function summaryLines(changes: readonly AssetChange[], version: number): string[] {
  if (version === 1 && !changes.length) return ["First published version"];
  const by = new Map<AssetSection, { added: number; changed: number; removed: number }>();
  for (const c of changes) {
    if (!(ASSET_SECTIONS as readonly string[]).includes(c.section)) continue;
    const s = by.get(c.section) ?? { added: 0, changed: 0, removed: 0 };
    s[c.kind]++;
    by.set(c.section, s);
  }
  const lines = ASSET_SECTIONS.flatMap((s) => {
    const c = by.get(s);
    if (!c) return [];
    const parts = [c.added && `${c.added} added`, c.changed && `${c.changed} changed`, c.removed && `${c.removed} removed`].filter(Boolean);
    return [`${SECTION_LABELS[s]}: ${parts.join(", ")}`];
  });
  return lines.length ? lines : ["Details only (no asset changes)"];
}

/** Per-section counts as stored on a version. */
export const versionCounts = (content: BlueprintContent) => sectionCounts(content);
