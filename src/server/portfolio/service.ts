import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { readAuthorizedPrivateFile, uploadPrivateFile, removePrivateFile } from "@/server/storage/private";
import type { SessionUser } from "@/server/auth/service";
import { FOUNDER_ATTRIBUTION, portfolioTitle, type PortfolioStatus } from "@/lib/projects";

export interface PortfolioSection {
  heading: string;
  body?: string;
  items?: string[];
}

export interface PortfolioCard {
  id: string;
  slug: string;
  title: string;
  summary: string;
  status: PortfolioStatus;
  statusLabel: string;
  technologies: string[];
  categories: string[];
  featured: boolean;
  attribution: string;
  coverAssetId: string | null;
  services: Array<{ slug: string; name: string }>;
}

export interface PortfolioAssetView {
  id: string;
  alt: string;
  caption: string | null;
  kind: string;
  anonymized: boolean;
  width: number | null;
  height: number | null;
}

export interface PortfolioDetail extends PortfolioCard {
  problem: string;
  solution: string;
  publishedOutcome: string | null;
  sections: PortfolioSection[];
  limitations: string[];
  privacyNote: string | null;
  liveDemoUrl: string | null;
  assets: PortfolioAssetView[];
}

interface ProjectRow {
  id: string;
  slug: string;
  title: string;
  anonymized_title: string | null;
  client_name_public: boolean;
  summary: string;
  problem: string;
  solution: string;
  published_outcome: string | null;
  sections: PortfolioSection[];
  limitations: string[];
  privacy_note: string | null;
  technologies: string[];
  categories: string[];
  project_status: PortfolioStatus;
  status_label: string | null;
  live_demo_url: string | null;
  attribution: string;
  featured: boolean;
}

const STATUS_FALLBACK: Record<PortfolioStatus, string> = { built: "Built", in_development: "In development", built_locally: "Built locally", planned: "Planned" };

async function relatedServices(db: Queryable, projectIds: string[]) {
  if (!projectIds.length) return new Map<string, Array<{ slug: string; name: string }>>();
  // Service visibility is enforced by row-level security for clients.
  const { rows } = await db.query<{ project_id: string; slug: string; name: string }>(
    `select l.project_id, s.slug, s.name from service_portfolio_links l join service_catalog s on s.id = l.service_id
     where l.project_id = any($1::uuid[]) and s.kind <> 'maintenance_plan' order by l.sort_order, s.name`,
    [projectIds],
  );
  const map = new Map<string, Array<{ slug: string; name: string }>>();
  for (const r of rows) map.set(r.project_id, [...(map.get(r.project_id) ?? []), { slug: r.slug, name: r.name }]);
  return map;
}

async function assetsFor(db: Queryable, projectIds: string[]) {
  if (!projectIds.length) return new Map<string, Array<PortfolioAssetView>>();
  // Only granted, non-sensitive columns are readable here; storage keys never leave the server.
  const { rows } = await db.query<PortfolioAssetView & { project_id: string }>(
    `select id, project_id, kind, alt, caption, anonymized, width, height from portfolio_assets
     where project_id = any($1::uuid[]) order by (kind = 'cover') desc, sort_order, created_at`,
    [projectIds],
  );
  const map = new Map<string, Array<PortfolioAssetView>>();
  for (const r of rows) map.set(r.project_id, [...(map.get(r.project_id) ?? []), { id: r.id, alt: r.alt, caption: r.caption, kind: r.kind, anonymized: r.anonymized, width: r.width, height: r.height }]);
  return map;
}

const card = (r: ProjectRow, assets: PortfolioAssetView[], services: Array<{ slug: string; name: string }>): PortfolioCard => ({
  id: r.id,
  slug: r.slug,
  title: portfolioTitle({ title: r.title, anonymizedTitle: r.anonymized_title, clientNamePublic: r.client_name_public }),
  summary: r.summary,
  status: r.project_status,
  statusLabel: r.status_label ?? STATUS_FALLBACK[r.project_status],
  technologies: r.technologies,
  categories: r.categories,
  featured: r.featured,
  attribution: r.attribution || FOUNDER_ATTRIBUTION,
  coverAssetId: assets[0]?.id ?? null,
  services,
});

/** Published, reviewed projects only. Row-level security hides everything else from clients. */
export async function listPortfolio(userId: string): Promise<PortfolioCard[]> {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<ProjectRow>("select * from portfolio_projects where visible order by featured desc, sort_order, title");
    const ids = rows.map((r) => r.id);
    const [assets, services] = await Promise.all([assetsFor(db, ids), relatedServices(db, ids)]);
    return rows.map((r) => card(r, assets.get(r.id) ?? [], services.get(r.id) ?? []));
  });
}

