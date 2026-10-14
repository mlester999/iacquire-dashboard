// Appointment rules that need no database: reading GoHighLevel's appointment webhooks and free-slot answers, ordering events,
// and working out lateness and reminder times. Contract sources: GoHighLevel's published OpenAPI spec (calendars: free-slots,
// appointments) and webhook event docs (AppointmentCreate / AppointmentUpdate / AppointmentDelete), read 2026-10-14.

export const APPOINTMENT_STATUSES = ["new", "confirmed", "cancelled", "showed", "noshow", "invalid"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** GoHighLevel also reports "active" and "completed" in some responses; they map onto the statuses the portal shows. */
export function mapAppointmentStatus(raw: unknown): AppointmentStatus {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if ((APPOINTMENT_STATUSES as readonly string[]).includes(s)) return s as AppointmentStatus;
  if (s === "active") return "confirmed";
  if (s === "completed") return "showed";
  return "new";
}

/** A live appointment occupies its time. Cancelled and invalid ones do not. */
export const isLiveStatus = (s: AppointmentStatus) => s !== "cancelled" && s !== "invalid";

export interface GhlAppointmentEvent {
  kind: "create" | "update" | "delete";
  locationId: string;
  appointmentId: string;
  calendarId: string | null;
  contactId: string | null;
  status: AppointmentStatus;
  assignedUserId: string | null;
  title: string;
  address: string | null;
  startAt: Date | null;
  endAt: Date | null;
  /** The provider's own clock. Orders events; arrival time never does. */
  eventTime: Date;
  source: string | null;
}

const ID = /^[A-Za-z0-9_-]{6,80}$/;
const TYPE_KIND: Record<string, GhlAppointmentEvent["kind"]> = { AppointmentCreate: "create", AppointmentUpdate: "update", AppointmentDelete: "delete" };

function date(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Narrows an Appointment* webhook payload to what the portal uses. Anything malformed yields null and is ignored. */
export function parseGhlAppointmentEvent(payload: Record<string, unknown>): GhlAppointmentEvent | null {
  const kind = typeof payload.type === "string" ? TYPE_KIND[payload.type] : undefined;
  const a = payload.appointment;
  if (!kind || typeof a !== "object" || a === null || Array.isArray(a)) return null;
  const ap = a as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const locationId = str(payload.locationId);
  const appointmentId = str(ap.id);
  if (!locationId || !appointmentId || !ID.test(appointmentId)) return null;
  const idOrNull = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : null);
  const startAt = date(ap.startTime);
  const endAt = date(ap.endTime);
  // A delete may carry little more than an id. For any other event the times must make sense.
  if (kind !== "delete" && (!startAt || (endAt && endAt.getTime() < startAt.getTime()))) return null;
  const eventTime = date(ap.dateUpdated) ?? date(ap.dateAdded) ?? date(payload.timestamp);
  if (!eventTime) return null;
  return {
    kind,
    locationId,
    appointmentId,
    calendarId: idOrNull(ap.calendarId),
    contactId: idOrNull(ap.contactId),
    status: mapAppointmentStatus(ap.appointmentStatus ?? ap.status),
    assignedUserId: idOrNull(ap.assignedUserId),
    title: (str(ap.title) ?? "Appointment").slice(0, 200),
    address: str(ap.address),
    startAt,
    endAt: endAt && startAt && endAt.getTime() > startAt.getTime() ? endAt : startAt ? new Date(startAt.getTime() + 30 * 60_000) : null,
    eventTime,
    source: str(ap.source)?.slice(0, 40) ?? null,
  };
}

/** The key that makes two deliveries of the same logical event the same event, whatever their delivery ids. */
export const appointmentDedupeKey = (e: Pick<GhlAppointmentEvent, "kind" | "appointmentId" | "eventTime" | "status" | "startAt">) =>
  [e.kind, e.appointmentId, e.eventTime.toISOString(), e.status, e.startAt?.toISOString() ?? "-"].join("|");

export const overlaps = (a: { start: Date; end: Date }, b: { start: Date; end: Date }) => a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();

/** Whether cancelling at `cancelledAt` is closer to the start than the workspace's policy allows. No policy means never late. */
export function isLateCancellation(startAt: Date, cancelledAt: Date, lateHours: number | null | undefined): boolean {
  if (lateHours == null) return false;
  const ms = startAt.getTime() - cancelledAt.getTime();
  return ms >= 0 && ms < lateHours * 3_600_000;
}

/** When each reminder is due. Reminders already in the past are dropped, never sent late, and duplicates collapse. */
export function reminderSchedule(startAt: Date, offsetsMinutes: number[], now: Date): Array<{ offsetMinutes: number; dueAt: Date }> {
  const seen = new Set<number>();
  const out: Array<{ offsetMinutes: number; dueAt: Date }> = [];
  for (const offset of offsetsMinutes) {
    if (!Number.isInteger(offset) || offset <= 0 || seen.has(offset)) continue;
    seen.add(offset);
    const dueAt = new Date(startAt.getTime() - offset * 60_000);
    if (dueAt.getTime() > now.getTime()) out.push({ offsetMinutes: offset, dueAt });
  }
  return out.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

export interface Slot {
  /** ISO instant (UTC). */
  start: string;
  end: string;
}

/**
 * Reads GoHighLevel's free-slots answer: an object keyed by date, each holding a `slots` array of ISO timestamps. Anything that is
 * not a valid timestamp is dropped rather than guessed at. Returns null if the shape is not the documented one at all.
 */
export function parseFreeSlots(body: unknown, slotMinutes: number): Slot[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const out = new Map<string, Slot>();
  let sawDay = false;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (typeof value !== "object" || value === null || !Array.isArray((value as { slots?: unknown }).slots)) return null;
    sawDay = true;
    for (const s of (value as { slots: unknown[] }).slots) {
      const d = date(s);
      if (!d) continue;
      const start = d.toISOString();
      out.set(start, { start, end: new Date(d.getTime() + slotMinutes * 60_000).toISOString() });
    }
  }
  // An empty object is a valid "nothing free" answer; an object with unrelated keys is not.
  if (!sawDay && Object.keys(body as object).length > 0) return null;
  return [...out.values()].sort((a, b) => a.start.localeCompare(b.start));
}

export interface SlotFilter {
  now: Date;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  /** Time already taken on this calendar, from our own records. */
  busy: Array<{ start: Date; end: Date }>;
}

/** Keeps only slots that are far enough ahead, not too far out, and do not collide with anything we already know is taken. */
export function filterSlots(slots: Slot[], f: SlotFilter): Slot[] {
  const earliest = f.now.getTime() + f.minNoticeMinutes * 60_000;
  const latest = f.now.getTime() + f.maxDaysAhead * 86_400_000;
  return slots.filter((s) => {
    const start = new Date(s.start);
    const end = new Date(s.end);
    if (start.getTime() < earliest || start.getTime() > latest) return false;
    return !f.busy.some((b) => overlaps({ start, end }, b));
  });
}

/** A short, readable time in the customer's own zone, for messages. */
export function formatSlot(startIso: string, timeZone: string): string {
  const d = new Date(startIso);
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** Splits a requested date range into windows of at most 31 days, the most the provider accepts in one call. */
export function dateWindows(from: Date, to: Date, maxDays = 31): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = [];
  let cursor = from.getTime();
  const step = maxDays * 86_400_000 - 1;
  while (cursor < to.getTime() && out.length < 4) {
    const end = Math.min(cursor + step, to.getTime());
    out.push({ from: new Date(cursor), to: new Date(end) });
    cursor = end + 1;
  }
  return out;
}

const BOOKING_WORDS = /\b(book(ing|ed)?|appointments?|schedul(e|ing)|re-?schedul(e|ing)|viewing|tour|consultation|available|availability|slots?|meet(ing)?|come (in|by)|visit|free (on|at|for)|openings?)\b/i;
const TIME_WORDS = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b(tomorrow|next week|this week|morning|afternoon)\b/i;

/**
 * Whether the customer is talking about booking. When they are, the reply is prepared with the calendar's real availability; when
 * they are not, nothing about the calendar is read or mentioned. A reply to an earlier offer ("Tuesday 2pm works") counts as booking
 * talk if the previous message was about booking.
 */
export function detectBookingIntent(message: string, previous: string[] = []): boolean {
  if (BOOKING_WORDS.test(message)) return true;
  return TIME_WORDS.test(message) && previous.slice(-2).some((p) => BOOKING_WORDS.test(p));
}
