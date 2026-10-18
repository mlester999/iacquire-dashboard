// Connected calendars: iCalendar parsing, Google / Microsoft / CalDAV / ICS adapters, OAuth sign-in, busy sync, write-back and the rules
// around them. Synthetic workspaces only: every provider call goes to a fetch mock router and every DNS answer is mocked, so nothing here
// contacts Google, Microsoft, Apple or any other host.
import crypto from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The OAuth callback route reads the signed-in person from the session; here it is whoever the test says.
const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
vi.mock("@/server/auth/session", async (original) => ({ ...(await original<typeof import("@/server/auth/session")>()), getCurrentUser: async () => session.user }));
// The screen is rendered to HTML below without a browser: navigation and server actions are inert stand-ins there.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/crm/calendar-connections" }));
vi.mock("@/app/actions/crm-calendar-connections", () => {
  const ok = async () => ({ ok: true, data: null });
  return { connectCalDavAction: ok, connectIcsFeedAction: ok, updateCalendarConnectionAction: ok, disconnectCalendarAction: ok, syncCalendarNowAction: ok, listCalendarSyncRunsAction: ok };
});
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { decryptSecret, sha256 } from "@/server/security/crypto";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { computeSlots, loadBookingContext } from "@/server/calendars/availability";
import { bookingPageActor, bookNativeAppointment, cancelNativeAppointment, rescheduleNativeAppointment } from "@/server/calendars/booking";
import {
  calendarConnectionSettings, completeCalendarOAuth, connectCalDav, connectIcsFeed, disconnectCalendar, listMyConnections, listSyncRuns, listTeamConnections,
  startCalendarOAuth, updateConnectionOptions,
} from "@/server/calendars/connections";
import { DELETED_HASH, externalRef, syncConnectionBusy, syncDueConnections, writeBackDue } from "@/server/calendars/sync";
import { assertPublicHttps, hostResolver } from "@/server/calendars/adapters/http";
import { expandCalendar, foldLine, parseDuration, parseIcs, parseRRule, prop, serializeEvent, unescapeText, unfold } from "@/server/calendars/adapters/ical";
import { googleAdapter, listGoogleCalendars } from "@/server/calendars/adapters/google";
import { microsoftAdapter, microsoftSchedule } from "@/server/calendars/adapters/microsoft";
import { GOOGLE_SCOPES } from "@/server/calendars/adapters/oauth";
import type { AuthSession, BusyQuery, OutboundEvent } from "@/server/calendars/adapters/types";
import { ipv6Groups, isPublicAddress } from "@/server/onboarding/website";
import type { ConnectionView } from "@/server/calendars/connections";
import type { CrmScope } from "@/server/crm/page";
import { CalendarConnectionsWorkspace } from "@/components/crm/scheduling/connections/calendar-connections";
import { GET as oauthStart } from "@/app/api/crm/calendar-oauth/[provider]/start/route";
import { GET as oauthCallback } from "@/app/api/crm/calendar-oauth/[provider]/callback/route";
import { agencyPeople, crmOrg, type CrmOrg, type CrmWho } from "./support/crm";

// ---------------------------------------------------------------------------
// A fetch mock router: every request is recorded; anything unexpected is reported and answered 599.
// ---------------------------------------------------------------------------

type Req = { method: string; url: URL; headers: Record<string, string>; body: string };
type Handler = (r: Req, m: RegExpMatchArray) => Response | Promise<Response>;

class FetchRouter {
  routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
  calls: Req[] = [];
  unexpected: string[] = [];
  /** Later routes win, so a test can override a default. */
  on(method: string, pattern: RegExp, handler: Handler) {
    this.routes.unshift({ method, pattern, handler });
    return this;
  }
  install() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const req: Req = { method: (init?.method ?? "GET").toUpperCase(), url, headers, body: typeof init?.body === "string" ? init.body : "" };
      this.calls.push(req);
      for (const r of this.routes) {
        if (r.method !== "*" && r.method !== req.method) continue;
        const m = `${url.origin}${url.pathname}`.match(r.pattern);
        if (m) return r.handler(req, m);
      }
      this.unexpected.push(`${req.method} ${url.origin}${url.pathname}`);
      return new Response("unexpected", { status: 599 });
    });
    return this;
  }
  find(method: string, pattern: RegExp) {
    return this.calls.filter((c) => c.method === method && pattern.test(`${c.url.origin}${c.url.pathname}`));
  }
}

let router: FetchRouter;
const dnsAnswers = (host: string) => (host.includes("internal-lan") ? ["10.1.2.3"] : host.includes("metadata") ? ["169.254.169.254"] : host.includes("loopback") ? ["127.0.0.1"] : ["93.184.216.34"]);

beforeEach(() => {
  router = new FetchRouter().install();
  vi.spyOn(hostResolver, "lookup").mockImplementation(async (host: string) => dnsAnswers(host));
});
afterEach(() => {
  expect(router.unexpected).toEqual([]);
  vi.restoreAllMocks();
});

const form = (body: string) => Object.fromEntries(new URLSearchParams(body));
const xml = (body: string, status = 207, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "application/xml; charset=utf-8", ...headers } });

// Monday 19 October 2026, 08:00 in Manila (00:00 UTC).
const NOW = new Date("2026-10-19T00:00:00Z");
const at = (localHHMM: string, date = "2026-10-20") => new Date(`${date}T${localHHMM}:00+08:00`);
const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

beforeAll(() => {
  setEnv({
    GOOGLE_CALENDAR_CLIENT_ID: "google-client-id.apps.example.test", GOOGLE_CALENDAR_CLIENT_SECRET: "google-client-secret-synthetic",
    MICROSOFT_CALENDAR_CLIENT_ID: "00000000-0000-0000-0000-000000000abc", MICROSOFT_CALENDAR_CLIENT_SECRET: "microsoft-client-secret-synthetic",
    CALENDAR_SYNC_DISABLED: undefined,
  });
});

// ---------------------------------------------------------------------------
// Google fakes
// ---------------------------------------------------------------------------

const PRIMARY = "ana@example.test";

interface GoogleFake {
  events: Array<Record<string, unknown>>;
  /** What an incremental (syncToken) request returns. */
  incremental: "none" | "changed" | "gone";
  accessToken: string;
  refreshFails: boolean;
  created: Array<Record<string, unknown>>;
}

function googleFake(opts: Partial<GoogleFake> = {}): GoogleFake {
  const g: GoogleFake = { events: [], incremental: "none", accessToken: "ya29.synthetic-access-1", refreshFails: false, created: [], ...opts };
  router
    .on("POST", /^https:\/\/oauth2\.googleapis\.com\/token$/, (r) => {
      const f = form(r.body);
      if (f.client_secret !== "google-client-secret-synthetic") return Response.json({ error: "invalid_client" }, { status: 401 });
      if (f.grant_type === "authorization_code") {
        if (f.code !== "good-code" || !f.code_verifier || f.redirect_uri !== "http://localhost:3000/api/crm/calendar-oauth/google/callback") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: g.accessToken, refresh_token: "1//synthetic-refresh-1", expires_in: 3599, scope: GOOGLE_SCOPES.join(" "), token_type: "Bearer" });
      }
      if (f.grant_type === "refresh_token") {
        if (g.refreshFails) return Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
        g.accessToken = "ya29.synthetic-access-2";
        return Response.json({ access_token: g.accessToken, expires_in: 3599, scope: GOOGLE_SCOPES.join(" "), token_type: "Bearer" });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    })
    .on("POST", /^https:\/\/oauth2\.googleapis\.com\/revoke$/, () => new Response("", { status: 200 }))
    .on("GET", /^https:\/\/openidconnect\.googleapis\.com\/v1\/userinfo$/, () => Response.json({ sub: "google-sub-ana", email: PRIMARY, email_verified: true }))
    .on("GET", /\/calendar\/v3\/users\/me\/calendarList$/, (r) => {
      if (r.headers.authorization !== `Bearer ${g.accessToken}`) return Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 });
      return Response.json({ items: [
        { id: PRIMARY, summary: "Ana", primary: true, accessRole: "owner", timeZone: "Asia/Manila", conferenceProperties: { allowedConferenceSolutionTypes: ["hangoutsMeet"] } },
        { id: "team@group.calendar.google.com", summary: "Team", accessRole: "reader", timeZone: "Asia/Manila" },
      ] });
    })
    .on("POST", /\/calendar\/v3\/freeBusy$/, (r) => {
      const body = JSON.parse(r.body) as { items: Array<{ id: string }> };
      return Response.json({ calendars: Object.fromEntries(body.items.map((i) => [i.id, { busy: [] }])) });
    })
    .on("GET", /\/calendar\/v3\/calendars\/([^/]+)\/events$/, (r) => {
      if (r.headers.authorization !== `Bearer ${g.accessToken}`) return Response.json({ error: { code: 401 } }, { status: 401 });
      if (r.url.searchParams.get("syncToken")) {
        if (g.incremental === "gone") return Response.json({ error: { code: 410, errors: [{ reason: "fullSyncRequired" }] } }, { status: 410 });
        return Response.json({ items: g.incremental === "changed" ? [{ id: "changed-1" }] : [], nextSyncToken: "sync-token-incremental" });
      }
      expect(r.url.searchParams.get("singleEvents")).toBe("true");
      expect(r.url.searchParams.get("timeMin")).toBeTruthy();
      return Response.json({ items: g.events, nextSyncToken: "sync-token-full", timeZone: "Asia/Manila" });
    })
    .on("POST", /\/calendar\/v3\/calendars\/([^/]+)\/events$/, (r) => {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      g.created.push(body);
      const conf = (body.conferenceData as { createRequest?: unknown } | undefined)?.createRequest;
      return Response.json({ ...body, etag: '"g-1"', ...(conf ? { conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }], conferenceSolution: { key: { type: "hangoutsMeet" } } }, hangoutLink: "https://meet.google.com/abc-defg-hij" } : {}) });
    })
    .on("PATCH", /\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/, (r, m) => Response.json({ ...JSON.parse(r.body), id: decodeURIComponent(m[2]), etag: '"g-2"', conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] } }))
    .on("DELETE", /\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/, () => new Response(null, { status: 204 }));
  return g;
}

/** Runs the whole Google sign-in for one person: start, provider consent (simulated), callback. */
async function connectGoogle(c: CrmOrg, who: CrmWho = "owner") {
  const { url } = await startCalendarOAuth(c.actor(who), "google", { returnPath: "/crm/calendar-connections" });
  const state = new URL(url).searchParams.get("state")!;
  const out = await completeCalendarOAuth({ id: c.people[who].id }, "google", { state, code: "good-code" }, { now: NOW });
  return { ...out, state, url };
}

async function nativeSetup(c: CrmOrg, opts: { meetingProvider?: "google_meet" | "microsoft_teams" | "none"; host?: CrmWho } = {}) {
  const owner = c.actor("owner");
  const host = opts.host ?? "owner";
  await setHostAvailability(owner, c.people[host].id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: `Consults ${crypto.randomUUID().slice(0, 6)}`, assignment: "single", public: true, members: [{ userId: c.people[host].id }] });
  const type = await createAppointmentType(owner, cal.id, {
    name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30,
    locationKind: opts.meetingProvider && opts.meetingProvider !== "none" ? "video" : "phone", meetingProvider: opts.meetingProvider ?? "none",
    questions: [{ key: "budget", label: "Budget", type: "text", required: false }],
  });
  return { calendarId: cal.id, typeId: type.id };
}

const slotsOn = (c: CrmOrg, typeId: string, date = "2026-10-20", excludeAppointmentId: string | null = null) =>
  withSystem(async (db) => {
    const ctx = await loadBookingContext(db, c.org.id, typeId);
    return (await computeSlots(db, ctx, { from: at("00:00", date), to: at("23:59", date), now: NOW, excludeAppointmentId })).map((s) => s.start);
  });

// ---------------------------------------------------------------------------
// iCalendar
// ---------------------------------------------------------------------------

