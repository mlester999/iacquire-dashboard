import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import {
  authorizeBlueprintAction, canDoBlueprint, contentDigest, isUuid, sha256,
  type AgencyUser, type BlueprintAction,
} from "@/server/crm/blueprints/access";
import {
  assetViews, autoChangeSummary, capChanges, checkDraft, describeIssues, keyFromName, selectAssets, suffixKey, versionCounts, withMeta, BLUEPRINT_KEY_RE,
} from "@/server/crm/blueprints/library/content";
import {
  IMPORT_LABEL_SQL, IMPORT_REACHABLE_SQL, IMPORT_SELECT, LIVE_SQL, PERSON_NAME, SOURCE_REACHABLE_SQL, SUMMARY_SELECT, iso, isoOrNull, listVersionRows, loadBlueprintRow,
  loadVersionPackage, lockBlueprint, normalizeReport, refuseArchived, safeDigest, toImportDetail, toImportSummary, toSummary, toVersionView, visibleSourceLabel,
  type BlueprintRow, type ImportRow, type LockedBlueprint,
} from "@/server/crm/blueprints/library/rows";
import { sameJson } from "@/lib/crm/blueprints/canonical";
import { changedSections, diffContents, type BlueprintDiff } from "@/lib/crm/blueprints/diff";
import { buildPackageFile, readPackage, serializePackage } from "@/lib/crm/blueprints/package";
import { makeReport, reportForContent } from "@/lib/crm/blueprints/report";
import { deriveRequirements, modulesOf, requirementDetails, totalAssets } from "@/lib/crm/blueprints/requirements";
import { BlueprintValidationError, scanText, validateContent, type ValidationIssue } from "@/lib/crm/blueprints/validate";
import { STARTER_BLUEPRINTS, getStarter } from "@/lib/crm/blueprints/starters";
import {
  ASSET_SECTIONS, BLUEPRINT_INDUSTRIES, BLUEPRINT_MAX_BYTES, BLUEPRINT_SCHEMA_VERSION, BLUEPRINT_SOURCES, emptyBlueprint,
  type ApplicationStatus, type ApplyStrategy, type AssetSection, type BlueprintContent, type BlueprintIndustry, type BlueprintSource, type CompatReport,
  type PlanAction,
} from "@/lib/crm/blueprints/types";
import type {
  ApplicationSummary, AssetView, BlueprintDetail, BlueprintFolderView, BlueprintSummary, ClientOption, CompareView, ImportDetail, ImportSummary,
  PackageImportPreview, StarterView, UpdateCandidate, VersionView,
} from "@/lib/crm/blueprints/views";

// The agency Blueprint library: Blueprints with a working draft and frozen published versions, library folders, iAcquire starters, version
// comparison and restore, package export and import, the history of imports (package files and GoHighLevel), and which clients applied which
// version.
//
// Everything here is agency work served by trusted code (the library tables have no grants to the application role). Every function
// authorizes the signed-in agency person through access.ts inside its own transaction (the role is re-read under a row lock), and anything
// about a client is scoped to the clients that person can reach: super admins every client, staff only the ones they are assigned to.
// Library events are audited without an organization (orgId null, actorKind agency).

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** The staff member whose assignments scope client data, or null for a super admin (who reaches every client). */
const scopeOf = (user: AgencyUser): string | null => (user.platformRole === "agency_super_admin" ? null : user.id);

function audit(db: Queryable, user: AgencyUser, action: string, targetType: string, targetId: string, metadata: Record<string, unknown> = {}) {
  return recordAudit({ orgId: null, actorUserId: user.id, actorKind: "agency", action, targetType, targetId, result: "success", metadata }, db);
}

/** Parses a function's input, refusing with the first readable problem. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError("invalid_input", r.error.issues[0]?.message ?? "Check the details and try again.");
  return r.data;
}

const nameSchema = z.string({ error: "Give the Blueprint a name." }).trim().min(1, "Give the Blueprint a name.").max(80, "Names can be at most 80 characters.");
const descriptionSchema = z.string().trim().max(1000, "Descriptions can be at most 1,000 characters.");
const industrySchema = z.enum(BLUEPRINT_INDUSTRIES, { error: "Choose an industry." });
const keySchema = z.string().trim().toLowerCase().regex(BLUEPRINT_KEY_RE, "Keys are 3 to 64 lower-case letters, numbers and hyphens, starting and ending with a letter or number.");
const folderIdSchema = z.string().refine(isUuid, "Choose a folder from the list.").nullable();
const versionSchema = z.union([z.literal("draft"), z.number().int().min(1)], { error: "Choose a version." });
const revisionSchema = z.number({ error: "Reload this Blueprint and try again." }).int().min(1);
const folderNameSchema = z.string({ error: "Give the folder a name." }).trim().min(1, "Give the folder a name.").max(60, "Folder names can be at most 60 characters.");

async function assertFolder(db: Queryable, folderId: string): Promise<void> {
  const { rows } = await db.query("select 1 from crm_blueprint_folders where id = $1", [folderId]);
  if (!rows[0]) throw new AppError("invalid_input", "That folder no longer exists. Choose another one.");
}

/** Free text a person writes next to a Blueprint (a change summary) follows the same content rules as the Blueprint itself. */
function checkFreeText(text: string, what: string): void {
  const bad = scanText(text).find((f) => f.kind === "secret" || f.kind === "unsafe");
  if (bad) throw new AppError("invalid_input", `The ${what} can't be saved. ${bad.message}`);
}

/** The draft or a published version's content. */
async function contentAt(db: Queryable, row: Pick<BlueprintRow, "id" | "draft_package">, version: number | "draft"): Promise<{ content: BlueprintContent; digest: string | null }> {
  if (version === "draft") return { content: row.draft_package, digest: safeDigest(row.draft_package) || null };
  const v = await loadVersionPackage(db, row.id, version);
  return { content: v.content, digest: v.digest };
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

/** The library's tabs. "all" leaves archived Blueprints out; they have their own tab. "native" is everything not imported from GoHighLevel. */
export const LIBRARY_COLLECTIONS = ["all", "native", "imported_ghl", "featured", "drafts", "published", "archived"] as const;
export type LibraryCollection = (typeof LIBRARY_COLLECTIONS)[number];
export const LIBRARY_COLLECTION_LABELS: Record<LibraryCollection, string> = {
  all: "All", native: "Native", imported_ghl: "Imported GHL", featured: "Featured", drafts: "Drafts", published: "Published", archived: "Archived",
};

export const LIBRARY_SORTS = ["updated", "name", "created", "most_applied"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];
export const LIBRARY_SORT_LABELS: Record<LibrarySort, string> = { updated: "Last updated", name: "Name", created: "Newest", most_applied: "Most applied" };

export interface LibraryFilter {
  search?: string;
  /** Default "all". */
  collection?: LibraryCollection;
  industry?: BlueprintIndustry | null;
  /** A folder's id; null for Blueprints in no folder; omitted for every folder. */
  folderId?: string | null;
  source?: BlueprintSource | null;
  /** Default "updated". */
  sort?: LibrarySort;
}

const COLLECTION_SQL: Record<LibraryCollection, string> = {
  all: "b.status <> 'archived'",
  native: "b.status <> 'archived' and b.source_kind <> 'ghl_import'",
  imported_ghl: "b.status <> 'archived' and b.source_kind = 'ghl_import'",
  featured: "b.status <> 'archived' and b.featured",
  drafts: "b.status = 'draft'",
  published: "b.status = 'published'",
  archived: "b.status = 'archived'",
};

const SORT_SQL: Record<LibrarySort, string> = {
  updated: "b.updated_at desc, b.id",
  name: "lower(b.name), b.id",
  created: "b.created_at desc, b.id",
  most_applied: "applied_to desc, lower(b.name), b.id",
};

/**
 * Library cards, filtered and sorted. Unknown filter values (from a hand-edited address) are ignored rather than refused, so a stale link
 * still opens the library.
 */
export async function listBlueprints(user: AgencyUser, filter: LibraryFilter = {}): Promise<BlueprintSummary[]> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "list");
    const params: unknown[] = [scopeOf(user)];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const collection = (LIBRARY_COLLECTIONS as readonly string[]).includes(filter.collection ?? "") ? filter.collection! : "all";
    const where = [COLLECTION_SQL[collection]];
    if (filter.industry && (BLUEPRINT_INDUSTRIES as readonly string[]).includes(filter.industry)) where.push(`b.industry = ${p(filter.industry)}`);
    if (filter.source && (BLUEPRINT_SOURCES as readonly string[]).includes(filter.source)) where.push(`b.source_kind = ${p(filter.source)}`);
    if (filter.folderId === null) where.push("b.folder_id is null");
    else if (typeof filter.folderId === "string") where.push(isUuid(filter.folderId) ? `b.folder_id = ${p(filter.folderId)}` : "false");
    const search = typeof filter.search === "string" ? filter.search.trim().toLowerCase().slice(0, 100) : "";
    if (search) {
      const s = p(search);
      // The source label can name the client it came from: it is searched only for people who can reach that client.
      where.push(`(position(${s} in lower(b.name)) > 0 or position(${s} in lower(b.description)) > 0 or position(${s} in b.key) > 0
        or (${SOURCE_REACHABLE_SQL} and position(${s} in lower(coalesce(b.source_label, ''))) > 0))`);
    }
    const sort = (LIBRARY_SORTS as readonly string[]).includes(filter.sort ?? "") ? filter.sort! : "updated";
    const { rows } = await db.query<BlueprintRow>(`${SUMMARY_SELECT} where ${where.join(" and ")} order by ${SORT_SQL[sort]} limit 500`, params);
    return rows.map(toSummary);
  });
}

