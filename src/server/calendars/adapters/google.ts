import "server-only";
import crypto from "node:crypto";
import { zonedToInstant } from "@/lib/calendars/slots";
import { errorFor, parseJson, providerRequest, type HttpRequest, type HttpResult } from "@/server/calendars/adapters/http";
import { GOOGLE } from "@/server/calendars/adapters/oauth";
import {
  CalendarProviderError, safeMeetingLink, type AuthSession, type BusyInterval, type BusyQuery, type BusyResult, type CalendarAdapter, type CalendarCursor,
  type ExistingEvent, type OutboundEvent, type RemoteCalendar, type WriteResult,
} from "@/server/calendars/adapters/types";

// Google Calendar API v3. Contract: the official discovery document (www.googleapis.com/discovery/v1/apis/calendar/v3/rest, revision
// 20261012): calendarList.list, freebusy.query, events.list (syncToken, singleEvents, timeMin/timeMax; 410 means the sync token expired),
// events.insert / patch / delete (conferenceDataVersion=1 with conferenceData.createRequest of type "hangoutsMeet"; sendUpdates=none).

const API = "https://www.googleapis.com/calendar/v3";
const ORIGINS = ["https://www.googleapis.com"];
const SERVICE = "Google Calendar";
const MAX_PAGES = 10;

interface GError { error?: { code?: number; message?: string; status?: string; errors?: Array<{ reason?: string }> } }

function failure(res: HttpResult): CalendarProviderError {
  let reason: string | null = null;
  try {
    const j = JSON.parse(res.text) as GError;
    reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? null;
  } catch {
    /* not JSON */
  }
  // Google reports quota problems as 403 with a rate-limit reason.
  if (res.status === 403 && reason && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(reason)) {
    return new CalendarProviderError("rate_limited", `${SERVICE} asked us to slow down.`, { status: 403, code: reason });
  }
  return errorFor(res.status, SERVICE, res.headers, reason);
}

async function call(auth: AuthSession, path: string, req: HttpRequest = {}): Promise<HttpResult> {
  return providerRequest(auth, `${API}${path}`, ORIGINS, req, SERVICE);
}

async function json<T>(auth: AuthSession, path: string, req: HttpRequest = {}): Promise<T> {
  const res = await call(auth, path, req);
  if (res.status < 200 || res.status >= 300) throw failure(res);
  return parseJson<T>(res.text, SERVICE);
}

const qs = (p: Record<string, string | number | boolean | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) u.set(k, String(v));
  return u.toString();
};

interface CalendarListEntry { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string; timeZone?: string; deleted?: boolean; conferenceProperties?: { allowedConferenceSolutionTypes?: string[] } }

export async function listGoogleCalendars(auth: AuthSession): Promise<RemoteCalendar[]> {
  const out: RemoteCalendar[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await json<{ items?: CalendarListEntry[]; nextPageToken?: string }>(auth, `/users/me/calendarList?${qs({ maxResults: 250, minAccessRole: "freeBusyReader", pageToken })}`);
    for (const c of r.items ?? []) {
      if (c.deleted || !c.id) continue;
      out.push({
        // Events are written with calendar.events.owned, which covers only calendars the person owns (their primary calendar and the
        // ones they created); a shared calendar they may edit ("writer") would refuse every write with 403.
        id: c.id, name: (c.summaryOverride || c.summary || c.id).slice(0, 200), primary: !!c.primary, canWrite: c.accessRole === "owner",
        timezone: c.timeZone ?? null,
        // Unknown when Google doesn't say; an empty list means Meet isn't allowed on this calendar.
        meetings: c.conferenceProperties?.allowedConferenceSolutionTypes ? c.conferenceProperties.allowedConferenceSolutionTypes.filter((t) => t === "hangoutsMeet") : undefined,
      });
    }
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/** freebusy.query for up to 50 calendars: busy ranges per calendar, or the provider's error reason for one it couldn't read. */
export async function googleFreeBusy(auth: AuthSession, calendarIds: string[], from: Date, to: Date): Promise<Map<string, { busy: Array<{ start: number; end: number }>; error: string | null }>> {
  const r = await json<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason?: string }> }> }>(auth, "/freeBusy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: calendarIds.slice(0, 50).map((id) => ({ id })) }),
  });
  const out = new Map<string, { busy: Array<{ start: number; end: number }>; error: string | null }>();
  for (const id of calendarIds) {
    const c = r.calendars?.[id];
    const busy = (c?.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })).filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
    out.set(id, { busy, error: c ? (c.errors?.[0]?.reason ?? null) : "notFound" });
  }
  return out;
}

interface GEventTime { date?: string; dateTime?: string; timeZone?: string }
interface GEvent {
  id: string;
  status?: string;
  start?: GEventTime;
  end?: GEventTime;
  originalStartTime?: GEventTime;
  transparency?: string;
  eventType?: string;
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  extendedProperties?: { private?: Record<string, string> };
  hangoutLink?: string;
  etag?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }>; createRequest?: { status?: { statusCode?: string } } };
}
interface GEvents { items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string; timeZone?: string }

