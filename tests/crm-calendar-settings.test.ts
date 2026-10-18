// Calendar, appointment type, working hours and booking page settings. Synthetic workspaces only; nothing here contacts a calendar provider.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import {
  archiveAppointmentType, clearDayException, createAppointmentType, createCalendar, duplicateAppointmentType, hostMeetingSupport, listBookingPages, listCalendars,
  listHostAvailability, listSchedulingPeople, reorderAppointmentTypes, setAppointmentTypePublic, setCalendarPublic, setDayException, setHostAvailability, updateAppointmentType,
  updateCalendar,
} from "@/server/calendars/setup";
import { computeSlots, loadBookingContext } from "@/server/calendars/availability";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { addDays, weekdayOf } from "@/lib/calendars/slots";
import { copyToWorkdays, dayProblem, hoursAroundAbsence, questionKey, splitMinutes, timeOptions } from "@/components/crm/scheduling/settings/hours";
import { checkTypeForm, questionsForSave, typeFormFrom, type QuestionDraft } from "@/components/crm/scheduling/settings/forms";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { CalendarsManager } from "@/components/crm/scheduling/settings/calendars-manager";
import { CalendarDetail } from "@/components/crm/scheduling/settings/calendar-detail";
import { AvailabilityManager } from "@/components/crm/scheduling/settings/availability-manager";
import { BookingPagesManager } from "@/components/crm/scheduling/settings/booking-pages-manager";
import type { CrmScope } from "@/server/crm/page";

// The screens are rendered on the server here, outside Next: the router and the server actions are stand-ins that are never called.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/crm/calendars" }));
vi.mock("@/app/actions/crm-calendar-settings", () => {
  const stub = async () => ({ ok: false, error: "not in tests" });
  return Object.fromEntries([
    "createCalendarAction", "updateCalendarAction", "archiveCalendarAction", "setCalendarPublicAction", "createAppointmentTypeAction", "updateAppointmentTypeAction", "archiveAppointmentTypeAction",
    "duplicateAppointmentTypeAction", "reorderAppointmentTypesAction", "setAppointmentTypePublicAction", "setHostAvailabilityAction", "setDayExceptionAction", "clearDayExceptionAction", "deleteAvailabilityOverrideAction",
  ].map((n) => [n, stub]));
});

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
// Dates are relative to the real today (exceptions in the past are not loaded), on a Tuesday at least a week away. Bookings are
// computed "now" = the Monday before at 08:00 in Manila.
const realToday = new Date().toISOString().slice(0, 10);
let DAY = addDays(realToday, 7);
while (weekdayOf(DAY) !== 2) DAY = addDays(DAY, 1);
const NOW = new Date(`${addDays(DAY, -1)}T00:00:00Z`);

const slotHours = (a: CrmOrg, typeId: string, date = DAY) =>
  withSystem(async (db) => {
    const ctx = await loadBookingContext(db, a.org.id, typeId);
    const slots = await computeSlots(db, ctx, { from: new Date(`${date}T00:00:00+08:00`), to: new Date(`${date}T23:59:00+08:00`), now: NOW });
    return slots.map((s) => new Date(s.start).getUTCHours() + 8);
  });

async function calendarWithType(a: CrmOrg, opts: { hosts?: Array<keyof CrmOrg["people"]>; assignment?: "single" | "round_robin" | "collective"; hours?: boolean } = {}) {
  const owner = a.actor("owner");
  const hosts = opts.hosts ?? ["owner"];
  if (opts.hours !== false) for (const h of hosts) await setHostAvailability(owner, a.people[h].id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: `Visits ${Math.random().toString(36).slice(2, 7)}`, assignment: opts.assignment ?? (hosts.length > 1 ? "round_robin" : "single"), members: hosts.map((h) => ({ userId: a.people[h].id })) });
  const type = await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 0 });
  return { calendarId: cal.id, typeId: type.id };
}

let a: CrmOrg;
let b: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Settings A", timezone: "Asia/Manila" });
  b = await crmOrg({ name: "Settings B", timezone: "Asia/Manila" });
});