export interface LibraryCounts {
  collections: Record<LibraryCollection, number>;
  /** Blueprints that aren't archived, per industry. */
  industries: Record<BlueprintIndustry, number>;
  /** Blueprints that aren't archived and sit in no folder. */
  unfiled: number;
}

/** Counts for the library's tabs, industry chips and the "no folder" entry. */
export async function libraryCounts(user: AgencyUser): Promise<LibraryCounts> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "list");
    const { rows } = await db.query<{ status: string; source_kind: string; featured: boolean; industry: BlueprintIndustry; unfiled: boolean; n: number | string }>(
      "select status, source_kind, featured, industry, folder_id is null as unfiled, count(*) as n from crm_blueprints group by 1, 2, 3, 4, 5",
    );
    const collections = Object.fromEntries(LIBRARY_COLLECTIONS.map((c) => [c, 0])) as Record<LibraryCollection, number>;
    const industries = Object.fromEntries(BLUEPRINT_INDUSTRIES.map((i) => [i, 0])) as Record<BlueprintIndustry, number>;
    let unfiled = 0;
    for (const r of rows) {
      const n = Number(r.n);
      if (r.status === "archived") {
        collections.archived += n;
        continue;
      }
      collections.all += n;
      if (r.source_kind === "ghl_import") collections.imported_ghl += n;
      else collections.native += n;
      if (r.featured) collections.featured += n;
      if (r.status === "draft") collections.drafts += n;
      if (r.status === "published") collections.published += n;
      if (r.industry in industries) industries[r.industry] += n;
      if (r.unfiled) unfiled += n;
    }
    return { collections, industries, unfiled };
  });
}

/** Everything the details panel shows: the draft and its validation, the published content, versions, provenance and what the person may do. */
export async function getBlueprint(user: AgencyUser, id: string): Promise<BlueprintDetail> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "inspect");
    const scope = scopeOf(user);
    const row = await loadBlueprintRow(db, id, scope);
    const versions = (await listVersionRows(db, row.id)).map(toVersionView);
    // The import it was saved from, unless that import is a client's own GoHighLevel location the person can't reach (getImport refuses it too).
    const imp = await db.query<{ id: string; report: Partial<CompatReport> | null }>(
      `select i.id, i.report from crm_blueprint_imports i where i.blueprint_id = $1 and i.status = 'saved' and ${IMPORT_REACHABLE_SQL("$2")}
        order by i.saved_at desc limit 1`,
      [row.id, scope],
    );
    // The client a Blueprint was captured from is named only to people who can reach that client.
    let sourceOrgName: string | null = null;
    if (row.source_org_id) {
      const o = await db.query<{ name: string }>(
        "select name from organizations where id = $1 and ($2::uuid is null or exists (select 1 from staff_assignments s where s.org_id = $1 and s.user_id = $2))",
        [row.source_org_id, scope],
      );
      sourceOrgName = o.rows[0]?.name ?? null;
    }
    const check = validateContent(row.draft_package);
    const shown = row.published_package ?? row.draft_package;
    let reqDetails: BlueprintDetail["requirementDetails"] = [];
    let unpublishedDiff: BlueprintDiff | null = null;
    try {
      reqDetails = requirementDetails(shown);
      unpublishedDiff = row.published_package ? diffContents(row.published_package, row.draft_package) : null;
    } catch {
      // Stored content that can't be walked is already reported through draftErrors and the card's compatibility note.
    }
    return {
      ...toSummary(row),
      draft: row.draft_package,
      draftRevision: row.draft_revision,
      draftUpdatedAt: iso(row.draft_updated_at),
      draftUpdatedBy: row.draft_updated_by_name,
      published: row.published_package,
      unpublishedDiff,
      draftWarnings: check.warnings,
      draftErrors: check.errors,
      requirementDetails: reqDetails,
      versions,
      provenance: { importId: imp.rows[0]?.id ?? null, sourceOrgName, starterKey: row.starter_key },
      importReport: imp.rows[0] ? normalizeReport(imp.rows[0].report) : null,
      canDesign: canDoBlueprint(user, "edit"),
      canPublish: canDoBlueprint(user, "publish") && row.status !== "archived",
      canApply: canDoBlueprint(user, "apply") && row.current_version !== null && row.status !== "archived",
    };
  });
}

/** Every asset of the draft or a published version, as the inspection panel lists it. */
export async function inspectAssets(user: AgencyUser, id: string, version: number | "draft" = "draft"): Promise<AssetView[]> {
  const v = parse(versionSchema, version);
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "inspect");
    const row = await loadBlueprintRow(db, id, scopeOf(user));
    return assetViews((await contentAt(db, row, v)).content);
  });
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export type CreateFrom =
  | { kind: "blank" }
  | { kind: "starter"; starterKey: string }
  | { kind: "duplicate"; blueprintId: string; version: number | "draft" };

const createSchema = z.object({
  name: nameSchema,
  key: keySchema.optional(),
  description: descriptionSchema.optional(),
  industry: industrySchema,
  folderId: folderIdSchema.optional(),
  from: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("blank") }),
    z.object({ kind: z.literal("starter"), starterKey: z.string().max(64) }),
    z.object({ kind: z.literal("duplicate"), blueprintId: z.string().max(64), version: versionSchema }),
  ], { error: "Choose how to start the Blueprint." }),
});

