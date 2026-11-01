// What a settings change does to bookings that already exist: nothing, except tell people. Removing a weekday, narrowing the hours, adding a day off, taking a host off a calendar or losing a
// host lists the upcoming bookings that no longer fit, with a reason and one notice, and never cancels, moves or edits one (the customer was promised that time; a person decides).
// Synthetic workspaces only; nothing here contacts a calendar provider and no message is sent to a customer.
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { clearDayException, createAppointmentType, createCalendar, setDayException, setHostAvailability, updateCalendar } from "@/server/calendars/setup";
import { bookNativeAppointment } from "@/server/calendars/booking";
import { attentionDigest, attentionWarning, checkBookingsAfterChange, findBookingsNeedingAttention, type BookingNeedingAttention } from "@/server/calendars/impact";
import { createContact } from "@/server/crm/contacts";
import { setDayExceptionAction, setHostAvailabilityAction, updateCalendarAction } from "@/app/actions/crm-calendar-settings";
import { revokeMember } from "@/server/settings/service";
import { ctxFor } from "./support/fixtures";
import { crmOrg, type CrmOrg, type CrmWho } from "./support/crm";

const h = vi.hoisted(() => ({ actor: null as null | import("@/server/crm/actor").CrmActor }));
// The actions resolve who is acting from the session; here the test chooses, and the permission check still runs.
vi.mock("@/server/crm/request", async () => {
  const { assertCan } = await import("@/server/crm/actor");
  return {
    resolveCrmActor: async (_orgId: string | null, permission: import("@/lib/permissions").Permission) => {
      if (!h.actor) throw new Error("No actor chosen for this test.");
      assertCan(h.actor, permission);
      return h.actor;
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ZONE = "America/Chicago";
const MON_TO_FRI = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
// The suite's clock starts on Monday 26 October 2026 (06:00 UTC, 01:00 in Chicago, daylight time). Tuesday 27 October at 10:00 in Chicago is 15:00 UTC.
const TUE = "2026-10-27";
const WED = "2026-10-28";
const at = (date: string, hhmmUtc: string) => new Date(`${date}T${hhmmUtc}:00Z`);
const without = (...days: number[]) => MON_TO_FRI.filter((r) => !days.includes(r.weekday));

/** An active calendar with one host (or several), their hours, and one 60-minute type. */
async function setup(c: CrmOrg, opts: { host?: CrmWho; hours?: Array<{ weekday: number; startMinute: number; endMinute: number }> } = {}) {
  const owner = c.actor("owner");
  const host = opts.host ?? "owner";
  await setHostAvailability(owner, c.people[host].id, { timezone: ZONE, rules: opts.hours ?? MON_TO_FRI });
  const cal = await createCalendar(owner, { name: `Visits ${crypto.randomBytes(2).toString("hex")}`, assignment: "single", members: [{ userId: c.people[host].id }] });
  const type = await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30 });
  return { calendarId: cal.id, typeId: type.id, hostId: c.people[host].id };
}

let n = 0;
async function book(c: CrmOrg, typeId: string, startAt: Date) {
  const contact = await createContact(c.actor("owner"), { firstName: `Customer${++n}`, lastName: "Reyes", email: `customer-${crypto.randomUUID()}@example.test` });
  const res = await bookNativeAppointment(c.actor("owner"), { typeId, startAt, contact: { id: contact.id }, via: "staff", now: new Date() });
  return res.appointmentId;
}

const appointment = async (id: string) =>
  (await withSystem((db) => db.query<{ status: string; start_at: Date; end_at: Date; version: number; busy_block_id: string | null; released_at: Date | null; blocks: string }>(
    `select a.status, a.start_at, a.end_at, a.version, a.busy_block_id, b.released_at,
            (select count(*)::text from crm_busy_blocks x where x.org_id = a.org_id and x.appointment_id = a.id and x.released_at is null) as blocks
       from appointment_refs a left join crm_busy_blocks b on b.id = a.busy_block_id where a.id = $1`,
    [id],
  ))).rows[0];
const count = async (sql: string, params: unknown[]) => Number((await withSystem((db) => db.query<{ n: string }>(sql, params))).rows[0].n);
const appointmentsOf = (orgId: string) => count("select count(*)::text as n from appointment_refs where org_id = $1", [orgId]);
const impactNotices = (orgId: string, userId: string) => count("select count(*)::text as n from notifications where org_id = $1 and user_id = $2 and dedupe_key like 'calendar-impact:%'", [orgId, userId]);

describe("bookings a change leaves behind", () => {
  it("lists a Tuesday booking when Tuesday is removed, leaves it exactly as it was, and tells owners and admins once", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const owner = c.actor("owner");
    const s = await setup(c);
    const id = await book(c, s.typeId, at(TUE, "15:00"));
    const before = await appointment(id);
    expect(before).toMatchObject({ status: expect.stringMatching(/new|confirmed/), blocks: "1" });
    const total = await appointmentsOf(c.org.id);

    const res = await setHostAvailability(owner, s.hostId, { timezone: ZONE, rules: without(2) });
    expect(res.affected).toEqual([expect.objectContaining({ id, reason: "closed_day", hostUserId: s.hostId, calendarId: s.calendarId, startAt: "2026-10-27T15:00:00.000Z" })]);
    expect(res.affected[0].contactLabel).toMatch(/Customer\d+ Reyes/);

    // The booking is exactly as it was: same state, same time, same version, same block still held. Nothing was added or removed.
    expect(await appointment(id)).toEqual(before);
    expect(await appointmentsOf(c.org.id)).toBe(total);

    // One notice per owner and admin, linking to the booking; the sales rep (not a host, not an admin) hears nothing.
    expect(await impactNotices(c.org.id, c.people.owner.id)).toBe(1);
    expect(await impactNotices(c.org.id, c.people.manager.id)).toBe(1);
    expect(await impactNotices(c.org.id, c.people.sales.id)).toBe(0);
    const note = (await withSystem((db) => db.query<{ link: string; kind: string; title: string; body: string }>("select link, kind, title, body from notifications where org_id = $1 and user_id = $2 and dedupe_key like 'calendar-impact:%'", [c.org.id, c.people.manager.id]))).rows[0];
    expect(note.link).toBe(`/crm/calendar?appointment=${id}`);
    expect(note.kind).toBe("crm_calendar_sync");
    expect(note.body).toMatch(/Nothing was cancelled or moved/);

    // Saving the same hours again, and running the check again, add no second notice.
    expect((await setHostAvailability(owner, s.hostId, { timezone: ZONE, rules: without(2) })).affected).toEqual([]);
    expect(await checkBookingsAfterChange(c.org.id, { userIds: [s.hostId] })).toHaveLength(1);
    expect(await impactNotices(c.org.id, c.people.owner.id)).toBe(1);
    expect(await impactNotices(c.org.id, c.people.manager.id)).toBe(1);

    // Putting Tuesday back lists nothing, and the booking is still untouched.
    expect((await setHostAvailability(owner, s.hostId, { timezone: ZONE, rules: MON_TO_FRI })).affected).toEqual([]);
    expect(await appointment(id)).toEqual(before);
  });

  it("announces the same list again when it comes back after it was resolved, but not for a repeat of the same check", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const owner = c.actor("owner");
    const s = await setup(c);
    const id = await book(c, s.typeId, at(TUE, "15:00"));
    const remove = () => setHostAvailability(owner, s.hostId, { timezone: ZONE, rules: without(2) });
    const restore = () => setHostAvailability(owner, s.hostId, { timezone: ZONE, rules: MON_TO_FRI });

    expect((await remove()).affected.map((b) => b.id)).toEqual([id]);
    expect(await impactNotices(c.org.id, c.people.owner.id)).toBe(1);
    // The check run again with nothing changed is a repeat, not a new problem.
    await checkBookingsAfterChange(c.org.id, { userIds: [s.hostId] });
    expect(await impactNotices(c.org.id, c.people.owner.id)).toBe(1);

    // Resolved (the hours are back and nothing is left to review), then the very same situation again: a new problem, announced once more, to the owner and the host.
    expect((await restore()).affected).toEqual([]);
    expect((await remove()).affected.map((b) => b.id)).toEqual([id]);
    expect(await impactNotices(c.org.id, c.people.owner.id)).toBe(2);
    expect(await impactNotices(c.org.id, c.people.manager.id)).toBe(2);
    await checkBookingsAfterChange(c.org.id, { userIds: [s.hostId] });
    expect(await impactNotices(c.org.id, c.people.owner.id)).toBe(2);
    // Resolving it twice in a row closes one episode, not two.
    await restore();
    await restore();
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'crm.booking_impact_cleared'", [c.org.id])).toBe(2);
  });

  it("removing a host from the team lists their upcoming bookings, tells the owner once, and moves nothing", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const s = await setup(c, { host: "sales" });
    const id = await book(c, s.typeId, at(TUE, "15:00"));
    const before = await appointment(id);
    const res = await revokeMember(ctxFor(c.people.owner, c.org, "owner"), c.people.sales.id);
    expect(res.warning).toBe("1 upcoming booking is with a host who no longer fits; review it. Nothing was cancelled or moved.");
    expect(await appointment(id)).toEqual(before);
    expect(await impactNotices(c.org.id, c.people.owner.id)).toBe(1);
    expect(await impactNotices(c.org.id, c.people.sales.id)).toBe(0);
    // A person with nothing booked leaves quietly.
    const quiet = await crmOrg({ timezone: ZONE });
    expect(await revokeMember(ctxFor(quiet.people.owner, quiet.org, "owner"), quiet.people.support.id)).toEqual({ warning: null });
  });

  it("separates a booking outside narrowed hours from one on a closed day, and a day off or a workspace holiday lists it too", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const owner = c.actor("owner");
    const s = await setup(c);
    const id = await book(c, s.typeId, at(TUE, "15:00")); // 10:00 in Chicago
    const other = await book(c, s.typeId, at(WED, "15:00"));

    // Tuesday still has hours, just not at 10:00.
    const narrowed = await setHostAvailability(owner, s.hostId, { timezone: ZONE, rules: [...without(2), { weekday: 2, startMinute: 13 * 60, endMinute: 17 * 60 }] });
    expect(narrowed.affected.map((b) => [b.id, b.reason])).toEqual([[id, "outside_hours"]]);
    // A change that still covers the booking lists nothing.
    expect((await setHostAvailability(owner, s.hostId, { timezone: ZONE, rules: MON_TO_FRI })).affected).toEqual([]);

    // A whole day off for the host, for a day without bookings, lists nothing; for Tuesday it lists the booking.
    expect((await setDayException(owner, { userId: s.hostId, date: "2026-11-10", windows: null })).affected).toEqual([]);
    const off = await setDayException(owner, { userId: s.hostId, date: TUE, windows: null, reason: "Training" });
    expect(off.affected.map((b) => [b.id, b.reason])).toEqual([[id, "closed_day"]]);
    // Open only in the afternoon: the booking is outside the hours now.
    const afternoon = await setDayException(owner, { userId: s.hostId, date: TUE, windows: [{ startMinute: 13 * 60, endMinute: 17 * 60 }] });
    expect(afternoon.affected.map((b) => [b.id, b.reason])).toEqual([[id, "outside_hours"]]);
    // A workspace holiday on Wednesday reaches every host (Tuesday's own exception is cleared first, so only the holiday is being judged).
    await clearDayException(owner, { userId: s.hostId, date: TUE });
    const holiday = await setDayException(owner, { userId: null, date: WED, windows: null, reason: "Holiday" });
    expect(holiday.affected.map((b) => [b.id, b.reason])).toEqual([[other, "closed_day"]]);

    // Neither booking was touched.
    for (const x of [id, other]) expect(await appointment(x)).toMatchObject({ blocks: "1", released_at: null });
    expect((await appointment(id)).status).toMatch(/new|confirmed/);
  });

  it("lists all of a host's upcoming bookings when the host is taken off the calendar, and leaves them in place", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const owner = c.actor("owner");
    const s = await setup(c);
    const first = await book(c, s.typeId, at(TUE, "15:00"));
    const second = await book(c, s.typeId, at(WED, "15:00"));
    const cancelled = await book(c, s.typeId, at(WED, "17:00"));
    await withSystem((db) => db.query("update appointment_refs set status = 'cancelled' where id = $1", [cancelled]));
    const before = [await appointment(first), await appointment(second)];

    // Changing nothing about the hosts lists nothing.
    expect((await updateCalendar(owner, s.calendarId, { name: "Renamed visits" })).affected).toEqual([]);
    const res = await updateCalendar(owner, s.calendarId, { members: [{ userId: c.people.sales.id }] });
    expect(res.affected.map((b) => [b.id, b.reason, b.hostUserId]).sort()).toEqual([[first, "host_removed", s.hostId], [second, "host_removed", s.hostId]].sort());
    expect([await appointment(first), await appointment(second)]).toEqual(before);
    expect(await impactNotices(c.org.id, c.people.owner.id)).toBe(1);
    // The cancelled booking is not listed, and neither is anything else.
    expect(res.affected.some((b) => b.id === cancelled)).toBe(false);
  });

  it("lists a booking whose host is no longer an active member, and does not notify that person", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const s = await setup(c, { host: "sales" });
    const id = await book(c, s.typeId, at(TUE, "15:00"));
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [c.org.id, c.people.sales.id]));
    const found = await withSystem((db) => findBookingsNeedingAttention(db, c.org.id));
    expect(found.map((b) => [b.id, b.reason])).toEqual([[id, "host_inactive"]]);
    expect((await checkBookingsAfterChange(c.org.id)).map((b) => b.id)).toEqual([id]);
    expect(await impactNotices(c.org.id, c.people.owner.id)).toBe(1);
    expect(await impactNotices(c.org.id, c.people.sales.id)).toBe(0);
    expect(await appointment(id)).toMatchObject({ blocks: "1", released_at: null });
  });

  it("judges a daylight-saving day by the real offset: no false alarm when the hours still cover it, an alarm when they do not", async () => {
    // Sunday 1 November 2026 is the day the clocks go back in Chicago (25 hours long): 11:00 is CST, UTC-6, so 11:00 to 12:00 is 17:00 to 18:00 UTC.
    const c = await crmOrg({ timezone: ZONE });
    const owner = c.actor("owner");
    const sunday = { weekday: 0, startMinute: 6 * 60, endMinute: 12 * 60 };
    const s = await setup(c, { hours: [sunday, { weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }] });
    const id = await book(c, s.typeId, at("2026-11-01", "17:00"));
    expect(await appointment(id)).toMatchObject({ blocks: "1" });
    // Changing another day does not flag it (a fixed daylight-time offset would put the end of the hours an hour early).
    expect((await setHostAvailability(owner, s.hostId, { timezone: ZONE, rules: [sunday] })).affected).toEqual([]);
    // Hours that end at 11:00 local leave the 11:00 booking outside them, on a day that does have hours.
    const narrowed = await setHostAvailability(owner, s.hostId, { timezone: ZONE, rules: [{ ...sunday, endMinute: 11 * 60 }] });
    expect(narrowed.affected.map((b) => [b.id, b.reason])).toEqual([[id, "outside_hours"]]);
  });

  it("never reads or lists another workspace's bookings, and a change in one workspace tells the other nothing", async () => {
    const a = await crmOrg({ timezone: ZONE });
    const b = await crmOrg({ timezone: ZONE });
    const sa = await setup(a);
    const sb = await setup(b);
    const idA = await book(a, sa.typeId, at(TUE, "15:00"));
    const idB = await book(b, sb.typeId, at(TUE, "15:00"));
    const res = await setHostAvailability(a.actor("owner"), sa.hostId, { timezone: ZONE, rules: without(2) });
    expect(res.affected.map((x) => x.id)).toEqual([idA]);
    // B's host and calendar named in A's scope find nothing; A's listing never contains B's booking.
    const seen = await withSystem(async (db) => ({
      all: await findBookingsNeedingAttention(db, a.org.id),
      hostOfB: await findBookingsNeedingAttention(db, a.org.id, { userIds: [sb.hostId] }),
      calendarOfB: await findBookingsNeedingAttention(db, a.org.id, { calendarId: sb.calendarId }),
    }));
    expect(seen.all.map((x) => x.id)).toEqual([idA]);
    expect(seen.hostOfB).toEqual([]);
    expect(seen.calendarOfB).toEqual([]);
    expect(await impactNotices(b.org.id, b.people.owner.id)).toBe(0);
    expect(await impactNotices(b.org.id, b.people.manager.id)).toBe(0);
    expect(await appointment(idB)).toMatchObject({ blocks: "1", released_at: null });
    // B's own change lists B's booking only.
    expect((await setHostAvailability(b.actor("owner"), sb.hostId, { timezone: ZONE, rules: without(2) })).affected.map((x) => x.id)).toEqual([idB]);
  });

  it("lists only upcoming bookings that are still live", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const owner = c.actor("owner");
    const s = await setup(c);
    const id = await book(c, s.typeId, at(TUE, "15:00"));
    await setHostAvailability(owner, s.hostId, { timezone: ZONE, rules: without(2) });
    const listed = (now: Date) => withSystem((db) => findBookingsNeedingAttention(db, c.org.id, { now }));
    expect((await listed(at(TUE, "12:00"))).map((x) => x.id)).toEqual([id]);
    // Once it is over it is history, not something to review.
    expect(await listed(at(TUE, "17:00"))).toEqual([]);
    // A booking that has been cancelled, or that was never confirmed as live, is not listed.
    for (const status of ["cancelled", "showed", "noshow"]) {
      await withSystem((db) => db.query("update appointment_refs set status = $2 where id = $1", [id, status]));
      expect(await listed(at(TUE, "12:00"))).toEqual([]);
    }
    await withSystem((db) => db.query("update appointment_refs set status = 'new' where id = $1", [id]));
    expect((await listed(at(TUE, "12:00"))).map((x) => x.id)).toEqual([id]);
  });

  it("says it in words for a screen, and the digest changes only when the situation does", () => {
    const item = (id: string, reason: BookingNeedingAttention["reason"]): BookingNeedingAttention => ({ id, startAt: "2026-10-27T15:00:00.000Z", endAt: "2026-10-27T16:00:00.000Z", calendarId: null, hostUserId: "h", contactLabel: null, reason, detail: "" });
    expect(attentionWarning([])).toBeNull();
    expect(attentionWarning([item("a", "closed_day")])).toBe("1 upcoming booking is outside these hours; review it. Nothing was cancelled or moved.");
    expect(attentionWarning([item("a", "closed_day"), item("b", "outside_hours")])).toBe("2 upcoming bookings are outside these hours; review them. Nothing was cancelled or moved.");
    expect(attentionWarning([item("a", "host_removed"), item("b", "outside_hours")])).toMatch(/^2 upcoming bookings are with a host who no longer fits; review them\./);
    expect(attentionDigest([item("a", "closed_day"), item("b", "outside_hours")])).toBe(attentionDigest([item("b", "outside_hours"), item("a", "closed_day")]));
    expect(attentionDigest([item("a", "closed_day")])).not.toBe(attentionDigest([item("a", "outside_hours")]));
    expect(attentionDigest([item("a", "closed_day")])).not.toBe(attentionDigest([item("a", "closed_day"), item("b", "closed_day")]));
  });
});