describe("booking page options", () => {
  it("saves a calendar's booking intro and an appointment type's confirmation, change and contact settings, with safe defaults", async () => {
    const owner = a.actor("owner");
    const cal = await createCalendar(owner, { name: "Intro calendar", bookingIntro: "  Pick a time that suits you.  " });
    const plain = await createAppointmentType(owner, cal.id, { name: "Plain", durationMinutes: 30 });
    const custom = await createAppointmentType(owner, cal.id, {
      name: "Phone only", durationMinutes: 45, confirmationMessage: "Bring your latest bill.", allowCustomerChanges: false, changeCutoffMinutes: 1440, requireEmail: false, requirePhone: true,
    });
    let found = (await listCalendars(owner)).find((c) => c.id === cal.id)!;
    expect(found.bookingIntro).toBe("Pick a time that suits you.");
    expect(found.types.find((t) => t.id === plain.id)).toMatchObject({ confirmationMessage: null, allowCustomerChanges: true, changeCutoffMinutes: 0, requireEmail: true, requirePhone: false });
    expect(found.types.find((t) => t.id === custom.id)).toMatchObject({ confirmationMessage: "Bring your latest bill.", allowCustomerChanges: false, changeCutoffMinutes: 1440, requireEmail: false, requirePhone: true });

    await updateCalendar(owner, cal.id, { bookingIntro: null });
    await updateAppointmentType(owner, custom.id, { confirmationMessage: null, allowCustomerChanges: true, changeCutoffMinutes: 120, requireEmail: true });
    found = (await listCalendars(owner)).find((c) => c.id === cal.id)!;
    expect(found.bookingIntro).toBeNull();
    expect(found.types.find((t) => t.id === custom.id)).toMatchObject({ confirmationMessage: null, allowCustomerChanges: true, changeCutoffMinutes: 120, requireEmail: true, requirePhone: true });
    // The booking flow reads the same columns.
    const ctx = await withSystem((db) => loadBookingContext(db, a.org.id, custom.id));
    expect(ctx.type).toMatchObject({ changeCutoffMinutes: 120, requireEmail: true, requirePhone: true });
  });

  it("refuses settings the booking page couldn't honour", async () => {
    const owner = a.actor("owner");
    const cal = await createCalendar(owner, { name: "Rules calendar" });
    await expect(createAppointmentType(owner, cal.id, { name: "No contact", durationMinutes: 30, requireEmail: false })).rejects.toThrow(/email address or a phone number/);
    await expect(createAppointmentType(owner, cal.id, { name: "No contact", durationMinutes: 30, requireEmail: false, requirePhone: false })).rejects.toThrow(/email address or a phone number/);
    const t = await createAppointmentType(owner, cal.id, { name: "Email", durationMinutes: 30 });
    // Turning email off without turning phone on would leave no way to reach them.
    await expect(updateAppointmentType(owner, t.id, { requireEmail: false })).rejects.toThrow(/email address or a phone number/);
    await expect(updateAppointmentType(owner, t.id, { changeCutoffMinutes: 10081 })).rejects.toThrow(/7 days/);
    await expect(updateAppointmentType(owner, t.id, { changeCutoffMinutes: 1.5 })).rejects.toThrow(/7 days/);
    await expect(updateAppointmentType(owner, t.id, { confirmationMessage: "x".repeat(501) })).rejects.toThrow(/500 characters/);
    await expect(updateAppointmentType(owner, t.id, { questions: [{ key: "slot", label: "When?", type: "select", required: true, options: ["Morning", "morning"] }] })).rejects.toThrow(/different/);
    await expect(updateAppointmentType(owner, t.id, { questions: [{ key: "slot", label: "When?", type: "select", required: true, options: ["Morning", " "] }] })).rejects.toThrow(/1 to 100/);
    await expect(updateCalendar(owner, cal.id, { bookingIntro: "x".repeat(501) })).rejects.toThrow(/500 characters/);
    await expect(updateCalendar(owner, cal.id, { roundRobinMode: "random" as "balanced" })).rejects.toThrow(/round robin/);
    await expect(updateCalendar(owner, cal.id, { assignment: "round_robin", members: [{ userId: a.people.owner.id }, { userId: a.people.owner.id }] })).rejects.toThrow(/listed once/);
    await expect(updateAppointmentType(a.actor("sales"), t.id, { requirePhone: true })).rejects.toThrow(/role/);
    // Choice questions are stored trimmed; other questions never keep options.
    await updateAppointmentType(owner, t.id, { questions: [{ key: "slot", label: " When? ", type: "select", required: true, options: [" Morning ", "Afternoon"] }, { key: "notes", label: "Notes", type: "text", required: false, options: ["stray"] }] });
    const saved = (await listCalendars(owner)).find((c) => c.id === cal.id)!.types.find((x) => x.id === t.id)!;
    expect(saved.questions).toEqual([{ key: "slot", label: "When?", type: "select", required: true, options: ["Morning", "Afternoon"] }, { key: "notes", label: "Notes", type: "text", required: false }]);
  });
});