/** A new draft Blueprint: blank, from an iAcquire starter (an editable copy), or a duplicate of a draft or published version. */
export async function createBlueprint(user: AgencyUser, input: { name: string; key?: string; description?: string; industry: BlueprintIndustry; folderId?: string | null; from: CreateFrom }): Promise<{ id: string }> {
  const data = parse(createSchema, input);
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, data.from.kind === "duplicate" ? "duplicate" : "create");
    let base: BlueprintContent | null = null;
    let source: BlueprintSource = "native";
    let sourceLabel: string | null = null;
    let sourceOrgId: string | null = null;
    if (data.from.kind === "starter") {
      const starter = getStarter(data.from.starterKey);
      if (!starter) throw new AppError("not_found", "That starter doesn't exist.");
      base = structuredClone(starter);
      sourceLabel = `Started from the iAcquire “${starter.blueprint.name}” starter`;
    } else if (data.from.kind === "duplicate") {
      const original = await loadBlueprintRow(db, data.from.blueprintId, scopeOf(user));
      base = (await contentAt(db, original, data.from.version)).content;
      // A copy keeps saying where its configuration came from (a starter's copy is the agency's own; only the installed starter is "starter").
      source = original.source_kind === "starter" ? "native" : original.source_kind;
      sourceOrgId = original.source_org_id;
      const of = `Copy of “${original.name}” (${data.from.version === "draft" ? "draft" : `version ${data.from.version}`})`;
      // Only what the person may see of the original's source travels to the copy (never the name of a client they can't reach).
      const shown = visibleSourceLabel(original);
      sourceLabel = (shown ? `${of} · ${shown}` : of).slice(0, 200);
    }
    const meta = {
      key: data.key ?? keyFromName(data.name),
      name: data.name,
      description: data.description ?? base?.blueprint.description ?? "",
      industry: data.industry,
    };
    const content = base ? withMeta(base, meta) : emptyBlueprint(meta);
    const r = await insertBlueprint(db, user, { content, source, sourceLabel, sourceOrgId, folderId: data.folderId ?? null, exactKey: data.key !== undefined });
    return { id: r.id };
  });
}

export interface InsertBlueprintInput {
  content: BlueprintContent;
  source: BlueprintSource;
  sourceLabel?: string | null;
  sourceOrgId?: string | null;
  starterKey?: string | null;
  folderId?: string | null;
  /**
   * Refuse when content.blueprint.key is taken (a key the person typed). Otherwise a taken key gets the next free "-2", "-3" … and the
   * returned key says which one.
   */
  exactKey?: boolean;
}

/**
 * Inserts a draft Blueprint inside the caller's transaction. Used by imports and capture; the caller has authorized the person. The content
 * must be storable (see checkDraft): structure, size, code and credentials are refused; other problems stay in the draft for a person to fix
 * and are returned.
 */
