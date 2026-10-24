// What the Messages screens decide, kept apart from React so each rule can be tested without a browser: how the rail is sectioned and read aloud, how a conversation is laid
// out in days and in runs by one author, how a page of messages joins what is already loaded, and how files and conversations are addressed. Pure: the clock is passed in.

import type { ChannelVisibility, ConversationKind } from "@/lib/staff-messages/conversations";
import { formatBytes } from "@/lib/utils";

export const MESSAGES_HOME = "/admin/messages";
export const FILE_ROUTE = "/api/admin/messages/files";

export const conversationHref = (conversationId: string): string => `${MESSAGES_HOME}/${conversationId}`;
/** Where a file comes out. By id only: the server checks the person is in the conversation the file was sent in. */
export const downloadHref = (attachmentId: string): string => `${FILE_ROUTE}/${attachmentId}`;

export const attachmentLabel = (file: { filename: string; sizeBytes: number }): string => `${file.filename}, ${formatBytes(file.sizeBytes)}`;

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

/** One row of the rail (the server's RailItem has exactly these fields). */
export interface RailEntry {
  id: string;
  kind: ConversationKind;
  visibility: ChannelVisibility;
  /** The conversation's name; for a direct message, the other person's. */
  name: string;
  topic: string | null;
  archived: boolean;
  lastSeq: number;
  lastReadSeq: number;
  unread: number;
  muted: boolean;
  notify: "all" | "mentions" | "none";
  lastMessageAt: string | null;
  memberCount: number;
  peer: { id: string; name: string; former: boolean } | null;
}

export type RailFilter = "all" | "unread";
export type RailSectionKey = "direct" | "group" | "channel" | "archived";

export interface RailSection {
  key: RailSectionKey;
  label: string;
  entries: RailEntry[];
}

const SECTIONS: ReadonlyArray<{ key: RailSectionKey; label: string }> = [
  { key: "direct", label: "Direct messages" },
  { key: "group", label: "Groups" },
  { key: "channel", label: "Channels" },
  { key: "archived", label: "Archived" },
];

/** What the rail calls a conversation: a channel with a # in front, everything else as it is named. */
export function railTitle(entry: Pick<RailEntry, "kind" | "name">): string {
  if (!entry.name) return "Unnamed conversation";
  return entry.kind === "channel" ? `#${entry.name}` : entry.name;
}

/** The rail in four sections, each in the order the server sent (newest activity first); a section with nothing in it is left out. */
export function railSections(entries: readonly RailEntry[], opts: { filter: RailFilter; query: string }): RailSection[] {
  const needle = opts.query.trim().toLowerCase();
  const buckets: Record<RailSectionKey, RailEntry[]> = { direct: [], group: [], channel: [], archived: [] };
  for (const e of entries) {
    if (opts.filter === "unread" && e.unread === 0) continue;
    if (needle && !railTitle(e).toLowerCase().includes(needle)) continue;
    buckets[e.archived ? "archived" : e.kind].push(e);
  }
  return SECTIONS.filter((s) => buckets[s.key].length > 0).map((s) => ({ key: s.key, label: s.label, entries: buckets[s.key] }));
}

/** The unread count in words for a screen reader (the badge itself shows a number, or 99+). */
export function unreadAria(unread: number, muted: boolean): string {
  const text = unread <= 0 ? "No unread messages" : unread === 1 ? "1 unread message" : unread > 99 ? "More than 99 unread messages" : `${unread} unread messages`;
  return muted ? `${text}, muted` : text;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

function formatterFor(timeZone: string, options: Intl.DateTimeFormatOptions, locale = "en-US"): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
  }
}

/** The calendar day of a moment in the person's time zone, as YYYY-MM-DD (empty for a date that is not one). */
export function dayKey(at: Date | string | number, timeZone: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return formatterFor(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA").format(d);
}

/** The day before a YYYY-MM-DD, by the calendar (not by subtracting 24 hours, which is wrong twice a year). */
function previousDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** "Today", "Yesterday", or a short date (with the year when it is not this one), in the person's time zone. */
export function dayLabel(at: Date | string | number, now: Date | number, timeZone: string): string {
  const key = dayKey(at, timeZone);
  if (!key) return "";
  const today = dayKey(now, timeZone);
  if (key === today) return "Today";
  if (today && key === previousDay(today)) return "Yesterday";
  const sameYear = today.slice(0, 4) === key.slice(0, 4);
  return formatterFor(timeZone, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(new Date(at));
}

// ---------------------------------------------------------------------------
// A conversation laid out
// ---------------------------------------------------------------------------

export interface TimelineMessage {
  id: string;
  seq: number;
  authorId: string | null;
  createdAt: string;
  deleted: boolean;
}

export type TimelineItem<T extends TimelineMessage> =
  | { type: "day"; key: string; label: string }
  | { type: "unread"; key: string }
  | { type: "message"; key: string; message: T; /** True when the author's name and time are written above it (the first of a run). */ header: boolean };

/** A run of messages by one person stays together while each follows the last within this many minutes. */
export const RUN_MINUTES = 5;

/**
 * The messages with a day heading before each new day, one marker above the first message after `afterSeq` (what the person had read when they opened the conversation), and
 * `header` true on the first of each run by one author. Every message appears exactly once, in the order given.
 */
export function timeline<T extends TimelineMessage>(messages: readonly T[], opts: { now: Date | number; timeZone: string; afterSeq: number | null; runMinutes?: number }): Array<TimelineItem<T>> {
  const out: Array<TimelineItem<T>> = [];
  const runMs = (opts.runMinutes ?? RUN_MINUTES) * 60_000;
  let previous: T | null = null;
  let day = "";
  let marked = false;
  for (const message of messages) {
    const thisDay = dayKey(message.createdAt, opts.timeZone);
    const newDay = thisDay !== day;
    if (newDay) {
      day = thisDay;
      out.push({ type: "day", key: `day:${thisDay}:${message.id}`, label: dayLabel(message.createdAt, opts.now, opts.timeZone) });
    }
    let afterMarker = false;
    if (!marked && opts.afterSeq !== null && message.seq > opts.afterSeq) {
      marked = true;
      afterMarker = true;
      out.push({ type: "unread", key: "unread" });
    }
    const sameRun =
      previous !== null && !newDay && !afterMarker && !previous.deleted && !message.deleted && message.authorId !== null && message.authorId === previous.authorId &&
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <= runMs;
    out.push({ type: "message", key: message.id, message, header: !sameRun });
    previous = message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** The newest page replaces everything from its first message on (the server is the authority for what exists there); older messages loaded earlier stay. */
export function mergeLatest<T extends { seq: number }>(loaded: readonly T[], latest: readonly T[]): T[] {
  if (latest.length === 0) return [];
  const first = latest[0].seq;
  return [...loaded.filter((m) => m.seq < first), ...latest];
}

/** An older page goes above what is loaded; anything in it that is not older than the first loaded message is left out. */
export function mergeOlder<T extends { seq: number }>(loaded: readonly T[], older: readonly T[]): T[] {
  if (loaded.length === 0) return [...older];
  const first = loaded[0].seq;
  return [...older.filter((m) => m.seq < first), ...loaded];
}
