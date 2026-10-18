// Draft calendars (created from a Blueprint): every booking path refuses them, the activation checks say exactly what is missing, and
// activation makes them bookable. Synthetic workspaces only; nothing here contacts a calendar provider and no message is sent.
import crypto from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} }),
  usePathname: () => "/crm/calendars",
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: () => { throw new Error("NEXT_REDIRECT"); },
}));
import { withSystem } from "@/server/db";
import {
  archiveCalendar, createAppointmentType, createCalendar, listBookingPages, listCalendars, listSchedulingPeople, parseHoursTemplate, setCalendarPublic, setHostAvailability,
  updateAppointmentType, updateCalendar, type AppointmentTypeInput,
} from "@/server/calendars/setup";
import { computeSlots, loadBookingContext } from "@/server/calendars/availability";
import { bookingPageActor, bookNativeAppointment } from "@/server/calendars/booking";
import { listBookableSlots, listScheduleFilters } from "@/server/calendars/schedule";
import { handleSlots, resolvePublicBookingPage, type PublicRequestMeta } from "@/server/calendars/public-booking";
import { activateCalendar, applyCalendarHoursTemplate, verifyCalendar, type CalendarCheckKey, type CalendarVerification } from "@/server/calendars/activation";
import { getAvailability } from "@/server/appointments/availability";
import { requestBooking } from "@/server/appointments/booking";
import { loadWorkspaceBooking, publicTarget, siteData } from "@/server/sites/booking-data";
import { bookingOptionsFor, bookingReadiness } from "@/server/websites/booking-setup";
import { createContact } from "@/server/crm/contacts";
import { isRef, type Section, type SiteContent } from "@/lib/website/doc";
import { newElement } from "@/lib/website/editor/library";
import { insertElement } from "@/lib/website/ops";
import { buildSite } from "@/lib/website/templates/index";
import { CalendarDetail } from "@/components/crm/scheduling/settings/calendar-detail";
import { CalendarsManager } from "@/components/crm/scheduling/settings/calendars-manager";
import { BookingPagesManager } from "@/components/crm/scheduling/settings/booking-pages-manager";
import type { CrmScope } from "@/server/crm/page";
import { crmOrg, type CrmOrg, type CrmWho } from "./support/crm";

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
// Monday 19 October 2026, 08:00 in Manila (00:00 UTC). Everything below is worked out at this instant.
const NOW = new Date("2026-10-19T00:00:00Z");
const at = (localHHMM: string, date = "2026-10-20") => new Date(`${date}T${localHHMM}:00+08:00`);
const DRAFT = /still a draft/;

interface Draft { calendarId: string; typeId: string | null; slug: string; typeSlug: string | null }

/**
 * A calendar as a Blueprint leaves it: hosts and a type set up here, then marked draft (no page, not the default) with the Blueprint's
 * suggested hours and time zone. `hours: false` leaves the hosts without weekly hours.
 */
async function draftCalendar(c: CrmOrg, opts: { hosts?: CrmWho[]; hours?: boolean; type?: Partial<AppointmentTypeInput> | null; template?: unknown; timezone?: string | null } = {}): Promise<Draft> {
  const owner = c.actor("owner");
  const hosts = opts.hosts ?? ["owner"];
  if (opts.hours !== false) for (const h of hosts) await setHostAvailability(owner, c.people[h].id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: `Blueprint visits ${crypto.randomBytes(2).toString("hex")}`, assignment: hosts.length > 1 ? "round_robin" : "single", members: hosts.map((h) => ({ userId: c.people[h].id })) });
  const type = opts.type === null ? null : await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, ...opts.type });
  await withSystem((db) => db.query(
    "update crm_calendars set status = 'draft', public = false, is_default = false, origin = 'blueprint', timezone = $2, hours_template = $3::jsonb where id = $1",
    [cal.id, opts.timezone === undefined ? "Asia/Manila" : opts.timezone, JSON.stringify(opts.template ?? WEEKDAYS_9_TO_5)],
  ));
  const view = (await listCalendars(owner)).find((x) => x.id === cal.id)!;
  return { calendarId: cal.id, typeId: type?.id ?? null, slug: view.slug, typeSlug: view.types[0]?.slug ?? null };
}

