import "server-only";
import sharp from "sharp";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";
import { roleHasPermission, type Permission } from "@/lib/permissions";
import { eachElement, parseContent, referencedAssetIds, type SiteContent } from "@/lib/website/doc";
import { ELEMENT_DEFS } from "@/lib/website/catalog";
import { tokenValues } from "@/lib/website/instantiate";
import { builtInCards } from "@/lib/website/gallery-data";
import { INDUSTRY_FILTERS, type GalleryCard } from "@/lib/website/gallery";
import { blankTemplateContent, instantiateTemplate, type Origin } from "@/lib/website/instantiate";
import { buildSite, resolveTemplate, sampleSite } from "@/lib/website/templates";
import type { SiteDetails } from "@/lib/website/templates/types";

export type TemplateStatus = "draft" | "in_review" | "published" | "hidden" | "archived";
export const isCustomKey = (key: string) => key.startsWith("custom.");

export interface TemplateView {
  id: string | null;
  key: string;
  kind: "builtin" | "custom";
  name: string;
  description: string;
  familyId: string;
  familyName: string;
  industries: string[];
  tags: string[];
  status: TemplateStatus;
  featured: boolean;
  version: number;
  basedOn: string | null;
  mode: "light" | "dark";
  updatedAt: string | null;
  publishedAt: string | null;
  updatedByName: string | null;
  hasPreviewImage: boolean;
  /** The working copy has changes that clients don't see yet. */
  unpublishedChanges: boolean;
  /** Websites that began from this template. They keep their own copy, so this is informational. */
  sitesUsing: number;
}

const need = (user: SessionUser, permission: Permission) => {
  if (!roleHasPermission(user.platformRole === "none" ? null : user.platformRole, permission)) throw new AppError("forbidden", "You don't have access to manage templates.");
};

interface Row {
  id: string; key: string; kind: "builtin" | "custom"; name: string; description: string; family: string; industries: string[]; tags: string[]; status: TemplateStatus; featured: boolean;
  version: number; based_on: string | null; updated_at: Date; published_at: Date | null; updated_name: string | null; has_preview: boolean; unpublished: boolean;
}

const SELECT = `t.id, t.key, t.kind, t.name, t.description, t.family, t.industries, t.tags, t.status, t.featured, t.version, t.based_on, t.updated_at, t.published_at, u.full_name as updated_name,
  (t.preview_image is not null) as has_preview, (t.kind = 'custom' and t.draft_content is not null and t.draft_content is distinct from t.content) as unpublished`;

async function usage(db: Queryable): Promise<Map<string, number>> {
  const { rows } = await db.query<{ k: string; n: string }>("select template_key as k, count(*) as n from websites group by template_key");
  return new Map(rows.map((r) => [r.k, Number(r.n)]));
}

/** Every template the agency manages: the built-in designs (with the agency's choices applied) and the agency's own. */
export async function listLibrary(user: SessionUser): Promise<TemplateView[]> {
  need(user, "website.templates.design");
  return withSystem(async (db) => {
    const { rows } = await db.query<Row>(`select ${SELECT} from website_templates t left join users u on u.id = t.updated_by`);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const used = await usage(db);
    const out: TemplateView[] = [];
    for (const c of builtInCards()) {
      const o = byKey.get(c.key);
      out.push({
        id: o?.id ?? null, key: c.key, kind: "builtin", name: c.name, description: c.description, familyId: c.familyId, familyName: c.familyName,
        industries: c.industries, tags: [...new Set([...c.tags, ...(o?.tags ?? [])])], status: o?.status ?? "published", featured: o ? o.featured : c.featured, version: o?.version ?? 1,
        basedOn: null, mode: c.mode, updatedAt: o ? new Date(o.updated_at).toISOString() : null, publishedAt: o?.published_at ? new Date(o.published_at).toISOString() : null,
        updatedByName: o?.updated_name ?? null, hasPreviewImage: o?.has_preview ?? false, unpublishedChanges: false, sitesUsing: used.get(c.key) ?? 0,
      });
    }
    for (const r of rows.filter((x) => x.kind === "custom")) {
      out.push({
        id: r.id, key: r.key, kind: "custom", name: r.name, description: r.description, familyId: r.family, familyName: r.family === "custom" ? "Agency design" : r.family, industries: r.industries, tags: r.tags,
        status: r.status, featured: r.featured, version: r.version, basedOn: r.based_on, mode: "light", updatedAt: new Date(r.updated_at).toISOString(), publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
        updatedByName: r.updated_name, hasPreviewImage: r.has_preview, unpublishedChanges: r.unpublished, sitesUsing: used.get(r.key) ?? 0,
      });
    }
    return out;
  });
}

