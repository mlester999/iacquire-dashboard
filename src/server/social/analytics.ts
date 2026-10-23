import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import { openCredentials } from "@/server/social/credentials";
import { socialOrgRunnableSql } from "@/server/social/org-gate";
import { providerFor } from "@/server/social/providers";
import type { SocialProvider } from "@/server/social/providers/types";
import { PLATFORMS, PLATFORM_LIMITS, type Platform } from "@/lib/social/rules";

// What publishing achieved, from records that exist. Two kinds of evidence, never mixed up:
//   * ENGAGEMENT: only the numbers a platform actually returned for a post (likes, comments, shares). A number it did not return is absent, never shown as zero.
//     Reach and impressions are not collected: they need the insights permissions, which this build does not ask for.
//   * LEADS: a lead is tied to a post only when its own visit carried that post's tracking code (the utm_content on the post's link). Likes and impressions are
//     never claimed to have produced a sale; the figures below are contacts whose recorded visit came from the post's link, and what became of them AFTER that visit.
//     A post whose link cannot carry the code (no link, tracking off, Instagram) cannot be measured and is reported as such, never as zero.

export const METRICS_MAX_AGE_HOURS = 6;
export const METRICS_WINDOW_DAYS = 30;
/** Numbers last read longer ago than this are shown with the date they are from. */
export const METRICS_STALE_HOURS = 24;
/** The most posts one metrics pass reads, and how long it may run: the rest wait for the next pass, oldest read first. */
const MAX_READS_PER_PASS = 100;
const DEFAULT_BUDGET_MS = 45_000;
/** A contact created this long before its first visit through a post still counts as created by that visit, so a clock that differs a little never turns a new lead into an old one. */
const SAME_VISIT_SLACK = "5 minutes";

export type MetricsState = "current" | "stale" | "frozen";

/** What became of the contacts whose visit carried a post's (or campaign's) tracking code. Each contact is counted once. */
export interface LeadFigures {
  leads: number;
  /** Leads the visit itself added to the CRM and that are now qualified or customers. A lead's status has no history, so one already in the CRM before the visit is not credited. */
  qualified: number;
  /** Appointments booked after the visit. */
  appointments: number;
  /** Deals created after the visit. */
  opportunities: number;
  /** Those deals that are marked won. */
  wonCount: number;
  /** Leads that were already in the CRM before their visit: counted in `leads`, but their status is not credited. */
  alreadyInCrm: number;
}

export interface PostPerformance extends LeadFigures {
  postId: string;
  caption: string;
  platform: Platform;
  accountName: string;
  campaignName: string | null;
  publishedAt: string;
  permalink: string | null;
  /** What the platform returned, or null when it returned nothing. */
  metrics: Record<string, number> | null;
  /** When those numbers were read. */
  metricsAt: string | null;
  /** current: read within the last day. stale: older. frozen: the post is past the window in which numbers are read, so they are from when it was last read. */
  metricsState: MetricsState | null;
  /** Whether the posted link carries this post's tracking code. When false no lead can be tied to the post, and the lead figures above are not measurements. */
  tracked: boolean;
}

export interface CampaignPerformance extends LeadFigures {
  campaignId: string | null;
  name: string;
  posts: number;
  /** Posts of the campaign whose link carries a tracking code. */
  trackedPosts: number;
  /** False when none of the campaign's posts carries a tracking code: its lead figures are not measurements. */
  tracked: boolean;
}

export interface SocialOverview {
  startsAt: string;
  endsAt: string;
  counts: { published: number; scheduled: number; awaitingApproval: number; failed: number; drafts: number };
  engagement: { totals: Record<string, number>; postsWithData: number; publishedPosts: number; lastSyncAt: string | null; outdatedPosts: number };
  /** Distinct contacts across every tracked post in the period, each counted once (so these can be fewer than the rows add up to), and how many tracked posts they could come from. */
  leads: Omit<LeadFigures, "leads"> & { total: number; trackedPosts: number };
  campaigns: CampaignPerformance[];
  posts: PostPerformance[];
  /** True when the period holds more published posts than the table lists (the most recent are listed, and the engagement totals cover those). */
  postsTruncated: boolean;
  notes: string[];
}

