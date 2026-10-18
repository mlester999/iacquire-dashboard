import "server-only";
import { isValidTimeZone, zonedToInstant } from "@/lib/calendars/slots";
import { errorFor, parseJson, providerRequest, type HttpRequest, type HttpResult } from "@/server/calendars/adapters/http";
import { ianaFromTzid } from "@/server/calendars/adapters/ical";
import {
  CalendarProviderError, safeMeetingLink, type AuthSession, type BusyInterval, type BusyQuery, type BusyResult, type CalendarAdapter, type CalendarCursor,
  type ExistingEvent, type OutboundEvent, type RemoteCalendar, type WriteResult,
} from "@/server/calendars/adapters/types";

// Microsoft Graph v1.0. Contract: the Graph v1.0 OpenAPI description (github.com/microsoftgraph/msgraph-metadata, openapi/v1.0/openapi.yaml)
// and $metadata, read 2026-10-16: GET /me, GET /me/calendars, GET /me/calendars/{id}/calendarView (startDateTime, endDateTime,
// @odata.nextLink), POST /me/calendar/getSchedule, POST /me/calendars/{id}/events (transactionId, isOnlineMeeting,
// onlineMeetingProvider "teamsForBusiness", onlineMeeting.joinUrl), PATCH and DELETE /me/events/{id}. Times are requested in UTC
// (Prefer: outlook.timezone="UTC"). getSchedule isn't available to personal Microsoft accounts, so the connection test falls back to a
// calendarView read for them.

const API = "https://graph.microsoft.com/v1.0";
const ORIGINS = ["https://graph.microsoft.com"];
const SERVICE = "Microsoft 365";
const MAX_PAGES = 20;
const UTC_PREFER = { Prefer: 'outlook.timezone="UTC"' };

interface GraphError { error?: { code?: string; message?: string } }

function failure(res: HttpResult): CalendarProviderError {
  let code: string | null = null;
  try {
    code = (JSON.parse(res.text) as GraphError).error?.code ?? null;
  } catch {
    /* not JSON */
  }
  return errorFor(res.status, SERVICE, res.headers, code);
}

async function call(auth: AuthSession, urlOrPath: string, req: HttpRequest = {}): Promise<HttpResult> {
  return providerRequest(auth, urlOrPath.startsWith("https://") ? urlOrPath : `${API}${urlOrPath}`, ORIGINS, req, SERVICE);
}

async function json<T>(auth: AuthSession, urlOrPath: string, req: HttpRequest = {}): Promise<T> {
  const res = await call(auth, urlOrPath, req);
  if (res.status < 200 || res.status >= 300) throw failure(res);
  return parseJson<T>(res.text, SERVICE);
}

interface GraphDateTime { dateTime?: string; timeZone?: string }