describe("publishing a booking page", () => {
  it("can't go public without an active host and a shown type, and says why", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const cal = await createCalendar(owner, { name: "Launch", members: [{ userId: c.people.sales.id }] });
    await expect(setCalendarPublic(owner, cal.id, true)).rejects.toThrow(/no appointment types/);
    const t = await createAppointmentType(owner, cal.id, { name: "Hidden", durationMinutes: 30, public: false });
    await expect(setCalendarPublic(owner, cal.id, true)).rejects.toThrow(/hidden from the booking page/);
    // The edit form's switch goes through the same check.
    await expect(updateCalendar(owner, cal.id, { public: true })).rejects.toThrow(/hidden from the booking page/);
    await setAppointmentTypePublic(owner, t.id, true);
    await expect(setCalendarPublic(c.actor("sales"), cal.id, true)).rejects.toThrow(/role/);
    await setCalendarPublic(owner, cal.id, true);
    expect((await listCalendars(owner)).find((x) => x.id === cal.id)?.public).toBe(true);
    // Turning it on again is a no-op; off always works.
    await setCalendarPublic(owner, cal.id, true);
    await setCalendarPublic(owner, cal.id, false);

    // A host who left the workspace doesn't count.
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [c.org.id, c.people.sales.id]));
    await expect(setCalendarPublic(owner, cal.id, true)).rejects.toThrow(/Nobody active hosts/);
    await withSystem((db) => db.query("update organization_memberships set status = 'active' where org_id = $1 and user_id = $2", [c.org.id, c.people.sales.id]));
    await updateCalendar(owner, cal.id, { public: true, bookingIntro: "Welcome" });
    const audit = await withSystem((db) => db.query<{ action: string }>("select action from audit_logs where org_id = $1 and target_id = $2 and action like 'crm.calendar_%' order by created_at", [c.org.id, cal.id]));
    expect(audit.rows.map((r) => r.action)).toEqual(["crm.calendar_created", "crm.calendar_published", "crm.calendar_unpublished", "crm.calendar_published"]);
  });

  it("explains why a page isn't live: off, no hours for the people who'd take it, paused, nothing shown", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const single = await calendarWithType(c, { hosts: ["sales"], hours: false });
    let pages = (await listBookingPages(owner)).pages;
    expect(pages.find((p) => p.calendarId === single.calendarId)).toMatchObject({ live: false, blockers: [{ code: "calendar_private" }, { code: "no_hours", people: [{ userId: c.people.sales.id }] }] });
    await setCalendarPublic(owner, single.calendarId, true);
    await setHostAvailability(owner, c.people.sales.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    pages = (await listBookingPages(owner)).pages;
    const page = pages.find((p) => p.calendarId === single.calendarId)!;
    expect(page).toMatchObject({ live: true, blockers: [] });
    expect(page.types[0]).toMatchObject({ live: true, public: true });
    expect((await listBookingPages(owner)).orgSlug).toBe(c.org.slug);

    await setHostAvailability(owner, c.people.sales.id, { timezone: "Asia/Manila", accepting: false, rules: WEEKDAYS_9_TO_5 });
    expect((await listBookingPages(owner)).pages.find((p) => p.calendarId === single.calendarId)?.blockers).toEqual([{ code: "not_accepting" }]);
    await setHostAvailability(owner, c.people.sales.id, { timezone: "Asia/Manila", accepting: true, rules: WEEKDAYS_9_TO_5 });
    await setAppointmentTypePublic(owner, single.typeId, false);
    expect((await listBookingPages(owner)).pages.find((p) => p.calendarId === single.calendarId)).toMatchObject({ live: false, blockers: [{ code: "no_public_types" }] });
    await archiveAppointmentType(owner, single.typeId);
    expect((await listBookingPages(owner)).pages.find((p) => p.calendarId === single.calendarId)?.blockers).toEqual([{ code: "no_types" }]);

    // Round robin needs one host with hours; collective needs all of them.
    const rr = await calendarWithType(c, { hosts: ["owner", "setter"], assignment: "round_robin", hours: false });
    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    await setCalendarPublic(owner, rr.calendarId, true);
    expect((await listBookingPages(owner)).pages.find((p) => p.calendarId === rr.calendarId)).toMatchObject({ live: true });
    const team = await calendarWithType(c, { hosts: ["owner", "setter"], assignment: "collective", hours: false });
    await setCalendarPublic(owner, team.calendarId, true);
    expect((await listBookingPages(owner)).pages.find((p) => p.calendarId === team.calendarId)).toMatchObject({ live: false, blockers: [{ code: "no_hours", people: [{ userId: c.people.setter.id }] }] });
    // Everyone who can see the calendar can see the list.
    expect((await listBookingPages(c.actor("viewer"))).pages.length).toBe(pages.length + 2);
  });
});

