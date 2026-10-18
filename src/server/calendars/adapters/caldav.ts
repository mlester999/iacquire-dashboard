import "server-only";
import { publicRequest, type HttpResult } from "@/server/calendars/adapters/http";
import { expandCalendar, ianaFromTzid, parseIcs, prop, serializeEvent } from "@/server/calendars/adapters/ical";
import { CALDAV, CALSERVER, DAV, child, childrenOf, davProp, parseMultistatus, textOf, XmlParseError, type DavResponse } from "@/server/calendars/adapters/xml";
import {
  CalendarProviderError, kindForStatus, type BusyInterval, type BusyQuery, type BusyResult, type CalendarAdapter, type CalendarCursor, type ExistingEvent,
  type OutboundEvent, type RemoteCalendar, type WriteResult,
} from "@/server/calendars/adapters/types";

// CalDAV (RFC 4791) on top of WebDAV (RFC 4918), including iCloud. Discovery follows RFC 5397 and RFC 6764: PROPFIND the address for
// DAV:current-user-principal (trying /.well-known/caldav when the address itself doesn't say), PROPFIND the principal for
// CALDAV:calendar-home-set, then PROPFIND the home (Depth: 1) for calendar collections whose supported-calendar-component-set includes
// VEVENT. Busy times come from a CALDAV:calendar-query REPORT with a time-range filter; recurrences are expanded here (servers differ in
// how well they expand). Events we add are PUT at a stable address with If-None-Match / If-Match on the ETag, and removed with DELETE.

export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";

export interface CalDavAccount {
  serverUrl: string;
  username: string;
  password: string;
  principalUrl?: string | null;
  homeUrl?: string | null;
}

const XML_HEADERS = { "Content-Type": 'application/xml; charset="utf-8"', Accept: "application/xml, text/xml;q=0.9" };

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/><d:displayname/></d:prop></d:propfind>`;
const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/><cs:getctag/><d:sync-token/><c:calendar-timezone/></d:prop></d:propfind>`;
const PROPFIND_TAG = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>`;
const PROPFIND_ETAG = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`;

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** The calendar-query REPORT for VEVENTs overlapping [from, to) (RFC 4791 7.8). */
export function calendarQuery(from: Date, to: Date): string {
  return `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${utcStamp(from)}" end="${utcStamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
}

/** iCloud hands out calendar homes on other icloud.com hosts; any other server gets the password only on the host the person entered. */
export function trustedHosts(serverUrl: string): (host: string) => boolean {
  const base = new URL(serverUrl).hostname.toLowerCase();
  if (base === "icloud.com" || base.endsWith(".icloud.com")) return (h) => h === "icloud.com" || h.endsWith(".icloud.com");
  return (h) => h === base;
}

const isICloud = (serverUrl: string) => /(^|\.)icloud\.com$/i.test(new URL(serverUrl).hostname);
const serviceName = (account: CalDavAccount) => (isICloud(account.serverUrl) ? "iCloud" : "The calendar server");

const asCollection = (u: string) => (u.endsWith("/") ? u : `${u}/`);

async function dav(account: CalDavAccount, url: string, method: string, body: string | undefined, extraHeaders: Record<string, string> = {}): Promise<HttpResult> {
  const service = serviceName(account);
  const res = await publicRequest(url, {
    method,
    body,
    headers: { ...(body && !extraHeaders["Content-Type"] ? XML_HEADERS : {}), ...extraHeaders },
    authHeaders: { Authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`, "utf8").toString("base64")}` },
    trustHost: trustedHosts(account.serverUrl),
  }, service);
  if (res.status === 401) {
    throw new CalendarProviderError("auth", isICloud(account.serverUrl) ? "iCloud didn't accept the Apple ID and app-specific password." : "The calendar server didn't accept the username and password.", { status: 401 });
  }
  return res;
}

function multistatus(res: HttpResult, account: CalDavAccount): DavResponse[] {
  if (res.status !== 207) {
    const kind = kindForStatus(res.status);
    throw new CalendarProviderError(kind === "invalid" ? "invalid" : kind, `${serviceName(account)} answered HTTP ${res.status}.`, { status: res.status });
  }
  try {
    return parseMultistatus(res.text);
  } catch (err) {
    if (err instanceof XmlParseError) throw new CalendarProviderError("invalid", `${serviceName(account)} sent a response we couldn't read.`);
    throw err;
  }
}

const hrefIn = (el: ReturnType<typeof davProp>) => textOf(child(el, DAV, "href"));

async function principalAt(account: CalDavAccount, url: string): Promise<string | null> {
  const res = await dav(account, url, "PROPFIND", PROPFIND_PRINCIPAL, { Depth: "0" });
  if (res.status === 404 || res.status === 405 || res.status === 403) return null;
  for (const r of multistatus(res, account)) {
    const href = hrefIn(davProp(r, DAV, "current-user-principal"));
    if (href) return new URL(href, res.url).toString();
  }
  return null;
}