export async function insertBlueprint(db: Queryable, user: AgencyUser, input: InsertBlueprintInput): Promise<{ id: string; key: string; errors: ValidationIssue[]; warnings: ValidationIssue[] }> {
  const checked = checkDraft(input.content);
  if (!(BLUEPRINT_SOURCES as readonly string[]).includes(input.source)) throw new AppError("invalid_input", "Unknown Blueprint source.");
  const starterKey = input.starterKey ?? null;
  if (input.source === "starter" && !starterKey) throw new AppError("invalid_input", "A starter Blueprint needs its starter key.");
  if (starterKey && !BLUEPRINT_KEY_RE.test(starterKey)) throw new AppError("invalid_input", "That isn't a starter key.");
  if (input.sourceOrgId && !isUuid(input.sourceOrgId)) throw new AppError("invalid_input", "Unknown source client.");
  const folderId = input.folderId ?? null;
  if (folderId) {
    if (!isUuid(folderId)) throw new AppError("invalid_input", "Choose a folder from the list.");
    await assertFolder(db, folderId);
  }
  if (starterKey) {
    const dup = await db.query("select 1 from crm_blueprints where starter_key = $1", [starterKey]);
    if (dup.rows[0]) throw new AppError("conflict", "This starter is already in the library.");
  }
  const base = checked.content.blueprint.key;
  const label = input.sourceLabel ? input.sourceLabel.slice(0, 200) : null;
  for (let n = 1; n <= 200; n++) {
    const key = n === 1 ? base : suffixKey(base, n);
    const content: BlueprintContent = { ...checked.content, blueprint: { ...checked.content.blueprint, key } };
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_blueprints (key, name, description, industry, folder_id, source_kind, source_label, source_org_id, starter_key, draft_package,
                                   draft_updated_by, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $11)
       on conflict (key) do nothing returning id`,
      [key, content.blueprint.name, content.blueprint.description, content.blueprint.industry, folderId, input.source, label, input.sourceOrgId ?? null, starterKey,
        JSON.stringify(content), user.id],
    );
    if (rows[0]) {
      await audit(db, user, "crm.blueprint_created", "crm_blueprint", rows[0].id, { key, source: input.source, starter: starterKey, assets: totalAssets(content) });
      return { id: rows[0].id, key, errors: checked.errors, warnings: checked.warnings };
    }
    if (input.exactKey) throw new AppError("conflict", `Another Blueprint already uses the key “${base}”. Choose another key.`);
  }
  throw new AppError("conflict", "Too many Blueprints share this key. Choose another key.");
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

const detailsSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  industry: industrySchema.optional(),
  folderId: folderIdSchema.optional(),
  featured: z.boolean().optional(),
});

/**
 * Changes the library details. Name, description and industry are part of the package too, so changing them is a draft change (the draft
 * revision moves on, and an editor that started from the old one is asked to reload); the folder and the featured flag are library-only.
 */
export async function updateBlueprintDetails(user: AgencyUser, id: string, input: { name?: string; description?: string; industry?: BlueprintIndustry; folderId?: string | null; featured?: boolean }): Promise<{ revision: number }> {
  const data = parse(detailsSchema, input);
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "edit");
    const row = await lockBlueprint(db, id);
    refuseArchived(row);
    if (data.folderId) await assertFolder(db, data.folderId);
    const meta = row.draft_package.blueprint;
    const next = { key: row.key, name: data.name ?? row.name, description: data.description ?? row.description, industry: data.industry ?? row.industry };
    const metaChanged = next.name !== meta.name || next.description !== meta.description || next.industry !== meta.industry
      || next.name !== row.name || next.description !== row.description || next.industry !== row.industry;
    const folderId = data.folderId === undefined ? row.folder_id : data.folderId;
    const featured = data.featured ?? row.featured;
    const changed = [
      ...(metaChanged ? (["name", "description", "industry"] as const).filter((k) => next[k] !== row[k]) : []),
      ...(folderId !== row.folder_id ? ["folder"] : []),
      ...(featured !== row.featured ? ["featured"] : []),
    ];
    if (!metaChanged && !changed.length) return { revision: row.draft_revision };
    const revision = metaChanged ? row.draft_revision + 1 : row.draft_revision;
    await db.query(
      `update crm_blueprints set name = $2, description = $3, industry = $4, folder_id = $5, featured = $6,
              draft_package = case when $7 then $8::jsonb else draft_package end,
              draft_revision = $9,
              draft_updated_by = case when $7 then $10::uuid else draft_updated_by end,
              draft_updated_at = case when $7 then now() else draft_updated_at end
        where id = $1`,
      [row.id, next.name, next.description, next.industry, folderId, featured, metaChanged, JSON.stringify(withMeta(row.draft_package, next)), revision, user.id],
    );
    await audit(db, user, "crm.blueprint_updated", "crm_blueprint", row.id, { changed });
    return { revision };
  });
}

/**
 * Saves the working draft. `revision` is the draft revision the editor started from; a different current revision is a conflict, so two
 * people never overwrite each other unknowingly. The library key never changes through the editor. Saving identical content changes nothing.
 */
export async function saveDraft(user: AgencyUser, id: string, input: { content: BlueprintContent; revision: number }): Promise<{ revision: number; errors: ValidationIssue[]; warnings: ValidationIssue[] }> {
  const revision = parse(revisionSchema, input?.revision);
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "edit");
    const row = await lockBlueprint(db, id);
    refuseArchived(row, "edit it");
    if (row.draft_revision !== revision) {
      throw new AppError("conflict", "Someone saved this Blueprint after you opened it. Reload it to see their changes, then make yours again.");
    }
    const raw = input?.content as unknown;
    const incoming = raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>), blueprint: { ...((raw as { blueprint?: object }).blueprint ?? {}), key: row.key } }
      : raw;
    const checked = checkDraft(incoming);
    if (sameJson(checked.content, row.draft_package)) return { revision: row.draft_revision, errors: checked.errors, warnings: checked.warnings };
    const meta = checked.content.blueprint;
    await db.query(
      `update crm_blueprints set draft_package = $2::jsonb, draft_revision = draft_revision + 1, name = $3, description = $4, industry = $5,
              draft_updated_by = $6, draft_updated_at = now()
        where id = $1`,
      [row.id, JSON.stringify(checked.content), meta.name, meta.description, meta.industry, user.id],
    );
    await audit(db, user, "crm.blueprint_draft_saved", "crm_blueprint", row.id, { revision: row.draft_revision + 1, errors: checked.errors.length, warnings: checked.warnings.length });
    return { revision: row.draft_revision + 1, errors: checked.errors, warnings: checked.warnings };
  });
}

/**
 * Freezes content as the next version of a locked Blueprint: refuses content identical to the latest version, stores the digest, the
 * change list against the previous version and the counts, and marks the Blueprint published.
 */
async function publishInTx(db: Queryable, user: AgencyUser, row: Pick<LockedBlueprint, "id" | "current_version">, content: BlueprintContent, changeSummary: string | null): Promise<{ version: number; versionId: string }> {
  const prev = row.current_version ? await loadVersionPackage(db, row.id, row.current_version) : null;
  const digest = contentDigest(content);
  if (prev && prev.digest === digest) throw new AppError("conflict", `Nothing changed since version ${prev.version}. Edit the draft before publishing again.`);
  const diff = prev ? diffContents(prev.content, content) : null;
  const { rows: next } = await db.query<{ version: number }>("select coalesce(max(version), 0) + 1 as version from crm_blueprint_versions where blueprint_id = $1", [row.id]);
  const version = Number(next[0].version);
  const summary = (changeSummary?.trim() || autoChangeSummary(diff, content)).slice(0, 2000);
  const { rows } = await db.query<{ id: string }>(
    `insert into crm_blueprint_versions (blueprint_id, version, schema_version, package, digest, change_summary, changes, counts, published_by)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9) returning id`,
    [row.id, version, content.schemaVersion, JSON.stringify(content), digest, summary, JSON.stringify(capChanges(diff?.changes ?? [])), JSON.stringify(versionCounts(content)), user.id],
  );
  await db.query("update crm_blueprints set status = 'published', current_version = $2 where id = $1", [row.id, version]);
  await audit(db, user, "crm.blueprint_published", "crm_blueprint", row.id, { version, digest, changes: diff?.changes.length ?? null });
  return { version, versionId: rows[0].id };
}

/**
 * Freezes the draft as the next version. Refuses a stale revision (publish what you reviewed), any validation error, an empty Blueprint,
 * and a draft identical to the latest version. Published versions never change afterwards.
 */
export async function publishBlueprint(user: AgencyUser, id: string, input: { revision: number; changeSummary?: string }): Promise<{ version: number; versionId: string }> {
  const revision = parse(revisionSchema, input?.revision);
  const changeSummary = parse(z.string().trim().max(2000, "Change summaries can be at most 2,000 characters.").optional(), input?.changeSummary);
  if (changeSummary) checkFreeText(changeSummary, "change summary");
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "publish");
    const row = await lockBlueprint(db, id);
    refuseArchived(row, "publish it");
    if (row.draft_revision !== revision) {
      throw new AppError("conflict", "The draft changed after you reviewed it. Reload it, check the changes, then publish.");
    }
    const v = validateContent(row.draft_package);
    if (!v.ok || !v.content) throw new AppError("invalid_input", `Fix ${v.errors.length === 1 ? "this problem" : `these ${v.errors.length} problems`} before publishing: ${describeIssues(v.errors)}`);
    if (totalAssets(v.content) === 0) throw new AppError("invalid_input", "Add at least one asset before publishing.");
    if (v.content.blueprint.key !== row.key) throw new AppError("conflict", "The draft's key doesn't match this Blueprint. Save the draft again before publishing.");
    return publishInTx(db, user, row, v.content, changeSummary ?? null);
  });
}

/** Retires a Blueprint from the library. Its versions, and everything clients already applied, stay exactly as they are. */
export async function archiveBlueprint(user: AgencyUser, id: string): Promise<void> {
  await withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "archive");
    const row = await lockBlueprint(db, id);
    if (row.status === "archived") return;
    await db.query("update crm_blueprints set status = 'archived', archived_at = now() where id = $1", [row.id]);
    await audit(db, user, "crm.blueprint_archived", "crm_blueprint", row.id, { previous: row.status });
  });
}

/** Back into the library as published (when it has a published version) or as a draft. */
export async function unarchiveBlueprint(user: AgencyUser, id: string): Promise<void> {
  await withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "archive");
    const row = await lockBlueprint(db, id);
    if (row.status !== "archived") return;
    const status = row.current_version ? "published" : "draft";
    await db.query("update crm_blueprints set status = $2, archived_at = null where id = $1", [row.id, status]);
    await audit(db, user, "crm.blueprint_unarchived", "crm_blueprint", row.id, { status });
  });
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function listVersions(user: AgencyUser, id: string): Promise<VersionView[]> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "inspect");
    const row = await loadBlueprintRow(db, id, scopeOf(user));
    return (await listVersionRows(db, row.id)).map(toVersionView);
  });
}

/** The working draft, or a published version exactly as it was frozen. */
export async function getVersionContent(user: AgencyUser, id: string, version: number | "draft"): Promise<BlueprintContent> {
  const v = parse(versionSchema, version);
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "inspect");
    const row = await loadBlueprintRow(db, id, scopeOf(user));
    return (await contentAt(db, row, v)).content;
  });
}

export async function compareVersions(user: AgencyUser, id: string, from: number | "draft", to: number | "draft"): Promise<BlueprintDiff> {
  return (await compareView(user, id, from, to)).diff;
}

/** The comparison with both sides' digests, for the compare screen. */
export async function compareView(user: AgencyUser, id: string, from: number | "draft", to: number | "draft"): Promise<CompareView> {
  const a = parse(versionSchema, from);
  const b = parse(versionSchema, to);
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "compare");
    const row = await loadBlueprintRow(db, id, scopeOf(user));
    const left = await contentAt(db, row, a);
    const right = await contentAt(db, row, b);
    return { blueprintId: row.id, from: { version: a, digest: left.digest }, to: { version: b, digest: right.digest }, diff: diffContents(left.content, right.content) };
  });
}

/**
 * Copies a published version's assets, slots and settings into the working draft, to publish them again as a new version. The library
 * details (name, description, industry) stay as they are now, and nothing published changes.
 */
export async function restoreVersionToDraft(user: AgencyUser, id: string, version: number): Promise<{ revision: number }> {
  const v = parse(z.number({ error: "Choose a published version." }).int().min(1, "Choose a published version."), version);
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "edit");
    const row = await lockBlueprint(db, id);
    refuseArchived(row, "restore a version");
    const frozen = await loadVersionPackage(db, row.id, v);
    const checked = checkDraft(withMeta(frozen.content, { key: row.key, name: row.name, description: row.description, industry: row.industry }));
    if (sameJson(checked.content, row.draft_package)) return { revision: row.draft_revision };
    await db.query(
      "update crm_blueprints set draft_package = $2::jsonb, draft_revision = draft_revision + 1, draft_updated_by = $3, draft_updated_at = now() where id = $1",
      [row.id, JSON.stringify(checked.content), user.id],
    );
    await audit(db, user, "crm.blueprint_version_restored", "crm_blueprint", row.id, { version: v, revision: row.draft_revision + 1 });
    return { revision: row.draft_revision + 1 };
  });
}

// ---------------------------------------------------------------------------
// Library folders
// ---------------------------------------------------------------------------

/** Folders with how many Blueprints (not archived) each holds. */
export async function listLibraryFolders(user: AgencyUser): Promise<BlueprintFolderView[]> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "list");
    const { rows } = await db.query<{ id: string; name: string; count: number | string }>(
      `select f.id, f.name, (select count(*) from crm_blueprints b where b.folder_id = f.id and b.status <> 'archived') as count
         from crm_blueprint_folders f order by f.position, lower(f.name)`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count) }));
  });
}

const folderTaken = (name: string) => new AppError("conflict", `There is already a folder called “${name}”.`);
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "23505";

export async function createLibraryFolder(user: AgencyUser, name: string): Promise<{ id: string }> {
  const n = parse(folderNameSchema, name);
  try {
    return await withSystem(async (db) => {
      await authorizeBlueprintAction(db, user, "edit");
      const dup = await db.query("select 1 from crm_blueprint_folders where lower(name) = lower($1)", [n]);
      if (dup.rows[0]) throw folderTaken(n);
      const { rows } = await db.query<{ id: string }>(
        "insert into crm_blueprint_folders (name, position, created_by) values ($1, (select coalesce(max(position), -1) + 1 from crm_blueprint_folders), $2) returning id",
        [n, user.id],
      );
      await audit(db, user, "crm.blueprint_folder_created", "crm_blueprint_folder", rows[0].id, { name: n });
      return { id: rows[0].id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw folderTaken(n);
    throw err;
  }
}

export async function renameLibraryFolder(user: AgencyUser, id: string, name: string): Promise<void> {
  const n = parse(folderNameSchema, name);
  try {
    await withSystem(async (db) => {
      await authorizeBlueprintAction(db, user, "edit");
      if (!isUuid(id)) throw new AppError("not_found", "Folder not found.");
      const dup = await db.query("select 1 from crm_blueprint_folders where lower(name) = lower($1) and id <> $2", [n, id]);
      if (dup.rows[0]) throw folderTaken(n);
      const { rows } = await db.query("update crm_blueprint_folders set name = $2 where id = $1 returning id", [id, n]);
      if (!rows[0]) throw new AppError("not_found", "Folder not found.");
      await audit(db, user, "crm.blueprint_folder_renamed", "crm_blueprint_folder", id, { name: n });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw folderTaken(n);
    throw err;
  }
}

/** Deletes a folder. Its Blueprints stay in the library, in no folder. */
export async function deleteLibraryFolder(user: AgencyUser, id: string): Promise<void> {
  await withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "edit");
    if (!isUuid(id)) throw new AppError("not_found", "Folder not found.");
    const { rows } = await db.query<{ name: string }>("delete from crm_blueprint_folders where id = $1 returning name", [id]);
    if (!rows[0]) throw new AppError("not_found", "Folder not found.");
    await audit(db, user, "crm.blueprint_folder_deleted", "crm_blueprint_folder", id, { name: rows[0].name });
  });
}

// ---------------------------------------------------------------------------
// iAcquire starters
// ---------------------------------------------------------------------------

/** Every iAcquire starter, and whether it is already in the library. */
export async function listStarters(user: AgencyUser): Promise<StarterView[]> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "list");
    const { rows } = await db.query<{ id: string; starter_key: string }>("select id, starter_key from crm_blueprints where starter_key is not null");
    const installed = new Map(rows.map((r) => [r.starter_key, r.id]));
    return STARTER_BLUEPRINTS.map((s) => ({
      key: s.blueprint.key,
      name: s.blueprint.name,
      description: s.blueprint.description,
      industry: s.blueprint.industry,
      modules: modulesOf(s),
      totalAssets: totalAssets(s),
      requirements: deriveRequirements(s),
      installedId: installed.get(s.blueprint.key) ?? null,
    }));
  });
}

/** A starter's content, for the preview before installing or copying it. */
export async function getStarterContent(user: AgencyUser, starterKey: string): Promise<BlueprintContent> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "list");
    const starter = typeof starterKey === "string" ? getStarter(starterKey) : null;
    if (!starter) throw new AppError("not_found", "That starter doesn't exist.");
    return structuredClone(starter);
  });
}

/**
 * Adds an iAcquire starter to the library as a published Blueprint (version 1), because it is iAcquire's own reviewed content. Publishing
 * needs the publish permission. Installing twice returns the existing Blueprint (`created: false`), even when two people install at once.
 */
export async function installStarter(user: AgencyUser, starterKey: string): Promise<{ id: string; created: boolean }> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "publish");
    const starter = typeof starterKey === "string" ? getStarter(starterKey) : null;
    if (!starter) throw new AppError("not_found", "That starter doesn't exist.");
    const key = starter.blueprint.key;
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`crm-blueprint-starter:${key}`]);
    const existing = await db.query<{ id: string }>("select id from crm_blueprints where starter_key = $1", [key]);
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
    const v = validateContent(structuredClone(starter));
    if (!v.ok || !v.content) throw new AppError("invalid_input", `This starter can't be installed: ${describeIssues(v.errors)}`);
    const inserted = await insertBlueprint(db, user, { content: v.content, source: "starter", sourceLabel: "iAcquire starter", starterKey: key });
    const content: BlueprintContent = { ...v.content, blueprint: { ...v.content.blueprint, key: inserted.key } };
    await publishInTx(db, user, { id: inserted.id, current_version: null }, content, `iAcquire starter, first version. ${autoChangeSummary(null, content)}`);
    await audit(db, user, "crm.blueprint_starter_installed", "crm_blueprint", inserted.id, { starter: key });
    return { id: inserted.id, created: true };
  });
}