describe("appointment type order and copies", () => {
  it("reorders a calendar's types, and only with the full current list", async () => {
    const owner = a.actor("owner");
    const cal = await createCalendar(owner, { name: "Ordered" });
    const one = await createAppointmentType(owner, cal.id, { name: "One", durationMinutes: 30 });
    const two = await createAppointmentType(owner, cal.id, { name: "Two", durationMinutes: 30 });
    const three = await createAppointmentType(owner, cal.id, { name: "Three", durationMinutes: 30 });
    await reorderAppointmentTypes(owner, cal.id, [three.id, one.id, two.id]);
    const order = async () => (await listCalendars(owner)).find((c) => c.id === cal.id)!.types.map((t) => t.name);
    expect(await order()).toEqual(["Three", "One", "Two"]);
    await expect(reorderAppointmentTypes(owner, cal.id, [three.id, one.id])).rejects.toThrow(/Reload/);
    await expect(reorderAppointmentTypes(owner, cal.id, [three.id, one.id, one.id])).rejects.toThrow(/once/);
    await expect(reorderAppointmentTypes(a.actor("manager"), cal.id, [one.id, two.id, three.id])).resolves.toBeUndefined();
    await expect(reorderAppointmentTypes(a.actor("sales"), cal.id, [one.id, two.id, three.id])).rejects.toThrow(/role/);
    await archiveAppointmentType(owner, two.id);
    await reorderAppointmentTypes(owner, cal.id, [three.id, one.id]);
    expect(await order()).toEqual(["Three", "One"]);
  });

  it("duplicates a type with its settings and questions, hidden and last", async () => {
    const owner = a.actor("owner");
    const cal = await createCalendar(owner, { name: "Copies" });
    const src = await createAppointmentType(owner, cal.id, {
      name: "Consultation", durationMinutes: 50, bufferAfterMinutes: 10, capacity: 4, locationKind: "in_person", locationDetail: "12 Mango St", requirePhone: true, confirmationMessage: "See you soon",
      questions: [{ key: "topic", label: "Topic", type: "text", required: true }],
    });
    await createAppointmentType(owner, cal.id, { name: "Other", durationMinutes: 30 });
    const copy = await duplicateAppointmentType(owner, src.id);
    const again = await duplicateAppointmentType(owner, src.id);
    const types = (await listCalendars(owner)).find((c) => c.id === cal.id)!.types;
    const c1 = types.find((t) => t.id === copy.id)!;
    expect(c1).toMatchObject({ name: "Consultation (copy)", slug: "consultation-copy", public: false, durationMinutes: 50, bufferAfterMinutes: 10, capacity: 4, locationKind: "in_person", locationDetail: "12 Mango St", requirePhone: true, confirmationMessage: "See you soon" });
    expect(c1.questions).toEqual([{ key: "topic", label: "Topic", type: "text", required: true }]);
    expect(types.find((t) => t.id === again.id)?.slug).toBe("consultation-copy-2");
    expect(types.map((t) => t.id).slice(-2)).toEqual([copy.id, again.id]);
    await expect(duplicateAppointmentType(a.actor("viewer"), src.id)).rejects.toThrow(/role/);
  });
});