/** What clients may choose from: built-in designs not hidden or archived, and the agency's own published designs. */
export async function listPublishedCards(): Promise<GalleryCard[]> {
  const rows = await withSystem(async (db) => (await db.query<Row>(`select ${SELECT} from website_templates t left join users u on u.id = t.updated_by`)).rows);
  const overlay = new Map(rows.filter((r) => r.kind === "builtin").map((r) => [r.key, r]));
  const hidden = new Set([...overlay.values()].filter((r) => r.status !== "published").map((r) => r.key));
  const featured = new Set([...overlay.values()].filter((r) => r.featured).map((r) => r.key));
  const noOverlayFeatured = builtInCards().filter((c) => c.featured && !overlay.has(c.key)).map((c) => c.key);
  const cards = builtInCards({ hidden, featured: new Set([...featured, ...noOverlayFeatured]), added: new Map() });
  for (const r of rows.filter((x) => x.kind === "custom" && x.status === "published")) {
    const sample = await withSystem(async (db) => (await db.query<{ content: unknown }>("select content from website_templates where id = $1", [r.id])).rows[0]?.content);
    const parsed = parseContent(sample);
    cards.push({
      key: r.key, source: "custom", familyId: r.family, familyName: r.family === "custom" ? "Agency design" : r.family, familyTagline: "", name: r.name, description: r.description, tags: r.tags,
      industries: r.industries.filter((i) => INDUSTRY_FILTERS.some((f) => f.id === i)), styles: [], featured: r.featured, mode: "light", addedAt: new Date(r.published_at ?? r.updated_at).toISOString(),
      pages: parsed.ok ? parsed.content.pages.map((p) => ({ slug: p.slug, title: p.navLabel || p.title })) : [{ slug: "home", title: "Home" }],
    });
  }
  return cards;
}

/** Whether a client may start a site from this template right now. */
export async function isOfferable(key: string): Promise<boolean> {
  if (isCustomKey(key)) {
    const { rows } = await withSystem((db) => db.query("select 1 from website_templates where key = $1 and kind = 'custom' and status = 'published' and content is not null", [key]));
    return rows.length > 0;
  }
  if (!resolveTemplate(key)) return false;
  const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from website_templates where key = $1 and kind = 'builtin'", [key]));
  return !rows[0] || rows[0].status === "published";
}

/** Builds a client's first draft from a template: a built-in design from the facts, or an agency design copied and filled in. */
export async function buildFromTemplate(key: string, details: SiteDetails, opts: { requireOffered?: boolean } = {}): Promise<{ content: SiteContent; templateKey: string }> {
  // Starting a new site needs a design the agency currently offers. Rebuilding a site from the design it already uses does not.
  if (opts.requireOffered !== false && !(await isOfferable(key))) throw new AppError("invalid_input", "Choose one of the templates.");
  if (!isCustomKey(key)) {
    if (!resolveTemplate(key)) throw new AppError("invalid_input", "Choose one of the templates.");
    return { content: buildSite(key, details), templateKey: key };
  }
  const row = (await withSystem((db) => db.query<{ id: string; content: unknown; version: number }>("select id, content, version from website_templates where key = $1", [key]))).rows[0];
  const parsed = parseContent(row?.content);
  if (!row || !parsed.ok) throw new AppError("invalid_input", "That template isn't available right now.");
  const origin: Origin = { key, templateId: row.id, version: row.version };
  const built = instantiateTemplate(parsed.content, details, origin);
  if (!built.ok) throw new AppError("invalid_input", `That template couldn't be used: ${built.error}`);
  return { content: built.content, templateKey: key };
}

// ---------------------------------------------------------------------------
// Designing
// ---------------------------------------------------------------------------