export async function getPortfolioProject(userId: string, slug: string): Promise<PortfolioDetail | null> {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<ProjectRow>("select * from portfolio_projects where slug = $1 and visible", [slug]);
    const r = rows[0];
    if (!r) return null;
    const [assets, services] = await Promise.all([assetsFor(db, [r.id]), relatedServices(db, [r.id])]);
    const a = assets.get(r.id) ?? [];
    return {
      ...card(r, a, services.get(r.id) ?? []),
      problem: r.problem,
      solution: r.solution,
      publishedOutcome: r.published_outcome,
      sections: Array.isArray(r.sections) ? r.sections : [],
      limitations: r.limitations,
      privacyNote: r.privacy_note,
      liveDemoUrl: r.live_demo_url,
      assets: a,
    };
  });
}

/** Hosts an admin may import screenshots from (and preview unimported references of): the founder's own portfolio site only. */
const IMPORT_HOSTS = ["www.automatewithmarky.com"];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function fetchSourceImage(sourceUrl: string): Promise<Buffer> {
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:" || !IMPORT_HOSTS.includes(url.host)) throw new AppError("forbidden", "Images can only be imported from the approved source site.");
  try {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000), headers: { Accept: "image/*" } });
    if (!res.ok) throw new Error(String(res.status));
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) throw new Error("large");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("large");
    return bytes;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("upstream_error", "The source image could not be downloaded.");
  }
}

/**
 * Image bytes for a portfolio asset, always served from this app's own origin. Visibility is decided by
 * row-level security (published asset of a visible project, or agency staff). Only stored images can be
 * published, so a client can only ever reach stored bytes; an unimported source reference is previewed
 * for staff alone, fetched on demand from the approved source host.
 */
export async function getPortfolioImage(userId: string, assetId: string, variant: "full" | "thumb") {
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new AppError("not_found", "Image not found.");
  const visible = await withUser(userId, async (db) => (await db.query("select 1 from portfolio_assets where id = $1", [assetId])).rows[0]);
  if (!visible) throw new AppError("not_found", "Image not found.");
  const a = (await withSystem((db) =>
    db.query<{ private_file_id: string | null; thumb_file_id: string | null; source_url: string | null; published: boolean }>("select private_file_id, thumb_file_id, source_url, published from portfolio_assets where id = $1", [assetId]),
  )).rows[0];
  if (!a) throw new AppError("not_found", "Image not found.");
  const fileId = variant === "thumb" ? (a.thumb_file_id ?? a.private_file_id) : a.private_file_id;
  if (fileId) {
    const f = await readAuthorizedPrivateFile(fileId);
    return { bytes: f.bytes, mime: f.mime_type };
  }
  // Defence in depth: a published asset without a stored file is never served from a third-party host.
  if (!a.source_url || a.published) throw new AppError("not_found", "Image not found.");
  const bytes = await fetchSourceImage(a.source_url);
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : bytes.subarray(0, 4).equals(Buffer.from("RIFF")) ? "image/webp" : null;
  if (!mime) throw new AppError("upstream_error", "The source did not return a supported image.");
  return { bytes, mime };
}

// ---------------------------------------------------------------------------
// Agency management
// ---------------------------------------------------------------------------

function assertPortfolioAdmin(user: SessionUser) {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only agency super admins can manage the portfolio.");
}

export interface AdminPortfolioRow {
  id: string;
  slug: string;
  title: string;
  anonymizedTitle: string | null;
  clientNamePublic: boolean;
  summary: string;
  problem: string;
  solution: string;
  publishedOutcome: string | null;
  sections: PortfolioSection[];
  limitations: string[];
  privacyNote: string | null;
  technologies: string[];
  categories: string[];
  status: PortfolioStatus;
  statusLabel: string | null;
  liveDemoUrl: string | null;
  attribution: string;
  sourceUrl: string | null;
  sourceImportedAt: string | null;
  featured: boolean;
  reviewState: "pending_review" | "approved";
  disclosureConfirmed: boolean;
  visible: boolean;
  sortOrder: number;
  serviceSlugs: string[];
  assets: Array<PortfolioAssetView & { published: boolean; stored: boolean; sourceUrl: string | null; sortOrder: number }>;
}