/** A Graph dateTimeTimeZone to an instant. UTC is what we ask for; IANA and known Windows zone names are handled too. */
export function graphInstant(t: GraphDateTime | undefined): number | null {
  if (!t?.dateTime) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(t.dateTime.trim());
  if (!m) return null;
  if (m[5]) {
    const ms = Date.parse(t.dateTime);
    return Number.isFinite(ms) ? ms : null;
  }
  const tz = (t.timeZone ?? "UTC").trim();
  const seconds = Number(m[4] ?? 0);
  if (/^(utc|tzone:\/\/microsoft\/utc|gmt|coordinated universal time)$/i.test(tz)) return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${String(seconds).padStart(2, "0")}Z`);
  const iana = isValidTimeZone(tz) ? tz : ianaFromTzid(tz);
  if (!iana) return null;
  return zonedToInstant(m[1], Number(m[2]) * 60 + Number(m[3]), iana) + seconds * 1000;
}

const graphUtc = (d: Date) => ({ dateTime: d.toISOString().replace(/Z$/, ""), timeZone: "UTC" });

interface GraphCalendar { id: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean; allowedOnlineMeetingProviders?: string[] }

export async function listMicrosoftCalendars(auth: AuthSession): Promise<RemoteCalendar[]> {
  const out: RemoteCalendar[] = [];
  let next: string | undefined = `/me/calendars?$select=id,name,isDefaultCalendar,canEdit,allowedOnlineMeetingProviders&$top=100`;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const r: { value?: GraphCalendar[]; "@odata.nextLink"?: string } = await json(auth, next);
    for (const c of r.value ?? []) {
      if (!c.id) continue;
      out.push({ id: c.id, name: (c.name || "Calendar").slice(0, 200), primary: !!c.isDefaultCalendar, canWrite: c.canEdit !== false, timezone: null, meetings: (c.allowedOnlineMeetingProviders ?? []).filter((p) => p === "teamsForBusiness") });
    }
    next = r["@odata.nextLink"];
  }
  return out;
}

interface ScheduleItem { status?: string; start?: GraphDateTime; end?: GraphDateTime }
interface ScheduleInformation { scheduleId?: string; scheduleItems?: ScheduleItem[]; error?: { message?: string; responseCode?: string } }

/** Which free/busy statuses take time: busy, out of office and tentative do; free, working elsewhere and unknown don't. */
export const GRAPH_BUSY_STATUSES = new Set(["busy", "oof", "tentative"]);

/** getSchedule for the signed-in mailbox, mapped to busy ranges. Item subjects and locations are never kept. */
export async function microsoftSchedule(auth: AuthSession, address: string, from: Date, to: Date): Promise<Array<{ start: number; end: number }>> {
  const r = await json<{ value?: ScheduleInformation[] }>(auth, "/me/calendar/getSchedule", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...UTC_PREFER },
    body: JSON.stringify({ schedules: [address], startTime: graphUtc(from), endTime: graphUtc(to), availabilityViewInterval: 30 }),
  });
  const info = r.value?.[0];
  if (!info) throw new CalendarProviderError("invalid", `${SERVICE} returned no schedule.`);
  if (info.error?.responseCode) throw new CalendarProviderError("invalid", `${SERVICE} couldn't read the schedule (${info.error.responseCode.slice(0, 60)}).`, { code: info.error.responseCode });
  const out: Array<{ start: number; end: number }> = [];
  for (const it of info.scheduleItems ?? []) {
    if (!GRAPH_BUSY_STATUSES.has(it.status ?? "")) continue;
    const start = graphInstant(it.start);
    const end = graphInstant(it.end);
    if (start !== null && end !== null && end > start) out.push({ start, end });
  }
  return out;
}

interface GraphEvent {
  id: string;
  showAs?: string;
  isCancelled?: boolean;
  start?: GraphDateTime;
  end?: GraphDateTime;
  originalStart?: string;
  type?: string;
  transactionId?: string;
  responseStatus?: { response?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  isOnlineMeeting?: boolean;
  "@odata.etag"?: string;
}

async function calendarView(auth: AuthSession, calendarId: string, from: Date, to: Date): Promise<GraphEvent[]> {
  const out: GraphEvent[] = [];
  const params = new URLSearchParams({
    startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: "500",
    $select: "id,showAs,isCancelled,start,end,originalStart,type,transactionId,responseStatus",
  });
  let next: string | undefined = `/me/calendars/${encodeURIComponent(calendarId)}/calendarView?${params.toString()}`;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const r: { value?: GraphEvent[]; "@odata.nextLink"?: string } = await json(auth, next, { headers: UTC_PREFER });
    out.push(...(r.value ?? []));
    next = r["@odata.nextLink"];
  }
  return out;
}

/** A capability check that works for every account type: one day of the default calendar. */
export async function microsoftCanRead(auth: AuthSession, calendarId: string, now: Date): Promise<void> {
  await calendarView(auth, calendarId, now, new Date(now.getTime() + 86_400_000));
}

