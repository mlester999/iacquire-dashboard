import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { deriveLaunchReadiness, type CalendarCheckFact, type CalendarFacts, type ChannelFact, type EmployeeFact, type HostConnectionFact, type LaunchFacts } from "@/lib/launch-readiness";

// A button that points at a page that does not exist is a dead end the client cannot get out of (the channel buttons once pointed at /inbox/settings). Every address the launch judge can put
// on a button has to open a real App Router page; the sign-in start addresses under /api are route handlers, not pages, and have to match a real route handler instead.

const APP = path.join(process.cwd(), "src", "app");

function filesNamed(dir: string, name: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return filesNamed(full, name);
    return e.name === name ? [full] : [];
  });
}

/** The URL segments of a page or route file: route groups "(x)" vanish, "[id]" matches any one segment. */
function segmentsOf(file: string): string[] {
  const rel = path.relative(APP, path.dirname(file)).split(path.sep).filter(Boolean);
  return rel.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
}

const matches = (pattern: string[], url: string[]) =>
  pattern.length === url.length && pattern.every((seg, i) => (seg.startsWith("[") && seg.endsWith("]") && !seg.startsWith("[...") ? url[i] !== "" : seg === url[i]));

const PAGES = filesNamed(APP, "page.tsx").map(segmentsOf);
const ROUTE_HANDLERS = filesNamed(APP, "route.ts").map(segmentsOf);

