// Native calendars and booking. Synthetic workspaces only; nothing here contacts a calendar provider or sends a message.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withUser, type Queryable } from "@/server/db";
import {
  addAvailabilityOverride, createAppointmentType, createCalendar, listCalendars, listHostAvailability, setHostAvailability, updateAppointmentType, updateCalendar,
} from "@/server/calendars/setup";
import { computeSlots, loadBookingContext } from "@/server/calendars/availability";
import {
  bookingPageActor, bookNativeAppointment, cancelNativeAppointment, findByManageToken, rescheduleNativeAppointment, setNativeAppointmentStatus,
} from "@/server/calendars/booking";
import { getWorkspace } from "@/server/crm/workspace";
import { crmOrg, eventsFor, type CrmOrg } from "./support/crm";

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
// Monday 19 October 2026, 08:00 in Manila (00:00 UTC). Bookings are made "now" = this instant.
const NOW = new Date("2026-10-19T00:00:00Z");
const at = (localHHMM: string, date = "2026-10-20") => new Date(`${date}T${localHHMM}:00+08:00`);

// The synthetic week is fixed so slot arithmetic stays readable. Freeze JavaScript time at NOW so a
// real clock that has moved past the fixture cannot flip the "has started" and booking-horizon checks.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

async function setupWorkspace(a: CrmOrg, opts: { assignment?: "single" | "round_robin" | "collective"; capacity?: number; buffers?: number; dailyLimit?: number | null; hosts?: Array<keyof CrmOrg["people"]> } = {}) {
  const owner = a.actor("owner");
  const hosts = opts.hosts ?? ["owner"];
  for (const h of hosts) await setHostAvailability(owner, a.people[h].id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: `Consults ${Math.random().toString(36).slice(2, 6)}`, assignment: opts.assignment ?? (hosts.length > 1 ? "round_robin" : "single"), public: true, members: hosts.map((h) => ({ userId: a.people[h].id })) });
  const type = await createAppointmentType(owner, cal.id, {
    name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, capacity: opts.capacity ?? 1, bufferBeforeMinutes: opts.buffers ?? 0, bufferAfterMinutes: opts.buffers ?? 0, dailyLimit: opts.dailyLimit ?? null,
  });
  return { calendarId: cal.id, typeId: type.id };
}

const slotsFor = async (a: CrmOrg, typeId: string, date = "2026-10-20") =>
  withSystem(async (db) => {
    const ctx = await loadBookingContext(db, a.org.id, typeId);
    return computeSlots(db, ctx, { from: at("00:00", date), to: at("23:59", date), now: NOW });
  });

let a: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Calendar Co", timezone: "Asia/Manila" });
});

