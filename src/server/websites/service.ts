import "server-only";
import crypto from "node:crypto";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import { readAuthorizedPrivateFile } from "@/server/storage/private";
import { generateSiteContent } from "@/lib/website/generate";
import { checkReadiness, warningNeedsAcknowledgement, type Issue } from "@/lib/website/lint";
import { parseContent, referencedAssetIds, type SiteContent } from "@/lib/website/schema";
import { resolveTemplate } from "@/lib/website/templates";
import { buildSiteDetails } from "@/server/websites/details";
import { contentHash, sha256Hex } from "@/server/websites/hash";
import { probeSite, type ProbeFetcher } from "@/server/websites/probe";
import type { OrgContext } from "@/server/tenancy/context";

const SAVE_LIMIT: RateLimitRule = { name: "website:save", limit: 240, windowSeconds: 60 };
const MAX_PUBLICATION_ASSET_BYTES = 40 * 1024 * 1024;

export const platformHost = (subdomain: string) => `${subdomain}.${env().SITES_BASE_DOMAIN}`;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface DomainView {
  id: string;
  hostname: string;
  kind: "platform" | "custom";
  status: "pending_dns" | "verified" | "active" | "error" | "removed";
  verificationToken: string;
  verifiedAt: string | null;
  dnsCheckedAt: string | null;
  dnsDetail: string | null;
  routingOk: boolean | null;
  sslStatus: "unknown" | "pending" | "ready" | "error";
  sslDetail: string | null;
  liveOk: boolean | null;
  liveCheckedAt: string | null;
  isPrimary: boolean;
  acquisition: "platform" | "existing" | "purchase_requested" | "purchase_approved" | "purchased";
  registrar: string | null;
  renewsAt: string | null;
  purchaseCostMicros: number | null;
}

export interface WebsiteSummary {
  id: string;
  name: string;
  kind: "website" | "landing_page";
  templateKey: string;
  subdomain: string;
  platformHost: string;
  draftRevision: number;
  draftUpdatedAt: string;
  approval: { status: "draft" | "submitted" | "approved" | "changes_requested"; note: string | null; decidedAt: string | null };
  published: { publicationId: string; number: number; publishedAt: string; health: "unchecked" | "healthy" | "unhealthy"; healthDetail: string | null; healthCheckedAt: string | null } | null;
  hasUnpublishedChanges: boolean;
  domains: DomainView[];
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function mapDomain(r: Record<string, unknown>): DomainView {
  return {
    id: r.id as string, hostname: r.hostname as string, kind: r.kind as DomainView["kind"], status: r.status as DomainView["status"],
    verificationToken: r.verification_token as string, verifiedAt: iso(r.verified_at as Date | null), dnsCheckedAt: iso(r.dns_checked_at as Date | null),
    dnsDetail: (r.dns_detail as string | null) ?? null, routingOk: (r.routing_ok as boolean | null) ?? null, sslStatus: r.ssl_status as DomainView["sslStatus"],
    sslDetail: (r.ssl_detail as string | null) ?? null, liveOk: (r.live_ok as boolean | null) ?? null, liveCheckedAt: iso(r.live_checked_at as Date | null),
    isPrimary: r.is_primary as boolean, acquisition: r.acquisition as DomainView["acquisition"], registrar: (r.registrar as string | null) ?? null,
    renewsAt: iso(r.renews_at as Date | null), purchaseCostMicros: r.purchase_cost_micros === null || r.purchase_cost_micros === undefined ? null : Number(r.purchase_cost_micros),
  };
}
export const DOMAIN_COLUMNS =
  "id, hostname, kind, status, verification_token, verified_at, dns_checked_at, dns_detail, routing_ok, ssl_status, ssl_detail, live_ok, live_checked_at, is_primary, acquisition, registrar, renews_at, purchase_cost_micros";

export async function getWebsite(ctx: OrgContext): Promise<WebsiteSummary | null> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      id: string; name: string; kind: "website" | "landing_page"; template_key: string; subdomain: string; draft_revision: number; draft_updated_at: Date; draft_content: unknown;
      approval_status: WebsiteSummary["approval"]["status"]; approval_note: string | null; approval_decided_at: Date | null; published_publication_id: string | null;
      pub_number: number | null; published_at: Date | null; health: "unchecked" | "healthy" | "unhealthy" | null; health_detail: string | null; health_checked_at: Date | null; pub_hash: string | null; pub_template: string | null;
    }>(
      `select w.id, w.name, w.kind, w.template_key, w.subdomain, w.draft_revision, w.draft_updated_at, w.draft_content, w.approval_status, w.approval_note, w.approval_decided_at,
              w.published_publication_id, p.number as pub_number, p.published_at, p.health, p.health_detail, p.health_checked_at, p.content_hash as pub_hash, p.template_key as pub_template
       from websites w left join website_publications p on p.id = w.published_publication_id
       where w.org_id = $1 and w.kind = 'website'`,
      [ctx.org.orgId],
    );
    const w = rows[0];
    if (!w) return null;
    const domains = await db.query<Record<string, unknown>>(`select ${DOMAIN_COLUMNS} from website_domains where website_id = $1 and removed_at is null order by is_primary desc, created_at`, [w.id]);
    let changed = false;
    if (w.published_publication_id) {
      const parsed = parseContent(w.draft_content);
      changed = !parsed.ok || contentHash(parsed.content) !== w.pub_hash || w.template_key !== w.pub_template;
    }
    return {
      id: w.id, name: w.name, kind: w.kind, templateKey: w.template_key, subdomain: w.subdomain, platformHost: platformHost(w.subdomain), draftRevision: w.draft_revision,
      draftUpdatedAt: new Date(w.draft_updated_at).toISOString(), approval: { status: w.approval_status, note: w.approval_note, decidedAt: iso(w.approval_decided_at) },
      published: w.published_publication_id && w.pub_number ? { publicationId: w.published_publication_id, number: w.pub_number, publishedAt: new Date(w.published_at!).toISOString(), health: w.health ?? "unchecked", healthDetail: w.health_detail, healthCheckedAt: iso(w.health_checked_at) } : null,
      hasUnpublishedChanges: changed, domains: domains.rows.map(mapDomain),
    } satisfies WebsiteSummary;
  });
}

