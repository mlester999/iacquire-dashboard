import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { filterSlots, isLiveStatus, type AppointmentStatus, type Slot } from "@/lib/appointments";
import { ghlAppointmentProvider, type AppointmentProvider } from "@/server/appointments/provider";
import { bookingIsNative, nativeAvailability } from "@/server/calendars/agent-booking";

export interface AppointmentPolicy {
  defaultCalendarId: string | null;
  slotMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  lateCancelHours: number | null;
  aiBookingEnabled: boolean;
  remindersEnabled: boolean;
  reminderOffsetsMinutes: number[];
  remindersApprovalId: string | null;
}

export const DEFAULT_POLICY: AppointmentPolicy = {
  defaultCalendarId: null, slotMinutes: 30, minNoticeMinutes: 120, maxDaysAhead: 30, lateCancelHours: null, aiBookingEnabled: false, remindersEnabled: false, reminderOffsetsMinutes: [1440, 120], remindersApprovalId: null,
};

export async function loadPolicy(db: Queryable, orgId: string): Promise<AppointmentPolicy> {
  const { rows } = await db.query<{
    default_calendar_id: string | null; slot_minutes: number; min_notice_minutes: number; max_days_ahead: number; late_cancel_hours: number | null; ai_booking_enabled: boolean;
    reminders_enabled: boolean; reminder_offsets_minutes: number[]; reminders_approval_id: string | null;
  }>("select * from appointment_settings where org_id = $1", [orgId]);
  const r = rows[0];
  if (!r) return DEFAULT_POLICY;
  return {
    defaultCalendarId: r.default_calendar_id, slotMinutes: r.slot_minutes, minNoticeMinutes: r.min_notice_minutes, maxDaysAhead: r.max_days_ahead, lateCancelHours: r.late_cancel_hours,
    aiBookingEnabled: r.ai_booking_enabled, remindersEnabled: r.reminders_enabled, reminderOffsetsMinutes: r.reminder_offsets_minutes, remindersApprovalId: r.reminders_approval_id,
  };
}

export type AvailabilityResult =
  | { ok: true; slots: Slot[]; calendarId: string; timeZone: string; checkedAt: string; slotMinutes: number }
  | { ok: false; reason: string; detail: string };

export interface AvailabilityOptions {
  calendarId?: string | null;
  from?: Date;
  to?: Date;
  /** Cap on the number of slots returned. */
  limit?: number;
  /** Cap per calendar day, so a long list is not all one afternoon. */
  perDay?: number;
  timeZone?: string;
  now?: Date;
  provider?: AppointmentProvider;
  /** A booking that already holds the slot being checked, so it does not count as taking it. */
  ignoreBookingId?: string;
}

/**
 * The times a customer can really be offered. Every slot was reported free by the calendar provider moments ago; the portal then
 * only ever removes times (too soon, too far out, already held by an appointment or a pending booking), it never adds one. If the
 * calendar can't be read the answer is "none, and here is why", never a guess.
 */
