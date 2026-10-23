// What a private feedback score means, and when it needs a person. Pure: no I/O, so the server, the screens and the tests use the same rules.
//
// A low score only ever ADDS something (a private follow-up for the team). It never changes who is asked for a review, which review links a customer sees, or
// what the customer is told to do before posting one (see docs/roadmap/phases-3-to-7/audit/5fg-reputation-retention.md, rules R1 to R3).

/** csat5: one to five (the page's rating buttons). nps10: zero to ten ("how likely are you to recommend us"). */
export const FEEDBACK_SCALES = ["csat5", "nps10"] as const;
export type FeedbackScale = (typeof FEEDBACK_SCALES)[number];
export const isFeedbackScale = (v: unknown): v is FeedbackScale => typeof v === "string" && (FEEDBACK_SCALES as readonly string[]).includes(v);

export interface ScoreThresholds {
  /** A one-to-five rating at or below this needs a follow-up. */
  escalateAtOrBelow: number;
  /** A zero-to-ten score at or below this (a "detractor") needs a follow-up. */
  npsDetractorMax: number;
}

/** The standing defaults: 2 of 5, and the usual detractor band of 0 to 6. Both are per-workspace settings (reputation_settings). */
export const DEFAULT_THRESHOLDS: ScoreThresholds = { escalateAtOrBelow: 2, npsDetractorMax: 6 };

/** The ranges a workspace may choose from. The database checks the same ranges. */
export const THRESHOLD_LIMITS = {
  escalateAtOrBelow: { min: 1, max: 3 },
  npsDetractorMax: { min: 4, max: 7 },
} as const;

/**
 * Whether one score is low enough to need a person. A missing score is never low: a comment on its own is judged by what it says, not by a number it
 * does not have (see the feedback service). Decided once, when the feedback arrives, and stored; changing a threshold later does not rewrite history.
 */
export function isLowScore(scale: FeedbackScale, value: number | null | undefined, thresholds: ScoreThresholds = DEFAULT_THRESHOLDS): boolean {
  if (value === null || value === undefined || !Number.isInteger(value)) return false;
  if (scale === "csat5") return value >= 1 && value <= thresholds.escalateAtOrBelow;
  return value >= 0 && value <= thresholds.npsDetractorMax;
}

/** The score the customer gave, whichever scale it was on, in words for a team member ("2 of 5", "6 of 10"). */
export function describeScore(scale: FeedbackScale, value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return scale === "csat5" ? `${value} of 5` : `${value} of 10`;
}

/** What a request asks: a review request (the private form beside the public links) or a satisfaction survey (the same page; its questions are the point). */
export const REQUEST_KINDS = ["review", "survey"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const isRequestKind = (v: unknown): v is RequestKind => typeof v === "string" && (REQUEST_KINDS as readonly string[]).includes(v);

/** The whole numbers each scale accepts. */
export const SCALE_RANGE = { csat5: { min: 1, max: 5 }, nps10: { min: 0, max: 10 } } as const;

/**
 * A score from a form field, judged on the scale the request was made with: a whole number in that scale's range, null when nothing was chosen, or "invalid". Which scale
 * applies is decided by the request on the server, never by the form, so a posted 7 on a one-to-five request is refused.
 */
export function parseScore(scale: FeedbackScale, v: unknown): number | null | "invalid" {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,2}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  const { min, max } = SCALE_RANGE[scale];
  return Number.isInteger(n) && n >= min && n <= max ? n : "invalid";
}

// ---------------------------------------------------------------------------
// Scores over many answers: CSAT and NPS, never shown for a handful of answers
// ---------------------------------------------------------------------------

/**
 * The fewest answers before a score is shown at all. A satisfaction percentage from three answers is noise that reads like a fact, so below these the screens say how many
 * answers there are and how many are needed. Both numbers are proposals the owner of the product confirms.
 */
export const MIN_RESPONSES = { csat5: 10, nps10: 30 } as const;

/** The standard Net Promoter bands. They are fixed: the workspace's own follow-up level (nps_detractor_max) decides who gets a follow-up, not how the score is reported. */
export const NPS_BANDS = { promoterMin: 9, passiveMin: 7 } as const;
export type NpsBand = "promoter" | "passive" | "detractor";
export const npsBand = (score: number): NpsBand => (score >= NPS_BANDS.promoterMin ? "promoter" : score >= NPS_BANDS.passiveMin ? "passive" : "detractor");

/** Counts of answers by value: index = value - 1 for a one-to-five scale (length 5), index = value for a zero-to-ten scale (length 11). */
export type Histogram = number[];

/** A histogram from rows of (value, how many). A value outside the scale is ignored, never counted. */
export function histogramOf(scale: FeedbackScale, rows: ReadonlyArray<{ value: number; n: number }>): Histogram {
  const { min, max } = SCALE_RANGE[scale];
  const h: Histogram = new Array(max - min + 1).fill(0);
  for (const r of rows) if (Number.isInteger(r.value) && r.value >= min && r.value <= max && r.n > 0) h[r.value - min] += r.n;
  return h;
}

export interface CsatSummary {
  answers: number;
  /** Answers of 4 or 5. */
  satisfied: number;
  /** The share of answers that were 4 or 5, 0 to 100; null until there are enough answers. */
  percent: number | null;
  /** The mean, one decimal; null until there are enough answers. */
  average: number | null;
  enough: boolean;
  needed: number;
}

/** CSAT: the share of answers that were 4 or 5 out of 5, shown only when there are enough answers. */
export function summarizeCsat(h: Histogram): CsatSummary {
  const answers = h.slice(0, 5).reduce((a, b) => a + b, 0);
  const satisfied = (h[3] ?? 0) + (h[4] ?? 0);
  const enough = answers >= MIN_RESPONSES.csat5;
  const total = h.slice(0, 5).reduce((a, n, i) => a + n * (i + 1), 0);
  return {
    answers, satisfied, enough, needed: MIN_RESPONSES.csat5,
    percent: enough ? Math.round((satisfied / answers) * 100) : null,
    average: enough ? Math.round((total / answers) * 10) / 10 : null,
  };
}

export interface NpsSummary {
  answers: number;
  promoters: number;
  passives: number;
  detractors: number;
  /** Promoters minus detractors as a share of all answers, -100 to 100; null until there are enough answers. */
  score: number | null;
  enough: boolean;
  needed: number;
}

/** NPS: the share of promoters (9 or 10) minus the share of detractors (0 to 6), shown only when there are enough answers. */
export function summarizeNps(h: Histogram): NpsSummary {
  const at = (from: number, to: number) => h.slice(from, to + 1).reduce((a, b) => a + b, 0);
  const promoters = at(NPS_BANDS.promoterMin, 10);
  const passives = at(NPS_BANDS.passiveMin, NPS_BANDS.promoterMin - 1);
  const detractors = at(0, NPS_BANDS.passiveMin - 1);
  const answers = promoters + passives + detractors;
  const enough = answers >= MIN_RESPONSES.nps10;
  return { answers, promoters, passives, detractors, enough, needed: MIN_RESPONSES.nps10, score: enough ? Math.round(((promoters - detractors) / answers) * 100) : null };
}

/** What to say instead of a score: how many answers there are and how many are needed. Never a number that looks like a result. */
export function tooFewText(answers: number, needed: number): string {
  if (answers === 0) return `No answers yet. A score appears after ${needed}.`;
  return `${answers} ${answers === 1 ? "answer" : "answers"} so far: too few for a score. It appears after ${needed}.`;
}
