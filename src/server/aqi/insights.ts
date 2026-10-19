import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { resolveLlmConfigDetailed } from "@/server/llm/client";
import { getPublishedAqiConfig, effectiveAqiModel } from "@/server/aqi/service";
import { ORG_ROLES } from "@/lib/permissions";
import type { SessionUser } from "@/server/auth/service";

export interface AqiInsightsRequest {
  from?: string | null;
  to?: string | null;
  days?: number | null;
  orgId?: string | null;
  role?: string | null;
}

export interface AqiInsightsRange {
  from: string;
  to: string;
  days: number;
  label: string;
}

export interface AqiDailyPoint {
  date: string;
  messages: number;
  conversations: number;
  activeUsers: number;
}

export interface AqiTutorialInsight {
  slug: string;
  title: string;
  starts: number;
  completions: number;
  inProgress: number;
  resumes: number;
  targetMissing: number;
  completionRate: number | null;
  averageSeconds: number | null;
}

export interface AqiInsights {
  range: AqiInsightsRange;
  generatedAt: string;
  filters: {
    organizations: Array<{ id: string; name: string }>;
    roles: string[];
    orgId: string | null;
    role: string | null;
  };
  usage: {
    available: boolean;
    note: string | null;
    conversations: number;
    savedConversations: number;
    messages: number;
    userMessages: number;
    assistantMessages: number;
    activeUsers: number;
    newUsers: number;
    returningUsers: number;
    daily: AqiDailyPoint[];
  };
  performance: {
    available: boolean;
    note: string | null;
    successful: number;
    failed: number;
    cancelled: number;
    successRate: number | null;
    errors: Array<{ code: string; count: number }>;
    latencyP50: number | null;
    latencyP95: number | null;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    estimatedCosts: number;
    rateLimits: number;
    provider: { available: boolean; detail: string; connectionStatus: string | null; model: string | null };
  };
  knowledge: {
    available: boolean;
    note: string | null;
    retrievals: number;
    misses: number;
    topCategories: Array<{ category: string; count: number }>;
    unansweredByPage: Array<{ page: string; count: number }>;
    stale: Array<{ id: string; title: string; category: string; lastReviewedAt: string | null; updatedAt: string; freshnessDays: number | null; reviewDueAt: string | null }>;
    staleCount: number;
  };
  tutorials: {
    available: boolean;
    note: string | null;
    starts: number;
    completions: number;
    uniqueUsers: number;
    resumes: number;
    targetMissing: number;
    completionRate: number | null;
    abandonmentRate: number | null;
    averageSeconds: number | null;
    perTutorial: AqiTutorialInsight[];
    stops: Array<{ tutorialSlug: string; stepKey: string; count: number }>;
  };
  feedback: {
    available: boolean;
    note: string | null;
    helpful: number;
    notHelpful: number;
    total: number;
    trend: Array<{ date: string; helpful: number; notHelpful: number }>;
    byPage: Array<{ page: string; notHelpful: number }>;
  };
  guidance: {
    available: boolean;
    note: string | null;
    offers: number;
    accepted: number;
    declined: number;
    acceptanceRate: number | null;
    requestsByPage: Array<{ page: string; count: number }>;
    tipsShown: number;
    tipsClicked: number;
    topTips: Array<{ tipSlug: string; views: number; clicks: number }>;
  };
  definitions: Record<string, string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RATE = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDay(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError("invalid_input", `${label} must be a date such as 2026-10-01.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new AppError("invalid_input", `${label} is not a valid date.`);
  return date;
}

export function resolveAqiInsightsRange(input: AqiInsightsRequest): AqiInsightsRange {
  const today = new Date();
  const endDefault = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  let from: Date;
  let to: Date;
  if (input.from || input.to) {
    if (!input.from || !input.to) throw new AppError("invalid_input", "Choose both a start and an end date.");
    from = parseDay(input.from, "Start date");
    to = parseDay(input.to, "End date");
  } else {
    const days = Math.min(366, Math.max(1, Math.round(input.days ?? 30)));
    to = endDefault;
    from = new Date(to.getTime() - (days - 1) * DAY_MS);
  }
  if (from.getTime() > to.getTime()) throw new AppError("invalid_input", "The start date must be before the end date.");
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > 366) throw new AppError("invalid_input", "Choose a period of 366 days or less.");
  return {
    from: isoDay(from),
    to: isoDay(to),
    days,
    label: days === 1 ? from.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : `${from.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} – ${to.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
  };
}

const DEFINITIONS: Record<string, string> = {
  conversations: "AQi conversations created in the selected period. Temporary chats are included; only explicitly saved chats appear in history.",
  messages: "User and assistant turns written in the period, including failed and cancelled answers.",
  activeUsers: "Distinct signed-in people who wrote at least one AQi message in the period.",
  newUsers: "People whose first recorded AQi message falls inside the period.",
  returningUsers: "People who had at least one AQi message before the period and returned during it.",
  successRate: "Completed answers divided by all answers that reached a terminal state (complete, failed or cancelled).",
  latency: "Provider response time recorded on completed or failed answers. Estimated when the provider did not report usage.",
  cost: "Computed only from configured model prices; turns without configured pricing are excluded rather than estimated.",
  knowledgeRetrievals: "Turns where at least one published knowledge entry matched. Only the matched categories are stored, never the question or answer text.",
  knowledgeMisses: "How-to or navigation turns where no approved knowledge matched. Used to identify missing platform documentation.",
  staleKnowledge: "Published entries whose review date has passed, or which have never been reviewed and are older than their freshness policy.",
  tutorials: "Tutorial events are recorded only while a person actually runs a walkthrough. Starts are attempts, not page views.",
  completionRate: "Verified or explicitly finished walkthroughs divided by starts in the period.",
  feedback: "Thumbs up/down recorded on assistant answers. Free-text comments are stored for review but are not displayed in analytics.",
  guidance: "Offers AQi made to show a walkthrough, whether the person accepted, and configured contextual-tip impressions.",
  tips: "Configured tips shown on a matching authorized page. No model call is made to display a tip.",
};

/**
 * Super-Admin-only analytics. Every figure is a real aggregate over recorded rows; a section with no
 * event source is marked unavailable instead of being filled with an estimate. Conversation text is
 * never selected.
 */
export async function getAqiInsights(admin: SessionUser, input: AqiInsightsRequest): Promise<AqiInsights> {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can view AQi Insights.");
  const range = resolveAqiInsightsRange(input);
  const orgId = input.orgId?.trim() || null;
  if (orgId && !/^[0-9a-f-]{36}$/i.test(orgId)) throw new AppError("invalid_input", "Choose a valid organization.");
  const role = input.role?.trim() || null;
  if (role && !(ORG_ROLES as readonly string[]).includes(role)) throw new AppError("invalid_input", "Choose a valid workspace role.");
  const from = new Date(`${range.from}T00:00:00.000Z`);
  const toExclusive = new Date(new Date(`${range.to}T00:00:00.000Z`).getTime() + DAY_MS);
  const [configView, llm] = await Promise.all([getPublishedAqiConfig(), resolveLlmConfigDetailed()]);

  return withSystem(async (db) => {
    const rangeArgs = [from, toExclusive, orgId, role];
    const inRange = "m.created_at >= $1 and m.created_at < $2 and ($3::uuid is null or m.org_id = $3) and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = m.org_id and om.user_id = m.user_id and om.role = $4))";

    const messageTotals = (await db.query<{ messages: number; user_messages: number; assistant_messages: number; active_users: number; successful: number; failed: number; cancelled: number; input_tokens: number; output_tokens: number; cost_micros: number; estimated: number; p50: number | null; p95: number | null }>(
      `select count(*)::int as messages,
              count(*) filter (where m.role = 'user')::int as user_messages,
              count(*) filter (where m.role = 'assistant')::int as assistant_messages,
              count(distinct m.user_id)::int as active_users,
              count(*) filter (where m.role = 'assistant' and m.status = 'complete')::int as successful,
              count(*) filter (where m.role = 'assistant' and m.status = 'failed')::int as failed,
              count(*) filter (where m.role = 'assistant' and m.status = 'cancelled')::int as cancelled,
              coalesce(sum(m.input_tokens), 0)::int as input_tokens,
              coalesce(sum(m.output_tokens), 0)::int as output_tokens,
              coalesce((select sum(u.cost_micros) from aqi_usage_events u where u.created_at >= $1 and u.created_at < $2 and u.kind = 'message' and ($3::uuid is null or u.org_id = $3) and ($4::text is null or exists (select 1 from organization_memberships om2 where om2.org_id = u.org_id and om2.user_id = u.user_id and om2.role = $4))), 0)::bigint as cost_micros,
              count(*) filter (where m.role = 'assistant' and m.status = 'complete' and m.latency_ms is not null)::int as estimated,
              percentile_cont(0.5) within group (order by m.latency_ms) filter (where m.role = 'assistant' and m.latency_ms is not null) as p50,
              percentile_cont(0.95) within group (order by m.latency_ms) filter (where m.role = 'assistant' and m.latency_ms is not null) as p95
         from aqi_messages m where ${inRange}`,
      rangeArgs,
    )).rows[0];

    const conversationTotals = (await db.query<{ conversations: number; saved: number }>(
      `select count(*)::int as conversations, count(*) filter (where c.saved_at is not null)::int as saved
         from aqi_conversations c
        where c.created_at >= $1 and c.created_at < $2 and ($3::uuid is null or c.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = c.org_id and om.user_id = c.user_id and om.role = $4))`,
      rangeArgs,
    )).rows[0];

    const firstTime = (await db.query<{ new_users: number }>(
      `with firsts as (
         select m.user_id, min(m.created_at) as first_at
           from aqi_messages m
          where ($3::uuid is null or m.org_id = $3)
            and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = m.org_id and om.user_id = m.user_id and om.role = $4))
          group by m.user_id
       )
       select count(*)::int as new_users from firsts where first_at >= $1 and first_at < $2`,
      rangeArgs,
    )).rows[0];

    const daily = (await db.query<{ day: string; messages: number; conversations: number; active_users: number }>(
      `select to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD') as day,
              count(*)::int as messages,
              count(distinct m.conversation_id)::int as conversations,
              count(distinct m.user_id)::int as active_users
         from aqi_messages m where ${inRange}
        group by 1 order by 1`,
      rangeArgs,
    )).rows;

    const errors = (await db.query<{ code: string; count: number }>(
      `select coalesce(m.error_code, 'unknown') as code, count(*)::int as count
         from aqi_messages m
        where ${inRange} and m.role = 'assistant' and m.status = 'failed'
        group by 1 order by count desc, code limit 12`,
      rangeArgs,
    )).rows;

    const rateLimits = (await db.query<{ count: number }>(
      `select count(*)::int as count from aqi_usage_events u
        where u.kind = 'rate_limit' and u.created_at >= $1 and u.created_at < $2 and ($3::uuid is null or u.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = u.org_id and om.user_id = u.user_id and om.role = $4))`,
      rangeArgs,
    )).rows[0];

    const knowledge = (await db.query<{ retrievals: number; misses: number }>(
      `select count(*) filter (where kind = 'knowledge_retrieval')::int as retrievals,
              count(*) filter (where kind = 'knowledge_miss')::int as misses
         from aqi_usage_events u
        where u.created_at >= $1 and u.created_at < $2 and u.kind in ('knowledge_retrieval', 'knowledge_miss')
          and ($3::uuid is null or u.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = u.org_id and om.user_id = u.user_id and om.role = $4))`,
      rangeArgs,
    )).rows[0];

    const categories = (await db.query<{ category: string; count: number }>(
      `select category, count(*)::int as count
         from aqi_usage_events u, jsonb_array_elements_text(coalesce(u.metadata->'categories', '[]'::jsonb)) as category
        where u.kind = 'knowledge_retrieval' and u.created_at >= $1 and u.created_at < $2
          and ($3::uuid is null or u.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = u.org_id and om.user_id = u.user_id and om.role = $4))
        group by 1 order by count desc, category limit 12`,
      rangeArgs,
    )).rows;

    const missesByPage = (await db.query<{ page: string; count: number }>(
      `select coalesce(u.page_route, u.metadata->>'page', 'Unknown page') as page, count(*)::int as count
         from aqi_usage_events u
        where u.kind = 'knowledge_miss' and u.created_at >= $1 and u.created_at < $2 and ($3::uuid is null or u.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = u.org_id and om.user_id = u.user_id and om.role = $4))
        group by 1 order by count desc limit 12`,
      rangeArgs,
    )).rows;

    const stale = (await db.query<{ id: string; title: string; category: string; last_reviewed_at: Date | null; updated_at: Date; freshness_days: number | null; review_due_at: Date | null }>(
      `select id, title, category, last_reviewed_at, updated_at, freshness_days,
              coalesce(next_review_at, (coalesce(last_reviewed_at, updated_at) + make_interval(days => coalesce(freshness_days, $1)))) as review_due_at
         from aqi_knowledge_entries
        where status = 'published'
          and coalesce(next_review_at, (coalesce(last_reviewed_at, updated_at) + make_interval(days => coalesce(freshness_days, $1)))) < now()
        order by review_due_at asc limit 40`,
      [configView.config.knowledgeFreshnessDays],
    )).rows;

    const tutorialEvents = (await db.query<{ kind: string; count: number; users: number }>(
      `select e.kind, count(*)::int as count, count(distinct e.user_id)::int as users
         from aqi_tutorial_events e
        where e.created_at >= $1 and e.created_at < $2 and ($3::uuid is null or e.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = e.org_id and om.user_id = e.user_id and om.role = $4))
        group by e.kind`,
      rangeArgs,
    )).rows;

    const tutorialRows = (await db.query<{ slug: string; title: string; starts: number; completions: number; resumes: number; target_missing: number; users: number }>(
      `select t.slug, t.title,
              count(*) filter (where e.kind = 'started')::int as starts,
              count(*) filter (where e.kind = 'completed')::int as completions,
              count(*) filter (where e.kind = 'resumed')::int as resumes,
              count(*) filter (where e.kind = 'target_missing')::int as target_missing,
              count(distinct e.user_id)::int as users
         from aqi_tutorial_events e join aqi_tutorials t on t.id = e.tutorial_id
        where e.created_at >= $1 and e.created_at < $2 and ($3::uuid is null or e.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = e.org_id and om.user_id = e.user_id and om.role = $4))
        group by t.slug, t.title order by starts desc, t.title`,
      rangeArgs,
    )).rows;

    const progress = (await db.query<{ tutorial_id: string; slug: string; in_progress: number; avg_seconds: number | null }>(
      `select t.id as tutorial_id, t.slug,
              count(*) filter (where p.status in ('in_progress', 'paused'))::int as in_progress,
              avg(extract(epoch from (p.completed_at - p.started_at))) filter (where p.status = 'completed' and p.completed_at is not null) as avg_seconds
         from aqi_tutorial_progress p join aqi_tutorials t on t.id = p.tutorial_id
        where p.last_activity_at >= $1 and p.last_activity_at < $2 and ($3::uuid is null or p.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = p.org_id and om.user_id = p.user_id and om.role = $4))
        group by t.id, t.slug`,
      rangeArgs,
    )).rows;

    const stops = (await db.query<{ slug: string; step_key: string; count: number }>(
      `select t.slug, coalesce(e.step_key, 'unknown') as step_key, count(*)::int as count
         from aqi_tutorial_events e join aqi_tutorials t on t.id = e.tutorial_id
        where e.kind in ('exited', 'target_missing') and e.created_at >= $1 and e.created_at < $2
          and ($3::uuid is null or e.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = e.org_id and om.user_id = e.user_id and om.role = $4))
        group by 1, 2 order by count desc limit 20`,
      rangeArgs,
    )).rows;

    const feedback = (await db.query<{ helpful: number; not_helpful: number }>(
      `select count(*) filter (where m.feedback_rating = 1)::int as helpful,
              count(*) filter (where m.feedback_rating = -1)::int as not_helpful
         from aqi_messages m where ${inRange} and m.feedback_rating is not null`,
      rangeArgs,
    )).rows[0];

    const feedbackDaily = (await db.query<{ day: string; helpful: number; not_helpful: number }>(
      `select to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD') as day,
              count(*) filter (where m.feedback_rating = 1)::int as helpful,
              count(*) filter (where m.feedback_rating = -1)::int as not_helpful
         from aqi_messages m where ${inRange} and m.feedback_rating is not null
        group by 1 order by 1`,
      rangeArgs,
    )).rows;

    const feedbackByPage = (await db.query<{ page: string; not_helpful: number }>(
      `select coalesce(m.context->>'page', 'Unknown page') as page, count(*)::int as not_helpful
         from aqi_messages m
        where ${inRange} and m.feedback_rating = -1
        group by 1 order by not_helpful desc limit 12`,
      rangeArgs,
    )).rows;

    const guidance = (await db.query<{ offers: number; accepted: number; declined: number; tips_view: number; tips_click: number }>(
      `select count(*) filter (where kind = 'guidance_offer')::int as offers,
              count(*) filter (where kind = 'guidance_accept')::int as accepted,
              count(*) filter (where kind = 'guidance_decline')::int as declined,
              count(*) filter (where kind = 'tip_view')::int as tips_view,
              count(*) filter (where kind = 'tip_click')::int as tips_click
         from aqi_usage_events u
        where u.created_at >= $1 and u.created_at < $2
          and u.kind in ('guidance_offer', 'guidance_accept', 'guidance_decline', 'tip_view', 'tip_click')
          and ($3::uuid is null or u.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = u.org_id and om.user_id = u.user_id and om.role = $4))`,
      rangeArgs,
    )).rows[0];

    const guidancePages = (await db.query<{ page: string; count: number }>(
      `select coalesce(u.page_route, 'Unknown page') as page, count(*)::int as count
         from aqi_usage_events u
        where u.kind = 'guidance_offer' and u.created_at >= $1 and u.created_at < $2 and ($3::uuid is null or u.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = u.org_id and om.user_id = u.user_id and om.role = $4))
        group by 1 order by count desc limit 12`,
      rangeArgs,
    )).rows;

    const topTips = (await db.query<{ tip: string; views: number; clicks: number }>(
      `select coalesce(u.metadata->>'tipSlug', u.metadata->>'tipId', 'unknown') as tip,
              count(*) filter (where u.kind = 'tip_view')::int as views,
              count(*) filter (where u.kind = 'tip_click')::int as clicks
         from aqi_usage_events u
        where u.kind in ('tip_view', 'tip_click') and u.created_at >= $1 and u.created_at < $2
          and ($3::uuid is null or u.org_id = $3)
          and ($4::text is null or exists (select 1 from organization_memberships om where om.org_id = u.org_id and om.user_id = u.user_id and om.role = $4))
        group by 1 order by views desc, clicks desc limit 12`,
      rangeArgs,
    )).rows;

    const organizations = (await db.query<{ id: string; name: string }>(
      "select id, name from organizations where kind = 'client' and status <> 'archived' order by name",
    )).rows;

    const counts = Object.fromEntries(tutorialEvents.map((row) => [row.kind, row.count]));
    const starts = counts.started ?? 0;
    const completions = counts.completed ?? 0;
    const uniqueUsers = Math.max(0, ...tutorialEvents.map((row) => row.users));
    const perTutorial: AqiTutorialInsight[] = tutorialRows.map((row) => {
      const progressRow = progress.find((p) => p.slug === row.slug);
      return {
        slug: row.slug,
        title: row.title,
        starts: row.starts,
        completions: row.completions,
        inProgress: progressRow?.in_progress ?? 0,
        resumes: row.resumes,
        targetMissing: row.target_missing,
        completionRate: RATE(row.completions, row.starts),
        averageSeconds: progressRow?.avg_seconds ? Math.round(progressRow.avg_seconds) : null,
      };
    });
    const averageSeconds = (() => {
      const values = progress.filter((row) => row.avg_seconds !== null).map((row) => Number(row.avg_seconds));
      return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    })();

    const usageAny = messageTotals.messages > 0 || conversationTotals.conversations > 0;
    const performanceAny = messageTotals.successful + messageTotals.failed + messageTotals.cancelled > 0;
    const feedbackAny = feedback.helpful + feedback.not_helpful > 0;
    const tutorialAny = starts + completions + (counts.resumed ?? 0) > 0;
    const guidanceAny = guidance.offers + guidance.tips_view > 0;

    return {
      range,
      generatedAt: new Date().toISOString(),
      filters: { organizations, roles: [...ORG_ROLES], orgId, role },
      usage: {
        available: usageAny,
        note: usageAny ? null : "No AQi messages or conversations were recorded in this period.",
        conversations: conversationTotals.conversations,
        savedConversations: conversationTotals.saved,
        messages: messageTotals.messages,
        userMessages: messageTotals.user_messages,
        assistantMessages: messageTotals.assistant_messages,
        activeUsers: messageTotals.active_users,
        newUsers: firstTime.new_users,
        returningUsers: Math.max(0, messageTotals.active_users - firstTime.new_users),
        daily: daily.map((row) => ({ date: row.day, messages: row.messages, conversations: row.conversations, activeUsers: row.active_users })),
      },
      performance: {
        available: performanceAny,
        note: performanceAny ? null : "No provider answers were recorded in this period.",
        successful: messageTotals.successful,
        failed: messageTotals.failed,
        cancelled: messageTotals.cancelled,
        successRate: RATE(messageTotals.successful, messageTotals.successful + messageTotals.failed + messageTotals.cancelled),
        errors: errors.map((row) => ({ code: row.code, count: row.count })),
        latencyP50: messageTotals.p50 !== null ? Math.round(Number(messageTotals.p50)) : null,
        latencyP95: messageTotals.p95 !== null ? Math.round(Number(messageTotals.p95)) : null,
        inputTokens: messageTotals.input_tokens,
        outputTokens: messageTotals.output_tokens,
        costMicros: Number(messageTotals.cost_micros),
        estimatedCosts: messageTotals.estimated,
        rateLimits: rateLimits.count,
        provider: {
          available: Boolean(llm.config?.apiKey),
          detail: llm.config?.apiKey ? "Configured AI provider is available to AQi." : "No eligible AQi provider is currently available.",
          connectionStatus: llm.connectionStatus,
          model: effectiveAqiModel(configView.config, llm.config?.model ?? llm.model),
        },
      },
      knowledge: {
        available: knowledge.retrievals + knowledge.misses > 0,
        note: knowledge.retrievals + knowledge.misses > 0 ? null : "Knowledge retrieval events are recorded from Phase 3 onward; no matched or missed retrieval was recorded in this period.",
        retrievals: knowledge.retrievals,
        misses: knowledge.misses,
        topCategories: categories.map((row) => ({ category: row.category, count: row.count })),
        unansweredByPage: missesByPage.map((row) => ({ page: row.page, count: row.count })),
        stale: stale.map((row) => ({
          id: row.id,
          title: row.title,
          category: row.category,
          lastReviewedAt: row.last_reviewed_at ? row.last_reviewed_at.toISOString() : null,
          updatedAt: row.updated_at.toISOString(),
          freshnessDays: row.freshness_days,
          reviewDueAt: row.review_due_at ? row.review_due_at.toISOString() : null,
        })),
        staleCount: stale.length,
      },
      tutorials: {
        available: tutorialAny,
        note: tutorialAny ? null : "No tutorial activity was recorded in this period.",
        starts,
        completions,
        uniqueUsers,
        resumes: counts.resumed ?? 0,
        targetMissing: counts.target_missing ?? 0,
        completionRate: RATE(completions, starts),
        abandonmentRate: starts ? Math.round(((starts - completions) / starts) * 1000) / 10 : null,
        averageSeconds,
        perTutorial,
        stops: stops.map((row) => ({ tutorialSlug: row.slug, stepKey: row.step_key, count: row.count })),
      },
      feedback: {
        available: feedbackAny,
        note: feedbackAny ? null : "No feedback was recorded in this period.",
        helpful: feedback.helpful,
        notHelpful: feedback.not_helpful,
        total: feedback.helpful + feedback.not_helpful,
        trend: feedbackDaily.map((row) => ({ date: row.day, helpful: row.helpful, notHelpful: row.not_helpful })),
        byPage: feedbackByPage.map((row) => ({ page: row.page, notHelpful: row.not_helpful })),
      },
      guidance: {
        available: guidanceAny,
        note: guidanceAny ? null : "No guidance offers or contextual tips were recorded in this period.",
        offers: guidance.offers,
        accepted: guidance.accepted,
        declined: guidance.declined,
        acceptanceRate: RATE(guidance.accepted, guidance.offers),
        requestsByPage: guidancePages.map((row) => ({ page: row.page, count: row.count })),
        tipsShown: guidance.tips_view,
        tipsClicked: guidance.tips_click,
        topTips: topTips.map((row) => ({ tipSlug: row.tip, views: row.views, clicks: row.clicks })),
      },
      definitions: DEFINITIONS,
    };
  });
}
