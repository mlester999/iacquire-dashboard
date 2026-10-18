import "server-only";
import { type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { slotStarts, workingIntervals, zonedDate, type DayOverride, type Interval, type WeeklyRule } from "@/lib/calendars/slots";
import { TYPE_COLUMNS, toTypeView, type AppointmentTypeView, type Assignment, type CalendarStatus } from "@/server/calendars/setup";

export interface BookableSlot {
  start: string;
  end: string;
  /** Who could take it (round robin), or who will attend (collective). */
  hostIds: string[];
  /** For group sessions: places left. */
  remaining: number | null;
}

export interface Host {
  userId: string;
  name: string;
  priority: number;
  lastAssignedAt: Date | null;
  timezone: string;
  accepting: boolean;
  rules: WeeklyRule[];
  overrides: DayOverride[];
}

export interface BookingContext {
  orgId: string;
  orgName: string;
  orgSlug: string;
  orgTimezone: string;
  type: AppointmentTypeView;
  calendar: { id: string; name: string; slug: string; assignment: Assignment; roundRobinMode: "balanced" | "priority"; public: boolean; status: CalendarStatus };
  hosts: Host[];
}

const LIVE = "('new', 'confirmed')";

/** Why a draft calendar refuses a booking, in the words staff see. Public pages never get this far: they only ever find active calendars. */
export const DRAFT_CALENDAR_MESSAGE = "This calendar is still a draft, so it takes no bookings. Verify and activate it in Calendars & Types first.";

/**
 * Everything availability depends on for one appointment type. Only active, accepting members who are still in the workspace host.
 * A draft calendar (one a Blueprint created that nobody has verified and activated yet) takes no bookings, so its types are refused here,
 * which every booking path goes through: staff, the AI's request flow, booking pages, website booking and the API. Only the activation
 * check reads a draft's context (`includeDraft`), to prove a real time would be offered before it goes live.
 */
export async function loadBookingContext(db: Queryable, orgId: string, typeId: string, opts: { includeDraft?: boolean } = {}): Promise<BookingContext> {
  const t = await db.query<Parameters<typeof toTypeView>[0] & { cal_name: string; cal_slug: string; assignment: Assignment; round_robin_mode: "balanced" | "priority"; cal_public: boolean; cal_status: CalendarStatus }>(
    `select ${TYPE_COLUMNS}, c.name as cal_name, c.slug as cal_slug, c.assignment, c.round_robin_mode, c.public as cal_public, c.status as cal_status
     from crm_appointment_types t join crm_calendars c on c.id = t.calendar_id and c.org_id = t.org_id
     where t.id = $1 and t.org_id = $2 and t.archived_at is null and c.archived_at is null`,
    [typeId, orgId],
  );
  const row = t.rows[0];
  if (!row) throw new AppError("not_found", "That appointment type isn't available.");
  // "Not found" like any type that can't be booked, so public pages answer exactly as for a page that doesn't exist; staff see why.
  if (row.cal_status !== "active" && !opts.includeDraft) throw new AppError("not_found", DRAFT_CALENDAR_MESSAGE);
  const org = await db.query<{ name: string; slug: string; timezone: string }>("select name, slug, timezone from organizations where id = $1", [orgId]);
  const orgTimezone = org.rows[0]?.timezone ?? "UTC";
  const members = await db.query<{ user_id: string; name: string; priority: number; last_assigned_at: Date | null; timezone: string | null; accepting: boolean | null }>(
    `select cm.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as name, cm.priority, cm.last_assigned_at, h.timezone, h.accepting
     from crm_calendar_members cm join organization_memberships m on m.org_id = cm.org_id and m.user_id = cm.user_id and m.status = 'active'
     join users u on u.id = cm.user_id and u.status = 'active'
     left join crm_host_settings h on h.org_id = cm.org_id and h.user_id = cm.user_id
     where cm.calendar_id = $1 and cm.org_id = $2 and cm.active order by cm.priority desc, cm.created_at`,
    [row.calendar_id, orgId],
  );
  const ids = members.rows.map((m) => m.user_id);
  const rules = ids.length ? await db.query<{ user_id: string; weekday: number; start_minute: number; end_minute: number }>("select user_id, weekday, start_minute, end_minute from crm_availability_rules where org_id = $1 and user_id = any($2::uuid[])", [orgId, ids]) : { rows: [] };
  const overrides = await db.query<{ user_id: string | null; on_date: string; start_minute: number | null; end_minute: number | null }>(
    "select user_id, on_date::text, start_minute, end_minute from crm_availability_overrides where org_id = $1 and on_date >= current_date - 2",
    [orgId],
  );
  return {
    orgId, orgName: org.rows[0]?.name ?? "", orgSlug: org.rows[0]?.slug ?? "", orgTimezone,
    type: toTypeView(row),
    calendar: { id: row.calendar_id, name: row.cal_name, slug: row.cal_slug, assignment: row.assignment, roundRobinMode: row.round_robin_mode, public: row.cal_public, status: row.cal_status },
    hosts: members.rows.map((m) => {
      const own = overrides.rows.filter((o) => o.user_id === m.user_id);
      const ownDates = new Set(own.map((o) => o.on_date));
      // A person's own exception for a day replaces the workspace-wide one for that day.
      const all = [...own, ...overrides.rows.filter((o) => o.user_id === null && !ownDates.has(o.on_date))];
      return {
        userId: m.user_id, name: m.name, priority: m.priority, lastAssignedAt: m.last_assigned_at, timezone: m.timezone ?? orgTimezone, accepting: m.accepting ?? true,
        rules: rules.rows.filter((r) => r.user_id === m.user_id).map((r) => ({ weekday: r.weekday, startMinute: r.start_minute, endMinute: r.end_minute })),
        overrides: all.map((o) => ({ date: o.on_date, startMinute: o.start_minute, endMinute: o.end_minute })),
      };
    }),
  };
}

export interface SlotQuery {
  from: Date;
  to: Date;
  now?: Date;
  /** People booking on someone's behalf may book inside the notice period; customers and AI employees can't. */
  ignoreNotice?: boolean;
  /** An appointment being rescheduled: its own time doesn't count as busy. */
  excludeAppointmentId?: string | null;
  onlyHostId?: string | null;
}

/**
 * Bookable start times for an appointment type. Every time offered is inside a host's working hours, clear of their native
 * appointments (with buffers) and of busy times from calendars they connected, within notice and horizon, and under the daily limit.
 * The exclusion constraint on busy blocks enforces the same rule again at booking time.
 */
export async function computeSlots(db: Queryable, ctx: BookingContext, q: SlotQuery): Promise<BookableSlot[]> {
  const now = (q.now ?? new Date()).getTime();
  const t = ctx.type;
  const earliest = q.ignoreNotice ? now : now + t.minNoticeMinutes * 60_000;
  const horizon = now + t.maxDaysAhead * 86_400_000;
  const from = Math.max(q.from.getTime(), earliest);
  const to = Math.min(q.to.getTime(), horizon, from + 62 * 86_400_000);
  if (to <= from) return [];
  const hosts = ctx.hosts.filter((h) => h.accepting && (!q.onlyHostId || h.userId === q.onlyHostId));
  if (!hosts.length) return [];
  const ids = hosts.map((h) => h.userId);
  const pad = (t.bufferBeforeMinutes + t.bufferAfterMinutes + t.durationMinutes) * 60_000 + 86_400_000;
  const blocks = await db.query<{ id: string; user_id: string; appointment_type_id: string | null; appointment_id: string | null; starts_at: Date; ends_at: Date; capacity: number; booked: number; mine: boolean }>(
    `select b.id, b.user_id, b.appointment_type_id, b.appointment_id, b.starts_at, b.ends_at, b.capacity, b.booked,
            ($5::uuid is not null and (b.appointment_id = $5::uuid
              or b.id in (select busy_block_id from appointment_refs where id = $5::uuid and org_id = $1 and busy_block_id is not null)
              or b.id in (select busy_block_id from crm_appointment_hosts where appointment_id = $5::uuid and org_id = $1 and busy_block_id is not null))) as mine
     from crm_busy_blocks b where b.org_id = $1 and b.user_id = any($2::uuid[]) and b.released_at is null and b.ends_at > $3 and b.starts_at < $4`,
    [ctx.orgId, ids, new Date(from - pad), new Date(to + pad), q.excludeAppointmentId ?? null],
  );
  const external = await db.query<{ user_id: string; starts_at: Date; ends_at: Date }>(
    `select e.user_id, e.starts_at, e.ends_at from crm_external_busy e join crm_calendar_connections c on c.id = e.connection_id
     where e.org_id = $1 and e.user_id = any($2::uuid[]) and c.status = 'connected' and c.check_conflicts and e.ends_at > $3 and e.starts_at < $4`,
    [ctx.orgId, ids, new Date(from - pad), new Date(to + pad)],
  );
  // Per-day limits count live appointments of this type, per host, by the host's local date.
  const daily = t.dailyLimit
    ? await db.query<{ user_id: string; start_at: Date }>(
        `select h.user_id, a.start_at from appointment_refs a join crm_appointment_hosts h on h.appointment_id = a.id
         where a.org_id = $1 and a.appointment_type_id = $2 and a.status in ${LIVE} and h.user_id = any($3::uuid[]) and a.start_at > $4 and a.start_at < $5 and ($6::uuid is null or a.id <> $6::uuid)`,
        [ctx.orgId, t.id, ids, new Date(from - 86_400_000), new Date(to + 86_400_000), q.excludeAppointmentId ?? null],
      )
    : { rows: [] };

  const dur = t.durationMinutes * 60_000;
  const before = t.bufferBeforeMinutes * 60_000;
  const perHost = new Map<string, Map<number, number | null>>(); // start -> remaining (group) or null
  for (const h of hosts) {
    // Hours are expanded over a wider window and the starts filtered afterwards, so a narrow query (one exact time) still sees the whole day.
    const work = workingIntervals({ from: from - 86_400_000, to: to + dur + 86_400_000, timeZone: h.timezone, rules: h.rules, overrides: h.overrides });
    const mine = blocks.rows.filter((b) => b.user_id === h.userId && !(b.mine && b.capacity === 1));
    const busy: Interval[] = [
      ...mine.map((b) => ({ start: new Date(b.starts_at).getTime(), end: new Date(b.ends_at).getTime() })),
      ...external.rows.filter((e) => e.user_id === h.userId).map((e) => ({ start: new Date(e.starts_at).getTime(), end: new Date(e.ends_at).getTime() })),
    ];
    const starts = new Map<number, number | null>();
    for (const s of slotStarts(work, busy, { durationMinutes: t.durationMinutes, intervalMinutes: t.slotIntervalMinutes ?? t.durationMinutes, bufferBeforeMinutes: t.bufferBeforeMinutes, bufferAfterMinutes: t.bufferAfterMinutes, timeZone: h.timezone })) {
      starts.set(s, t.capacity > 1 ? t.capacity : null);
    }
    // Group sessions already started by someone else stay open until full.
    if (t.capacity > 1) {
      for (const b of mine) {
        if (b.appointment_type_id !== t.id || b.capacity <= 1) continue;
        const s = new Date(b.starts_at).getTime() + before;
        const left = b.capacity - b.booked + (b.mine ? 1 : 0);
        if (left > 0) starts.set(s, left);
      }
    }
    if (t.dailyLimit) {
      const counts = new Map<string, number>();
      for (const d of daily.rows.filter((r) => r.user_id === h.userId)) {
        const day = zonedDate(new Date(d.start_at).getTime(), h.timezone);
        counts.set(day, (counts.get(day) ?? 0) + 1);
      }
      for (const s of [...starts.keys()]) {
        const day = zonedDate(s, h.timezone);
        // Joining an existing group session doesn't add an appointment for the host.
        if ((counts.get(day) ?? 0) >= t.dailyLimit && starts.get(s) === (t.capacity > 1 ? t.capacity : null)) starts.delete(s);
      }
    }
    for (const s of [...starts.keys()]) if (s < from || s >= to) starts.delete(s);
    perHost.set(h.userId, starts);
  }

  const all = new Set<number>();
  for (const m of perHost.values()) for (const s of m.keys()) all.add(s);
  const out: BookableSlot[] = [];
  for (const s of [...all].sort((a, b) => a - b)) {
    const free = hosts.filter((h) => perHost.get(h.userId)?.has(s)).map((h) => h.userId);
    if (ctx.calendar.assignment === "collective" && free.length !== hosts.length) continue;
    if (ctx.calendar.assignment === "single" && !free.includes(hosts[0].userId)) continue;
    const ok = ctx.calendar.assignment === "single" ? [hosts[0].userId] : free;
    if (!ok.length) continue;
    // Group places: round robin can use whichever host has room; a collective session needs a place with every host.
    const left = ok.map((id) => perHost.get(id)?.get(s) ?? 0);
    const remaining = t.capacity > 1 ? (ctx.calendar.assignment === "collective" ? Math.min(...left) : Math.max(...left)) : null;
    out.push({ start: new Date(s).toISOString(), end: new Date(s + dur).toISOString(), hostIds: ok, remaining });
  }
  return out;
}

/** Orders the free hosts for a round-robin booking: fewest recent assignments first (balanced), or highest priority first. */
export function orderHosts(ctx: BookingContext, free: string[]): string[] {
  const hosts = ctx.hosts.filter((h) => free.includes(h.userId));
  const last = (h: Host) => (h.lastAssignedAt ? new Date(h.lastAssignedAt).getTime() : 0);
  if (ctx.calendar.roundRobinMode === "priority") hosts.sort((a, b) => b.priority - a.priority || last(a) - last(b));
  else hosts.sort((a, b) => last(a) - last(b) || b.priority - a.priority);
  return hosts.map((h) => h.userId);
}
