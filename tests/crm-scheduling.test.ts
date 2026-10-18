// The calendar workspace: schedule reads, appointment detail, the staff booking actions and where /appointments sends a workspace.
// Synthetic workspaces only; nothing here contacts a calendar provider or sends a message.
import { readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ actor: null as null | import("@/server/crm/actor").CrmActor }));
// The actions resolve their actor from the session; here the test chooses who is acting, and the permission check still runs.
vi.mock("@/server/crm/request", async () => {
  const { assertCan } = await import("@/server/crm/actor");
  return {
    resolveCrmActor: async (_orgId: string | null, permission: import("@/lib/permissions").Permission) => {
      if (!who.actor) throw new Error("No actor chosen for this test.");
      assertCan(who.actor, permission);
      return who.actor;
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// The screens are rendered to HTML below without a running app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/crm/calendar",
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error("not-found");
  },
}));

import { withSystem, withUser } from "@/server/db";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { bookingPageActor, bookNativeAppointment, cancelNativeAppointment, rescheduleNativeAppointment } from "@/server/calendars/booking";
import {
  appointmentsAreNative, appointmentsHomeFor, getAppointmentDetail, getScheduleOverlay, listAppointmentPage, listBookableSlots, listSchedule, listScheduleFilters, nativeAppointmentsHome,
} from "@/server/calendars/schedule";
import {
  appointmentDetailAction, bookableSlotsAction, bookAppointmentAction, cancelAppointmentAction, rescheduleAppointmentAction, rescheduleSlotsAction, setAppointmentStatusAction,
} from "@/app/actions/crm-scheduling";
import { agencyActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import { sourceAvailability } from "@/server/queries/dashboard";
import { addDays, weekdayOf, zonedDate } from "@/lib/calendars/slots";
import { CRM_NAV, navFor } from "@/lib/crm/nav";
import {
  calendarQuery, followDrawerLink, layoutDay, minuteInDay, parseCalendarState, parseListState, rangeLabel, shiftDate, viewDays, viewRange, type DrawerLink,
} from "@/components/crm/scheduling/calendar-math";
import { permissionNeeded } from "@/lib/permissions";
import { timeRangeIn } from "@/components/crm/scheduling/format";
import { CalendarWorkspace } from "@/components/crm/scheduling/calendar-workspace";
import { AppointmentsList } from "@/components/crm/scheduling/appointments-list";
import type { ScheduleFilters, ScheduleItem } from "@/server/calendars/schedule";
import type { CrmScope } from "@/server/crm/page";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";

const TZ = "Asia/Manila";
const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
/** A Manila weekday at least `ahead` days from today (the actions use the real clock, so test days are relative to it). */
function weekday(ahead: number): string {
  let d = addDays(zonedDate(Date.now(), TZ), ahead);
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, 1);
  return d;
}
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+08:00`);
const dayWindow = (date: string) => ({ from: at(date, "00:00"), to: new Date(at(date, "00:00").getTime() + 86_400_000) });

const nextWeekday = (d: string) => {
  let n = addDays(d, 1);
  while (weekdayOf(n) === 0 || weekdayOf(n) === 6) n = addDays(n, 1);
  return n;
};
const D1 = weekday(4);
const D2 = nextWeekday(D1);
/** A weekday well in the past, booked "as of" the day before it, for outcomes (which need the appointment to have started). */
const PAST = (() => {
  let d = addDays(zonedDate(Date.now(), TZ), -12);
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, -1);
  return d;
})();
const PAST_NOW = at(addDays(PAST, -1), "00:00");

async function setup(c: CrmOrg, opts: { hosts?: Array<keyof CrmOrg["people"]>; name?: string; questions?: boolean } = {}) {
  const owner = c.actor("owner");
  const hosts = opts.hosts ?? ["owner"];
  for (const h of hosts) await setHostAvailability(owner, c.people[h].id, { timezone: TZ, rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: opts.name ?? `Consults ${Math.random().toString(36).slice(2, 6)}`, public: true, color: "#0f9d76", members: hosts.map((h) => ({ userId: c.people[h].id })), assignment: hosts.length > 1 ? "round_robin" : "single" });
  const type = await createAppointmentType(owner, cal.id, {
    name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 60, color: "#4f6bed",
    questions: opts.questions ? [{ key: "address", label: "Property address", type: "text", required: true }] : [],
  });
  return { calendarId: cal.id, typeId: type.id };
}

let a: CrmOrg;
let b: CrmOrg;
let aSetup: { calendarId: string; typeId: string };
let bSetup: { calendarId: string; typeId: string };
const as = (actor: CrmActor) => {
  who.actor = actor;
};

beforeAll(async () => {
  a = await crmOrg({ name: "Schedule A", timezone: TZ });
  b = await crmOrg({ name: "Schedule B", timezone: TZ });
  aSetup = await setup(a);
  bSetup = await setup(b);
});

describe("schedule reads", () => {
  it("lists this workspace's native appointments in a window, in start order, with type, calendar, hosts and the contact's name", async () => {
    const page = await bookingPageActor(a.org.id);
    const ten = await bookNativeAppointment(page, { typeId: aSetup.typeId, startAt: at(D1, "10:00"), contact: { firstName: "Ana", lastName: "Reyes", email: "ana.reyes@example.test" }, via: "booking_page" });
    const nine = await bookNativeAppointment(page, { typeId: aSetup.typeId, startAt: at(D1, "09:00"), contact: { firstName: "Ben", email: "ben@example.test" }, via: "booking_page" });
    const other = await bookNativeAppointment(await bookingPageActor(b.org.id), { typeId: bSetup.typeId, startAt: at(D1, "10:00"), contact: { firstName: "Cy", email: "cy@example.test" }, via: "booking_page" });
    // A GoHighLevel appointment in the same workspace belongs to its own read-only view, not this calendar.
    await withSystem((db) => db.query("insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at) values ($1, 'ghl_sched_1', 'cal_x', 'GHL', 'confirmed', $2, $3)", [a.org.id, at(D1, "11:00"), at(D1, "12:00")]));

    const items = await listSchedule(a.actor("viewer"), dayWindow(D1));
    expect(items.map((i) => i.id)).toEqual([nine.appointmentId, ten.appointmentId]);
    expect(items[1]).toMatchObject({
      status: "confirmed", bookedVia: "booking_page", version: 1, rescheduleCount: 0,
      type: { id: aSetup.typeId, name: "Site visit", color: "#4f6bed", durationMinutes: 60 },
      calendar: { id: aSetup.calendarId, color: "#0f9d76" },
      hosts: [{ id: a.people.owner.id, name: "Owner Person" }],
      contact: { name: "Ana Reyes" },
      startAt: at(D1, "10:00").toISOString(),
    });
    expect(Object.keys(items[1].contact ?? {}).sort()).toEqual(["id", "name"]);
    expect(items.some((i) => i.id === other.appointmentId)).toBe(false);
  });

  it("keeps other workspaces out under row-level security, even with no filter in the query", async () => {
    const mine = await listSchedule(a.actor("owner"), dayWindow(D1));
    expect(mine.length).toBeGreaterThan(0);
    const seenByB = await withUser(b.people.viewer.id, (db) => db.query<{ org_id: string }>("select org_id from appointment_refs where provider = 'native'"));
    expect(seenByB.rows.length).toBeGreaterThan(0);
    expect(seenByB.rows.every((r) => r.org_id === b.org.id)).toBe(true);
    const hostsSeenByB = await withUser(b.people.viewer.id, (db) => db.query<{ org_id: string }>("select org_id from crm_appointment_hosts"));
    expect(hostsSeenByB.rows.every((r) => r.org_id === b.org.id)).toBe(true);
    const bItems = await listSchedule(b.actor("owner"), dayWindow(D1));
    expect(bItems.some((i) => mine.some((m) => m.id === i.id))).toBe(false);
    await expect(getAppointmentDetail(b.actor("owner"), mine[0].id)).rejects.toThrow(/not found/);
    as(b.actor("owner"));
    expect(await appointmentDetailAction(null, mine[0].id)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("filters by calendar, person and status, and caps the window at 62 days", async () => {
    const c = await crmOrg({ timezone: TZ });
    const first = await setup(c, { name: "Owner calendar" });
    const second = await setup(c, { name: "Sales calendar", hosts: ["sales"] });
    const page = await bookingPageActor(c.org.id);
    const one = await bookNativeAppointment(page, { typeId: first.typeId, startAt: at(D1, "09:00"), contact: { firstName: "One", email: "one@example.test" }, via: "booking_page" });
    const two = await bookNativeAppointment(page, { typeId: second.typeId, startAt: at(D1, "09:00"), contact: { firstName: "Two", email: "two@example.test" }, via: "booking_page" });
    const three = await bookNativeAppointment(page, { typeId: first.typeId, startAt: at(D1, "13:00"), contact: { firstName: "Three", email: "three@example.test" }, via: "booking_page" });
    await cancelNativeAppointment(page, three.appointmentId, { by: "customer" });
    const viewer = c.actor("viewer");
    const ids = async (q: Parameters<typeof listSchedule>[1]) => (await listSchedule(viewer, q)).map((i) => i.id).sort();
    expect(await ids({ ...dayWindow(D1), calendarIds: [second.calendarId] })).toEqual([two.appointmentId]);
    expect(await ids({ ...dayWindow(D1), hostIds: [c.people.owner.id] })).toEqual([one.appointmentId, three.appointmentId].sort());
    expect(await ids({ ...dayWindow(D1), statuses: ["cancelled"] })).toEqual([three.appointmentId]);
    expect(await ids({ ...dayWindow(D1), statuses: ["new", "confirmed", "showed", "noshow"] })).toEqual([one.appointmentId, two.appointmentId].sort());
    const from = at(D1, "00:00");
    await expect(listSchedule(viewer, { from, to: new Date(from.getTime() + 63 * 86_400_000) })).rejects.toThrow(/62 days or less/);
    expect(await listSchedule(viewer, { from, to: new Date(from.getTime() + 62 * 86_400_000) })).toHaveLength(3);
    await expect(listSchedule(viewer, { from, to: from })).rejects.toThrow(/after its start/);
    await expect(listSchedule(viewer, { ...dayWindow(D1), calendarIds: ["not-a-calendar"] })).rejects.toThrow(/from the list/);
    // The filters offer the live calendars, their types and their active hosts.
    const f = await listScheduleFilters(viewer);
    expect(f.orgTimezone).toBe(TZ);
    expect(f.calendars.map((x) => x.name).sort()).toEqual(["Owner calendar", "Sales calendar"]);
    expect(f.calendars.find((x) => x.id === second.calendarId)).toMatchObject({ hostIds: [c.people.sales.id], types: [{ id: second.typeId, name: "Site visit", durationMinutes: 60 }] });
    expect(f.hosts.map((h) => h.id).sort()).toEqual([c.people.owner.id, c.people.sales.id].sort());
  });

  it("the appointments list splits upcoming from past, searches by customer and pages", async () => {
    const c = await crmOrg({ timezone: TZ });
    const s = await setup(c);
    const owner = c.actor("owner");
    for (const [i, hh] of ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"].entries()) {
      await bookNativeAppointment(owner, { typeId: s.typeId, startAt: at(D1, hh), contact: { firstName: i === 0 ? "Zelda" : `Person${i}`, email: `p${i}@example.test` }, via: "staff" });
    }
    await bookNativeAppointment(owner, { typeId: s.typeId, startAt: at(PAST, "09:00"), contact: { firstName: "Old", email: "old@example.test" }, via: "staff", now: PAST_NOW });
    const upcoming = await listAppointmentPage(c.actor("viewer"), { when: "upcoming", pageSize: 5, page: 1 });
    expect(upcoming.total).toBe(6);
    expect(upcoming.items).toHaveLength(5);
    expect(upcoming.items[0].startAt).toBe(at(D1, "09:00").toISOString());
    const second = await listAppointmentPage(c.actor("viewer"), { when: "upcoming", pageSize: 5, page: 2 });
    expect(second.items.map((i) => i.startAt)).toEqual([at(D1, "14:00").toISOString()]);
    const past = await listAppointmentPage(c.actor("viewer"), { when: "past" });
    expect(past.items.map((i) => i.contact?.name)).toEqual(["Old"]);
    expect((await listAppointmentPage(c.actor("viewer"), { when: "upcoming", search: "zel" })).items.map((i) => i.contact?.name)).toEqual(["Zelda"]);
    const range = await listAppointmentPage(c.actor("viewer"), { when: "range", from: at(D1, "10:00"), to: at(D1, "12:00") });
    expect(range.total).toBe(2);
    await expect(listAppointmentPage(c.actor("viewer"), { when: "range" })).rejects.toThrow(/both dates/);
  });

  it("an appointment that was moved and then cancelled keeps its answers, notes, reason, the customer's time zone and its history", async () => {
    const c = await crmOrg({ timezone: TZ });
    const s = await setup(c, { questions: true });
    const page = await bookingPageActor(c.org.id);
    const booked = await bookNativeAppointment(page, {
      typeId: s.typeId, startAt: at(D1, "09:00"), contact: { firstName: "Gia", email: "gia@example.test" }, answers: { address: "12 Mango St" }, notes: "Bring the floor plan",
      inviteeTimezone: "America/New_York", via: "booking_page",
    });
    await rescheduleNativeAppointment(c.actor("owner"), booked.appointmentId, { startAt: at(D1, "14:00"), by: "staff", expectedVersion: 1 });
    await cancelNativeAppointment(c.actor("manager"), booked.appointmentId, { by: "staff", reason: "Customer is travelling" });
    const d = await getAppointmentDetail(c.actor("viewer"), booked.appointmentId);
    expect(d).toMatchObject({
      status: "cancelled", cancelReason: "Customer is travelling", rescheduleCount: 1, previousStartAt: at(D1, "09:00").toISOString(), startAt: at(D1, "14:00").toISOString(),
      inviteeTimezone: "America/New_York", timezone: TZ, description: "Bring the floor plan", answers: [{ key: "address", label: "Property address", value: "12 Mango St" }],
      assignment: "single", version: 3,
    });
    expect(d.cancelledAt).toBeTruthy();
    expect(d.history.map((h) => h.kind)).toEqual(["appointment.booked", "appointment.rescheduled", "appointment.cancelled"]);
    expect(d.history[1].actor).toBe("Owner Person");
    expect(d.history[2].actor).toBe("Manager Person");
    expect(d.history[0].actor).toBeNull();
  });

  it("shades working hours and shows busy times from connected calendars only, without any event details", async () => {
    const c = await crmOrg({ timezone: TZ });
    const s = await setup(c);
    const owner = c.people.owner.id;
    const conns = await withSystem((db) => db.query<{ id: string; status: string }>(
      `insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, check_conflicts) values ($1, $2, 'ics', 'Work feed', 'connected', true), ($1, $2, 'ics', 'Old feed', 'disconnected', true) returning id, status`,
      [c.org.id, owner],
    ));
    const live = conns.rows.find((r) => r.status === "connected")!.id;
    const gone = conns.rows.find((r) => r.status === "disconnected")!.id;
    await withSystem((db) => db.query(
      `insert into crm_external_busy (org_id, connection_id, user_id, external_ref, starts_at, ends_at) values ($1, $2, $4, $5, $6, $7), ($1, $3, $4, $8, $9, $10)`,
      [c.org.id, live, gone, owner, "a".repeat(64), at(D1, "13:00"), at(D1, "14:00"), "b".repeat(64), at(D1, "15:00"), at(D1, "16:00")],
    ));
    const [o] = await getScheduleOverlay(c.actor("viewer"), { ...dayWindow(D1), hostIds: [owner] });
    expect(o).toMatchObject({ userId: owner, timezone: TZ, accepting: true });
    expect(o.working).toEqual([{ start: at(D1, "09:00").toISOString(), end: at(D1, "17:00").toISOString() }]);
    expect(o.busy).toEqual([{ start: at(D1, "13:00").toISOString(), end: at(D1, "14:00").toISOString() }]);
    expect(Object.keys(o.busy[0]).sort()).toEqual(["end", "start"]);
    // The same busy time is what staff booking avoids.
    const slots = await listBookableSlots(c.actor("owner"), { typeId: s.typeId, ...dayWindow(D1) });
    expect(slots.map((s) => s.start)).not.toContain(at(D1, "13:00").toISOString());
    expect(slots.map((s) => s.start)).toContain(at(D1, "15:00").toISOString());
  });
});

describe("staff actions", () => {
  it("a viewer can't book; a sales rep books (and never sees the customer's link) but can't move, cancel or record outcomes", async () => {
    as(a.actor("viewer"));
    const refused = await bookAppointmentAction(null, { typeId: aSetup.typeId, startAt: at(D2, "09:00").toISOString(), contact: { kind: "new", firstName: "Vi", email: "vi@example.test" }, idempotencyKey: `staff:${crypto.randomUUID()}` });
    expect(refused).toMatchObject({ ok: false, code: "forbidden" });
    expect(await bookableSlotsAction(null, { typeId: aSetup.typeId, ...iso(dayWindow(D2)) })).toMatchObject({ ok: false, code: "forbidden" });

    as(a.actor("sales"));
    const slots = await bookableSlotsAction(null, { typeId: aSetup.typeId, ...iso(dayWindow(D2)) });
    expect(slots.ok && slots.data.map((s) => s.start)).toContain(at(D2, "09:00").toISOString());
    const key = `staff:${crypto.randomUUID()}`;
    const booked = await bookAppointmentAction(null, { typeId: aSetup.typeId, startAt: at(D2, "09:00").toISOString(), contact: { kind: "new", firstName: "Rae", lastName: "Cruz", email: "rae@example.test" }, notes: "Wants a quote", idempotencyKey: key });
    if (!booked.ok) throw new Error(booked.error);
    expect(booked.data).toMatchObject({ status: "confirmed", created: true, hostIds: [a.people.owner.id], startAt: at(D2, "09:00").toISOString() });
    expect(JSON.stringify(booked.data)).not.toMatch(/manage|token/i);
    const again = await bookAppointmentAction(null, { typeId: aSetup.typeId, startAt: at(D2, "09:00").toISOString(), contact: { kind: "new", firstName: "Rae", email: "rae@example.test" }, idempotencyKey: key });
    expect(again).toMatchObject({ ok: true, data: { appointmentId: booked.data.appointmentId, created: false } });
    const row = await withSystem((db) => db.query<{ booked_via: string; origin: string; created_by: string; description: string }>("select booked_via, origin, created_by, description from appointment_refs where id = $1", [booked.data.appointmentId]));
    expect(row.rows[0]).toEqual({ booked_via: "staff", origin: "portal_staff", created_by: a.people.sales.id, description: "Wants a quote" });

    const id = booked.data.appointmentId;
    expect(await rescheduleSlotsAction(null, id, iso(dayWindow(D2)))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await rescheduleAppointmentAction(null, id, { startAt: at(D2, "11:00").toISOString(), expectedVersion: 1 })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await cancelAppointmentAction(null, id, "No")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setAppointmentStatusAction(null, id, "confirmed")).toMatchObject({ ok: false, code: "forbidden" });
    // Everyone in the workspace can read it.
    as(a.actor("viewer"));
    expect(await appointmentDetailAction(null, id)).toMatchObject({ ok: true, data: { id, contact: { name: "Rae Cruz" }, bookedVia: "staff" } });
  });

  it("a manager moves an appointment with the version they saw, cancels it with a reason, and records outcomes once it has started", async () => {
    const page = await bookingPageActor(a.org.id);
    const appt = await bookNativeAppointment(page, { typeId: aSetup.typeId, startAt: at(D2, "13:00"), contact: { firstName: "Mo", email: "mo@example.test" }, via: "booking_page" });
    as(a.actor("manager"));
    const free = await rescheduleSlotsAction(null, appt.appointmentId, iso(dayWindow(D2)));
    if (!free.ok) throw new Error(free.error);
    // Its own time counts as free, and the host stays.
    expect(free.data.find((s) => s.start === at(D2, "13:00").toISOString())).toMatchObject({ keepsHost: true });
    expect(free.data.map((s) => s.start)).not.toContain(at(D2, "09:00").toISOString());
    const moved = await rescheduleAppointmentAction(null, appt.appointmentId, { startAt: at(D2, "15:00").toISOString(), expectedVersion: 1 });
    expect(moved).toMatchObject({ ok: true, data: { startAt: at(D2, "15:00").toISOString() } });
    const stale = await rescheduleAppointmentAction(null, appt.appointmentId, { startAt: at(D2, "16:00").toISOString(), expectedVersion: 1 });
    expect(stale).toMatchObject({ ok: false, code: "conflict", error: expect.stringMatching(/Someone else changed/) });
    const early = await setAppointmentStatusAction(null, appt.appointmentId, "showed");
    expect(early).toMatchObject({ ok: false, code: "conflict", error: expect.stringMatching(/once the appointment has started/) });
    const cancelled = await cancelAppointmentAction(null, appt.appointmentId, "  Double booked by mistake  ");
    expect(cancelled).toMatchObject({ ok: true, data: { changed: true } });
    const d = await getAppointmentDetail(a.actor("viewer"), appt.appointmentId);
    expect(d).toMatchObject({ status: "cancelled", cancelReason: "Double booked by mistake", version: 3 });
    expect(await rescheduleSlotsAction(null, appt.appointmentId, iso(dayWindow(D2)))).toMatchObject({ ok: false, code: "conflict" });

    const past = await bookNativeAppointment(a.actor("owner"), { typeId: aSetup.typeId, startAt: at(PAST, "10:00"), contact: { firstName: "Pat", email: "pat@example.test" }, via: "staff", now: PAST_NOW });
    expect(await setAppointmentStatusAction(null, past.appointmentId, "noshow")).toMatchObject({ ok: true });
    expect(await setAppointmentStatusAction(null, past.appointmentId, "showed")).toMatchObject({ ok: true });
    expect((await getAppointmentDetail(a.actor("viewer"), past.appointmentId)).history.map((h) => h.kind)).toEqual(["appointment.booked", "appointment.no_show", "appointment.showed"]);
  });

  it("a booking that needs confirmation is confirmed by a manager, once", async () => {
    const c = await crmOrg({ timezone: TZ });
    const s = await setup(c);
    await withSystem((db) => db.query("update crm_appointment_types set requires_confirmation = true where id = $1", [s.typeId]));
    const r = await bookNativeAppointment(await bookingPageActor(c.org.id), { typeId: s.typeId, startAt: at(D1, "10:00"), contact: { firstName: "Nia", email: "nia@example.test" }, via: "booking_page" });
    expect(r.status).toBe("new");
    as(c.actor("manager"));
    expect(await setAppointmentStatusAction(null, r.appointmentId, "confirmed")).toMatchObject({ ok: true });
    expect(await setAppointmentStatusAction(null, r.appointmentId, "confirmed")).toMatchObject({ ok: false, code: "conflict" });
    expect((await listSchedule(c.actor("viewer"), dayWindow(D1)))[0]).toMatchObject({ id: r.appointmentId, status: "confirmed", version: 2 });
  });

  it("checks input before it reaches the calendar", async () => {
    as(a.actor("owner"));
    const base = { typeId: aSetup.typeId, startAt: at(D2, "10:00").toISOString(), idempotencyKey: `staff:${crypto.randomUUID()}` };
    expect(await bookAppointmentAction(null, { ...base, contact: { kind: "new", firstName: "No Contact" } })).toMatchObject({ ok: false, code: "invalid_input", error: expect.stringMatching(/email address or a phone number/) });
    expect(await bookAppointmentAction(null, { ...base, contact: { kind: "new", firstName: " ", email: "x@example.test" } })).toMatchObject({ ok: false, code: "invalid_input", error: expect.stringMatching(/first name/) });
    expect(await bookAppointmentAction(null, { ...base, contact: { kind: "new", firstName: "Bad", email: "not-an-email" } })).toMatchObject({ ok: false, code: "invalid_input", error: expect.stringMatching(/valid email/) });
    expect(await bookAppointmentAction(null, { ...base, idempotencyKey: "nope", contact: { kind: "new", firstName: "K", email: "k@example.test" } })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await bookAppointmentAction(null, { ...base, typeId: "x", contact: { kind: "new", firstName: "K", email: "k@example.test" } })).toMatchObject({ ok: false, code: "invalid_input" });
    // Another workspace's type is simply not available here.
    expect(await bookAppointmentAction(null, { ...base, typeId: bSetup.typeId, contact: { kind: "new", firstName: "K", email: "k@example.test" } })).toMatchObject({ ok: false, code: "not_found" });
    // A time that isn't free (outside working hours) is refused by the calendar itself.
    expect(await bookAppointmentAction(null, { ...base, startAt: at(D2, "20:00").toISOString(), contact: { kind: "new", firstName: "K", email: "k@example.test" } })).toMatchObject({ ok: false, code: "conflict" });
    expect(await bookableSlotsAction(null, { typeId: aSetup.typeId, from: at(D2, "00:00").toISOString(), to: new Date(at(D2, "00:00").getTime() + 40 * 86_400_000).toISOString() })).toMatchObject({ ok: false, error: expect.stringMatching(/31 days or less/) });
  });

  it("refuses when GoHighLevel owns appointments, and a read-only agency session can look but not book", async () => {
    const c = await crmOrg({ timezone: TZ });
    const s = await setup(c);
    const agency = await agencyPeople();
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [c.org.id, agency.staff.id]));
    await startSupportSession(agency.staff, c.org.id, { mode: "read", reason: "Checking the calendar setup" });
    const support = await agencyActor(agency.staff, c.org.id);
    expect(await listSchedule(support, dayWindow(D1))).toEqual([]);
    as(support);
    expect(await bookAppointmentAction(c.org.id, { typeId: s.typeId, startAt: at(D1, "10:00").toISOString(), contact: { kind: "new", firstName: "Ag", email: "ag@example.test" }, idempotencyKey: `staff:${crypto.randomUUID()}` }))
      .toMatchObject({ ok: false, code: "forbidden", error: expect.stringMatching(/read-only/) });

    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
    as(c.actor("owner"));
    expect(await bookableSlotsAction(null, { typeId: s.typeId, ...iso(dayWindow(D1)) })).toMatchObject({ ok: false, code: "conflict", error: expect.stringMatching(/GoHighLevel/) });
    expect(await bookAppointmentAction(null, { typeId: s.typeId, startAt: at(D1, "10:00").toISOString(), contact: { kind: "new", firstName: "G", email: "g@example.test" }, idempotencyKey: `staff:${crypto.randomUUID()}` }))
      .toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("where /appointments sends a workspace", () => {
  it("decides from the workspace mode and who owns appointments", () => {
    expect(appointmentsHomeFor("native", null)).toBe("/crm/calendar");
    expect(appointmentsHomeFor("ghl", null)).toBeNull();
    expect(appointmentsHomeFor("ghl", "native")).toBeNull();
    expect(appointmentsHomeFor("hybrid", null)).toBe("/crm/calendar");
    expect(appointmentsHomeFor("hybrid", "ghl")).toBeNull();
    expect(appointmentsHomeFor("hybrid", "native")).toBe("/crm/calendar");
    expect(appointmentsHomeFor(null, null)).toBeNull();
  });

  it("sends native workspaces to the CRM calendar and leaves GoHighLevel ones on their view; the dashboard counts the native calendar", async () => {
    const c = await crmOrg();
    expect(await nativeAppointmentsHome(c.org.id)).toBe("/crm/calendar");
    expect((await withUser(c.people.viewer.id, (db) => sourceAvailability(db, c.org.id, false))).calendar).toBe(true);
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
    expect(await nativeAppointmentsHome(c.org.id)).toBeNull();
    // GoHighLevel tenants still need their calendar connected, exactly as before.
    expect((await withUser(c.people.viewer.id, (db) => sourceAvailability(db, c.org.id, false))).calendar).toBe(false);
    await withSystem(async (db) => {
      await db.query("update crm_workspaces set mode = 'hybrid' where org_id = $1", [c.org.id]);
      await db.query("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'appointments', 'ghl')", [c.org.id]);
    });
    expect(await nativeAppointmentsHome(c.org.id)).toBeNull();
    await withSystem((db) => db.query("update crm_capability_providers set provider = 'native' where org_id = $1 and capability = 'appointments'", [c.org.id]));
    expect(await nativeAppointmentsHome(c.org.id)).toBe("/crm/calendar");
    // Someone who can't see the workspace's CRM settings gets the old answer rather than an error.
    const stranger = await crmOrg();
    expect(await withUser(stranger.people.owner.id, (db) => appointmentsAreNative(db, c.org.id))).toBe(false);
  });
});

describe("calendar maths", () => {
  it("lays out weeks from Sunday, months as whole weeks, and windows at the zone's midnights", () => {
    expect(viewDays("week", "2026-10-21")).toEqual(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
    const month = viewDays("month", "2026-10-16");
    expect([month[0], month[month.length - 1], month.length]).toEqual(["2026-09-27", "2026-10-31", 35]);
    expect(viewDays("agenda", "2026-10-16")).toHaveLength(30);
    const r = viewRange("day", "2026-10-20", TZ);
    expect([r.from.toISOString(), r.to.toISOString()]).toEqual(["2026-10-19T16:00:00.000Z", "2026-10-20T16:00:00.000Z"]);
    expect(shiftDate("month", "2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftDate("week", "2026-10-20", -1)).toBe("2026-10-13");
    expect(rangeLabel("week", "2026-10-21")).toBe("Oct 18 – 24, 2026");
    expect(rangeLabel("week", "2026-12-30")).toBe("Dec 27, 2026 – Jan 2, 2027");
    expect(rangeLabel("month", "2026-10-02")).toBe("October 2026");
  });

  it("normalizes ICU-specific spaces in appointment time ranges", () => {
    expect(timeRangeIn("2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z", "UTC")).toBe("10:00 – 11:00 AM");
    expect(timeRangeIn("2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z", "UTC")).not.toMatch(/[\u00a0\u2007\u2009\u202f]/);
  });

  it("places overlapping appointments side by side and keeps wall-clock positions across a DST change", () => {
    const ny = "America/New_York";
    const item = (s: string, e: string) => ({ startAt: new Date(s).toISOString(), endAt: new Date(e).toISOString() });
    const segs = layoutDay([item("2026-10-20T09:00:00+08:00", "2026-10-20T10:00:00+08:00"), item("2026-10-20T09:30:00+08:00", "2026-10-20T10:30:00+08:00"), item("2026-10-20T11:00:00+08:00", "2026-10-20T12:00:00+08:00")], "2026-10-20", TZ);
    expect(segs.map((s) => [s.top, s.bottom, s.col, s.cols])).toEqual([[540, 600, 0, 2], [570, 630, 1, 2], [660, 720, 0, 1]]);
    // 1 November 2026: New York falls back at 02:00, so 09:00 local is still 540 minutes on the grid.
    expect(minuteInDay(new Date("2026-11-01T14:00:00Z").getTime(), "2026-11-01", ny)).toBe(540);
    const late = layoutDay([item("2026-10-20T23:30:00+08:00", "2026-10-21T00:30:00+08:00")], "2026-10-21", TZ)[0];
    expect(late).toMatchObject({ top: 0, bottom: 30, startsBefore: true });
  });

  it("reads URL state safely", () => {
    const now = Date.parse("2026-10-16T05:00:00Z");
    expect(parseCalendarState({}, TZ, now)).toMatchObject({ view: "week", date: "2026-10-16", timeZone: TZ, calendarId: null, showCancelled: false });
    expect(parseCalendarState({ view: "agenda", date: "2026-02-30", tz: "Mars/Base", calendar: "x", cancelled: "1" }, TZ, now)).toMatchObject({ view: "agenda", date: "2026-10-16", timeZone: TZ, calendarId: null, showCancelled: true });
    expect(parseCalendarState({ tz: "America/New_York" }, TZ, now)).toMatchObject({ timeZone: "America/New_York", date: "2026-10-16" });
    expect(parseListState({ when: "range", from: "2026-10-20", to: "2026-10-01" })).toMatchObject({ when: "upcoming", from: null, to: null });
    expect(parseListState({ when: "range", from: "2026-10-01", to: "2026-10-20", status: "noshow", page: "3" })).toMatchObject({ when: "range", from: "2026-10-01", status: "noshow", page: 3 });
    expect(parseListState({ status: "weird", page: "-1" })).toMatchObject({ status: "all", page: 1 });
  });
});

describe("navigation", () => {
  it("lists the scheduling screens for everyone who can see appointments, each with a real icon", () => {
    const sections = navFor((p) => p === "appointments.view" || p === "crm.view", "client");
    expect(sections.find((s) => s.key === "scheduling")?.items.map((i) => i.path)).toEqual(["/calendar", "/appointments", "/booking-pages", "/availability", "/calendars", "/calendar-connections"]);
    expect(navFor((p) => p === "crm.view", "client").some((s) => s.key === "scheduling")).toBe(false);
    const shell = readFileSync(path.join(process.cwd(), "src/components/crm/crm-shell.tsx"), "utf8");
    const icons = shell.slice(shell.indexOf("const ICONS"), shell.indexOf("};", shell.indexOf("const ICONS")));
    for (const item of CRM_NAV.flatMap((s) => s.items)) expect(icons.includes(`"${item.icon}"`) || new RegExp(`\\b${item.icon}:`).test(icons)).toBe(true);
  });
});

describe("screens", () => {
  const scope: CrmScope = { base: "/crm", orgId: null, agency: false, readOnly: false, userId: "00000000-0000-4000-8000-000000000001", timezone: TZ, currency: "USD", can: { "appointments.view": true, "appointments.book": true, "appointments.manage": true, "contacts.view": true } };
  const host = { id: "00000000-0000-4000-8000-000000000002", name: "Dana Host" };
  const filters: ScheduleFilters = {
    orgTimezone: TZ,
    hosts: [host],
    calendars: [{ id: "00000000-0000-4000-8000-0000000000c1", name: "Consults", color: null, assignment: "single", isDefault: true, hostIds: [host.id], types: [{ id: "00000000-0000-4000-8000-0000000000f1", name: "Site visit", color: "#4f6bed", durationMinutes: 60, capacity: 1, requiresConfirmation: false, locationKind: "phone", questions: [] }] }],
  };
  const item = (n: number, start: string, end: string, status: ScheduleItem["status"]): ScheduleItem => ({
    id: `00000000-0000-4000-8000-00000000010${n}`, title: `Site visit with Customer ${n}`, status, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
    type: { id: filters.calendars[0].types[0].id, name: "Site visit", color: "#4f6bed", durationMinutes: 60 }, calendar: { id: filters.calendars[0].id, name: "Consults", color: null },
    hosts: [host], contact: { id: `00000000-0000-4000-8000-00000000020${n}`, name: `Customer ${n}` }, bookedVia: "staff", location: "Phone call", meetingLink: null, version: 1, rescheduleCount: 0, lateCancellation: false,
  });
  const items = [
    item(1, "2026-10-20T09:00:00+08:00", "2026-10-20T10:00:00+08:00", "confirmed"),
    item(2, "2026-10-20T09:30:00+08:00", "2026-10-20T10:30:00+08:00", "new"),
    item(3, "2026-10-21T14:00:00+08:00", "2026-10-21T15:00:00+08:00", "cancelled"),
  ];
  const render = (view: "month" | "week" | "day" | "agenda", date = "2026-10-20") =>
    renderToStaticMarkup(React.createElement(CalendarWorkspace, {
      scope, workspaceTimeZone: TZ, today: "2026-10-19", items, truncated: false, filters, overlayNote: null,
      state: { view, date, timeZone: TZ, calendarId: null, hostId: null, showCancelled: true, appointmentId: null },
      overlay: { userId: host.id, name: host.name, timezone: TZ, accepting: true, working: [{ start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T09:00:00.000Z" }], busy: [{ start: "2026-10-20T05:00:00.000Z", end: "2026-10-20T06:00:00.000Z" }] },
    }));

  it("renders the week, day, month and agenda views with every appointment, its status and the shading key", () => {
    const week = render("week");
    expect(week).toContain("Oct 18 – 24, 2026");
    expect(week).toMatch(/aria-label="Customer 1 9:00[^\"]*10:00 AM Site visit Confirmed with Dana Host"/);
    expect(week).toContain("Customer 2 9:30 – 10:30 AM Site visit Unconfirmed with Dana Host");
    expect(week).toContain("Site visit Cancelled with Dana Host");
    expect(week).toContain("Busy elsewhere");
    expect(week).toContain("Outside Dana Host&#x27;s hours");
    expect(week).toContain("New appointment");
    const day = render("day");
    expect(day).toContain("Tuesday, October 20, 2026");
    expect(day).not.toContain("Customer 3");
    const month = render("month");
    expect(month).toContain("October 2026");
    expect(month).toContain("Tuesday, October 20: 2 appointments. Open this day.");
    const agenda = render("agenda");
    expect(agenda).toContain("Wednesday, October 21");
    expect(agenda).toContain("Customer 3");
  });

  it("hides changes from people who can only view, and lists appointments as a table and as cards", () => {
    const viewer = { ...scope, can: { "appointments.view": true as const } };
    const html = renderToStaticMarkup(React.createElement(CalendarWorkspace, {
      scope: viewer, workspaceTimeZone: TZ, today: "2026-10-19", items, truncated: true, filters, overlay: null, overlayNote: "Choose one person to see their working hours and busy times.",
      state: { view: "week", date: "2026-10-20", timeZone: TZ, calendarId: null, hostId: null, showCancelled: false, appointmentId: null },
    }));
    expect(html).not.toContain("New appointment");
    expect(html).not.toContain("Drag an appointment");
    expect(html).toContain("Only the first 2,000 appointments");
    expect(html).toContain("Choose one person to see their working hours");
    const list = renderToStaticMarkup(React.createElement(AppointmentsList, {
      scope, items, total: 3, pageSize: 25, filters, today: "2026-10-19",
      state: { when: "upcoming", from: null, to: null, status: "all", calendarId: null, hostId: null, q: "", page: 1, appointmentId: null },
    }));
    expect(list).toContain("3 appointments");
    expect(list).toContain('href="/crm/contacts/00000000-0000-4000-8000-000000000201"');
    expect((list.match(/Customer 1/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

function iso(w: { from: Date; to: Date }) {
  return { from: w.from.toISOString(), to: w.to.toISOString() };
}

describe("drawer links and addresses", () => {
  const ID = "00000000-0000-4000-8000-00000000a001";
  const OTHER = "00000000-0000-4000-8000-00000000a002";

  it("names the day whenever an appointment is open, so a refresh after moving or cancelling it never re-runs the notification-link jump", () => {
    const s = parseCalendarState({}, TZ, Date.parse("2026-10-16T05:00:00Z"));
    expect(calendarQuery(s, TZ, "2026-10-16")).toBe("");
    expect(calendarQuery({ ...s, appointmentId: ID }, TZ, "2026-10-16")).toBe(`?date=2026-10-16&appointment=${ID}`);
    expect(calendarQuery({ ...s, showCancelled: true, appointmentId: ID }, TZ, "2026-10-16")).toBe(`?date=2026-10-16&cancelled=1&appointment=${ID}`);
    // The list reads its search trimmed, so " ann " and "ann" are one search.
    expect(parseListState({ q: "  ann  " }).q).toBe("ann");
    expect(parseListState({ q: "   " }).q).toBe("");
  });

  it("opens a linked appointment on every navigation to it, even the same link again after its drawer was closed", () => {
    const load1 = { appointmentId: ID };
    const open: DrawerLink = { seen: load1, openId: ID };
    // A re-render of the same page load changes nothing.
    expect(followDrawerLink(open, load1)).toBe(open);
    const closed: DrawerLink = { ...open, openId: null };
    expect(followDrawerLink(closed, load1).openId).toBeNull();
    // Clicking the same notification again is a new page load, with a new state object: the drawer opens.
    expect(followDrawerLink(closed, { appointmentId: ID }).openId).toBe(ID);
    // A link to another appointment switches to it.
    expect(followDrawerLink(open, { appointmentId: OTHER }).openId).toBe(OTHER);
    // A refresh that names no appointment (after closing, or after an action) leaves the drawer as it is.
    expect(followDrawerLink({ seen: load1, openId: OTHER }, { appointmentId: null }).openId).toBe(OTHER);
    expect(followDrawerLink(closed, { appointmentId: null }).openId).toBeNull();
  });

  it("drawer addresses use a null history state, as Next's docs do, so the router follows them", () => {
    const bits = readFileSync(path.join(process.cwd(), "src/components/crm/scheduling/bits.tsx"), "utf8");
    expect(bits).toContain('window.history.replaceState(null, "", url)');
    for (const f of ["calendar-workspace.tsx", "appointments-list.tsx"]) {
      const src = readFileSync(path.join(process.cwd(), "src/components/crm/scheduling", f), "utf8");
      expect(src, f).not.toContain("window.history.replaceState(window.history.state");
      expect(src, f).toContain("replaceAddress(");
    }
  });
});

describe("screens: filters on phones and who can change what", () => {
  const scope: CrmScope = { base: "/crm", orgId: null, agency: false, readOnly: false, userId: "00000000-0000-4000-8000-000000000001", timezone: TZ, currency: "USD", can: { "appointments.view": true, "appointments.book": true } };
  const longName = "A calendar with a very long name that would push the select past the edge of a phone screen, chevron and all";
  const filters: ScheduleFilters = { orgTimezone: TZ, hosts: [{ id: "00000000-0000-4000-8000-000000000002", name: "Dana Host" }], calendars: [] };
  const calendar = (f: ScheduleFilters) => renderToStaticMarkup(React.createElement(CalendarWorkspace, {
    scope, workspaceTimeZone: TZ, today: "2026-10-19", items: [], truncated: false, filters: f, overlay: null, overlayNote: null,
    state: { view: "week", date: "2026-10-20", timeZone: TZ, calendarId: null, hostId: null, showCancelled: false, appointmentId: null },
  }));

  it("names the permission, not a role, when someone can't set up calendars", () => {
    const html = calendar(filters);
    expect(html).toContain(`No calendars yet. ${permissionNeeded("Creating calendars and appointment types", "calendars.manage")}`.replace(/'/g, "&#x27;"));
    expect(html).toContain("“Set up calendars and booking pages”");
    expect(html).not.toMatch(/owner or manager|owners and admins/i);
    expect(permissionNeeded("Confirming, moving, cancelling and recording outcomes", "appointments.manage"))
      .toBe("Confirming, moving, cancelling and recording outcomes needs the “Reschedule and cancel appointments” permission, which the business owner or a manager can give you.");
    const sources = ["appointment-drawer.tsx", "calendar-workspace.tsx", "new-appointment-dialog.tsx", "settings/calendars-manager.tsx", "settings/booking-pages-manager.tsx", "settings/calendar-detail.tsx", "settings/availability-manager.tsx"];
    for (const f of sources) {
      const src = readFileSync(path.join(process.cwd(), "src/components/crm/scheduling", f), "utf8");
      expect(src, f).not.toMatch(/Only owners and admins|owner or manager|owner or admin|Owners and admins can/);
    }
  });

  it("keeps filter selects inside the card on a phone, however long a calendar's name", () => {
    const withLong: ScheduleFilters = { ...filters, calendars: [{ id: "00000000-0000-4000-8000-0000000000c1", name: longName, color: null, assignment: "single", isDefault: true, hostIds: [], types: [] }] };
    const html = calendar(withLong);
    for (const id of ["cal-calendar", "cal-host", "cal-tz"]) expect(html).toMatch(new RegExp(`<select class="[^"]*max-w-full[^"]*" id="${id}"`));
    expect(html).toMatch(/<div class="flex min-w-0 max-w-full flex-wrap[^"]*"><label for="cal-tz"/);
    const list = renderToStaticMarkup(React.createElement(AppointmentsList, {
      scope, items: [], total: 0, pageSize: 25, filters: withLong, today: "2026-10-19",
      state: { when: "upcoming", from: null, to: null, status: "all", calendarId: null, hostId: null, q: "ann", page: 1, appointmentId: null },
    }));
    for (const id of ["appt-status", "appt-calendar", "appt-host"]) expect(list).toMatch(new RegExp(`<select class="[^"]*max-w-full[^"]*" id="${id}"`));
    // The search box starts from the address's search.
    expect(list).toMatch(/<input[^>]*aria-label="Search by customer"[^>]*value="ann"/);
  });
});
