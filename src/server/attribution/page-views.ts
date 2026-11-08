import "server-only";
import type { Queryable } from "@/server/db";

export interface WebsitePageViewRow {
  page: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  referringHost: string | null;
  pageLoads: number;
}

export interface WebsitePageViewReport {
  total: number;
  rows: WebsitePageViewRow[];
}

const count = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

/** Daily UTC aggregates only. Callers must check `website.view` before reading this report. */
export async function websitePageViewReport(
  db: Queryable,
  orgId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<WebsitePageViewReport> {
  const startDay = startsAt.toISOString().slice(0, 10);
  const endDay = endsAt.toISOString().slice(0, 10);
  const [total, details] = await Promise.all([
    db.query<{ page_views: string }>(
      "select coalesce(sum(page_views), 0)::text as page_views from website_usage_daily where org_id = $1 and day >= $2::date and day <= $3::date",
      [orgId, startDay, endDay],
    ),
    db.query<{
      page_slug: string;
      utm_source: string;
      utm_medium: string;
      utm_campaign: string;
      referrer_host: string;
      page_views: string;
    }>(
      `select page_slug, utm_source, utm_medium, utm_campaign, referrer_host, sum(page_views)::text as page_views
         from website_page_views_daily
        where org_id = $1 and day >= $2::date and day <= $3::date
        group by page_slug, utm_source, utm_medium, utm_campaign, referrer_host
        order by sum(page_views) desc, page_slug, utm_source, utm_medium, utm_campaign, referrer_host
        limit 50`,
      [orgId, startDay, endDay],
    ),
  ]);
  return {
    total: count(total.rows[0]?.page_views),
    rows: details.rows.map((row) => ({
      page: row.page_slug === "__other__" ? "Additional page loads" : row.page_slug,
      source: row.utm_source || null,
      medium: row.utm_medium || null,
      campaign: row.utm_campaign || null,
      referringHost: row.referrer_host || null,
      pageLoads: count(row.page_views),
    })),
  };
}