/** Whether an address opens an existing page (or, for /api, an existing route handler). */
function resolves(href: string): "page" | "route" | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const url = href.split(/[?#]/)[0].split("/").filter(Boolean);
  if (url[0] === "api") return ROUTE_HANDLERS.some((p) => matches(p, url)) ? "route" : null;
  return PAGES.some((p) => matches(p, url)) ? "page" : null;
}

const employee = (role: (typeof AGENT_ROLE_KEYS)[number], over: Partial<EmployeeFact> = {}): EmployeeFact => ({
  role, entitled: true, provisioning: "succeeded", provisioningDetail: null, attempts: 1, maxAttempts: 3, nextRetryAt: null, healthFailed: false, healthDetail: null, heldForReview: false, configVersion: 3,
  readiness: { state: "ready", chatAvailable: true, workReady: true, description: "Ready.", blocking: [] }, ...over,
});
const notReady = { state: "pending_setup" as const, chatAvailable: false, workReady: false, description: "Not ready.", blocking: [] as string[] };
const checks = (failing: CalendarCheckFact["key"][] = []): CalendarCheckFact[] =>
  (["hosts", "hours", "timezone", "types", "connections", "slot"] as const).map((key) => ({ key, ok: !failing.includes(key), detail: failing.includes(key) ? "It does not pass yet." : "Passed." }));
const calendar = (over: Partial<CalendarFacts> = {}): CalendarFacts => ({ id: "cal-1", status: "draft", hosts: 1, hostsWithHours: 1, hasSuggestedHours: false, types: 1, needsVideoConnection: false, checks: null, bookingPageOn: false, ...over });

/** A fully populated, ready client: each scenario below breaks one area so the judge shows every button it can. */
function base(): LaunchFacts {
  return {
    submitted: true, paymentCleared: true, canOpenBilling: true,
    profile: { companyName: true, industry: true, description: true, timezone: "America/Chicago", timezoneAnswered: true },
    knowledge: { approved: 3, pending: 0 },
    crm: { mode: "native", blueprint: "verified", pipelineReady: true, records: { state: "in_place", tags: 2, contactFields: 1, forms: 1 }, providerConnected: false },
    appointments: { wanted: true, calendar: calendar({ status: "active", checks: checks() }), externalCalendarConnected: false },
    channels: [],
    employees: AGENT_ROLE_KEYS.map((role) => employee(role)),
    verification: AGENT_ROLE_KEYS.map((role) => ({ role, state: "passed" as const, configVersion: 3, detail: null })),
  };
}
const host = (over: Partial<HostConnectionFact> = {}): HostConnectionFact => ({ userId: "u-1", name: "Dana Reyes", viewer: false, meet: { google: false, microsoft: false }, busy: { google: false, microsoft: false }, ...over });
const channel = (c: ChannelFact["channel"], over: Partial<ChannelFact> = {}): ChannelFact => ({ channel: c, wanted: true, enabled: false, registration: "not_started", ...over });

/** Every scenario the judge can answer with a button that links somewhere. */
function scenarios(): Array<[string, LaunchFacts]> {
  const f = base();
  const withCalendar = (cal: CalendarFacts | null, wanted: boolean | null = true): LaunchFacts => ({ ...f, appointments: { wanted, calendar: cal, externalCalendarConnected: false } });
  return [
    ["the setup payment is not confirmed", { ...f, paymentCleared: false, employees: AGENT_ROLE_KEYS.map((role) => employee(role, { provisioning: "none", readiness: notReady })) }],
    ["the company details and time zone are missing", { ...f, profile: { companyName: true, industry: false, description: false, timezone: null, timezoneAnswered: false } }],
    ["no knowledge was saved", { ...f, knowledge: { approved: 0, pending: 0 } }],
    ["knowledge is waiting for review", { ...f, knowledge: { approved: 2, pending: 2 } }],
    ["the questionnaire does not say whether appointments are booked", withCalendar(null, null)],
    ["there is no calendar", withCalendar(null)],
    ["a calendar has no host", withCalendar(calendar({ hosts: 0, hostsWithHours: 0 }))],
    ["a host has no hours and none are suggested", withCalendar(calendar({ hostsWithHours: 0, hasSuggestedHours: false }))],
    ["a host has no hours and some are suggested", withCalendar(calendar({ hostsWithHours: 0, hasSuggestedHours: true }))],
    ["there is no appointment type", withCalendar(calendar({ types: 0 }))],
    ["a video appointment needs Google", withCalendar(calendar({ needsVideoConnection: true, videoProviders: ["google"] }))],
    ["a video appointment needs Microsoft", withCalendar(calendar({ needsVideoConnection: true, videoProviders: ["microsoft"] }))],
    ["a video appointment needs both", withCalendar(calendar({ needsVideoConnection: true, videoProviders: ["google", "microsoft"] }))],
    ["a draft calendar's checks fail on the connections", withCalendar(calendar({ checks: checks(["connections"]) }))],
    ["a draft calendar's checks fail on the open time", withCalendar(calendar({ checks: checks(["slot"]) }))],
    ["a draft calendar passes its checks", withCalendar(calendar({ checks: checks() }))],
    ["an active calendar can no longer offer a time", withCalendar(calendar({ status: "active", checks: checks(["slot"]) }))],
    ["an active calendar fails the time zone, hours and connection checks", withCalendar(calendar({ status: "active", checks: checks(["timezone", "hours", "connections"]) }))],
    ["an active calendar has types without an open time", withCalendar(calendar({ status: "active", checks: checks(), typesWithoutTimes: ["Full-day survey"] }))],
    ["a video appointment has no way to join", withCalendar(calendar({ status: "active", checks: checks(), typesWithoutJoinInfo: ["Video estimate"] }))],
    ["the public page is on and a check fails", withCalendar(calendar({ status: "active", bookingPageOn: true, checks: checks(["hours"]) }))],
    ["the host is the person looking and has not connected Google", withCalendar(calendar({
      status: "active", checks: checks(), needsVideoConnection: true, videoProviders: ["google"], oauthAvailable: { google: true, microsoft: true }, hostConnections: [host({ viewer: true })],
    }))],
    ["the client's Microsoft calendar must block times", withCalendar(calendar({
      status: "active", checks: checks(), busyProvider: "microsoft", oauthAvailable: { google: true, microsoft: true }, hostConnections: [host({ viewer: true })],
    }))],
    ["the client said a team member takes appointments, and nobody is marked", { ...withCalendar(calendar({ hosts: 0, hostsWithHours: 0 })), appointments: { wanted: true, calendar: calendar({ hosts: 0, hostsWithHours: 0 }), externalCalendarConnected: false, hostChoice: "team", teamHosts: [] } }],
    ["the client said a team member takes appointments, and has not invited them", { ...withCalendar(calendar({ hosts: 0, hostsWithHours: 0 })), appointments: { wanted: true, calendar: calendar({ hosts: 0, hostsWithHours: 0 }), externalCalendarConnected: false, hostChoice: "team", teamHosts: [{ name: "Marcus Hale", state: "not_invited" }] } }],
    ["a channel registration was rejected", { ...f, channels: [channel("sms", { registration: "rejected" }), channel("whatsapp", { registration: "rejected" })] }],
    ["an email address and a WhatsApp number were not given", { ...f, channels: [channel("email", { statedSender: null }), channel("whatsapp", { statedSender: null })] }],
    ["channels wait for iAcquire", { ...f, channels: [channel("sms", { registration: "pending", statedSender: "+1 512 555 0100" }), channel("email", { statedSender: "hello@example.test", credentialStored: true })] }],
    ["the CRM setup is waiting, failed or partial", { ...f, crm: { ...f.crm, blueprint: "waiting_for_a_person", pipelineReady: false } }],
    ["the CRM lost records", { ...f, crm: { ...f.crm, blueprint: "missing_records" } }],
    ["an employee's profile failed and another's check failed", {
      ...f, employees: AGENT_ROLE_KEYS.map((role, i) => (i === 0 ? employee(role, { provisioning: "failed", attempts: 3, readiness: notReady }) : i === 1 ? employee(role, { provisioning: "awaiting_health_check", healthFailed: true, readiness: notReady }) : i === 2 ? employee(role, { provisioning: "retrying", attempts: 1, readiness: notReady }) : employee(role))),
    }],
    ["the final checks have not run", { ...f, verification: [] }],
  ];
}

const hrefsOf = (facts: LaunchFacts) => deriveLaunchReadiness(facts).steps.flatMap((s) => s.items).flatMap((i) => (i.action?.href ? [i.action.href] : []));

describe("every address the launch judge puts on a button opens something that exists", () => {
  const collected = scenarios().flatMap(([name, facts]) => hrefsOf(facts).map((href) => ({ name, href })));

  it("resolves each one to a page, or, for the provider sign-in start, to a route handler", () => {
    expect(collected.length).toBeGreaterThan(15);
    const dead = collected.filter(({ href }) => resolves(href) === null);
    expect(dead, `dead links: ${JSON.stringify(dead)}`).toEqual([]);
    // Only the provider sign-in start is allowed to be a route handler; everything else a client clicks is a page.
    const routes = [...new Set(collected.filter(({ href }) => resolves(href) === "route").map(({ href }) => href))];
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((href) => /^\/api\/crm\/calendar-oauth\/(google|microsoft)\/start\?return=\/setup$/.test(href))).toBe(true);
  });

  it("covers the addresses the panel is known to use, so the scenarios cannot quietly stop reaching them", () => {
    const hrefs = new Set(collected.map(({ href }) => href));
    for (const expected of ["/settings/billing", "/onboarding", "/knowledge", "/crm/calendars", "/crm/calendars/cal-1", "/crm/availability", "/crm/calendar-connections", "/settings/messaging", "/settings/team",
      "/api/crm/calendar-oauth/google/start?return=/setup", "/api/crm/calendar-oauth/microsoft/start?return=/setup"]) {
      expect(hrefs.has(expected), expected).toBe(true);
    }
    // The address the channel buttons used to carry does not exist and is never emitted.
    expect(hrefs.has("/inbox/settings")).toBe(false);
  });

  it("can fail: an address with no page, an external address and a traversal do not resolve", () => {
    expect(resolves("/inbox/settings")).toBeNull();
    expect(resolves("/settings/messaging")).toBe("page");
    expect(resolves("/crm/calendars/some-id")).toBe("page");
    expect(resolves("/api/crm/calendar-oauth/yahoo/missing")).toBeNull();
    expect(resolves("/api/crm/calendar-oauth/google/start?return=/setup")).toBe("route");
    expect(resolves("https://evil.example/setup")).toBeNull();
    expect(resolves("//evil.example")).toBeNull();
  });

  it("gives the intent buttons no address: they run a step inside the page", () => {
    const intents = scenarios().flatMap(([, facts]) => deriveLaunchReadiness(facts).steps.flatMap((s) => s.items)).filter((i) => i.action?.intent);
    expect(intents.length).toBeGreaterThan(0);
    expect(intents.every((i) => i.action?.href === undefined)).toBe(true);
  });
});