// ---------------------------------------------------------------------------
// Package files
// ---------------------------------------------------------------------------

/**
 * The package file for a published version: its frozen content, a manifest computed from it and its integrity digest. A version whose stored
 * digest no longer matches its content is refused rather than exported.
 */
export async function exportPackage(user: AgencyUser, id: string, version: number): Promise<{ filename: string; json: string }> {
  const v = parse(z.number({ error: "Choose a published version to export." }).int().min(1, "Choose a published version to export."), version);
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "export");
    const row = await loadBlueprintRow(db, id, scopeOf(user));
    const frozen = await loadVersionPackage(db, row.id, v);
    if (safeDigest(frozen.content) !== frozen.digest) {
      throw new AppError("conflict", `Version ${v} doesn't match its recorded digest, so it can't be exported. Contact iAcquire support.`);
    }
    let json: string;
    try {
      json = serializePackage(buildPackageFile(frozen.content, { sha: sha256 }));
    } catch (err) {
      if (err instanceof BlueprintValidationError) throw new AppError("conflict", `Version ${v} no longer passes validation, so it can't be exported: ${err.message}`);
      throw err;
    }
    await audit(db, user, "crm.blueprint_exported", "crm_blueprint", row.id, { version: v, digest: frozen.digest });
    return { filename: `${row.key}-v${v}.iacquire-blueprint.json`, json };
  });
}

