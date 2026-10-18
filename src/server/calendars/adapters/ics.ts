import "server-only";
import { publicRequest } from "@/server/calendars/adapters/http";
import { expandCalendar, IcsParseError, parseIcs } from "@/server/calendars/adapters/ical";
import { CalendarProviderError, kindForStatus, type BusyInterval, type BusyQuery, type BusyResult, type CalendarAdapter, type RemoteCalendar } from "@/server/calendars/adapters/types";

// Read-only ICS feeds ("subscribe by URL", RFC 5545 over HTTPS). A feed is polled, never pushed: changes show up at the next poll, and
// nothing is ever written back. The feed address is often a secret (a private iCal link), so it is stored encrypted and never shown
// again after it is saved. Requests use If-None-Match with the last ETag so an unchanged feed costs one short response.

export const FEED_CALENDAR_ID = "feed";
export const ICS_MAX_BYTES = 5_000_000;

/** webcal:// is the same feed over HTTPS. Anything other than https is refused. */
export function normalizeFeedUrl(raw: string): string {
  const trimmed = raw.trim();
  const candidate = /^webcals?:\/\//i.test(trimmed) ? trimmed.replace(/^webcals?:\/\//i, "https://") : trimmed;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    throw new CalendarProviderError("invalid", "That doesn't look like a calendar address. It should start with https://.");
  }
  if (u.protocol !== "https:") throw new CalendarProviderError("forbidden", "Only https:// calendar addresses are supported.", { code: "unsafe_address" });
  u.hash = "";
  return u.toString();
}

export interface FeedFetch {
  /** Null when the server said the feed is unchanged (304). */
  text: string | null;
  etag: string | null;
}

export async function fetchFeed(url: string, etag: string | null): Promise<FeedFetch> {
  const res = await publicRequest(url, { headers: { Accept: "text/calendar, text/plain;q=0.8, */*;q=0.5", ...(etag ? { "If-None-Match": etag } : {}) }, maxBytes: ICS_MAX_BYTES }, "The calendar feed");
  if (res.status === 304) return { text: null, etag };
  if (res.status === 401 || res.status === 403) throw new CalendarProviderError("auth", "The calendar feed refused access. The link may have been reset; copy the current one.", { status: res.status });
  if (res.status < 200 || res.status >= 300) throw new CalendarProviderError(kindForStatus(res.status), `The calendar feed answered HTTP ${res.status}.`, { status: res.status });
  if (!/^\s*BEGIN:VCALENDAR/i.test(res.text.replace(/^﻿/, ""))) throw new CalendarProviderError("invalid", "That address didn't return a calendar (iCalendar) file.");
  return { text: res.text, etag: res.headers.get("etag")?.slice(0, 300) ?? null };
}

/** Fetches and reads a feed once, as the test before saving it: it must parse and contain a calendar. */
export async function testFeed(url: string, timeZone: string, now = new Date()): Promise<{ events: number; name: string | null }> {
  const f = await fetchFeed(url, null);
  try {
    const roots = parseIcs(f.text ?? "");
    const cal = roots.find((r) => r.name === "VCALENDAR");
    if (!cal) throw new CalendarProviderError("invalid", "That address didn't return a calendar (iCalendar) file.");
    const r = expandCalendar(roots, { from: now.getTime(), to: now.getTime() + 62 * 86_400_000, defaultTimeZone: timeZone });
    const name = cal.props.find((p) => p.name === "X-WR-CALNAME")?.value.trim().slice(0, 120) || null;
    return { events: r.events, name };
  } catch (err) {
    if (err instanceof IcsParseError) throw new CalendarProviderError("invalid", err.message);
    throw err;
  }
}

export function icsAdapter(url: string, label: string): CalendarAdapter {
  const calendar: RemoteCalendar = { id: FEED_CALENDAR_ID, name: label, primary: true, canWrite: false, timezone: null, meetings: [] };
  return {
    provider: "ics",
    listCalendars: async () => [calendar],
    async readBusy(_auth, q: BusyQuery): Promise<BusyResult> {
      const counts = { calendars: 1, events: 0, busy: 0, ownSkipped: 0, free: 0, unsupported: 0 };
      const prev = q.cursors[FEED_CALENDAR_ID] ?? {};
      const f = await fetchFeed(url, q.forceFull ? null : prev.etag ?? null);
      if (f.text === null) return { busy: null, cursors: { [FEED_CALENDAR_ID]: prev }, counts };
      let parsed;
      try {
        parsed = expandCalendar(f.text, { from: q.from.getTime(), to: q.to.getTime(), defaultTimeZone: q.timeZone });
      } catch (err) {
        if (err instanceof IcsParseError) throw new CalendarProviderError("invalid", err.message);
        throw err;
      }
      counts.events = parsed.events;
      counts.unsupported = parsed.unsupported;
      const busy: BusyInterval[] = [];
      for (const inst of parsed.instances) {
        // A feed of a calendar this workspace also writes to (through another connection) shows our own appointments back to us.
        if (q.isOwnEvent(inst.uid, inst.marker)) {
          counts.ownSkipped++;
          continue;
        }
        if (inst.transparent) {
          counts.free++;
          continue;
        }
        busy.push({ calendarId: FEED_CALENDAR_ID, eventId: inst.uid, instanceStart: new Date(inst.originalStart).toISOString(), start: inst.start, end: inst.end });
      }
      counts.busy = busy.length;
      return { busy, cursors: { [FEED_CALENDAR_ID]: { ...(f.etag ? { etag: f.etag } : {}), fullAt: new Date().toISOString() } }, counts };
    },
  };
}
