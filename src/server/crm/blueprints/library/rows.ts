import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { contentDigest, isUuid } from "@/server/crm/blueprints/access";
import { contentFacts, summaryLines } from "@/server/crm/blueprints/library/content";
import { validateContent, type ValidationIssue } from "@/lib/crm/blueprints/validate";
import { makeReport } from "@/lib/crm/blueprints/report";
import type { AssetChange } from "@/lib/crm/blueprints/diff";
import {
  ASSET_SECTIONS,
  type AssetSection, type BlueprintContent, type BlueprintIndustry, type BlueprintSource, type BlueprintStatus, type CompatReport, type CompatSummary,
} from "@/lib/crm/blueprints/types";
import type { BlueprintSummary, ImportDetail, ImportSummary, VersionView } from "@/lib/crm/blueprints/views";

// Database rows of the agency library and how they become view models. Every query here runs inside a transaction the library service
// opened after authorizing the person (src/server/crm/blueprints/library.ts).

export const iso = (d: Date | string | null | undefined): string => (d ? new Date(d).toISOString() : "");
export const isoOrNull = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** A person's display name in agency views (the name, or the sign-in email when no name was given). */
export const PERSON_NAME = (alias: string) => `coalesce(nullif(${alias}.full_name, ''), ${alias}.email::text)`;

/** Live applications: applied (fully or partly) and not rolled back. */
export const LIVE_STATUSES = ["applied", "partially_applied"] as const;
export const LIVE_SQL = `('applied', 'partially_applied')`;

export const notFound = (): AppError => new AppError("not_found", "Blueprint not found.");

// ---------------------------------------------------------------------------
// Blueprints
// ---------------------------------------------------------------------------

export interface BlueprintRow {
  id: string;
  key: string;
  name: string;
  description: string;
  industry: BlueprintIndustry;
  folder_id: string | null;
  folder_name: string | null;
  source_kind: BlueprintSource;
  source_label: string | null;
  source_org_id: string | null;
  starter_key: string | null;
  status: BlueprintStatus;
  featured: boolean;
  draft_package: BlueprintContent;
  draft_revision: number;
  draft_updated_by_name: string | null;
  draft_updated_at: Date | string;
  current_version: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  published_package: BlueprintContent | null;
  published_digest: string | null;
  applied_to: number | string | null;
  import_summary: Partial<CompatSummary> | null;
  /** Whether the person reading may know the client the Blueprint came from (always, when it came from no client). */
  source_reachable: boolean;
}

/**
 * Whether the person (`$1`, null for a super admin) can reach the client a Blueprint was captured or imported from. SQL over `b`, the
 * Blueprint row. Everything that would name that client (the stored source label, a search on it) is shown only when it holds.
 */
export const SOURCE_REACHABLE_SQL = `($1::uuid is null or b.source_org_id is null
  or exists (select 1 from staff_assignments s where s.org_id = b.source_org_id and s.user_id = $1))`;

/** The same rule for an import (`i`): one from a client's own GoHighLevel location is shown only to people who can reach that client. */
export const IMPORT_REACHABLE_SQL = (person: string) => `(${person}::uuid is null or i.source_kind <> 'ghl_client'
  or exists (select 1 from staff_assignments s where s.org_id = i.source_org_id and s.user_id = ${person}))`;

/**
 * Library rows with what a card needs: the folder, the latest published version, how many reachable client workspaces (not archived) have it
 * live, and the summary of the import it came from. `$1` is the staff member whose assignments scope the count (null for a super admin, who
 * reaches every client), so a count never reveals clients the person can't see.
 */
export const SUMMARY_SELECT = `
  select b.id, b.key, b.name, b.description, b.industry, b.folder_id, f.name as folder_name, b.source_kind, b.source_label, b.source_org_id,
         b.starter_key, b.status, b.featured, b.draft_package, b.draft_revision, b.draft_updated_at, b.current_version, b.created_at, b.updated_at,
         ${PERSON_NAME("du")} as draft_updated_by_name,
         v.package as published_package, v.digest as published_digest,
         (select count(distinct a.org_id) from crm_blueprint_applications a join organizations o on o.id = a.org_id
            where a.blueprint_id = b.id and a.status in ${LIVE_SQL} and o.status <> 'archived'
              and ($1::uuid is null or exists (select 1 from staff_assignments s where s.org_id = a.org_id and s.user_id = $1))) as applied_to,
         (select i.report -> 'summary' from crm_blueprint_imports i
            where i.blueprint_id = b.id and i.status = 'saved' and ${IMPORT_REACHABLE_SQL("$1")} order by i.saved_at desc limit 1) as import_summary,
         ${SOURCE_REACHABLE_SQL} as source_reachable
    from crm_blueprints b
    left join crm_blueprint_folders f on f.id = b.folder_id
    left join users du on du.id = b.draft_updated_by
    left join crm_blueprint_versions v on v.blueprint_id = b.id and v.version = b.current_version`;