describe("the settings actions surface it", () => {
  it("returns the sentence and the bookings for a host's hours, a day off and a host change, and a person editing their own hours still gets it", async () => {
    const c = await crmOrg({ timezone: ZONE });
    h.actor = c.actor("owner");
    const s = await setup(c);
    const first = await book(c, s.typeId, at(TUE, "15:00"));
    const second = await book(c, s.typeId, at(WED, "15:00"));

    const hours = await setHostAvailabilityAction(null, s.hostId, { timezone: ZONE, rules: without(2, 3) });
    expect(hours).toMatchObject({ ok: true, data: { warning: "2 upcoming bookings are outside these hours; review them. Nothing was cancelled or moved." } });
    if (!hours.ok) throw new Error("expected success");
    expect(hours.data.bookingsToReview.map((b) => b.id).sort()).toEqual([first, second].sort());
    expect(hours.data.bookingsToReview[0]).toMatchObject({ reason: "closed_day" });

    // Nothing to review: no warning.
    expect(await setHostAvailabilityAction(null, s.hostId, { timezone: ZONE, rules: MON_TO_FRI })).toMatchObject({ ok: true, data: { warning: null, bookingsToReview: [] } });
    expect(await setDayExceptionAction(null, { userId: s.hostId, date: TUE, windows: null })).toMatchObject({ ok: true, data: { warning: "1 upcoming booking is outside these hours; review it. Nothing was cancelled or moved." } });
    // A host change keeps its own result fields and adds the sentence.
    const moved = await updateCalendarAction(null, s.calendarId, { members: [{ userId: c.people.sales.id }] });
    expect(moved).toMatchObject({ ok: true, data: { hoursApplied: [], hoursNeedZoneChoice: [], warning: expect.stringMatching(/^2 upcoming bookings are with a host who no longer fits/) } });

    // The host edits their own hours (they only have permission to see the calendar): they still get the sentence for their own bookings.
    const d = await crmOrg({ timezone: ZONE });
    const sd = await setup(d, { host: "sales" });
    await book(d, sd.typeId, at(TUE, "15:00"));
    h.actor = d.actor("sales");
    expect(await setHostAvailabilityAction(null, sd.hostId, { timezone: ZONE, rules: without(2) })).toMatchObject({ ok: true, data: { warning: expect.stringMatching(/^1 upcoming booking is outside these hours/) } });
    // Someone who is not a host and cannot manage calendars may not change another person's hours, and nothing is listed or sent.
    h.actor = d.actor("viewer");
    expect(await setHostAvailabilityAction(null, sd.hostId, { timezone: ZONE, rules: MON_TO_FRI })).toMatchObject({ ok: false });
  });
});
