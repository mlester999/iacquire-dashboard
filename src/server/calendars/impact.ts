import "server-only";
import { createHash } from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { addDays, isValidTimeZone, workingIntervals, zonedDate, zonedToInstant, type DayOverride, type WeeklyRule } from "@/lib/calendars/slots";

// Changing a host's hours, taking a host off a calendar or adding a day off never touches a booking that already exists: the customer was promised that time, and
// moving or cancelling it is the customer's business (and a person's decision), not a side effect of a settings screen. What these functions do is NOTICE: they list the
// upcoming bookings that no longer fit, so the screen can say "N upcoming bookings are outside these hours; review them", and tell the people who can act on it once.
// Nothing in this file writes to appointment_refs, crm_busy_blocks or crm_appointment_hosts.

export type AttentionReason = "outside_hours" | "closed_day" | "host_inactive" | "host_removed";

export interface BookingNeedingAttention {
  id: string;
  startAt: string;
  endAt: string;
  calendarId: string | null;
  /** The host the reason is about (a collective booking is listed once, for the first host that no longer fits). */
  hostUserId: string;
  contactLabel: string | null;
  reason: AttentionReason;
  /** Plain words for the reason, for the notice and the list. */
  detail: string;
}

export interface AttentionScope {
  /** Only bookings these people host. Left out, every host is checked. */
  userIds?: string[];
  /** Only bookings on this calendar. */
  calendarId?: string;
  /** Only bookings that start inside this window (a day exception looks at the days it changes). */
  from?: Date;
  to?: Date;
  now?: Date;
}

const REASON_TEXT: Record<AttentionReason, string> = {
  outside_hours: "It is outside the host's working hours now.",
  closed_day: "It falls on a day the host no longer works.",
  host_inactive: "Its host is no longer an active member of this workspace.",
  host_removed: "Its host no longer takes bookings on this calendar.",
};

/** A bound on one check, so a workspace with a very long diary is still answered quickly. */
const MAX_CHECKED = 1000;

interface Row {
  id: string;
  start_at: Date;
  end_at: Date;
  calendar_ref: string | null;
  contact_label: string | null;
  user_id: string;
}

/**
 * The upcoming native bookings ('new' or 'confirmed', not yet over) whose host can no longer take them: the meeting no longer fits inside one of the host's working
 * intervals (weekly hours in the host's own zone with day exceptions applied, so a daylight-saving day is judged exactly as availability judges it), it falls on a day the
 * host has closed, the host is no longer an active member of the workspace, or the host is no longer on the booking's calendar. Reads only: it never cancels, moves or
 * edits anything. Trusted code: the caller authorized the reader for `orgId`, every query names it, so another workspace's bookings are never seen.
 */