const n = (v: unknown) => Number(v ?? 0);
const NO_FIGURES: LeadFigures = { leads: 0, qualified: 0, appointments: 0, opportunities: 0, wonCount: 0, alreadyInCrm: 0 };
const POST_LIST_LIMIT = 200;

/** Platforms whose captions make a link clickable: the only ones where a visitor can arrive through a post's link. */
const CLICKABLE: string[] = PLATFORMS.filter((p) => PLATFORM_LIMITS[p].clickableLinks);

/** Published posts of a window whose posted link carries the tracking code. Parameters: $1 workspace, $2 from, $3 to, $4 platforms with clickable links. */
const TRACKED_POSTS = `select p.tracking_code as code, p.campaign_id
  from social_posts p join social_accounts a on a.id = p.account_id and a.org_id = p.org_id
  where p.org_id = $1 and p.status = 'published' and p.published_at >= $2 and p.published_at < $3
    and p.tracking_code is not null and p.link_url is not null and a.platform = any($4::text[])`;

/**
 * What became of a set of contacts, counted from each contact's FIRST visit that carried a code. Every outcome has to come after that visit: a deal, an
 * appointment or a win that predates it is not the post's. Qualified has no history to compare, so it is credited only to a contact the visit itself created.
 */
const FIGURES = `count(*)::int as leads,
  count(*) filter (where f.created_at < f.at - interval '${SAME_VISIT_SLACK}')::int as already_in_crm,
  count(*) filter (where f.created_at >= f.at - interval '${SAME_VISIT_SLACK}' and f.lead_status in ('qualified', 'customer'))::int as qualified,
  count(*) filter (where exists (select 1 from appointment_refs ar where ar.org_id = $1 and ar.contact_id = f.contact_id and ar.status not in ('cancelled', 'invalid') and ar.created_at >= f.at))::int as appointments,
  count(*) filter (where exists (select 1 from crm_opportunities o where o.org_id = $1 and o.contact_id = f.contact_id and o.archived_at is null and o.created_at >= f.at))::int as opportunities,
  count(*) filter (where exists (select 1 from crm_opportunities o where o.org_id = $1 and o.contact_id = f.contact_id and o.archived_at is null and o.created_at >= f.at and o.status = 'won'))::int as won`;

/** Whether a lead has been followed up since its visit: an open task for the contact, or a message sent to them. Calls and meetings logged elsewhere are not looked at. */
const NEEDS_FOLLOW_UP = `count(*) filter (where not exists (select 1 from tasks tk where tk.org_id = $1 and tk.contact_id = f.contact_id and tk.status in ('open', 'in_progress'))
    and not exists (select 1 from conversations cv join conversation_messages cm on cm.conversation_id = cv.id and cm.org_id = cv.org_id
      where cv.org_id = $1 and cv.contact_id = f.contact_id and cm.direction = 'outbound' and cm.status in ('queued', 'sending', 'sent', 'delivered', 'read') and cm.created_at >= f.at))::int as need_follow_up`;

type Row = { grp: string | null; leads: number; already_in_crm: number; qualified: number; appointments: number; opportunities: number; won: number; need_follow_up?: number };
const figuresOf = (r: Row): LeadFigures => ({ leads: n(r.leads), qualified: n(r.qualified), appointments: n(r.appointments), opportunities: n(r.opportunities), wonCount: n(r.won), alreadyInCrm: n(r.already_in_crm) });
const plain = (f: LeadFigures | undefined): LeadFigures => (f ? { leads: f.leads, qualified: f.qualified, appointments: f.appointments, opportunities: f.opportunities, wonCount: f.wonCount, alreadyInCrm: f.alreadyInCrm } : { ...NO_FIGURES });

/**
 * The lead figures of the tracked posts published in a window, by post (keyed by tracking code), by campaign (keyed by campaign id, null for posts with none) or
 * all together ("all"). A contact is counted once per key, however many touches or posts it made, and a deleted contact is not counted. With `followUp`, also how
 * many of those leads have neither an open task nor a message sent to them since their visit.
 */