const slugOf = (name: string) => name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "design";

async function uniqueKey(db: Queryable, name: string): Promise<string> {
  const base = slugOf(name);
  for (let i = 0; i < 50; i += 1) {
    const key = `custom.${i === 0 ? base : `${base}-${i + 1}`}`;
    const { rows } = await db.query("select 1 from website_templates where key = $1", [key]);
    if (!rows.length) return key;
  }
  return `custom.${base}-${Date.now().toString(36)}`;
}

export interface TemplateDraft {
  id: string;
  key: string;
  name: string;
  status: TemplateStatus;
  version: number;
  revision: number;
  content: SiteContent;
  updatedAt: string;
}

export async function createTemplate(user: SessionUser, input: { name: string; from: { kind: "blank" } | { kind: "builtin"; key: string } | { kind: "custom"; key: string }; description?: string; industries?: string[]; tags?: string[] }): Promise<{ id: string; key: string }> {
  need(user, "website.templates.design");
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new AppError("invalid_input", "Give the template a name of 2 to 80 characters.");
  let content: SiteContent;
  let basedOn: string | null = null;
  let family = "custom";
  if (input.from.kind === "blank") content = blankTemplateContent(name);
  else if (input.from.kind === "builtin") {
    const t = resolveTemplate(input.from.key);
    if (!t) throw new AppError("invalid_input", "That template wasn't found.");
    content = structuredClone(sampleSite(t.key));
    basedOn = t.key;
    family = t.family.id;
  } else {
    const sourceKey = input.from.key;
    const row = (await withSystem((db) => db.query<{ draft_content: unknown; family: string }>("select draft_content, family from website_templates where key = $1 and kind = 'custom'", [sourceKey]))).rows[0];
    const parsed = parseContent(row?.draft_content);
    if (!row || !parsed.ok) throw new AppError("not_found", "That template wasn't found.");
    content = structuredClone(parsed.content);
    basedOn = sourceKey;
    family = row.family;
  }
  return withSystem(async (db) => {
    const key = await uniqueKey(db, name);
    const stored: SiteContent = { ...content, isSample: true, origin: { key, templateId: null, version: 0 } };
    const { rows } = await db.query<{ id: string }>(
      `insert into website_templates (key, kind, name, description, family, industries, tags, status, draft_content, based_on, created_by, updated_by)
       values ($1, 'custom', $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $9) returning id`,
      [key, name, (input.description ?? "").slice(0, 300), family === "custom" ? "custom" : family, (input.industries ?? []).slice(0, 12), (input.tags ?? []).slice(0, 16), JSON.stringify(stored), basedOn, user.id],
    );
    await recordAudit({ orgId: null, actorUserId: user.id, actorKind: "user", action: "website.template_created", targetType: "website_template", targetId: rows[0].id, result: "success", metadata: { key, basedOn } }, db);
    return { id: rows[0].id, key };
  });
}

export async function getTemplateDraft(user: SessionUser, id: string): Promise<TemplateDraft> {
  need(user, "website.templates.design");
  const r = (await withSystem((db) => db.query<{ id: string; key: string; name: string; status: TemplateStatus; version: number; draft_revision: number; draft_content: unknown; updated_at: Date }>(
    "select id, key, name, status, version, draft_revision, draft_content, updated_at from website_templates where id = $1 and kind = 'custom'", [id]))).rows[0];
  if (!r) throw new AppError("not_found", "Template not found.");
  const parsed = parseContent(r.draft_content);
  if (!parsed.ok) throw new AppError("internal", "This template's saved design couldn't be read.");
  return { id: r.id, key: r.key, name: r.name, status: r.status, version: r.version, revision: r.draft_revision, content: parsed.content, updatedAt: new Date(r.updated_at).toISOString() };
}

export class TemplateConflictError extends AppError {
  constructor() {
    super("conflict", "This template was changed in another window or by a teammate. Reload to see the latest before editing.");
  }
}