describe("working hours and days off", () => {
  it("people change their own hours and days; someone else's, or the whole workspace's, need calendar management", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await calendarWithType(c, { hosts: ["sales"] });
    const sales = c.actor("sales");
    const manager = c.actor("manager");
    await setHostAvailability(sales, c.people.sales.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    await setHostAvailability(c.actor("viewer"), c.people.viewer.id, { timezone: "UTC", rules: [] });
    await expect(setHostAvailability(sales, c.people.setter.id, { timezone: "Asia/Manila", rules: [] })).rejects.toThrow(/someone else/);
    await setHostAvailability(manager, c.people.setter.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });

    // Away for lunch: the day keeps the hours either side.
    await setDayException(sales, { userId: c.people.sales.id, date: DAY, windows: [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1020 }], reason: "Dentist" });
    expect(await slotHours(c, typeId)).toEqual([9, 10, 11, 14, 15, 16]);
    // Saving the day again replaces what was there.
    await setDayException(sales, { userId: c.people.sales.id, date: DAY, windows: [{ startMinute: 600, endMinute: 660 }] });
    expect(await slotHours(c, typeId)).toEqual([10]);
    const mine = (await listHostAvailability(sales)).overrides.filter((o) => o.userId === c.people.sales.id && o.date === DAY);
    expect(mine).toHaveLength(1);

    await expect(setDayException(sales, { userId: c.people.owner.id, date: DAY, windows: null })).rejects.toThrow(/calendar management/);
    await expect(setDayException(sales, { userId: null, date: DAY, windows: null, reason: "Holiday" })).rejects.toThrow(/calendar management/);
    await setDayException(manager, { userId: null, date: addDays(DAY, 1), windows: null, reason: "Holiday" });
    expect(await slotHours(c, typeId, addDays(DAY, 1))).toEqual([]);
    await expect(clearDayException(sales, { userId: null, date: addDays(DAY, 1) })).rejects.toThrow(/calendar management/);
    await expect(clearDayException(c.actor("viewer"), { userId: c.people.sales.id, date: DAY })).rejects.toThrow(/calendar management/);

    await clearDayException(sales, { userId: c.people.sales.id, date: DAY });
    expect(await slotHours(c, typeId)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    await expect(clearDayException(sales, { userId: c.people.sales.id, date: DAY })).rejects.toThrow(/doesn't exist/);
    await clearDayException(manager, { userId: null, date: addDays(DAY, 1) });
    expect((await slotHours(c, typeId, addDays(DAY, 1))).length).toBe(8);
  });

  it("checks the day's windows and the date", async () => {
    const owner = a.actor("owner");
    const me = a.people.owner.id;
    await expect(setDayException(owner, { userId: me, date: "2026-02-30", windows: null })).rejects.toThrow(/date/);
    await expect(setDayException(owner, { userId: me, date: DAY, windows: [] })).rejects.toThrow(/close the whole day/);
    await expect(setDayException(owner, { userId: me, date: DAY, windows: [{ startMinute: 600, endMinute: 720 }, { startMinute: 700, endMinute: 800 }] })).rejects.toThrow(/overlap/);
    await expect(setDayException(owner, { userId: me, date: DAY, windows: [{ startMinute: 720, endMinute: 600 }] })).rejects.toThrow(/start before its end/);
    await expect(setDayException(owner, { userId: me, date: DAY, windows: null, reason: "x".repeat(121) })).rejects.toThrow(/120/);
    const r = await setDayException(owner, { userId: me, date: DAY, windows: null, reason: "Training" });
    expect(r.ids).toHaveLength(1);
    const saved = (await listHostAvailability(owner)).overrides.find((o) => o.id === r.ids[0]);
    expect(saved).toMatchObject({ userId: me, date: DAY, startMinute: null, endMinute: null, reason: "Training" });
  });

  it("lists everyone who can host for the pickers", async () => {
    const people = await listSchedulingPeople(a.actor("viewer"));
    expect(people.map((p) => p.id).sort()).toEqual(Object.values(a.people).map((p) => p.id).sort());
  });
});

describe("meeting links", () => {
  it("shows which hosts have a connected calendar that can add events, to calendar managers only", async () => {
    const c = await crmOrg();
    await withSystem(async (db) => {
      await db.query(
        "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, write_events, external_calendar_id) values ($1, $2, 'google', 'owner@example.test', 'connected', true, 'primary')",
        [c.org.id, c.people.owner.id],
      );
      await db.query(
        "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, write_events, external_calendar_id) values ($1, $2, 'microsoft', 'sales@example.test', 'needs_reauth', true, 'cal-1')",
        [c.org.id, c.people.sales.id],
      );
      await db.query(
        "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, write_events, external_calendar_id) values ($1, $2, 'google', 'read-only@example.test', 'connected', false, null)",
        [c.org.id, c.people.setter.id],
      );
    });
    expect(await hostMeetingSupport(c.actor("owner"))).toEqual({ [c.people.owner.id]: { google: true, microsoft: false } });
    await expect(hostMeetingSupport(c.actor("sales"))).rejects.toThrow(/role/);
    expect(await hostMeetingSupport(b.actor("owner"))).toEqual({});
  });
});