export async function findBookingsNeedingAttention(db: Queryable, orgId: string, scope: AttentionScope = {}): Promise<BookingNeedingAttention[]> {
  const now = scope.now ?? new Date();
  const userIds = scope.userIds ? [...new Set(scope.userIds)] : null;
  if (userIds && !userIds.length) return [];
  const rows = await db.query<Row>(
    `select a.id, a.start_at, a.end_at, a.calendar_ref, a.contact_label, h.user_id
       from appointment_refs a
       join lateral (
         select ah.user_id from crm_appointment_hosts ah where ah.appointment_id = a.id and ah.org_id = a.org_id
         union
         select a.assigned_user_id where a.assigned_user_id is not null
       ) h on true
      where a.org_id = $1 and a.provider = 'native' and a.status in ('new', 'confirmed') and a.end_at > $2
        and ($3::uuid[] is null or h.user_id = any($3::uuid[]))
        and ($4::uuid is null or a.calendar_ref = $4::uuid)
        and ($5::timestamptz is null or a.start_at >= $5::timestamptz) and ($6::timestamptz is null or a.start_at < $6::timestamptz)
      order by a.start_at, a.id, h.user_id
      limit ${MAX_CHECKED}`,
    [orgId, now, userIds, scope.calendarId ?? null, scope.from ?? null, scope.to ?? null],
  );
  if (!rows.rows.length) return [];

  const hostIds = [...new Set(rows.rows.map((r) => r.user_id))];
  const earliest = new Date(Math.min(...rows.rows.map((r) => new Date(r.start_at).getTime())));
  const active = await db.query<{ user_id: string }>(
    `select m.user_id from organization_memberships m join users u on u.id = m.user_id
      where m.org_id = $1 and m.status = 'active' and u.status = 'active' and m.user_id = any($2::uuid[])`,
    [orgId, hostIds],
  );
  const onCalendar = await db.query<{ calendar_id: string; user_id: string }>("select calendar_id, user_id from crm_calendar_members where org_id = $1 and active and user_id = any($2::uuid[])", [orgId, hostIds]);
  const settings = await db.query<{ user_id: string; timezone: string }>("select user_id, timezone from crm_host_settings where org_id = $1 and user_id = any($2::uuid[])", [orgId, hostIds]);
  const rules = await db.query<{ user_id: string; weekday: number; start_minute: number; end_minute: number }>("select user_id, weekday, start_minute, end_minute from crm_availability_rules where org_id = $1 and user_id = any($2::uuid[])", [orgId, hostIds]);
  const overrides = await db.query<{ user_id: string | null; on_date: string; start_minute: number | null; end_minute: number | null }>(
    "select user_id, on_date::text, start_minute, end_minute from crm_availability_overrides where org_id = $1 and (user_id is null or user_id = any($2::uuid[])) and on_date >= ($3::timestamptz)::date - 2",
    [orgId, hostIds, earliest],
  );
  const org = await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId]);
  const activeIds = new Set(active.rows.map((r) => r.user_id));
  const memberOf = new Set(onCalendar.rows.map((r) => `${r.calendar_id}:${r.user_id}`));
  const orgZone = org.rows[0]?.timezone && isValidTimeZone(org.rows[0].timezone) ? org.rows[0].timezone : "UTC";
  const zoneOf = new Map(settings.rows.map((r) => [r.user_id, isValidTimeZone(r.timezone) ? r.timezone : orgZone]));

  const hours = new Map<string, { zone: string; rules: WeeklyRule[]; overrides: DayOverride[] }>();
  for (const id of hostIds) {
    const own = overrides.rows.filter((o) => o.user_id === id);
    const ownDates = new Set(own.map((o) => o.on_date));
    // A person's own exception for a day replaces the workspace-wide one for that day, as in availability.
    const all = [...own, ...overrides.rows.filter((o) => o.user_id === null && !ownDates.has(o.on_date))];
    hours.set(id, {
      zone: zoneOf.get(id) ?? orgZone,
      rules: rules.rows.filter((r) => r.user_id === id).map((r) => ({ weekday: r.weekday, startMinute: r.start_minute, endMinute: r.end_minute })),
      overrides: all.map((o) => ({ date: o.on_date, startMinute: o.start_minute, endMinute: o.end_minute })),
    });
  }

  const out = new Map<string, BookingNeedingAttention>();
  for (const r of rows.rows) {
    if (out.has(r.id)) continue;
    const reason = reasonFor(r, { activeIds, memberOf, hours: hours.get(r.user_id) });
    if (!reason) continue;
    out.set(r.id, {
      id: r.id, startAt: new Date(r.start_at).toISOString(), endAt: new Date(r.end_at).toISOString(), calendarId: r.calendar_ref, hostUserId: r.user_id,
      contactLabel: r.contact_label, reason, detail: REASON_TEXT[reason],
    });
  }
  return [...out.values()];
}

function reasonFor(
  r: Row,
  ctx: { activeIds: Set<string>; memberOf: Set<string>; hours: { zone: string; rules: WeeklyRule[]; overrides: DayOverride[] } | undefined },
): AttentionReason | null {
  if (!ctx.activeIds.has(r.user_id)) return "host_inactive";
  if (r.calendar_ref && !ctx.memberOf.has(`${r.calendar_ref}:${r.user_id}`)) return "host_removed";
  const h = ctx.hours;
  if (!h) return null;
  const start = new Date(r.start_at).getTime();
  const end = new Date(r.end_at).getTime();
  // Hours are expanded over a wider window than the meeting, as availability does, so a meeting that starts near midnight sees the whole of its day.
  const work = workingIntervals({ from: start - 36 * 3_600_000, to: end + 36 * 3_600_000, timeZone: h.zone, rules: h.rules, overrides: h.overrides });
  if (work.some((w) => w.start <= start && end <= w.end)) return null;
  const date = zonedDate(start, h.zone);
  const dayStart = zonedToInstant(date, 0, h.zone);
  const dayEnd = zonedToInstant(addDays(date, 1), 0, h.zone);
  const that = workingIntervals({ from: dayStart, to: dayEnd, timeZone: h.zone, rules: h.rules, overrides: h.overrides });
  return that.length ? "outside_hours" : "closed_day";
}

/** Covers exactly the bookings and reasons listed, so the same situation is announced once and a different one is announced again. */
export function attentionDigest(list: readonly BookingNeedingAttention[]): string {
  return createHash("sha256").update(list.map((b) => `${b.id}:${b.reason}:${b.hostUserId}`).sort().join("|")).digest("hex");
}