export interface CalDavDiscovery {
  principalUrl: string;
  homeUrl: string;
  calendars: RemoteCalendar[];
}

/** Finds the person's calendars from the address they entered. Every request is authenticated, so success also proves the password. */
export async function discoverCalDav(account: CalDavAccount): Promise<CalDavDiscovery> {
  const service = serviceName(account);
  let principalUrl = await principalAt(account, account.serverUrl);
  if (!principalUrl) principalUrl = await principalAt(account, new URL("/.well-known/caldav", account.serverUrl).toString());
  if (!principalUrl) throw new CalendarProviderError("not_found", `${service} didn't say where your calendars are. Check the server address.`);
  const homeRes = await dav(account, principalUrl, "PROPFIND", PROPFIND_HOME, { Depth: "0" });
  let homeUrl: string | null = null;
  for (const r of multistatus(homeRes, account)) {
    const href = hrefIn(davProp(r, CALDAV, "calendar-home-set"));
    if (href) homeUrl = asCollection(new URL(href, homeRes.url).toString());
  }
  if (!homeUrl) throw new CalendarProviderError("not_found", `${service} has no calendar home for this account.`);
  const calendars = await listCalDavCalendars({ ...account, principalUrl, homeUrl });
  return { principalUrl, homeUrl, calendars };
}

export async function listCalDavCalendars(account: CalDavAccount): Promise<RemoteCalendar[]> {
  if (!account.homeUrl) throw new CalendarProviderError("invalid", "The calendar home isn't known yet.");
  const res = await dav(account, account.homeUrl, "PROPFIND", PROPFIND_CALENDARS, { Depth: "1" });
  const out: RemoteCalendar[] = [];
  for (const r of multistatus(res, account)) {
    const type = davProp(r, DAV, "resourcetype");
    if (!child(type, CALDAV, "calendar")) continue;
    const comps = davProp(r, CALDAV, "supported-calendar-component-set");
    // Absent means the collection accepts any component type (RFC 4791 5.2.3).
    if (comps && !childrenOf(comps, CALDAV, "comp").some((c) => (c.attrs.name ?? "").toUpperCase() === "VEVENT")) continue;
    const privs = davProp(r, DAV, "current-user-privilege-set");
    const names = new Set((privs?.children ?? []).flatMap((p) => p.children.filter((c) => c.ns === DAV).map((c) => c.name)));
    const canWrite = !privs || names.has("write") || names.has("write-content") || names.has("bind") || names.has("all");
    const url = asCollection(new URL(r.href, res.url).toString());
    const tzText = textOf(davProp(r, CALDAV, "calendar-timezone"));
    let timezone: string | null = null;
    if (tzText) {
      const vtz = parseIcs(tzText)[0]?.components.find((c) => c.name === "VTIMEZONE");
      const id = vtz ? prop(vtz, "TZID")?.value : undefined;
      timezone = id ? ianaFromTzid(id) : null;
    }
    const name = textOf(davProp(r, DAV, "displayname")) || decodeURIComponent(url.replace(/\/$/, "").split("/").pop() ?? "Calendar");
    out.push({ id: url, name: name.slice(0, 200), primary: false, canWrite, timezone, meetings: [] });
  }
  // CalDAV has no "primary" calendar: the first one that takes events stands in for it.
  const first = out.find((c) => c.canWrite) ?? out[0];
  if (first) first.primary = true;
  return out;
}

async function collectionTag(account: CalDavAccount, calendarUrl: string): Promise<string | null> {
  const res = await dav(account, calendarUrl, "PROPFIND", PROPFIND_TAG, { Depth: "0" });
  for (const r of multistatus(res, account)) {
    const tag = textOf(davProp(r, CALSERVER, "getctag")) || textOf(davProp(r, DAV, "sync-token"));
    if (tag) return tag.slice(0, 300);
  }
  return null;
}

async function currentEtag(account: CalDavAccount, href: string): Promise<string | null> {
  const res = await dav(account, href, "PROPFIND", PROPFIND_ETAG, { Depth: "0" });
  if (res.status === 404) return null;
  for (const r of multistatus(res, account)) {
    const e = textOf(davProp(r, DAV, "getetag"));
    if (e) return e;
  }
  return null;
}

