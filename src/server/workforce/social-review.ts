import "server-only";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck, type ReviewMetric } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";

// The Performance Analyst's read-only look at the social media manager. It reads stored posts, the numbers the platforms returned and the leads whose recorded
// visit carried a post's tracking code. It drafts nothing, publishes nothing, contacts nobody and changes nothing. It recommends themes or posting times only
// from returned engagement numbers and says plainly when there are too few to say anything. It never claims likes or views produced a sale.

const MIN_POSTS_FOR_ADVICE = 8;
const MIN_PER_GROUP = 3;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const failedPosts: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number }>(
    "select count(*)::int as count from social_posts where org_id = $1 and status in ('failed', 'needs_reconciliation') and updated_at > now() - interval '14 days'", [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "social_posts_failed", severity: "warning", count,
    title: `${count} social post${count === 1 ? "" : "s"} failed or could not be confirmed in the last 14 days`,
    detail: "These did not publish, or the platform did not confirm whether they went out. A post whose result is unknown is never sent again until a person has checked the Page.",
    evidenceHref: "/social?status=failed", recommendedAction: "Open each one, read the reason, then retry it, fix it, or confirm on the Page whether it was posted.", requiresApproval: false,
  });
};

const approvalBacklog: ReviewCheck = async (db, job) => {
  // Waiting since it was last sent for approval, not since it was last touched.
  const { rows } = await db.query<{ count: number }>(
    `select count(*)::int as count from social_posts p where p.org_id = $1 and p.status = 'pending_approval'
       and (select max(e.at) from social_post_events e where e.post_id = p.id and e.org_id = p.org_id and e.kind = 'submitted') < now() - interval '1 day'`, [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "social_approvals_waiting", severity: "warning", count,
    title: `${count} social post${count === 1 ? " has" : "s have"} been waiting for approval for over a day`,
    detail: "Nothing can be scheduled until a person with approval rights has looked at it.",
    evidenceHref: "/social/approvals", recommendedAction: "Approve, ask for changes, or reject each one.", requiresApproval: false,
  });
};

const accountsNeedAttention: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; names: string[] }>(
    "select count(*)::int as count, coalesce((array_agg(name order by name))[1:3], '{}') as names from social_accounts where org_id = $1 and status in ('needs_reauth', 'error')", [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "social_accounts_attention", severity: "critical", count, samples: rows[0]?.names ?? [],
    title: `${count} connected social account${count === 1 ? " needs" : "s need"} attention`,
    detail: "Posts for these accounts cannot be published until they are reconnected.",
    evidenceHref: "/social/accounts", recommendedAction: "Ask the business owner or a manager to reconnect each account.", requiresApproval: false,
  });
};

const quietAccounts: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ accounts: number; published: number }>(
    `select (select count(*)::int from social_accounts where org_id = $1 and status = 'connected') as accounts,
            (select count(*)::int from social_posts where org_id = $1 and status = 'published' and published_at > now() - interval '14 days') as published`, [job.org_id],
  );
  const { accounts, published } = rows[0] ?? { accounts: 0, published: 0 };
  if (!accounts || published) return null;
  return reviewFinding({
    key: "social_quiet", severity: "info", count: accounts,
    title: "Nothing was published to a connected social account in the last 14 days",
    detail: "The accounts are connected and working, but no post has gone out recently.",
    evidenceHref: "/social", recommendedAction: "Draft a few posts, or ask for AI post ideas from your approved knowledge.", requiresApproval: false,
  });
};

