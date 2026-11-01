// Time zones in scheduling: a host's hours are read in the host's own zone, suggested hours are never silently written in a different zone than the host already has, a Chicago business with a
// Manila host gets the right instants, and daylight-saving days offer the right real hours. Synthetic workspaces only; nothing here contacts a calendar provider and no message is sent.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createAppointmentType, createCalendar, setHostAvailability, updateCalendar } from "@/server/calendars/setup";
import { computeSlots, loadBookingContext } from "@/server/calendars/availability";
import { bookNativeAppointment } from "@/server/calendars/booking";
import { activeHostsOfCalendar, applyCalendarHoursTemplate, verifyCalendar } from "@/server/calendars/activation";
import { createContact } from "@/server/crm/contacts";
import { crmOrg, type CrmOrg, type CrmWho } from "./support/crm";

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
const TEMPLATE = [{ weekday: 2, startMinute: 600, endMinute: 900 }, { weekday: 4, startMinute: 600, endMinute: 900 }];

/** A calendar with two hosts, the Blueprint's suggested hours (written in Manila) and no hours for anybody yet. */
async function templated(c: CrmOrg, hosts: CrmWho[] = ["owner", "sales"]) {
  const owner = c.actor("owner");
  const cal = await createCalendar(owner, { name: `Visits ${crypto.randomBytes(2).toString("hex")}`, assignment: "round_robin", members: hosts.map((h) => ({ userId: c.people[h].id })) });
  await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30 });
  await withSystem((db) => db.query("update crm_calendars set timezone = 'Asia/Manila', hours_template = $2::jsonb where id = $1", [cal.id, JSON.stringify(TEMPLATE)]));
  return cal.id;
}
const hostRow = async (c: CrmOrg, who: CrmWho) => withSystem(async (db) => ({
  tz: (await db.query<{ timezone: string }>("select timezone from crm_host_settings where org_id = $1 and user_id = $2", [c.org.id, c.people[who].id])).rows[0]?.timezone ?? null,
  rules: (await db.query<{ weekday: number; start_minute: number; end_minute: number }>("select weekday, start_minute, end_minute from crm_availability_rules where org_id = $1 and user_id = $2 order by weekday", [c.org.id, c.people[who].id])).rows,
}));

describe("suggested hours and a host who already has a different time zone", () => {
  it("does not write business-local hours in the wrong zone: the host is reported as needing a zone choice", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    // The sales rep set a zone (London) but has no weekly hours yet.
    await setHostAvailability(owner, c.people.sales.id, { timezone: "Europe/London", rules: [] });
    const calendarId = await templated(c);
    const res = await applyCalendarHoursTemplate(owner, calendarId);
    expect(res).toEqual({ applied: [c.people.owner.id], kept: [], needsZoneChoice: [c.people.sales.id] });
    // The owner (no settings) got the hours in the suggested zone; the sales rep got nothing and keeps London.
    expect(await hostRow(c, "owner")).toEqual({ tz: "Asia/Manila", rules: [{ weekday: 2, start_minute: 600, end_minute: 900 }, { weekday: 4, start_minute: 600, end_minute: 900 }] });
    expect(await hostRow(c, "sales")).toEqual({ tz: "Europe/London", rules: [] });
    // Verification still says they have no hours, so the calendar cannot go live with hours read in the wrong zone.
    const v = await verifyCalendar(owner, calendarId);
    expect(v.checks.find((x) => x.key === "hours")).toMatchObject({ ok: false, people: [{ userId: c.people.sales.id }] });
    // Applying again changes nothing and still reports the same person.
    expect(await applyCalendarHoursTemplate(owner, calendarId)).toMatchObject({ applied: [], needsZoneChoice: [c.people.sales.id] });
  });

  it("applies hours to that host once somebody chooses the zone, in the chosen zone", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.sales.id, { timezone: "Europe/London", rules: [] });
    const calendarId = await templated(c);
    await expect(applyCalendarHoursTemplate(owner, calendarId, { timezone: "Mars/Olympus" })).rejects.toThrow(/valid time zone/);
    expect((await hostRow(c, "sales")).rules).toEqual([]);
    // "These hours are London hours": they are saved as such and the host's zone stays London.
    const london = await applyCalendarHoursTemplate(owner, calendarId, { timezone: "Europe/London" });
    expect(london.needsZoneChoice).toEqual([]);
    expect(london.applied.sort()).toEqual([c.people.owner.id, c.people.sales.id].sort());
    expect(await hostRow(c, "sales")).toEqual({ tz: "Europe/London", rules: [{ weekday: 2, start_minute: 600, end_minute: 900 }, { weekday: 4, start_minute: 600, end_minute: 900 }] });
    // The owner had no settings, so they start in the chosen zone.
    expect((await hostRow(c, "owner")).tz).toBe("Europe/London");
  });

  it("moves a host with no hours to the chosen zone when the hours are written in another one, and never touches a host who has hours", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.sales.id, { timezone: "Europe/London", rules: [] });
    await setHostAvailability(owner, c.people.setter.id, { timezone: "America/Chicago", rules: [{ weekday: 1, startMinute: 480, endMinute: 720 }] });
    const calendarId = await templated(c, ["sales", "setter"]);
    const res = await applyCalendarHoursTemplate(owner, calendarId, { timezone: "Asia/Manila" });
    expect(res.applied).toEqual([c.people.sales.id]);
    expect(res.kept).toEqual([c.people.setter.id]);
    expect((await hostRow(c, "sales")).tz).toBe("Asia/Manila");
    expect(await hostRow(c, "setter")).toEqual({ tz: "America/Chicago", rules: [{ weekday: 1, start_minute: 480, end_minute: 720 }] });
  });

  it("is not applied through a calendar's own host assignment either, and the same-zone host still gets their hours", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.sales.id, { timezone: "Europe/London", rules: [] });
    await setHostAvailability(owner, c.people.setter.id, { timezone: "Asia/Manila", rules: [] });
    const calendarId = await templated(c, ["owner"]);
    const res = await updateCalendar(owner, calendarId, {
      assignment: "round_robin", members: [{ userId: c.people.owner.id }, { userId: c.people.sales.id }, { userId: c.people.setter.id }], useHoursTemplate: true,
    });
    expect(res.hoursApplied.sort()).toEqual([c.people.owner.id, c.people.setter.id].sort());
    // The host who was left without hours is named, so the screen can say so instead of implying everyone has hours.
    expect(res.hoursNeedZoneChoice).toEqual([c.people.sales.id]);
    expect((await hostRow(c, "sales")).rules).toEqual([]);
    expect((await hostRow(c, "setter")).rules).toHaveLength(2);
  });
});