const LIST_FIELDS = "items(id,status,start,end,originalStartTime,transparency,eventType,attendees(self,responseStatus),extendedProperties/private),nextPageToken,nextSyncToken,timeZone";

function instantOfGoogle(t: GEventTime | undefined, fallbackTz: string): number | null {
  if (!t) return null;
  if (t.dateTime) {
    const ms = Date.parse(t.dateTime);
    return Number.isFinite(ms) ? ms : null;
  }
  if (t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) return zonedToInstant(t.date, 0, t.timeZone || fallbackTz);
  return null;
}

/**
 * Whether anything changed on a calendar since its sync token, without reading the window again. Null: a full read is needed, because the
 * token expired (410), or the calendar is gone (404) or no longer lets the person read its events (403 that isn't a rate limit). The full
 * read handles those calmly (no busy times, or freebusy.query), where failing here would stop busy sync for every calendar on the
 * connection until the next six-hourly full read. Otherwise { changed, nextToken }.
 */
async function incrementalCheck(auth: AuthSession, calendarId: string, token: string): Promise<{ changed: boolean; nextToken: string | null } | null> {
  const res = await call(auth, `/calendars/${encodeURIComponent(calendarId)}/events?${qs({ syncToken: token, singleEvents: true, maxResults: 50, fields: "items(id),nextPageToken,nextSyncToken" })}`);
  if (res.status === 410 || res.status === 404) return null;
  if (res.status === 403) {
    const f = failure(res);
    if (f.kind === "rate_limited") throw f;
    return null;
  }
  if (res.status < 200 || res.status >= 300) throw failure(res);
  const r = parseJson<GEvents>(res.text, SERVICE);
  if ((r.items?.length ?? 0) > 0 || r.nextPageToken) return { changed: true, nextToken: null };
  return { changed: false, nextToken: r.nextSyncToken ?? token };
}