/** The sentence a settings screen shows, or null when nothing needs a look. Plain words: nothing was cancelled or moved. */
export function attentionWarning(list: readonly BookingNeedingAttention[]): string | null {
  const n = list.length;
  if (!n) return null;
  const hoursOnly = list.every((b) => b.reason === "outside_hours" || b.reason === "closed_day");
  const noun = n === 1 ? "upcoming booking" : "upcoming bookings";
  const be = n === 1 ? "is" : "are";
  const them = n === 1 ? "it" : "them";
  return hoursOnly
    ? `${n} ${noun} ${be} outside these hours; review ${them}. Nothing was cancelled or moved.`
    : `${n} ${noun} ${be} with a host who no longer fits; review ${them}. Nothing was cancelled or moved.`;
}

const CLEARED_ACTION = "crm.booking_impact_cleared";

/**
 * How many times a check has found that nothing needed a look after a notice had gone out. A notice is unique per person and key for good (not only while unread), so the same
 * list coming back later has to carry a different key to be announced again: this count is the part of the key that changes when the problem was resolved in between.
 */
async function impactEpisode(db: Queryable, orgId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>("select count(*) as n from audit_logs where org_id = $1 and action = $2", [orgId, CLEARED_ACTION]);
  return Number(rows[0]?.n ?? 0);
}

/**
 * A check that found nothing, after a notice had been sent since the last such moment, closes that episode: one audit row, written once per episode. The next list, even an
 * identical one, is then a new problem and is announced.
 */
async function closeImpactEpisode(db: Queryable, orgId: string): Promise<void> {
  const open = await db.query(
    `select 1 from notifications n
      where n.org_id = $1 and n.dedupe_key like 'calendar-impact:%'
        and n.created_at > coalesce((select max(a.created_at) from audit_logs a where a.org_id = $1 and a.action = $2), '-infinity'::timestamptz)
      limit 1`,
    [orgId, CLEARED_ACTION],
  );
  if (!open.rows.length) return;
  await recordAudit({ orgId, actorKind: "system", action: CLEARED_ACTION, targetType: "organization", targetId: orgId, result: "success" }, db);
}

/**
 * Tells the workspace's owners and admins, and the hosts a booking is still with, about the bookings that need a look: ONE notice per distinct list per episode (its dedupe key
 * holds the digest of the bookings and reasons, and the count of times the problem was resolved in between), linking to the earliest booking. Saving the same hours again, or
 * running the check twice, adds nothing; the same list coming back after it was resolved is announced again. Customers are never contacted.
 */
export async function notifyBookingsNeedingAttention(db: Queryable, orgId: string, list: readonly BookingNeedingAttention[]): Promise<void> {
  if (!list.length) return;
  const first = list[0];
  const n = list.length;
  const notice = {
    kind: "crm_calendar_sync" as const,
    severity: "warning" as const,
    title: n === 1 ? "An upcoming booking needs a look" : `${n} upcoming bookings need a look`,
    body: `${first.contactLabel ? `${first.contactLabel}: ` : ""}${first.detail} Nothing was cancelled or moved: open the booking to change it with the customer.`,
    link: `/crm/calendar?appointment=${first.id}`,
    dedupeKey: `calendar-impact:${orgId}:${attentionDigest(list)}:${await impactEpisode(db, orgId)}`,
  };
  await notifyOrgRoles(db, orgId, ["owner", "admin"], notice);
  for (const host of new Set(list.filter((b) => b.reason !== "host_inactive").map((b) => b.hostUserId))) await notifyUser(db, host, orgId, notice);
}

/**
 * The check a write service runs once its change has committed: finds the bookings the change left behind, tells the right people once, and returns the list for the screen.
 * It opens its own system transaction (so it must not be called inside another) and never fails the person's change: on a problem it is logged without details and the
 * list is empty.
 */
export async function checkBookingsAfterChange(orgId: string, scope: AttentionScope = {}): Promise<BookingNeedingAttention[]> {
  try {
    return await withSystem(async (db) => {
      const list = await findBookingsNeedingAttention(db, orgId, scope);
      if (list.length) await notifyBookingsNeedingAttention(db, orgId, list);
      else await closeImpactEpisode(db, orgId);
      return list;
    });
  } catch (err) {
    console.warn("[iacquire] the check for bookings that no longer fit failed after a calendar change.", { error: err instanceof Error ? err.name : "unknown" });
    return [];
  }
}