const visitor = (): PublicRequestMeta => ({ origin: "https://app.example.test", host: "app.example.test", secFetchSite: "same-origin", ip: `203.0.113.${Math.floor(Math.random() * 250) + 1}`, now: NOW });
const checkOf = (v: CalendarVerification, key: CalendarCheckKey) => v.checks.find((c) => c.key === key)!;
const failing = (v: CalendarVerification) => v.checks.filter((c) => !c.ok).map((c) => c.key).sort();
const statusOf = async (id: string) => (await withSystem((db) => db.query<{ status: string; public: boolean; is_default: boolean; verified_at: Date | null; verification: Record<string, unknown> }>("select status, public, is_default, verified_at, verification from crm_calendars where id = $1", [id]))).rows[0];

let a: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Draft Calendar Co", timezone: "Asia/Manila" });
});

describe("every booking path refuses a draft calendar", () => {
  it("the booking engine itself: availability, staff, booking page, website and the staff slot picker", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const d = await draftCalendar(c);
    const typeId = d.typeId as string;
    // Availability: a draft's context is refused; only the activation check may read it.
    await expect(withSystem((db) => loadBookingContext(db, c.org.id, typeId))).rejects.toThrow(DRAFT);
    const ctx = await withSystem((db) => loadBookingContext(db, c.org.id, typeId, { includeDraft: true }));
    expect(ctx.calendar.status).toBe("draft");
    expect((await withSystem((db) => computeSlots(db, ctx, { from: at("00:00"), to: at("23:59"), now: NOW }))).length).toBeGreaterThan(0);
    // Staff booking, a booking page and a website booking all go through the same refusal.
    const contact = await createContact(c.actor("owner"), { firstName: "Ana", lastName: "Reyes", email: `ana-${crypto.randomUUID()}@example.test` });
    await expect(bookNativeAppointment(c.actor("owner"), { typeId, startAt: at("10:00"), contact: { id: contact.id }, via: "staff", now: NOW })).rejects.toThrow(DRAFT);
    const page = await bookingPageActor(c.org.id);
    for (const via of ["booking_page", "website", "api"] as const) {
      await expect(bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "Ben", email: `ben-${via}@example.test` }, via, now: NOW })).rejects.toThrow(DRAFT);
    }
    // The staff slot picker offers nothing for it.
    await expect(listBookableSlots(c.actor("owner"), { typeId, from: at("00:00"), to: at("23:59"), now: NOW })).rejects.toThrow(DRAFT);
    const appts = await withSystem((db) => db.query("select 1 from appointment_refs where org_id = $1", [c.org.id]));
    expect(appts.rows).toHaveLength(0);
  });

  it("the AI and Appointments page request flow: never books a draft, never quietly moves to another calendar, and the fallback skips drafts", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const d = await draftCalendar(c);
    const contact = await createContact(c.actor("owner"), { firstName: "Cara", email: `cara-${crypto.randomUUID()}@example.test` });
    // Only drafts in the workspace: nothing to offer, and it says why.
    const none = await getAvailability(c.org.id, { now: NOW, from: NOW });
    expect(none).toMatchObject({ ok: false, reason: "no_calendar" });
    expect(!none.ok && none.detail).toMatch(/still drafts/);
    for (const ref of [d.typeId, d.calendarId]) {
      const av = await getAvailability(c.org.id, { calendarId: ref, now: NOW, from: NOW });
      expect(av).toMatchObject({ ok: false, reason: "no_calendar" });
      const asked = await requestBooking({ orgId: c.org.id, contactId: contact.id, calendarId: ref, startAt: at("10:00"), actor: { kind: "ai", agentId: null }, now: NOW });
      expect(asked).toMatchObject({ status: "unavailable", reason: "no_calendar" });
      const staff = await requestBooking({ orgId: c.org.id, contactId: contact.id, calendarId: ref, startAt: at("10:00"), actor: { kind: "staff", userId: c.people.owner.id }, now: NOW });
      expect(staff).toMatchObject({ status: "unavailable", reason: "no_calendar" });
    }
    // Once an active calendar exists, a request that names nothing goes there; one that names the draft is still refused.
    const owner = c.actor("owner");
    const active = await createCalendar(owner, { name: "Active consults", members: [{ userId: c.people.owner.id }] });
    const activeType = await createAppointmentType(owner, active.id, { name: "Consult", durationMinutes: 30, minNoticeMinutes: 60 });
    const fallback = await getAvailability(c.org.id, { now: NOW, from: NOW });
    expect(fallback).toMatchObject({ ok: true, calendarId: activeType.id });
    expect(await getAvailability(c.org.id, { calendarId: d.typeId, now: NOW, from: NOW })).toMatchObject({ ok: false, reason: "no_calendar" });
    const held = await withSystem((db) => db.query("select 1 from appointment_bookings where org_id = $1 and calendar_id = $2", [c.org.id, d.typeId]));
    expect(held.rows).toHaveLength(0);
  });

  it("public booking pages and website booking never show or book a draft", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const d = await draftCalendar(c);
    expect(await resolvePublicBookingPage(c.org.slug, d.slug)).toBeNull();
    expect(await resolvePublicBookingPage(c.org.slug, d.slug, d.typeSlug)).toBeNull();
    const slots = await handleSlots(visitor(), { org: c.org.slug, calendar: d.slug, type: d.typeSlug ?? "", from: "2026-10-20", to: "2026-10-20", tz: "Asia/Manila" });
    expect(slots.status).toBe(404);
    // Website booking data: the draft is listed for the editor as not public, never offered to visitors.
    const ws = await withSystem((db) => loadWorkspaceBooking(db, c.org.id));
    expect(ws.calendars.find((x) => x.id === d.calendarId)?.status).toBe("draft");
    expect(siteData(ws).calendars.map((x) => x.slug)).not.toContain(d.slug);
    expect(publicTarget(ws, d.slug, d.typeSlug as string)).toBeNull();
    // Even if the row were somehow public, the website's own filter keeps a draft out.
    const forged = { ...ws, calendars: ws.calendars.map((x) => (x.id === d.calendarId ? { ...x, public: true } : x)) };
    expect(publicTarget(forged, d.slug, d.typeSlug as string)).toBeNull();
    expect(siteData(forged).calendars.map((x) => x.slug)).not.toContain(d.slug);
    const options = await bookingOptionsFor(c.org.id, { agency: false });
    expect(options.calendars.find((x) => x.slug === d.slug)).toMatchObject({ public: false });
    // Publishing a site whose booking element names the draft is blocked with the reason.
    const site = buildSite("corp.summit", { businessName: "Draft Co", industry: "other", services: [{ title: "Visits" }], email: "hi@draft.example" });
    const first = site.pages.find((p) => p.slug === "home")!.items.find((i): i is Section => !isRef(i))!;
    const el = newElement(site, "booking");
    Object.assign(el.props, { calendar: d.slug });
    const content: SiteContent = insertElement(site, first.columns[0].id, 0, el);
    const ready = await bookingReadiness(c.org.id, content, NOW);
    expect(ready.blockers.map((x) => x.code)).toEqual(["booking_calendar_draft"]);
    expect(ready.blockers[0].message).toMatch(/draft calendar/);
  });

  it("staff can filter by a draft but are never offered it to book; it has no booking page and can't be the default", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const d = await draftCalendar(c);
    const owner = c.actor("owner");
    const filters = await listScheduleFilters(owner);
    const f = filters.calendars.find((x) => x.id === d.calendarId)!;
    expect(f).toMatchObject({ draft: true, types: [] });
    expect(f.hostIds).toEqual([c.people.owner.id]);
    // Booking pages: listed, not live, and the reason is the draft.
    const pages = await listBookingPages(owner);
    const p = pages.pages.find((x) => x.calendarId === d.calendarId)!;
    expect(p).toMatchObject({ status: "draft", live: false, public: false });
    expect(p.blockers[0]).toEqual({ code: "draft" });
    expect(p.types.every((t) => !t.live)).toBe(true);
    // No page, no default, until activated.
    await expect(setCalendarPublic(owner, d.calendarId, true)).rejects.toThrow(/still a draft/);
    await expect(updateCalendar(owner, d.calendarId, { public: true })).rejects.toThrow(/still a draft/);
    await expect(updateCalendar(owner, d.calendarId, { isDefault: true })).rejects.toThrow(/still a draft/);
    await expect(withSystem((db) => db.query("update crm_calendars set public = true where id = $1", [d.calendarId]))).rejects.toThrow();
    // Archiving the default hands the default to an active calendar, never to the draft.
    const one = await createCalendar(owner, { name: "Front desk", members: [{ userId: c.people.owner.id }] });
    expect((await statusOf(one.id)).is_default).toBe(true);
    const two = await createCalendar(owner, { name: "Back office", members: [{ userId: c.people.owner.id }] });
    await archiveCalendar(owner, one.id);
    expect((await statusOf(d.calendarId)).is_default).toBe(false);
    expect((await statusOf(two.id)).is_default).toBe(true);
    // Editing a draft's settings and hosts still works.
    await updateCalendar(owner, d.calendarId, { name: "Renamed draft", members: [{ userId: c.people.owner.id }, { userId: c.people.sales.id }], assignment: "round_robin" });
    expect((await listCalendars(owner)).find((x) => x.id === d.calendarId)).toMatchObject({ name: "Renamed draft", status: "draft", origin: "blueprint" });
  });
});