describe("icalendar parsing", () => {
  it("unfolds lines, reads quoted parameters, and unescapes text", () => {
    const text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a@x\r\nSUMMARY:Lunch\\, then \\;review\\nnotes \r\n  continued\r\nATTENDEE;CN=\"Doe, Jane: CEO\";ROLE=CHAIR:mailto:jane@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(unfold(text)).toContain("SUMMARY:Lunch\\, then \\;review\\nnotes  continued");
    const ev = parseIcs(text)[0].components[0];
    expect(unescapeText(prop(ev, "SUMMARY")!.value)).toBe("Lunch, then ;review\nnotes  continued");
    expect(prop(ev, "ATTENDEE")!.params.CN).toEqual(["Doe, Jane: CEO"]);
    expect(prop(ev, "ATTENDEE")!.value).toBe("mailto:jane@example.test");
  });

  it("reads all-day, UTC, TZID and floating times, and DURATION", () => {
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VEVENT", "UID:allday", "DTSTART;VALUE=DATE:20261021", "DTEND;VALUE=DATE:20261022", "END:VEVENT",
      "BEGIN:VEVENT", "UID:utc", "DTSTART:20261020T020000Z", "DTEND:20261020T030000Z", "END:VEVENT",
      "BEGIN:VEVENT", "UID:tzid", "DTSTART;TZID=America/New_York:20261020T090000", "DURATION:PT1H30M", "END:VEVENT",
      "BEGIN:VEVENT", "UID:floating", "DTSTART:20261020T150000", "DTEND:20261020T160000", "END:VEVENT",
      "BEGIN:VEVENT", "UID:vendor", "DTSTART;TZID=/mozilla.org/20050126_1/Europe/London:20261020T090000", "DTEND;TZID=/mozilla.org/20050126_1/Europe/London:20261020T100000", "END:VEVENT",
      "BEGIN:VEVENT", "UID:windows", "DTSTART;TZID=Eastern Standard Time:20261022T090000", "DTEND;TZID=Eastern Standard Time:20261022T100000", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const r = expandCalendar(ics, { from: Date.parse("2026-10-19T00:00:00Z"), to: Date.parse("2026-10-25T00:00:00Z"), defaultTimeZone: "Asia/Manila" });
    const by = Object.fromEntries(r.instances.map((i) => [i.uid, [new Date(i.start).toISOString(), new Date(i.end).toISOString(), i.allDay]]));
    // All day in the owner's zone (Manila, +08:00).
    expect(by.allday).toEqual(["2026-10-20T16:00:00.000Z", "2026-10-21T16:00:00.000Z", true]);
    expect(by.utc).toEqual(["2026-10-20T02:00:00.000Z", "2026-10-20T03:00:00.000Z", false]);
    expect(by.tzid).toEqual(["2026-10-20T13:00:00.000Z", "2026-10-20T14:30:00.000Z", false]);
    expect(by.floating).toEqual(["2026-10-20T07:00:00.000Z", "2026-10-20T08:00:00.000Z", false]);
    expect(by.vendor).toEqual(["2026-10-20T08:00:00.000Z", "2026-10-20T09:00:00.000Z", false]);
    expect(by.windows).toEqual(["2026-10-22T13:00:00.000Z", "2026-10-22T14:00:00.000Z", false]);
    expect(parseDuration("P1W")).toEqual({ sign: 1, weeks: 1, days: 0, seconds: 0 });
    expect(parseDuration("-PT15M")).toEqual({ sign: -1, weeks: 0, days: 0, seconds: 900 });
    expect(parseDuration("P")).toBeNull();
  });

  it("expands a weekly series across a DST change, with an EXDATE, a cancelled instance and a moved one", () => {
    // Tuesdays 09:00 New York from 6 October 2026. DST ends on Sunday 1 November 2026: 13:00Z before, 14:00Z after.
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT", "UID:weekly@example.test", "DTSTART;TZID=America/New_York:20261006T090000", "DTEND;TZID=America/New_York:20261006T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8", "EXDATE;TZID=America/New_York:20261013T090000", "END:VEVENT",
      // 20 October cancelled; 3 November moved to 11:00.
      "BEGIN:VEVENT", "UID:weekly@example.test", "RECURRENCE-ID;TZID=America/New_York:20261020T090000", "DTSTART;TZID=America/New_York:20261020T090000", "DTEND;TZID=America/New_York:20261020T100000", "STATUS:CANCELLED", "END:VEVENT",
      "BEGIN:VEVENT", "UID:weekly@example.test", "RECURRENCE-ID;TZID=America/New_York:20261103T090000", "DTSTART;TZID=America/New_York:20261103T110000", "DTEND;TZID=America/New_York:20261103T120000", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const r = expandCalendar(ics, { from: Date.parse("2026-10-01T00:00:00Z"), to: Date.parse("2026-12-31T00:00:00Z"), defaultTimeZone: "UTC" });
    expect(r.instances.map((i) => new Date(i.start).toISOString())).toEqual([
      "2026-10-06T13:00:00.000Z",
      "2026-10-27T13:00:00.000Z",
      "2026-11-03T16:00:00.000Z", // moved to 11:00 EST
      "2026-11-10T14:00:00.000Z",
      "2026-11-17T14:00:00.000Z",
      "2026-11-24T14:00:00.000Z",
    ]);
    const moved = r.instances.find((i) => i.start === Date.parse("2026-11-03T16:00:00Z"))!;
    expect(new Date(moved.originalStart).toISOString()).toBe("2026-11-03T14:00:00.000Z");
  });

  it("handles UNTIL, monthly and yearly rules, BYSETPOS, invalid dates and transparent or cancelled events", () => {
    const window = { from: Date.parse("2026-01-01T00:00:00Z"), to: Date.parse("2027-12-31T00:00:00Z"), defaultTimeZone: "UTC" };
    const one = (rule: string, start = "20260131T100000Z", extra: string[] = []) =>
      expandCalendar(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:r", `DTSTART:${start}`, "DURATION:PT1H", `RRULE:${rule}`, ...extra, "END:VEVENT", "END:VCALENDAR"].join("\n"), window)
        .instances.map((i) => new Date(i.start).toISOString().slice(0, 10));
    // The 31st only in months that have one.
    expect(one("FREQ=MONTHLY;COUNT=4")).toEqual(["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);
    expect(one("FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20260430T235959Z", "20260130T100000Z")).toEqual(["2026-01-30", "2026-02-27", "2026-03-27", "2026-04-24"]);
    // Last weekday of the month.
    expect(one("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "20260130T100000Z")).toEqual(["2026-01-30", "2026-02-27", "2026-03-31"]);
    expect(one("FREQ=YEARLY;BYMONTH=3;BYDAY=2SU;COUNT=2", "20260308T100000Z")).toEqual(["2026-03-08", "2027-03-14"]);
    expect(one("FREQ=DAILY;INTERVAL=2;COUNT=3", "20260101T100000Z")).toEqual(["2026-01-01", "2026-01-03", "2026-01-05"]);
    expect(one("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4", "20260105T100000Z")).toEqual(["2026-01-05", "2026-01-07", "2026-01-19", "2026-01-21"]);
    expect(one("FREQ=DAILY;COUNT=3", "20260101", ["DTSTART;VALUE=DATE:20260101"]).length).toBe(3);
    expect(parseRRule("FREQ=HOURLY")?.unsupported).toEqual(["FREQ=HOURLY"]);
    expect(parseRRule("FREQ=NEVER")).toBeNull();
    const r = expandCalendar([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT", "UID:free", "DTSTART:20260601T100000Z", "DTEND:20260601T110000Z", "TRANSP:TRANSPARENT", "END:VEVENT",
      "BEGIN:VEVENT", "UID:gone", "DTSTART:20260601T120000Z", "DTEND:20260601T130000Z", "STATUS:CANCELLED", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n"), window);
    expect(r.instances.map((i) => [i.uid, i.transparent])).toEqual([["free", true]]);
  });

  it("only expands inside the window, however old the series", () => {
    const started = performance.now();
    const r = expandCalendar(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:old", "DTSTART;TZID=Asia/Manila:20100104T090000", "DTEND;TZID=Asia/Manila:20100104T093000", "RRULE:FREQ=DAILY", "END:VEVENT", "END:VCALENDAR"].join("\n"), {
      from: Date.parse("2026-10-19T00:00:00Z"), to: Date.parse("2026-10-26T00:00:00Z"), defaultTimeZone: "UTC",
    });
    expect(r.instances).toHaveLength(7);
    expect(new Date(r.instances[0].start).toISOString()).toBe("2026-10-19T01:00:00.000Z");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("uses a calendar's own VTIMEZONE rules for a zone name that isn't IANA", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VTIMEZONE", "TZID:Custom Eastern",
      "BEGIN:STANDARD", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:summer", "DTSTART;TZID=Custom Eastern:20261030T090000", "DTEND;TZID=Custom Eastern:20261030T100000", "END:VEVENT",
      "BEGIN:VEVENT", "UID:winter", "DTSTART;TZID=Custom Eastern:20261102T090000", "DTEND;TZID=Custom Eastern:20261102T100000", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const r = expandCalendar(ics, { from: Date.parse("2026-10-01T00:00:00Z"), to: Date.parse("2026-12-01T00:00:00Z"), defaultTimeZone: "UTC" });
    expect(Object.fromEntries(r.instances.map((i) => [i.uid, new Date(i.start).toISOString()]))).toEqual({ summer: "2026-10-30T13:00:00.000Z", winter: "2026-11-02T14:00:00.000Z" });
    expect(r.unknownZones).toEqual([]);
  });

  it("writes events with CRLF, folding at 75 octets and escaped text, which read back the same", () => {
    const long = "Consultation with Ana — notes; a, b \\ c\nsecond line ".repeat(4);
    const out = serializeEvent({ uid: "iaq-1@iacquire", start: new Date("2026-10-20T02:00:00Z"), end: new Date("2026-10-20T03:00:00Z"), summary: "Site visit with Ana", description: long, dtstamp: new Date("2026-10-19T00:00:00Z") });
    expect(out.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(foldLine("x".repeat(80))).toBe(`${"x".repeat(75)}\r\n ${"x".repeat(5)}`);
    const ev = parseIcs(out)[0].components[0];
    expect(unescapeText(prop(ev, "DESCRIPTION")!.value)).toBe(long);
    expect(prop(ev, "DTSTART")!.value).toBe("20261020T020000Z");
  });
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

describe("google and microsoft sign-in", () => {
  let a: CrmOrg;
  beforeAll(async () => {
    a = await crmOrg({ name: "Calendar Sign-in Co", timezone: "Asia/Manila" });
  });

  it("starts with a hashed single-use state, an encrypted S256 PKCE verifier and least-privilege scopes", async () => {
    const { url } = await startCalendarOAuth(a.actor("sales"), "google", { returnPath: "/crm/calendar-connections" });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = u.searchParams;
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("redirect_uri")).toBe("http://localhost:3000/api/crm/calendar-oauth/google/callback");
    expect(p.get("scope")?.split(" ")).toEqual(["openid", "email", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.freebusy", "https://www.googleapis.com/auth/calendar.events.owned"]);
    const state = p.get("state")!;
    const { rows } = await withSystem((db) => db.query<{ state_hash: string; code_verifier: string; return_path: string; expires_in: number }>(
      "select state_hash, code_verifier, return_path, extract(epoch from expires_at - created_at)::int as expires_in from crm_calendar_oauth_states where user_id = $1", [a.people.sales.id]));
    expect(rows).toHaveLength(1);
    expect(rows[0].state_hash).toBe(sha256(state));
    expect(rows[0].code_verifier.startsWith("v1.")).toBe(true);
    const verifier = decryptSecret(rows[0].code_verifier);
    expect(crypto.createHash("sha256").update(verifier).digest("base64url")).toBe(p.get("code_challenge"));
    expect(rows[0].expires_in).toBe(600);
    expect(rows[0].return_path).toBe("/crm/calendar-connections");
    // The app role can't read sign-in states at all.
    await expect(withUser(a.people.sales.id, (db) => db.query("select 1 from crm_calendar_oauth_states"))).rejects.toThrow();
  });

  it("refuses roles without calendars.connect, agency support sessions, and providers iAcquire hasn't set up", async () => {
    await expect(startCalendarOAuth(a.actor("viewer"), "google")).rejects.toThrow(/role/);
    const agency = await agencyPeople();
    await startSupportSession(agency.superAdmin, a.org.id, { mode: "write", reason: "Checking the calendar setup" });
    const writer = await agencyActor(agency.superAdmin, a.org.id);
    await expect(startCalendarOAuth(writer, "google")).rejects.toThrow(/support can't connect/);
    await expect(connectIcsFeed(writer, { url: "https://feeds.example.com/x.ics" })).rejects.toThrow(/support can't connect/);
    setEnv({ MICROSOFT_CALENDAR_CLIENT_ID: undefined });
    try {
      await expect(startCalendarOAuth(a.actor("owner"), "microsoft")).rejects.toThrow(/isn't set up by iAcquire yet/);
      const ms = calendarConnectionSettings().providers.find((x) => x.key === "microsoft")!;
      expect(ms).toMatchObject({ configured: false });
      expect(ms.unavailableReason).toMatch(/Not set up by iAcquire yet/);
    } finally {
      setEnv({ MICROSOFT_CALENDAR_CLIENT_ID: "00000000-0000-0000-0000-000000000abc" });
    }
  });

  it("completes only for the person who started it, once, and stores the tokens encrypted after a real capability test", async () => {
    googleFake();
    const { url } = await startCalendarOAuth(a.actor("owner"), "google");
    const state = new URL(url).searchParams.get("state")!;
    // Someone else signed in can't use it, and the attempt burns it.
    await expect(completeCalendarOAuth({ id: a.people.sales.id }, "google", { state, code: "good-code" }, { now: NOW })).rejects.toThrow(/different person/);
    await expect(completeCalendarOAuth({ id: a.people.owner.id }, "google", { state, code: "good-code" }, { now: NOW })).rejects.toThrow(/already used or has expired/);
    expect(router.find("POST", /oauth2\.googleapis\.com\/token/)).toHaveLength(0);

    const ok = await connectGoogle(a, "owner");
    expect(ok.outcome).toBe("connected");
    // Replaying the same state fails.
    await expect(completeCalendarOAuth({ id: a.people.owner.id }, "google", { state: ok.state, code: "good-code" }, { now: NOW })).rejects.toThrow(/already used/);
    const exchange = router.find("POST", /oauth2\.googleapis\.com\/token/)[0];
    expect(form(exchange.body)).toMatchObject({ grant_type: "authorization_code", code: "good-code" });
    expect(form(exchange.body).code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // The capability test really ran: calendar list and an availability read, with the new token.
    expect(router.find("GET", /users\/me\/calendarList/)[0].headers.authorization).toBe("Bearer ya29.synthetic-access-1");
    expect(router.find("POST", /freeBusy/)).toHaveLength(1);

    const row = (await withSystem((db) => db.query<{ status: string; credentials: string; account_label: string; provider_account_id: string; conflict_calendar_ids: string[]; external_calendar_id: string; write_events: boolean; scopes: string[] }>(
      "select status, credentials, account_label, provider_account_id, conflict_calendar_ids, external_calendar_id, write_events, scopes from crm_calendar_connections where id = $1", [ok.connectionId]))).rows[0];
    expect(row).toMatchObject({ status: "connected", account_label: PRIMARY, provider_account_id: "google-sub-ana", conflict_calendar_ids: [PRIMARY], external_calendar_id: PRIMARY, write_events: true });
    expect(row.credentials).not.toContain("ya29.synthetic-access-1");
    expect(row.credentials).not.toContain("synthetic-refresh-1");
    expect(JSON.parse(decryptSecret(row.credentials))).toMatchObject({ accessToken: "ya29.synthetic-access-1", refreshToken: "1//synthetic-refresh-1" });
    // The application role can't read the credentials column, even for the person's own connection.
    await expect(withUser(a.people.owner.id, (db) => db.query("select credentials from crm_calendar_connections where id = $1", [ok.connectionId]))).rejects.toThrow();
    const mine = await listMyConnections(a.actor("owner"));
    expect(mine.map((c) => c.id)).toContain(ok.connectionId);
    expect(JSON.stringify(mine)).not.toMatch(/ya29|refresh/);
    const audit = await withSystem((db) => db.query<{ action: string; metadata: unknown }>("select action, metadata from audit_logs where org_id = $1 and action = 'crm.calendar_connected'", [a.org.id]));
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toMatch(/ya29|refresh/);
  });

  it("an expired state, a cancelled consent, or a failed capability test saves nothing", async () => {
    const g = googleFake();
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const first = await startCalendarOAuth(c.actor("owner"), "google");
    const s1 = new URL(first.url).searchParams.get("state")!;
    await withSystem((db) => db.query("update crm_calendar_oauth_states set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' where user_id = $1", [c.people.owner.id]));
    await expect(completeCalendarOAuth({ id: c.people.owner.id }, "google", { state: s1, code: "good-code" })).rejects.toThrow(/expired/);

    const second = await startCalendarOAuth(c.actor("owner"), "google");
    const denied = await completeCalendarOAuth({ id: c.people.owner.id }, "google", { state: new URL(second.url).searchParams.get("state"), error: "access_denied" });
    expect(denied).toMatchObject({ outcome: "denied", connectionId: null });

    router.on("POST", /\/calendar\/v3\/freeBusy$/, () => Response.json({ calendars: { [PRIMARY]: { errors: [{ domain: "global", reason: "notFound" }] } } }));
    const third = await startCalendarOAuth(c.actor("owner"), "google");
    await expect(completeCalendarOAuth({ id: c.people.owner.id }, "google", { state: new URL(third.url).searchParams.get("state"), code: "good-code" }, { now: NOW })).rejects.toThrow(/wasn't connected/);
    expect(router.find("POST", /oauth2\.googleapis\.com\/revoke/)).toHaveLength(1);
    const rows = await withSystem((db) => db.query("select 1 from crm_calendar_connections where org_id = $1", [c.org.id]));
    expect(rows.rows).toHaveLength(0);
    void g;
  });

  it("reconnecting the same account updates the same connection", async () => {
    googleFake();
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const one = await connectGoogle(c, "owner");
    await withSystem((db) => db.query("update crm_calendar_connections set status = 'needs_reauth', last_error = 'expired' where id = $1", [one.connectionId]));
    const two = await connectGoogle(c, "owner");
    expect(two.connectionId).toBe(one.connectionId);
    const rows = await withSystem((db) => db.query<{ status: string; last_error: string | null }>("select status, last_error from crm_calendar_connections where org_id = $1", [c.org.id]));
    expect(rows.rows).toEqual([{ status: "connected", last_error: null }]);
  });

  it("connects Microsoft after a getSchedule read, and falls back to a calendar read for personal accounts", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    router
      .on("POST", /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token$/, (r) => {
        const f = form(r.body);
        expect(f.scope).toContain("offline_access");
        expect(f.code_verifier).toBeTruthy();
        return Response.json({ access_token: "eyJ.synthetic-ms-access", refresh_token: "0.synthetic-ms-refresh", expires_in: 3600, scope: "openid offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite", token_type: "Bearer" });
      })
      .on("GET", /^https:\/\/graph\.microsoft\.com\/v1\.0\/me$/, () => Response.json({ id: "ms-object-1", mail: null, userPrincipalName: "ben@example.test" }))
      .on("GET", /\/v1\.0\/me\/calendars$/, () => Response.json({ value: [{ id: "AAMk-default", name: "Calendar", isDefaultCalendar: true, canEdit: true, allowedOnlineMeetingProviders: ["teamsForBusiness"] }] }))
      .on("POST", /\/v1\.0\/me\/calendar\/getSchedule$/, () => Response.json({ error: { code: "ErrorInvalidRequest", message: "Not supported for this account" } }, { status: 400 }))
      .on("GET", /\/v1\.0\/me\/calendars\/AAMk-default\/calendarView$/, (r) => {
        expect(r.headers.prefer).toBe('outlook.timezone="UTC"');
        return Response.json({ value: [] });
      });
    const { url } = await startCalendarOAuth(c.actor("sales"), "microsoft");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(u.searchParams.get("scope")).toBe("openid offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite");
    const out = await completeCalendarOAuth({ id: c.people.sales.id }, "microsoft", { state: u.searchParams.get("state"), code: "ms-code" }, { now: NOW });
    expect(out.outcome).toBe("connected");
    expect(router.find("POST", /getSchedule/)).toHaveLength(1);
    expect(router.find("GET", /calendarView/)).toHaveLength(1);
    const [conn] = await listMyConnections(c.actor("sales"));
    expect(conn).toMatchObject({ provider: "microsoft", accountLabel: "ben@example.test", writeEvents: true, writeCalendarId: "AAMk-default", canWriteEvents: true });
    expect(conn.calendars[0].meetings).toEqual(["teamsForBusiness"]);
  });
});

describe("microsoft getSchedule mapping", () => {
  it("counts busy, tentative and out-of-office time, ignores free and working-elsewhere, and reads each time zone", async () => {
    router.on("POST", /\/v1\.0\/me\/calendar\/getSchedule$/, (r) => {
      const body = JSON.parse(r.body);
      expect(body).toMatchObject({ schedules: ["ben@example.test"], startTime: { timeZone: "UTC" }, endTime: { timeZone: "UTC" } });
      expect(r.headers.prefer).toBe('outlook.timezone="UTC"');
      return Response.json({ value: [{ scheduleId: "ben@example.test", availabilityView: "0220", scheduleItems: [
        { status: "busy", subject: "private", start: { dateTime: "2026-10-20T02:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-20T03:00:00.0000000", timeZone: "UTC" } },
        { status: "free", start: { dateTime: "2026-10-20T04:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-20T05:00:00.0000000", timeZone: "UTC" } },
        { status: "oof", start: { dateTime: "2026-10-21T09:00:00.0000000", timeZone: "Pacific Standard Time" }, end: { dateTime: "2026-10-21T10:00:00.0000000", timeZone: "Pacific Standard Time" } },
        { status: "tentative", start: { dateTime: "2026-10-22T09:00:00", timeZone: "Asia/Manila" }, end: { dateTime: "2026-10-22T09:30:00", timeZone: "Asia/Manila" } },
        { status: "workingElsewhere", start: { dateTime: "2026-10-23T00:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-24T00:00:00", timeZone: "UTC" } },
      ] }] });
    });
    const auth: AuthSession = { headers: async () => ({ Authorization: "Bearer synthetic" }), refresh: async () => false };
    const busy = await microsoftSchedule(auth, "ben@example.test", NOW, new Date(NOW.getTime() + 7 * 86_400_000));
    expect(busy.map((b) => [new Date(b.start).toISOString(), new Date(b.end).toISOString()])).toEqual([
      ["2026-10-20T02:00:00.000Z", "2026-10-20T03:00:00.000Z"],
      ["2026-10-21T16:00:00.000Z", "2026-10-21T17:00:00.000Z"],
      ["2026-10-22T01:00:00.000Z", "2026-10-22T01:30:00.000Z"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Busy sync
// ---------------------------------------------------------------------------

describe("google busy sync", () => {
  it("keeps only busy times (no titles), skips free, declined, cancelled and our own events, and blocks those times for booking", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const g = googleFake();
    const { typeId } = await nativeSetup(c);
    const conn = await connectGoogle(c);
    g.events = [
      { id: "busy-1", status: "confirmed", summary: "Dentist", start: { dateTime: "2026-10-20T10:00:00+08:00" }, end: { dateTime: "2026-10-20T11:00:00+08:00" } },
      { id: "free-1", status: "confirmed", transparency: "transparent", start: { dateTime: "2026-10-20T12:00:00+08:00" }, end: { dateTime: "2026-10-20T13:00:00+08:00" } },
      { id: "declined-1", attendees: [{ self: true, responseStatus: "declined" }], start: { dateTime: "2026-10-20T13:00:00+08:00" }, end: { dateTime: "2026-10-20T14:00:00+08:00" } },
      { id: "cancelled-1", status: "cancelled" },
      { id: "ours-1", extendedProperties: { private: { iaqAppointment: crypto.randomUUID(), iaqWorkspace: c.org.id } }, start: { dateTime: "2026-10-20T15:00:00+08:00" }, end: { dateTime: "2026-10-20T16:00:00+08:00" } },
      { id: "other-workspace", extendedProperties: { private: { iaqAppointment: crypto.randomUUID(), iaqWorkspace: crypto.randomUUID() } }, start: { dateTime: "2026-10-21T15:00:00+08:00" }, end: { dateTime: "2026-10-21T16:00:00+08:00" } },
      { id: "allday-1", start: { date: "2026-10-22" }, end: { date: "2026-10-23" } },
    ];
    const before = await slotsOn(c, typeId);
    expect(before).toContain("2026-10-20T02:00:00.000Z");
    const out = await syncConnectionBusy(conn.connectionId!, { now: NOW });
    expect(out).toMatchObject({ status: "ok", busy: 3 });
    const rows = (await withSystem((db) => db.query<{ external_ref: string; starts_at: Date; ends_at: Date }>("select external_ref, starts_at, ends_at from crm_external_busy where connection_id = $1 order by starts_at", [conn.connectionId]))).rows;
    expect(rows.map((r) => new Date(r.starts_at).toISOString())).toEqual(["2026-10-20T02:00:00.000Z", "2026-10-21T07:00:00.000Z", "2026-10-21T16:00:00.000Z"]);
    expect(rows[0].external_ref).toBe(externalRef(conn.connectionId!, "busy-1", "2026-10-20T02:00:00.000Z"));
    const cols = await withSystem((db) => db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'crm_external_busy'"));
    expect(cols.rows.map((r) => r.column_name)).not.toContain("title");
    // The busy hour is gone from the booking page; the transparent hour isn't.
    const after = await slotsOn(c, typeId);
    expect(after).not.toContain("2026-10-20T02:00:00.000Z");
    expect(after).toContain("2026-10-20T04:00:00.000Z");
    // All-day (busy) Thursday is closed.
    expect(await slotsOn(c, typeId, "2026-10-22")).toEqual([]);
    const runs = await listSyncRuns(c.actor("owner"));
    expect(runs[0]).toMatchObject({ kind: "busy", status: "ok" });
    expect(runs[0].counts).toMatchObject({ busy: 3, ownSkipped: 1, free: 2 });
  });

  it("checks changes with the sync token, does nothing when nothing changed, and starts over after a 410", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const g = googleFake();
    const conn = await connectGoogle(c);
    g.events = [{ id: "busy-1", start: { dateTime: "2026-10-20T10:00:00+08:00" }, end: { dateTime: "2026-10-20T11:00:00+08:00" } }];
    await syncConnectionBusy(conn.connectionId!, { now: NOW });
    const fullCalls = () => router.calls.filter((r) => /\/events$/.test(r.url.pathname) && r.method === "GET" && !r.url.searchParams.get("syncToken")).length;
    const tokenCalls = () => router.calls.filter((r) => r.url.searchParams.get("syncToken"));
    expect(fullCalls()).toBe(1);
    const state = (await withSystem((db) => db.query<{ sync_cursors: { calendars: Record<string, { syncToken?: string }> } }>("select sync_cursors from crm_calendar_connections where id = $1", [conn.connectionId]))).rows[0].sync_cursors;
    expect(state.calendars[PRIMARY].syncToken).toBe("sync-token-full");

    expect(await syncConnectionBusy(conn.connectionId!, { now: new Date(NOW.getTime() + 600_000) })).toMatchObject({ status: "unchanged" });
    expect(tokenCalls().at(-1)?.url.searchParams.get("syncToken")).toBe("sync-token-full");
    expect(fullCalls()).toBe(1);

    g.incremental = "gone";
    g.events = [...g.events, { id: "busy-2", start: { dateTime: "2026-10-21T10:00:00+08:00" }, end: { dateTime: "2026-10-21T11:00:00+08:00" } }];
    expect(await syncConnectionBusy(conn.connectionId!, { now: new Date(NOW.getTime() + 1_200_000) })).toMatchObject({ status: "ok", busy: 2 });
    expect(fullCalls()).toBe(2);

    g.incremental = "changed";
    g.events = g.events.slice(1);
    expect(await syncConnectionBusy(conn.connectionId!, { now: new Date(NOW.getTime() + 1_800_000) })).toMatchObject({ status: "ok", busy: 1 });
    const left = await withSystem((db) => db.query<{ starts_at: Date }>("select starts_at from crm_external_busy where connection_id = $1", [conn.connectionId]));
    expect(left.rows.map((r) => new Date(r.starts_at).toISOString())).toEqual(["2026-10-21T02:00:00.000Z"]);
  });

  it("refreshes an expired token, and asks the person to reconnect (once) when the refresh is refused", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const g = googleFake();
    const conn = await connectGoogle(c);
    // The provider says the token expired: one refresh, then the read succeeds with the new token.
    g.accessToken = "ya29.rotated-elsewhere";
    router.on("POST", /^https:\/\/oauth2\.googleapis\.com\/token$/, (r) => {
      expect(form(r.body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "1//synthetic-refresh-1" });
      if (g.refreshFails) return Response.json({ error: "invalid_grant" }, { status: 400 });
      g.accessToken = "ya29.synthetic-access-2";
      return Response.json({ access_token: g.accessToken, expires_in: 3599, scope: GOOGLE_SCOPES.join(" ") });
    });
    expect(await syncConnectionBusy(conn.connectionId!, { now: NOW })).toMatchObject({ status: "ok" });
    const creds = (await withSystem((db) => db.query<{ credentials: string }>("select credentials from crm_calendar_connections where id = $1", [conn.connectionId]))).rows[0].credentials;
    expect(creds).not.toContain("ya29.synthetic-access-2");
    expect(JSON.parse(decryptSecret(creds)).accessToken).toBe("ya29.synthetic-access-2");

    g.accessToken = "ya29.revoked";
    g.refreshFails = true;
    expect(await syncConnectionBusy(conn.connectionId!, { now: NOW, force: true })).toMatchObject({ status: "needs_reauth" });
    const row = (await withSystem((db) => db.query<{ status: string; last_error: string }>("select status, last_error from crm_calendar_connections where id = $1", [conn.connectionId]))).rows[0];
    expect(row.status).toBe("needs_reauth");
    expect(row.last_error).toMatch(/invalid_grant/);
    // Nothing more happens until they reconnect, and they're told only once.
    expect(await syncConnectionBusy(conn.connectionId!, { now: NOW })).toMatchObject({ status: "skipped" });
    await withSystem((db) => db.query("update crm_calendar_connections set status = 'connected' where id = $1", [conn.connectionId]));
    await syncConnectionBusy(conn.connectionId!, { now: NOW, force: true });
    const notes = await withSystem((db) => db.query("select title from notifications where user_id = $1 and kind = 'crm_calendar_sync'", [c.people.owner.id]));
    expect(notes.rows).toHaveLength(1);
  });

  it("a saved sign-in that can no longer be decrypted asks the person to reconnect instead of failing silently", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    googleFake();
    const conn = await connectGoogle(c);
    await withSystem((db) => db.query("update crm_calendar_connections set credentials = 'v1.AAAA.BBBB.CCCC' where id = $1", [conn.connectionId]));
    expect(await syncConnectionBusy(conn.connectionId!, { now: NOW })).toMatchObject({ status: "skipped" });
    const row = (await withSystem((db) => db.query<{ status: string }>("select status from crm_calendar_connections where id = $1", [conn.connectionId]))).rows[0];
    expect(row.status).toBe("needs_reauth");
  });

  it("backs off after a rate limit and keeps the connection (and its last busy times) in use", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const g = googleFake();
    const conn = await connectGoogle(c);
    g.events = [{ id: "busy-1", start: { dateTime: "2026-10-20T10:00:00+08:00" }, end: { dateTime: "2026-10-20T11:00:00+08:00" } }];
    await syncConnectionBusy(conn.connectionId!, { now: NOW });
    router.on("GET", /\/calendar\/v3\/calendars\/([^/]+)\/events$/, () => Response.json({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }, { status: 403 }));
    expect(await syncConnectionBusy(conn.connectionId!, { now: NOW, force: true })).toMatchObject({ status: "failed" });
    const row = (await withSystem((db) => db.query<{ status: string; consecutive_failures: number; next_sync_at: Date; last_error: string }>("select status, consecutive_failures, next_sync_at, last_error from crm_calendar_connections where id = $1", [conn.connectionId]))).rows[0];
    expect(row).toMatchObject({ status: "connected", consecutive_failures: 1 });
    expect(row.last_error).toMatch(/slow down/);
    expect(new Date(row.next_sync_at).getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 10 * 60_000);
    const busy = await withSystem((db) => db.query("select 1 from crm_external_busy where connection_id = $1", [conn.connectionId]));
    expect(busy.rows).toHaveLength(1);
  });

  it("the scheduler claims due connections only, and the kill switch stops it without touching anyone", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    googleFake();
    const conn = await connectGoogle(c);
    await withSystem((db) => db.query("update crm_calendar_connections set next_sync_at = now() + interval '1 day' where status = 'connected' and id <> $1", [conn.connectionId]));
    await withSystem((db) => db.query("update crm_calendar_connections set next_sync_at = now() - interval '1 minute' where id = $1", [conn.connectionId]));
    setEnv({ CALENDAR_SYNC_DISABLED: "true" });
    try {
      const before = router.calls.length;
      expect(await syncDueConnections()).toEqual({ synced: 0, failed: 0, paused: true });
      expect(await writeBackDue()).toMatchObject({ paused: true });
      expect(router.calls.length).toBe(before);
      expect(calendarConnectionSettings().syncPaused).toBe(true);
    } finally {
      setEnv({ CALENDAR_SYNC_DISABLED: undefined });
    }
    const out = await syncDueConnections();
    expect(out.synced).toBeGreaterThanOrEqual(1);
    const next = (await withSystem((db) => db.query<{ next_sync_at: Date }>("select next_sync_at from crm_calendar_connections where id = $1", [conn.connectionId]))).rows[0].next_sync_at;
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });

  it("falls back to freebusy.query for a calendar shared with free/busy access only", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const g = googleFake();
    const conn = await connectGoogle(c);
    await updateConnectionOptions(c.actor("owner"), conn.connectionId!, { conflictCalendarIds: [PRIMARY, "team@group.calendar.google.com"] });
    g.events = [{ id: "mine-1", start: { dateTime: "2026-10-20T10:00:00+08:00" }, end: { dateTime: "2026-10-20T11:00:00+08:00" } }];
    router
      .on("GET", /\/calendars\/team%40group\.calendar\.google\.com\/events$/, () => Response.json({ error: { code: 403, errors: [{ reason: "forbidden" }] } }, { status: 403 }))
      .on("POST", /\/calendar\/v3\/freeBusy$/, (r) => {
        expect(JSON.parse(r.body).items).toEqual([{ id: "team@group.calendar.google.com" }]);
        return Response.json({ calendars: { "team@group.calendar.google.com": { busy: [{ start: "2026-10-21T01:00:00Z", end: "2026-10-21T02:00:00Z" }] } } });
      });
    expect(await syncConnectionBusy(conn.connectionId!, { now: NOW })).toMatchObject({ status: "ok", busy: 2 });
    const rows = await withSystem((db) => db.query<{ starts_at: Date }>("select starts_at from crm_external_busy where connection_id = $1 order by starts_at", [conn.connectionId]));
    expect(rows.rows.map((r) => new Date(r.starts_at).toISOString())).toEqual(["2026-10-20T02:00:00.000Z", "2026-10-21T01:00:00.000Z"]);
  });
});

describe("microsoft busy sync", () => {
  it("reads calendarView in UTC and leaves out free time and events this workspace wrote", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    router
      .on("POST", /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token$/, () => Response.json({ access_token: "eyJ.synthetic", refresh_token: "0.synthetic", expires_in: 3600, scope: "openid offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite" }))
      .on("GET", /graph\.microsoft\.com\/v1\.0\/me$/, () => Response.json({ id: "ms-2", mail: "cara@example.test" }))
      .on("GET", /\/v1\.0\/me\/calendars$/, () => Response.json({ value: [{ id: "CAL-1", name: "Calendar", isDefaultCalendar: true, canEdit: true }] }))
      .on("POST", /\/v1\.0\/me\/calendar\/getSchedule$/, () => Response.json({ value: [{ scheduleItems: [] }] }))
      .on("GET", /\/v1\.0\/me\/calendars\/CAL-1\/calendarView$/, () => Response.json({ value: [
        { id: "m-busy", showAs: "busy", start: { dateTime: "2026-10-20T02:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-20T03:00:00.0000000", timeZone: "UTC" } },
        { id: "m-free", showAs: "free", start: { dateTime: "2026-10-20T04:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-20T05:00:00.0000000", timeZone: "UTC" } },
        { id: "m-cancelled", showAs: "busy", isCancelled: true, start: { dateTime: "2026-10-20T06:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-20T07:00:00.0000000", timeZone: "UTC" } },
        { id: "m-ours", showAs: "busy", start: { dateTime: "2026-10-20T07:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-20T08:00:00.0000000", timeZone: "UTC" } },
      ] }));
    const { url } = await startCalendarOAuth(c.actor("owner"), "microsoft");
    const out = await completeCalendarOAuth({ id: c.people.owner.id }, "microsoft", { state: new URL(url).searchParams.get("state"), code: "x" }, { now: NOW });
    // Pretend this workspace wrote "m-ours" for one of its appointments.
    const { typeId } = await nativeSetup(c);
    const page = await bookingPageActor(c.org.id);
    const appt = await bookNativeAppointment(page, { typeId, startAt: at("15:00"), contact: { firstName: "Dee", email: "dee@example.test" }, via: "booking_page", now: NOW });
    await withSystem((db) => db.query("insert into crm_external_events (org_id, appointment_id, connection_id, external_event_id) values ($1, $2, $3, 'm-ours')", [c.org.id, appt.appointmentId, out.connectionId]));
    expect(await syncConnectionBusy(out.connectionId!, { now: NOW })).toMatchObject({ status: "ok", busy: 1 });
    // Microsoft has no per-app revocation endpoint: disconnecting deletes the tokens and says nothing was revoked.
    expect(await disconnectCalendar(c.actor("owner"), out.connectionId!)).toEqual({ revoked: false });
  });
});

// ---------------------------------------------------------------------------
// CalDAV and iCloud
// ---------------------------------------------------------------------------

const RECURRING_ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//EN",
  "BEGIN:VEVENT", "UID:standup@example.test", "DTSTART;TZID=Asia/Manila:20261019T100000", "DTEND;TZID=Asia/Manila:20261019T103000",
  "RRULE:FREQ=DAILY;COUNT=5", "EXDATE;TZID=Asia/Manila:20261021T100000", "SUMMARY:Standup", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

function caldavServer(base: string, opts: { homeHost?: string; requireAuthOnHome?: boolean } = {}) {
  const host = new URL(base).origin;
  const home = `${opts.homeHost ?? host}/calendars/ana/`;
  const store = new Map<string, { body: string; etag: string }>();
  const basic = `Basic ${Buffer.from("ana@example.test:abcd-efgh-ijkl-mnop").toString("base64")}`;
  const esc = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  router
    .on("PROPFIND", esc(`${host}/`), (r) => {
      if (r.headers.authorization !== basic) return new Response(null, { status: 401 });
      return xml(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/ana/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
    })
    .on("PROPFIND", esc(`${host}/principals/ana/`), (r) => {
      if (r.headers.authorization !== basic) return new Response(null, { status: 401 });
      return xml(`<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/ana/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>${home}</d:href></cal:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
    })
    .on("PROPFIND", esc(home), (r) => {
      if (r.headers.authorization !== basic) return new Response(null, { status: 401 });
      return xml(`<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
        <D:response><D:href>/calendars/ana/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
        <D:response><D:href>/calendars/ana/work/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work &amp; clients</D:displayname>
          <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set><D:current-user-privilege-set><D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege></D:current-user-privilege-set><CS:getctag>ctag-1</CS:getctag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
          <D:propstat><D:prop><C:calendar-timezone/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>
        <D:response><D:href>/calendars/ana/tasks/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Tasks</D:displayname><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      </D:multistatus>`);
    })
    .on("PROPFIND", esc(`${opts.homeHost ?? host}/calendars/ana/work/`), () => xml(`<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:response><d:href>/calendars/ana/work/</d:href><d:propstat><d:prop><cs:getctag>ctag-1</cs:getctag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`))
    .on("REPORT", esc(`${opts.homeHost ?? host}/calendars/ana/work/`), (r) => {
      expect(r.headers.depth).toBe("1");
      expect(r.body).toMatch(/<c:time-range start="\d{8}T\d{6}Z" end="\d{8}T\d{6}Z"\/>/);
      const ours = [...store.entries()].map(([href, v]) => `<d:response><d:href>${new URL(href).pathname}</d:href><d:propstat><d:prop><d:getetag>${v.etag}</d:getetag><cal:calendar-data><![CDATA[${v.body}]]></cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("");
      return xml(`<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/ana/work/standup.ics</d:href><d:propstat><d:prop><d:getetag>"s1"</d:getetag><cal:calendar-data>${RECURRING_ICS.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>${ours}</d:multistatus>`);
    })
    .on("PUT", /\/calendars\/ana\/work\/iaq-[0-9a-f]+\.ics$/, (r) => {
      const href = `${r.url.origin}${r.url.pathname}`;
      const cur = store.get(href);
      if (r.headers["if-none-match"] === "*" && cur) return new Response(null, { status: 412 });
      if (r.headers["if-match"] && r.headers["if-match"] !== cur?.etag) return new Response(null, { status: 412 });
      const etag = `"e${(Number(cur?.etag.replace(/\D/g, "") ?? 0) + 1)}"`;
      store.set(href, { body: r.body, etag });
      return new Response(null, { status: cur ? 204 : 201, headers: { etag } });
    })
    .on("DELETE", /\/calendars\/ana\/work\/iaq-[0-9a-f]+\.ics$/, (r) => {
      const href = `${r.url.origin}${r.url.pathname}`;
      if (r.headers["if-match"] && r.headers["if-match"] !== store.get(href)?.etag) return new Response(null, { status: 412 });
      store.delete(href);
      return new Response(null, { status: 204 });
    });
  return { store, home };
}

describe("caldav and icloud", () => {
  it("discovers calendars (principal → home → VEVENT collections), tests a read, and stores the password encrypted", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    caldavServer("https://dav.example.com/");
    const out = await connectCalDav(c.actor("owner"), { preset: "caldav", serverUrl: "https://dav.example.com/", username: "ana@example.test", password: "abcd-efgh-ijkl-mnop" }, { now: NOW });
    expect(out.calendars).toBe(1);
    const [conn] = await listMyConnections(c.actor("owner"));
    expect(conn).toMatchObject({ provider: "caldav", accountLabel: "ana@example.test", writeEvents: false, status: "connected" });
    expect(conn.calendars).toEqual([expect.objectContaining({ id: "https://dav.example.com/calendars/ana/work/", name: "Work & clients", canWrite: true, primary: true })]);
    const creds = (await withSystem((db) => db.query<{ credentials: string }>("select credentials from crm_calendar_connections where id = $1", [conn.id]))).rows[0].credentials;
    expect(creds).not.toContain("abcd-efgh-ijkl-mnop");
    expect(JSON.parse(decryptSecret(creds)).password).toBe("abcd-efgh-ijkl-mnop");

    expect(await syncConnectionBusy(conn.id, { now: NOW })).toMatchObject({ status: "ok", busy: 4 });
    const busy = await withSystem((db) => db.query<{ starts_at: Date }>("select starts_at from crm_external_busy where connection_id = $1 order by starts_at", [conn.id]));
    // Daily at 10:00 Manila for five days, except the 21st.
    expect(busy.rows.map((r) => new Date(r.starts_at).toISOString())).toEqual(["2026-10-19T02:00:00.000Z", "2026-10-20T02:00:00.000Z", "2026-10-22T02:00:00.000Z", "2026-10-23T02:00:00.000Z"]);
    // Unchanged collection tag: no REPORT the second time.
    const reports = () => router.find("REPORT", /work\/$/).length;
    expect(reports()).toBe(2);
    expect(await syncConnectionBusy(conn.id, { now: new Date(NOW.getTime() + 600_000) })).toMatchObject({ status: "unchanged" });
    expect(reports()).toBe(2);
  });

  it("refuses a wrong password without saving, and never sends the password to a host the account doesn't trust", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    caldavServer("https://dav.example.com/");
    await expect(connectCalDav(c.actor("owner"), { preset: "caldav", serverUrl: "https://dav.example.com/", username: "ana@example.test", password: "wrong" })).rejects.toThrow(/didn't accept/);
    caldavServer("https://dav2.example.com/", { homeHost: "https://elsewhere.example.net" });
    await expect(connectCalDav(c.actor("owner"), { preset: "caldav", serverUrl: "https://dav2.example.com/", username: "ana@example.test", password: "abcd-efgh-ijkl-mnop" })).rejects.toThrow();
    const elsewhere = router.calls.filter((r) => r.url.hostname === "elsewhere.example.net");
    expect(elsewhere.length).toBeGreaterThan(0);
    expect(elsewhere.every((r) => !r.headers.authorization)).toBe(true);
    expect((await withSystem((db) => db.query("select 1 from crm_calendar_connections where org_id = $1", [c.org.id]))).rows).toHaveLength(0);
  });

  it("iCloud uses caldav.icloud.com and follows its calendar home to another icloud.com host", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    caldavServer("https://caldav.icloud.com/", { homeHost: "https://p42-caldav.icloud.com" });
    const out = await connectCalDav(c.actor("owner"), { preset: "icloud", username: "ana@example.test", password: " abcd-efgh-ijkl-mnop " }, { now: NOW });
    expect(out.calendars).toBe(1);
    const p42 = router.calls.filter((r) => r.url.hostname === "p42-caldav.icloud.com");
    expect(p42.length).toBeGreaterThan(0);
    expect(p42.every((r) => r.headers.authorization?.startsWith("Basic "))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ICS feeds
// ---------------------------------------------------------------------------

describe("ics feeds", () => {
  it("refuses anything but https to a public host, before any request is made", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    for (const url of ["http://feeds.example.com/a.ics", "https://127.0.0.1/a.ics", "https://169.254.169.254/latest/meta-data", "https://internal-lan.example.com/a.ics", "https://metadata.example.com/a.ics", "https://localhost/a.ics", "https://printer.local/a.ics", "https://feeds.example.com:8443/a.ics", "ftp://feeds.example.com/a.ics", "https://user:pass@feeds.example.com/a.ics"]) {
      await expect(connectIcsFeed(owner, { url })).rejects.toThrow(/https|private|local|public|port|password|address/i);
    }
    expect(router.calls).toHaveLength(0);
    // A redirect to a private address is refused too.
    router.on("GET", /^https:\/\/feeds\.example\.com\/redirect\.ics$/, () => new Response(null, { status: 302, headers: { location: "https://loopback.example.com/secret.ics" } }));
    await expect(connectIcsFeed(owner, { url: "https://feeds.example.com/redirect.ics" })).rejects.toThrow(/private or local/);
    expect(router.calls.map((r) => r.url.hostname)).toEqual(["feeds.example.com"]);
  });

  it("tests and parses the feed before saving, stays read-only, and polls with the ETag", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await nativeSetup(c);
    let served = 0;
    router.on("GET", /^https:\/\/feeds\.example\.com\/ana\.ics$/, (r) => {
      served++;
      if (r.headers["if-none-match"] === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      return new Response(["BEGIN:VCALENDAR", "X-WR-CALNAME:Ana personal", "BEGIN:VEVENT", "UID:p1", "DTSTART;TZID=Asia/Manila:20261020T140000", "DTEND;TZID=Asia/Manila:20261020T150000", "END:VEVENT", "END:VCALENDAR"].join("\r\n"), { status: 200, headers: { "content-type": "text/calendar", etag: '"v1"' } });
    });
    router.on("GET", /^https:\/\/feeds\.example\.com\/page\.html$/, () => new Response("<html>not a calendar</html>", { headers: { "content-type": "text/html" } }));
    await expect(connectIcsFeed(c.actor("owner"), { url: "https://feeds.example.com/page.html" })).rejects.toThrow(/didn't return a calendar/);
    const out = await connectIcsFeed(c.actor("owner"), { url: "webcal://feeds.example.com/ana.ics" }, { now: NOW });
    expect(out.events).toBe(1);
    const [conn] = await listMyConnections(c.actor("owner"));
    expect(conn).toMatchObject({ provider: "ics", accountLabel: "Ana personal", writeEvents: false, canWriteEvents: false });
    await expect(updateConnectionOptions(c.actor("owner"), conn.id, { writeEvents: true, writeCalendarId: "feed" })).rejects.toThrow(/read-only/);
    const creds = (await withSystem((db) => db.query<{ credentials: string; write_events: boolean }>("select credentials, write_events from crm_calendar_connections where id = $1", [conn.id]))).rows[0];
    expect(creds.credentials).not.toContain("feeds.example.com");
    expect(await syncConnectionBusy(conn.id, { now: NOW })).toMatchObject({ status: "ok", busy: 1 });
    expect(await slotsOn(c, typeId)).not.toContain("2026-10-20T06:00:00.000Z");
    expect(await syncConnectionBusy(conn.id, { now: new Date(NOW.getTime() + 600_000) })).toMatchObject({ status: "unchanged" });
    expect(served).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

describe("write-back", () => {
  it("creates the event with a Meet link, updates it when the appointment changes, skips an unchanged one, and deletes it on cancel", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const g = googleFake();
    const { typeId } = await nativeSetup(c, { meetingProvider: "google_meet" });
    const conn = await connectGoogle(c);
    const page = await bookingPageActor(c.org.id);
    const appt = await bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "Ana", lastName: "Reyes", email: "ana.reyes@example.test", phone: "+639171234567" }, answers: { budget: "secret budget answer" }, via: "booking_page", now: NOW });

    expect(await writeBackDue({ now: NOW })).toMatchObject({ written: 1, failed: 0 });
    const insert = router.find("POST", /\/calendars\/[^/]+\/events$/)[0];
    expect(insert.url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(insert.url.searchParams.get("sendUpdates")).toBe("none");
    const body = JSON.parse(insert.body);
    expect(body.summary).toBe("Site visit with Ana");
    expect(body.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: "hangoutsMeet" });
    expect(body.id).toMatch(/^iaq[0-9a-f]{40}$/);
    expect(body.attendees).toBeUndefined();
    expect(insert.body).not.toMatch(/secret budget answer|ana\.reyes@example\.test|\+639171234567|Reyes/);
    expect(body.description).toContain(`/crm/calendar?appointment=${appt.appointmentId}`);
    const ref = (await withSystem((db) => db.query<{ meeting_link: string | null }>("select meeting_link from appointment_refs where id = $1", [appt.appointmentId]))).rows[0];
    expect(ref.meeting_link).toBe("https://meet.google.com/abc-defg-hij");
    const ev = (await withSystem((db) => db.query<{ external_event_id: string; content_hash: string; meeting_link: string; remote_calendar_id: string }>("select external_event_id, content_hash, meeting_link, remote_calendar_id from crm_external_events where appointment_id = $1", [appt.appointmentId]))).rows[0];
    expect(ev).toMatchObject({ external_event_id: body.id, meeting_link: "https://meet.google.com/abc-defg-hij", remote_calendar_id: PRIMARY });

    // Nothing pending: a second pass sends nothing.
    expect(await writeBackDue({ now: NOW })).toMatchObject({ written: 0 });
    // Something touched the appointment without changing what's written: hash is the same, so no request.
    await withSystem((db) => db.query("update appointment_refs set last_event_at = now() + interval '1 minute' where id = $1", [appt.appointmentId]));
    const writesBefore = router.calls.filter((r) => r.method !== "GET").length;
    expect(await writeBackDue({ now: NOW })).toMatchObject({ written: 0, failed: 0 });
    expect(router.calls.filter((r) => r.method !== "GET").length).toBe(writesBefore);

    // Rescheduled: one PATCH of the same event, no new conference request.
    await rescheduleNativeAppointment(c.actor("owner"), appt.appointmentId, { startAt: at("13:00"), by: "staff", now: NOW });
    expect(await writeBackDue({ now: NOW })).toMatchObject({ written: 1 });
    const patch = router.find("PATCH", /\/events\/iaq[0-9a-f]+$/);
    expect(patch).toHaveLength(1);
    const patched = JSON.parse(patch[0].body);
    expect(patched.start.dateTime).toBe("2026-10-20T05:00:00.000Z");
    expect(patched.conferenceData).toBeUndefined();
    const after = (await withSystem((db) => db.query<{ content_hash: string }>("select content_hash from crm_external_events where appointment_id = $1", [appt.appointmentId]))).rows[0];
    expect(after.content_hash).not.toBe(ev.content_hash);

    // Our own event never counts as busy (or the appointment would block its own reschedule).
    g.events = [
      { id: body.id, extendedProperties: { private: { iaqAppointment: appt.appointmentId, iaqWorkspace: c.org.id } }, start: { dateTime: "2026-10-20T13:00:00+08:00" }, end: { dateTime: "2026-10-20T14:00:00+08:00" } },
      { id: "foreign", start: { dateTime: "2026-10-20T15:00:00+08:00" }, end: { dateTime: "2026-10-20T16:00:00+08:00" } },
    ];
    await syncConnectionBusy(conn.connectionId!, { now: NOW, force: true });
    const free = await slotsOn(c, typeId, "2026-10-20", appt.appointmentId);
    expect(free).toContain("2026-10-20T05:00:00.000Z");
    expect(free).not.toContain("2026-10-20T07:00:00.000Z");

    // Cancelled: the remote event is deleted; the record of it stays.
    await cancelNativeAppointment(c.actor("owner"), appt.appointmentId, { by: "staff", now: NOW });
    expect(await writeBackDue({ now: NOW })).toMatchObject({ deleted: 1 });
    expect(router.find("DELETE", /\/events\/iaq[0-9a-f]+$/)).toHaveLength(1);
    const gone = (await withSystem((db) => db.query<{ content_hash: string }>("select content_hash from crm_external_events where appointment_id = $1", [appt.appointmentId]))).rows[0];
    expect(gone.content_hash).toBe(DELETED_HASH);
    expect(await writeBackDue({ now: NOW })).toMatchObject({ written: 0, deleted: 0 });
    const runs = await listSyncRuns(c.actor("owner"));
    expect(runs.some((r) => r.kind === "write" && r.status === "ok")).toBe(true);
  });

  it("stores a meeting link only when the provider actually returns one", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    googleFake();
    let ready = false;
    router
      .on("POST", /\/calendar\/v3\/calendars\/([^/]+)\/events$/, (r) => Response.json({ ...JSON.parse(r.body), etag: '"p1"', conferenceData: { createRequest: { requestId: "x", status: { statusCode: "pending" } } } }))
      .on("GET", /\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/, () => Response.json(ready ? { conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/later-link" }] } } : { conferenceData: { createRequest: { status: { statusCode: "pending" } } } }));
    const { typeId } = await nativeSetup(c, { meetingProvider: "google_meet" });
    await connectGoogle(c);
    const page = await bookingPageActor(c.org.id);
    const appt = await bookNativeAppointment(page, { typeId, startAt: at("11:00"), contact: { firstName: "Bo", email: "bo@example.test" }, via: "booking_page", now: NOW });
    await writeBackDue({ now: NOW });
    const link = async () => (await withSystem((db) => db.query<{ a: string | null; e: string | null; err: string | null }>("select a.meeting_link as a, e.meeting_link as e, e.last_error as err from appointment_refs a join crm_external_events e on e.appointment_id = a.id where a.id = $1", [appt.appointmentId]))).rows[0];
    expect(await link()).toEqual({ a: null, e: null, err: "meeting_pending" });
    // Checked again a little later: still pending, still nothing invented.
    await withSystem((db) => db.query("update crm_external_events set updated_at = $2 where appointment_id = $1", [appt.appointmentId, NOW]));
    await writeBackDue({ now: new Date(NOW.getTime() + 120_000) });
    expect(await link()).toEqual({ a: null, e: null, err: "meeting_pending" });
    expect(router.find("GET", /\/events\/iaq[0-9a-f]+$/)).toHaveLength(1);
    ready = true;
    await writeBackDue({ now: new Date(NOW.getTime() + 240_000) });
    expect(await link()).toEqual({ a: "https://meet.google.com/later-link", e: "https://meet.google.com/later-link", err: null });
  });

  it("writes to CalDAV with If-None-Match, updates with If-Match, and deletes on cancel", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const dav = caldavServer("https://dav.example.com/");
    const { typeId } = await nativeSetup(c, { meetingProvider: "google_meet" });
    const { id } = await connectCalDav(c.actor("owner"), { preset: "caldav", serverUrl: "https://dav.example.com/", username: "ana@example.test", password: "abcd-efgh-ijkl-mnop" }, { now: NOW });
    await updateConnectionOptions(c.actor("owner"), id, { writeEvents: true, writeCalendarId: "https://dav.example.com/calendars/ana/work/" });
    const page = await bookingPageActor(c.org.id);
    const appt = await bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "Cy", email: "cy@example.test" }, via: "booking_page", now: NOW });
    expect(await writeBackDue({ now: NOW })).toMatchObject({ written: 1 });
    const put = router.find("PUT", /iaq-[0-9a-f]+\.ics$/);
    expect(put[0].headers["if-none-match"]).toBe("*");
    expect(put[0].headers["content-type"]).toMatch(/text\/calendar/);
    expect(put[0].body).toContain("SUMMARY:Site visit with Cy");
    expect(put[0].body).toContain("DTSTART:20261020T020000Z");
    // CalDAV can't create meeting links, so none is stored.
    expect((await withSystem((db) => db.query<{ meeting_link: string | null }>("select meeting_link from appointment_refs where id = $1", [appt.appointmentId]))).rows[0].meeting_link).toBeNull();
    // Our own event in the calendar is skipped by the busy read.
    await syncConnectionBusy(id, { now: NOW, force: true });
    const runs = await listSyncRuns(c.actor("owner"), { connectionId: id });
    expect(runs.find((r) => r.kind === "busy")?.counts.ownSkipped).toBe(1);

    await rescheduleNativeAppointment(c.actor("owner"), appt.appointmentId, { startAt: at("14:00"), by: "staff", now: NOW });
    await writeBackDue({ now: NOW });
    expect(router.find("PUT", /iaq-[0-9a-f]+\.ics$/).at(-1)!.headers["if-match"]).toBe('"e1"');
    expect([...dav.store.values()][0].body).toContain("DTSTART:20261020T060000Z");
    await cancelNativeAppointment(c.actor("owner"), appt.appointmentId, { by: "staff", now: NOW });
    expect(await writeBackDue({ now: NOW })).toMatchObject({ deleted: 1 });
    expect(router.find("DELETE", /iaq-[0-9a-f]+\.ics$/)[0].headers["if-match"]).toBe('"e2"');
    expect(dav.store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Options, disconnecting and isolation
// ---------------------------------------------------------------------------

describe("options, disconnecting and tenant isolation", () => {
  it("only the owner changes options, with validation; disconnect clears busy times and credentials but keeps the history", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const g = googleFake();
    const { typeId } = await nativeSetup(c, { host: "sales" });
    const conn = await connectGoogle(c, "sales");
    const id = conn.connectionId!;
    await expect(updateConnectionOptions(c.actor("owner"), id, { checkConflicts: false })).rejects.toThrow(/Only the person/);
    await expect(updateConnectionOptions(c.actor("sales"), id, { conflictCalendarIds: ["nope@example.test"] })).rejects.toThrow(/isn't in this account/);
    await expect(updateConnectionOptions(c.actor("sales"), id, { conflictCalendarIds: [] })).rejects.toThrow(/at least one/);
    await expect(updateConnectionOptions(c.actor("sales"), id, { writeEvents: true, writeCalendarId: "team@group.calendar.google.com" })).rejects.toThrow(/can add events to/);
    const v = await updateConnectionOptions(c.actor("sales"), id, { conflictCalendarIds: [PRIMARY, "team@group.calendar.google.com"] });
    expect(v.conflictCalendarIds).toEqual([PRIMARY, "team@group.calendar.google.com"]);

    g.events = [{ id: "busy-1", start: { dateTime: "2026-10-20T10:00:00+08:00" }, end: { dateTime: "2026-10-20T11:00:00+08:00" } }];
    await syncConnectionBusy(id, { now: NOW });
    expect(await slotsOn(c, typeId)).not.toContain("2026-10-20T02:00:00.000Z");
    const page = await bookingPageActor(c.org.id);
    const appt = await bookNativeAppointment(page, { typeId, startAt: at("15:00"), contact: { firstName: "Di", email: "di@example.test" }, via: "booking_page", now: NOW });
    await writeBackDue({ now: NOW });

    // Another person (without calendars.manage) can't disconnect it; a manager can, and the owner is told.
    await expect(disconnectCalendar(c.actor("setter"), id)).rejects.toThrow(/workspace manager/);
    const team = await listTeamConnections(c.actor("manager"));
    expect(team.map((t) => t.id)).toContain(id);
    await expect(listTeamConnections(c.actor("sales"))).rejects.toThrow(/role/);
    const res = await disconnectCalendar(c.actor("manager"), id);
    expect(res.revoked).toBe(true);
    expect(form(router.find("POST", /oauth2\.googleapis\.com\/revoke/).at(-1)!.body).token).toBe("1//synthetic-refresh-1");
    const row = (await withSystem((db) => db.query<{ status: string; credentials: string | null; write_events: boolean; disconnected_at: Date | null }>("select status, credentials, write_events, disconnected_at from crm_calendar_connections where id = $1", [id]))).rows[0];
    expect(row).toMatchObject({ status: "disconnected", credentials: null, write_events: false });
    expect(row.disconnected_at).not.toBeNull();
    expect((await withSystem((db) => db.query("select 1 from crm_external_busy where connection_id = $1", [id]))).rows).toHaveLength(0);
    expect((await withSystem((db) => db.query("select 1 from crm_external_events where connection_id = $1 and appointment_id = $2", [id, appt.appointmentId]))).rows).toHaveLength(1);
    expect(await slotsOn(c, typeId)).toContain("2026-10-20T02:00:00.000Z");
    expect((await withSystem((db) => db.query("select 1 from notifications where user_id = $1 and kind = 'crm_calendar_sync' and title like '%disconnected%'", [c.people.sales.id]))).rows).toHaveLength(1);
    expect(await listMyConnections(c.actor("sales"))).toEqual([]);
    // Nothing is written to a disconnected calendar.
    await cancelNativeAppointment(c.actor("owner"), appt.appointmentId, { by: "staff", now: NOW });
    const deletes = router.find("DELETE", /\/events\//).length;
    await writeBackDue({ now: NOW });
    expect(router.find("DELETE", /\/events\//).length).toBe(deletes);
    await expect(syncConnectionBusy(id, { now: NOW })).resolves.toMatchObject({ status: "skipped" });
  });

  it("keeps each workspace's connections, busy times and history to itself", async () => {
    const a = await crmOrg({ timezone: "Asia/Manila" });
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const g = googleFake();
    const conn = await connectGoogle(a, "owner");
    g.events = [{ id: "busy-1", start: { dateTime: "2026-10-20T10:00:00+08:00" }, end: { dateTime: "2026-10-20T11:00:00+08:00" } }];
    await syncConnectionBusy(conn.connectionId!, { now: NOW });
    await expect(updateConnectionOptions(b.actor("owner"), conn.connectionId!, { checkConflicts: false })).rejects.toThrow(/no longer exists/);
    await expect(disconnectCalendar(b.actor("owner"), conn.connectionId!)).rejects.toThrow(/no longer exists/);
    expect(await listTeamConnections(b.actor("owner"))).toEqual([]);
    expect(await listSyncRuns(b.actor("owner"))).toEqual([]);
    for (const table of ["crm_calendar_connections", "crm_external_busy", "crm_calendar_sync_runs"]) {
      const seen = await withUser(b.people.owner.id, (db) => db.query<{ org_id: string }>(`select org_id from ${table}`));
      expect(seen.rows.every((r) => r.org_id === b.org.id)).toBe(true);
    }
    // Inside one workspace, a teammate without calendars.manage doesn't see someone else's connection.
    const peer = await withUser(a.people.sales.id, (db) => db.query("select id from crm_calendar_connections where id = $1", [conn.connectionId]));
    expect(peer.rows).toHaveLength(0);
    const mgr = await withUser(a.people.manager.id, (db) => db.query("select id from crm_calendar_connections where id = $1", [conn.connectionId]));
    expect(mgr.rows).toHaveLength(1);
    // And the app role can never write these tables.
    await expect(withUser(a.people.owner.id, (db) => db.query("update crm_calendar_connections set status = 'connected' where id = $1", [conn.connectionId]))).rejects.toThrow();
    await expect(withUser(a.people.owner.id, (db) => db.query("delete from crm_external_busy where connection_id = $1", [conn.connectionId]))).rejects.toThrow();
  });
});

describe("microsoft teams write-back", () => {
  it("asks Graph for a Teams meeting on the host's own calendar and stores the join link it returns", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    let withLink = true;
    router
      .on("POST", /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token$/, () => Response.json({ access_token: "eyJ.synthetic", refresh_token: "0.synthetic", expires_in: 3600, scope: "openid offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite" }))
      .on("GET", /graph\.microsoft\.com\/v1\.0\/me$/, () => Response.json({ id: "ms-3", mail: "eve@example.test" }))
      .on("GET", /\/v1\.0\/me\/calendars$/, () => Response.json({ value: [{ id: "CAL-T", name: "Calendar", isDefaultCalendar: true, canEdit: true, allowedOnlineMeetingProviders: ["teamsForBusiness"] }] }))
      .on("POST", /\/v1\.0\/me\/calendar\/getSchedule$/, () => Response.json({ value: [{ scheduleItems: [] }] }))
      .on("POST", /\/v1\.0\/me\/calendars\/CAL-T\/events$/, (r) => {
        const body = JSON.parse(r.body);
        return Response.json({ ...body, id: `ev-${crypto.randomUUID()}`, "@odata.etag": 'W/"1"', isOnlineMeeting: true, onlineMeeting: withLink ? { joinUrl: "https://teams.microsoft.com/l/meetup-join/synthetic" } : null }, { status: 201 });
      });
    const { typeId } = await nativeSetup(c, { meetingProvider: "microsoft_teams" });
    const { url } = await startCalendarOAuth(c.actor("owner"), "microsoft");
    await completeCalendarOAuth({ id: c.people.owner.id }, "microsoft", { state: new URL(url).searchParams.get("state"), code: "x" }, { now: NOW });
    const page = await bookingPageActor(c.org.id);
    const one = await bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "Gil", email: "gil@example.test" }, via: "booking_page", now: NOW });
    expect(await writeBackDue({ now: NOW })).toMatchObject({ written: 1 });
    const post = JSON.parse(router.find("POST", /\/me\/calendars\/CAL-T\/events$/)[0].body);
    expect(post).toMatchObject({ subject: "Site visit with Gil", isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness", start: { dateTime: "2026-10-20T02:00:00.000", timeZone: "UTC" } });
    expect(post.transactionId).toMatch(/^iaq-[0-9a-f]{32}$/);
    const link = async (id: string) => (await withSystem((db) => db.query<{ meeting_link: string | null }>("select meeting_link from appointment_refs where id = $1", [id]))).rows[0].meeting_link;
    expect(await link(one.appointmentId)).toBe("https://teams.microsoft.com/l/meetup-join/synthetic");
    // A meeting Graph didn't return a link for leaves the appointment without one.
    withLink = false;
    router.on("GET", /\/v1\.0\/me\/events\/[^/]+$/, () => Response.json({ id: "x", isOnlineMeeting: true, onlineMeeting: null }));
    const two = await bookNativeAppointment(page, { typeId, startAt: at("13:00"), contact: { firstName: "Hal", email: "hal@example.test" }, via: "booking_page", now: NOW });
    await writeBackDue({ now: NOW });
    expect(await link(two.appointmentId)).toBeNull();
  });
});

describe("oauth routes", () => {
  const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost:3000${path}`, { headers });
  const params = (provider: string) => ({ params: Promise.resolve({ provider }) });

  it("start refuses unknown providers and sign-ins started from another site", async () => {
    expect((await oauthStart(req("/api/crm/calendar-oauth/yahoo/start"), params("yahoo"))).status).toBe(404);
    const res = await oauthStart(req("/api/crm/calendar-oauth/google/start", { "sec-fetch-site": "cross-site" }), params("google"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/crm/calendar-connections");
    expect(decodeURIComponent(decodeURIComponent(res.headers.get("set-cookie") ?? ""))).toMatch(/iaq_calendar_notice=.*didn't start from iAcquire/);
    expect(router.calls).toHaveLength(0);
  });

  it("the callback finishes for the signed-in person, runs the first sync, and never echoes the code", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const g = googleFake();
    g.events = [{ id: "busy-1", start: { dateTime: "2026-10-20T10:00:00+08:00" }, end: { dateTime: "2026-10-20T11:00:00+08:00" } }];
    const { url } = await startCalendarOAuth(c.actor("owner"), "google", { returnPath: "/crm/calendar-connections?tab=mine" });
    const state = new URL(url).searchParams.get("state")!;
    session.user = null;
    const anon = await oauthCallback(req(`/api/crm/calendar-oauth/google/callback?state=${state}&code=good-code`), params("google"));
    expect(anon.headers.get("location")).toMatch(/\/login\?next=/);
    session.user = { id: c.people.owner.id };
    try {
      const res = await oauthCallback(req(`/api/crm/calendar-oauth/google/callback?state=${state}&code=good-code&scope=x`), params("google"));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("http://localhost:3000/crm/calendar-connections?tab=mine");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("location")).not.toContain("good-code");
      expect(decodeURIComponent(decodeURIComponent(res.headers.get("set-cookie") ?? ""))).toContain("is connected");
      const [conn] = await listMyConnections(c.actor("owner"));
      expect(conn.lastSuccessAt).not.toBeNull();
      expect((await withSystem((db) => db.query("select 1 from crm_external_busy where connection_id = $1", [conn.id]))).rows).toHaveLength(1);
      // A replay of the same callback is refused, with a message and no new connection.
      const again = await oauthCallback(req(`/api/crm/calendar-oauth/google/callback?state=${state}&code=good-code`), params("google"));
      expect(decodeURIComponent(decodeURIComponent(again.headers.get("set-cookie") ?? ""))).toMatch(/already used/);
      expect(await listMyConnections(c.actor("owner"))).toHaveLength(1);
    } finally {
      session.user = null;
    }
  });
});

describe("calendar connections screen", () => {
  const scope = (over: Partial<CrmScope> = {}): CrmScope => ({
    base: "/crm", orgId: null, agency: false, readOnly: false, userId: "u1", timezone: "Asia/Manila", currency: "PHP",
    can: { "appointments.view": true, "calendars.connect": true }, ...over,
  });
  const conn = (over: Partial<ConnectionView>): ConnectionView => ({
    id: crypto.randomUUID(), userId: "u1", userName: null, provider: "google", accountLabel: "ana@example.test", status: "connected",
    lastSyncedAt: "2026-10-19T00:00:00.000Z", lastSuccessAt: "2026-10-19T00:00:00.000Z", lastError: null, consecutiveFailures: 0,
    checkConflicts: true, conflictCalendarIds: ["primary"], writeEvents: true, writeCalendarId: "primary",
    calendars: [{ id: "primary", name: "Ana", primary: true, canWrite: true, timezone: "Asia/Manila" }], canWriteEvents: true, nextSyncAt: null,
    createdAt: "2026-10-01T00:00:00.000Z", ...over,
  });
  const settings = () => {
    const s = calendarConnectionSettings();
    return { ...s, providers: s.providers.map((p) => (p.key === "microsoft" ? { ...p, configured: false, unavailableReason: "Not set up by iAcquire yet. An administrator adds it." } : p)) };
  };
  const html = (props: Partial<React.ComponentProps<typeof CalendarConnectionsWorkspace>>) =>
    renderToStaticMarkup(React.createElement(CalendarConnectionsWorkspace, {
      scope: scope(), settings: settings(), mine: [], team: [], runs: [], canConnect: true, notice: null, renderedAt: "2026-10-19T00:10:00.000Z", ...props,
    })).replace(/<!-- -->/g, "");

  it("offers each provider honestly: a real link for configured OAuth, no fake connect for one that isn't set up", () => {
    const out = html({});
    expect(out).toContain('href="/api/crm/calendar-oauth/google/start?return=%2Fcrm%2Fcalendar-connections"');
    expect(out).not.toContain("/api/crm/calendar-oauth/microsoft/start");
    expect(out).toContain("Not set up by iAcquire yet");
    expect(out).toContain("No calendars connected yet");
    expect(out).toMatch(/ICS feed \(read-only\)/);
    expect(out).toContain("refreshed on a schedule rather than instantly");
  });

  it("shows status in words that don't overstate it, and the right actions for each", () => {
    const out = html({
      mine: [
        conn({ status: "needs_reauth", lastError: "Google no longer accepts the saved sign-in (invalid_grant)." }),
        conn({ provider: "ics", accountLabel: "Personal feed", writeEvents: false, writeCalendarId: null, canWriteEvents: false, calendars: [{ id: "feed", name: "Personal feed", primary: true, canWrite: false, timezone: null }], conflictCalendarIds: ["feed"] }),
        conn({ accountLabel: "flaky@example.test", consecutiveFailures: 2, lastError: "Google Calendar asked us to slow down." }),
      ],
      runs: [{ id: "1", connectionId: "gone", kind: "busy", status: "ok", startedAt: "2026-10-19T00:05:00.000Z", finishedAt: "2026-10-19T00:05:01.000Z", counts: { busy: 3, ownSkipped: 1 }, error: null }],
    });
    expect(out).toContain("Reconnect needed");
    expect(out).toContain("aren&#x27;t checked, and nothing is added to it, until you reconnect");
    expect(out).toMatch(/href="\/api\/crm\/calendar-oauth\/google\/start[^"]*"[^>]*>.*Reconnect/);
    expect(out).toContain("read-only, updates about every 30 minutes (not instant)");
    expect(out).toContain("Connected · last sync failed");
    expect(out).toContain("3 busy times · 1 iAcquire appointment skipped");
    // Nothing secret ever reaches the page.
    expect(out).not.toMatch(/ya29|1\/\/|refresh_token|credentials/i);
  });

  it("in a support session shows the team's connections but no way to connect anyone's calendar", () => {
    const out = html({
      scope: scope({ agency: true, orgId: crypto.randomUUID(), userId: "agent", can: { "appointments.view": true, "calendars.manage": true } }),
      canConnect: false,
      team: [conn({ userId: "u2", userName: "Ben Cruz", provider: "microsoft", accountLabel: "ben@example.test" })],
    });
    expect(out).toContain("Support view");
    expect(out).toContain("Ben Cruz");
    expect(out).not.toContain("Connect a calendar");
    expect(out).not.toContain("/api/crm/calendar-oauth/");
    expect(out).toContain("Disconnect Ben Cruz");
  });
});

// ---------------------------------------------------------------------------
// Review fixes (Phase 2 scheduling review): each test failed before its fix
// ---------------------------------------------------------------------------

const bearer: AuthSession = { headers: async () => ({ Authorization: "Bearer ya29.synthetic-direct" }), refresh: async () => false };
const busyQuery = (over: Partial<BusyQuery> = {}): BusyQuery => ({
  calendarIds: [PRIMARY], from: NOW, to: new Date(NOW.getTime() + 7 * 86_400_000), cursors: {}, forceFull: false, isOwnEvent: () => false, timeZone: "Asia/Manila", ...over,
});
/** writeBackDue works across every workspace in the shared test database: earlier tests' connections stop writing so counts are this test's. */
const onlyThisWorkspaceWrites = (c: CrmOrg) => withSystem((db) => db.query("update crm_calendar_connections set write_events = false where org_id <> $1", [c.org.id]));
const davXml = (entries: Array<{ href: string; body: string }>) =>
  xml(`<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${entries.map((e) => `<d:response><d:href>${e.href}</d:href><d:propstat><d:prop><d:getetag>"x"</d:getetag><cal:calendar-data>${e.body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`);

describe("review fixes: Outlook and Exchange time zones", () => {
  it("reads VTIMEZONE rules whose onsets are dated 1601 (Exchange's 'Customized Time Zone' and unmapped Windows zones)", () => {
    const window = { from: Date.parse("2026-10-01T00:00:00Z"), to: Date.parse("2026-12-01T00:00:00Z") };
    const customized = [
      "BEGIN:VCALENDAR", "METHOD:PUBLISH", "PRODID:Microsoft Exchange Server 2010", "VERSION:2.0",
      "BEGIN:VTIMEZONE", "TZID:Customized Time Zone",
      "BEGIN:STANDARD", "DTSTART:16010101T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3", "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:summer", "DTSTART;TZID=Customized Time Zone:20261020T090000", "DTEND;TZID=Customized Time Zone:20261020T100000", "END:VEVENT",
      "BEGIN:VEVENT", "UID:winter", "DTSTART;TZID=Customized Time Zone:20261102T090000", "DTEND;TZID=Customized Time Zone:20261102T100000", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    // The host is in Manila: falling back to their zone would put 09:00 at 01:00Z.
    const r = expandCalendar(customized, { ...window, defaultTimeZone: "Asia/Manila" });
    expect(r.unknownZones).toEqual([]);
    expect(Object.fromEntries(r.instances.map((i) => [i.uid, new Date(i.start).toISOString()]))).toEqual({ summer: "2026-10-20T13:00:00.000Z", winter: "2026-11-02T14:00:00.000Z" });

    // Lagos has no daylight time and its Windows name isn't one we map: only the calendar's own (1601) rules say +01:00.
    const lagos = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VTIMEZONE", "TZID:W. Central Africa Standard Time",
      "BEGIN:STANDARD", "DTSTART:16010101T000000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:16010101T000000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:lagos", "DTSTART;TZID=W. Central Africa Standard Time:20261020T090000", "DTEND;TZID=W. Central Africa Standard Time:20261020T100000", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const l = expandCalendar(lagos, { ...window, defaultTimeZone: "America/New_York" });
    expect(l.unknownZones).toEqual([]);
    expect(new Date(l.instances[0].start).toISOString()).toBe("2026-10-20T08:00:00.000Z");
  });
});

describe("review fixes: write-back", () => {
  it("a reschedule that commits while the create is in flight is written on the next pass (versions, not clock times)", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    googleFake();
    const { typeId } = await nativeSetup(c);
    await connectGoogle(c);
    await onlyThisWorkspaceWrites(c);
    const page = await bookingPageActor(c.org.id);
    const appt = await bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "Ivy", email: "ivy@example.test" }, via: "booking_page", now: NOW });
    let moved = false;
    router.on("POST", /\/calendar\/v3\/calendars\/([^/]+)\/events$/, async (r) => {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      if (!moved) {
        moved = true;
        // Staff move it to 13:00 while Google is still answering the create for 10:00.
        await rescheduleNativeAppointment(c.actor("owner"), appt.appointmentId, { startAt: at("13:00"), by: "staff", now: NOW });
      }
      return Response.json({ ...body, etag: '"g-1"' });
    });
    expect(await writeBackDue({ now: NOW })).toMatchObject({ written: 1, failed: 0 });
    expect(JSON.parse(router.find("POST", /\/events$/)[0].body).start.dateTime).toBe("2026-10-20T02:00:00.000Z");
    // The database clock isn't the test's NOW: date the write at NOW, so the six-hourly re-check isn't what picks the change up.
    await withSystem((db) => db.query("update crm_external_events set synced_at = $2 where appointment_id = $1", [appt.appointmentId, NOW]));
    // The event was built from the old version, so the next pass moves it.
    expect(await writeBackDue({ now: NOW })).toMatchObject({ written: 1, failed: 0 });
    const patch = router.find("PATCH", /\/events\/iaq[0-9a-f]+$/);
    expect(patch).toHaveLength(1);
    expect(JSON.parse(patch[0].body).start.dateTime).toBe("2026-10-20T05:00:00.000Z");
    const row = (await withSystem((db) => db.query<{ written_version: number; version: number }>(
      "select e.written_version, a.version from crm_external_events e join appointment_refs a on a.id = e.appointment_id where e.appointment_id = $1", [appt.appointmentId],
    ))).rows[0];
    expect(row.written_version).toBe(row.version);
    expect(await writeBackDue({ now: NOW })).toMatchObject({ written: 0 });
  });
});

describe("review fixes: our own events read back through another connection", () => {
  it("an ICS feed of a calendar this workspace writes to leaves our appointments out (Google export UIDs and iAcquire markers)", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    googleFake();
    const { typeId } = await nativeSetup(c);
    await connectGoogle(c);
    await onlyThisWorkspaceWrites(c);
    const page = await bookingPageActor(c.org.id);
    const appt = await bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "Jo", email: "jo@example.test" }, via: "booking_page", now: NOW });
    await writeBackDue({ now: NOW });
    const googleId = JSON.parse(router.find("POST", /\/events$/)[0].body).id as string;
    router.on("GET", /^https:\/\/feeds\.example\.com\/ana\.ics$/, () => new Response([
      "BEGIN:VCALENDAR", "VERSION:2.0",
      // Google's iCalendar export of the event written through the Google connection.
      "BEGIN:VEVENT", `UID:${googleId}@google.com`, "DTSTART:20261020T020000Z", "DTEND:20261020T030000Z", "END:VEVENT",
      // An event written by a CalDAV connection, carrying our markers.
      "BEGIN:VEVENT", "UID:copied@example.test", "DTSTART:20261020T030000Z", "DTEND:20261020T040000Z", `X-IACQUIRE-APPOINTMENT:${appt.appointmentId}`, `X-IACQUIRE-WORKSPACE:${c.org.id}`, "END:VEVENT",
      // Another workspace's appointment is this person's commitment like any other.
      "BEGIN:VEVENT", "UID:foreign@example.test", "DTSTART:20261020T060000Z", "DTEND:20261020T070000Z", `X-IACQUIRE-APPOINTMENT:${crypto.randomUUID()}`, `X-IACQUIRE-WORKSPACE:${crypto.randomUUID()}`, "END:VEVENT",
      "BEGIN:VEVENT", "UID:dentist@example.test", "DTSTART:20261020T070000Z", "DTEND:20261020T080000Z", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"), { status: 200, headers: { "content-type": "text/calendar" } }));
    await connectIcsFeed(c.actor("owner"), { url: "https://feeds.example.com/ana.ics" }, { now: NOW });
    const feed = (await listMyConnections(c.actor("owner"))).find((x) => x.provider === "ics")!;
    expect(await syncConnectionBusy(feed.id, { now: NOW })).toMatchObject({ status: "ok", busy: 2 });
    const runs = await listSyncRuns(c.actor("owner"), { connectionId: feed.id });
    expect(runs.find((r) => r.kind === "busy")?.counts.ownSkipped).toBe(2);
    // So the appointment can still be moved to a time overlapping its own (10:00 and 11:00 Manila), and the feed's own busy hours count.
    const free = await slotsOn(c, typeId, "2026-10-20", appt.appointmentId);
    expect(free).toContain("2026-10-20T02:00:00.000Z");
    expect(free).toContain("2026-10-20T03:00:00.000Z");
    expect(free).not.toContain("2026-10-20T06:00:00.000Z");
    expect(free).not.toContain("2026-10-20T07:00:00.000Z");
  });

  it("CalDAV events carry the workspace marker, and a copy of ours at another address is still ours (by UID or by marker)", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const dav = caldavServer("https://dav.example.com/");
    const { typeId } = await nativeSetup(c);
    const { id } = await connectCalDav(c.actor("owner"), { preset: "caldav", serverUrl: "https://dav.example.com/", username: "ana@example.test", password: "abcd-efgh-ijkl-mnop" }, { now: NOW });
    await updateConnectionOptions(c.actor("owner"), id, { writeEvents: true, writeCalendarId: "https://dav.example.com/calendars/ana/work/" });
    await onlyThisWorkspaceWrites(c);
    const page = await bookingPageActor(c.org.id);
    const appt = await bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "Kit", email: "kit@example.test" }, via: "booking_page", now: NOW });
    await writeBackDue({ now: NOW });
    const written = [...dav.store.values()][0].body;
    expect(written).toContain(`X-IACQUIRE-APPOINTMENT:${appt.appointmentId}`);
    expect(written).toContain(`X-IACQUIRE-WORKSPACE:${c.org.id}`);
    // The calendar app copied it to other resources: one keeps our UID without the markers, one keeps the markers under a new UID.
    const uidOnly = written.replace(/X-IACQUIRE-[A-Z]+:[^\r\n]*\r\n/g, "");
    const markersOnly = written.replace(/UID:[^\r\n]*/, "UID:renamed-by-the-app@example.test");
    router.on("REPORT", /\/calendars\/ana\/work\/$/, () => davXml([{ href: "/calendars/ana/work/copy-1.ics", body: uidOnly }, { href: "/calendars/ana/work/copy-2.ics", body: markersOnly }]));
    expect(await syncConnectionBusy(id, { now: NOW, force: true })).toMatchObject({ status: "ok", busy: 0 });
    const runs = await listSyncRuns(c.actor("owner"), { connectionId: id });
    expect(runs.find((r) => r.kind === "busy")?.counts.ownSkipped).toBe(2);
  });
});

describe("review fixes: Google", () => {
  it("a calendar that's gone (404) or no longer readable (403) at the sync-token check gets a full read instead of failing the connection", async () => {
    const answer = (id: string, incremental: boolean) => {
      if (id === "gone@group.calendar.google.com") return Response.json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, { status: 404 });
      if (id === "hidden@group.calendar.google.com") return Response.json({ error: { code: 403, errors: [{ reason: "forbidden" }] } }, { status: 403 });
      if (incremental) return Response.json({ items: [], nextSyncToken: "t-2" });
      return Response.json({ items: [{ id: "busy-1", start: { dateTime: "2026-10-20T10:00:00+08:00" }, end: { dateTime: "2026-10-20T11:00:00+08:00" } }], nextSyncToken: "t-full" });
    };
    router
      .on("GET", /\/calendar\/v3\/calendars\/([^/]+)\/events$/, (r, m) => answer(decodeURIComponent(m[1]), !!r.url.searchParams.get("syncToken")))
      .on("POST", /\/calendar\/v3\/freeBusy$/, () => Response.json({ calendars: { "hidden@group.calendar.google.com": { busy: [{ start: "2026-10-21T01:00:00Z", end: "2026-10-21T02:00:00Z" }] } } }));
    const tokens = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { syncToken: "t-1", fullAt: NOW.toISOString() }]));

    const gone = [PRIMARY, "gone@group.calendar.google.com"];
    const r1 = await googleAdapter.readBusy(bearer, busyQuery({ calendarIds: gone, cursors: tokens(gone) }));
    expect(r1.busy?.map((b) => [b.calendarId, new Date(b.start).toISOString()])).toEqual([[PRIMARY, "2026-10-20T02:00:00.000Z"]]);
    expect(r1.cursors["gone@group.calendar.google.com"].syncToken).toBeUndefined();

    const hidden = ["hidden@group.calendar.google.com", PRIMARY];
    const r2 = await googleAdapter.readBusy(bearer, busyQuery({ calendarIds: hidden, cursors: tokens(hidden) }));
    expect(r2.busy?.map((b) => [b.calendarId, new Date(b.start).toISOString()]).sort()).toEqual([[PRIMARY, "2026-10-20T02:00:00.000Z"], ["hidden@group.calendar.google.com", "2026-10-21T01:00:00.000Z"]]);

    // A 403 that is really a rate limit still backs off.
    router.on("GET", /\/calendar\/v3\/calendars\/([^/]+)\/events$/, () => Response.json({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }, { status: 403 }));
    await expect(googleAdapter.readBusy(bearer, busyQuery({ calendarIds: [PRIMARY], cursors: tokens([PRIMARY]) }))).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("offers only calendars the person owns for adding events (calendar.events.owned can't write to shared ones)", async () => {
    router.on("GET", /\/calendar\/v3\/users\/me\/calendarList$/, () => Response.json({ items: [
      { id: PRIMARY, summary: "Ana", primary: true, accessRole: "owner" },
      { id: "made-by-ana@group.calendar.google.com", summary: "Side business", accessRole: "owner" },
      { id: "team@group.calendar.google.com", summary: "Team", accessRole: "writer" },
      { id: "holidays@group.v.calendar.google.com", summary: "Holidays", accessRole: "reader" },
    ] }));
    const cals = await listGoogleCalendars(bearer);
    expect(cals.map((x) => [x.id, x.canWrite])).toEqual([
      [PRIMARY, true], ["made-by-ana@group.calendar.google.com", true], ["team@group.calendar.google.com", false], ["holidays@group.v.calendar.google.com", false],
    ]);
  });
});

describe("review fixes: clearing a location", () => {
  it("Google and Outlook updates send an empty location, because PATCH keeps any field that is left out", async () => {
    router
      .on("PATCH", /\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/, (r, m) => Response.json({ ...JSON.parse(r.body), id: decodeURIComponent(m[2]), etag: '"g-2"' }))
      .on("PATCH", /graph\.microsoft\.com\/v1\.0\/me\/events\/([^/]+)$/, (r, m) => Response.json({ ...JSON.parse(r.body), id: decodeURIComponent(m[1]), "@odata.etag": 'W/"2"' }));
    const ev: OutboundEvent = {
      appointmentId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), idempotencyKey: "a".repeat(64), title: "Site visit with Ana", start: at("10:00"), end: at("11:00"),
      timeZone: "Asia/Manila", location: null, description: "Booked with iAcquire.", tentative: false, conference: null, sequence: 1,
    };
    await googleAdapter.upsertEvent!(bearer, PRIMARY, { eventId: "iaq-existing", calendarId: PRIMARY, etag: '"g-1"' }, ev);
    expect(JSON.parse(router.find("PATCH", /\/events\/iaq-existing$/)[0].body).location).toBe("");
    await microsoftAdapter.upsertEvent!(bearer, "CAL-1", { eventId: "ms-existing", calendarId: "CAL-1", etag: null }, ev);
    expect(JSON.parse(router.find("PATCH", /\/me\/events\/ms-existing$/)[0].body).location).toEqual({ displayName: "" });
    // A location that is set is still sent as it is.
    await googleAdapter.upsertEvent!(bearer, PRIMARY, { eventId: "iaq-existing", calendarId: PRIMARY, etag: '"g-2"' }, { ...ev, location: "Office A" });
    expect(JSON.parse(router.find("PATCH", /\/events\/iaq-existing$/)[1].body).location).toBe("Office A");
  });
});

describe("review fixes: addresses people type", () => {
  it("refuses IPv4-mapped, translated and NAT64 IPv6 forms of private addresses, however the URL parser writes them", async () => {
    // The WHATWG parser rewrites the dotted form to hex, which a text pattern on the dotted form never saw.
    expect(new URL("https://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    expect(ipv6Groups("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(ipv6Groups("64:ff9b::10.0.0.5")).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0x0a00, 5]);
    expect(ipv6Groups("not-an-ip")).toBeNull();
    for (const bad of [
      "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:a00:5", "0:0:0:0:0:ffff:7f00:1", "::ffff:0:7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.5", "64:ff9b:1::1",
      "::127.0.0.1", "::7f00:1", "2002:7f00:1::1", "2001:0:4136:e378::1", "2001:db8::1", "3fff::1", "100::1", "fe80::1%eth0", "fec0::1", "ff02::1",
    ]) expect(isPublicAddress(bad), bad).toBe(false);
    for (const ok of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:5db8:d822", "64:ff9b::5db8:d822", "93.184.216.34"]) expect(isPublicAddress(ok), ok).toBe(true);
    for (const url of ["https://[::ffff:127.0.0.1]/a.ics", "https://[::ffff:a9fe:a9fe]/latest/meta-data", "https://[64:ff9b::a00:5]/a.ics", "https://[::ffff:0:a00:5]/a.ics"]) {
      await expect(assertPublicHttps(new URL(url)), url).rejects.toThrow(/private or local/);
    }
    // A name that resolves to such an address is refused the same way.
    vi.spyOn(hostResolver, "lookup").mockImplementation(async () => ["::ffff:7f00:1"]);
    await expect(assertPublicHttps(new URL("https://feeds.example.com/a.ics"))).rejects.toThrow(/private or local/);
    const c = await crmOrg({ timezone: "Asia/Manila" });
    await expect(connectIcsFeed(c.actor("owner"), { url: "https://[::ffff:7f00:1]/a.ics" })).rejects.toThrow(/private or local/);
    expect(router.calls).toHaveLength(0);
  });
});
