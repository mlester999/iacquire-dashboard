// Public reviews read from a review site: the labels, the honest state of each site's connection, and the few numbers computed from what was read. Pure: the server and the
// screens use the same functions, and the tests check them without a database.
//
// Rules that hold here: a number is computed from the reviews actually stored, and always shown with how many that is, where it came from and when it was read; what the site
// itself says about its totals is kept apart and shown beside it, never merged into it; and nothing here says why a review exists or claims that a request for a review
// produced one.

export const REVIEW_PROVIDERS = ["google", "facebook"] as const;
export type ReviewProvider = (typeof REVIEW_PROVIDERS)[number];
export const isReviewProvider = (v: unknown): v is ReviewProvider => typeof v === "string" && (REVIEW_PROVIDERS as readonly string[]).includes(v);
export const PROVIDER_LABELS: Record<ReviewProvider, string> = { google: "Google", facebook: "Facebook" };
/** What the site calls a review: Facebook's are recommendations. */
export const PROVIDER_REVIEW_WORD: Record<ReviewProvider, string> = { google: "review", facebook: "recommendation" };

export type ConnectionStatus = "connected" | "needs_reauth" | "error" | "revoked" | "disconnected";

export type ProviderState = "unavailable" | "available_not_connected" | "connected" | "needs_reauth" | "error" | "revoked" | "needs_permission";
export type Tone = "neutral" | "primary" | "success" | "warning" | "danger";

export interface ProviderFacts {
  provider: ReviewProvider;
  /** Reading this site is switched on and set up in this environment. */
  environmentReady: boolean;
  /** Plain words for what is missing when it is not, without any setting name. */
  missing: string | null;
  /** Facebook only: a Page is connected for Social media in this workspace. */
  pageConnected?: boolean;
  /** Facebook only: that Page was not given permission to read recommendations. */
  pageLacksPermission?: boolean;
  /** The workspace's live (not disconnected) connection to this site, when there is one. */
  connection: { status: Exclude<ConnectionStatus, "disconnected">; statusDetail: string | null; name: string; simulated: boolean } | null;
  /** The simulated stand-in may be offered in this environment (never in production). */
  simulatedAllowed: boolean;
}

export interface ProviderStateView {
  state: ProviderState;
  label: string;
  tone: Tone;
  /** What this means for the person, and what to do, in plain words. */
  detail: string;
  /** A real connection can be started from here. */
  canConnect: boolean;
}

const STATE_LABELS: Record<ProviderState, string> = {
  unavailable: "Not available yet",
  available_not_connected: "Not connected",
  connected: "Connected",
  needs_reauth: "Needs to be reconnected",
  error: "Problem reading it",
  revoked: "Access was removed",
  needs_permission: "Needs more permission",
};
const STATE_TONES: Record<ProviderState, Tone> = { unavailable: "neutral", available_not_connected: "neutral", connected: "success", needs_reauth: "warning", error: "danger", revoked: "warning", needs_permission: "warning" };

/** The honest state of one review site for one workspace. Never "connected" unless a connection exists and its last check said so. */
export function providerState(f: ProviderFacts): ProviderStateView {
  const site = PROVIDER_LABELS[f.provider];
  const view = (state: ProviderState, detail: string, canConnect = false): ProviderStateView => ({ state, label: STATE_LABELS[state], tone: STATE_TONES[state], detail, canConnect });
  const c = f.connection;
  if (c) {
    if (c.status === "connected") return view("connected", `Reading ${site} reviews for ${c.name}.${c.simulated ? " This is a test connection: the reviews are samples, not real." : ""}`);
    if (c.status === "needs_reauth") return view("needs_reauth", c.statusDetail ?? `${site} no longer accepts the saved sign-in. Reconnect it to read reviews again.`, f.environmentReady);
    if (c.status === "revoked") return view("revoked", c.statusDetail ?? `Access to ${site} was removed on their side. Reconnect it to read reviews again.`, f.environmentReady);
    return view("error", c.statusDetail ?? `${site} could not be read the last time it was tried. It is tried again automatically.`);
  }
  if (!f.environmentReady) {
    return view("unavailable", f.missing ?? `Reading ${site} reviews isn't set up for iAcquire yet, so nothing can be connected. Your ${site} review link still works as usual.`);
  }
  if (f.provider === "facebook") {
    if (!f.pageConnected) return view("available_not_connected", "Connect your Facebook Page in Social media first. iAcquire reads recommendations through that connection, so there is no second sign-in.");
    if (f.pageLacksPermission) return view("needs_permission", "Your Facebook Page is connected for posting, but it hasn't been given permission to read recommendations. Reconnect the Page in Social media and allow the extra access.");
    return view("available_not_connected", "Your Facebook Page is connected. Choose to read its recommendations.", true);
  }
  return view("available_not_connected", `Connect your ${site} Business Profile location to read its reviews here.`, true);
}