export const microsoftAdapter: CalendarAdapter = {
  provider: "microsoft",
  listCalendars: listMicrosoftCalendars,

  async readBusy(auth: AuthSession, q: BusyQuery): Promise<BusyResult> {
    const counts = { calendars: q.calendarIds.length, events: 0, busy: 0, ownSkipped: 0, free: 0, unsupported: 0 };
    const busy: BusyInterval[] = [];
    const cursors: Record<string, CalendarCursor> = {};
    const nowIso = new Date().toISOString();
    for (const id of q.calendarIds) {
      let events: GraphEvent[];
      try {
        events = await calendarView(auth, id, q.from, q.to);
      } catch (err) {
        // A calendar that was deleted in Outlook has no busy times; anything else is a real failure.
        if (err instanceof CalendarProviderError && err.kind === "not_found") {
          cursors[id] = { fullAt: nowIso };
          continue;
        }
        throw err;
      }
      for (const ev of events) {
        counts.events++;
        if (!ev.id || ev.isCancelled) continue;
        if (q.isOwnEvent(ev.id)) {
          counts.ownSkipped++;
          continue;
        }
        if (!GRAPH_BUSY_STATUSES.has(ev.showAs ?? "busy") || ev.responseStatus?.response === "declined") {
          counts.free++;
          continue;
        }
        const start = graphInstant(ev.start);
        const end = graphInstant(ev.end);
        if (start === null || end === null || end <= start) continue;
        const original = ev.originalStart ? Date.parse(ev.originalStart) : start;
        busy.push({ calendarId: id, eventId: ev.id, instanceStart: new Date(Number.isFinite(original) ? original : start).toISOString(), start, end });
      }
      cursors[id] = { fullAt: nowIso };
    }
    counts.busy = busy.length;
    return { busy, cursors, counts };
  },

  async upsertEvent(auth: AuthSession, calendarId: string, existing: ExistingEvent | null, ev: OutboundEvent): Promise<WriteResult> {
    const body: Record<string, unknown> = {
      subject: ev.title,
      body: { contentType: "text", content: ev.description },
      start: graphUtc(ev.start),
      end: graphUtc(ev.end),
      showAs: ev.tentative ? "tentative" : "busy",
      // Always sent: an update is a PATCH, which keeps any field left out, so a removed location must be cleared with "".
      location: { displayName: ev.location ?? "" },
    };
    const done = (g: GraphEvent): WriteResult => {
      const link = safeMeetingLink(g.onlineMeeting?.joinUrl);
      return { eventId: g.id, calendarId, etag: g["@odata.etag"] ?? null, meetingLink: link, meetingPending: ev.conference === "microsoft_teams" && !!g.isOnlineMeeting && !link };
    };
    if (existing && existing.calendarId === calendarId) {
      const res = await call(auth, `/me/events/${encodeURIComponent(existing.eventId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.status >= 200 && res.status < 300) return done(parseJson<GraphEvent>(res.text, SERVICE));
      if (res.status !== 404) throw failure(res);
    }
    const create = {
      ...body,
      // Graph uses transactionId to drop a repeated create of the same event (a retry after a timeout).
      transactionId: `iaq-${ev.idempotencyKey.slice(0, 32)}`,
      ...(ev.conference === "microsoft_teams" ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
    };
    const res = await call(auth, `/me/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(create) });
    if (res.status >= 200 && res.status < 300) return done(parseJson<GraphEvent>(res.text, SERVICE));
    throw failure(res);
  },

  async deleteEvent(auth: AuthSession, existing: ExistingEvent): Promise<void> {
    const res = await call(auth, `/me/events/${encodeURIComponent(existing.eventId)}`, { method: "DELETE" });
    if ((res.status >= 200 && res.status < 300) || res.status === 404) return;
    throw failure(res);
  },

  async meetingLink(auth: AuthSession, existing: ExistingEvent) {
    const g = await json<GraphEvent>(auth, `/me/events/${encodeURIComponent(existing.eventId)}?$select=id,isOnlineMeeting,onlineMeeting`);
    const link = safeMeetingLink(g.onlineMeeting?.joinUrl);
    return { link, pending: !!g.isOnlineMeeting && !link };
  },
};

/** The signed-in Microsoft account: its object id and mail address (or sign-in name). */
export async function microsoftAccount(auth: AuthSession): Promise<{ id: string; email: string }> {
  const j = await json<{ id?: string; mail?: string | null; userPrincipalName?: string }>(auth, "/me?$select=id,mail,userPrincipalName,displayName");
  if (!j.id) throw new CalendarProviderError("invalid", "Microsoft didn't say which account signed in.");
  return { id: j.id, email: (j.mail || j.userPrincipalName || j.id).slice(0, 200) };
}
