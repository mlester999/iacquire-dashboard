// A booking page can only go live for a calendar that passes the same checks as activation: a current host with weekly hours in a real time zone, the meeting links its types need, and an
// open time a customer would really be offered. Turning a page OFF always works. Synthetic workspaces only; nothing here contacts a calendar provider and no message is sent.
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { createCalendarAction } from "@/app/actions/crm-calendar-settings";
import { createAppointmentType, createCalendar, setCalendarPublic, setHostAvailability, updateAppointmentType, updateCalendar } from "@/server/calendars/setup";
import { verifyCalendar } from "@/server/calendars/activation";
import { crmOrg, type CrmOrg } from "./support/crm";

const h = vi.hoisted(() => ({ actor: null as null | import("@/server/crm/actor").CrmActor }));
// The action resolves who is acting from the session; here the test chooses, and the permission check still runs.
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

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
const REASON = /^Fix this before customers can book: /;

/** An active calendar (as a manually created one is from the start) with one host and one type. `hours: false` leaves the host without weekly hours. */
async function manualCalendar(c: CrmOrg, opts: { hours?: boolean; type?: Parameters<typeof createAppointmentType>[2] | null } = {}) {
  const owner = c.actor("owner");
  if (opts.hours !== false) await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: "Visits", members: [{ userId: c.people.owner.id }] });
  const type = opts.type === null ? null : await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, ...opts.type });
  return { calendarId: cal.id, typeId: type?.id ?? null };
}
const isPublic = async (id: string) => (await withSystem((db) => db.query<{ public: boolean }>("select public from crm_calendars where id = $1", [id]))).rows[0].public;
const audits = async (orgId: string, action: string) => (await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = $2", [orgId, action]))).rows.length;

describe("publishing a booking page", () => {
  it("is refused while the host has no weekly hours, and says what to fix", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const cal = await manualCalendar(c, { hours: false });
    await expect(setCalendarPublic(owner, cal.calendarId, true)).rejects.toThrow(REASON);
    await expect(setCalendarPublic(owner, cal.calendarId, true)).rejects.toThrow(/Owner Person has no weekly hours/);
    await expect(updateCalendar(owner, cal.calendarId, { public: true })).rejects.toThrow(/no weekly hours/);
    expect(await isPublic(cal.calendarId)).toBe(false);
    expect(await audits(c.org.id, "crm.calendar_published")).toBe(0);
  });

  it("is refused while the host's time zone is not a real one", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const cal = await manualCalendar(c);
    await withSystem((db) => db.query("update crm_host_settings set timezone = 'Mars/Olympus' where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    await expect(setCalendarPublic(c.actor("owner"), cal.calendarId, true)).rejects.toThrow(/no valid time zone/);
    expect(await isPublic(cal.calendarId)).toBe(false);
  });

  it("is refused while no customer would be offered a time", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    // The only type needs more notice than the 14 days activation looks ahead.
    const cal = await manualCalendar(c, { type: { name: "Far out", durationMinutes: 60, minNoticeMinutes: 20 * 24 * 60, maxDaysAhead: 60 } });
    await expect(setCalendarPublic(owner, cal.calendarId, true)).rejects.toThrow(/No time would be offered to a customer/);
    expect(await isPublic(cal.calendarId)).toBe(false);
    // Fixing the notice is what makes it publishable.
    await updateAppointmentType(owner, cal.typeId as string, { minNoticeMinutes: 60 });
    await setCalendarPublic(owner, cal.calendarId, true);
    expect(await isPublic(cal.calendarId)).toBe(true);
  });

  it("is refused while every host has paused new bookings", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const cal = await manualCalendar(c);
    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", accepting: false, rules: WEEKDAYS_9_TO_5 });
    await expect(setCalendarPublic(owner, cal.calendarId, true)).rejects.toThrow(/Every host has paused new bookings/);
    await expect(updateCalendar(owner, cal.calendarId, { public: true })).rejects.toThrow(/paused new bookings/);
    expect(await isPublic(cal.calendarId)).toBe(false);
    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", accepting: true, rules: WEEKDAYS_9_TO_5 });
    await setCalendarPublic(owner, cal.calendarId, true);
    expect(await isPublic(cal.calendarId)).toBe(true);
  });

  it("is refused while a type needs a meeting tool the hosts have not connected, or a video type says nothing about joining", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const meet = await manualCalendar(c, { type: { name: "Meet call", durationMinutes: 30, locationKind: "video", meetingProvider: "google_meet" } });
    await expect(setCalendarPublic(owner, meet.calendarId, true)).rejects.toThrow(/Google Calendar/);
    const bare = await manualCalendar(c, { type: { name: "Video call", durationMinutes: 30, locationKind: "video", meetingProvider: "none" } });
    await expect(setCalendarPublic(owner, bare.calendarId, true)).rejects.toThrow(/Video call is a video appointment with no meeting tool/);
    await updateAppointmentType(owner, bare.typeId as string, { locationDetail: "We email a video link the morning of." });
    await setCalendarPublic(owner, bare.calendarId, true);
    expect(await isPublic(bare.calendarId)).toBe(true);
  });

  it("is allowed exactly when verifyCalendar says every check passes", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const cal = await manualCalendar(c);
    expect((await verifyCalendar(owner, cal.calendarId)).ok).toBe(true);
    await setCalendarPublic(owner, cal.calendarId, true);
    expect(await isPublic(cal.calendarId)).toBe(true);
    expect(await audits(c.org.id, "crm.calendar_published")).toBe(1);
    // The same through the settings update.
    const second = await manualCalendar(c);
    await updateCalendar(owner, second.calendarId, { public: true });
    expect(await isPublic(second.calendarId)).toBe(true);
  });

  it("still keeps its earlier reasons: no host, no type, every type hidden", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const none = await manualCalendar(c, { type: null });
    await expect(setCalendarPublic(owner, none.calendarId, true)).rejects.toThrow(/no appointment types yet/);
    const hidden = await manualCalendar(c, { type: { name: "Hidden", durationMinutes: 30, public: false } });
    await expect(setCalendarPublic(owner, hidden.calendarId, true)).rejects.toThrow(/hidden from the booking page/);
    // The only host leaves the workspace: nobody could take a booking, even though the calendar row still lists them.
    const ready = await manualCalendar(c);
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    await expect(setCalendarPublic(c.actor("manager"), ready.calendarId, true)).rejects.toThrow(/Nobody active hosts this calendar/);
  });

  it("never blocks turning a page off, however broken the calendar has become", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const cal = await manualCalendar(c);
    await setCalendarPublic(owner, cal.calendarId, true);
    // The host loses their hours and pauses bookings: the page is live but would fail every check now.
    await withSystem((db) => db.query("delete from crm_availability_rules where org_id = $1", [c.org.id]));
    await withSystem((db) => db.query("update crm_host_settings set accepting = false where org_id = $1", [c.org.id]));
    expect((await verifyCalendar(owner, cal.calendarId)).ok).toBe(false);
    // Other edits to a calendar that is already public do not re-judge it, and turning it off works through both doors.
    await updateCalendar(owner, cal.calendarId, { name: "Renamed visits" });
    expect(await isPublic(cal.calendarId)).toBe(true);
    await setCalendarPublic(owner, cal.calendarId, false);
    expect(await isPublic(cal.calendarId)).toBe(false);
    expect(await audits(c.org.id, "crm.calendar_unpublished")).toBe(1);
    // Turning it back on is judged again.
    await expect(setCalendarPublic(owner, cal.calendarId, true)).rejects.toThrow(REASON);
    await updateCalendar(owner, cal.calendarId, { public: false });
  });

  it("judges only the calendar of the caller's own workspace", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const other = await crmOrg({ timezone: "Asia/Manila" });
    const cal = await manualCalendar(c);
    await expect(setCalendarPublic(other.actor("owner"), cal.calendarId, true)).rejects.toThrow(/not found/);
    expect(await isPublic(cal.calendarId)).toBe(false);
  });
});

describe("creating a calendar", () => {
  it("never creates a public booking page, even when the caller asks for one, so the checks cannot be skipped by creating it public", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    h.actor = c.actor("owner");
    // A caller that sends `public: true` (the type system refuses it; a hand-made request does not).
    const made = await createCalendarAction(c.org.id, { name: "Visits", members: [{ userId: c.people.owner.id }], public: true } as Parameters<typeof createCalendarAction>[1]);
    expect(made.ok).toBe(true);
    const id = made.ok ? made.data.id : "";
    expect(await isPublic(id)).toBe(false);
    // A video type with no way to join, on a host with no hours: the page stays off until the same checks as everywhere else pass.
    await createAppointmentType(c.actor("owner"), id, { name: "Video call", durationMinutes: 30, locationKind: "video", meetingProvider: "none" });
    expect(await isPublic(id)).toBe(false);
    await expect(setCalendarPublic(c.actor("owner"), id, true)).rejects.toThrow(REASON);
    expect(await isPublic(id)).toBe(false);
  });
});