// ---------------------------------------------------------------------------
// A review, in words
// ---------------------------------------------------------------------------

export function ratingText(rating: number | null, recommends: boolean | null): string {
  if (rating !== null) return `${rating} of 5 stars`;
  if (recommends === true) return "Recommends";
  if (recommends === false) return "Doesn't recommend";
  return "No rating";
}

/** A review the team should hear about: at or below the workspace's star level, or a recommendation withdrawn. */
export function isLowPublicReview(r: { rating: number | null; recommends: boolean | null }, alertAtOrBelow: number): boolean {
  if (r.rating !== null) return r.rating <= alertAtOrBelow;
  return r.recommends === false;
}

export const REVIEW_FILTERS = ["all", "needs_reply", "low", "replied", "removed"] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];
export const REVIEW_FILTER_LABELS: Record<ReviewFilter, string> = { all: "All", needs_reply: "Needs a reply", low: "Low ratings", replied: "Replied", removed: "Removed from the site" };
export const isReviewFilter = (v: unknown): v is ReviewFilter => typeof v === "string" && (REVIEW_FILTERS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Numbers computed from what was read
// ---------------------------------------------------------------------------

export interface MirrorRow {
  rating: number | null;
  recommends: boolean | null;
  removed: boolean;
}

export interface MirrorSummary {
  /** Reviews stored that the site still returns. */
  live: number;
  /** Reviews stored that the site no longer returns. */
  removed: number;
  /** Live reviews with a star rating, and their average to one decimal; null when there are none (never a made-up zero). */
  rated: number;
  average: number | null;
  byRating: Record<1 | 2 | 3 | 4 | 5, number>;
  recommended: number;
  notRecommended: number;
}

export function summarizeMirror(rows: readonly MirrorRow[]): MirrorSummary {
  const byRating: MirrorSummary["byRating"] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let live = 0, removed = 0, rated = 0, sum = 0, recommended = 0, notRecommended = 0;
  for (const r of rows) {
    if (r.removed) {
      removed += 1;
      continue;
    }
    live += 1;
    if (r.rating !== null && r.rating >= 1 && r.rating <= 5) {
      rated += 1;
      sum += r.rating;
      byRating[r.rating as 1 | 2 | 3 | 4 | 5] += 1;
    } else if (r.recommends === true) recommended += 1;
    else if (r.recommends === false) notRecommended += 1;
  }
  return { live, removed, rated, average: rated ? Math.round((sum / rated) * 10) / 10 : null, byRating, recommended, notRecommended };
}

/** What the site says it has, set beside what was read. Nothing is added together and neither number stands in for the other. */
export function syncedAgainstReported(site: string, word: string, read: number, reportedCount: number | null): string {
  const plural = (n: number) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (reportedCount === null) return `${plural(read)} read. ${site} doesn't report a total.`;
  if (read === reportedCount) return `${plural(read)} read, the same as ${site} reports.`;
  if (read < reportedCount) return `${site} reports ${plural(reportedCount)}; ${read} read so far.`;
  return `${plural(read)} read; ${site} now reports ${reportedCount}. Some have been removed on the site since.`;
}

export interface WeekBucket {
  /** The Monday (UTC) the week starts, as YYYY-MM-DD. */
  weekStart: string;
  count: number;
}

const mondayOf = (d: Date) => {
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = new Date(t).getUTCDay();
  return t - ((day + 6) % 7) * 86_400_000;
};

/** New reviews per week for the last `weeks` weeks, oldest first, every week present (a quiet week counts zero). All causes: nothing here says what produced a review. */
export function weeklyCounts(dates: ReadonlyArray<string | Date | null>, now: Date, weeks = 12): WeekBucket[] {
  const last = mondayOf(now);
  const buckets = Array.from({ length: weeks }, (_, i) => ({ start: last - (weeks - 1 - i) * 7 * 86_400_000, count: 0 }));
  for (const d of dates) {
    if (!d) continue;
    const t = new Date(d);
    if (Number.isNaN(t.getTime())) continue;
    const start = mondayOf(t);
    const b = buckets.find((x) => x.start === start);
    if (b) b.count += 1;
  }
  return buckets.map((b) => ({ weekStart: new Date(b.start).toISOString().slice(0, 10), count: b.count }));
}

/** How long ago a time was, in the largest sensible unit, for "read 3 hours ago". */
export function agoText(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86_400)} days ago`;
}