describe("GoHighLevel and agency sessions", () => {
  it("refuses changes while GoHighLevel owns calendars, and in a read-only support session", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const { calendarId, typeId } = await calendarWithType(c);
    const agency = await agencyPeople();
    await startSupportSession(agency.superAdmin, c.org.id, { mode: "read", reason: "Checking the booking page" });
    const reader = await agencyActor(agency.superAdmin, c.org.id);
    expect((await listBookingPages(reader)).pages.map((p) => p.calendarId)).toEqual([calendarId]);
    await expect(setCalendarPublic(reader, calendarId, true)).rejects.toThrow(/read-only/);
    await expect(setDayException(reader, { userId: null, date: DAY, windows: null })).rejects.toThrow(/read-only/);

    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
    const owner = c.actor("owner");
    await expect(setCalendarPublic(owner, calendarId, true)).rejects.toThrow(/GoHighLevel/);
    await expect(reorderAppointmentTypes(owner, calendarId, [typeId])).rejects.toThrow(/GoHighLevel/);
    await expect(duplicateAppointmentType(owner, typeId)).rejects.toThrow(/GoHighLevel/);
    await expect(setAppointmentTypePublic(owner, typeId, false)).rejects.toThrow(/GoHighLevel/);
    await expect(setDayException(owner, { userId: c.people.owner.id, date: DAY, windows: null })).rejects.toThrow(/GoHighLevel/);
    await withSystem((db) => db.query("update crm_workspaces set mode = 'native' where org_id = $1", [c.org.id]));
  });
});