export async function saveTemplateDraft(user: SessionUser, id: string, input: { content: unknown; expectedRevision: number }): Promise<{ revision: number }> {
  need(user, "website.templates.design");
  const parsed = parseContent(input.content);
  if (!parsed.ok) throw new AppError("invalid_input", `${parsed.error}${parsed.path ? ` (${parsed.path})` : ""}`);
  // A template is shared with every client, so it can never point at one tenant's uploaded image.
  if (referencedAssetIds(parsed.content).length > 0) throw new AppError("invalid_input", "A template can use built-in artwork only. Remove uploaded images from it: they belong to one client.");
  const { rows } = await withSystem((db) =>
    db.query<{ draft_revision: number }>(
      "update website_templates set draft_content = $2, draft_revision = draft_revision + 1, updated_by = $4, updated_at = now() where id = $1 and kind = 'custom' and draft_revision = $3 returning draft_revision",
      [id, JSON.stringify({ ...parsed.content, isSample: true }), input.expectedRevision, user.id]),
  );
  if (!rows[0]) throw new TemplateConflictError();
  return { revision: rows[0].draft_revision };
}

export interface TemplateMeta { name?: string; description?: string; industries?: string[]; tags?: string[]; featured?: boolean }

/** Settings that apply to any template. For a built-in design only the agency's choices (tags, featured) are stored. */
export async function updateTemplateMeta(user: SessionUser, key: string, patch: TemplateMeta): Promise<void> {
  need(user, "website.templates.design");
  if (patch.featured !== undefined) need(user, "website.templates.publish");
  await withSystem(async (db) => {
    const id = await ensureRow(db, key, user);
    const sets: string[] = [];
    const vals: unknown[] = [id, user.id];
    const add = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    const builtin = !isCustomKey(key);
    if (patch.name !== undefined && !builtin) add("name", patch.name.trim().slice(0, 80) || "Untitled");
    if (patch.description !== undefined && !builtin) add("description", patch.description.slice(0, 300));
    if (patch.industries !== undefined) add("industries", patch.industries.filter((i) => INDUSTRY_FILTERS.some((f) => f.id === i)).slice(0, 12));
    if (patch.tags !== undefined) add("tags", patch.tags.map((t) => t.trim().toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 16));
    if (patch.featured !== undefined) add("featured", patch.featured);
    if (!sets.length) return;
    await db.query(`update website_templates set ${sets.join(", ")}, updated_by = $2 where id = $1`, vals);
    await recordAudit({ orgId: null, actorUserId: user.id, actorKind: "user", action: "website.template_updated", targetType: "website_template", targetId: id, result: "success", metadata: { key, fields: Object.keys(patch) } }, db);
  });
}

/** A built-in design gets a row only once the agency makes a choice about it. */
async function ensureRow(db: Queryable, key: string, user: SessionUser): Promise<string> {
  const found = await db.query<{ id: string }>("select id from website_templates where key = $1", [key]);
  if (found.rows[0]) return found.rows[0].id;
  const t = resolveTemplate(key);
  if (!t) throw new AppError("not_found", "Template not found.");
  const ins = await db.query<{ id: string }>(
    "insert into website_templates (key, kind, name, description, family, status, created_by, updated_by) values ($1, 'builtin', $2, $3, $4, 'published', $5, $5) returning id",
    [key, t.variation.name, t.variation.description, t.family.id, user.id]);
  return ins.rows[0].id;
}

/** Publishing, hiding and archiving decide what clients are offered, so they are the agency's super admin's call. */
export async function setTemplateStatus(user: SessionUser, key: string, status: TemplateStatus, note?: string): Promise<{ version: number }> {
  need(user, status === "draft" || status === "in_review" ? "website.templates.design" : "website.templates.publish");
  return withSystem(async (db) => {
    const id = await ensureRow(db, key, user);
    const row = (await db.query<{ kind: string; version: number; draft_content: unknown; content: unknown; status: string }>("select kind, version, draft_content, content, status from website_templates where id = $1 for update", [id])).rows[0];
    let version = row.version;
    if (row.kind === "custom" && status === "published") {
      const parsed = parseContent(row.draft_content);
      if (!parsed.ok) throw new AppError("invalid_input", `This template can't be published yet: ${parsed.error}${parsed.path ? ` (${parsed.path})` : ""}`);
      const check = checkTemplate(parsed.content);
      if (check.blockers.length) throw new AppError("invalid_input", `This template can't be published yet: ${check.blockers[0].message}`);
      version = row.content ? row.version + 1 : 1;
      await db.query("update website_templates set content = draft_content, version = $2, status = 'published', published_at = now(), updated_by = $3 where id = $1", [id, version, user.id]);
      await db.query("insert into website_template_versions (template_id, version, content, note, created_by) values ($1, $2, $3, $4, $5)", [id, version, JSON.stringify(parsed.content), (note ?? "").slice(0, 300) || null, user.id]);
    } else {
      if (row.kind === "custom" && status === "in_review" && !parseContent(row.draft_content).ok) throw new AppError("invalid_input", "Fix the template's design before sending it for review.");
      await db.query("update website_templates set status = $2, updated_by = $3 where id = $1", [id, status, user.id]);
    }
    await recordAudit({ orgId: null, actorUserId: user.id, actorKind: "user", action: "website.template_status", targetType: "website_template", targetId: id, result: "success", metadata: { key, from: row.status, to: status, version } }, db);
    return { version };
  });
}