/**
 * Reads a package file without trusting anything in it (size before parsing, format, integrity on the content as exported, format upgrades,
 * strict validation incl. code and credential scanning), and records the attempt in the import history: previewed when it can be saved,
 * failed otherwise (a failed file's content is never stored). Nothing is added to the library until the import is saved.
 */
export async function previewPackageImport(user: AgencyUser, json: string): Promise<PackageImportPreview> {
  if (typeof json !== "string") throw new AppError("invalid_input", "Choose a Blueprint package file.");
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "import_file");
    const result = json.length > BLUEPRINT_MAX_BYTES
      ? { ok: false, content: null, upgradedFrom: null, integrity: "missing" as const, manifest: "missing" as const, errors: [{ severity: "error" as const, code: "too_large", path: "", message: `The file is larger than ${BLUEPRINT_MAX_BYTES / 1000} KB, the limit for a Blueprint package.`, assetId: null }], warnings: [] as ValidationIssue[] }
      : readPackage(json, { sha: sha256 });
    const content = result.ok ? result.content : null;
    const limitations: string[] = [];
    if (result.upgradedFrom) limitations.push(`This package was written in format version ${result.upgradedFrom} and was upgraded to version ${BLUEPRINT_SCHEMA_VERSION}.`);
    if (result.integrity === "missing" && content) limitations.push("The package has no integrity digest, so there is no proof it wasn't changed after export.");
    const report = content ? reportForContent(content, limitations) : makeReport([], limitations);
    const error = result.ok ? null : (result.errors[0]?.message ?? "This file can't be imported.").slice(0, 500);
    const sourceLabel = (content ? `Package file: ${content.blueprint.name}` : "Package file").slice(0, 200);
    const status = content ? "previewed" : "failed";
    const counts = { discovered: report.summary.discovered, converted: report.summary.fullySupported, partial: report.summary.partiallySupported, unsupported: report.summary.unsupported, failed: report.summary.failed };
    const { rows } = await db.query<{ id: string; created_at: Date | string }>(
      `insert into crm_blueprint_imports (source_kind, source_label, status, report, package, counts, error, created_by)
       values ('package_file', $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7) returning id, created_at`,
      [sourceLabel, status, JSON.stringify(report), content ? JSON.stringify(content) : null, JSON.stringify(counts), error, user.id],
    );
    await audit(db, user, "crm.blueprint_import_previewed", "crm_blueprint_import", rows[0].id, { source: "package_file", status, errors: result.errors.length, integrity: result.integrity });
    const name = await db.query<{ name: string }>(`select ${PERSON_NAME("u")} as name from users u where u.id = $1`, [user.id]);
    return {
      id: rows[0].id,
      sourceKind: "package_file",
      sourceLabel,
      status,
      counts,
      blueprintId: null,
      createdBy: name.rows[0]?.name ?? null,
      createdAt: iso(rows[0].created_at),
      report,
      content,
      validation: { errors: result.errors, warnings: result.warnings },
      error,
      upgradedFrom: result.upgradedFrom,
      integrity: result.integrity,
      manifest: result.manifest,
    };
  });
}

// ---------------------------------------------------------------------------
// Import history (package files and GoHighLevel)
// ---------------------------------------------------------------------------

/** The source label of a Blueprint saved from a client's own GoHighLevel location. */
const CLIENT_IMPORT_SOURCE_LABEL = "Imported from a client's GoHighLevel location";

/** Which permission an import needs: package files are design work; GoHighLevel imports read a stored credential (super admins only). */
function importAction(row: Pick<ImportRow, "source_kind" | "source_org_id">): { action: BlueprintAction; orgId: string | null } {
  if (row.source_kind === "package_file") return { action: "import_file", orgId: null };
  if (row.source_kind === "ghl_client" && row.source_org_id) return { action: "import_ghl_client", orgId: row.source_org_id };
  return { action: "import_ghl", orgId: null };
}

/**
 * An import the person may see: an import from a client's own GoHighLevel location is visible only to people who can reach that client.
 * Locked when `lock` is set (saving and discarding).
 */
async function loadImport(db: Queryable, user: AgencyUser, importId: string, lock = false): Promise<ImportRow> {
  const missing = () => new AppError("not_found", "Import not found.");
  if (!isUuid(importId)) throw missing();
  if (lock) await db.query("select 1 from crm_blueprint_imports where id = $1 for update", [importId]);
  const { rows } = await db.query<ImportRow>(`${IMPORT_SELECT} where i.id = $1`, [importId]);
  const row = rows[0];
  if (!row) throw missing();
  const scope = scopeOf(user);
  if (scope && row.source_kind === "ghl_client") {
    const a = await db.query("select 1 from staff_assignments where org_id = $1 and user_id = $2", [row.source_org_id, scope]);
    if (!a.rows[0]) throw missing();
  }
  return row;
}

/**
 * Saves a previewed import (a package file or a GoHighLevel import) as a new draft Blueprint, optionally only some assets (and what they
 * depend on) and with other details. Saving twice returns the Blueprint the first save made.
 */
export async function saveImport(user: AgencyUser, importId: string, input: { name?: string; key?: string; industry?: BlueprintIndustry; assetIds?: string[] }): Promise<{ blueprintId: string }> {
  const data = parse(z.object({
    name: nameSchema.optional(),
    key: keySchema.optional(),
    industry: industrySchema.optional(),
    assetIds: z.array(z.string().max(96)).max(5000).optional(),
  }), input ?? {});
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "import_file");
    const row = await loadImport(db, user, importId, true);
    const need = importAction(row);
    await authorizeBlueprintAction(db, user, need.action, need.orgId);
    if (row.status === "saved" && row.blueprint_id) return { blueprintId: row.blueprint_id };
    if (row.status === "discarded") throw new AppError("conflict", "This import was discarded. Import the source again.");
    if (row.status !== "previewed" || !row.package) throw new AppError("conflict", "Nothing could be converted from this import, so there is nothing to save.");
    let content = row.package;
    if (data.assetIds) content = selectAssets(content, data.assetIds);
    content = withMeta(content, {
      key: data.key ?? content.blueprint.key,
      name: data.name ?? content.blueprint.name,
      description: content.blueprint.description,
      industry: data.industry ?? content.blueprint.industry,
    });
    const source: BlueprintSource = row.source_kind === "package_file" ? "file_import" : "ghl_import";
    // A client's own location is never named in the library (every agency person sees it); source_org_id records which client it was.
    const sourceLabel = row.source_kind === "ghl_client" ? CLIENT_IMPORT_SOURCE_LABEL : row.source_label;
    const inserted = await insertBlueprint(db, user, {
      content, source, sourceLabel, sourceOrgId: row.source_kind === "ghl_client" ? row.source_org_id : null, exactKey: data.key !== undefined,
    });
    await db.query("update crm_blueprint_imports set status = 'saved', blueprint_id = $2, saved_at = now() where id = $1", [row.id, inserted.id]);
    await audit(db, user, "crm.blueprint_import_saved", "crm_blueprint_import", row.id, { blueprint: inserted.id, source: row.source_kind, assets: totalAssets(content) });
    return { blueprintId: inserted.id };
  });
}

/** Discards a previewed import: its report stays in the history, the proposed content is dropped. */
export async function discardImport(user: AgencyUser, importId: string): Promise<void> {
  await withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "import_file");
    const row = await loadImport(db, user, importId, true);
    const need = importAction(row);
    await authorizeBlueprintAction(db, user, need.action, need.orgId);
    if (row.status === "discarded") return;
    if (row.status === "saved") throw new AppError("conflict", "This import is already saved as a Blueprint. Archive the Blueprint instead.");
    await db.query("update crm_blueprint_imports set status = 'discarded', package = null where id = $1", [row.id]);
    await audit(db, user, "crm.blueprint_import_discarded", "crm_blueprint_import", row.id, { source: row.source_kind });
  });
}