export async function leadFigures(db: Queryable, orgId: string, window: { startsAt: Date; endsAt: Date }, by: "code" | "campaign" | "all", opts: { followUp?: boolean } = {}): Promise<Map<string | null, LeadFigures & { needFollowUp: number }>> {
  const grp = by === "code" ? "tr.code" : by === "campaign" ? "tr.campaign_id::text" : "'all'";
  const group = by === "all" ? "t.contact_id, c.created_at, c.lead_status" : `${grp}, t.contact_id, c.created_at, c.lead_status`;
  const { rows } = await db.query<Row>(
    `with tracked as (${TRACKED_POSTS}),
     f as (
       select ${grp} as grp, t.contact_id, min(t.occurred_at) as at, c.created_at, c.lead_status
       from tracked tr join lead_touches t on t.org_id = $1 and t.content = tr.code
       join contacts c on c.id = t.contact_id and c.org_id = t.org_id and c.deleted_at is null
       group by ${group}
     )
     select f.grp, ${FIGURES}${opts.followUp ? `,\n       ${NEEDS_FOLLOW_UP}` : ""}
     from f group by f.grp`,
    [orgId, window.startsAt, window.endsAt, CLICKABLE],
  );
  return new Map(rows.map((r) => [r.grp, { ...figuresOf(r), needFollowUp: n(r.need_follow_up) }]));
}

/** Posts published in a window, and what followed the ones with a tracking link, per campaign. Posts that belong to no campaign are listed last, as "No campaign". */
export async function campaignRollup(db: Queryable, orgId: string, window: { startsAt: Date; endsAt: Date }): Promise<CampaignPerformance[]> {
  const byCampaign = await leadFigures(db, orgId, window, "campaign");
  const { rows } = await db.query<{ campaign_id: string | null; name: string | null; posts: number; tracked_posts: number }>(
    `select p.campaign_id, camp.name, count(*)::int as posts,
            count(*) filter (where p.tracking_code is not null and p.link_url is not null and a.platform = any($4::text[]))::int as tracked_posts
     from social_posts p join social_accounts a on a.id = p.account_id and a.org_id = p.org_id
     left join social_campaigns camp on camp.id = p.campaign_id and camp.org_id = p.org_id
     where p.org_id = $1 and p.status = 'published' and p.published_at >= $2 and p.published_at < $3
     group by p.campaign_id, camp.name`,
    [orgId, window.startsAt, window.endsAt, CLICKABLE],
  );
  return rows
    .map((r): CampaignPerformance => ({ campaignId: r.campaign_id, name: r.campaign_id ? r.name ?? "Removed campaign" : "No campaign", posts: n(r.posts), trackedPosts: n(r.tracked_posts), tracked: n(r.tracked_posts) > 0, ...plain(byCampaign.get(r.campaign_id)) }))
    .sort((a, b) => Number(a.campaignId === null) - Number(b.campaignId === null) || b.posts - a.posts || a.name.localeCompare(b.name));
}

function metricsState(publishedAt: Date, fetchedAt: Date | null, now: Date): MetricsState | null {
  if (!fetchedAt) return null;
  if (now.getTime() - publishedAt.getTime() > METRICS_WINDOW_DAYS * 86_400_000) return "frozen";
  return now.getTime() - fetchedAt.getTime() > METRICS_STALE_HOURS * 3_600_000 ? "stale" : "current";
}