describe("activeHostsOfCalendar", () => {
  it("lists only current members who are active users, with their zone and whether they have hours, and only in the caller's workspace", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const other = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    const calendarId = await templated(c);
    const hosts = await withSystem((db) => activeHostsOfCalendar(db, c.org.id, calendarId));
    expect(hosts.map((h) => [h.userId, h.hasHours, h.timezone])).toEqual(expect.arrayContaining([[c.people.owner.id, true, "Asia/Manila"], [c.people.sales.id, false, null]]));
    expect(hosts).toHaveLength(2);
    // A host who left the workspace, one who was disabled and one removed from the calendar are not hosts.
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [c.org.id, c.people.sales.id]));
    expect((await withSystem((db) => activeHostsOfCalendar(db, c.org.id, calendarId))).map((h) => h.userId)).toEqual([c.people.owner.id]);
    await withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [c.people.owner.id]));
    expect(await withSystem((db) => activeHostsOfCalendar(db, c.org.id, calendarId))).toEqual([]);
    await withSystem((db) => db.query("update users set status = 'active' where id = $1", [c.people.owner.id]));
    await withSystem((db) => db.query("update crm_calendar_members set active = false where calendar_id = $1 and user_id = $2", [calendarId, c.people.owner.id]));
    expect(await withSystem((db) => activeHostsOfCalendar(db, c.org.id, calendarId))).toEqual([]);
    // Another workspace asking for this calendar sees nobody.
    expect(await withSystem((db) => activeHostsOfCalendar(db, other.org.id, calendarId))).toEqual([]);
  });
});