/** The import history, newest first. Imports from a client's own GoHighLevel location are listed only to people who can reach that client. */
export async function listImports(user: AgencyUser): Promise<ImportSummary[]> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "list");
    const { rows } = await db.query<ImportRow>(
      `select i.id, i.source_kind, ${IMPORT_LABEL_SQL} as source_label, i.status, jsonb_build_object('summary', i.report -> 'summary') as report, i.counts,
              i.blueprint_id, i.created_at, ${PERSON_NAME("u")} as created_by_name
         from crm_blueprint_imports i left join users u on u.id = i.created_by left join organizations so on so.id = i.source_org_id
        where ${IMPORT_REACHABLE_SQL("$1")}
        order by i.created_at desc, i.id limit 200`,
      [scopeOf(user)],
    );
    return rows.map(toImportSummary);
  });
}

export async function getImport(user: AgencyUser, importId: string): Promise<ImportDetail> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "inspect");
    return toImportDetail(await loadImport(db, user, importId));
  });
}

// ---------------------------------------------------------------------------
// Applications and clients
// ---------------------------------------------------------------------------

/** One live application, as update coverage reads it. */
interface LiveApplicationRow {
  org_id: string;
  blueprint_id: string;
  version: number;
  sections: string[] | null;
  /** Narrowed to some assets (options.assetIds): it covers no section as a whole. */
  narrowed: boolean;
  created_at: Date | string;
}

/** Every live application of the given (client, Blueprint) pairs, newest first within each pair. */
async function liveApplicationRows(db: Queryable, pairs: Array<{ orgId: string; blueprintId: string }>): Promise<Map<string, LiveApplicationRow[]>> {
  const out = new Map<string, LiveApplicationRow[]>();
  if (!pairs.length) return out;
  const { rows } = await db.query<LiveApplicationRow>(
    `select a.org_id, a.blueprint_id, a.version, a.sections, coalesce((a.summary ->> 'narrowed')::boolean, false) as narrowed, a.created_at
       from crm_blueprint_applications a
       join unnest($1::uuid[], $2::uuid[]) as p(org_id, blueprint_id) on p.org_id = a.org_id and p.blueprint_id = a.blueprint_id
      where a.status in ${LIVE_SQL}
      order by a.org_id, a.blueprint_id, a.created_at desc, a.version desc, a.id desc`,
    [pairs.map((p) => p.orgId), pairs.map((p) => p.blueprintId)],
  );
  for (const r of rows) {
    const k = `${r.org_id}|${r.blueprint_id}`;
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}

interface Coverage {
  /** The version the client has as a whole (see UpdateCandidate.appliedVersion). */
  appliedVersion: number;
  /** Sections of the latest version still to apply; only computed when asked for, or when a section-limited update followed a full one. */
  pending: AssetSection[];
  /** A newer version is published, or a section-limited update left part of the latest version out. */
  updateAvailable: boolean;
  lastAppliedAt: Date | string;
}

/**
 * What of a Blueprint's latest version a client's live applications cover. The newest full application (every section, not narrowed to some
 * assets) is the baseline (the oldest live one when there is none); a section counts as applied when the latest version doesn't change it
 * since the baseline, or when a later application took that section from a version that has it as the latest does. So an update applied
 * to some sections only still offers the rest. Published versions are read once per call.
 */
class UpdateCoverage {
  private readonly packages = new Map<string, Promise<BlueprintContent>>();
  private readonly changed = new Map<string, Promise<AssetSection[]>>();
  constructor(private readonly db: Queryable, private readonly latest: (blueprintId: string) => number | null) {}

  private content(blueprintId: string, version: number): Promise<BlueprintContent> {
    const k = `${blueprintId}@${version}`;
    let p = this.packages.get(k);
    if (!p) this.packages.set(k, (p = loadVersionPackage(this.db, blueprintId, version).then((v) => v.content)));
    return p;
  }

  /** Sections the latest version changes compared with `version`. */
  changedSince(blueprintId: string, version: number): Promise<AssetSection[]> {
    const latest = this.latest(blueprintId);
    if (!latest || version >= latest) return Promise.resolve([]);
    const k = `${blueprintId}@${version}`;
    let p = this.changed.get(k);
    if (!p) {
      this.changed.set(k, (p = (async () => {
        const [from, to] = await Promise.all([this.content(blueprintId, version), this.content(blueprintId, latest)]);
        try {
          return changedSections(diffContents(from, to));
        } catch {
          // Stored content that can't be compared: offer every section rather than none.
          return [...ASSET_SECTIONS];
        }
      })()));
    }
    return p;
  }

  /** `apps`: the live applications of one Blueprint in one client, newest first. */
  async of(blueprintId: string, apps: readonly LiveApplicationRow[], opts: { sections: boolean }): Promise<Coverage> {
    const newest = apps[0];
    const latest = this.latest(blueprintId) ?? newest.version;
    const full = apps.findIndex((a) => !a.narrowed && !(a.sections?.length));
    const b = full >= 0 ? full : apps.length - 1;
    const baseline = apps[b];
    if (b === 0 && !opts.sections) {
      return { appliedVersion: newest.version, pending: [], updateAvailable: newest.version < latest, lastAppliedAt: newest.created_at };
    }
    const after = apps.slice(0, b);
    const pending: AssetSection[] = [];
    for (const s of await this.changedSince(blueprintId, baseline.version)) {
      let covered = false;
      for (const a of after) {
        if (a.narrowed || (a.sections?.length && !a.sections.includes(s))) continue;
        if ((await this.changedSince(blueprintId, a.version)).includes(s)) continue;
        covered = true;
        break;
      }
      if (!covered) pending.push(s);
    }
    return {
      appliedVersion: pending.length ? baseline.version : newest.version,
      pending,
      updateAvailable: pending.length > 0 || newest.version < latest,
      lastAppliedAt: newest.created_at,
    };
  }
}

/**
 * Whether part of a Blueprint's latest version is still to apply in one client: a newer version, or sections a section-limited update left
 * out. The same coverage listApplications works out for the newest live application, for one (client, Blueprint) pair, so an application's
 * detail and an apply result can offer "the rest of vN" too. Trusted: the caller authorized the reader.
 */
export async function liveUpdateAvailable(db: Queryable, orgId: string, blueprintId: string, latestVersion: number | null): Promise<boolean> {
  const apps = (await liveApplicationRows(db, [{ orgId, blueprintId }])).get(`${orgId}|${blueprintId}`);
  if (!apps?.length) return false;
  return (await new UpdateCoverage(db, () => latestVersion).of(blueprintId, apps, { sections: false })).updateAvailable;
}

interface ApplicationRow {
  id: string;
  org_id: string;
  org_name: string;
  blueprint_id: string;
  blueprint_name: string;
  version: number;
  latest_version: number | null;
  mode: "initial" | "update";
  strategy: ApplyStrategy;
  status: ApplicationStatus;
  requested_by_name: string | null;
  requested_via: "agency" | "onboarding";
  created_at: Date | string;
  rolled_back_at: Date | string | null;
  newest_live: boolean;
}

/**
 * Applications of Blueprints to the clients the person can reach (staff: the clients they are assigned to), newest first, optionally for one
 * Blueprint or one client. canRollBack marks the newest live application of each Blueprint in each workspace: the only one a rollback accepts.
 */
export async function listApplications(user: AgencyUser, filter: { blueprintId?: string; orgId?: string } = {}): Promise<ApplicationSummary[]> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "list");
    if ((filter.blueprintId !== undefined && !isUuid(filter.blueprintId)) || (filter.orgId !== undefined && !isUuid(filter.orgId))) return [];
    const { rows } = await db.query<ApplicationRow>(
      `select a.id, a.org_id, o.name as org_name, a.blueprint_id, a.blueprint_name, a.version, b.current_version as latest_version, a.mode, a.strategy, a.status,
              ${PERSON_NAME("u")} as requested_by_name, a.requested_via, a.created_at, a.rolled_back_at,
              (a.status in ${LIVE_SQL} and a.id = (
                 select a2.id from crm_blueprint_applications a2
                  where a2.org_id = a.org_id and a2.blueprint_id = a.blueprint_id and a2.status in ${LIVE_SQL}
                  order by a2.created_at desc, a2.version desc, a2.id desc limit 1)) as newest_live
         from crm_blueprint_applications a
         join organizations o on o.id = a.org_id
         join crm_blueprints b on b.id = a.blueprint_id
         left join users u on u.id = a.requested_by
        where ($1::uuid is null or exists (select 1 from staff_assignments s where s.org_id = a.org_id and s.user_id = $1))
          and ($2::uuid is null or a.blueprint_id = $2)
          and ($3::uuid is null or a.org_id = $3)
        order by a.created_at desc, a.version desc, a.id desc limit 500`,
      [scopeOf(user), filter.blueprintId ?? null, filter.orgId ?? null],
    );
    const counts = new Map<string, Partial<Record<PlanAction, number>>>();
    if (rows.length) {
      const c = await db.query<{ application_id: string; action: PlanAction; n: number | string }>(
        "select application_id, action, count(*) as n from crm_blueprint_application_items where application_id = any($1::uuid[]) group by 1, 2",
        [rows.map((r) => r.id)],
      );
      for (const r of c.rows) counts.set(r.application_id, { ...(counts.get(r.application_id) ?? {}), [r.action]: Number(r.n) });
    }
    // Whether the latest version is still (partly) to apply, on the newest live application of each Blueprint in each client.
    const newest = rows.filter((r) => r.newest_live);
    const latestOf = new Map(rows.map((r) => [r.blueprint_id, r.latest_version]));
    const coverage = new UpdateCoverage(db, (bp) => latestOf.get(bp) ?? null);
    const live = await liveApplicationRows(db, newest.map((r) => ({ orgId: r.org_id, blueprintId: r.blueprint_id })));
    const updateAvailable = new Set<string>();
    for (const r of newest) {
      const apps = live.get(`${r.org_id}|${r.blueprint_id}`);
      if (apps?.length && (await coverage.of(r.blueprint_id, apps, { sections: false })).updateAvailable) updateAvailable.add(r.id);
    }
    return rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      orgName: r.org_name,
      blueprintId: r.blueprint_id,
      blueprintName: r.blueprint_name,
      version: r.version,
      latestVersion: r.latest_version,
      mode: r.mode,
      strategy: r.strategy,
      status: r.status,
      counts: counts.get(r.id) ?? {},
      requestedBy: r.requested_by_name,
      requestedVia: r.requested_via,
      createdAt: iso(r.created_at),
      rolledBackAt: isoOrNull(r.rolled_back_at),
      canRollBack: Boolean(r.newest_live),
      updateAvailable: updateAvailable.has(r.id),
    }));
  });
}