export async function socialOverview(ctx: OrgContext, input: { startsAt: Date; endsAt: Date }, deps: { now?: Date } = {}): Promise<SocialOverview> {
  if (!ctx.can("social.view")) throw new AppError("forbidden", "Your role can't see social media.");
  if (!(input.startsAt < input.endsAt)) throw new AppError("invalid_input", "The period must end after it starts.");
  const now = deps.now ?? new Date();
  return withUser(ctx.user.id, async (db) => {
    const org = ctx.org.orgId;
    const counts = (await db.query<{ published: string; scheduled: string; awaiting: string; failed: string; drafts: string }>(
      `select count(*) filter (where status = 'published' and published_at >= $2 and published_at < $3)::text as published,
              count(*) filter (where status in ('scheduled', 'publishing'))::text as scheduled,
              count(*) filter (where status = 'pending_approval')::text as awaiting,
              count(*) filter (where status in ('failed', 'needs_reconciliation'))::text as failed,
              count(*) filter (where status in ('draft', 'changes_requested', 'approved'))::text as drafts
       from social_posts where org_id = $1`, [org, input.startsAt, input.endsAt],
    )).rows[0];
    // The latest numbers the platform returned: a pass that found nothing leaves an empty marker row, which must not hide earlier numbers.
    const posts = await db.query<{ id: string; caption: string; kind: string; link_url: string | null; platform: Platform; account_name: string; campaign_name: string | null; published_at: Date; permalink: string | null; tracking_code: string | null; metrics: Record<string, number> | null; fetched_at: Date | null }>(
      `select p.id, p.caption, p.kind, p.link_url, a.platform, a.name as account_name, camp.name as campaign_name, p.published_at, p.permalink, p.tracking_code, m.metrics, m.fetched_at
       from social_posts p join social_accounts a on a.id = p.account_id and a.org_id = p.org_id
       left join social_campaigns camp on camp.id = p.campaign_id and camp.org_id = p.org_id
       left join lateral (select metrics, fetched_at from social_post_metrics where post_id = p.id and org_id = p.org_id and metrics <> '{}'::jsonb order by fetched_at desc limit 1) m on true
       where p.org_id = $1 and p.status = 'published' and p.published_at >= $2 and p.published_at < $3 order by p.published_at desc limit ${POST_LIST_LIMIT}`,
      [org, input.startsAt, input.endsAt],
    );
    const byCode = await leadFigures(db, org, input, "code");
    const all = plain((await leadFigures(db, org, input, "all")).get("all"));
    const campaigns = await campaignRollup(db, org, input);
    const trackedPosts = campaigns.reduce((t, c) => t + c.trackedPosts, 0);

    const totals: Record<string, number> = {};
    let withData = 0;
    let outdated = 0;
    let lastSync: Date | null = null;
    const perf: PostPerformance[] = posts.rows.map((p) => {
      const m = p.metrics && Object.keys(p.metrics).length ? p.metrics : null;
      if (m) {
        withData += 1;
        for (const [k, v] of Object.entries(m)) if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
      }
      if (p.fetched_at && (!lastSync || new Date(p.fetched_at) > lastSync)) lastSync = new Date(p.fetched_at);
      const state = metricsState(new Date(p.published_at), p.fetched_at ? new Date(p.fetched_at) : null, now);
      if (state === "stale" || state === "frozen") outdated += 1;
      const tracked = Boolean(p.tracking_code && p.link_url && CLICKABLE.includes(p.platform));
      const l = tracked ? byCode.get(p.tracking_code) : undefined;
      return {
        postId: p.id, caption: p.caption.slice(0, 140), platform: p.platform, accountName: p.account_name, campaignName: p.campaign_name, publishedAt: new Date(p.published_at).toISOString(), permalink: p.permalink,
        metrics: m, metricsAt: p.fetched_at ? new Date(p.fetched_at).toISOString() : null, metricsState: state, tracked, ...plain(l),
      };
    });
    return {
      startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(),
      counts: { published: n(counts.published), scheduled: n(counts.scheduled), awaitingApproval: n(counts.awaiting), failed: n(counts.failed), drafts: n(counts.drafts) },
      engagement: { totals, postsWithData: withData, publishedPosts: perf.length, lastSyncAt: lastSync ? (lastSync as Date).toISOString() : null, outdatedPosts: outdated },
      leads: { total: all.leads, qualified: all.qualified, appointments: all.appointments, opportunities: all.opportunities, wonCount: all.wonCount, alreadyInCrm: all.alreadyInCrm, trackedPosts },
      campaigns,
      posts: perf,
      postsTruncated: n(counts.published) > perf.length,
      notes: [
        "Likes, comments and shares are shown only where the platform returned them. A post with no numbers has none from the platform yet, which is not the same as zero. Reach and impressions are not collected.",
        "A lead is tied to a post only when its own visit carried that post's tracking code. Likes and views are never counted as sales, and won deal value is the value of deals marked won, not verified revenue.",
        "Appointments and deals count only those created after the lead's visit through the post. Qualified counts only leads that visit added to your CRM, because a lead's status has no history; a lead already in your CRM beforehand is counted as a lead and shown separately. A post without a tracking code in its link cannot be measured, so it shows \"Not tracked\", not zero.",
      ],
    };
  });
}