describe("verification", () => {
  it("reports each failure reason: no hosts, no hours, no time zone, no appointment types, missing connections, no open time", async () => {
    const owner = a.actor("owner");
    // No hosts at all (a Blueprint never carries people).
    const empty = await draftCalendar(a, { hours: false });
    await withSystem((db) => db.query("delete from crm_calendar_members where calendar_id = $1", [empty.calendarId]));
    const v0 = await verifyCalendar(owner, empty.calendarId, { now: NOW });
    expect(v0.ok).toBe(false);
    expect(failing(v0)).toEqual(["hosts", "hours", "slot", "timezone"]);
    expect(checkOf(v0, "types").ok).toBe(true);
    expect(checkOf(v0, "hosts").detail).toMatch(/Nobody hosts/);

    // A host with no weekly hours, and no time zone of their own yet.
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const noHours = await draftCalendar(c, { hours: false });
    const v1 = await verifyCalendar(c.actor("owner"), noHours.calendarId, { now: NOW });
    expect(failing(v1)).toEqual(["hours", "slot", "timezone"]);
    expect(checkOf(v1, "hours").people).toEqual([{ userId: c.people.owner.id, name: "Owner Person" }]);
    expect(checkOf(v1, "hours").detail).toMatch(/Owner Person has no weekly hours/);

    // Hours, but a time zone that isn't real.
    await setHostAvailability(c.actor("owner"), c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    await withSystem((db) => db.query("update crm_host_settings set timezone = 'Mars/Olympus' where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    const v2 = await verifyCalendar(c.actor("owner"), noHours.calendarId, { now: NOW });
    expect(failing(v2)).toContain("timezone");
    expect(checkOf(v2, "timezone").detail).toMatch(/no valid time zone/);
    await withSystem((db) => db.query("update crm_host_settings set timezone = 'Asia/Manila' where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    expect((await verifyCalendar(c.actor("owner"), noHours.calendarId, { now: NOW })).ok).toBe(true);

    // Nothing to book.
    const noTypes = await draftCalendar(c, { type: null });
    const v3 = await verifyCalendar(c.actor("owner"), noTypes.calendarId, { now: NOW });
    expect(failing(v3)).toEqual(["slot", "types"]);

    // Google Meet links need every host's connected Google Calendar (with adding events on).
    const meet = await draftCalendar(c, { hosts: ["owner", "sales"], type: { locationKind: "video", meetingProvider: "google_meet" } });
    const v4 = await verifyCalendar(c.actor("owner"), meet.calendarId, { now: NOW });
    expect(failing(v4)).toEqual(["connections"]);
    expect(checkOf(v4, "connections").detail).toMatch(/Google Calendar/);
    expect(checkOf(v4, "connections").people?.map((p) => p.userId).sort()).toEqual([c.people.owner.id, c.people.sales.id].sort());
    const connect = (who: CrmWho, provider: "google" | "microsoft", writeEvents = true) =>
      withSystem((db) => db.query(
        "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, write_events, external_calendar_id) values ($1, $2, $3, $4, 'connected', $5, 'primary')",
        [c.org.id, c.people[who].id, provider, `${who}-${provider}-${writeEvents}@example.test`, writeEvents],
      ));
    await connect("owner", "google");
    await connect("sales", "google", false); // reading busy times only can't create a Meet link
    await connect("sales", "microsoft");
    const v5 = await verifyCalendar(c.actor("owner"), meet.calendarId, { now: NOW });
    expect(checkOf(v5, "connections").people?.map((p) => p.userId)).toEqual([c.people.sales.id]);
    await connect("sales", "google");
    expect((await verifyCalendar(c.actor("owner"), meet.calendarId, { now: NOW })).ok).toBe(true);
    // Teams links need Microsoft.
    await updateAppointmentType(c.actor("owner"), meet.typeId as string, { meetingProvider: "microsoft_teams" });
    const v6 = await verifyCalendar(c.actor("owner"), meet.calendarId, { now: NOW });
    expect(checkOf(v6, "connections").people?.map((p) => p.userId)).toEqual([c.people.owner.id]);
    expect(checkOf(v6, "connections").detail).toMatch(/Microsoft Teams/);

    // Everything set up, but nobody would be offered a time: every host paused new bookings.
    const d = await crmOrg({ timezone: "Asia/Manila" });
    const paused = await draftCalendar(d);
    await withSystem((db) => db.query("update crm_host_settings set accepting = false where org_id = $1", [d.org.id]));
    const v7 = await verifyCalendar(d.actor("owner"), paused.calendarId, { now: NOW });
    expect(failing(v7)).toEqual(["slot"]);
    expect(checkOf(v7, "slot").detail).toMatch(/paused new bookings/);
    // Or the only type can't be booked inside the next 14 days.
    await withSystem((db) => db.query("update crm_host_settings set accepting = true where org_id = $1", [d.org.id]));
    await updateAppointmentType(d.actor("owner"), paused.typeId as string, { minNoticeMinutes: 20 * 24 * 60 });
    const v8 = await verifyCalendar(d.actor("owner"), paused.calendarId, { now: NOW });
    expect(failing(v8)).toEqual(["slot"]);
    expect(v8.firstOpenTime).toBeNull();
  });

  it("passes with the first open time a customer would really be offered", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const d = await draftCalendar(c);
    const v = await verifyCalendar(c.actor("owner"), d.calendarId, { now: NOW });
    expect(v).toMatchObject({ ok: true, status: "draft", calendarId: d.calendarId });
    expect(v.checks.map((x) => x.key)).toEqual(["hosts", "hours", "timezone", "types", "connections", "slot"]);
    // Monday 08:00 local with 60 minutes' notice: 09:00 local is the first time.
    expect(v.firstOpenTime).toEqual({ typeId: d.typeId, typeName: "Site visit", start: "2026-10-19T01:00:00.000Z" });
    // Verifying writes nothing.
    expect((await statusOf(d.calendarId)).status).toBe("draft");
  });

  it("only people who manage calendars in that workspace can verify or activate", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const other = await crmOrg({ timezone: "Asia/Manila" });
    const d = await draftCalendar(c);
    await expect(verifyCalendar(c.actor("sales"), d.calendarId, { now: NOW })).rejects.toThrow(/role doesn't allow/);
    await expect(activateCalendar(c.actor("viewer"), d.calendarId, { now: NOW })).rejects.toThrow(/role doesn't allow/);
    await expect(verifyCalendar(other.actor("owner"), d.calendarId, { now: NOW })).rejects.toThrow(/not found/);
    await expect(activateCalendar(other.actor("owner"), d.calendarId, { now: NOW })).rejects.toThrow(/not found/);
    await expect(applyCalendarHoursTemplate(other.actor("owner"), d.calendarId)).rejects.toThrow(/not found/);
    expect((await statusOf(d.calendarId)).status).toBe("draft");
  });
});

describe("activation", () => {
  it("refuses while a check fails, then activates, records the checks, becomes the default and takes bookings", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const d = await draftCalendar(c, { hours: false });
    const refused = await activateCalendar(owner, d.calendarId, { now: NOW });
    expect(refused).toMatchObject({ activated: false, alreadyActive: false });
    expect(failing(refused.verification)).toEqual(["hours", "slot", "timezone"]);
    expect((await statusOf(d.calendarId)).status).toBe("draft");

    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    const done = await activateCalendar(owner, d.calendarId, { now: NOW });
    expect(done).toMatchObject({ activated: true, alreadyActive: false, madeDefault: true });
    expect(done.verification.status).toBe("active");
    const row = await statusOf(d.calendarId);
    expect(row).toMatchObject({ status: "active", is_default: true, public: false });
    expect(new Date(row.verified_at as Date).toISOString()).toBe(NOW.toISOString());
    expect(row.verification).toMatchObject({ version: 1, checkedAt: NOW.toISOString(), by: c.people.owner.id });
    expect((row.verification.checks as Array<{ key: string; ok: boolean }>).map((x) => [x.key, x.ok])).toEqual([["hosts", true], ["hours", true], ["timezone", true], ["types", true], ["connections", true], ["slot", true]]);
    const audit = await withSystem((db) => db.query("select actor_user_id from audit_logs where org_id = $1 and action = 'crm.calendar_activated' and target_id = $2", [c.org.id, d.calendarId]));
    expect(audit.rows).toEqual([{ actor_user_id: c.people.owner.id }]);

    // Now every path books it: staff, the request flow, and (once its page is on) the public page.
    const contact = await createContact(owner, { firstName: "Dee", email: `dee-${crypto.randomUUID()}@example.test` });
    const booked = await bookNativeAppointment(owner, { typeId: d.typeId as string, startAt: at("10:00"), contact: { id: contact.id }, via: "staff", now: NOW });
    expect(booked.created).toBe(true);
    expect(await getAvailability(c.org.id, { now: NOW, from: NOW })).toMatchObject({ ok: true, calendarId: d.typeId });
    expect((await listScheduleFilters(owner)).calendars.find((x) => x.id === d.calendarId)?.types).toHaveLength(1);
    await setCalendarPublic(owner, d.calendarId, true);
    expect(await resolvePublicBookingPage(c.org.slug, d.slug, d.typeSlug)).not.toBeNull();
    const pages = await listBookingPages(owner);
    expect(pages.pages.find((x) => x.calendarId === d.calendarId)).toMatchObject({ status: "active", live: true });

    // Activating again changes nothing.
    const again = await activateCalendar(owner, d.calendarId, { now: NOW });
    expect(again).toMatchObject({ activated: false, alreadyActive: true });
  });

  it("doesn't take the default from an existing active calendar", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const main = await createCalendar(owner, { name: "Main", members: [{ userId: c.people.owner.id }] });
    const d = await draftCalendar(c);
    const res = await activateCalendar(owner, d.calendarId, { now: NOW });
    expect(res).toMatchObject({ activated: true, madeDefault: false });
    expect((await statusOf(main.id)).is_default).toBe(true);
    expect((await statusOf(d.calendarId)).is_default).toBe(false);
  });

  it("an archived draft can't be activated", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const d = await draftCalendar(c);
    await archiveCalendar(c.actor("owner"), d.calendarId);
    await expect(activateCalendar(c.actor("owner"), d.calendarId, { now: NOW })).rejects.toThrow(/not found/);
  });
});

describe("suggested hours", () => {
  it("reads only well-formed, non-overlapping ranges", () => {
    expect(parseHoursTemplate(null)).toEqual([]);
    expect(parseHoursTemplate([
      { weekday: 2, startMinute: 600, endMinute: 720 }, { weekday: 1, start: 540, end: 1020 }, { weekday: 7, startMinute: 0, endMinute: 60 },
      { weekday: 1, startMinute: 600, endMinute: 660 }, { weekday: 3, startMinute: 700, endMinute: 600 }, { weekday: 4, startMinute: 1.5, endMinute: 60 }, "9-5",
    ])).toEqual([{ weekday: 1, startMinute: 540, endMinute: 1020 }, { weekday: 2, startMinute: 600, endMinute: 720 }]);
  });

  it("are given, when assigning hosts, only to hosts who have no hours yet; everyone else keeps their own", async () => {
    const c = await crmOrg({ timezone: "UTC" });
    const owner = c.actor("owner");
    const template = [{ weekday: 2, startMinute: 600, endMinute: 900 }, { weekday: 4, startMinute: 600, endMinute: 900 }];
    const d = await draftCalendar(c, { hours: false, template, timezone: "Asia/Manila" });
    // The sales rep already works Monday mornings in their own time zone.
    await setHostAvailability(owner, c.people.sales.id, { timezone: "Europe/London", rules: [{ weekday: 1, startMinute: 480, endMinute: 720 }] });
    const res = await updateCalendar(owner, d.calendarId, { assignment: "round_robin", members: [{ userId: c.people.owner.id }, { userId: c.people.sales.id }], useHoursTemplate: true });
    expect(res.hoursApplied).toEqual([c.people.owner.id]);
    const hours = async (who: CrmWho) => withSystem(async (db) => ({
      tz: (await db.query<{ timezone: string }>("select timezone from crm_host_settings where org_id = $1 and user_id = $2", [c.org.id, c.people[who].id])).rows[0]?.timezone,
      rules: (await db.query<{ weekday: number; start_minute: number; end_minute: number }>("select weekday, start_minute, end_minute from crm_availability_rules where org_id = $1 and user_id = $2 order by weekday", [c.org.id, c.people[who].id])).rows,
    }));
    expect(await hours("owner")).toEqual({ tz: "Asia/Manila", rules: [{ weekday: 2, start_minute: 600, end_minute: 900 }, { weekday: 4, start_minute: 600, end_minute: 900 }] });
    expect(await hours("sales")).toEqual({ tz: "Europe/London", rules: [{ weekday: 1, start_minute: 480, end_minute: 720 }] });
    // Applying again never duplicates or overwrites anything.
    const second = await applyCalendarHoursTemplate(owner, d.calendarId);
    expect(second).toEqual({ applied: [], kept: expect.arrayContaining([c.people.owner.id, c.people.sales.id]) });
    expect((await hours("owner")).rules).toHaveLength(2);
    // Without the option, assigning hosts leaves hours alone.
    await updateCalendar(owner, d.calendarId, { members: [{ userId: c.people.owner.id }, { userId: c.people.sales.id }, { userId: c.people.setter.id }] });
    expect((await hours("setter")).rules).toEqual([]);
    const third = await applyCalendarHoursTemplate(owner, d.calendarId);
    expect(third.applied).toEqual([c.people.setter.id]);
    // Only managers apply hours for others, and a calendar with no suggestion says so.
    await expect(applyCalendarHoursTemplate(c.actor("sales"), d.calendarId)).rejects.toThrow(/role doesn't allow/);
    const plain = await createCalendar(owner, { name: "Plain", members: [{ userId: c.people.owner.id }] });
    await expect(applyCalendarHoursTemplate(owner, plain.id)).rejects.toThrow(/no suggested hours/);
    const audit = await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'crm.calendar_hours_applied'", [c.org.id]));
    expect(audit.rows).toHaveLength(2);
  });
});

describe("settings screens", () => {
  const scopeOf = (c: CrmOrg, manage: boolean): CrmScope => ({
    base: "/crm", orgId: null, agency: false, readOnly: false, userId: c.people.owner.id, timezone: "Asia/Manila", currency: "PHP",
    can: { "crm.view": true, "appointments.view": true, ...(manage ? { "calendars.manage": true as const } : {}) },
  });
  const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
  const json = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

  it("show the Draft badge, why drafts take no bookings, each check, and Activate", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const d = await draftCalendar(c, { hours: false });
    const [calendars, booking, people] = await Promise.all([listCalendars(owner), listBookingPages(owner), listSchedulingPeople(owner)]);
    const cal = calendars.find((x) => x.id === d.calendarId)!;
    const verification = await verifyCalendar(owner, d.calendarId, { now: NOW });
    const detail = html(React.createElement(CalendarDetail, {
      scope: scopeOf(c, true), calendar: json(cal), page: booking.pages.find((p) => p.calendarId === cal.id)!, people, orgSlug: booking.orgSlug, appUrl: "https://portal.example.test", meeting: {}, verification: json(verification),
    }));
    expect(detail).toContain("Draft");
    expect(detail).toContain("Verify and activate");
    expect(detail).toContain("A draft takes no bookings");
    expect(detail).toContain("No booking page while this calendar is a draft.");
    expect(detail).toContain("Working hours");
    expect(detail).toContain("Owner Person has no weekly hours");
    expect(detail).toContain(`/crm/availability?person=${c.people.owner.id}`);
    expect(detail).toContain("3 of 6 checks pass.");
    expect(detail).toContain("Activate calendar");
    expect(detail).toContain("Suggested working hours (Asia/Manila)");
    expect(detail).toContain("Use for hosts without hours");
    // Without calendar management: the explanation and the checks, but nothing to click.
    const viewer = html(React.createElement(CalendarDetail, {
      scope: scopeOf(c, false), calendar: json(cal), page: booking.pages.find((p) => p.calendarId === cal.id)!, people, orgSlug: booking.orgSlug, appUrl: null, meeting: null, verification: json(verification),
    }));
    expect(viewer).toContain("A draft takes no bookings");
    expect(viewer).not.toContain("Activate calendar");
    expect(viewer).not.toContain("Use for hosts without hours");

    const list = html(React.createElement(CalendarsManager, { scope: scopeOf(c, true), calendars: json(calendars), pages: booking.pages, people }));
    expect(list).toContain("Draft");
    expect(list).toContain("Takes no bookings until it is verified and activated.");
    expect(list).toContain(`/crm/calendars/${d.calendarId}#verify`);
    expect(list).toContain("No bookings while a draft");

    const pages = html(React.createElement(BookingPagesManager, { scope: scopeOf(c, true), pages: booking.pages, orgSlug: booking.orgSlug, appUrl: "https://portal.example.test" }));
    expect(pages).toContain("This calendar is a draft, so it takes no bookings until it is verified and activated.");
    expect(pages).toContain("Verify and activate");
  });
});