export async function listPortfolioForAdmin(user: SessionUser): Promise<{ projects: AdminPortfolioRow[]; services: Array<{ slug: string; name: string }> }> {
  assertPortfolioAdmin(user);
  return withSystem(async (db) => {
    const projects = (await db.query<ProjectRow & { source_url: string | null; source_imported_at: Date | null; review_state: "pending_review" | "approved"; disclosure_confirmed: boolean; visible: boolean; sort_order: number }>(
      "select * from portfolio_projects order by (review_state = 'pending_review') desc, featured desc, sort_order, title",
    )).rows;
    const assets = (await db.query<{ id: string; project_id: string; kind: string; alt: string; caption: string | null; anonymized: boolean; width: number | null; height: number | null; published: boolean; private_file_id: string | null; source_url: string | null; sort_order: number }>(
      "select id, project_id, kind, alt, caption, anonymized, width, height, published, private_file_id, source_url, sort_order from portfolio_assets order by (kind = 'cover') desc, sort_order, created_at",
    )).rows;
    const links = (await db.query<{ project_id: string; slug: string }>("select l.project_id, s.slug from service_portfolio_links l join service_catalog s on s.id = l.service_id order by l.sort_order")).rows;
    const services = (await db.query<{ slug: string; name: string }>("select slug, name from service_catalog where kind <> 'maintenance_plan' order by name")).rows;
    return {
      services,
      projects: projects.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        anonymizedTitle: r.anonymized_title,
        clientNamePublic: r.client_name_public,
        summary: r.summary,
        problem: r.problem,
        solution: r.solution,
        publishedOutcome: r.published_outcome,
        sections: Array.isArray(r.sections) ? r.sections : [],
        limitations: r.limitations,
        privacyNote: r.privacy_note,
        technologies: r.technologies,
        categories: r.categories,
        status: r.project_status,
        statusLabel: r.status_label,
        liveDemoUrl: r.live_demo_url,
        attribution: r.attribution,
        sourceUrl: r.source_url,
        sourceImportedAt: r.source_imported_at ? new Date(r.source_imported_at).toISOString() : null,
        featured: r.featured,
        reviewState: r.review_state,
        disclosureConfirmed: r.disclosure_confirmed,
        visible: r.visible,
        sortOrder: r.sort_order,
        serviceSlugs: links.filter((l) => l.project_id === r.id).map((l) => l.slug),
        assets: assets.filter((a) => a.project_id === r.id).map((a) => ({ id: a.id, alt: a.alt, caption: a.caption, kind: a.kind, anonymized: a.anonymized, width: a.width, height: a.height, published: a.published, stored: Boolean(a.private_file_id), sourceUrl: a.source_url, sortOrder: a.sort_order })),
      })),
    };
  });
}