/**
 * Reads the platform's numbers for published posts and stores what it returned. Posts read in the last few hours are skipped, and so are an account that is not
 * connected and a workspace that is suspended, archived or paused. Each pass reads the posts whose latest read is oldest first (never-read first), one workspace's
 * turn after another's, so a busy workspace cannot starve a quiet one, and it stops when its time budget is spent. A post the platform returns nothing for (or that
 * could not be read) gets an empty marker row, which only moves it to the back of the queue: it shows as "no numbers yet", not as zero. Returns the posts that got numbers.
 */
export async function syncPostMetrics(deps: {
  now?: Date;
  provider?: (adapter: "meta" | "simulated") => SocialProvider;
  /** Only this workspace (tests and per-tenant tooling); the scheduler passes none. */
  orgId?: string | null;
  /** How long the pass may keep reading before it leaves the rest for the next one. */
  budgetMs?: number;
  /** The most posts to read in this pass. */
  limit?: number;
} = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const due = await withSystem(async (db) => (await db.query<{ id: string; org_id: string; provider_post_id: string; account_id: string; platform: Platform; adapter: "meta" | "simulated"; external_id: string; credentials: string | null }>(
    `select q.id, q.org_id, q.provider_post_id, q.account_id, q.platform, q.adapter, q.external_id, q.credentials from (
       select p.id, p.org_id, p.provider_post_id, p.account_id, a.platform, a.adapter, a.external_id, a.credentials, p.published_at, lr.last_read,
              row_number() over (partition by p.org_id order by lr.last_read asc nulls first, p.published_at desc) as turn
       from social_posts p join social_accounts a on a.id = p.account_id and a.org_id = p.org_id
       left join lateral (select max(m.fetched_at) as last_read from social_post_metrics m where m.post_id = p.id and m.org_id = p.org_id) lr on true
       where p.status = 'published' and p.provider_post_id is not null and p.provider_post_id not like 'manual:%' and p.provider_post_id not like 'container:%'
         and p.published_at > $1 and a.status = 'connected' and a.credentials is not null and ($3::uuid is null or p.org_id = $3)
         and ${socialOrgRunnableSql("p.org_id")}
         and (lr.last_read is null or lr.last_read <= $2)
     ) q order by q.turn, q.last_read asc nulls first, q.published_at desc limit $4`,
    [new Date(now.getTime() - METRICS_WINDOW_DAYS * 86_400_000), new Date(now.getTime() - METRICS_MAX_AGE_HOURS * 3_600_000), deps.orgId ?? null, deps.limit ?? MAX_READS_PER_PASS],
  )).rows);
  const deadline = Date.now() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
  let stored = 0;
  for (const p of due) {
    if (Date.now() > deadline) break;
    let clean: Record<string, number> = {};
    try {
      const creds = openCredentials(p.credentials);
      if (creds) {
        const m = await (deps.provider ? deps.provider(p.adapter) : providerFor(p.adapter)).metrics(creds, { platform: p.platform, externalId: p.external_id }, p.provider_post_id);
        clean = Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0));
      }
    } catch {
      /* a post whose numbers could not be read is tried again on a later pass, after the ones read longer ago */
    }
    await withSystem((db) => db.query("insert into social_post_metrics (org_id, post_id, fetched_at, metrics, source) values ($1, $2, $3, $4::jsonb, $5)", [p.org_id, p.id, now, JSON.stringify(clean), p.adapter]));
    if (Object.keys(clean).length) stored += 1;
  }
  return stored;
}