describe("calendar setup", () => {
  it("creates calendars and types with unique slugs, and the first calendar is the default", async () => {
    const owner = a.actor("owner");
    const one = await createCalendar(owner, { name: "Sales Calls" });
    const two = await createCalendar(owner, { name: "Sales Calls" });
    const cals = await listCalendars(owner);
    const byId = new Map(cals.map((c) => [c.id, c]));
    expect(byId.get(one.id)?.slug).toBe("sales-calls");
    expect(byId.get(two.id)?.slug).toBe("sales-calls-2");
    expect(cals.filter((c) => c.isDefault)).toHaveLength(1);
    await expect(createCalendar(a.actor("sales"), { name: "Mine" })).rejects.toThrow();
    await expect(updateCalendar(owner, one.id, { assignment: "single", members: [{ userId: a.people.owner.id }, { userId: a.people.sales.id }] })).rejects.toThrow(/one host/);
    await expect(createAppointmentType(owner, one.id, { name: "Bad", durationMinutes: 3 })).rejects.toThrow(/5 minutes/);
  });

  it("people set their own hours; someone else's need calendar management", async () => {
    await setHostAvailability(a.actor("sales"), a.people.sales.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    await expect(setHostAvailability(a.actor("sales"), a.people.owner.id, { timezone: "Asia/Manila", rules: [] })).rejects.toThrow(/someone else/);
    await expect(setHostAvailability(a.actor("owner"), a.people.owner.id, { timezone: "Mars/Olympus", rules: [] })).rejects.toThrow(/time zone/);
    await expect(setHostAvailability(a.actor("owner"), a.people.owner.id, { timezone: "UTC", rules: [{ weekday: 1, startMinute: 600, endMinute: 540 }] })).rejects.toThrow(/start before/);
    const list = await listHostAvailability(a.actor("owner"));
    expect(list.hosts.find((h) => h.userId === a.people.sales.id)?.rules).toHaveLength(5);
  });
});

describe("availability", () => {
  it("offers working hours in the host's time zone, after the notice period", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b);
    const tue = await slotsFor(b, typeId);
    expect(tue.map((s) => s.start)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"].map((h) => `2026-10-20T${h}:00:00.000Z`));
    // Monday: now is 08:00 local with 60 minutes' notice, so 09:00 is the first time.
    const mon = await slotsFor(b, typeId, "2026-10-19");
    expect(mon[0].start).toBe("2026-10-19T01:00:00.000Z");
    // Weekends are closed.
    expect(await slotsFor(b, typeId, "2026-10-24")).toHaveLength(0);
  });

  it("a day off removes that day; a workspace holiday applies to everyone", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b);
    await addAvailabilityOverride(b.actor("owner"), { userId: null, date: "2026-10-20", startMinute: null, endMinute: null, reason: "Holiday" });
    expect(await slotsFor(b, typeId)).toHaveLength(0);
    await addAvailabilityOverride(b.actor("owner"), { userId: b.people.owner.id, date: "2026-10-21", startMinute: 13 * 60, endMinute: 15 * 60 });
    expect((await slotsFor(b, typeId, "2026-10-21")).map((s) => s.start)).toEqual(["2026-10-21T05:00:00.000Z", "2026-10-21T06:00:00.000Z"]);
  });
});