export async function getAvailability(orgId: string, opts: AvailabilityOptions = {}): Promise<AvailabilityResult> {
  // A workspace on native calendars answers from its own calendars; GoHighLevel is never asked.
  if (!opts.provider && (await withSystem((db) => bookingIsNative(db, orgId)))) return nativeAvailability(orgId, opts);
  const now = opts.now ?? new Date();
  const provider = opts.provider ?? ghlAppointmentProvider;
  const ctx = await withSystem(async (db) => {
    const policy = await loadPolicy(db, orgId);
    const map = await db.query<{ calendar_ids: string[] }>("select calendar_ids from ghl_location_mappings where org_id = $1 and status <> 'disabled'", [orgId]);
    const org = await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId]);
    return { policy, calendars: map.rows[0]?.calendar_ids ?? null, orgTz: org.rows[0]?.timezone ?? "UTC" };
  });
  if (!ctx.calendars) return { ok: false, reason: "not_connected", detail: "The calendar isn't connected for this workspace." };
  const calendarId = opts.calendarId ?? ctx.policy.defaultCalendarId ?? (ctx.calendars.length === 1 ? ctx.calendars[0] : null);
  if (!calendarId) return { ok: false, reason: "no_calendar", detail: ctx.calendars.length ? "Choose which calendar bookings go on." : "No calendar is connected for this workspace." };
  if (!ctx.calendars.includes(calendarId)) return { ok: false, reason: "calendar_not_mapped", detail: "That calendar isn't connected to this workspace." };

  const earliest = new Date(now.getTime() + ctx.policy.minNoticeMinutes * 60_000);
  const from = new Date(Math.max((opts.from ?? earliest).getTime(), earliest.getTime()));
  const horizon = new Date(now.getTime() + ctx.policy.maxDaysAhead * 86_400_000);
  const to = new Date(Math.min((opts.to ?? new Date(from.getTime() + 7 * 86_400_000)).getTime(), horizon.getTime()));
  if (to.getTime() <= from.getTime()) return { ok: true, slots: [], calendarId, timeZone: opts.timeZone ?? ctx.orgTz, checkedAt: now.toISOString(), slotMinutes: ctx.policy.slotMinutes };
  const timeZone = opts.timeZone ?? ctx.orgTz;

  const free = await provider.freeSlots({ orgId, calendarId, from, to, timeZone });
  if (!free.ok) return { ok: false, reason: free.reason, detail: free.detail };

  const busy = await withSystem(async (db) => {
    const held = await db.query<{ start_at: Date; end_at: Date; status: AppointmentStatus }>(
      "select start_at, end_at, status from appointment_refs where org_id = $1 and ghl_calendar_id = $2 and end_at > $3 and start_at < $4",
      [orgId, calendarId, from.toISOString(), to.toISOString()],
    );
    const pending = await db.query<{ start_at: Date; end_at: Date }>(
      "select start_at, end_at from appointment_bookings where org_id = $1 and calendar_id = $2 and status in ('awaiting_approval', 'requested', 'needs_manual') and end_at > $3 and start_at < $4 and ($5::uuid is null or id <> $5::uuid)",
      [orgId, calendarId, from.toISOString(), to.toISOString(), opts.ignoreBookingId ?? null],
    );
    return [...held.rows.filter((r) => isLiveStatus(r.status)), ...pending.rows].map((r) => ({ start: new Date(r.start_at), end: new Date(r.end_at) }));
  });

  const sized = free.slots.map((s) => ({ start: s.start, end: new Date(new Date(s.start).getTime() + ctx.policy.slotMinutes * 60_000).toISOString() }));
  let slots = filterSlots(sized, { now, minNoticeMinutes: ctx.policy.minNoticeMinutes, maxDaysAhead: ctx.policy.maxDaysAhead, busy });
  if (opts.perDay) {
    const perDay = new Map<string, number>();
    slots = slots.filter((s) => {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s.start));
      const n = (perDay.get(day) ?? 0) + 1;
      perDay.set(day, n);
      return n <= (opts.perDay as number);
    });
  }
  if (opts.limit) slots = slots.slice(0, opts.limit);
  return { ok: true, slots, calendarId, timeZone, checkedAt: now.toISOString(), slotMinutes: ctx.policy.slotMinutes };
}

/** Whether one exact slot is offered right now. Used immediately before a booking is sent. */
export async function isSlotAvailable(orgId: string, calendarId: string, startAt: Date, opts: { now?: Date; provider?: AppointmentProvider; ignoreBookingId?: string } = {}): Promise<{ ok: true; available: boolean; checkedAt: string } | { ok: false; reason: string; detail: string }> {
  const now = opts.now ?? new Date();
  const res = await getAvailability(orgId, { calendarId, from: new Date(startAt.getTime() - 60_000), to: new Date(startAt.getTime() + 3_600_000), now, provider: opts.provider, ignoreBookingId: opts.ignoreBookingId, limit: 200 });
  if (!res.ok) return res;
  return { ok: true, available: res.slots.some((s) => new Date(s.start).getTime() === startAt.getTime()), checkedAt: res.checkedAt };
}
