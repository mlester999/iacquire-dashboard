import "server-only";
import type { Queryable } from "@/server/db";
import { campaignRollup, leadFigures, type CampaignPerformance } from "@/server/social/analytics";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck, type ReviewMetric } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";

// The Performance Analyst's read-only look at the social media manager. It reads stored posts, the numbers the platforms returned and the leads whose recorded
// visit carried a post's tracking code. It drafts nothing, publishes nothing, contacts nobody and changes nothing. It recommends themes or posting times only
// from returned engagement numbers, compares like with like (posts on the same account), reports a difference only when it is large enough to mean something,
// and says plainly when there are too few to say anything. It never claims likes or views produced a sale, and never claims why a number moved.

const MIN_POSTS_FOR_ADVICE = 8;
const MIN_PER_GROUP = 3;
/** A difference is reported only when the stronger group averages at least this much above the weaker one, and by at least a whole like or comment per post. */
const MIN_GAP_RATIO = 0.25;
const MIN_GAP_ABSOLUTE = 1;
/** Posts needed in EACH of two periods before one is compared with the other. */
const MIN_PER_PERIOD = 5;
const LOOKBACK_DAYS = 60;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_PARTS = { morning: "in the morning (5am to noon)", afternoon: "in the afternoon (noon to 5pm)", evening: "in the evening (5pm to 10pm)", night: "late at night or very early (10pm to 5am)" } as const;
type DayPart = keyof typeof DAY_PARTS;
const dayPart = (hour: number): DayPart => (hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lookback = () => {
  const endsAt = new Date(Date.now() + 60_000);
  return { startsAt: new Date(endsAt.getTime() - LOOKBACK_DAYS * 86_400_000), endsAt };
};

export const failedPosts: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number }>(
    "select count(*)::int as count from social_posts where org_id = $1 and status in ('failed', 'needs_reconciliation') and updated_at > now() - interval '14 days'", [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "social_posts_failed", severity: "warning", count,
    title: `${count} social post${count === 1 ? "" : "s"} failed or could not be confirmed in the last 14 days`,
    detail: "These did not publish, or the platform did not confirm whether they went out. A post whose result is unknown is never sent again until a person has checked the Page.",
    evidenceHref: "/social?view=list&status=failed,needs_reconciliation", recommendedAction: "Open each one, read the reason, then retry it, fix it, or confirm on the Page whether it was posted.", requiresApproval: false,
  });
};

