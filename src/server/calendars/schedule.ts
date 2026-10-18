import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { assertCan, crmRead, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner, resolveCapabilities } from "@/server/crm/workspace";
import { pageTotal } from "@/server/crm/directory";
import { loadCalendars, type Assignment, type BookingQuestion, type LocationKind } from "@/server/calendars/setup";
import { computeSlots, loadBookingContext, type BookableSlot } from "@/server/calendars/availability";
import { addDays, mergeIntervals, workingIntervals, zonedDate, type DayOverride } from "@/lib/calendars/slots";
import type { CapabilityProvider, CrmMode } from "@/lib/crm/types";

// The calendar workspace's reads: what is booked in a window, one appointment in full, what the filters offer, and when people work or are
// busy elsewhere. Everything here reads; every change goes through src/server/calendars/booking.ts.

export const SCHEDULE_STATUSES = ["new", "confirmed", "showed", "noshow", "cancelled"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];
/** Statuses that still hold time or record an outcome: everything except cancelled. */
export const ACTIVE_STATUSES: ScheduleStatus[] = ["new", "confirmed", "showed", "noshow"];
/** The widest window one schedule read covers (the same cap as availability). */
export const MAX_SCHEDULE_DAYS = 62;
/** At most this many appointments come back for one window; the screen says so when it is reached. */
export const SCHEDULE_LIMIT = 2000;
/** Slot reads for the staff pickers cover at most this many days. */
export const MAX_SLOT_DAYS = 31;

const DAY = 86_400_000;

export interface ScheduleItem {
  id: string;
  title: string;
  status: ScheduleStatus | "invalid";
  startAt: string;
  endAt: string;
  type: { id: string; name: string; color: string | null; durationMinutes: number } | null;
  calendar: { id: string; name: string; color: string | null } | null;
  hosts: Array<{ id: string; name: string }>;
  /** Only the contact's id and display name: the drawer links to the contact for anything more. */
  contact: { id: string; name: string } | null;
  bookedVia: string | null;
  location: string | null;
  meetingLink: string | null;
  /** Optimistic version: a reschedule passes it back so two people can't move the same appointment at once. */
  version: number;
  rescheduleCount: number;
  lateCancellation: boolean;
}

export interface ScheduleQuery {
  from: Date;
  to: Date;
  calendarIds?: string[];
  hostIds?: string[];
  statuses?: ScheduleStatus[];
}

type ItemRow = {
  id: string; title: string; status: ScheduleItem["status"]; start_at: Date; end_at: Date; booked_via: string | null; location: string | null; meeting_link: string | null;
  version: number; reschedule_count: number; late_cancellation: boolean; type_id: string | null; type_name: string | null; type_color: string | null; duration_minutes: number | null;
  cal_id: string | null; cal_name: string | null; cal_color: string | null; contact_id: string | null; contact_name: string | null; hosts: Array<{ id: string; name: string }> | null;
};

const ITEM_COLUMNS = `a.id, a.title, a.status, a.start_at, a.end_at, a.booked_via, a.location, a.meeting_link, a.version, a.reschedule_count, a.late_cancellation,
  t.id as type_id, t.name as type_name, t.color as type_color, t.duration_minutes, c.id as cal_id, c.name as cal_name, c.color as cal_color,
  a.contact_id, coalesce(nullif(ct.display_name, ''), a.contact_label) as contact_name,
  coalesce((select jsonb_agg(jsonb_build_object('id', h.user_id, 'name', coalesce(nullif(u.full_name, ''), u.email::text)) order by lower(coalesce(nullif(u.full_name, ''), u.email::text)))
            from crm_appointment_hosts h join users u on u.id = h.user_id where h.appointment_id = a.id), '[]'::jsonb) as hosts`;

const ITEM_FROM = `from appointment_refs a
  left join crm_appointment_types t on t.id = a.appointment_type_id and t.org_id = a.org_id
  left join crm_calendars c on c.id = a.calendar_ref and c.org_id = a.org_id
  left join contacts ct on ct.id = a.contact_id and ct.org_id = a.org_id and ct.deleted_at is null`;