export async function getDraft(ctx: OrgContext): Promise<{ websiteId: string; content: SiteContent; revision: number; templateKey: string } | null> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  const row = await withUser(ctx.user.id, async (db) =>
    (await db.query<{ id: string; draft_content: unknown; draft_revision: number; template_key: string }>("select id, draft_content, draft_revision, template_key from websites where org_id = $1 and kind = 'website'", [ctx.org.orgId])).rows[0],
  );
  if (!row) return null;
  const parsed = parseContent(row.draft_content);
  if (!parsed.ok) throw new AppError("internal", "The saved draft could not be read. Restore an earlier version.");
  return { websiteId: row.id, content: parsed.content, revision: row.draft_revision, templateKey: row.template_key };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const labelFrom = (name: string) => {
  let label = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/g, "");
  if (label.length < 3) label = `site-${label || crypto.randomBytes(2).toString("hex")}`;
  return label;
};
const RESERVED = new Set(["www", "app", "api", "admin", "mail", "email", "sites", "site", "static", "assets", "cdn", "status", "docs", "help", "support", "billing", "dashboard", "login", "portal", "iacquire", "ghl", "n8n", "hermes", "supabase", "ns1", "ns2", "smtp", "ftp", "test", "staging", "preview", "dev"]);
export const isValidSubdomain = (s: string) => /^[a-z0-9](?:[a-z0-9-]{1,40}[a-z0-9])$/.test(s) && !RESERVED.has(s);

async function uniqueSubdomain(db: Queryable, name: string): Promise<string> {
  let base = labelFrom(name);
  if (RESERVED.has(base)) base = `${base}-co`;
  for (let i = 0; i < 40; i += 1) {
    const candidate = i === 0 ? base : `${base.slice(0, 38)}-${i + 1}`;
    const { rows } = await db.query("select 1 from websites where subdomain = $1", [candidate]);
    if (!rows.length && isValidSubdomain(candidate)) return candidate;
  }
  return `${base.slice(0, 32)}-${crypto.randomBytes(3).toString("hex")}`;
}

async function assertAssetsOwned(db: Queryable, orgId: string, ids: string[]) {
  if (!ids.length) return;
  const { rows } = await db.query<{ id: string }>("select id from org_assets where org_id = $1 and id = any($2::uuid[]) and deleted_at is null", [orgId, ids]);
  const have = new Set(rows.map((r) => r.id.toLowerCase()));
  const missing = ids.filter((i) => !have.has(i.toLowerCase()));
  if (missing.length) throw new AppError("invalid_input", "One of the images on this site is no longer in your library. Choose another image.");
}

async function nextVersion(db: Queryable, websiteId: string) {
  const { rows } = await db.query<{ n: number }>("select coalesce(max(version), 0) + 1 as n from website_versions where website_id = $1", [websiteId]);
  return Number(rows[0].n);
}

