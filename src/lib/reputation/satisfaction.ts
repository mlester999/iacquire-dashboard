// The Satisfaction view: CSAT and NPS from the private answers customers gave, folded from grouped counts. Pure, so the same folding is tested without a database and the screen
// shows exactly what the numbers say.
//
// Rules the numbers keep:
//  * Answers a customer gave through their own link, or in a survey that knew who they were, are one group. Answers to an anonymous survey are reported on their own, never blended in.
//  * Feedback a person recorded by hand (the Retention page) or imported is not the customer's own answer on a scale, so it is counted and left out of every score.
//  * A score is shown only for enough answers (MIN_RESPONSES), in the whole view, in each week and in each segment. Below that: how many answers, and how many are needed.
//  * Public reviews never appear here: this is private feedback only, and nothing links what a person said privately to what they may have posted on a review site.
import { histogramOf, MIN_RESPONSES, summarizeCsat, summarizeNps, type CsatSummary, type FeedbackScale, type NpsSummary } from "@/lib/reputation/scores";

/** Answers grouped by scale and value, as the database returns them. */
export interface ScoreRow {
  scale: FeedbackScale;
  value: number;
  n: number;
}

export interface ScoreBlock {
  csat: CsatSummary;
  nps: NpsSummary;
}

/** CSAT and NPS for a set of grouped answers. */
export function blockFrom(rows: readonly ScoreRow[]): ScoreBlock {
  return {
    csat: summarizeCsat(histogramOf("csat5", rows.filter((r) => r.scale === "csat5"))),
    nps: summarizeNps(histogramOf("nps10", rows.filter((r) => r.scale === "nps10"))),
  };
}

/** How many answers a block holds, both scales together. */
export const answersIn = (b: ScoreBlock) => b.csat.answers + b.nps.answers;

export interface Segment {
  id: string;
  name: string;
  answers: number;
  block: ScoreBlock;
}

/** Answers by appointment type or calendar: the busiest first, ties by name, at most `limit`. Each segment gets its own gate. */
export function segmentsFrom(rows: ReadonlyArray<ScoreRow & { id: string; name: string }>, limit = 8): Segment[] {
  const by = new Map<string, { name: string; rows: ScoreRow[] }>();
  for (const r of rows) {
    const g = by.get(r.id) ?? { name: r.name, rows: [] };
    g.rows.push(r);
    by.set(r.id, g);
  }
  return [...by.entries()]
    .map(([id, g]) => {
      const block = blockFrom(g.rows);
      return { id, name: g.name, answers: answersIn(block), block };
    })
    .filter((s) => s.answers > 0)
    .sort((a, b) => b.answers - a.answers || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export interface TrendPoint {
  /** The first day of the week (YYYY-MM-DD), in the workspace's time zone. */
  week: string;
  answers: number;
  block: ScoreBlock;
}

/** Answers by week, oldest first. A week with too few answers keeps its count and shows no score. */
export function trendFrom(rows: ReadonlyArray<ScoreRow & { week: string }>): TrendPoint[] {
  const by = new Map<string, ScoreRow[]>();
  for (const r of rows) by.set(r.week, [...(by.get(r.week) ?? []), r]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, list]) => {
      const block = blockFrom(list);
      return { week, answers: answersIn(block), block };
    });
}

/** The Satisfaction view for one period, as the server builds it. Every score in it is already gated. */
export interface SatisfactionReport {
  days: number;
  since: string;
  /** Answers through a customer's own link, or in a survey that knew who they were. */
  named: ScoreBlock;
  /** Answers to a survey that knew nobody, reported on their own. */
  anonymous: ScoreBlock;
  /** Feedback recorded by hand or imported in the period: counted, never scored. */
  handRecorded: number;
  /** How many of the requests that went out got an answer, for review requests and for surveys. */
  response: { review: ResponseShare; survey: ResponseShare };
  trend: TrendPoint[];
  byAppointmentType: Segment[];
  byCalendar: Segment[];
  followUp: {
    /** Low feedback nobody has resolved yet, now. */
    open: number;
    /** Of those, not acknowledged within the workspace's time. */
    overdue: number;
    acknowledgeWithinHours: number;
    /** Low feedback in the period that someone acknowledged, and the median wait; the wait is null until there are enough to judge. */
    acknowledged: number;
    medianHoursToAcknowledge: number | null;
  };
}

export interface ResponseShare {
  sent: number;
  answered: number;
  /** Shown only when enough requests went out for a percentage to mean something. */
  percent: number | null;
}

/** How many of the requests that went out got an answer. Always the counts; a percentage only for enough requests. */
export function responseShare(sent: number, answered: number): ResponseShare {
  const a = Math.min(answered, sent);
  return { sent, answered: a, percent: sent >= MIN_RESPONSES.csat5 ? Math.round((a / sent) * 100) : null };
}

/** The fewest low-feedback follow-ups to judge how fast the team acknowledges them. Fewer than this and only the count is shown. */
export const MIN_ACKNOWLEDGED_SAMPLE = 5;

/** Hours in the words a person says them: "under an hour", "6 hours", "3 days". */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "";
  if (hours < 1) return "under an hour";
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const d = Math.round(hours / 24);
  return `${d} days`;
}
