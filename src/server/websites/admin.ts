import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import { resolveTemplate } from "@/lib/website/templates";
import { platformHost, type DomainView } from "@/server/websites/service";
import { LIFECYCLE_LABEL, type Lifecycle } from "@/lib/website/lifecycle";

/**
 * Every Website Studio read follows the database's current client scope: Super Admins see every client, Managers follow their configured scope,
 * and Staff see assigned clients. Nothing is invented: every figure is a count of real rows, and "no data" is reported as no data.
 */
async function scope(user: SessionUser, requiredPermission?: "website.review"): Promise<{ userId: string }> {
  if (user.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
  const { rows } = await withSystem((db) => db.query<{ can_view: boolean; can_review: boolean }>(
    `select coalesce(app.user_has_agency_permission($1,'website.view'),false) as can_view,
            coalesce(app.user_has_agency_permission($1,'website.review'),false) as can_review`,
    [user.id],
  ));
  if (rows[0]?.can_view !== true) throw new AppError("forbidden", "Your role does not allow viewing Website Studio.");
  if (requiredPermission === "website.review" && rows[0]?.can_review !== true) {
    throw new AppError("forbidden", "Your role does not allow reviewing client websites.");
  }
  return { userId: user.id };
}

export { LIFECYCLE_LABEL, type Lifecycle };

export interface ManagedWebsite {
  websiteId: string;
  orgId: string;
  orgName: string;
  name: string;
  templateKey: string;
  templateName: string;
  lifecycle: Lifecycle;
  approval: "draft" | "submitted" | "approved" | "changes_requested";
  approvalNote: string | null;
  draftUpdatedAt: string;
  published: { number: number; publishedAt: string; health: "unchecked" | "healthy" | "unhealthy"; healthDetail: string | null } | null;
  domain: { hostname: string; kind: "platform" | "custom"; status: string; sslStatus: string; liveOk: boolean | null; detail: string | null } | null;
  /** Things that need a person's attention, in plain words. */
  warnings: string[];
  openComments: number;
  enquiries30d: number;
  archived: boolean;
  lockedBy: string | null;
}

interface Row {
  id: string; org_id: string; org_name: string; name: string; template_key: string; approval_status: ManagedWebsite["approval"]; approval_note: string | null; draft_updated_at: Date; archived_at: Date | null;
  pub_number: number | null; published_at: Date | null; health: "unchecked" | "healthy" | "unhealthy" | null; health_detail: string | null; last_pub_status: string | null; open_comments: string; enquiries: string;
  d_host: string | null; d_kind: "platform" | "custom" | null; d_status: string | null; d_ssl: string | null; d_live: boolean | null; d_detail: string | null; custom_trouble: string | null;
  lock_name: string | null; lock_expires: Date | null; org_status: string;
}

const MANAGED_SQL = `
  select w.id, w.org_id, o.name as org_name, w.name, w.template_key, w.approval_status, w.approval_note, w.draft_updated_at, w.archived_at,
         p.number as pub_number, p.published_at, p.health, p.health_detail,
         (select lp.status from website_publications lp where lp.website_id = w.id order by lp.number desc limit 1) as last_pub_status,
         (select count(*) from website_comments c where c.website_id = w.id and c.resolved_at is null) as open_comments,
         (select count(*) from website_form_submissions s where s.website_id = w.id and s.created_at > now() - interval '30 days') as enquiries,
         d.hostname as d_host, d.kind as d_kind, d.status as d_status, d.ssl_status as d_ssl, d.live_ok as d_live, d.dns_detail as d_detail,
         (select string_agg(x.hostname || ': ' || case when x.status in ('pending_dns', 'error') then 'DNS not verified' when x.ssl_status = 'error' then 'certificate problem' when x.live_ok = false then 'not answering' else 'check needed' end, '; ')
            from website_domains x where x.website_id = w.id and x.removed_at is null and x.kind = 'custom'
              and (x.status in ('pending_dns', 'error') or x.ssl_status = 'error' or x.live_ok = false)) as custom_trouble,
         case when w.edit_lock_expires > now() then w.edit_lock_name end as lock_name, w.edit_lock_expires as lock_expires, o.status as org_status
  from websites w
  join organizations o on o.id = w.org_id
  left join website_publications p on p.id = w.published_publication_id
  left join lateral (
    select hostname, kind, status, ssl_status, live_ok, dns_detail from website_domains x
    where x.website_id = w.id and x.removed_at is null order by x.is_primary desc, x.created_at limit 1
  ) d on true
  where o.kind = 'client' and o.status <> 'archived'
    and app.user_can_access_org($1,w.org_id)`;

function lifecycleOf(r: Row): Lifecycle {
  if (r.archived_at) return "archived";
  if (!r.pub_number && r.last_pub_status === "failed") return "publication_failed";
  if (r.pub_number) return "published";
  if (r.approval_status === "submitted") return "ready_for_review";
  if (r.approval_status === "changes_requested") return "changes_requested";
  if (r.approval_status === "approved") return "approved";
  return "draft";
}

function map(r: Row): ManagedWebsite {
  const warnings: string[] = [];
  if (r.archived_at) warnings.push("This website is archived.");
  if (r.org_status === "suspended") warnings.push("The client's workspace is suspended, so the site is not being served.");
  if (r.last_pub_status === "failed") warnings.push("The latest publication could not be served.");
  if (r.pub_number && r.health === "unhealthy") warnings.push(r.health_detail || "The live site is not answering its health check.");
  if (r.custom_trouble) warnings.push(`Domain: ${r.custom_trouble}.`);
  if (r.approval_status === "submitted") warnings.push("Waiting for the owner's approval.");
  if (Number(r.open_comments) > 0) warnings.push(`${r.open_comments} open comment${Number(r.open_comments) === 1 ? "" : "s"}.`);
  const t = resolveTemplate(r.template_key);
  return {
    websiteId: r.id, orgId: r.org_id, orgName: r.org_name, name: r.name, templateKey: r.template_key, templateName: t ? `${t.family.name} · ${t.variation.name}` : r.template_key.startsWith("custom.") ? `Agency design · ${r.template_key.slice(7)}` : r.template_key,
    lifecycle: lifecycleOf(r), approval: r.approval_status, approvalNote: r.approval_note, draftUpdatedAt: new Date(r.draft_updated_at).toISOString(),
    published: r.pub_number ? { number: r.pub_number, publishedAt: new Date(r.published_at!).toISOString(), health: r.health ?? "unchecked", healthDetail: r.health_detail } : null,
    domain: r.d_host ? { hostname: r.d_host, kind: r.d_kind!, status: r.d_status!, sslStatus: r.d_ssl ?? "unknown", liveOk: r.d_live, detail: r.d_detail } : null,
    warnings, openComments: Number(r.open_comments), enquiries30d: Number(r.enquiries), archived: Boolean(r.archived_at), lockedBy: r.lock_name,
  };
}

export async function listManagedWebsites(user: SessionUser): Promise<ManagedWebsite[]> {
  const s = await scope(user);
  const { rows } = await withSystem((db) => db.query<Row>(`${MANAGED_SQL} order by w.draft_updated_at desc`, [s.userId]));
  return rows.map(map);
}

export async function getManagedWebsite(user: SessionUser, orgId: string): Promise<ManagedWebsite | null> {
  const s = await scope(user);
  const { rows } = await withSystem((db) => db.query<Row>(`${MANAGED_SQL} and w.org_id = $2 and w.kind = 'website'`, [s.userId, orgId]));
  return rows[0] ? map(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface ActivityItem { at: string; action: string; label: string; actor: string | null; orgName: string | null; orgId: string | null }

export interface StudioOverview {
  total: number;
  published: number;
  drafts: number;
  pendingApprovals: number;
  changesRequested: number;
  approvedWaiting: number;
  domainsNeedingAttention: number;
  failedPublications: number;
  unhealthy: number;
  archived: number;
  usage30d: { requests: number; bytes: number; enquiries: number } | null;
  activity: ActivityItem[];
  clientsWithoutSite: number;
}

const ACTION_LABEL: Record<string, string> = {
  "website.created": "Website created", "website.published": "Website published", "website.rolled_back": "Publication rolled back", "website.unpublished": "Website taken offline", "website.submitted": "Sent for approval",
  "website.approved": "Approved by the owner", "website.changes_requested": "Changes requested", "website.version_restored": "Version restored", "website.regenerated": "Draft rebuilt", "website.template_created": "Template created",
  "website.template_status": "Template status changed", "website.template_updated": "Template updated", "website.agency_edit": "Edited by the agency", "website.comment_added": "Comment added", "website.archived": "Website archived", "website.unarchived": "Website restored",
  "website.domain_added": "Domain added", "website.domain_verified": "Domain verified", "website.template_version_restored": "Template version restored",
};

export async function studioOverview(user: SessionUser): Promise<StudioOverview> {
  const s = await scope(user);
  const sites = await listManagedWebsites(user);
  const orgIds = sites.map((x) => x.orgId);
  const usage = await withSystem(async (db) => {
    if (!orgIds.length) return null;
    const r = (await db.query<{ requests: string | null; bytes: string | null; forms: string | null }>(
      "select sum(requests) as requests, sum(bytes_served) as bytes, sum(form_submissions) as forms from website_usage_daily where org_id = any($1::uuid[]) and day > current_date - 30", [orgIds])).rows[0];
    return { requests: Number(r.requests ?? 0), bytes: Number(r.bytes ?? 0), enquiries: Number(r.forms ?? 0) };
  });
  const activity = await withSystem(async (db) => {
    const { rows } = await db.query<{ created_at: Date; action: string; actor: string | null; org_name: string | null; org_id: string | null }>(
      `select a.created_at, a.action, u.full_name as actor, o.name as org_name, a.org_id
       from audit_logs a left join users u on u.id = a.actor_user_id left join organizations o on o.id = a.org_id
       where a.action like 'website.%'
         and (coalesce(app.user_has_agency_permission($1,'agency.security.manage'),false)
           or (a.org_id is not null and app.user_can_access_org($1,a.org_id)))
       order by a.created_at desc limit 12`, [s.userId]);
    return rows.map((r) => ({ at: new Date(r.created_at).toISOString(), action: r.action, label: ACTION_LABEL[r.action] ?? r.action.replace("website.", "").replace(/_/g, " "), actor: r.actor, orgName: r.org_name, orgId: r.org_id }));
  });
  const withoutSite = await withSystem(async (db) =>
    Number((await db.query<{ n: string }>(
      `select count(*) as n from organizations o where o.kind = 'client' and o.status in ('active', 'onboarding') and not exists (select 1 from websites w where w.org_id = o.id and w.kind = 'website')
         and app.user_can_access_org($1,o.id)`, [s.userId])).rows[0].n));
  const live = sites.filter((x) => !x.archived);
  return {
    total: live.length,
    published: live.filter((x) => x.published).length,
    drafts: live.filter((x) => !x.published).length,
    pendingApprovals: live.filter((x) => x.approval === "submitted").length,
    changesRequested: live.filter((x) => x.approval === "changes_requested").length,
    approvedWaiting: live.filter((x) => x.approval === "approved" && !x.published).length,
    domainsNeedingAttention: live.filter((x) => x.warnings.some((w) => w.startsWith("Domain:"))).length,
    failedPublications: live.filter((x) => x.lifecycle === "publication_failed" || x.warnings.some((w) => w.includes("could not be served"))).length,
    unhealthy: live.filter((x) => x.published?.health === "unhealthy").length,
    archived: sites.filter((x) => x.archived).length,
    usage30d: usage, activity, clientsWithoutSite: withoutSite,
  };
}

// ---------------------------------------------------------------------------
// Reviews and domains
// ---------------------------------------------------------------------------

export async function reviewQueue(user: SessionUser): Promise<{ waiting: ManagedWebsite[]; changes: ManagedWebsite[]; approved: ManagedWebsite[]; failed: ManagedWebsite[]; comments: ManagedWebsite[] }> {
  await scope(user, "website.review");
  const all = (await listManagedWebsites(user)).filter((x) => !x.archived);
  return {
    waiting: all.filter((x) => x.approval === "submitted"),
    changes: all.filter((x) => x.approval === "changes_requested"),
    approved: all.filter((x) => x.approval === "approved" && !x.published),
    failed: all.filter((x) => x.lifecycle === "publication_failed" || x.published?.health === "unhealthy"),
    comments: all.filter((x) => x.openComments > 0),
  };
}

export interface DomainRow {
  id: string; websiteId: string; orgId: string; orgName: string; hostname: string; kind: "platform" | "custom"; status: DomainView["status"]; sslStatus: DomainView["sslStatus"]; liveOk: boolean | null; routingOk: boolean | null;
  isPrimary: boolean; dnsDetail: string | null; sslDetail: string | null; checkedAt: string | null; renewsAt: string | null; acquisition: DomainView["acquisition"]; needsAttention: boolean; why: string | null;
}

export async function domainsOverview(user: SessionUser): Promise<{ domains: DomainRow[]; baseDomain: string; usage: Array<{ orgName: string; orgId: string; requests: number; bytes: number; enquiries: number }> }> {
  const s = await scope(user);
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; website_id: string; org_id: string; org_name: string; hostname: string; kind: "platform" | "custom"; status: DomainView["status"]; ssl_status: DomainView["sslStatus"]; live_ok: boolean | null; routing_ok: boolean | null; is_primary: boolean;
      dns_detail: string | null; ssl_detail: string | null; dns_checked_at: Date | null; renews_at: Date | null; acquisition: DomainView["acquisition"] }>(
      `select d.id, d.website_id, d.org_id, o.name as org_name, d.hostname, d.kind, d.status, d.ssl_status, d.live_ok, d.routing_ok, d.is_primary, d.dns_detail, d.ssl_detail, d.dns_checked_at, d.renews_at, d.acquisition
       from website_domains d join organizations o on o.id = d.org_id
       where d.removed_at is null and o.status <> 'archived' and app.user_can_access_org($1,d.org_id)
       order by (d.status in ('pending_dns', 'error') or d.ssl_status = 'error' or d.live_ok = false) desc, o.name, d.hostname`, [s.userId]));
  const domains = rows.map((r): DomainRow => {
    let why: string | null = null;
    if (r.status === "pending_dns") why = "DNS ownership not verified yet.";
    else if (r.status === "error") why = r.dns_detail || "DNS check failed.";
    else if (r.ssl_status === "error") why = r.ssl_detail || "The certificate has a problem.";
    else if (r.live_ok === false) why = "The domain is not serving the site.";
    else if (r.kind === "custom" && r.renews_at && new Date(r.renews_at).getTime() < Date.now() + 30 * 86_400_000) why = "Renewal is due within 30 days.";
    return { id: r.id, websiteId: r.website_id, orgId: r.org_id, orgName: r.org_name, hostname: r.hostname, kind: r.kind, status: r.status, sslStatus: r.ssl_status, liveOk: r.live_ok, routingOk: r.routing_ok, isPrimary: r.is_primary, dnsDetail: r.dns_detail, sslDetail: r.ssl_detail,
      checkedAt: r.dns_checked_at ? new Date(r.dns_checked_at).toISOString() : null, renewsAt: r.renews_at ? new Date(r.renews_at).toISOString() : null, acquisition: r.acquisition, needsAttention: why !== null, why };
  });
  const usage = await withSystem(async (db) =>
    (await db.query<{ org_id: string; name: string; requests: string; bytes: string; forms: string }>(
      `select u.org_id, o.name, sum(u.requests) as requests, sum(u.bytes_served) as bytes, sum(u.form_submissions) as forms
       from website_usage_daily u join organizations o on o.id = u.org_id
       where u.day > current_date - 30 and app.user_can_access_org($1,u.org_id) group by u.org_id, o.name order by 3 desc limit 25`, [s.userId])).rows
      .map((r) => ({ orgId: r.org_id, orgName: r.name, requests: Number(r.requests), bytes: Number(r.bytes), enquiries: Number(r.forms) })));
  return { domains, baseDomain: platformHost("example").replace(/^example\./, ""), usage };
}

/** Clients the user may manage, for pickers (media library, "create a website for…"). */
export async function managedClients(user: SessionUser): Promise<Array<{ id: string; name: string; hasWebsite: boolean }>> {
  const s = await scope(user);
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; name: string; has: boolean }>(
      `select o.id, o.name, exists (select 1 from websites w where w.org_id = o.id and w.kind = 'website') as has from organizations o
       where o.kind = 'client' and o.status in ('active', 'onboarding') and app.user_can_access_org($1,o.id) order by o.name`, [s.userId]));
  return rows.map((r) => ({ id: r.id, name: r.name, hasWebsite: r.has }));
}
