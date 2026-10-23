import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import { openCredentials } from "@/server/social/credentials";
import { providerFor } from "@/server/social/providers";
import type { SocialProvider } from "@/server/social/providers/types";
import type { Platform } from "@/lib/social/rules";

// What publishing achieved, from records that exist. Two kinds of evidence, never mixed up:
//   * ENGAGEMENT: only the numbers a platform actually returned for a post (likes, comments, shares). A number it did not return is absent, never shown as zero.
//     Reach and impressions are not collected: they need the insights permissions, which this build does not ask for.
//   * LEADS: a lead is tied to a post only when its own visit carried that post's tracking code (the utm_content on the post's link). Likes and impressions are
//     never claimed to have produced a sale; the figures below are contacts whose recorded visit came from the post's link, and what became of them.

export const METRICS_MAX_AGE_HOURS = 6;
export const METRICS_WINDOW_DAYS = 30;

export interface PostPerformance {
  postId: string;
  caption: string;
  platform: Platform;
  accountName: string;
  publishedAt: string;
  permalink: string | null;
  /** What the platform returned, or null when it returned nothing. */
  metrics: Record<string, number> | null;
  metricsAt: string | null;
  leads: number;
  qualified: number;
  appointments: number;
  opportunities: number;
  wonCount: number;
}

export interface SocialOverview {
  startsAt: string;
  endsAt: string;
  counts: { published: number; scheduled: number; awaitingApproval: number; failed: number; drafts: number };
  engagement: { totals: Record<string, number>; postsWithData: number; publishedPosts: number; lastSyncAt: string | null };
  leads: { total: number; qualified: number; appointments: number; opportunities: number; wonCount: number };
  posts: PostPerformance[];
  notes: string[];
}

const n = (v: unknown) => Number(v ?? 0);

export async function socialOverview(ctx: OrgContext, input: { startsAt: Date; endsAt: Date }): Promise<SocialOverview> {
  if (!ctx.can("social.view")) throw new AppError("forbidden", "Your role can't see social media.");
  if (!(input.startsAt < input.endsAt)) throw new AppError("invalid_input", "The period must end after it starts.");
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
    const posts = await db.query<{ id: string; caption: string; kind: string; platform: Platform; account_name: string; published_at: Date; permalink: string | null; tracking_code: string | null; metrics: Record<string, number> | null; fetched_at: Date | null }>(
      `select p.id, p.caption, p.kind, a.platform, a.name as account_name, p.published_at, p.permalink, p.tracking_code, m.metrics, m.fetched_at
       from social_posts p join social_accounts a on a.id = p.account_id and a.org_id = p.org_id
       left join lateral (select metrics, fetched_at from social_post_metrics where post_id = p.id and org_id = p.org_id order by fetched_at desc limit 1) m on true
       where p.org_id = $1 and p.status = 'published' and p.published_at >= $2 and p.published_at < $3 order by p.published_at desc limit 200`,
      [org, input.startsAt, input.endsAt],
    );
    const codes = posts.rows.map((p) => p.tracking_code).filter((c): c is string => Boolean(c));
    // Contacts whose recorded visit carried a post's tracking code, and what became of them. A contact is counted once per post.
    const byCode = new Map<string, { leads: number; qualified: number; appointments: number; opportunities: number; won: number }>();
    if (codes.length) {
      const lead = await db.query<{ code: string; leads: string; qualified: string; appointments: string; opportunities: string; won: string }>(
        `with hits as (
           select distinct t.content as code, c.id, c.lead_status from lead_touches t join contacts c on c.id = t.contact_id and c.org_id = t.org_id
           where t.org_id = $1 and t.content = any($2::text[]) and c.deleted_at is null
         )
         select h.code, count(*)::text as leads, count(*) filter (where h.lead_status in ('qualified', 'customer'))::text as qualified,
           count(*) filter (where exists (select 1 from appointment_refs a where a.org_id = $1 and a.contact_id = h.id and a.status not in ('cancelled', 'invalid')))::text as appointments,
           count(*) filter (where exists (select 1 from crm_opportunities o where o.org_id = $1 and o.contact_id = h.id and o.archived_at is null))::text as opportunities,
           count(*) filter (where exists (select 1 from crm_opportunities o where o.org_id = $1 and o.contact_id = h.id and o.archived_at is null and o.status = 'won'))::text as won
         from hits h group by h.code`, [org, codes],
      );
      for (const r of lead.rows) byCode.set(r.code, { leads: n(r.leads), qualified: n(r.qualified), appointments: n(r.appointments), opportunities: n(r.opportunities), won: n(r.won) });
    }
    const totals: Record<string, number> = {};
    let withData = 0;
    let lastSync: Date | null = null;
    const perf: PostPerformance[] = posts.rows.map((p) => {
      const m = p.metrics && Object.keys(p.metrics).length ? p.metrics : null;
      if (m) {
        withData += 1;
        for (const [k, v] of Object.entries(m)) if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
      }
      if (p.fetched_at && (!lastSync || new Date(p.fetched_at) > lastSync)) lastSync = new Date(p.fetched_at);
      const l = p.tracking_code ? byCode.get(p.tracking_code) : undefined;
      return {
        postId: p.id, caption: p.caption.slice(0, 140), platform: p.platform, accountName: p.account_name, publishedAt: new Date(p.published_at).toISOString(), permalink: p.permalink,
        metrics: m, metricsAt: p.fetched_at ? new Date(p.fetched_at).toISOString() : null,
        leads: l?.leads ?? 0, qualified: l?.qualified ?? 0, appointments: l?.appointments ?? 0, opportunities: l?.opportunities ?? 0, wonCount: l?.won ?? 0,
      };
    });
    const sum = (f: (p: PostPerformance) => number) => perf.reduce((t, p) => t + f(p), 0);
    return {
      startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(),
      counts: { published: n(counts.published), scheduled: n(counts.scheduled), awaitingApproval: n(counts.awaiting), failed: n(counts.failed), drafts: n(counts.drafts) },
      engagement: { totals, postsWithData: withData, publishedPosts: perf.length, lastSyncAt: lastSync ? (lastSync as Date).toISOString() : null },
      leads: { total: sum((p) => p.leads), qualified: sum((p) => p.qualified), appointments: sum((p) => p.appointments), opportunities: sum((p) => p.opportunities), wonCount: sum((p) => p.wonCount) },
      posts: perf,
      notes: [
        "Likes, comments and shares are shown only where the platform returned them. A post with no numbers has none from the platform yet, which is not the same as zero. Reach and impressions are not collected.",
        "A lead is tied to a post only when its own visit carried that post's tracking code. Likes and views are never counted as sales, and won deal value is the value of deals marked won, not verified revenue.",
      ],
    };
  });
}