describe("booking", () => {
  it("books from a public page, creates the contact, and never double-books the same time", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b);
    const page = await bookingPageActor(b.org.id);
    const first = await bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "Ana", lastName: "Reyes", email: "ana@example.test" }, via: "booking_page", now: NOW, inviteeTimezone: "Asia/Manila" });
    expect(first).toMatchObject({ status: "confirmed", hostIds: [b.people.owner.id], created: true });
    expect(first.manageToken).toBeTruthy();
    await expect(bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "Ben", email: "ben@example.test" }, via: "booking_page", now: NOW })).rejects.toThrow(/no longer available/);
    // The same person booking again reuses their contact.
    const again = await bookNativeAppointment(page, { typeId, startAt: at("11:00"), contact: { firstName: "Ana", email: "ANA@example.test" }, via: "booking_page", now: NOW });
    const contacts = await withSystem((db) => db.query<{ contact_id: string }>("select distinct contact_id from appointment_refs where id = any($1::uuid[])", [[first.appointmentId, again.appointmentId]]));
    expect(contacts.rows).toHaveLength(1);
    expect((await slotsFor(b, typeId)).map((s) => s.start)).not.toContain("2026-10-20T02:00:00.000Z");
    const ev = await eventsFor(b.org.id, "appointment.booked");
    expect(ev).toHaveLength(2);
  });

  it("concurrent requests for the last slot: exactly one wins", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b);
    const page = await bookingPageActor(b.org.id);
    const results = await Promise.allSettled(
      ["one", "two", "three"].map((n) => bookNativeAppointment(page, { typeId, startAt: at("14:00"), contact: { firstName: n, email: `${n}@example.test` }, via: "booking_page", now: NOW })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const blocks = await withSystem((db) => db.query("select 1 from crm_busy_blocks where org_id = $1 and released_at is null", [b.org.id]));
    expect(blocks.rows).toHaveLength(1);
  });

  it("the database refuses overlapping time for one person even if code were bypassed", async () => {
    const b = await crmOrg();
    await expect(withSystem(async (db) => {
      await db.query("insert into crm_busy_blocks (org_id, user_id, starts_at, ends_at) values ($1, $2, '2026-10-20T01:00Z', '2026-10-20T02:00Z')", [b.org.id, b.people.owner.id]);
      await db.query("insert into crm_busy_blocks (org_id, user_id, starts_at, ends_at) values ($1, $2, '2026-10-20T01:30Z', '2026-10-20T02:30Z')", [b.org.id, b.people.owner.id]);
    })).rejects.toThrow();
  });

  it("buffers keep space around appointments", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b, { buffers: 30 });
    const page = await bookingPageActor(b.org.id);
    await bookNativeAppointment(page, { typeId, startAt: at("11:00"), contact: { firstName: "Buf", email: "buf@example.test" }, via: "booking_page", now: NOW });
    const starts = (await slotsFor(b, typeId)).map((s) => s.start);
    // 10:00 would end at 11:00, but its 30-minute after-buffer overlaps the 10:30–12:30 block; 12:00 overlaps the block too.
    expect(starts).not.toContain("2026-10-20T02:00:00.000Z");
    expect(starts).not.toContain("2026-10-20T04:00:00.000Z");
    expect(starts).toContain("2026-10-20T05:00:00.000Z");
  });

  it("round robin rotates between free hosts and skips someone who is busy", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b, { hosts: ["owner", "sales"], assignment: "round_robin" });
    const page = await bookingPageActor(b.org.id);
    const r1 = await bookNativeAppointment(page, { typeId, startAt: at("09:00"), contact: { firstName: "A", email: "a@example.test" }, via: "booking_page", now: NOW });
    const r2 = await bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "B", email: "b@example.test" }, via: "booking_page", now: NOW });
    expect(r1.hostIds[0]).not.toBe(r2.hostIds[0]);
    // At 09:00 one host is taken; the time is still offered with the other host, and a second booking there goes to them.
    const nine = (await slotsFor(b, typeId)).find((s) => s.start === "2026-10-20T01:00:00.000Z");
    expect(nine?.hostIds).toHaveLength(1);
    const r3 = await bookNativeAppointment(page, { typeId, startAt: at("09:00"), contact: { firstName: "C", email: "c@example.test" }, via: "booking_page", now: NOW });
    expect(r3.hostIds[0]).not.toBe(r1.hostIds[0]);
    expect((await slotsFor(b, typeId)).find((s) => s.start === "2026-10-20T01:00:00.000Z")).toBeUndefined();
  });

  it("collective calendars need every host free and hold everyone's time", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b, { hosts: ["owner", "sales"], assignment: "collective" });
    await addAvailabilityOverride(b.actor("owner"), { userId: b.people.sales.id, date: "2026-10-20", startMinute: 13 * 60, endMinute: 17 * 60 });
    expect((await slotsFor(b, typeId)).map((s) => s.start)).toEqual(["2026-10-20T05:00:00.000Z", "2026-10-20T06:00:00.000Z", "2026-10-20T07:00:00.000Z", "2026-10-20T08:00:00.000Z"]);
    const page = await bookingPageActor(b.org.id);
    const r = await bookNativeAppointment(page, { typeId, startAt: at("13:00"), contact: { firstName: "Team", email: "team@example.test" }, via: "booking_page", now: NOW });
    expect(new Set(r.hostIds)).toEqual(new Set([b.people.owner.id, b.people.sales.id]));
    const blocks = await withSystem((db) => db.query("select user_id from crm_busy_blocks where org_id = $1 and released_at is null", [b.org.id]));
    expect(blocks.rows).toHaveLength(2);
  });

  it("group sessions fill up to capacity, then close", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b, { capacity: 2 });
    const page = await bookingPageActor(b.org.id);
    const g1 = await bookNativeAppointment(page, { typeId, startAt: at("15:00"), contact: { firstName: "G1", email: "g1@example.test" }, via: "booking_page", now: NOW });
    expect((await slotsFor(b, typeId)).find((s) => s.start === "2026-10-20T07:00:00.000Z")?.remaining).toBe(1);
    await bookNativeAppointment(page, { typeId, startAt: at("15:00"), contact: { firstName: "G2", email: "g2@example.test" }, via: "booking_page", now: NOW });
    expect((await slotsFor(b, typeId)).find((s) => s.start === "2026-10-20T07:00:00.000Z")).toBeUndefined();
    await expect(bookNativeAppointment(page, { typeId, startAt: at("15:00"), contact: { firstName: "G3", email: "g3@example.test" }, via: "booking_page", now: NOW })).rejects.toThrow(/no longer available/);
    // A cancellation reopens one place.
    await cancelNativeAppointment(page, g1.appointmentId, { by: "customer", now: NOW });
    expect((await slotsFor(b, typeId)).find((s) => s.start === "2026-10-20T07:00:00.000Z")?.remaining).toBe(1);
  });

  it("respects the daily limit", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b, { dailyLimit: 1 });
    const page = await bookingPageActor(b.org.id);
    await bookNativeAppointment(page, { typeId, startAt: at("09:00"), contact: { firstName: "D", email: "d@example.test" }, via: "booking_page", now: NOW });
    expect(await slotsFor(b, typeId)).toHaveLength(0);
    expect((await slotsFor(b, typeId, "2026-10-21")).length).toBeGreaterThan(0);
  });

  it("staff may book inside the notice period; customers can't", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b);
    await withSystem((db) => db.query("update crm_appointment_types set min_notice_minutes = 2880 where id = $1", [typeId]));
    const page = await bookingPageActor(b.org.id);
    await expect(bookNativeAppointment(page, { typeId, startAt: at("09:00"), contact: { firstName: "E", email: "e@example.test" }, via: "booking_page", now: NOW })).rejects.toThrow(/no longer available/);
    const c = await bookNativeAppointment(b.actor("owner"), { typeId, startAt: at("09:00"), contact: { firstName: "E", email: "e@example.test" }, via: "staff", now: NOW });
    expect(c.status).toBe("confirmed");
    await expect(bookNativeAppointment(b.actor("viewer"), { typeId, startAt: at("10:00"), contact: { id: (await withSystem((db) => db.query<{ contact_id: string }>("select contact_id from appointment_refs where id = $1", [c.appointmentId]))).rows[0].contact_id }, via: "staff", now: NOW })).rejects.toThrow();
  });

  it("requires confirmation when the type says so, and records outcomes", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b);
    await updateAppointmentType(b.actor("owner"), typeId, { requiresConfirmation: true, questions: [{ key: "address", label: "Property address", type: "text", required: true }] });
    const page = await bookingPageActor(b.org.id);
    await expect(bookNativeAppointment(page, { typeId, startAt: at("09:00"), contact: { firstName: "F", email: "f@example.test" }, via: "booking_page", now: NOW })).rejects.toThrow(/Property address/);
    const r = await bookNativeAppointment(page, { typeId, startAt: at("09:00"), contact: { firstName: "F", email: "f@example.test" }, answers: { address: "12 Mango St" }, via: "booking_page", now: NOW });
    expect(r.status).toBe("new");
    await setNativeAppointmentStatus(b.actor("owner"), r.appointmentId, "confirmed");
    await expect(setNativeAppointmentStatus(b.actor("owner"), r.appointmentId, "showed")).rejects.toThrow(/once the appointment has started/);
    const row = await withSystem((db) => db.query<{ status: string; answers: Record<string, string> }>("select status, answers from appointment_refs where id = $1", [r.appointmentId]));
    expect(row.rows[0]).toMatchObject({ status: "confirmed", answers: { address: "12 Mango St" } });
  });

  it("the customer's link reschedules and cancels; the old time is freed and the link can't be guessed", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b);
    const page = await bookingPageActor(b.org.id);
    const r = await bookNativeAppointment(page, { typeId, startAt: at("09:00"), contact: { firstName: "G", email: "g@example.test" }, via: "booking_page", now: NOW, idempotencyKey: "page-key-12345" });
    // A double submit returns the same booking.
    const dup = await bookNativeAppointment(page, { typeId, startAt: at("09:00"), contact: { firstName: "G", email: "g@example.test" }, via: "booking_page", now: NOW, idempotencyKey: "page-key-12345" });
    expect(dup).toMatchObject({ appointmentId: r.appointmentId, created: false });
    expect(await findByManageToken("not-a-real-token-but-long-enough")).toBeNull();
    const found = await findByManageToken(r.manageToken!);
    expect(found?.id).toBe(r.appointmentId);
    await rescheduleNativeAppointment(page, r.appointmentId, { startAt: at("13:00"), by: "customer", now: NOW });
    const starts = (await slotsFor(b, typeId)).map((s) => s.start);
    expect(starts).toContain("2026-10-20T01:00:00.000Z");
    expect(starts).not.toContain("2026-10-20T05:00:00.000Z");
    const moved = await withSystem((db) => db.query<{ reschedule_count: number; previous_start_at: Date }>("select reschedule_count, previous_start_at from appointment_refs where id = $1", [r.appointmentId]));
    expect(moved.rows[0].reschedule_count).toBe(1);
    const c1 = await cancelNativeAppointment(page, r.appointmentId, { by: "customer", reason: "Can't make it", now: NOW });
    const c2 = await cancelNativeAppointment(page, r.appointmentId, { by: "customer", now: NOW });
    expect(c1.changed).toBe(true);
    expect(c2.changed).toBe(false);
    expect((await slotsFor(b, typeId)).map((s) => s.start)).toContain("2026-10-20T05:00:00.000Z");
    expect((await eventsFor(b.org.id)).map((e) => e.type)).toEqual(expect.arrayContaining(["appointment.booked", "appointment.rescheduled", "appointment.cancelled"]));
  });

  it("refuses when GoHighLevel owns appointments, and keeps workspaces apart", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b);
    const other = await crmOrg();
    await expect(withSystem((db) => loadBookingContext(db, other.org.id, typeId))).rejects.toThrow(/isn't available/);
    const visible = await withUser(other.people.owner.id, (db) => db.query("select 1 from crm_appointment_types where id = $1", [typeId]));
    expect(visible.rows).toHaveLength(0);
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [b.org.id]));
    expect((await getWorkspace(b.actor("owner"))).capabilities.appointments).toBe("ghl");
    const page = await bookingPageActor(b.org.id);
    await expect(bookNativeAppointment(page, { typeId, startAt: at("09:00"), contact: { firstName: "H", email: "h@example.test" }, via: "booking_page", now: NOW })).rejects.toThrow(/GoHighLevel/);
    await withSystem((db) => db.query("update crm_workspaces set mode = 'native' where org_id = $1", [b.org.id]));
  });
});