const strList = (max: number, len: number) => z.array(z.string().trim().min(1).max(len)).max(max).default([]);
export const portfolioInputSchema = z.object({
  id: z.string().uuid().optional(),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/, "Use lowercase letters, numbers and dashes."),
  title: z.string().trim().min(2).max(200),
  anonymizedTitle: z.string().trim().max(200).nullable().default(null),
  clientNamePublic: z.boolean().default(false),
  summary: z.string().trim().max(1200).default(""),
  problem: z.string().trim().max(4000).default(""),
  solution: z.string().trim().max(4000).default(""),
  publishedOutcome: z.string().trim().max(600).nullable().default(null),
  sections: z.array(z.object({ heading: z.string().trim().min(1).max(120), body: z.string().trim().max(2000).optional(), items: z.array(z.string().trim().min(1).max(400)).max(30).optional() })).max(20).default([]),
  limitations: strList(10, 300),
  privacyNote: z.string().trim().max(600).nullable().default(null),
  technologies: strList(20, 60),
  categories: strList(12, 60),
  status: z.enum(["built", "in_development", "built_locally", "planned"]).default("built"),
  statusLabel: z.string().trim().max(60).nullable().default(null),
  liveDemoUrl: z
    .union([z.literal("").transform(() => null), z.string().trim().url().max(500).regex(/^https:\/\//, "Use an https link.")])
    .nullable()
    .default(null),
  attribution: z.string().trim().max(120).default(FOUNDER_ATTRIBUTION),
  featured: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(100000).default(0),
  serviceSlugs: z.array(z.string().max(80)).max(20).optional(),
});
export type PortfolioInput = z.input<typeof portfolioInputSchema>;

/** Editing never publishes. Visibility changes go through reviewPortfolioProject. */
export async function savePortfolioProject(user: SessionUser, input: PortfolioInput): Promise<{ id: string }> {
  assertPortfolioAdmin(user);
  const d = portfolioInputSchema.parse(input);
  return withSystem(async (db) => {
    const dup = await db.query("select 1 from portfolio_projects where slug = $1 and id is distinct from $2::uuid", [d.slug, d.id ?? null]);
    if (dup.rows[0]) throw new AppError("conflict", "Another project already uses that web address name.");
    const v = [d.slug, d.title, d.anonymizedTitle, d.clientNamePublic, d.summary, d.problem, d.solution, d.publishedOutcome, JSON.stringify(d.sections), d.limitations, d.privacyNote, d.technologies, d.categories, d.status, d.statusLabel, d.liveDemoUrl, d.attribution, d.featured, d.sortOrder, user.id];
    let id = d.id;
    if (id) {
      const r = await db.query(
        `update portfolio_projects set slug=$2,title=$3,anonymized_title=$4,client_name_public=$5,summary=$6,problem=$7,solution=$8,published_outcome=$9,
           sections=$10::jsonb,limitations=$11,privacy_note=$12,technologies=$13,categories=$14,project_status=$15,status_label=$16,live_demo_url=$17,
           attribution=$18,featured=$19,sort_order=$20,updated_by=$21 where id=$1 returning id`,
        [id, ...v],
      );
      if (!r.rows[0]) throw new AppError("not_found", "Project not found.");
    } else {
      id = (await db.query<{ id: string }>(
        `insert into portfolio_projects (slug,title,anonymized_title,client_name_public,summary,problem,solution,published_outcome,sections,limitations,privacy_note,
           technologies,categories,project_status,status_label,live_demo_url,attribution,featured,sort_order,created_by,updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20) returning id`,
        v,
      )).rows[0].id;
    }
    if (d.serviceSlugs) {
      await db.query("delete from service_portfolio_links where project_id = $1", [id]);
      for (const [i, slug] of d.serviceSlugs.entries()) {
        await db.query("insert into service_portfolio_links (service_id, project_id, sort_order) select s.id, $1, $3 from service_catalog s where s.slug = $2 on conflict do nothing", [id, slug, i]);
      }
    }
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: d.id ? "portfolio.project_updated" : "portfolio.project_created", targetType: "portfolio_project", targetId: id!, result: "success", metadata: { slug: d.slug } }, db);
    return { id: id! };
  });
}

export type PortfolioReviewAction = "approve_and_publish" | "hide" | "unapprove";

/**
 * The review gate. Publishing requires an explicit confirmation that public disclosure is permitted;
 * the database enforces that nothing is visible without an approved review and that confirmation.
 */
export async function reviewPortfolioProject(user: SessionUser, projectId: string, action: PortfolioReviewAction, opts: { disclosureConfirmed?: boolean } = {}) {
  assertPortfolioAdmin(user);
  await withSystem(async (db) => {
    const found = (await db.query<{ slug: string }>("select slug from portfolio_projects where id = $1", [projectId])).rows[0];
    if (!found) throw new AppError("not_found", "Project not found.");
    if (action === "approve_and_publish") {
      if (!opts.disclosureConfirmed) throw new AppError("invalid_input", "Confirm that public disclosure of this project (name, details and screenshots) is permitted before publishing.");
      await db.query("update portfolio_projects set review_state='approved', disclosure_confirmed=true, visible=true, updated_by=$2 where id=$1", [projectId, user.id]);
    } else if (action === "hide") {
      await db.query("update portfolio_projects set visible=false, updated_by=$2 where id=$1", [projectId, user.id]);
    } else {
      await db.query("update portfolio_projects set visible=false, review_state='pending_review', disclosure_confirmed=false, updated_by=$2 where id=$1", [projectId, user.id]);
    }
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: `portfolio.${action}`, targetType: "portfolio_project", targetId: projectId, result: "success", metadata: { slug: found.slug } }, db);
  });
}