export const approvalBacklog: ReviewCheck = async (db, job) => {
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

export const accountsNeedAttention: ReviewCheck = async (db, job) => {
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

export const quietAccounts: ReviewCheck = async (db, job) => {
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

interface EngagementRow {
  account_id: string;
  account_name: string;
  kind: string;
  dow: number;
  hour: number;
  /** Likes plus comments, and only when the platform returned BOTH. Null otherwise: an absent number is not a zero. */
  reach: number | null;
  /** Published in the last 30 days (otherwise in the 30 days before that). */
  recent: boolean;
}

/** Published posts of the last 60 days that have numbers, each with the latest likes and comments the platform returned (not an empty marker row). */
async function engagementRows(db: Queryable, orgId: string): Promise<EngagementRow[]> {
  const { rows } = await db.query<EngagementRow>(
    `select p.account_id, a.name as account_name, p.kind,
            extract(dow from p.published_at at time zone coalesce(o.timezone, 'UTC'))::int as dow,
            extract(hour from p.published_at at time zone coalesce(o.timezone, 'UTC'))::int as hour,
            case when m.metrics ?& array['likes', 'comments'] then ((m.metrics ->> 'likes')::numeric + (m.metrics ->> 'comments')::numeric)::float end as reach,
            p.published_at > now() - interval '30 days' as recent
     from social_posts p join social_accounts a on a.id = p.account_id and a.org_id = p.org_id join organizations o on o.id = p.org_id
     join lateral (select metrics from social_post_metrics where post_id = p.id and org_id = p.org_id and metrics <> '{}'::jsonb order by fetched_at desc limit 1) m on true
     where p.org_id = $1 and p.status = 'published' and p.published_at > now() - interval '60 days'`, [orgId],
  );
  return rows;
}

const byAccount = (rows: EngagementRow[]) => {
  const m = new Map<string, EngagementRow[]>();
  for (const r of rows) m.set(r.account_id, [...(m.get(r.account_id) ?? []), r]);
  return [...m.values()];
};
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

interface Group<K> {
  key: K;
  n: number;
  avg: number;
}

function groups<K extends string | number>(rows: EngagementRow[], key: (r: EngagementRow) => K): Group<K>[] {
  const m = new Map<K, number[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r.reach as number]);
  return [...m.entries()].filter(([, v]) => v.length >= MIN_PER_GROUP).map(([k, v]) => ({ key: k, n: v.length, avg: mean(v) })).sort((a, b) => b.avg - a.avg);
}

/** The strongest and weakest group, only when they are far enough apart to mean something. */
function clearGap<K extends string | number>(g: Group<K>[]): { best: Group<K>; worst: Group<K> } | null {
  if (g.length < 2) return null;
  const best = g[0];
  const worst = g[g.length - 1];
  return best.avg - worst.avg >= MIN_GAP_ABSOLUTE && best.avg >= worst.avg * (1 + MIN_GAP_RATIO) ? { best, worst } : null;
}

const leftOutNote = (n: number) => (n ? ` ${plural(n, "other post")} ${n === 1 ? "was" : "were"} left out because the platform did not return both likes and comments for ${n === 1 ? "it" : "them"}.` : "");

export const engagementAdvice: ReviewCheck = async (db, job) => {
  const all = await engagementRows(db, job.org_id);
  if (!all.length) return null;
  const usable = all.filter((r) => r.reach !== null);
  const leftOut = all.length - usable.length;
  const accounts = byAccount(usable);
  // Posts are compared within one account: a Page with a large audience and one with a small audience cannot be compared by raw counts.
  const enough = accounts.filter((a) => a.length >= MIN_POSTS_FOR_ADVICE).sort((a, b) => b.length - a.length).slice(0, 2);
  if (!enough.length) {
    const most = Math.max(0, ...accounts.map((a) => a.length));
    return reviewFinding({
      key: "social_not_enough_data", severity: "info", count: most || leftOut,
      title: most
        ? `Only ${plural(most, "recent post")} on one account ${most === 1 ? "has" : "have"} likes and comments, too few to compare post types, weekdays or times of day`
        : `${plural(leftOut, "recent post")} ${leftOut === 1 ? "has" : "have"} engagement numbers, but not both likes and comments, so they cannot be compared`,
      detail: `Advice needs at least ${MIN_POSTS_FOR_ADVICE} published posts on the same account with both likes and comments returned by the platform. Posts are compared within one account because audiences differ in size.${leftOutNote(leftOut)}`,
      evidenceHref: "/social/analytics", recommendedAction: "Keep publishing; the review will say more once there is enough to go on.", requiresApproval: false,
    });
  }
  const parts: string[] = [];
  const dims = new Set<string>();
  const avg = (g: { avg: number }) => g.avg.toFixed(1);
  for (const rows of enough) {
    const on = `On ${rows[0].account_name}, `;
    const kind = clearGap(groups(rows, (r) => r.kind));
    if (kind) {
      dims.add("post type");
      parts.push(`${on}${kind.best.key} posts averaged ${avg(kind.best)} likes and comments over ${kind.best.n} posts, against ${avg(kind.worst)} for ${kind.worst.key} posts over ${kind.worst.n}`);
    }
    const day = clearGap(groups(rows, (r) => r.dow));
    if (day) {
      dims.add("weekday");
      parts.push(`${on}posts on ${DAY_NAMES[day.best.key]} averaged ${avg(day.best)} over ${day.best.n} posts, against ${avg(day.worst)} on ${DAY_NAMES[day.worst.key]} over ${day.worst.n}`);
    }
    const time = clearGap(groups(rows, (r) => dayPart(r.hour)));
    if (time) {
      dims.add("time of day");
      parts.push(`${on}posts ${DAY_PARTS[time.best.key]} averaged ${avg(time.best)} over ${time.best.n} posts, against ${avg(time.worst)} for posts ${DAY_PARTS[time.worst.key]} over ${time.worst.n}`);
    }
  }
  const compared = enough.reduce((t, a) => t + a.length, 0);
  if (!parts.length) {
    return reviewFinding({
      key: "social_engagement_similar", severity: "info", count: compared,
      title: "Recent engagement looks similar across post types, weekdays and times of day",
      detail: `No post type, weekday or time of day stood out on an account with enough posts. A gap of at least ${Math.round(MIN_GAP_RATIO * 100)}% and one like or comment per post is needed before this review says one is stronger.${leftOutNote(leftOut)}`,
      evidenceHref: "/social/analytics", recommendedAction: "Keep publishing and check again when there are more posts.", requiresApproval: false,
    });
  }
  return reviewFinding({
    key: "social_engagement_pattern", severity: "info", count: compared,
    title: `Recent engagement differs by ${[...dims].join(", ").replace(/, ([^,]*)$/, " and $1")}`,
    detail: `${parts.join("; ")}. These are small samples of likes and comments only, not sales. They do not show that the type, day or time caused the difference, and a gap this size may be chance.${leftOutNote(leftOut)}`,
    evidenceHref: "/social/analytics", recommendedAction: "Treat this as something to test, not a rule: try the stronger option a few more times on that account and compare.", requiresApproval: false,
  });
};

export const engagementChange: ReviewCheck = async (db, job) => {
  const usable = (await engagementRows(db, job.org_id)).filter((r) => r.reach !== null);
  const parts: string[] = [];
  let compared = 0;
  for (const rows of byAccount(usable)) {
    const now = rows.filter((r) => r.recent).map((r) => r.reach as number);
    const before = rows.filter((r) => !r.recent).map((r) => r.reach as number);
    if (now.length < MIN_PER_PERIOD || before.length < MIN_PER_PERIOD) continue;
    const a = mean(now);
    const b = mean(before);
    if (Math.abs(a - b) < Math.max(MIN_GAP_ABSOLUTE, b * MIN_GAP_RATIO)) continue;
    compared += now.length + before.length;
    parts.push(`On ${rows[0].account_name}, the ${now.length} posts of the last 30 days averaged ${a.toFixed(1)} likes and comments, ${a > b ? "up" : "down"} from ${b.toFixed(1)} over the ${before.length} posts of the 30 days before`);
  }
  if (!parts.length) return null;
  return reviewFinding({
    key: "social_engagement_change", severity: "info", count: compared,
    title: "Likes and comments per post changed compared with the previous 30 days",
    detail: `${parts.join("; ")}. This compares two small groups of posts by likes and comments only. It does not show why the numbers moved, and a change this size may be chance.`,
    evidenceHref: "/social/analytics", recommendedAction: "Look at what was different about those posts, such as the topic, the picture and the time, before changing the plan.", requiresApproval: false,
  });
};

const campaignLine = (c: CampaignPerformance) => {
  const posts = plural(c.posts, "post");
  if (!c.tracked) return `${c.name}: ${posts}, none with a tracking link, so its leads cannot be measured`;
  const later = [c.appointments ? `${plural(c.appointments, "appointment")} booked later` : "", c.wonCount ? `${plural(c.wonCount, "deal")} later marked won` : ""].filter(Boolean);
  return `${c.name}: ${posts}${c.trackedPosts < c.posts ? ` (${c.trackedPosts} with a tracking link)` : ""}, ${[plural(c.leads, "tracked lead"), ...later].join(", ")}`;
};

export const campaignPerformance: ReviewCheck = async (db, job) => {
  const campaigns = (await campaignRollup(db, job.org_id, lookback())).filter((c) => c.campaignId !== null);
  if (!campaigns.length) return null;
  const ranked = [...campaigns].sort((a, b) => b.leads - a.leads || b.posts - a.posts);
  const leads = campaigns.reduce((t, c) => t + c.leads, 0);
  const unmeasured = campaigns.filter((c) => !c.tracked).length;
  return reviewFinding({
    key: "social_campaign_performance", severity: "info", count: campaigns.length, samples: ranked.slice(0, 3).map(campaignLine),
    title: `${plural(campaigns.length, "campaign")} published posts in the last ${LOOKBACK_DAYS} days; ${plural(leads, "tracked lead")} came through their links`,
    detail: `A lead is counted only when its own recorded visit carried a post's tracking code, and appointments and deals only when they were created after that visit. This shows what followed the posts, not that the posts caused it.${unmeasured ? ` ${plural(unmeasured, "campaign")} had no post with a tracking link, so ${unmeasured === 1 ? "its" : "their"} leads cannot be measured.` : ""}`,
    evidenceHref: "/social/analytics?range=90",
    recommendedAction: unmeasured ? "Add the page to share to the posts of the campaigns that have no link, so their leads can be measured." : "Compare which campaigns brought leads, and plan the next ones with that in mind.",
    requiresApproval: false,
  });
};

export const leadsFromPosts: ReviewCheck = async (db, job) => {
  const window = lookback();
  const all = (await leadFigures(db, job.org_id, window, "all", { followUp: true })).get("all");
  const leads = all?.leads ?? 0;
  if (!all || !leads) return null;
  const posts = (await leadFigures(db, job.org_id, window, "code")).size;
  const followUp = all.needFollowUp;
  return reviewFinding({
    key: "social_leads_tracked", severity: "info", count: leads,
    title: `${plural(leads, "lead")} arrived through the tracked link of ${plural(posts, "social post")} in the last ${LOOKBACK_DAYS} days`,
    detail: `A lead is counted only when its own recorded visit carried a post's tracking code. Likes and views are not counted as leads or sales. ${followUp} of the ${leads} ${followUp === 1 ? "has" : "have"} no open task and no message sent to them since their visit (calls and meetings logged elsewhere are not checked).${all.alreadyInCrm ? ` ${all.alreadyInCrm} ${all.alreadyInCrm === 1 ? "was" : "were"} already in your CRM before their visit.` : ""}`,
    evidenceHref: "/social/analytics?range=90",
    recommendedAction: followUp ? `Give the ${plural(followUp, "lead")} with no follow-up an owner and a task in the CRM.` : "Make sure each of these leads has an owner and a next step in the CRM.", requiresApproval: false,
  });
};

/** The comparison with the period before, attached only when either period has enough to compare: a swing from 1 to 2 is not a trend. */
function comparison(value: number, previous: number, label: string): Partial<Pick<ReviewMetric, "previous" | "change" | "changePct" | "trend" | "comparisonPeriod" | "higherIsBetter">> {
  if (Math.max(value, previous) < MIN_PER_PERIOD) return {};
  const change = value - previous;
  return { previous, change, changePct: previous > 0 ? Math.round((change / previous) * 100) : null, trend: change > 0 ? "up" : change < 0 ? "down" : "flat", comparisonPeriod: label, higherIsBetter: true };
}

export const metrics = async (db: Queryable, job: WorkJobRow): Promise<ReviewMetric[]> => {
  const { rows } = await db.query<{ published: number; with_numbers: number; previous: number }>(
    `select count(*) filter (where p.published_at > now() - interval '30 days')::int as published,
            count(*) filter (where p.published_at > now() - interval '30 days' and exists (select 1 from social_post_metrics m where m.post_id = p.id and m.org_id = p.org_id and m.metrics <> '{}'::jsonb))::int as with_numbers,
            count(*) filter (where p.published_at <= now() - interval '30 days')::int as previous
     from social_posts p where p.org_id = $1 and p.status = 'published' and p.published_at > now() - interval '60 days'`, [job.org_id],
  );
  const leads = await db.query<{ recent: number; previous: number }>(
    `select count(distinct t.contact_id) filter (where t.occurred_at > now() - interval '30 days')::int as recent,
            count(distinct t.contact_id) filter (where t.occurred_at <= now() - interval '30 days')::int as previous
     from lead_touches t join contacts c on c.id = t.contact_id and c.org_id = t.org_id and c.deleted_at is null
     where t.org_id = $1 and t.occurred_at > now() - interval '60 days'
       and t.content in (select tracking_code from social_posts where org_id = $1 and tracking_code is not null)`, [job.org_id],
  );
  const r = rows[0] ?? { published: 0, with_numbers: 0, previous: 0 };
  const l = leads.rows[0] ?? { recent: 0, previous: 0 };
  const period = "The 30 days before";
  return [
    { key: "social_published", label: "Posts published", value: r.published, period: "Last 30 days", definition: "Posts the platform confirmed published.", source: "Social media manager", ...comparison(r.published, r.previous, period) },
    { key: "social_with_numbers", label: "Published posts with engagement numbers", value: r.with_numbers, period: "Last 30 days", definition: "Posts for which the platform returned at least one number. A post without numbers is not a post with zero.", source: "Social media manager" },
    { key: "social_tracked_leads", label: "Leads through post links", value: l.recent, period: "Last 30 days", definition: "Contacts (not deleted) whose recorded visit carried a social post's tracking code, counted by when the visit happened. Not sales.", source: "Social media manager", ...comparison(l.recent, l.previous, period) },
  ];
};

export async function runSocialPerformanceReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "social_performance_review",
    allowedRoles: ["performance_analyst"],
    scanningMessage: "Reading stored social posts, the numbers the platforms returned and the leads their tracked links brought…",
    analyzingMessage: "Working out what needs a person and what the evidence supports…",
    checks: [accountsNeedAttention, failedPosts, approvalBacklog, quietAccounts, engagementAdvice, engagementChange, campaignPerformance, leadsFromPosts],
    metrics,
    limitations: `Only stored records in this workspace were read. Nothing was drafted, published or changed. Engagement is limited to the likes, comments and shares a platform returned; reach and impressions are not collected. Posts are compared within one account, and a difference or a change is reported only with at least ${MIN_PER_GROUP} posts in each group (${MIN_PER_PERIOD} in each period) and a clear gap. Leads are credited to a post only through its tracking link; a post without one cannot be measured.`,
    subject: "Social media",
  });
}