describe("tenant isolation", () => {
  it("never reaches another workspace's calendars, types, people or days", async () => {
    const { calendarId, typeId } = await calendarWithType(a);
    await setDayException(a.actor("owner"), { userId: null, date: addDays(DAY, 2), windows: null, reason: "A's holiday" });
    const other = b.actor("owner");
    await expect(setCalendarPublic(other, calendarId, true)).rejects.toThrow(/not found/);
    await expect(updateCalendar(other, calendarId, { bookingIntro: "Hijacked" })).rejects.toThrow(/not found/);
    await expect(reorderAppointmentTypes(other, calendarId, [typeId])).rejects.toThrow(/not found/);
    await expect(duplicateAppointmentType(other, typeId)).rejects.toThrow(/not found/);
    await expect(setAppointmentTypePublic(other, typeId, false)).rejects.toThrow(/not found/);
    await expect(updateAppointmentType(other, typeId, { requirePhone: true })).rejects.toThrow(/not found/);
    // B's own calendar can't take A's type ids either.
    const bCal = await createCalendar(other, { name: "B calendar" });
    await expect(reorderAppointmentTypes(other, bCal.id, [typeId])).rejects.toThrow(/Reload/);
    // People and days off belong to one workspace.
    await expect(setDayException(other, { userId: a.people.owner.id, date: DAY, windows: null })).rejects.toThrow(/active member/);
    await expect(clearDayException(other, { userId: null, date: addDays(DAY, 2) })).rejects.toThrow(/doesn't exist/);
    const aHoliday = await withSystem((db) => db.query("select 1 from crm_availability_overrides where org_id = $1 and user_id is null and on_date = $2", [a.org.id, addDays(DAY, 2)]));
    expect(aHoliday.rows).toHaveLength(1);
    expect((await listSchedulingPeople(other)).some((p) => p.id === a.people.owner.id)).toBe(false);
    expect((await listBookingPages(other)).pages.some((p) => p.calendarId === calendarId)).toBe(false);
    expect((await listHostAvailability(other)).overrides.some((o) => o.reason === "A's holiday")).toBe(false);
    const aTypes = (await listCalendars(a.actor("owner"))).find((c) => c.id === calendarId)!.types;
    expect(aTypes[0]).toMatchObject({ requirePhone: false, public: true });
    // Row-level security: B's member reading without any org filter sees none of A's rows.
    const seen = await withUser(b.people.viewer.id, (db) => db.query<{ org_id: string }>("select org_id from crm_availability_overrides union all select org_id from crm_calendars union all select org_id from crm_appointment_types"));
    expect(seen.rows.every((r) => r.org_id === b.org.id)).toBe(true);
  });
});

describe("settings form rules", () => {
  it("weekly hours: overlaps, copying a day to the workdays, and time away", () => {
    expect(dayProblem([{ startMinute: 540, endMinute: 720 }, { startMinute: 700, endMinute: 800 }])).toMatch(/overlap/);
    expect(dayProblem([{ startMinute: 600, endMinute: 600 }])).toMatch(/end after/);
    expect(dayProblem([{ startMinute: 540, endMinute: 720 }, { startMinute: 720, endMinute: 800 }])).toBeNull();
    const week = copyToWorkdays([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 780, endMinute: 1020 }, { weekday: 3, startMinute: 0, endMinute: 60 }, { weekday: 6, startMinute: 600, endMinute: 660 }], 1);
    expect(week.filter((r) => r.weekday === 3)).toEqual([{ weekday: 3, startMinute: 540, endMinute: 720 }, { weekday: 3, startMinute: 780, endMinute: 1020 }]);
    expect(week.filter((r) => r.weekday === 6)).toHaveLength(1);
    expect(week).toHaveLength(11);
    expect(hoursAroundAbsence([{ startMinute: 540, endMinute: 1020 }], { startMinute: 720, endMinute: 840 })).toEqual([{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1020 }]);
    expect(hoursAroundAbsence([{ startMinute: 540, endMinute: 1020 }], { startMinute: 480, endMinute: 600 })).toEqual([{ startMinute: 600, endMinute: 1020 }]);
    expect(hoursAroundAbsence([{ startMinute: 540, endMinute: 720 }, { startMinute: 780, endMinute: 1020 }], { startMinute: 500, endMinute: 1100 })).toEqual([]);
    expect(timeOptions("end", 15)).toContain(1440);
    expect(timeOptions("start", 15, 547)).toContain(547);
    expect(splitMinutes(2880)).toEqual({ value: 2, unit: "days" });
    expect(splitMinutes(90)).toEqual({ value: 90, unit: "minutes" });
  });

  it("question keys are unique and stable; the type form builds exactly what the server accepts", () => {
    expect(questionKey("What's the address?", [])).toBe("what_s_the_address");
    expect(questionKey("1st visit", [])).toBe("q_1st_visit");
    expect(questionKey("", [])).toBe("question");
    expect(questionKey("Topic", ["topic"])).toBe("topic_2");
    const drafts: QuestionDraft[] = [
      { id: "a", key: "topic", label: "Renamed topic", type: "text", required: true, optionsText: "" },
      { id: "b", key: null, label: "Topic", type: "select", required: false, optionsText: "Morning\n\n Afternoon " },
    ];
    expect(questionsForSave(drafts)).toEqual([
      { key: "topic", label: "Renamed topic", type: "text", required: true },
      { key: "topic_2", label: "Topic", type: "select", required: false, options: ["Morning", "Afternoon"] },
    ]);

    const form = typeFormFrom(null);
    expect(checkTypeForm({ ...form, name: "" }).errors.name).toBeTruthy();
    expect(checkTypeForm({ ...form, name: "Call", requireEmail: false, requirePhone: false }).errors.contact).toMatch(/email address or a phone number/);
    expect(checkTypeForm({ ...form, name: "Call", locationKind: "video", meetingProvider: "custom_link", meetingLink: "http://insecure.example" }).errors.meetingLink).toMatch(/https/);
    // A meeting link only applies to video calls.
    const phone = checkTypeForm({ ...form, name: "Call", locationKind: "phone", meetingProvider: "google_meet", notice: "2", noticeUnit: "days", cutoff: "3", cutoffUnit: "hours" });
    expect(phone.input).toMatchObject({ name: "Call", meetingProvider: "none", meetingLink: null, minNoticeMinutes: 2880, changeCutoffMinutes: 180, capacity: 1, requireEmail: true, requirePhone: false });
    const group = checkTypeForm({ ...form, name: "Class", group: true, capacity: "1" });
    expect(group.errors.capacity).toBeTruthy();
    expect(checkTypeForm({ ...form, name: "Class", group: true, capacity: "12", allowCustomerChanges: false, cutoff: "999999" }).input).toMatchObject({ capacity: 12, changeCutoffMinutes: 0, allowCustomerChanges: false });
  });
});