describe("Appointment Setter and staff requests on native calendars", () => {
  it("the shared request flow books native types: AI proposals wait for approval, staff bookings go straight through", async () => {
    const { requestBooking } = await import("@/server/appointments/booking");
    const { getAvailability } = await import("@/server/appointments/availability");
    const { decideApproval } = await import("@/server/approvals/service");
    const { ctxFor } = await import("./support/fixtures");
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b);
    const setter = (await withSystem((db) => db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'appointment_setter'", [b.org.id]))).rows[0].id;
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where id = $1", [setter]));
    const contact = (await bookNativeAppointment(b.actor("owner"), { typeId, startAt: at("16:00", "2026-10-23"), contact: { firstName: "Lia", email: "lia@example.test" }, via: "staff", now: NOW }));
    const contactId = (await withSystem((db) => db.query<{ contact_id: string }>("select contact_id from appointment_refs where id = $1", [contact.appointmentId]))).rows[0].contact_id;

    // Availability for the AI comes from native calendars, never GoHighLevel.
    const avail = await getAvailability(b.org.id, { now: NOW, from: at("00:00"), to: at("23:59"), timeZone: "Asia/Manila" });
    expect(avail.ok && avail.slots[0].start).toBe("2026-10-20T01:00:00.000Z");

    // AI booking without the owner's "book on its own" switch: an approval is created and the time is held.
    const proposed = await requestBooking({ orgId: b.org.id, contactId, startAt: at("09:00"), actor: { kind: "ai", agentId: setter }, now: NOW });
    expect(proposed.status).toBe("awaiting_approval");
    const again = await requestBooking({ orgId: b.org.id, contactId: contactId, startAt: at("09:00"), actor: { kind: "staff", userId: b.people.owner.id }, now: NOW });
    expect(again.status).toBe("awaiting_approval");
    if (proposed.status !== "awaiting_approval" || !proposed.approvalId) throw new Error("expected an approval");
    const ownerCtx = ctxFor(b.people.owner, b.org, "owner");
    const decided = await decideApproval(ownerCtx, proposed.approvalId, "approve");
    expect(decided.outcome?.status).toBe("succeeded");
    const booked = await withSystem((db) => db.query<{ status: string; appointment_id: string | null }>("select status, appointment_id from appointment_bookings where id = $1", [proposed.bookingId]));
    expect(booked.rows[0].status).toBe("booked");
    const appt = await withSystem((db) => db.query<{ provider: string; origin: string; booked_via: string }>("select provider, origin, booked_via from appointment_refs where id = $1", [booked.rows[0].appointment_id]));
    expect(appt.rows[0]).toEqual({ provider: "native", origin: "portal_ai", booked_via: "agent" });

    // A person booking an open time is booked immediately.
    const staff = await requestBooking({ orgId: b.org.id, contactId, startAt: at("10:00"), actor: { kind: "staff", userId: b.people.owner.id }, now: NOW });
    expect(staff.status).toBe("booked");
    // Asking again for the same person and time returns that booking; someone else asking for the taken time is refused.
    expect((await requestBooking({ orgId: b.org.id, contactId, startAt: at("10:00"), actor: { kind: "staff", userId: b.people.owner.id }, now: NOW })).status).toBe("booked");
    const { createContact } = await import("@/server/crm/contacts");
    const someoneElse = await createContact(b.actor("owner"), { firstName: "Noor", email: "noor@example.test" });
    const taken = await requestBooking({ orgId: b.org.id, contactId: someoneElse.id, startAt: at("10:00"), actor: { kind: "staff", userId: b.people.owner.id }, now: NOW });
    expect(taken).toMatchObject({ status: "unavailable", reason: "slot_taken" });
  });
});

// ---------------------------------------------------------------------------
// Review fixes (Phase 2 scheduling review): each test failed before its fix
// ---------------------------------------------------------------------------

/** Every SQL statement the database runs while `fn` runs, in order (the embedded test database runs one transaction at a time). */
async function statementsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  await withSystem(async () => undefined);
  const driver = await (globalThis as unknown as { __iaqDb: { promise: Promise<{ transaction: (fn: (tx: Queryable) => Promise<unknown>) => Promise<unknown> }> } }).__iaqDb.promise;
  const seen: string[] = [];
  const original = driver.transaction.bind(driver);
  const spy = vi.spyOn(driver, "transaction").mockImplementation((inner) =>
    original((tx) => inner({ query: (sql: string, params?: unknown[]) => (seen.push(sql), tx.query(sql, params)) } as Queryable)),
  );
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return seen;
}