export async function listTemplateVersions(user: SessionUser, id: string): Promise<Array<{ version: number; note: string | null; createdAt: string; createdByName: string | null }>> {
  need(user, "website.templates.design");
  const { rows } = await withSystem((db) => db.query<{ version: number; note: string | null; created_at: Date; name: string | null }>(
    "select v.version, v.note, v.created_at, u.full_name as name from website_template_versions v left join users u on u.id = v.created_by where v.template_id = $1 order by v.version desc", [id]));
  return rows.map((r) => ({ version: r.version, note: r.note, createdAt: new Date(r.created_at).toISOString(), createdByName: r.name }));
}

/** Puts an earlier published version back into the working copy (it is not published until someone publishes it). */
export async function restoreTemplateVersion(user: SessionUser, id: string, version: number): Promise<void> {
  need(user, "website.templates.design");
  const row = (await withSystem((db) => db.query<{ content: unknown }>("select content from website_template_versions where template_id = $1 and version = $2", [id, version]))).rows[0];
  if (!row) throw new AppError("not_found", "That version wasn't found.");
  await withSystem(async (db) => {
    await db.query("update website_templates set draft_content = $2, draft_revision = draft_revision + 1, updated_by = $3 where id = $1 and kind = 'custom'", [id, JSON.stringify(row.content), user.id]);
    await recordAudit({ orgId: null, actorUserId: user.id, actorKind: "user", action: "website.template_version_restored", targetType: "website_template", targetId: id, result: "success", metadata: { version } }, db);
  });
}

export async function duplicateTemplate(user: SessionUser, key: string): Promise<{ id: string; key: string }> {
  const lib = (await listLibrary(user)).find((t) => t.key === key);
  if (!lib) throw new AppError("not_found", "Template not found.");
  return createTemplate(user, { name: `${lib.name} copy`.slice(0, 80), from: lib.kind === "builtin" ? { kind: "builtin", key } : { kind: "custom", key }, description: lib.description, industries: lib.industries, tags: lib.tags });
}

export async function deleteDraftTemplate(user: SessionUser, id: string): Promise<void> {
  need(user, "website.templates.publish");
  const res = await withSystem((db) => db.query("delete from website_templates where id = $1 and kind = 'custom' and status = 'draft' and content is null", [id]));
  if (!res.rowCount) throw new AppError("conflict", "Only a template that has never been published can be deleted. Archive it instead.");
  await recordAudit({ orgId: null, actorUserId: user.id, actorKind: "user", action: "website.template_deleted", targetType: "website_template", targetId: id, result: "success" });
}

/** A card picture the agency uploads. It is re-encoded, so only a real image is ever stored. */
export async function setTemplatePreviewImage(user: SessionUser, key: string, bytes: Buffer): Promise<void> {
  need(user, "website.templates.design");
  let img: Buffer;
  try {
    img = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1280, height: 800, fit: "cover" }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw new AppError("invalid_input", "That doesn't look like a valid image. Use a PNG, JPG or WebP file.");
  }
  await withSystem(async (db) => {
    const id = await ensureRow(db, key, user);
    await db.query("update website_templates set preview_image = $2, preview_mime = 'image/webp', updated_by = $3 where id = $1", [id, img, user.id]);
  });
}