describe("a Chicago business with a host in Manila", () => {
  const MANILA_DAY_FROM = new Date("2026-10-20T00:00:00Z");
  const MANILA_DAY_TO = new Date("2026-10-21T00:00:00Z");
  const NOW = new Date("2026-10-19T00:00:00Z");

  it("offers the host's own 9-17 as real instants, and stores the business's zone and the invitee's zone on the booking", async () => {
    const c = await crmOrg({ timezone: "America/Chicago" });
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    const cal = await createCalendar(owner, { name: "Consults", members: [{ userId: c.people.owner.id }] });
    const type = await createAppointmentType(owner, cal.id, { name: "Consult", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30 });
    const ctx = await withSystem((db) => loadBookingContext(db, c.org.id, type.id));
    expect(ctx.orgTimezone).toBe("America/Chicago");
    expect(ctx.hosts[0].timezone).toBe("Asia/Manila");
    const slots = await withSystem((db) => computeSlots(db, ctx, { from: MANILA_DAY_FROM, to: MANILA_DAY_TO, now: NOW }));
    // Tuesday 9:00-17:00 in Manila is 01:00Z-09:00Z: eight hourly starts. Chicago's own 9:00 (14:00Z) is the host's 22:00, so it is not offered.
    expect(slots.map((s) => s.start)).toEqual(["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00", "08:00"].map((t) => `2026-10-20T${t}:00.000Z`));
    expect(slots.map((s) => s.start)).not.toContain("2026-10-20T14:00:00.000Z");

    // A booking keeps the business's zone, and the invitee's zone when they gave one or else the business's.
    const contact = await createContact(owner, { firstName: "Cora", email: `cora-${crypto.randomUUID()}@example.test` });
    const first = await bookNativeAppointment(owner, { typeId: type.id, startAt: new Date("2026-10-20T02:00:00Z"), contact: { id: contact.id }, via: "staff", now: NOW });
    const second = await bookNativeAppointment(owner, { typeId: type.id, startAt: new Date("2026-10-20T03:00:00Z"), contact: { id: contact.id }, via: "staff", inviteeTimezone: "Europe/London", now: NOW });
    const rows = (await withSystem((db) => db.query<{ id: string; start_at: Date; end_at: Date; timezone: string; invitee_timezone: string }>(
      "select id, start_at, end_at, timezone, invitee_timezone from appointment_refs where org_id = $1 order by start_at", [c.org.id]))).rows;
    expect(rows.map((r) => [r.id, new Date(r.start_at).toISOString(), new Date(r.end_at).toISOString(), r.timezone, r.invitee_timezone])).toEqual([
      [first.appointmentId, "2026-10-20T02:00:00.000Z", "2026-10-20T03:00:00.000Z", "America/Chicago", "America/Chicago"],
      [second.appointmentId, "2026-10-20T03:00:00.000Z", "2026-10-20T04:00:00.000Z", "America/Chicago", "Europe/London"],
    ]);
    // The booked hours are gone from the offer; the rest are still there.
    const after = await withSystem((db) => computeSlots(db, ctx, { from: MANILA_DAY_FROM, to: MANILA_DAY_TO, now: NOW }));
    expect(after.map((s) => s.start)).toEqual(["01:00", "04:00", "05:00", "06:00", "07:00", "08:00"].map((t) => `2026-10-20T${t}:00.000Z`));
    // A time at the host's night, even one that is a business hour in Chicago, is refused.
    await expect(bookNativeAppointment(owner, { typeId: type.id, startAt: new Date("2026-10-20T14:00:00Z"), contact: { id: contact.id }, via: "staff", now: NOW })).rejects.toThrow(/no longer available/);
  });

  it("offers a Chicago host 9-17 local as 8 real hours on both daylight-saving days", async () => {
    const c = await crmOrg({ timezone: "America/Chicago" });
    const owner = c.actor("owner");
    // Sundays only: 2026-03-08 (clocks go forward at 2:00) and 2026-11-01 (clocks go back at 2:00) are both Sundays.
    await setHostAvailability(owner, c.people.owner.id, { timezone: "America/Chicago", rules: [{ weekday: 0, startMinute: 9 * 60, endMinute: 17 * 60 }] });
    const cal = await createCalendar(owner, { name: "Sunday visits", members: [{ userId: c.people.owner.id }] });
    const type = await createAppointmentType(owner, cal.id, { name: "Visit", durationMinutes: 60, minNoticeMinutes: 0, maxDaysAhead: 365 });
    const ctx = await withSystem((db) => loadBookingContext(db, c.org.id, type.id));
    const day = async (from: string, to: string, now: string) => (await withSystem((db) => computeSlots(db, ctx, { from: new Date(from), to: new Date(to), now: new Date(now) }))).map((s) => s.start);
    // 9:00 is already daylight time on 2026-03-08 (14:00Z) and standard time on 2026-11-01 (15:00Z).
    expect(await day("2026-03-08T06:00:00Z", "2026-03-09T06:00:00Z", "2026-03-01T00:00:00Z")).toEqual(["14", "15", "16", "17", "18", "19", "20", "21"].map((h) => `2026-03-08T${h}:00:00.000Z`));
    expect(await day("2026-11-01T05:00:00Z", "2026-11-02T06:00:00Z", "2026-10-25T00:00:00Z")).toEqual(["15", "16", "17", "18", "19", "20", "21", "22"].map((h) => `2026-11-01T${h}:00:00.000Z`));
  });
});