describe("review fixes: hosts and group places", () => {
  it("round robin reads the hosts' last assignments only after taking the calendar's lock, when booking and when moving", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b, { hosts: ["owner", "sales"], assignment: "round_robin" });
    const page = await bookingPageActor(b.org.id);
    // A booking that waited on the lock must rank hosts with what the booking before it committed, so the read comes after the lock.
    const order = (sql: string[]) => ({
      lock: sql.findIndex((q) => q.includes("pg_advisory_xact_lock")),
      hosts: sql.findIndex((q) => q.includes("last_assigned_at") && /from crm_calendar_members/.test(q)),
    });
    let booked: Awaited<ReturnType<typeof bookNativeAppointment>> | null = null;
    const bookSql = await statementsDuring(async () => {
      booked = await bookNativeAppointment(page, { typeId, startAt: at("09:00"), contact: { firstName: "Ann", email: "ann@example.test" }, via: "booking_page", now: NOW });
    });
    const o1 = order(bookSql);
    expect(o1.lock).toBeGreaterThanOrEqual(0);
    expect(o1.hosts).toBeGreaterThan(o1.lock);
    const moveSql = await statementsDuring(() => rescheduleNativeAppointment(b.actor("owner"), booked!.appointmentId, { startAt: at("11:00"), by: "staff", now: NOW }));
    const o2 = order(moveSql);
    expect(o2.lock).toBeGreaterThanOrEqual(0);
    expect(o2.hosts).toBeGreaterThan(o2.lock);
    // Rotation still works as before.
    const next = await bookNativeAppointment(page, { typeId, startAt: at("14:00"), contact: { firstName: "Ben", email: "ben@example.test" }, via: "booking_page", now: NOW });
    expect(next.hostIds[0]).not.toBe(booked!.hostIds[0]);
  });

  it("a group session on a collective calendar gives every host's place back when a booking is cancelled or moved", async () => {
    const b = await crmOrg({ timezone: "Asia/Manila" });
    const { typeId } = await setupWorkspace(b, { hosts: ["owner", "manager"], assignment: "collective", capacity: 3 });
    const page = await bookingPageActor(b.org.id);
    const live = async () =>
      (await withSystem((db) => db.query<{ user_id: string; starts_at: Date; booked: number }>(
        "select user_id, starts_at, booked from crm_busy_blocks where org_id = $1 and released_at is null order by starts_at, user_id", [b.org.id],
      ))).rows.map((r) => [new Date(r.starts_at).toISOString(), r.booked]);
    const placesAt = async (hhmm: string) => (await slotsFor(b, typeId)).find((s) => s.start === at(hhmm).toISOString())?.remaining;
    const ten = at("10:00").toISOString();
    const one = await bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "A", email: "a@example.test" }, via: "booking_page", now: NOW });
    const two = await bookNativeAppointment(page, { typeId, startAt: at("10:00"), contact: { firstName: "B", email: "b@example.test" }, via: "booking_page", now: NOW });
    expect(new Set(one.hostIds)).toEqual(new Set([b.people.owner.id, b.people.manager.id]));
    // One shared block per host, each with both bookings in it; each host's block is recorded for each booking.
    expect(await live()).toEqual([[ten, 2], [ten, 2]]);
    const recorded = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_appointment_hosts where appointment_id = any($1::uuid[]) and busy_block_id is not null", [[one.appointmentId, two.appointmentId]]));
    expect(recorded.rows[0].n).toBe(4);
    expect(await placesAt("10:00")).toBe(1);

    // Cancelling one gives a place back with BOTH hosts.
    await cancelNativeAppointment(b.actor("owner"), one.appointmentId, { by: "staff", now: NOW });
    expect(await live()).toEqual([[ten, 1], [ten, 1]]);
    expect(await placesAt("10:00")).toBe(2);
    // Cancelling it again changes nothing.
    await cancelNativeAppointment(b.actor("owner"), one.appointmentId, { by: "staff", now: NOW });
    expect(await live()).toEqual([[ten, 1], [ten, 1]]);

    // Moving the other: both hosts' 10:00 blocks are released and 13:00 is held with both.
    await rescheduleNativeAppointment(b.actor("owner"), two.appointmentId, { startAt: at("13:00"), by: "staff", now: NOW });
    const one3 = at("13:00").toISOString();
    expect(await live()).toEqual([[one3, 1], [one3, 1]]);
    expect(await placesAt("10:00")).toBe(3);
    expect(await placesAt("13:00")).toBe(2);
    // And cancelling it leaves nobody's time held.
    await cancelNativeAppointment(b.actor("owner"), two.appointmentId, { by: "staff", now: NOW });
    expect(await live()).toEqual([]);
    expect(await placesAt("13:00")).toBe(3);
  });
});
