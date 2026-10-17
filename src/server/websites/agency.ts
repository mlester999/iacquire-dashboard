import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { agencyCanAccessOrg, agencyUserHasPermission } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import { DOMAIN_COLUMNS, mapDomain, platformHost, type DomainView } from "@/server/websites/service";

export interface AgencyWebsiteView {
  exists: boolean;
  orgName: string;
  templateKey: string | null;
  platformHost: string | null;
  approvalStatus: "draft" | "submitted" | "approved" | "changes_requested" | null;
  draftUpdatedAt: string | null;
  published: { number: number; publishedAt: string; health: "unchecked" | "healthy" | "unhealthy"; healthDetail: string | null; healthCheckedAt: string | null } | null;
  domains: DomainView[];
  enquiries: { total: number; last30Days: number; failed: number };
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** What the agency needs to see about a client's website: whether it is live and healthy, the domains, and any domain waiting on a quote or a purchase. */
export async function getAgencyWebsiteView(user: SessionUser, orgId: string): Promise<AgencyWebsiteView> {
  if (!(await agencyCanAccessOrg(user, orgId))) throw new AppError("not_found", "Client not found.");
  if (!(await agencyUserHasPermission(user.id, "website.view"))) throw new AppError("forbidden", "Your role does not allow viewing Website Studio.");
  return withSystem(async (db) => {
    const org = (await db.query<{ name: string }>("select name from organizations where id = $1", [orgId])).rows[0];
    if (!org) throw new AppError("not_found", "Client not found.");
    const w = (
      await db.query<{
        id: string; template_key: string; subdomain: string; approval_status: AgencyWebsiteView["approvalStatus"]; draft_updated_at: Date;
        pub_number: number | null; published_at: Date | null; health: "unchecked" | "healthy" | "unhealthy" | null; health_detail: string | null; health_checked_at: Date | null;
      }>(
        `select w.id, w.template_key, w.subdomain, w.approval_status, w.draft_updated_at, p.number as pub_number, p.published_at, p.health, p.health_detail, p.health_checked_at
         from websites w left join website_publications p on p.id = w.published_publication_id where w.org_id = $1 and w.kind = 'website'`,
        [orgId],
      )
    ).rows[0];
    if (!w) return { exists: false, orgName: org.name, templateKey: null, platformHost: null, approvalStatus: null, draftUpdatedAt: null, published: null, domains: [], enquiries: { total: 0, last30Days: 0, failed: 0 } };
    const domains = (await db.query<Record<string, unknown>>(`select ${DOMAIN_COLUMNS} from website_domains where website_id = $1 and removed_at is null order by is_primary desc, created_at`, [w.id])).rows.map(mapDomain);
    const counts = (
      await db.query<{ total: number; recent: number; failed: number }>(
        `select count(*)::int as total, count(*) filter (where created_at > now() - interval '30 days')::int as recent, count(*) filter (where status = 'failed')::int as failed
         from website_form_submissions where org_id = $1`,
        [orgId],
      )
    ).rows[0];
    return {
      exists: true, orgName: org.name, templateKey: w.template_key, platformHost: platformHost(w.subdomain), approvalStatus: w.approval_status, draftUpdatedAt: iso(w.draft_updated_at),
      published: w.pub_number ? { number: w.pub_number, publishedAt: iso(w.published_at)!, health: w.health ?? "unchecked", healthDetail: w.health_detail, healthCheckedAt: iso(w.health_checked_at) } : null,
      domains, enquiries: { total: counts.total, last30Days: counts.recent, failed: counts.failed },
    };
  });
}