export async function updatePortfolioAsset(user: SessionUser, assetId: string, changes: { published?: boolean; anonymized?: boolean; alt?: string; caption?: string | null; sortOrder?: number; kind?: "cover" | "screenshot" }) {
  assertPortfolioAdmin(user);
  const d = z.object({ published: z.boolean().optional(), anonymized: z.boolean().optional(), alt: z.string().trim().max(300).optional(), caption: z.string().trim().max(300).nullable().optional(), sortOrder: z.number().int().min(0).max(1000).optional(), kind: z.enum(["cover", "screenshot"]).optional() }).parse(changes);
  await withSystem(async (db) => {
    if (d.published) {
      const cur = (await db.query<{ private_file_id: string | null }>("select private_file_id from portfolio_assets where id = $1", [assetId])).rows[0];
      if (cur && !cur.private_file_id) throw new AppError("conflict", "Import a copy or upload your own screenshot before publishing this image. Linked images can't be shown to clients.");
    }
    const r = await db.query<{ project_id: string }>(
      `update portfolio_assets set published = coalesce($2, published), anonymized = coalesce($3, anonymized), alt = coalesce($4, alt),
         caption = case when $5::boolean then $6 else caption end, sort_order = coalesce($7, sort_order), kind = coalesce($8, kind) where id = $1 returning project_id`,
      [assetId, d.published ?? null, d.anonymized ?? null, d.alt ?? null, d.caption !== undefined, d.caption ?? null, d.sortOrder ?? null, d.kind ?? null],
    );
    if (!r.rows[0]) throw new AppError("not_found", "Image not found.");
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "portfolio.asset_updated", targetType: "portfolio_asset", targetId: assetId, result: "success", metadata: d }, db);
  });
}

async function agencyOrgId(db: Queryable): Promise<string> {
  const r = (await db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1")).rows[0];
  if (r) return r.id;
  // Portfolio images are agency-owned files, and every stored file belongs to an organization. The seed script
  // normally creates the agency organization; create the same minimal record here if it was never seeded.
  const created = await db.query<{ id: string }>(
    "insert into organizations (name, slug, kind, status, timezone, onboarding_completed_at) values ('iAcquire', 'iacquire', 'agency', 'active', 'UTC', now()) on conflict do nothing returning id",
  );
  const id = created.rows[0]?.id ?? (await db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1")).rows[0]?.id;
  if (!id) throw new AppError("integration_unavailable", "The agency workspace could not be prepared for image storage.");
  return id;
}

/** Re-encodes to WebP at web sizes (full 1600px, thumbnail 640px) and strips metadata. */
export async function optimizeImage(bytes: Buffer) {
  const sharp = (await import("sharp")).default;
  let base;
  try {
    base = sharp(bytes, { limitInputPixels: 40_000_000 }).rotate();
    await base.metadata();
  } catch {
    throw new AppError("invalid_input", "That file could not be read as an image.");
  }
  const full = await base.clone().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
  const thumb = await base.clone().resize({ width: 640, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  return { full: full.data, width: full.info.width, height: full.info.height, thumb };
}

async function storeImage(user: SessionUser, orgId: string, baseName: string, bytes: Buffer) {
  const opt = await optimizeImage(bytes);
  const safe = (baseName.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^\w\-]+/g, "_").slice(0, 80) || "image");
  const dir = crypto.randomUUID();
  const full = await uploadPrivateFile({ userId: user.id, orgId, bucket: "portfolio-assets", path: `${orgId}/${dir}/${safe}.webp`, bytes: opt.full, contentType: "image/webp", filename: `${safe}.webp`, visibility: "internal" });
  try {
    const thumb = await uploadPrivateFile({ userId: user.id, orgId, bucket: "portfolio-assets", path: `${orgId}/${crypto.randomUUID()}/${safe}-thumb.webp`, bytes: opt.thumb, contentType: "image/webp", filename: `${safe}-thumb.webp`, visibility: "internal" });
    return { fullId: full.id, thumbId: thumb.id, width: opt.width, height: opt.height, fullPath: full.storageKey };
  } catch (e) {
    await removePrivateFile({ userId: user.id, orgId, bucket: "portfolio-assets", path: full.storageKey }).catch(() => undefined);
    throw e;
  }
}

export async function uploadPortfolioAsset(user: SessionUser, projectId: string, file: { name: string; bytes: Buffer }, meta: { alt: string; caption?: string | null; kind?: "cover" | "screenshot" }) {
  assertPortfolioAdmin(user);
  const limit = await consumeRateLimit(RATE_LIMITS.uploadByUser, user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "Upload limit reached. Try again later.");
  if (!file.bytes.length || file.bytes.length > 10 * 1024 * 1024) throw new AppError("invalid_input", "Choose an image up to 10 MB.");
  const orgId = await withSystem(async (db) => {
    if (!(await db.query("select 1 from portfolio_projects where id = $1", [projectId])).rows[0]) throw new AppError("not_found", "Project not found.");
    return agencyOrgId(db);
  });
  const stored = await storeImage(user, orgId, file.name, file.bytes);
  return withSystem(async (db) => {
    const r = await db.query<{ id: string }>(
      `insert into portfolio_assets (project_id, kind, private_file_id, thumb_file_id, alt, caption, width, height, created_by, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,(select coalesce(max(sort_order),0)+10 from portfolio_assets where project_id = $1)) returning id`,
      [projectId, meta.kind ?? "screenshot", stored.fullId, stored.thumbId, meta.alt.slice(0, 300), meta.caption ?? null, stored.width, stored.height, user.id],
    );
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "portfolio.asset_uploaded", targetType: "portfolio_asset", targetId: r.rows[0].id, result: "success", metadata: { projectId } }, db);
    return { id: r.rows[0].id };
  });
}

