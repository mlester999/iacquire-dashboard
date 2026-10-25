// Pure rules for a maintenance plan's renewal: when the team and the client are reminded that the paid period is ending, when it counts as ended with no payment recorded, and
// how old a checkout nobody completed has to be before it is closed. No server or database code, so a component may import it. The numbers here are PROPOSALS the founder
// confirms; each is one constant. Nothing in this file decides that money arrived or did not: only a person recording a payment, or a provider's signed notice, does that.

/** The client and the team are reminded this many days before the day a plan is paid through (the closest reminder that applies; one of each per paid period). */
export const RENEWAL_NOTICE_DAYS = [7, 1] as const;
export type RenewalNoticeLevel = (typeof RENEWAL_NOTICE_DAYS)[number];

/**
 * When the switch is on, a plan is marked past due only once its paid period ended at least this many days ago. The team is told as soon as the sweep sees the period has ended
 * (normally the first day after), so in normal running a payment recorded the next morning is never marked missed. After a long scheduler outage the notice and the marking can
 * come in the same pass.
 */
export const AUTO_PAST_DUE_MIN_DAYS_OVER = 2;

/** A period that ended longer ago than this is left to the team's own list: it was announced on the first day and is not announced again. */
export const OVERDUE_NOTICE_WINDOW_DAYS = 60;

/** A pending checkout older than this is closed, so a second setup checkout is not blocked for ever by an abandoned one. A payment that arrives for it later is still recorded. */
export const STALE_CHECKOUT_HOURS = 48;

/** The most time the renewal sweep spends in one tick (the tick is cut off at 120 seconds), and how many rows it takes at a time. */
export const RENEWAL_SWEEP_BUDGET_MS = 30_000;
export const RENEWAL_SWEEP_BATCH = 100;

const DAY_MS = 86_400_000;
const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

/** Whole days from `today` to the day a plan is paid through (both YYYY-MM-DD): 0 on that day, negative once it has passed. Null for a value that is not a date. */
export function daysUntil(throughOn: string | null | undefined, today: string): number | null {
  if (!throughOn || !isDay(throughOn) || !isDay(today)) return null;
  return Math.round((Date.parse(`${throughOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/** Which reminder applies when `daysLeft` days remain (null: none yet, or the period has ended). 7 days out up to 2 days out reads 7; 1 day out and the day itself read 1. */
export function renewalNoticeLevel(daysLeft: number | null): RenewalNoticeLevel | null {
  if (daysLeft === null || daysLeft < 0 || daysLeft > RENEWAL_NOTICE_DAYS[0]) return null;
  return daysLeft <= RENEWAL_NOTICE_DAYS[1] ? RENEWAL_NOTICE_DAYS[1] : RENEWAL_NOTICE_DAYS[0];
}

export type RenewalStep =
  | { kind: "none" }
  | { kind: "notice"; level: RenewalNoticeLevel; daysLeft: number }
  | { kind: "overdue"; daysOver: number; markPastDue: boolean };

/**
 * What the sweep does for one plan today. Only a plan that is active and has a paid-through day takes part: a requested plan has not started, a past due one is already being
 * handled, and a plan whose cancellation is waiting for the team is about to end. "Overdue" means the paid-through day has passed and no payment moved it forward (a recorded
 * payment always moves it), and it marks the plan past due only when the switch is on AND the period ended AUTO_PAST_DUE_MIN_DAYS_OVER or more days ago.
 */
export function renewalStep(input: { status: string; paidThroughOn: string | null; today: string; autoPastDue: boolean }): RenewalStep {
  if (input.status !== "active") return { kind: "none" };
  const left = daysUntil(input.paidThroughOn, input.today);
  if (left === null) return { kind: "none" };
  if (left < 0) {
    const daysOver = -left;
    if (daysOver > OVERDUE_NOTICE_WINDOW_DAYS) return { kind: "none" };
    return { kind: "overdue", daysOver, markPastDue: input.autoPastDue && daysOver >= AUTO_PAST_DUE_MIN_DAYS_OVER };
  }
  const level = renewalNoticeLevel(left);
  return level === null ? { kind: "none" } : { kind: "notice", level, daysLeft: left };
}

/** True when a plan that is active (or about to be cancelled) was paid through a day before `today`. For display; it changes nothing by itself. */
export function paidPeriodEnded(status: string | null | undefined, paidThroughOn: string | null | undefined, today: string): boolean {
  if (status !== "active" && status !== "cancel_requested") return false;
  const left = daysUntil(paidThroughOn, today);
  return left !== null && left < 0;
}

/** The instant before which a pending checkout counts as stale. */
export const staleCheckoutCutoff = (now: Date) => new Date(now.getTime() - STALE_CHECKOUT_HOURS * 3_600_000);

/** A YYYY-MM-DD day plus whole days (negative allowed), in the same form. Null for a value that is not a date. */
export function addDays(day: string, n: number): string | null {
  if (!isDay(day) || !Number.isInteger(n)) return null;
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The plain sentence the team and the client read for the days left. */
export function renewalWhen(daysLeft: number): string {
  if (daysLeft <= 0) return "today";
  if (daysLeft === 1) return "tomorrow";
  return `in ${daysLeft} days`;
}

/** A YYYY-MM-DD day plus whole calendar months, keeping the day of the month and clamping to the last day of a shorter month (31 January plus one month is 28 or 29 February). */
export function addMonths(day: string, n: number): string | null {
  if (!isDay(day) || !Number.isInteger(n)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, last))).toISOString().slice(0, 10);
}

/**
 * The last day a payment covering `months` months runs through. A plan that is paid through a day that has not passed yet continues from the next day, so paying early never
 * loses the days already paid for; a plan that is requested, past due, expired or whose paid period ended starts the new period today. The period is the months from its first day to
 * the day before the same day-of-month that many months later. Null for months outside 1 to 12 or a date that is not a date.
 */
export function nextPaidThrough(input: { status: string; paidThroughOn: string | null; today: string; months: number }): string | null {
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > 12 || !isDay(input.today)) return null;
  const continuing = (input.status === "active" || input.status === "cancel_requested") && input.paidThroughOn !== null && isDay(input.paidThroughOn) && input.paidThroughOn >= input.today;
  const start = continuing ? addDays(input.paidThroughOn as string, 1) : input.today;
  if (!start) return null;
  const next = addMonths(start, input.months);
  return next ? addDays(next, -1) : null;
}