/** What a Blueprint captured or imported from a client says about its source to someone who can't reach that client. */
const UNREACHABLE_SOURCE_LABEL: Partial<Record<BlueprintSource, string>> = {
  native: "Captured from a client workspace",
  ghl_import: "Imported from a client's GoHighLevel location",
};

/** The source label the person may see: the stored one, or a generic one when it is about a client they can't reach. */
export function visibleSourceLabel(row: Pick<BlueprintRow, "source_label" | "source_kind" | "source_reachable">): string | null {
  if (row.source_reachable !== false) return row.source_label;
  return row.source_label ? UNREACHABLE_SOURCE_LABEL[row.source_kind] ?? "From a client workspace" : null;
}

/** contentDigest, or "" for stored content that can't be digested (it then never equals a version's digest). */
export function safeDigest(content: BlueprintContent): string {
  try {
    return contentDigest(content);
  } catch {
    return "";
  }
}

export function toSummary(row: BlueprintRow): BlueprintSummary {
  const shown = row.published_package ?? row.draft_package;
  const facts = contentFacts(shown, row.import_summary);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    industry: row.industry,
    status: row.status,
    featured: row.featured,
    source: row.source_kind,
    sourceLabel: visibleSourceLabel(row),
    folderId: row.folder_id,
    folderName: row.folder_name,
    currentVersion: row.current_version,
    hasUnpublishedChanges: row.current_version !== null && row.published_digest !== null && safeDigest(row.draft_package) !== row.published_digest,
    modules: facts.modules,
    totalAssets: facts.totalAssets,
    compatibility: facts.compatibility,
    compatibilityNotes: facts.compatibilityNotes,
    requirements: facts.requirements,
    appliedTo: Number(row.applied_to ?? 0),
    updatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
  };
}