const engagementAdvice: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ kind: string; dow: number; reach: number }>(
    `select p.kind, extract(dow from p.published_at at time zone coalesce(o.timezone, 'UTC'))::int as dow,
            coalesce((m.metrics ->> 'likes')::numeric, 0)::float + coalesce((m.metrics ->> 'comments')::numeric, 0)::float as reach
     from social_posts p join organizations o on o.id = p.org_id
     join lateral (select metrics from social_post_metrics where post_id = p.id and org_id = p.org_id order by fetched_at desc limit 1) m on true
     where p.org_id = $1 and p.status = 'published' and p.published_at > now() - interval '60 days' and m.metrics <> '{}'::jsonb`, [job.org_id],
  );
  if (rows.length < MIN_POSTS_FOR_ADVICE) {
    if (!rows.length) return null;
    return reviewFinding({
      key: "social_not_enough_data", severity: "info", count: rows.length,
      title: `Only ${rows.length} recent post${rows.length === 1 ? " has" : "s have"} engagement numbers, too few to recommend themes or posting times`,
      detail: `Advice needs at least ${MIN_POSTS_FOR_ADVICE} published posts with numbers the platform returned. Likes and comments are the only numbers read.`,
      evidenceHref: "/social/analytics", recommendedAction: "Keep publishing; the review will say more once there is enough to go on.", requiresApproval: false,
    });
  }
  const group = <K extends string | number>(key: (r: (typeof rows)[number]) => K) => {
    const m = new Map<K, number[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r.reach]);
    return [...m.entries()].filter(([, v]) => v.length >= MIN_PER_GROUP).map(([k, v]) => ({ key: k, n: v.length, avg: v.reduce((a, b) => a + b, 0) / v.length }));
  };
  const kinds = group((r) => r.kind).sort((a, b) => b.avg - a.avg);
  const days = group((r) => r.dow).sort((a, b) => b.avg - a.avg);
  const parts: string[] = [];
  if (kinds.length >= 2) parts.push(`${kinds[0].key} posts averaged ${kinds[0].avg.toFixed(1)} likes and comments over ${kinds[0].n} posts, against ${kinds[kinds.length - 1].avg.toFixed(1)} for ${kinds[kinds.length - 1].key} posts over ${kinds[kinds.length - 1].n}`);
  if (days.length >= 2) parts.push(`posts on ${DAY_NAMES[days[0].key]} averaged ${days[0].avg.toFixed(1)} over ${days[0].n} posts, against ${days[days.length - 1].avg.toFixed(1)} on ${DAY_NAMES[days[days.length - 1].key]} over ${days[days.length - 1].n}`);
  if (!parts.length) return null;
  return reviewFinding({
    key: "social_engagement_pattern", severity: "info", count: rows.length,
    title: "Recent engagement differs by post type or weekday",
    detail: `${parts.join("; ")}. These are small samples of likes and comments only, not sales, and a difference this size may be chance.`,
    evidenceHref: "/social/analytics", recommendedAction: "Treat this as a prompt to test, not a rule: try the better-performing type or day a few more times and compare.", requiresApproval: false,
  });
};

const leadsFromPosts: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ leads: number; posts: number }>(
    `select count(distinct t.contact_id)::int as leads, count(distinct p.id)::int as posts
     from social_posts p join lead_touches t on t.org_id = p.org_id and t.content = p.tracking_code
     where p.org_id = $1 and p.tracking_code is not null and p.published_at > now() - interval '60 days'`, [job.org_id],
  );
  const leads = Number(rows[0]?.leads ?? 0);
  if (!leads) return null;
  return reviewFinding({
    key: "social_leads_tracked", severity: "info", count: leads,
    title: `${leads} lead${leads === 1 ? "" : "s"} arrived through the tracked link of ${rows[0].posts} social post${rows[0].posts === 1 ? "" : "s"} in the last 60 days`,
    detail: "A lead is counted only when its own recorded visit carried a post's tracking code. Likes and views are not counted as leads or sales.",
    evidenceHref: "/social/analytics", recommendedAction: "Make sure these leads have an owner and a follow-up in the CRM.", requiresApproval: false,
  });
};

const metrics = async (db: Parameters<ReviewCheck>[0], job: WorkJobRow): Promise<ReviewMetric[]> => {
  const { rows } = await db.query<{ published: number; with_numbers: number }>(
    `select count(*)::int as published, count(*) filter (where exists (select 1 from social_post_metrics m where m.post_id = p.id and m.org_id = p.org_id and m.metrics <> '{}'::jsonb))::int as with_numbers
     from social_posts p where p.org_id = $1 and p.status = 'published' and p.published_at > now() - interval '30 days'`, [job.org_id],
  );
  const r = rows[0] ?? { published: 0, with_numbers: 0 };
  return [
    { key: "social_published", label: "Posts published", value: r.published, period: "Last 30 days", definition: "Posts the platform confirmed published.", source: "Social media manager" },
    { key: "social_with_numbers", label: "Published posts with engagement numbers", value: r.with_numbers, period: "Last 30 days", definition: "Posts for which the platform returned at least one number. A post without numbers is not a post with zero.", source: "Social media manager" },
  ];
};

export async function runSocialPerformanceReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "social_performance_review",
    allowedRoles: ["performance_analyst"],
    scanningMessage: "Reading stored social posts, the numbers the platforms returned and the leads their tracked links brought…",
    analyzingMessage: "Working out what needs a person and what the evidence supports…",
    checks: [accountsNeedAttention, failedPosts, approvalBacklog, quietAccounts, engagementAdvice, leadsFromPosts],
    metrics,
    limitations: "Only stored records in this workspace were read. Nothing was drafted, published or changed. Engagement is limited to the likes, comments and shares a platform returned; reach and impressions are not collected.",
    subject: "Social media",
  });
}