async function snapshot(db: Queryable, input: { orgId: string; websiteId: string; templateKey: string; content: SiteContent; source: "editor" | "generated" | "submit" | "publish" | "rollback"; note?: string; userId: string | null }) {
  const hash = contentHash(input.content);
  const { rows: last } = await db.query<{ id: string; content_hash: string; template_key: string }>("select id, content_hash, template_key from website_versions where website_id = $1 order by version desc limit 1", [input.websiteId]);
  if (last[0] && last[0].content_hash === hash && last[0].template_key === input.templateKey && input.source !== "generated") return { id: last[0].id, created: false };
  const { rows } = await db.query<{ id: string }>(
    `insert into website_versions (org_id, website_id, version, template_key, content, content_hash, source, note, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [input.orgId, input.websiteId, await nextVersion(db, input.websiteId), input.templateKey, JSON.stringify(input.content), hash, input.source, input.note?.slice(0, 300) ?? null, input.userId],
  );
  return { id: rows[0].id, created: true };
}

function requireEdit(ctx: OrgContext) {
  if (!ctx.can("website.edit")) throw new AppError("forbidden", "Only owners and managers can change the website.");
}

// ---------------------------------------------------------------------------
// Create, edit, template
// ---------------------------------------------------------------------------

export async function createWebsite(ctx: OrgContext, input: { templateKey: string }): Promise<{ websiteId: string; subdomain: string }> {
  requireEdit(ctx);
  if (ctx.org.kind !== "client") throw new AppError("invalid_input", "Websites are built inside a client workspace.");
  if (!resolveTemplate(input.templateKey)) throw new AppError("invalid_input", "Choose one of the templates.");
  const details = await buildSiteDetails(ctx);
  const content = generateSiteContent(details, input.templateKey);
  const result = await withSystem(async (db) => {
    const existing = await db.query("select 1 from websites where org_id = $1 and kind = 'website'", [ctx.org.orgId]);
    if (existing.rows.length) throw new AppError("conflict", "Your workspace already has a website.");
    await assertAssetsOwned(db, ctx.org.orgId, referencedAssetIds(content));
    const subdomain = await uniqueSubdomain(db, details.businessName);
    const { rows } = await db.query<{ id: string }>(
      `insert into websites (org_id, name, kind, template_key, subdomain, draft_content, draft_updated_by, created_by) values ($1, $2, 'website', $3, $4, $5, $6, $6) returning id`,
      [ctx.org.orgId, details.businessName.slice(0, 120), input.templateKey, subdomain, JSON.stringify(content), ctx.user.id],
    );
    const websiteId = rows[0].id;
    await snapshot(db, { orgId: ctx.org.orgId, websiteId, templateKey: input.templateKey, content, source: "generated", note: "First draft from your business details", userId: ctx.user.id });
    // The included address is ours, so its ownership is not in question. Whether it is actually being served is checked separately.
    await db.query(
      `insert into website_domains (org_id, website_id, hostname, kind, status, verification_token, verified_at, is_primary, acquisition, created_by)
       values ($1, $2, $3, 'platform', 'verified', $4, now(), true, 'platform', $5)`,
      [ctx.org.orgId, websiteId, platformHost(subdomain), crypto.randomBytes(16).toString("hex"), ctx.user.id],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.created", targetType: "website", targetId: websiteId, result: "success", metadata: { template: input.templateKey } }, db);
    return { websiteId, subdomain };
  });
  return result;
}

export class DraftConflictError extends AppError {
  constructor() {
    super("conflict", "This website was changed in another window or by a teammate. Reload to see the latest before editing.");
  }
}

export async function saveDraft(ctx: OrgContext, input: { content: unknown; expectedRevision: number }): Promise<{ revision: number; approvalReset: boolean; content: SiteContent }> {
  requireEdit(ctx);
  const limit = await consumeRateLimit(SAVE_LIMIT, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "Saving too quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
  const parsed = parseContent(input.content);
  if (!parsed.ok) throw new AppError("invalid_input", `${parsed.error}${parsed.path ? ` (${parsed.path})` : ""}`);
  return withSystem(async (db) => {
    await assertAssetsOwned(db, ctx.org.orgId, referencedAssetIds(parsed.content));
    const { rows } = await db.query<{ draft_revision: number; approval_status: string; prev: string }>(
      `update websites w set draft_content = $3, draft_revision = w.draft_revision + 1, draft_updated_by = $4, draft_updated_at = now(),
         approval_status = case when w.approval_status in ('submitted', 'approved') then 'draft' else w.approval_status end
       from (select approval_status as prev from websites where org_id = $1 and kind = 'website') old
       where w.org_id = $1 and w.kind = 'website' and w.draft_revision = $2
       returning w.draft_revision, w.approval_status, old.prev`,
      [ctx.org.orgId, input.expectedRevision, JSON.stringify(parsed.content), ctx.user.id],
    );
    if (!rows[0]) throw new DraftConflictError();
    return { revision: rows[0].draft_revision, approvalReset: ["submitted", "approved"].includes(rows[0].prev), content: parsed.content };
  });
}

export async function changeTemplate(ctx: OrgContext, input: { templateKey: string; expectedRevision: number }): Promise<{ revision: number }> {
  requireEdit(ctx);
  if (!resolveTemplate(input.templateKey)) throw new AppError("invalid_input", "Choose one of the templates.");
  return withSystem(async (db) => {
    // Content never depends on the template, so switching keeps every word and image.
    const { rows } = await db.query<{ draft_revision: number }>(
      `update websites set template_key = $3, draft_revision = draft_revision + 1, draft_updated_by = $4, draft_updated_at = now(),
         approval_status = case when approval_status in ('submitted', 'approved') then 'draft' else approval_status end
       where org_id = $1 and kind = 'website' and draft_revision = $2 returning draft_revision`,
      [ctx.org.orgId, input.expectedRevision, input.templateKey, ctx.user.id],
    );
    if (!rows[0]) throw new DraftConflictError();
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.template_changed", targetType: "website", result: "success", metadata: { template: input.templateKey } }, db);
    return { revision: rows[0].draft_revision };
  });
}

/** Replaces the draft with a fresh one built from the business details. The current draft is saved as a version first, so nothing is lost. */
export async function regenerateDraft(ctx: OrgContext, input: { expectedRevision: number }): Promise<{ revision: number }> {
  requireEdit(ctx);
  const details = await buildSiteDetails(ctx);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; draft_content: unknown; template_key: string; draft_revision: number }>(
      "select id, draft_content, template_key, draft_revision from websites where org_id = $1 and kind = 'website' for update", [ctx.org.orgId]);
    const w = rows[0];
    if (!w) throw new AppError("not_found", "Create your website first.");
    if (w.draft_revision !== input.expectedRevision) throw new DraftConflictError();
    const current = parseContent(w.draft_content);
    if (current.ok) await snapshot(db, { orgId: ctx.org.orgId, websiteId: w.id, templateKey: w.template_key, content: current.content, source: "editor", note: "Saved before rebuilding from your business details", userId: ctx.user.id });
    const fresh = generateSiteContent(details, w.template_key);
    await assertAssetsOwned(db, ctx.org.orgId, referencedAssetIds(fresh));
    const updated = await db.query<{ draft_revision: number }>(
      `update websites set draft_content = $2, draft_revision = draft_revision + 1, draft_updated_by = $3, draft_updated_at = now(),
         approval_status = case when approval_status in ('submitted', 'approved') then 'draft' else approval_status end where id = $1 returning draft_revision`,
      [w.id, JSON.stringify(fresh), ctx.user.id],
    );
    await snapshot(db, { orgId: ctx.org.orgId, websiteId: w.id, templateKey: w.template_key, content: fresh, source: "generated", note: "Rebuilt from your business details", userId: ctx.user.id });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.regenerated", targetType: "website", targetId: w.id, result: "success" }, db);
    return { revision: updated.rows[0].draft_revision };
  });
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface VersionView { id: string; version: number; templateKey: string; source: string; note: string | null; createdAt: string; createdByName: string | null; isLive: boolean }

export async function saveVersion(ctx: OrgContext, input: { note?: string }): Promise<{ version: number; created: boolean }> {
  requireEdit(ctx);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; draft_content: unknown; template_key: string }>("select id, draft_content, template_key from websites where org_id = $1 and kind = 'website'", [ctx.org.orgId]);
    const w = rows[0];
    if (!w) throw new AppError("not_found", "Create your website first.");
    const parsed = parseContent(w.draft_content);
    if (!parsed.ok) throw new AppError("invalid_input", parsed.error);
    const snap = await snapshot(db, { orgId: ctx.org.orgId, websiteId: w.id, templateKey: w.template_key, content: parsed.content, source: "editor", note: input.note, userId: ctx.user.id });
    const v = await db.query<{ version: number }>("select version from website_versions where id = $1", [snap.id]);
    return { version: v.rows[0].version, created: snap.created };
  });
}

export async function listVersions(ctx: OrgContext): Promise<VersionView[]> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; version: number; template_key: string; source: string; note: string | null; created_at: Date; name: string | null; live: boolean }>(
      `select v.id, v.version, v.template_key, v.source, v.note, v.created_at, u.full_name as name, exists (select 1 from website_publications p where p.version_id = v.id and p.status = 'live') as live
       from website_versions v join websites w on w.id = v.website_id left join users u on u.id = v.created_by where w.org_id = $1 and w.kind = 'website' order by v.version desc limit 60`,
      [ctx.org.orgId],
    );
    return rows.map((r) => ({ id: r.id, version: r.version, templateKey: r.template_key, source: r.source, note: r.note, createdAt: new Date(r.created_at).toISOString(), createdByName: r.name, isLive: r.live }));
  });
}

export async function getVersionContent(ctx: OrgContext, versionId: string): Promise<{ content: SiteContent; templateKey: string; version: number } | null> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  const row = await withUser(ctx.user.id, async (db) => (await db.query<{ content: unknown; template_key: string; version: number }>("select content, template_key, version from website_versions where id = $1 and org_id = $2", [versionId, ctx.org.orgId])).rows[0]);
  if (!row) return null;
  const parsed = parseContent(row.content);
  return parsed.ok ? { content: parsed.content, templateKey: row.template_key, version: row.version } : null;
}

export async function restoreVersion(ctx: OrgContext, input: { versionId: string; expectedRevision: number }): Promise<{ revision: number }> {
  requireEdit(ctx);
  const v = await getVersionContent(ctx, input.versionId);
  if (!v) throw new AppError("not_found", "That version wasn't found.");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; draft_content: unknown; template_key: string; draft_revision: number }>("select id, draft_content, template_key, draft_revision from websites where org_id = $1 and kind = 'website' for update", [ctx.org.orgId]);
    const w = rows[0];
    if (!w) throw new AppError("not_found", "Create your website first.");
    if (w.draft_revision !== input.expectedRevision) throw new DraftConflictError();
    // Keep what was being edited before replacing it.
    const current = parseContent(w.draft_content);
    if (current.ok) await snapshot(db, { orgId: ctx.org.orgId, websiteId: w.id, templateKey: w.template_key, content: current.content, source: "editor", note: `Saved before restoring version ${v.version}`, userId: ctx.user.id });
    await assertAssetsOwned(db, ctx.org.orgId, referencedAssetIds(v.content));
    const updated = await db.query<{ draft_revision: number }>(
      `update websites set draft_content = $2, template_key = $3, draft_revision = draft_revision + 1, draft_updated_by = $4, draft_updated_at = now(),
         approval_status = case when approval_status in ('submitted', 'approved') then 'draft' else approval_status end where id = $1 returning draft_revision`,
      [w.id, JSON.stringify(v.content), v.templateKey, ctx.user.id],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.version_restored", targetType: "website", targetId: w.id, result: "success", metadata: { version: v.version } }, db);
    return { revision: updated.rows[0].draft_revision };
  });
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export interface Preflight {
  blockers: Issue[];
  warnings: Issue[];
  /** Unverifiable claims the owner must read and confirm before publishing. */
  needsAcknowledgement: Issue[];
  canPublishNow: boolean;
}

export async function preflight(ctx: OrgContext): Promise<Preflight> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  const draft = await getDraft(ctx);
  if (!draft) throw new AppError("not_found", "Create your website first.");
  const r = checkReadiness(draft.content);
  const needsAck = r.warnings.filter(warningNeedsAcknowledgement);
  return { blockers: r.blockers, warnings: r.warnings.filter((w) => !warningNeedsAcknowledgement(w)), needsAcknowledgement: needsAck, canPublishNow: r.blockers.length === 0 };
}

export async function submitForApproval(ctx: OrgContext): Promise<{ versionId: string }> {
  requireEdit(ctx);
  const draft = await getDraft(ctx);
  if (!draft) throw new AppError("not_found", "Create your website first.");
  const ready = checkReadiness(draft.content);
  if (ready.blockers.length) throw new PublishBlockedError("Fix the highlighted issues before sending your website for approval.", ready.blockers, []);
  return withSystem(async (db) => {
    const snap = await snapshot(db, { orgId: ctx.org.orgId, websiteId: draft.websiteId, templateKey: draft.templateKey, content: draft.content, source: "submit", note: "Sent for approval", userId: ctx.user.id });
    const upd = await db.query("update websites set approval_status = 'submitted', approval_version_id = $2, approval_note = null, approval_decided_by = null, approval_decided_at = null where id = $1 and draft_revision = $3", [draft.websiteId, snap.id, draft.revision]);
    if (!upd.rowCount) throw new DraftConflictError();
    await notifyOrgRoles(db, ctx.org.orgId, ["owner"], { kind: "approval_requested", severity: "info", title: "Your website is ready for your approval", body: "Review the preview, then approve it or ask for changes.", link: "/website", dedupeKey: `website-approval:${snap.id}` });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.submitted", targetType: "website", targetId: draft.websiteId, result: "success" }, db);
    return { versionId: snap.id };
  });
}

export async function decideApproval(ctx: OrgContext, input: { approve: boolean; note?: string }): Promise<void> {
  if (!ctx.can("website.approve")) throw new AppError("forbidden", "Only the business owner can approve the website.");
  if (!input.approve && (input.note ?? "").trim().length < 3) throw new AppError("invalid_input", "Tell us what you'd like changed.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; approval_status: string; approval_version_id: string | null; draft_content: unknown; template_key: string }>(
      "select id, approval_status, approval_version_id, draft_content, template_key from websites where org_id = $1 and kind = 'website' for update", [ctx.org.orgId]);
    const w = rows[0];
    if (!w || w.approval_status !== "submitted" || !w.approval_version_id) throw new AppError("conflict", "There is nothing waiting for approval.");
    if (input.approve) {
      // Approval covers exactly what was submitted: if the draft has moved on since, it must be sent again.
      const ver = await db.query<{ content_hash: string; template_key: string }>("select content_hash, template_key from website_versions where id = $1", [w.approval_version_id]);
      const cur = parseContent(w.draft_content);
      if (!cur.ok || contentHash(cur.content) !== ver.rows[0]?.content_hash || w.template_key !== ver.rows[0]?.template_key) throw new AppError("conflict", "The website changed after it was sent for approval. It needs to be sent again.");
    }
    await db.query("update websites set approval_status = $2, approval_note = $3, approval_decided_by = $4, approval_decided_at = now() where id = $1", [w.id, input.approve ? "approved" : "changes_requested", (input.note ?? "").trim().slice(0, 600) || null, ctx.user.id]);
    await notifyOrgRoles(db, ctx.org.orgId, ["admin"], { kind: "approval_decided", severity: input.approve ? "success" : "warning", title: input.approve ? "Your website was approved" : "Changes requested on your website", body: input.approve ? "It's ready to publish." : (input.note ?? "").slice(0, 300), link: "/website" });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: input.approve ? "website.approved" : "website.changes_requested", targetType: "website", targetId: w.id, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export class PublishBlockedError extends AppError {
  constructor(message: string, readonly blockers: Issue[], readonly needsAcknowledgement: Issue[]) {
    super("invalid_input", message);
  }
}

interface AssetCopy { assetId: string; sha256: string; mime: string; bytes: Buffer; alt: string; width: number | null; height: number | null }

async function collectAssetCopies(orgId: string, content: SiteContent): Promise<AssetCopy[]> {
  const ids = referencedAssetIds(content);
  if (!ids.length) return [];
  const rows = await withSystem(async (db) =>
    (await db.query<{ id: string; alt_text: string; width: number | null; height: number | null; private_file_id: string; processed_file_id: string | null; mime: string }>(
      `select a.id, a.alt_text, a.width, a.height, a.private_file_id, a.processed_file_id, f.mime_type as mime
       from org_assets a join private_files f on f.id = a.private_file_id and f.org_id = a.org_id where a.org_id = $1 and a.id = any($2::uuid[]) and a.deleted_at is null`,
      [orgId, ids],
    )).rows,
  );
  if (rows.length !== ids.length) throw new AppError("invalid_input", "An image on this site is no longer in your library. Choose another image.");
  const copies: AssetCopy[] = [];
  let total = 0;
  for (const r of rows) {
    const useProcessed = content.brand.logoAssetId?.toLowerCase() === r.id.toLowerCase() && content.brand.logoVariant === "processed" && r.processed_file_id;
    const file = await readAuthorizedPrivateFile(useProcessed ? r.processed_file_id! : r.private_file_id);
    total += file.bytes.length;
    if (file.bytes.length > 6 * 1024 * 1024) throw new AppError("invalid_input", "An image is too large to publish. Upload a smaller version.");
    copies.push({ assetId: r.id, sha256: sha256Hex(file.bytes), mime: file.mime_type, bytes: file.bytes, alt: r.alt_text, width: r.width, height: r.height });
  }
  if (total > MAX_PUBLICATION_ASSET_BYTES) throw new AppError("usage_limit", "The images on this site are too large to publish together. Remove or shrink some.");
  return copies;
}

export interface PublishOutcome {
  publicationId: string;
  number: number;
  host: string;
  health: "healthy" | "unhealthy" | "unchecked";
  healthDetail: string;
  /** True when the new publication failed its live check and the previous one was put back. */
  restoredPrevious: boolean;
}

export async function publishWebsite(ctx: OrgContext, input: { acknowledgeClaims?: boolean; note?: string }, deps: { probe?: ProbeFetcher } = {}): Promise<PublishOutcome> {
  if (!ctx.can("website.publish")) throw new AppError("forbidden", "Only the business owner can publish the website.");
  const draft = await getDraft(ctx);
  if (!draft) throw new AppError("not_found", "Create your website first.");
  const ready = checkReadiness(draft.content);
  const claims = ready.warnings.filter(warningNeedsAcknowledgement);
  if (ready.blockers.length) throw new PublishBlockedError("Fix the highlighted issues before publishing.", ready.blockers, claims);
  if (claims.length && !input.acknowledgeClaims) throw new PublishBlockedError("Read the claims on your site and confirm you can back each one up.", [], claims);
  const copies = await collectAssetCopies(ctx.org.orgId, draft.content);

  const staged = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; draft_revision: number; approval_status: string; published_publication_id: string | null; subdomain: string }>(
      "select id, draft_revision, approval_status, published_publication_id, subdomain from websites where id = $1 and org_id = $2 for update", [draft.websiteId, ctx.org.orgId]);
    const w = rows[0];
    if (!w) throw new AppError("not_found", "Create your website first.");
    if (w.draft_revision !== draft.revision) throw new DraftConflictError();
    // The owner is the approver, so they may publish directly. Anyone else (a super admin acting for a managed client) needs the owner's approval of this exact draft.
    if (!ctx.can("website.approve") && w.approval_status !== "approved") throw new AppError("forbidden", "The business owner needs to approve this website before it can be published.");

    const snap = await snapshot(db, { orgId: ctx.org.orgId, websiteId: w.id, templateKey: draft.templateKey, content: draft.content, source: "publish", note: input.note, userId: ctx.user.id });
    const blobIds = new Map<string, string>();
    for (const c of copies) {
      const b = await db.query<{ id: string }>(
        `insert into website_asset_blobs (org_id, sha256, mime_type, bytes, width, height) values ($1, $2, $3, $4, $5, $6)
         on conflict (org_id, sha256) do update set sha256 = excluded.sha256 returning id`,
        [ctx.org.orgId, c.sha256, c.mime, c.bytes, c.width, c.height],
      );
      blobIds.set(c.assetId, b.rows[0].id);
    }
    const { rows: numRows } = await db.query<{ n: number }>("select coalesce(max(number), 0) + 1 as n from website_publications where website_id = $1", [w.id]);
    await db.query("update website_publications set status = 'superseded' where website_id = $1 and status = 'live'", [w.id]);
    const pub = await db.query<{ id: string }>(
      `insert into website_publications (org_id, website_id, number, version_id, template_key, content, content_hash, status, note, published_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'live', $8, $9) returning id`,
      [ctx.org.orgId, w.id, numRows[0].n, snap.id, draft.templateKey, JSON.stringify(draft.content), contentHash(draft.content), input.note?.slice(0, 300) ?? null, ctx.user.id],
    );
    for (const c of copies) {
      await db.query("insert into website_publication_assets (publication_id, asset_id, blob_id, alt, width, height) values ($1, $2, $3, $4, $5, $6)", [pub.rows[0].id, c.assetId, blobIds.get(c.assetId), c.alt, c.width, c.height]);
    }
    await db.query("update websites set published_publication_id = $2 where id = $1", [w.id, pub.rows[0].id]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.published", targetType: "website_publication", targetId: pub.rows[0].id, result: "success", metadata: { number: numRows[0].n, assets: copies.length } }, db);
    return { websiteId: w.id, publicationId: pub.rows[0].id, number: Number(numRows[0].n), previousId: w.published_publication_id, host: platformHost(w.subdomain) };
  });

  const host = await primaryHost(ctx.org.orgId, staged.websiteId, staged.host);
  const probe = await probeSite(host, staged.publicationId, deps.probe);
  let restored = false;
  await withSystem(async (db) => {
    await db.query("update website_publications set health = $2, health_detail = $3, health_checked_at = now() where id = $1", [staged.publicationId, probe.state, probe.detail]);
    if (probe.state === "unhealthy" && staged.previousId) {
      // A site that was fine must not be replaced by one that cannot be served: put the last healthy one back.
      const prev = await db.query<{ health: string }>("select health from website_publications where id = $1", [staged.previousId]);
      if (prev.rows[0] && prev.rows[0].health !== "unhealthy") {
        await db.query("update website_publications set status = 'failed' where id = $1", [staged.publicationId]);
        await db.query("update website_publications set status = 'live' where id = $1", [staged.previousId]);
        await db.query("update websites set published_publication_id = $2 where id = $1", [staged.websiteId, staged.previousId]);
        restored = true;
      }
    }
    if (probe.state === "unhealthy") {
      await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], { kind: "website_publish_failed", severity: "critical", title: restored ? "Your website update didn't go live; the previous version is still up" : "Your website was published but isn't being served", body: probe.detail, link: "/website", dedupeKey: `website-publish-failed:${staged.publicationId}` });
    } else {
      await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], { kind: "website_published", severity: "success", title: probe.state === "healthy" ? "Your website is live" : "Your website was published", body: probe.state === "healthy" ? host : "We'll confirm it's being served once the website runtime is reachable.", link: "/website", dedupeKey: `website-published:${staged.publicationId}` });
    }
  });
  return { publicationId: restored ? staged.previousId! : staged.publicationId, number: staged.number, host, health: probe.state, healthDetail: probe.detail, restoredPrevious: restored };
}

export async function primaryHost(orgId: string, websiteId: string, fallback: string): Promise<string> {
  const { rows } = await withSystem((db) =>
    db.query<{ hostname: string }>("select hostname from website_domains where org_id = $1 and website_id = $2 and removed_at is null and is_primary and status in ('verified', 'active') limit 1", [orgId, websiteId]),
  );
  return rows[0]?.hostname ?? fallback;
}

export async function unpublishWebsite(ctx: OrgContext): Promise<void> {
  if (!ctx.can("website.publish")) throw new AppError("forbidden", "Only the business owner can take the website offline.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; published_publication_id: string | null }>("select id, published_publication_id from websites where org_id = $1 and kind = 'website' for update", [ctx.org.orgId]);
    const w = rows[0];
    if (!w?.published_publication_id) throw new AppError("conflict", "The website isn't published.");
    await db.query("update website_publications set status = 'superseded', note = 'Taken offline' where id = $1", [w.published_publication_id]);
    await db.query("update websites set published_publication_id = null where id = $1", [w.id]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.unpublished", targetType: "website", targetId: w.id, result: "success" }, db);
  });
}

export interface PublicationView { id: string; number: number; templateKey: string; status: "live" | "superseded" | "failed"; health: "unchecked" | "healthy" | "unhealthy"; healthDetail: string | null; note: string | null; rolledBackTo: number | null; publishedAt: string; publishedByName: string | null }

export async function listPublications(ctx: OrgContext): Promise<PublicationView[]> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; number: number; template_key: string; status: PublicationView["status"]; health: PublicationView["health"]; health_detail: string | null; note: string | null; rolled_back_to: number | null; published_at: Date; name: string | null }>(
      `select p.id, p.number, p.template_key, p.status, p.health, p.health_detail, p.note, p.rolled_back_to, p.published_at, u.full_name as name
       from website_publications p join websites w on w.id = p.website_id left join users u on u.id = p.published_by where w.org_id = $1 and w.kind = 'website' order by p.number desc limit 40`,
      [ctx.org.orgId],
    );
    return rows.map((r) => ({ id: r.id, number: r.number, templateKey: r.template_key, status: r.status, health: r.health, healthDetail: r.health_detail, note: r.note, rolledBackTo: r.rolled_back_to, publishedAt: new Date(r.published_at).toISOString(), publishedByName: r.name }));
  });
}

/** Republishes an earlier publication's exact content and images as a new publication, so the history stays a clear timeline. */
export async function rollbackWebsite(ctx: OrgContext, input: { publicationNumber: number }, deps: { probe?: ProbeFetcher } = {}): Promise<PublishOutcome> {
  if (!ctx.can("website.publish")) throw new AppError("forbidden", "Only the business owner can restore an earlier version of the website.");
  const staged = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; published_publication_id: string | null; subdomain: string }>("select id, published_publication_id, subdomain from websites where org_id = $1 and kind = 'website' for update", [ctx.org.orgId]);
    const w = rows[0];
    if (!w) throw new AppError("not_found", "Create your website first.");
    const target = await db.query<{ id: string; number: number; template_key: string; content: unknown; content_hash: string; health: string; status: string }>(
      "select id, number, template_key, content, content_hash, health, status from website_publications where website_id = $1 and number = $2", [w.id, input.publicationNumber]);
    const t = target.rows[0];
    if (!t) throw new AppError("not_found", "That publication wasn't found.");
    if (t.id === w.published_publication_id) throw new AppError("conflict", "That version is already live.");
    if (t.status === "failed" || t.health === "unhealthy") throw new AppError("invalid_input", "That version could not be served last time, so it can't be restored.");
    const parsed = parseContent(t.content);
    if (!parsed.ok) throw new AppError("invalid_input", "That version can no longer be read.");
    const snap = await snapshot(db, { orgId: ctx.org.orgId, websiteId: w.id, templateKey: t.template_key, content: parsed.content, source: "rollback", note: `Restored publication ${t.number}`, userId: ctx.user.id });
    const { rows: numRows } = await db.query<{ n: number }>("select coalesce(max(number), 0) + 1 as n from website_publications where website_id = $1", [w.id]);
    await db.query("update website_publications set status = 'superseded' where website_id = $1 and status = 'live'", [w.id]);
    const pub = await db.query<{ id: string }>(
      `insert into website_publications (org_id, website_id, number, version_id, template_key, content, content_hash, status, note, rolled_back_to, published_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'live', $8, $9, $10) returning id`,
      [ctx.org.orgId, w.id, numRows[0].n, snap.id, t.template_key, JSON.stringify(parsed.content), t.content_hash, `Restored publication ${t.number}`, t.number, ctx.user.id],
    );
    await db.query("insert into website_publication_assets (publication_id, asset_id, blob_id, alt, width, height) select $1, asset_id, blob_id, alt, width, height from website_publication_assets where publication_id = $2", [pub.rows[0].id, t.id]);
    await db.query("update websites set published_publication_id = $2 where id = $1", [w.id, pub.rows[0].id]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.rolled_back", targetType: "website_publication", targetId: pub.rows[0].id, result: "success", metadata: { restored: t.number } }, db);
    return { websiteId: w.id, publicationId: pub.rows[0].id, number: Number(numRows[0].n), host: platformHost(w.subdomain) };
  });
  const host = await primaryHost(ctx.org.orgId, staged.websiteId, staged.host);
  const probe = await probeSite(host, staged.publicationId, deps.probe);
  await withSystem((db) => db.query("update website_publications set health = $2, health_detail = $3, health_checked_at = now() where id = $1", [staged.publicationId, probe.state, probe.detail]));
  return { publicationId: staged.publicationId, number: staged.number, host, health: probe.state, healthDetail: probe.detail, restoredPrevious: false };
}