/** Admin action: copies a referenced source image into private storage (optimized). Not run automatically. */
export async function importAssetFromSource(user: SessionUser, assetId: string) {
  assertPortfolioAdmin(user);
  const a = (await withSystem((db) => db.query<{ source_url: string | null; private_file_id: string | null }>("select source_url, private_file_id from portfolio_assets where id = $1", [assetId]))).rows[0];
  if (!a) throw new AppError("not_found", "Image not found.");
  if (a.private_file_id) throw new AppError("conflict", "This image is already stored in iAcquire.");
  if (!a.source_url) throw new AppError("invalid_input", "This image has no source to import.");
  const bytes = await fetchSourceImage(a.source_url);
  const orgId = await withSystem((db) => agencyOrgId(db));
  const stored = await storeImage(user, orgId, new URL(a.source_url).pathname.split("/").at(-1) ?? "image", bytes);
  await withSystem(async (db) => {
    await db.query("update portfolio_assets set private_file_id=$2, thumb_file_id=$3, width=$4, height=$5 where id=$1", [assetId, stored.fullId, stored.thumbId, stored.width, stored.height]);
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "portfolio.asset_imported", targetType: "portfolio_asset", targetId: assetId, result: "success", metadata: { host: new URL(a.source_url!).host } }, db);
  });
}

export async function deletePortfolioAsset(user: SessionUser, assetId: string) {
  assertPortfolioAdmin(user);
  const a = (await withSystem((db) => db.query<{ private_file_id: string | null; thumb_file_id: string | null }>("select private_file_id, thumb_file_id from portfolio_assets where id = $1", [assetId]))).rows[0];
  if (!a) throw new AppError("not_found", "Image not found.");
  const files = await withSystem((db) => db.query<{ id: string; org_id: string; storage_key: string }>("select id, org_id, storage_key from private_files where id = any($1::uuid[])", [[a.private_file_id, a.thumb_file_id].filter(Boolean)]));
  await withSystem(async (db) => {
    await db.query("delete from portfolio_assets where id = $1", [assetId]);
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "portfolio.asset_deleted", targetType: "portfolio_asset", targetId: assetId, result: "success" }, db);
  });
  for (const f of files.rows) await removePrivateFile({ userId: user.id, orgId: f.org_id, bucket: "portfolio-assets", path: f.storage_key }).catch(() => undefined);
}

export interface PublicPortfolioProject {
  slug: string;
  title: string;
  summary: string;
  problem: string;
  solution: string;
  status: PortfolioStatus;
  statusLabel: string;
  technologies: string[];
  categories: string[];
  attribution: string;
  limitations: string[];
  privacyNote: string | null;
  liveDemoUrl: string | null;
}

/** Published, reviewed projects only. Images stay private and are not part of this feed. */
export async function listPublicPortfolio(): Promise<PublicPortfolioProject[]> {
  const { rows } = await withSystem((db) => db.query<ProjectRow>("select * from portfolio_projects where visible and review_state = 'approved' and disclosure_confirmed order by featured desc, sort_order, title"));
  return rows.map((r) => ({
    slug: r.slug,
    title: portfolioTitle({ title: r.title, anonymizedTitle: r.anonymized_title, clientNamePublic: r.client_name_public }),
    summary: r.summary,
    problem: r.problem,
    solution: r.solution,
    status: r.project_status,
    statusLabel: r.status_label ?? STATUS_FALLBACK[r.project_status],
    technologies: r.technologies,
    categories: r.categories,
    attribution: r.attribution || FOUNDER_ATTRIBUTION,
    limitations: r.limitations,
    privacyNote: r.privacy_note,
    liveDemoUrl: r.live_demo_url,
  }));
}