/**
 * Clients (the person can reach, not archived) that don't have this Blueprint's latest version as a whole: an older version is live there,
 * or a section-limited update left some of the latest version's changes out. Each comes with the sections still to apply. Nothing is
 * pushed: each client's update is reviewed and confirmed on its own.
 */
export async function listUpdateCandidates(user: AgencyUser, blueprintId: string): Promise<UpdateCandidate[]> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "inspect");
    const row = await loadBlueprintRow(db, blueprintId, scopeOf(user));
    if (!row.current_version || !row.published_package) return [];
    const latest = row.current_version;
    const { rows } = await db.query<{ org_id: string; org_name: string }>(
      `select distinct a.org_id, o.name as org_name
         from crm_blueprint_applications a join organizations o on o.id = a.org_id
        where a.blueprint_id = $1 and a.status in ${LIVE_SQL} and o.status <> 'archived'
          and ($2::uuid is null or exists (select 1 from staff_assignments s where s.org_id = a.org_id and s.user_id = $2))`,
      [row.id, scopeOf(user)],
    );
    const live = await liveApplicationRows(db, rows.map((r) => ({ orgId: r.org_id, blueprintId: row.id })));
    const coverage = new UpdateCoverage(db, () => latest);
    const out: UpdateCandidate[] = [];
    for (const r of rows) {
      const apps = live.get(`${r.org_id}|${row.id}`);
      if (!apps?.length) continue;
      const c = await coverage.of(row.id, apps, { sections: true });
      if (!c.updateAvailable) continue;
      out.push({ orgId: r.org_id, orgName: r.org_name, appliedVersion: c.appliedVersion, latestVersion: latest, lastAppliedAt: iso(c.lastAppliedAt), changedSections: c.pending });
    }
    return out.sort((a, b) => a.orgName.toLowerCase().localeCompare(b.orgName.toLowerCase()) || a.orgId.localeCompare(b.orgId));
  });
}

/**
 * Clients the person can work on (super admins: every client; staff: their assigned clients, for previews), not archived, with their CRM
 * mode and the Blueprints live in each: the version each client has as a whole (its newest live version, or the version of its newest full
 * application when a later section-limited update left part of the latest version out, so the update is still offered).
 */
export async function listClientOptions(user: AgencyUser): Promise<ClientOption[]> {
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "list");
    const { rows } = await db.query<{ id: string; name: string; industry: string | null; mode: ClientOption["crmMode"] }>(
      `select o.id, o.name, o.industry, coalesce(w.mode, 'native') as mode
         from organizations o left join crm_workspaces w on w.org_id = o.id
        where o.kind = 'client' and o.status <> 'archived'
          and ($1::uuid is null or exists (select 1 from staff_assignments s where s.org_id = o.id and s.user_id = $1))
        order by lower(o.name), o.id limit 2000`,
      [scopeOf(user)],
    );
    const applied = new Map<string, ClientOption["appliedBlueprints"]>();
    if (rows.length) {
      const a = await db.query<{ org_id: string; blueprint_id: string; name: string; latest: number | null }>(
        `select distinct a.org_id, a.blueprint_id, b.name, b.current_version as latest
           from crm_blueprint_applications a join crm_blueprints b on b.id = a.blueprint_id
          where a.org_id = any($1::uuid[]) and a.status in ${LIVE_SQL}
          order by a.org_id, a.blueprint_id`,
        [rows.map((r) => r.id)],
      );
      const latestOf = new Map(a.rows.map((r) => [r.blueprint_id, r.latest]));
      const coverage = new UpdateCoverage(db, (bp) => latestOf.get(bp) ?? null);
      const live = await liveApplicationRows(db, a.rows.map((r) => ({ orgId: r.org_id, blueprintId: r.blueprint_id })));
      for (const r of a.rows) {
        const apps = live.get(`${r.org_id}|${r.blueprint_id}`);
        if (!apps?.length) continue;
        const c = await coverage.of(r.blueprint_id, apps, { sections: false });
        applied.set(r.org_id, [...(applied.get(r.org_id) ?? []), { blueprintId: r.blueprint_id, name: r.name, version: c.appliedVersion }]);
      }
    }
    return rows.map((r) => ({ id: r.id, name: r.name, industry: r.industry, crmMode: r.mode, appliedBlueprints: applied.get(r.id) ?? [] }));
  });
}