const toItem = (r: ItemRow): ScheduleItem => ({
  id: r.id,
  title: r.title,
  status: r.status,
  startAt: new Date(r.start_at).toISOString(),
  endAt: new Date(r.end_at).toISOString(),
  type: r.type_id ? { id: r.type_id, name: r.type_name ?? "Appointment", color: r.type_color, durationMinutes: r.duration_minutes ?? 0 } : null,
  calendar: r.cal_id ? { id: r.cal_id, name: r.cal_name ?? "Calendar", color: r.cal_color } : null,
  hosts: r.hosts ?? [],
  contact: r.contact_id ? { id: r.contact_id, name: r.contact_name || "Unnamed contact" } : null,
  bookedVia: r.booked_via,
  location: r.location,
  meetingLink: r.meeting_link,
  version: r.version,
  rescheduleCount: r.reschedule_count,
  lateCancellation: r.late_cancellation,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkIds(ids: string[] | undefined, what: string): string[] | undefined {
  if (!ids?.length) return undefined;
  if (ids.length > 50 || ids.some((id) => !UUID.test(id))) throw new AppError("invalid_input", `Choose ${what} from the list.`);
  return ids;
}

function checkStatuses(statuses: ScheduleStatus[] | undefined): ScheduleStatus[] | undefined {
  if (!statuses?.length) return undefined;
  if (statuses.some((s) => !SCHEDULE_STATUSES.includes(s))) throw new AppError("invalid_input", "Choose a status from the list.");
  return statuses;
}

function checkWindow(from: Date, to: Date, maxDays: number) {
  const f = from.getTime();
  const t = to.getTime();
  if (Number.isNaN(f) || Number.isNaN(t)) throw new AppError("invalid_input", "Choose a date range.");
  if (t <= f) throw new AppError("invalid_input", "The end of the range must be after its start.");
  if (t - f > maxDays * DAY) throw new AppError("invalid_input", `Choose a range of ${maxDays} days or less.`);
}

/** Filters shared by the calendar and the list. Placeholders continue from the params already given. */
function filterSql(params: unknown[], q: { calendarIds?: string[]; hostIds?: string[]; statuses?: ScheduleStatus[]; search?: string }): string {
  let sql = "";
  if (q.calendarIds) {
    params.push(q.calendarIds);
    sql += ` and a.calendar_ref = any($${params.length}::uuid[])`;
  }
  if (q.hostIds) {
    params.push(q.hostIds);
    sql += ` and exists (select 1 from crm_appointment_hosts hf where hf.appointment_id = a.id and hf.user_id = any($${params.length}::uuid[]))`;
  }
  if (q.statuses) {
    params.push(q.statuses);
    sql += ` and a.status = any($${params.length}::text[])`;
  }
  if (q.search) {
    params.push(`%${q.search.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    sql += ` and (ct.search_text like $${params.length} escape '\\' or lower(coalesce(a.contact_label, '')) like $${params.length} escape '\\' or lower(a.title) like $${params.length} escape '\\')`;
  }
  return sql;
}

/**
 * Native appointments overlapping a window, in start order. Members read under row-level security, so a missing filter still can't reach
 * another workspace; GoHighLevel appointments (provider 'ghl') never appear here, they have their own read-only view.
 */
export async function listSchedule(actor: CrmActor, q: ScheduleQuery): Promise<ScheduleItem[]> {
  assertCan(actor, "appointments.view");
  checkWindow(q.from, q.to, MAX_SCHEDULE_DAYS);
  const filters = { calendarIds: checkIds(q.calendarIds, "a calendar"), hostIds: checkIds(q.hostIds, "a person"), statuses: checkStatuses(q.statuses) };
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId, q.from, q.to];
    const extra = filterSql(params, filters);
    params.push(SCHEDULE_LIMIT);
    const { rows } = await db.query<ItemRow>(
      `select ${ITEM_COLUMNS} ${ITEM_FROM}
       where a.org_id = $1 and a.provider = 'native' and a.start_at < $3 and a.end_at > $2${extra}
       order by a.start_at, a.end_at, a.id limit $${params.length}`,
      params,
    );
    return rows.map(toItem);
  });
}

export type AppointmentListWhen = "upcoming" | "past" | "range";

export interface AppointmentListQuery {
  when: AppointmentListWhen;
  /** For "range": start times from (inclusive) and to (exclusive). */
  from?: Date | null;
  to?: Date | null;
  calendarIds?: string[];
  hostIds?: string[];
  statuses?: ScheduleStatus[];
  search?: string;
  page?: number;
  pageSize?: number;
  now?: Date;
}

/** The appointments list: upcoming soonest first, past most recent first, or a date range; filtered, searched by contact, and paged. */
export async function listAppointmentPage(actor: CrmActor, q: AppointmentListQuery): Promise<{ items: ScheduleItem[]; total: number; page: number; pageSize: number }> {
  assertCan(actor, "appointments.view");
  const pageSize = Math.min(100, Math.max(5, Math.floor(q.pageSize ?? 25)));
  const page = Math.max(1, Math.min(10_000, Math.floor(q.page ?? 1)));
  const now = q.now ?? new Date();
  if (q.when === "range") {
    if (!q.from || !q.to) throw new AppError("invalid_input", "Choose both dates for the range.");
    checkWindow(q.from, q.to, 731);
  }
  const search = (q.search ?? "").trim().slice(0, 80);
  const filters = { calendarIds: checkIds(q.calendarIds, "a calendar"), hostIds: checkIds(q.hostIds, "a person"), statuses: checkStatuses(q.statuses), search: search || undefined };
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId];
    let when: string;
    if (q.when === "upcoming") {
      params.push(now);
      when = ` and a.end_at > $${params.length}`;
    } else if (q.when === "past") {
      params.push(now);
      when = ` and a.end_at <= $${params.length}`;
    } else {
      params.push(q.from, q.to);
      when = ` and a.start_at >= $${params.length - 1} and a.start_at < $${params.length}`;
    }
    const extra = filterSql(params, filters);
    const where = `where a.org_id = $1 and a.provider = 'native'${when}${extra}`;
    const order = q.when === "past" ? "a.start_at desc, a.id desc" : "a.start_at, a.id";
    const { rows } = await db.query<ItemRow>(
      `select ${ITEM_COLUMNS} ${ITEM_FROM} ${where} order by ${order} limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    // A short page already gives the total; the count runs only when the page is full (or empty past the first page).
    const total = await pageTotal(page, pageSize, rows.length, async () => Number((await db.query<{ n: string }>(`select count(*)::text as n ${ITEM_FROM} ${where}`, params)).rows[0]?.n ?? 0));
    return { items: rows.map(toItem), total, page, pageSize };
  });
}

export interface AppointmentHistoryEntry {
  id: string;
  kind: string;
  summary: string;
  at: string;
  /** Who did it, in plain words; null when the summary already says it (a booking page, an automation). */
  actor: string | null;
}

export interface AppointmentDetail extends ScheduleItem {
  description: string | null;
  answers: Array<{ key: string; label: string; value: string }>;
  cancelReason: string | null;
  cancelledAt: string | null;
  /** The customer's own time zone, when it differs from the workspace's. */
  inviteeTimezone: string | null;
  timezone: string | null;
  previousStartAt: string | null;
  createdAt: string;
  createdBy: string | null;
  assignment: Assignment | null;
  history: AppointmentHistoryEntry[];
}

/** One appointment in full: answers, notes, cancellation, the customer's time zone and what happened to it, from the CRM timeline. */
export async function getAppointmentDetail(actor: CrmActor, id: string): Promise<AppointmentDetail> {
  assertCan(actor, "appointments.view");
  if (!UUID.test(id)) throw new AppError("not_found", "Appointment not found.");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<ItemRow & {
      description: string | null; answers: Record<string, string> | null; cancel_reason: string | null; cancelled_at: Date | null; invitee_timezone: string | null; timezone: string | null;
      previous_start_at: Date | null; created_at: Date; created_by_name: string | null; questions: BookingQuestion[] | null; assignment: Assignment | null;
    }>(
      `select ${ITEM_COLUMNS}, a.description, a.answers, a.cancel_reason, a.cancelled_at, a.invitee_timezone, a.timezone, a.previous_start_at, a.created_at,
              coalesce(nullif(cb.full_name, ''), cb.email::text) as created_by_name, t.questions, c.assignment
       ${ITEM_FROM} left join users cb on cb.id = a.created_by
       where a.id = $2 and a.org_id = $1 and a.provider = 'native'`,
      [actor.orgId, id],
    );
    const r = rows[0];
    if (!r) throw new AppError("not_found", "Appointment not found.");
    const history = await db.query<{ id: string; kind: string; summary: string; occurred_at: Date; actor_kind: string; actor_name: string | null }>(
      `select ca.id::text, ca.kind, ca.summary, ca.occurred_at, ca.actor_kind, coalesce(nullif(u.full_name, ''), u.email::text) as actor_name
       from crm_activities ca left join users u on u.id = ca.actor_user_id
       where ca.org_id = $1 and ca.ref_type = 'appointment' and ca.ref_id = $2 order by ca.occurred_at, ca.id limit 100`,
      [actor.orgId, id],
    );
    const raw = r.answers ?? {};
    const questions = r.questions ?? [];
    const answers = [
      ...questions.filter((q) => raw[q.key]).map((q) => ({ key: q.key, label: q.label, value: String(raw[q.key]) })),
      ...Object.keys(raw).filter((k) => !questions.some((q) => q.key === k) && raw[k]).map((k) => ({ key: k, label: k.replace(/_/g, " "), value: String(raw[k]) })),
    ];
    const who = (kind: string, name: string | null) =>
      kind === "user" ? name ?? "A teammate" : kind === "agency" ? "iAcquire support" : kind === "agent" ? "AI employee" : kind === "api" ? "API" : kind === "contact" ? "The customer" : null;
    return {
      ...toItem(r),
      description: r.description,
      answers,
      cancelReason: r.cancel_reason,
      cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
      inviteeTimezone: r.invitee_timezone,
      timezone: r.timezone,
      previousStartAt: r.previous_start_at ? new Date(r.previous_start_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
      createdBy: r.created_by_name,
      assignment: r.assignment,
      history: history.rows.map((h) => ({ id: h.id, kind: h.kind, summary: h.summary, at: new Date(h.occurred_at).toISOString(), actor: who(h.actor_kind, h.actor_name) })),
    };
  });
}

export interface ScheduleFilterType {
  id: string;
  name: string;
  color: string | null;
  durationMinutes: number;
  capacity: number;
  requiresConfirmation: boolean;
  locationKind: LocationKind;
  questions: BookingQuestion[];
}

export interface ScheduleFilters {
  orgTimezone: string;
  /**
   * Every live calendar, so staff can filter by any of them. A draft (`draft: true`) lists no types: it takes no bookings until it is
   * verified and activated, so the booking dialog never offers it.
   */
  calendars: Array<{ id: string; name: string; color: string | null; assignment: Assignment; isDefault: boolean; hostIds: string[]; types: ScheduleFilterType[]; draft?: boolean }>;
  hosts: Array<{ id: string; name: string }>;
}

/** What the calendar's filters and the staff booking dialog offer: live calendars with their types and active hosts (drafts without types). */
export async function listScheduleFilters(actor: CrmActor): Promise<ScheduleFilters> {
  assertCan(actor, "appointments.view");
  return crmRead(actor, async (db) => {
    const cals = await loadCalendars(db, actor.orgId);
    const org = await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [actor.orgId]);
    const hosts = new Map<string, string>();
    for (const c of cals) for (const m of c.members) if (m.active) hosts.set(m.userId, m.name);
    return {
      orgTimezone: org.rows[0]?.timezone ?? actor.timezone ?? "UTC",
      calendars: cals.map((c) => ({
        id: c.id, name: c.name, color: c.color, assignment: c.assignment, isDefault: c.isDefault, hostIds: c.members.filter((m) => m.active).map((m) => m.userId),
        ...(c.status === "draft" ? { draft: true } : {}),
        types: c.status === "draft" ? [] : c.types.map((t) => ({ id: t.id, name: t.name, color: t.color, durationMinutes: t.durationMinutes, capacity: t.capacity, requiresConfirmation: t.requiresConfirmation, locationKind: t.locationKind, questions: t.questions })),
      })),
      hosts: [...hosts].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

export interface HostOverlay {
  userId: string;
  name: string;
  timezone: string;
  accepting: boolean;
  /** When the person takes bookings in the window (their weekly hours with exceptions applied). */
  working: Array<{ start: string; end: string }>;
  /** Busy times from calendars they connected. Times only: no titles, attendees or descriptions are stored or returned. */
  busy: Array<{ start: string; end: string }>;
}

/**
 * Working hours and anonymous busy bands for a few people, to shade the week and day views. Read as trusted code after the permission
 * check, scoped to the actor's workspace by every query: a connection's status is visible under row-level security only to its owner and
 * calendar managers, and the bands must match what booking actually treats as busy.
 */
export async function getScheduleOverlay(actor: CrmActor, q: { from: Date; to: Date; hostIds: string[] }): Promise<HostOverlay[]> {
  assertCan(actor, "appointments.view");
  checkWindow(q.from, q.to, MAX_SCHEDULE_DAYS);
  const ids = checkIds(q.hostIds.slice(0, 20), "a person");
  if (!ids) return [];
  return withSystem(async (db) => {
    const people = await db.query<{ user_id: string; name: string; timezone: string | null; accepting: boolean | null }>(
      `select m.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as name, h.timezone, h.accepting
       from organization_memberships m join users u on u.id = m.user_id left join crm_host_settings h on h.org_id = m.org_id and h.user_id = m.user_id
       where m.org_id = $1 and m.user_id = any($2::uuid[]) and m.status = 'active'`,
      [actor.orgId, ids],
    );
    if (!people.rows.length) return [];
    const found = people.rows.map((p) => p.user_id);
    const org = await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [actor.orgId]);
    const orgTz = org.rows[0]?.timezone ?? "UTC";
    const rules = await db.query<{ user_id: string; weekday: number; start_minute: number; end_minute: number }>(
      "select user_id, weekday, start_minute, end_minute from crm_availability_rules where org_id = $1 and user_id = any($2::uuid[])",
      [actor.orgId, found],
    );
    const overrides = await db.query<{ user_id: string | null; on_date: string; start_minute: number | null; end_minute: number | null }>(
      `select user_id, on_date::text, start_minute, end_minute from crm_availability_overrides
       where org_id = $1 and (user_id is null or user_id = any($2::uuid[])) and on_date between $3::date and $4::date`,
      [actor.orgId, found, addDays(zonedDate(q.from.getTime(), "UTC"), -2), addDays(zonedDate(q.to.getTime(), "UTC"), 2)],
    );
    const busy = await db.query<{ user_id: string; starts_at: Date; ends_at: Date }>(
      `select e.user_id, e.starts_at, e.ends_at from crm_external_busy e join crm_calendar_connections c on c.id = e.connection_id and c.org_id = e.org_id
       where e.org_id = $1 and e.user_id = any($2::uuid[]) and c.status = 'connected' and c.check_conflicts and e.ends_at > $3 and e.starts_at < $4
       order by e.starts_at limit 5000`,
      [actor.orgId, found, q.from, q.to],
    );
    return people.rows.map((p) => {
      const tz = p.timezone ?? orgTz;
      const own = overrides.rows.filter((o) => o.user_id === p.user_id);
      const ownDates = new Set(own.map((o) => o.on_date));
      // As in booking: a person's own exception for a day replaces the workspace-wide one for that day.
      const days: DayOverride[] = [...own, ...overrides.rows.filter((o) => o.user_id === null && !ownDates.has(o.on_date))].map((o) => ({ date: o.on_date, startMinute: o.start_minute, endMinute: o.end_minute }));
      const accepting = p.accepting ?? true;
      const working = accepting
        ? workingIntervals({
            from: q.from.getTime(), to: q.to.getTime(), timeZone: tz, overrides: days,
            rules: rules.rows.filter((r) => r.user_id === p.user_id).map((r) => ({ weekday: r.weekday, startMinute: r.start_minute, endMinute: r.end_minute })),
          })
        : [];
      const bands = mergeIntervals(busy.rows.filter((b) => b.user_id === p.user_id).map((b) => ({ start: Math.max(new Date(b.starts_at).getTime(), q.from.getTime()), end: Math.min(new Date(b.ends_at).getTime(), q.to.getTime()) })));
      const iso = (i: { start: number; end: number }) => ({ start: new Date(i.start).toISOString(), end: new Date(i.end).toISOString() });
      return { userId: p.user_id, name: p.name, timezone: tz, accepting, working: working.map(iso), busy: bands.map(iso) };
    });
  });
}

export interface StaffSlot extends BookableSlot {
  /** For a reschedule: whether the current host (every host, for a collective) stays on it. */
  keepsHost?: boolean;
}

/**
 * Free times a person booking for a customer can choose. Staff may book inside the notice period, as bookNativeAppointment allows. Computed as
 * trusted code after the permission check (every query names the workspace) so every host's connected-calendar busy time counts, exactly as
 * it does when the booking is made.
 */
export async function listBookableSlots(actor: CrmActor, q: { typeId: string; from: Date; to: Date; hostId?: string | null; now?: Date }): Promise<StaffSlot[]> {
  assertCan(actor, "appointments.book");
  checkWindow(q.from, q.to, MAX_SLOT_DAYS);
  if (!UUID.test(q.typeId)) throw new AppError("not_found", "That appointment type isn't available.");
  if (q.hostId && !UUID.test(q.hostId)) throw new AppError("invalid_input", "Choose a person from the list.");
  return withSystem(async (db) => {
    await assertNativeOwner(db, actor.orgId, "appointments");
    const ctx = await loadBookingContext(db, actor.orgId, q.typeId);
    const slots = await computeSlots(db, ctx, { from: q.from, to: q.to, now: q.now, ignoreNotice: true });
    // Choosing a person only narrows a round robin; single calendars have one host and collective ones need everyone.
    if (q.hostId && ctx.calendar.assignment === "round_robin") {
      const host = q.hostId;
      return slots.filter((s) => s.hostIds.includes(host)).map((s) => ({ ...s, hostIds: [host] }));
    }
    return slots;
  });
}

/** Free times an upcoming appointment can move to. Its own time counts as free; a round robin may hand it to another free host. */
export async function listRescheduleSlots(actor: CrmActor, appointmentId: string, q: { from: Date; to: Date; now?: Date }): Promise<StaffSlot[]> {
  assertCan(actor, "appointments.manage");
  checkWindow(q.from, q.to, MAX_SLOT_DAYS);
  if (!UUID.test(appointmentId)) throw new AppError("not_found", "Appointment not found.");
  return withSystem(async (db) => {
    await assertNativeOwner(db, actor.orgId, "appointments");
    const appt = await db.query<{ status: string; appointment_type_id: string | null }>(
      "select status, appointment_type_id from appointment_refs where id = $1 and org_id = $2 and provider = 'native'",
      [appointmentId, actor.orgId],
    );
    const a = appt.rows[0];
    if (!a || !a.appointment_type_id) throw new AppError("not_found", "Appointment not found.");
    if (!["new", "confirmed"].includes(a.status)) throw new AppError("conflict", "Only an upcoming appointment can be moved.");
    const hosts = (await db.query<{ user_id: string }>("select user_id from crm_appointment_hosts where appointment_id = $1", [appointmentId])).rows.map((h) => h.user_id);
    const ctx = await loadBookingContext(db, actor.orgId, a.appointment_type_id);
    const slots = await computeSlots(db, ctx, { from: q.from, to: q.to, now: q.now, ignoreNotice: true, excludeAppointmentId: appointmentId });
    const marked = slots.map((s) => ({ ...s, keepsHost: hosts.length > 0 && hosts.every((h) => s.hostIds.includes(h)) }));
    // Only a round robin can change hands; anything else moves only to times its own host is free.
    return ctx.calendar.assignment === "round_robin" ? marked : marked.filter((s) => s.keepsHost);
  });
}

// ---------------------------------------------------------------------------
// Where appointments live for a workspace
// ---------------------------------------------------------------------------

/** The native calendar's path when iAcquire owns appointments for this mode and owner; null when GoHighLevel does (its view stays). */
export function appointmentsHomeFor(mode: CrmMode | null | undefined, appointmentsProvider: CapabilityProvider | null | undefined): "/crm/calendar" | null {
  if (!mode) return null;
  const owner = resolveCapabilities(mode, appointmentsProvider ? [{ capability: "appointments", provider: appointmentsProvider }] : []).appointments;
  return owner === "native" ? "/crm/calendar" : null;
}

/**
 * Whether iAcquire's own calendar owns appointments for a workspace. Works on any connection: under row-level security it needs crm.view
 * (without it the workspace row is invisible and the answer is false, the GoHighLevel-era behaviour).
 */
export async function appointmentsAreNative(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ mode: CrmMode; provider: CapabilityProvider | null }>(
    `select w.mode, p.provider from crm_workspaces w left join crm_capability_providers p on p.org_id = w.org_id and p.capability = 'appointments' where w.org_id = $1`,
    [orgId],
  );
  return appointmentsHomeFor(rows[0]?.mode, rows[0]?.provider) !== null;
}

/** Where /appointments should send a client workspace: the native calendar, or null to keep the GoHighLevel view. */
export async function nativeAppointmentsHome(orgId: string): Promise<"/crm/calendar" | null> {
  return (await withSystem((db) => appointmentsAreNative(db, orgId))) ? "/crm/calendar" : null;
}
