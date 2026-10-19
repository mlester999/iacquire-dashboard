import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { canOpenAqiRoute, matchAqiRoute } from "@/lib/aqi/routes";
import { listAqiTutorialsForViewer, recordAqiGuideSignal } from "@/server/aqi/tutorials";
import type { AqiViewer } from "@/server/aqi/access";
import type { AqiTutorialSummary } from "@/lib/aqi/tutorials";
import type { Permission } from "@/lib/permissions";

export type AqiOnboardingStatus = "not_seen" | "deferred" | "dismissed" | "completed" | "started";

export interface AqiPreferences {
  onboardingStatus: AqiOnboardingStatus;
  onboardingSeenAt: string | null;
  onboardingDismissedAt: string | null;
  postponedUntil: string | null;
  tipsEnabled: boolean;
  tipsQuietUntil: string | null;
  dismissedTips: string[];
}

interface PreferenceRow {
  user_id: string;
  org_id: string | null;
  onboarding_status: AqiOnboardingStatus;
  onboarding_seen_at: Date | null;
  onboarding_dismissed_at: Date | null;
  postponed_until: Date | null;
  tips_enabled: boolean;
  tips_quiet_until: Date | null;
  dismissed_tips: string[];
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPreferences(row: PreferenceRow | undefined): AqiPreferences {
  return {
    onboardingStatus: row?.onboarding_status ?? "not_seen",
    onboardingSeenAt: iso(row?.onboarding_seen_at ?? null),
    onboardingDismissedAt: iso(row?.onboarding_dismissed_at ?? null),
    postponedUntil: iso(row?.postponed_until ?? null),
    tipsEnabled: row?.tips_enabled ?? true,
    tipsQuietUntil: iso(row?.tips_quiet_until ?? null),
    dismissedTips: Array.isArray(row?.dismissed_tips) ? row.dismissed_tips : [],
  };
}

async function ensurePreferences(viewer: AqiViewer): Promise<PreferenceRow> {
  const orgId = viewer.org?.orgId ?? null;
  return withSystem(async (db) => {
    await db.query(
      `insert into aqi_user_preferences (user_id, org_id) values ($1, $2)
       on conflict (user_id) do update set org_id = coalesce(excluded.org_id, aqi_user_preferences.org_id), updated_at = now()`,
      [viewer.user.id, orgId],
    );
    const { rows } = await db.query<PreferenceRow>(
      `select user_id, org_id, onboarding_status, onboarding_seen_at, onboarding_dismissed_at, postponed_until,
              tips_enabled, tips_quiet_until, dismissed_tips
         from aqi_user_preferences where user_id = $1`,
      [viewer.user.id],
    );
    return rows[0];
  });
}

export async function getAqiPreferences(viewer: AqiViewer): Promise<AqiPreferences> {
  return toPreferences(await ensurePreferences(viewer));
}

export interface AqiOnboardingView {
  preferences: AqiPreferences;
  recommended: AqiTutorialSummary | null;
  shouldOffer: boolean;
  reason: "eligible" | "dismissed" | "completed" | "deferred" | "no_tutorial" | "in_progress";
}

const POSTPONE_DAYS = 7;
const QUIET_ROUTE = /^\/(chat|onboarding)(\/|$)/;

/**
 * First-time guidance is optional, server-backed and deliberately quiet: it never auto-opens the
 * overlay, never repeats after a dismissal, and never offers a walkthrough the person cannot use.
 */
export async function getAqiOnboarding(viewer: AqiViewer, pathname: string | null): Promise<AqiOnboardingView> {
  const preferences = await getAqiPreferences(viewer);
  const tutorials = await listAqiTutorialsForViewer(viewer);
  const recommended = tutorials.find((tutorial) => tutorial.slug === "getting-started") ?? tutorials[0] ?? null;
  if (!recommended) return { preferences, recommended: null, shouldOffer: false, reason: "no_tutorial" };
  if (preferences.onboardingStatus === "dismissed") return { preferences, recommended, shouldOffer: false, reason: "dismissed" };
  if (preferences.onboardingStatus === "completed") return { preferences, recommended, shouldOffer: false, reason: "completed" };
  if (preferences.onboardingStatus === "started") return { preferences, recommended, shouldOffer: false, reason: "in_progress" };
  if (preferences.onboardingStatus === "deferred" && preferences.postponedUntil && new Date(preferences.postponedUntil).getTime() > Date.now()) {
    return { preferences, recommended, shouldOffer: false, reason: "deferred" };
  }
  if (pathname && QUIET_ROUTE.test(pathname)) return { preferences, recommended, shouldOffer: false, reason: "deferred" };
  return { preferences, recommended, shouldOffer: true, reason: "eligible" };
}

export type AqiOnboardingAction = "start" | "defer" | "dismiss" | "complete" | "reset";

export async function setAqiOnboardingAction(
  viewer: AqiViewer,
  action: AqiOnboardingAction,
): Promise<{ preferences: AqiPreferences; tutorialSlug: string | null }> {
  await ensurePreferences(viewer);
  const orgId = viewer.org?.orgId ?? null;
  const tutorials = await listAqiTutorialsForViewer(viewer);
  const recommended = tutorials.find((tutorial) => tutorial.slug === "getting-started") ?? tutorials[0] ?? null;
  const postponed = new Date(Date.now() + POSTPONE_DAYS * 24 * 60 * 60 * 1000);
  const row = await withSystem(async (db) => {
    const result = await db.query<PreferenceRow>(
      `update aqi_user_preferences set
         org_id = coalesce($2::uuid, org_id),
         onboarding_status = case $3
           when 'start' then 'started'
           when 'defer' then 'deferred'
           when 'dismiss' then 'dismissed'
           when 'complete' then 'completed'
           when 'reset' then 'not_seen'
           else onboarding_status end,
         onboarding_seen_at = case when $3 in ('start','defer','dismiss','complete') then now() else onboarding_seen_at end,
         onboarding_dismissed_at = case when $3 = 'dismiss' then now() when $3 = 'reset' then null else onboarding_dismissed_at end,
         postponed_until = case when $3 = 'defer' then $4::timestamptz when $3 = 'reset' then null else postponed_until end,
         updated_at = now()
       where user_id = $1
       returning user_id, org_id, onboarding_status, onboarding_seen_at, onboarding_dismissed_at, postponed_until,
                 tips_enabled, tips_quiet_until, dismissed_tips`,
      [viewer.user.id, orgId, action, postponed],
    );
    return result.rows[0];
  });
  if (action === "start" && recommended) {
    await recordAqiGuideSignal(viewer, "guidance_accept", { slug: recommended.slug, source: "onboarding", page: null });
  }
  return { preferences: toPreferences(row), tutorialSlug: action === "start" ? recommended?.slug ?? null : null };
}

// ---------------------------------------------------------------------------
// Contextual tips
// ---------------------------------------------------------------------------

interface TipRow {
  id: string;
  slug: string;
  route_prefix: string;
  title: string;
  body: string;
  roles: string[];
  permission: string | null;
  tutorial_slug: string | null;
  priority: number;
}

export interface AqiContextualTip {
  id: string;
  slug: string;
  title: string;
  body: string;
  tutorialSlug: string | null;
  tutorialTitle: string | null;
}

export interface AqiContextualTipView {
  tip: AqiContextualTip | null;
  tipsEnabled: boolean;
  reason: "shown" | "disabled" | "dismissed" | "no_match" | "quiet" | "no_tutorial";
}

function routeMatches(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * A configured tip, matched against the current authorized page and role. No model call is made and
 * no chat text is stored. The tip is returned at most once per page visit by the browser.
 */
export async function getAqiContextualTip(viewer: AqiViewer, pathname: string | null): Promise<AqiContextualTipView> {
  const preferences = await getAqiPreferences(viewer);
  if (!preferences.tipsEnabled) return { tip: null, tipsEnabled: false, reason: "disabled" };
  if (preferences.tipsQuietUntil && new Date(preferences.tipsQuietUntil).getTime() > Date.now()) {
    return { tip: null, tipsEnabled: true, reason: "quiet" };
  }
  if (!pathname) return { tip: null, tipsEnabled: true, reason: "no_match" };
  const route = matchAqiRoute(pathname);
  if (!route || !canOpenAqiRoute(route, { can: viewer.can, agencyRole: viewer.agencyRole })) {
    return { tip: null, tipsEnabled: true, reason: "no_match" };
  }
  const clean = pathname.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  const role = viewer.org?.role ?? viewer.agencyRole ?? null;
  const rows = await withSystem(async (db) => (await db.query<TipRow>(
    `select id, slug, route_prefix, title, body, roles, permission, tutorial_slug, priority
       from aqi_contextual_tips where enabled order by priority, slug`,
  )).rows);
  const matched = rows.filter((row) => {
    if (!routeMatches(row.route_prefix, clean)) return false;
    if (row.roles.length && (!role || !row.roles.includes(role))) return false;
    if (row.permission && !viewer.can(row.permission as Permission)) return false;
    return true;
  });
  if (!matched.length) return { tip: null, tipsEnabled: true, reason: "no_match" };
  const eligible = matched.filter((row) => !preferences.dismissedTips.includes(row.slug));
  if (!eligible.length) return { tip: null, tipsEnabled: true, reason: "dismissed" };
  const tutorials = await listAqiTutorialsForViewer(viewer);
  const bySlug = new Map(tutorials.map((tutorial) => [tutorial.slug, tutorial]));
  for (const row of eligible) {
    const tutorial = row.tutorial_slug ? bySlug.get(row.tutorial_slug) : null;
    if (row.tutorial_slug && !tutorial) continue;
    return {
      tip: { id: row.id, slug: row.slug, title: row.title, body: row.body, tutorialSlug: tutorial?.slug ?? null, tutorialTitle: tutorial?.title ?? null },
      tipsEnabled: true,
      reason: "shown",
    };
  }
  return { tip: null, tipsEnabled: true, reason: "no_tutorial" };
}

export async function dismissAqiTip(viewer: AqiViewer, tipSlug: string): Promise<void> {
  const slug = tipSlug.trim().slice(0, 80);
  if (!/^[a-z0-9-]+$/.test(slug)) throw new AppError("invalid_input", "Invalid tip.");
  await ensurePreferences(viewer);
  await withSystem((db) => db.query(
    `update aqi_user_preferences set dismissed_tips = (
       select array_agg(distinct value) from unnest(dismissed_tips || $2::text[]) as value
     ), updated_at = now() where user_id = $1`,
    [viewer.user.id, [slug]],
  ));
}

export async function setAqiTipsEnabled(viewer: AqiViewer, enabled: boolean): Promise<void> {
  await ensurePreferences(viewer);
  await withSystem((db) => db.query(
    "update aqi_user_preferences set tips_enabled = $2, tips_quiet_until = null, updated_at = now() where user_id = $1",
    [viewer.user.id, enabled],
  ));
}

/** Records a tip impression at most once per tip per person per twelve hours. */
export async function recordAqiTipView(viewer: AqiViewer, tipSlug: string, pathname: string | null): Promise<void> {
  const run = async () => withSystem(async (db) => {
    const recent = await db.query(
      `select 1 from aqi_usage_events
        where user_id = $1 and kind = 'tip_view' and metadata->>'tipSlug' = $2 and created_at > now() - interval '12 hours'
        limit 1`,
      [viewer.user.id, tipSlug],
    );
    if (recent.rows[0]) return;
    await db.query(
      `insert into aqi_usage_events (org_id, user_id, kind, page_route, metadata)
       values ($1, $2, 'tip_view', $3, $4::jsonb)`,
      [viewer.org?.orgId ?? null, viewer.user.id, pathname?.slice(0, 300) ?? null, JSON.stringify({ tipSlug: tipSlug.slice(0, 80) })],
    );
  });
  await run().catch(() => undefined);
}

export async function recordAqiTipClick(viewer: AqiViewer, tipSlug: string, pathname: string | null): Promise<void> {
  await recordAqiGuideSignal(viewer, "tip_click", { tipId: tipSlug, page: pathname, source: "contextual_tip" });
}