/** An adapter bound to one CalDAV account (its credentials never leave this closure). */
export function caldavAdapter(account: CalDavAccount): CalendarAdapter {
  const service = serviceName(account);
  return {
    provider: "caldav",
    listCalendars: () => listCalDavCalendars(account),

    async readBusy(_auth, q: BusyQuery): Promise<BusyResult> {
      const counts = { calendars: q.calendarIds.length, events: 0, busy: 0, ownSkipped: 0, free: 0, unsupported: 0 };
      const cursors: Record<string, CalendarCursor> = {};
      const tags = new Map<string, string | null>();
      let changed = q.forceFull;
      for (const id of q.calendarIds) {
        const tag = await collectionTag(account, id);
        tags.set(id, tag);
        const prev = q.cursors[id];
        if (!tag || !prev?.ctag || prev.ctag !== tag || !prev.fullAt) changed = true;
        cursors[id] = { ...(prev ?? {}) };
      }
      if (!changed) return { busy: null, cursors, counts };

      const busy: BusyInterval[] = [];
      const nowIso = new Date().toISOString();
      for (const id of q.calendarIds) {
        const res = await dav(account, id, "REPORT", calendarQuery(q.from, q.to), { Depth: "1" });
        if (res.status === 404) {
          cursors[id] = { fullAt: nowIso };
          continue;
        }
        for (const r of multistatus(res, account)) {
          const data = textOf(davProp(r, CALDAV, "calendar-data"));
          if (!data) continue;
          const href = new URL(r.href, res.url).toString();
          if (q.isOwnEvent(href)) {
            counts.ownSkipped++;
            continue;
          }
          const parsed = expandCalendar(data, { from: q.from.getTime(), to: q.to.getTime(), defaultTimeZone: q.timeZone });
          counts.events += parsed.events;
          counts.unsupported += parsed.unsupported;
          for (const inst of parsed.instances) {
            // Our event at another address (written through another connection, or copied by the calendar app): its UID or markers say so.
            if (q.isOwnEvent(inst.uid, inst.marker)) {
              counts.ownSkipped++;
              continue;
            }
            if (inst.transparent) {
              counts.free++;
              continue;
            }
            busy.push({ calendarId: id, eventId: `${href}#${inst.uid}`, instanceStart: new Date(inst.originalStart).toISOString(), start: inst.start, end: inst.end });
          }
        }
        const tag = tags.get(id);
        cursors[id] = { ...(tag ? { ctag: tag } : {}), fullAt: nowIso };
      }
      counts.busy = busy.length;
      return { busy, cursors, counts };
    },

    async upsertEvent(_auth, calendarId: string, existing: ExistingEvent | null, ev: OutboundEvent): Promise<WriteResult> {
      const key = ev.idempotencyKey.slice(0, 40);
      const body = serializeEvent({
        uid: `iaq-${key}@iacquire`,
        start: ev.start,
        end: ev.end,
        summary: ev.title,
        description: ev.description,
        location: ev.location,
        status: ev.tentative ? "TENTATIVE" : "CONFIRMED",
        sequence: ev.sequence,
        // Both markers, so a later read (this connection, another one, or a feed of the same calendar) can tell it is ours.
        extra: { "X-IACQUIRE-APPOINTMENT": ev.appointmentId, "X-IACQUIRE-WORKSPACE": ev.workspaceId },
      });
      const headers = { "Content-Type": "text/calendar; charset=utf-8" };
      const put = (href: string, precondition: Record<string, string>) => dav(account, href, "PUT", body, { ...headers, ...precondition });
      const ok = (res: HttpResult, href: string): WriteResult => ({ eventId: href, calendarId, etag: res.headers.get("etag"), meetingLink: null, meetingPending: false });
      const sameCalendar = existing && existing.calendarId === calendarId;
      const href = sameCalendar ? existing.eventId : new URL(`iaq-${key}.ics`, asCollection(calendarId)).toString();
      let res = await put(href, sameCalendar && existing.etag ? { "If-Match": existing.etag } : sameCalendar ? {} : { "If-None-Match": "*" });
      if (res.status === 412) {
        // Changed or already there (a retry, or an edit in the calendar app): this is our event, so write over the current version.
        const etag = await currentEtag(account, href);
        res = await put(href, etag ? { "If-Match": etag } : { "If-None-Match": "*" });
      } else if (res.status === 404 && sameCalendar) {
        res = await put(href, { "If-None-Match": "*" });
      }
      if (res.status >= 200 && res.status < 300) return ok(res, href);
      throw new CalendarProviderError(kindForStatus(res.status), res.status === 403 ? `${service} doesn't allow adding events to that calendar.` : `${service} refused the event (HTTP ${res.status}).`, { status: res.status });
    },

    async deleteEvent(_auth, existing: ExistingEvent): Promise<void> {
      let res = await dav(account, existing.eventId, "DELETE", undefined, existing.etag ? { "If-Match": existing.etag } : {});
      if (res.status === 412) {
        const etag = await currentEtag(account, existing.eventId);
        if (!etag) return;
        res = await dav(account, existing.eventId, "DELETE", undefined, { "If-Match": etag });
      }
      if ((res.status >= 200 && res.status < 300) || res.status === 404 || res.status === 410) return;
      throw new CalendarProviderError(kindForStatus(res.status), `${service} couldn't remove the event (HTTP ${res.status}).`, { status: res.status });
    },
  };
}
