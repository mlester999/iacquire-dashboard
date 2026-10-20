/**
 * Date presentation for the chat history list. Everything is a pure function of (timestamp, now, time zone) so the
 * server render and the browser agree: the page passes the server's `now`, and the browser only moves it forward after
 * mount.
 */

export const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"] as const;
export type ConversationGroup = (typeof GROUP_ORDER)[number];

const DAY_MS = 86_400_000;

function safeZone(timeZone: string | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** The calendar day of an instant in a time zone, as a day number (days since 1970-01-01 in that zone). */
function dayNumber(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.floor(Date.UTC(get("year"), get("month") - 1, get("day")) / DAY_MS);
}

/** Whole calendar days between two instants in a time zone (0 = same day). Future instants count as today. */
export function calendarDaysAgo(iso: string, now: Date, timeZone?: string): number {
  const zone = safeZone(timeZone);
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, dayNumber(now, zone) - dayNumber(then, zone));
}

export function conversationGroup(iso: string, now: Date, timeZone?: string): ConversationGroup {
  const days = calendarDaysAgo(iso, now, timeZone);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return "Older";
}

/** Groups in display order, keeping the incoming (most recent first) order inside each group. */
export function groupConversations<T extends { lastMessageAt: string }>(items: readonly T[], now: Date, timeZone?: string): Array<[ConversationGroup, T[]]> {
  const buckets = new Map<ConversationGroup, T[]>();
  for (const item of items) {
    const group = conversationGroup(item.lastMessageAt, now, timeZone);
    buckets.set(group, [...(buckets.get(group) ?? []), item]);
  }
  return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => [g, buckets.get(g)!]);
}

/** "now", "5m", "3h", "2d", "3w", then "Sep 12" (with the year once it is not this year). */
export function compactRelativeTime(iso: string, now: Date, timeZone?: string): string {
  const then = new Date(iso);
  const diff = now.getTime() - then.getTime();
  if (Number.isNaN(then.getTime()) || diff < 45_000) return "now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(diff / DAY_MS);
  if (days < 7) return `${days}d`;
  if (days < 35) return `${Math.floor(days / 7)}w`;
  const zone = safeZone(timeZone);
  const sameYear = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" }).format(then) === new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" }).format(now);
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(then);
}

/** The full local date and time, for a tooltip or `title`. */
export function fullTimestamp(iso: string, timeZone?: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: safeZone(timeZone), dateStyle: "medium", timeStyle: "short" }).format(then);
}
