// The founder's consultation calendar settings, applied to a synthetic workspace through the same services the portal uses. Proves the settings are accepted by the real calendar rules, offer the
// times the founder described and no others, leave the booking page off, and that a Google Meet link is gated on a connected Google account. Nothing here touches production.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { getWorkspace } from "@/server/crm/workspace";
import { createAppointmentType, createCalendar, setHostAvailability, updateAppointmentType } from "@/server/calendars/setup";
import { verifyCalendar } from "@/server/calendars/activation";
import { nativeAvailability } from "@/server/calendars/native-availability";
import { INTERNAL_CONSULTATION_CALENDAR as SPEC } from "@/lib/internal-consultation-calendar";
import { crmOrg, type CrmOrg } from "./support/crm";

// Monday 2 November 2026, 00:00 UTC = 08:00 in Manila.
const NOW = new Date("2026-11-02T00:00:00Z");
const DAY_MS = 86_400_000;

let shop: CrmOrg;
let calendarId: string;
let typeId: string;

function manilaParts(iso: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: SPEC.host.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

beforeAll(async () => {
  shop = await crmOrg({ name: "Consultation Spec Co", timezone: SPEC.host.timezone });
  const owner = shop.actor("owner");
  await getWorkspace(owner);
  await setHostAvailability(owner, shop.people.owner.id, { timezone: SPEC.host.timezone, accepting: true, rules: SPEC.host.weeklyHours.map((r) => ({ ...r })) });
  calendarId = (await createCalendar(owner, { name: SPEC.calendar.name, public: SPEC.calendar.public, members: [{ userId: shop.people.owner.id }] })).id;
  typeId = (await createAppointmentType(owner, calendarId, { ...SPEC.appointmentType })).id;
}, 60_000);

describe("the consultation calendar settings", () => {
  it("are accepted by the real calendar rules and keep the booking page off", async () => {
    const { rows } = await withSystem((db) => db.query<{ public: boolean; type_public: boolean; requires_confirmation: boolean; buffer_after_minutes: number; min_notice_minutes: number; max_days_ahead: number; duration_minutes: number }>(
      `select c.public, t.public as type_public, t.requires_confirmation, t.buffer_after_minutes, t.min_notice_minutes, t.max_days_ahead, t.duration_minutes
         from crm_calendars c join crm_appointment_types t on t.calendar_id = c.id where c.id = $1`, [calendarId]));
    expect(rows[0]).toMatchObject({ public: false, type_public: false, requires_confirmation: true, buffer_after_minutes: 15, min_notice_minutes: 1440, max_days_ahead: 30, duration_minutes: 30 });
  });

  it("offer only Monday to Friday, 09:00 to 17:00 Manila time, in 30-minute steps, with a day's notice and nothing beyond 30 days", async () => {
    const result = await nativeAvailability(shop.org.id, { from: NOW, to: new Date(NOW.getTime() + 45 * DAY_MS), limit: 500, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.length).toBeGreaterThan(100);
    // The first offered time is the next working morning after 24 hours' notice: Tuesday 3 November, 09:00 in Manila.
    expect(result.slots[0].start).toBe("2026-11-03T01:00:00.000Z");
    for (const slot of result.slots) {
      const local = manilaParts(slot.start);
      expect(["Mon", "Tue", "Wed", "Thu", "Fri"], slot.start).toContain(local.weekday);
      expect(local.minutes % 30, slot.start).toBe(0);
      expect(local.minutes, slot.start).toBeGreaterThanOrEqual(9 * 60);
      expect(local.minutes, slot.start).toBeLessThanOrEqual(16 * 60 + 30);
      expect(new Date(slot.start).getTime(), slot.start).toBeGreaterThanOrEqual(NOW.getTime() + DAY_MS);
      expect(new Date(slot.start).getTime(), slot.start).toBeLessThanOrEqual(NOW.getTime() + 30 * DAY_MS);
    }
    const days = new Set(result.slots.map((s) => manilaParts(s.start).weekday));
    expect(days.has("Sat") || days.has("Sun")).toBe(false);
  });

  it("verify as ready to take bookings, without a meeting link", async () => {
    const verification = await verifyCalendar(shop.actor("owner"), calendarId, { now: NOW });
    expect(verification.checks.filter((c) => !c.ok)).toEqual([]);
    expect(verification.firstOpenTime).not.toBeNull();
  });

  it("gate a Google Meet link on a connected Google account", async () => {
    await updateAppointmentType(shop.actor("owner"), typeId, { meetingProvider: "google_meet" });
    const verification = await verifyCalendar(shop.actor("owner"), calendarId, { now: NOW });
    const connections = verification.checks.find((c) => c.key === "connections")!;
    expect(connections.ok).toBe(false);
    expect(connections.detail).toMatch(/Google/);
    expect(verification.ok).toBe(false);
    await updateAppointmentType(shop.actor("owner"), typeId, { meetingProvider: "none" });
  });
});