describe("settings screens", () => {
  const scopeOf = (c: CrmOrg, who: keyof CrmOrg["people"], manage: boolean, extra: Partial<CrmScope> = {}): CrmScope => ({
    base: "/crm", orgId: null, agency: false, readOnly: false, userId: c.people[who].id, timezone: "Asia/Manila", currency: "PHP",
    can: { "crm.view": true, "appointments.view": true, ...(manage ? { "calendars.manage": true as const } : {}) }, ...extra,
  });
  const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
  const json = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

  it("render real data: live and unfinished pages, each with its reasons, links and the controls the viewer may use", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const live = await calendarWithType(c, { hosts: ["owner"] });
    await setCalendarPublic(owner, live.calendarId, true);
    const draft = await calendarWithType(c, { hosts: ["sales"], hours: false });
    await updateAppointmentType(owner, draft.typeId, { public: false });
    const [calendars, booking, people, avail] = await Promise.all([listCalendars(owner), listBookingPages(owner), listSchedulingPeople(owner), listHostAvailability(owner)]);
    const ownerScope = scopeOf(c, "owner", true);

    const list = html(React.createElement(CalendarsManager, { scope: ownerScope, calendars: json(calendars), pages: booking.pages, people }));
    expect(list).toContain("Booking page live");
    expect(list).toContain("Booking page off");
    expect(list).toContain("New calendar");
    expect(list).toContain(`/crm/calendars/${draft.calendarId}`);
    // Without calendar management there's nothing to click that would only fail.
    const viewerList = html(React.createElement(CalendarsManager, { scope: scopeOf(c, "viewer", false), calendars: json(calendars), pages: booking.pages, people }));
    expect(viewerList).not.toContain("New calendar");
    // The notice names the permission (which can be granted to anyone, or withdrawn from a manager), not a role.
    expect(viewerList).toContain("Changing calendars and appointment types needs the “Set up calendars and booking pages” permission, which the business owner or a manager can give you.");
    expect(viewerList).not.toMatch(/owners and admins|owner or admin/i);

    const cal = calendars.find((x) => x.id === live.calendarId)!;
    const detail = html(React.createElement(CalendarDetail, { scope: ownerScope, calendar: json(cal), page: booking.pages.find((p) => p.calendarId === cal.id)!, people, orgSlug: booking.orgSlug, appUrl: "https://portal.example.test", meeting: {} }));
    expect(detail).toContain(`https://portal.example.test/book/${booking.orgSlug}/${cal.slug}`);
    expect(detail).toContain("Site visit");
    expect(detail).toContain("New appointment type");
    expect(detail).toContain(`Move Site visit up`);

    const pages = html(React.createElement(BookingPagesManager, { scope: ownerScope, pages: booking.pages, orgSlug: booking.orgSlug, appUrl: "https://portal.example.test" }));
    expect(pages).toContain("1 of 2 pages are live.");
    expect(pages).toContain("Sales Person has no weekly hours, so no time can be offered.");
    expect(pages).toContain(`/crm/availability?person=${c.people.sales.id}`);
    expect(pages).toContain("Every appointment type is hidden from the page.");
    expect(pages).toContain("The booking page is turned off.");

    const availability = html(React.createElement(AvailabilityManager, {
      scope: scopeOf(c, "sales", false), hosts: json(avail.hosts), people: [], overrides: json(avail.overrides), orgTimezone: avail.orgTimezone, timeZones: ["UTC", "Asia/Manila"], today: realToday, initialPerson: null,
    }));
    expect(availability).toContain("Save your hours");
    expect(availability).toContain("Fill in 9 to 5, Monday to Friday");
    expect(availability).not.toContain("Everyone (workspace holiday)");
    expect(availability).toContain("Set your own regular hours. Changing anyone else&#x27;s needs the “Set up calendars and booking pages” permission");
    // A manager sees everyone, can pick anyone and can add a workspace holiday.
    const managed = html(React.createElement(AvailabilityManager, {
      scope: ownerScope, hosts: json(avail.hosts), people, overrides: json(avail.overrides), orgTimezone: avail.orgTimezone, timeZones: ["UTC", "Asia/Manila"], today: realToday, initialPerson: c.people.sales.id,
    }));
    expect(managed).toContain("Everyone (workspace holiday)");
    expect(managed).toContain("Save Sales Person&#x27;s hours");
    expect(managed).toContain("Viewer Person");
  });
});