/** One Blueprint with its card details, or not found. `scope` is the staff member scoping counts (null for super admins). */
export async function loadBlueprintRow(db: Queryable, id: string, scope: string | null): Promise<BlueprintRow> {
  if (!isUuid(id)) throw notFound();
  const { rows } = await db.query<BlueprintRow>(`${SUMMARY_SELECT} where b.id = $2`, [scope, id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

/** The columns a write needs, locked for the rest of the transaction so two writes to one Blueprint happen one after the other. */
export interface LockedBlueprint {
  id: string;
  key: string;
  name: string;
  description: string;
  industry: BlueprintIndustry;
  folder_id: string | null;
  featured: boolean;
  source_kind: BlueprintSource;
  status: BlueprintStatus;
  draft_package: BlueprintContent;
  draft_revision: number;
  current_version: number | null;
}

export async function lockBlueprint(db: Queryable, id: string): Promise<LockedBlueprint> {
  if (!isUuid(id)) throw notFound();
  const { rows } = await db.query<LockedBlueprint>(
    `select id, key, name, description, industry, folder_id, featured, source_kind, status, draft_package, draft_revision, current_version
       from crm_blueprints where id = $1 for update`,
    [id],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

export function refuseArchived(row: Pick<LockedBlueprint, "status">, what = "change it"): void {
  if (row.status === "archived") throw new AppError("conflict", `This Blueprint is archived. Unarchive it to ${what}.`);
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface VersionRow {
  id: string;
  version: number;
  digest: string;
  schema_version: number;
  change_summary: string;
  changes: AssetChange[] | null;
  counts: Partial<Record<AssetSection, number>> | null;
  published_by_name: string | null;
  published_at: Date | string;
}

export const VERSION_SELECT = `
  select v.id, v.version, v.digest, v.schema_version, v.change_summary, v.changes, v.counts, v.published_at, ${PERSON_NAME("u")} as published_by_name
    from crm_blueprint_versions v left join users u on u.id = v.published_by`;

export function toVersionView(row: VersionRow): VersionView {
  const changes = Array.isArray(row.changes) ? row.changes : [];
  const counts = Object.fromEntries(ASSET_SECTIONS.map((s) => [s, Number(row.counts?.[s] ?? 0)])) as Record<AssetSection, number>;
  return {
    id: row.id,
    version: row.version,
    digest: row.digest,
    schemaVersion: row.schema_version,
    changeSummary: row.change_summary,
    summaryLines: summaryLines(changes, row.version),
    counts,
    publishedBy: row.published_by_name,
    publishedAt: iso(row.published_at),
  };
}

export async function listVersionRows(db: Queryable, blueprintId: string): Promise<VersionRow[]> {
  const { rows } = await db.query<VersionRow>(`${VERSION_SELECT} where v.blueprint_id = $1 order by v.version desc`, [blueprintId]);
  return rows;
}

/** A published version's frozen content and digest, or not found. */
export async function loadVersionPackage(db: Queryable, blueprintId: string, version: number): Promise<{ id: string; version: number; digest: string; content: BlueprintContent }> {
  if (!Number.isInteger(version) || version < 1) throw new AppError("invalid_input", "Choose a published version.");
  const { rows } = await db.query<{ id: string; version: number; digest: string; package: BlueprintContent }>(
    "select id, version, digest, package from crm_blueprint_versions where blueprint_id = $1 and version = $2",
    [blueprintId, version],
  );
  if (!rows[0]) throw new AppError("not_found", `Version ${version} of this Blueprint doesn't exist.`);
  return { id: rows[0].id, version: rows[0].version, digest: rows[0].digest, content: rows[0].package };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export type ImportSourceKind = ImportSummary["sourceKind"];
export type ImportStatus = ImportSummary["status"];

export interface ImportRow {
  id: string;
  source_kind: ImportSourceKind;
  source_org_id: string | null;
  ghl_source_id: string | null;
  source_label: string;
  status: ImportStatus;
  report: Partial<CompatReport> | null;
  package: BlueprintContent | null;
  counts: Record<string, unknown> | null;
  error: string | null;
  blueprint_id: string | null;
  created_by_name: string | null;
  created_at: Date | string;
}

/**
 * An import's label as its reader sees it. An import from a client's own GoHighLevel location stores a generic label (the library is
 * shared with staff who aren't assigned to that client) and is named after the client here, for readers who can reach it: every query
 * that uses this hides those imports from everyone else (loadImport, listImports).
 */
export const IMPORT_LABEL_SQL = "case when i.source_kind = 'ghl_client' and so.name is not null then so.name else i.source_label end";

export const IMPORT_SELECT = `
  select i.id, i.source_kind, i.source_org_id, i.ghl_source_id, ${IMPORT_LABEL_SQL} as source_label, i.status, i.report, i.package, i.counts, i.error,
         i.blueprint_id, i.created_at, ${PERSON_NAME("u")} as created_by_name
    from crm_blueprint_imports i left join users u on u.id = i.created_by left join organizations so on so.id = i.source_org_id`;

/** An import's report, complete even when the importer stored only part of one (or an older shape). */
export function normalizeReport(report: Partial<CompatReport> | null | undefined): CompatReport {
  const items = Array.isArray(report?.items) ? report.items : [];
  const base = makeReport(items, Array.isArray(report?.limitations) ? report.limitations : [], Array.isArray(report?.unavailable) ? report.unavailable : []);
  return report?.summary ? { ...base, summary: { ...base.summary, ...report.summary } } : base;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : 0);

/** The counts an import list shows, from its report summary (or its stored counts when it has no summary). */
export function importCounts(report: Partial<CompatReport> | null | undefined, counts: Record<string, unknown> | null | undefined): ImportSummary["counts"] {
  const s = report?.summary as Partial<CompatSummary> | undefined;
  if (s && typeof s === "object") {
    return { discovered: num(s.discovered), converted: num(s.fullySupported), partial: num(s.partiallySupported), unsupported: num(s.unsupported), failed: num(s.failed) };
  }
  const c = counts ?? {};
  return { discovered: num(c.discovered), converted: num(c.converted), partial: num(c.partial), unsupported: num(c.unsupported), failed: num(c.failed) };
}

export function toImportSummary(row: Pick<ImportRow, "id" | "source_kind" | "source_label" | "status" | "report" | "counts" | "blueprint_id" | "created_by_name" | "created_at">): ImportSummary {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceLabel: row.source_label,
    status: row.status,
    counts: importCounts(row.report, row.counts),
    blueprintId: row.blueprint_id,
    createdBy: row.created_by_name,
    createdAt: iso(row.created_at),
  };
}

/** The proposed content's validation, or the import's own error when nothing could be converted. */
export function importValidation(row: Pick<ImportRow, "package" | "error">): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  if (row.package) {
    const v = validateContent(row.package);
    return { errors: v.errors, warnings: v.warnings };
  }
  return { errors: row.error ? [{ severity: "error", code: "import_failed", path: "", message: row.error, assetId: null }] : [], warnings: [] };
}

export function toImportDetail(row: ImportRow): ImportDetail {
  return {
    ...toImportSummary(row),
    report: normalizeReport(row.report),
    content: row.package,
    validation: importValidation(row),
    error: row.error,
  };
}