export const googleAdapter: CalendarAdapter = {
  provider: "google",
  listCalendars: listGoogleCalendars,

  async readBusy(auth: AuthSession, q: BusyQuery): Promise<BusyResult> {
    const counts = { calendars: q.calendarIds.length, events: 0, busy: 0, ownSkipped: 0, free: 0, unsupported: 0 };
    const cursors: Record<string, CalendarCursor> = {};
    for (const id of q.calendarIds) cursors[id] = { ...(q.cursors[id] ?? {}) };

    // Cheap path first: every calendar has a sync token that reports no changes.
    let needFull = q.forceFull;
    for (const id of q.calendarIds) {
      if (needFull) break;
      const token = cursors[id].syncToken;
      if (!token) {
        needFull = true;
        break;
      }
      const check = await incrementalCheck(auth, id, token);
      if (!check) {
        delete cursors[id].syncToken;
        needFull = true;
      } else if (check.changed) needFull = true;
      else cursors[id].syncToken = check.nextToken ?? token;
    }
    if (!needFull) return { busy: null, cursors, counts };

    const busy: BusyInterval[] = [];
    const nowIso = new Date().toISOString();
    const fallback: string[] = [];
    for (const id of q.calendarIds) {
      let pageToken: string | undefined;
      let syncToken: string | undefined;
      let tz = q.timeZone;
      let forbidden = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await call(auth, `/calendars/${encodeURIComponent(id)}/events?${qs({ timeMin: q.from.toISOString(), timeMax: q.to.toISOString(), singleEvents: true, maxResults: 2500, pageToken, fields: LIST_FIELDS })}`);
        if (res.status === 404) break; // A calendar that's gone has no busy times.
        if (res.status === 403) {
          const f = failure(res);
          if (f.kind === "rate_limited") throw f;
          // Shared with free/busy access only: fall back to freebusy.query below.
          forbidden = true;
          break;
        }
        if (res.status < 200 || res.status >= 300) throw failure(res);
        const r = parseJson<GEvents>(res.text, SERVICE);
        if (r.timeZone) tz = r.timeZone;
        for (const ev of r.items ?? []) {
          counts.events++;
          if (!ev.id || ev.status === "cancelled") continue;
          const priv = ev.extendedProperties?.private;
          if (q.isOwnEvent(ev.id, { appointmentId: priv?.iaqAppointment ?? null, workspaceId: priv?.iaqWorkspace ?? null })) {
            counts.ownSkipped++;
            continue;
          }
          const declined = ev.attendees?.some((a) => a.self && a.responseStatus === "declined");
          if (ev.transparency === "transparent" || declined || ev.eventType === "workingLocation") {
            counts.free++;
            continue;
          }
          const start = instantOfGoogle(ev.start, tz);
          const end = instantOfGoogle(ev.end, tz);
          if (start === null || end === null || end <= start) continue;
          const original = instantOfGoogle(ev.originalStartTime, tz) ?? start;
          busy.push({ calendarId: id, eventId: ev.id, instanceStart: new Date(original).toISOString(), start, end });
        }
        pageToken = r.nextPageToken;
        syncToken = r.nextSyncToken ?? syncToken;
        if (!pageToken) break;
      }
      if (forbidden) fallback.push(id);
      cursors[id] = { ...(syncToken ? { syncToken } : {}), fullAt: nowIso };
    }
    if (fallback.length) {
      const fb = await googleFreeBusy(auth, fallback, q.from, q.to);
      for (const [id, r] of fb) for (const b of r.busy) busy.push({ calendarId: id, eventId: `freebusy:${id}`, instanceStart: new Date(b.start).toISOString(), start: b.start, end: b.end });
    }
    counts.busy = busy.length;
    return { busy, cursors, counts };
  },

  async upsertEvent(auth: AuthSession, calendarId: string, existing: ExistingEvent | null, ev: OutboundEvent): Promise<WriteResult> {
    const base = {
      summary: ev.title,
      description: ev.description,
      // Always sent: an update is a PATCH, which keeps any field left out, so a removed location must be cleared with "".
      location: ev.location ?? "",
      start: { dateTime: ev.start.toISOString(), timeZone: ev.timeZone },
      end: { dateTime: ev.end.toISOString(), timeZone: ev.timeZone },
      status: ev.tentative ? "tentative" : "confirmed",
      transparency: "opaque",
      extendedProperties: { private: { iaqAppointment: ev.appointmentId, iaqWorkspace: ev.workspaceId } },
    };
    const write = { "Content-Type": "application/json" };
    const params = qs({ conferenceDataVersion: 1, sendUpdates: "none" });
    const cal = encodeURIComponent(calendarId);
    const done = (g: GEvent): WriteResult => {
      const video = g.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ?? g.hangoutLink;
      const link = safeMeetingLink(video);
      return { eventId: g.id, calendarId, etag: g.etag ?? null, meetingLink: link, meetingPending: !link && g.conferenceData?.createRequest?.status?.statusCode === "pending" };
    };
    const patch = async (eventId: string, extra: Record<string, unknown> = {}) => {
      const res = await call(auth, `/calendars/${cal}/events/${encodeURIComponent(eventId)}?${params}`, { method: "PATCH", headers: write, body: JSON.stringify({ ...base, ...extra }) });
      return res;
    };
    if (existing && existing.calendarId === calendarId) {
      const res = await patch(existing.eventId);
      if (res.status >= 200 && res.status < 300) return done(parseJson<GEvent>(res.text, SERVICE));
      if (res.status !== 404 && res.status !== 410) throw failure(res);
      // Deleted on Google's side: create it again below.
    }
    // A stable id per connection and appointment makes a retried insert a 409 instead of a duplicate event.
    const id = `iaq${ev.idempotencyKey.slice(0, 40)}`;
    const body: Record<string, unknown> = { ...base, id };
    if (ev.conference === "google_meet") body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    const res = await call(auth, `/calendars/${cal}/events?${params}`, { method: "POST", headers: write, body: JSON.stringify(body) });
    if (res.status >= 200 && res.status < 300) return done(parseJson<GEvent>(res.text, SERVICE));
    if (res.status === 409) {
      // Already there (an earlier attempt, or a deleted copy): update it and make sure it is live again.
      const again = await patch(id, ev.conference === "google_meet" ? { conferenceData: body.conferenceData } : {});
      if (again.status >= 200 && again.status < 300) return done(parseJson<GEvent>(again.text, SERVICE));
      throw failure(again);
    }
    throw failure(res);
  },

  async deleteEvent(auth: AuthSession, existing: ExistingEvent): Promise<void> {
    const res = await call(auth, `/calendars/${encodeURIComponent(existing.calendarId)}/events/${encodeURIComponent(existing.eventId)}?${qs({ sendUpdates: "none" })}`, { method: "DELETE" });
    if ((res.status >= 200 && res.status < 300) || res.status === 404 || res.status === 410) return;
    throw failure(res);
  },

  async meetingLink(auth: AuthSession, existing: ExistingEvent) {
    const g = await json<GEvent>(auth, `/calendars/${encodeURIComponent(existing.calendarId)}/events/${encodeURIComponent(existing.eventId)}?${qs({ fields: "id,hangoutLink,conferenceData" })}`);
    const link = safeMeetingLink(g.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ?? g.hangoutLink);
    return { link, pending: !link && g.conferenceData?.createRequest?.status?.statusCode === "pending" };
  },
};

/** The signed-in Google account: OpenID userinfo (sub and email). */
export async function googleAccount(auth: AuthSession): Promise<{ id: string; email: string }> {
  const res = await providerRequest(auth, GOOGLE.userinfo, ["https://openidconnect.googleapis.com"], {}, "Google");
  if (res.status < 200 || res.status >= 300) throw errorFor(res.status, "Google", res.headers);
  const j = parseJson<{ sub?: string; email?: string }>(res.text, "Google");
  if (!j.sub) throw new CalendarProviderError("invalid", "Google didn't say which account signed in.");
  return { id: j.sub, email: (j.email ?? j.sub).slice(0, 200) };
}
