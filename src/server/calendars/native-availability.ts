import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { computeSlots, DRAFT_CALENDAR_MESSAGE, loadBookingContext, type BookableSlot, type BookingContext } from "@/server/calendars/availability";
import type { AvailabilityOptions, AvailabilityResult } from "@/server/appointments/availability";

type Resolved = { typeId: string } | { refused: string };

/**
 * Takes out the times that requests still waiting for a person already hold, so one time is not offered to two people. A waiting request holds its place the way `requestNativeBooking`
 * counts it: one per free host (round robin), one in all for a collective calendar, one per seat for a group session. The time itself only becomes busy when the request is
 * approved and booked; until then this is the only thing that keeps it from being offered (and previewed, and asked for) again.
 */
async function withoutHeldRequests(db: Queryable, ctx: BookingContext, slots: BookableSlot[], from: Date, to: Date): Promise<BookableSlot[]> {
  if (!slots.length) return slots;
  const held = await db.query<{ start_at: Date; n: string }>(
    `select start_at, count(*)::text as n from appointment_bookings
      where org_id = $1 and provider = 'native' and calendar_id = $2 and start_at >= $3 and start_at < $4 and status in ('awaiting_approval', 'requested', 'needs_manual')
      group by start_at`,
    [ctx.orgId, ctx.type.id, from, to],
  );
  if (!held.rows.length) return slots;
  const waiting = new Map(held.rows.map((row) => [new Date(row.start_at).getTime(), Number(row.n)]));
  return slots.filter((slot) => {
    const requests = waiting.get(new Date(slot.start).getTime()) ?? 0;
    if (!requests) return true;
    const room = ctx.type.capacity > 1 ? slot.remaining ?? 1 : ctx.calendar.assignment === "collective" ? 1 : slot.hostIds.length;
    return requests < room;
  });
}

/** The one zone the calendar's accepting hosts work in, when they all share it. Null when they work in different zones, or when there is no host to read it from. */
function sharedHostTimeZone(ctx: BookingContext): string | null {
  const zones = new Set(ctx.hosts.filter((host) => host.accepting).map((host) => host.timezone));
  return zones.size === 1 ? [...zones][0] : null;
}

const NO_TYPE = "No appointment type is set up yet.";
const DRAFT_ONLY = "This workspace's calendars are still drafts, so they take no bookings yet. Verify and activate a calendar first.";

/**
 * Resolve only active appointment types. A request that names a draft calendar is refused rather
 * than silently moved to another calendar; the fallback skips drafts.
 */
export async function resolveNativeAppointmentType(db: Queryable, orgId: string, ref: string | null | undefined): Promise<Resolved> {
  if (ref && /^[0-9a-f-]{36}$/i.test(ref)) {
    const t = await db.query<{ id: string; status: string }>(
      "select t.id, c.status from crm_appointment_types t join crm_calendars c on c.id = t.calendar_id and c.org_id = t.org_id where t.id = $1 and t.org_id = $2 and t.archived_at is null",
      [ref, orgId],
    );
    if (t.rows[0]) return t.rows[0].status === "draft" ? { refused: DRAFT_CALENDAR_MESSAGE } : { typeId: t.rows[0].id };
    const c = await db.query<{ id: string | null; status: string }>(
      `select c.status, (select t.id from crm_appointment_types t where t.calendar_id = c.id and t.org_id = c.org_id and t.archived_at is null order by t.position limit 1) as id
       from crm_calendars c where c.id = $1 and c.org_id = $2 and c.archived_at is null`,
      [ref, orgId],
    );
    if (c.rows[0]?.status === "draft") return { refused: DRAFT_CALENDAR_MESSAGE };
    if (c.rows[0]?.id) return { typeId: c.rows[0].id };
  }
  const d = await db.query<{ id: string }>(
    `select t.id from crm_appointment_types t join crm_calendars c on c.id = t.calendar_id and c.org_id = t.org_id
     where c.org_id = $1 and c.archived_at is null and c.status = 'active' and t.archived_at is null order by c.is_default desc, c.created_at, t.position limit 1`,
    [orgId],
  );
  if (d.rows[0]) return { typeId: d.rows[0].id };
  const drafts = await db.query("select 1 from crm_calendars where org_id = $1 and archived_at is null and status = 'draft' limit 1", [orgId]);
  return { refused: drafts.rows.length ? DRAFT_ONLY : NO_TYPE };
}

/** Native availability in the shape the Appointment Setter and the Appointments page already use. */
export async function nativeAvailability(orgId: string, opts: AvailabilityOptions = {}): Promise<AvailabilityResult> {
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const resolved = await resolveNativeAppointmentType(db, orgId, opts.calendarId);
    if ("refused" in resolved) return { ok: false, reason: "no_calendar", detail: resolved.refused };
    const typeId = resolved.typeId;
    const ctx = await loadBookingContext(db, orgId, typeId);
    const from = opts.from ?? now;
    const to = opts.to ?? new Date(from.getTime() + 7 * 86_400_000);
    let slots = await withoutHeldRequests(db, ctx, await computeSlots(db, ctx, { from, to, now }), from, to);
    const timeZone = opts.timeZone ?? ctx.orgTimezone;
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
    return { ok: true, slots: slots.map((s) => ({ start: s.start, end: s.end })), calendarId: typeId, timeZone, checkedAt: now.toISOString(), slotMinutes: ctx.type.durationMinutes, hostTimeZone: sharedHostTimeZone(ctx) };
  });
}