export async function readTemplatePreviewImage(key: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const r = (await withSystem((db) => db.query<{ preview_image: Buffer | null; preview_mime: string | null; status: string }>("select preview_image, preview_mime, status from website_templates where key = $1", [key]))).rows[0];
  if (!r?.preview_image || !r.preview_mime || r.status !== "published") return null;
  return { bytes: Buffer.from(r.preview_image), mime: r.preview_mime };
}

/** A custom template's content for the preview frame. Clients see only what is published; the agency may see the working copy. */
export async function templateContentForFrame(key: string, opts: { agency: SessionUser | null; draft: boolean }): Promise<SiteContent | null> {
  const r = (await withSystem((db) => db.query<{ content: unknown; draft_content: unknown; status: string }>("select content, draft_content, status from website_templates where key = $1 and kind = 'custom'", [key]))).rows[0];
  if (!r) return null;
  const wantDraft = opts.draft && opts.agency !== null && roleHasPermission(opts.agency.platformRole === "none" ? null : opts.agency.platformRole, "website.templates.design");
  if (!wantDraft && r.status !== "published") return null;
  const parsed = parseContent(wantDraft ? r.draft_content : r.content);
  return parsed.ok ? parsed.content : null;
}

// ---------------------------------------------------------------------------
// Preflight and history for the designer
// ---------------------------------------------------------------------------

export interface TemplateCheck {
  blockers: Array<{ code: string; message: string; where: string }>;
  warnings: Array<{ code: string; message: string; where: string }>;
}

const KNOWN_TOKENS = new Set(Object.keys(tokenValues({ businessName: "x", industry: "other", tagline: "x", description: "x", phone: "x", email: "x", address: "x", hours: "x", services: Array.from({ length: 8 }, () => ({ title: "x", description: "x" })), areas: Array.from({ length: 6 }, () => "x") })));

/** What must be true before a template is offered to clients. */
export function checkTemplate(content: SiteContent): TemplateCheck {
  const blockers: TemplateCheck["blockers"] = [];
  const warnings: TemplateCheck["warnings"] = [];
  if (referencedAssetIds(content).length) blockers.push({ code: "uploaded_image", message: "This template uses an uploaded image. Templates can use built-in artwork only.", where: "Images" });
  if (!content.pages.some((p) => p.slug === "home")) blockers.push({ code: "no_home", message: "A template needs a home page.", where: "Pages" });
  const unknown = new Set<string>();
  let hasForm = false;
  eachElement(content, (e) => {
    if (e.type === "form") hasForm = true;
    for (const f of ELEMENT_DEFS[e.type].fields) {
      const v = e.props[f.key];
      if (typeof v === "string") for (const m of v.matchAll(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi)) if (!KNOWN_TOKENS.has(m[1].toLowerCase())) unknown.add(m[1]);
    }
  });
  for (const t of unknown) blockers.push({ code: "unknown_token", message: `{{${t}}} isn't something a template can fill in. Known: business.name, business.tagline, business.phone, business.email, business.address, business.hours, service.1…8, area.1…6.`, where: "Text" });
  if (!hasForm) warnings.push({ code: "no_form", message: "No page has an enquiry form, so a website made from this template can't take enquiries until its owner adds one.", where: "Forms" });
  if (!content.header) warnings.push({ code: "no_header", message: "There is no header, so visitors have no navigation.", where: "Header" });
  if (!content.footer) warnings.push({ code: "no_footer", message: "There is no footer.", where: "Footer" });
  return { blockers, warnings };
}

export async function templatePreflight(user: SessionUser, id: string): Promise<TemplateCheck> {
  return checkTemplate((await getTemplateDraft(user, id)).content);
}

export async function getTemplateVersionContent(user: SessionUser, id: string, version: number): Promise<SiteContent> {
  need(user, "website.templates.design");
  const r = (await withSystem((db) => db.query<{ content: unknown }>("select content from website_template_versions where template_id = $1 and version = $2", [id, version]))).rows[0];
  const parsed = parseContent(r?.content);
  if (!r || !parsed.ok) throw new AppError("not_found", "That version wasn't found.");
  return parsed.content;
}