/**
 * Reads the platform's numbers for recently published posts and stores what it returned. Posts checked in the last few hours are skipped, and an account that is
 * not connected is skipped. A post the platform returns nothing for gets no row: it shows as "no numbers yet", not as zero. Returns the posts that got numbers.
 */
export async function syncPostMetrics(deps: { now?: Date; provider?: (adapter: "meta" | "simulated") => SocialProvider; /** Only this workspace (tests and per-tenant tooling); the scheduler passes none. */ orgId?: string | null } = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const due = await withSystem(async (db) => (await db.query<{ id: string; org_id: string; provider_post_id: string; account_id: string; platform: Platform; adapter: "meta" | "simulated"; external_id: string; credentials: string | null }>(
    `select p.id, p.org_id, p.provider_post_id, p.account_id, a.platform, a.adapter, a.external_id, a.credentials
     from social_posts p join social_accounts a on a.id = p.account_id and a.org_id = p.org_id
     where p.status = 'published' and p.provider_post_id is not null and p.provider_post_id not like 'manual:%' and p.published_at > $1 and a.status = 'connected' and ($3::uuid is null or p.org_id = $3)
       and not exists (select 1 from social_post_metrics m where m.post_id = p.id and m.fetched_at > $2)
     order by p.published_at desc limit 100`,
    [new Date(now.getTime() - METRICS_WINDOW_DAYS * 86_400_000), new Date(now.getTime() - METRICS_MAX_AGE_HOURS * 3_600_000), deps.orgId ?? null],
  )).rows);
  let stored = 0;
  for (const p of due) {
    const creds = openCredentials(p.credentials);
    if (!creds) continue;
    try {
      const m = await (deps.provider ? deps.provider(p.adapter) : providerFor(p.adapter)).metrics(creds, { platform: p.platform, externalId: p.external_id }, p.provider_post_id);
      const clean = Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0));
      if (!Object.keys(clean).length) continue;
      await withSystem((db) => db.query("insert into social_post_metrics (org_id, post_id, fetched_at, metrics, source) values ($1, $2, $3, $4::jsonb, $5)", [p.org_id, p.id, now, JSON.stringify(clean), p.adapter]));
      stored += 1;
    } catch {
      /* a post whose numbers could not be read is tried again on the next pass */
    }
  }
  return stored;
}
