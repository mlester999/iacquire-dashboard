import "server-only";
import { type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { isValidTimeZone, type WeeklyRule } from "@/lib/calendars/slots";

export type Assignment = "single" | "round_robin" | "collective";
export type LocationKind = "phone" | "video" | "in_person" | "custom" | "none";
export type MeetingProvider = "none" | "google_meet" | "microsoft_teams" | "custom_link";
/** draft: created from a Blueprint and not verified yet, so it takes no bookings. active: everything else. */
export type CalendarStatus = "draft" | "active";

export interface BookingQuestion {
  key: string;
  label: string;
  type: "text" | "textarea" | "select";
  required: boolean;
  options?: string[];
}

export interface AppointmentTypeView {
  id: string;
  calendarId: string;
  name: string;
  slug: string;
  description: string | null;
  durationMinutes: number;
  slotIntervalMinutes: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  dailyLimit: number | null;
  capacity: number;
  locationKind: LocationKind;
  locationDetail: string | null;
  meetingProvider: MeetingProvider;
  meetingLink: string | null;
  requiresConfirmation: boolean;
  public: boolean;
  questions: BookingQuestion[];
  color: string | null;
  position: number;
  /** Shown to the customer once they've booked (and in the confirmation the booking page sends). */
  confirmationMessage: string | null;
  /** Whether the customer's own link may reschedule or cancel, until `changeCutoffMinutes` before the start. */
  allowCustomerChanges: boolean;
  changeCutoffMinutes: number;
  /** Which contact details the booking form insists on. At least one is always required. */
  requireEmail: boolean;
  requirePhone: boolean;
}

export interface CalendarView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  assignment: Assignment;
  roundRobinMode: "balanced" | "priority";
  color: string | null;
  isDefault: boolean;
  public: boolean;
  /** A short welcome shown above the appointment types on the public booking page. */
  bookingIntro: string | null;
  members: Array<{ userId: string; name: string; priority: number; active: boolean }>;
  types: AppointmentTypeView[];
  /** A draft takes no bookings until it is verified and activated (src/server/calendars/activation.ts). */
  status: CalendarStatus;
  verifiedAt: string | null;
  /** Where it came from: made here, or created by applying a Blueprint or importing from GoHighLevel. */
  origin: "manual" | "blueprint" | "ghl_import";
  /** The time zone and weekly hours a Blueprint suggests for hosts who have none yet. Empty when there is no suggestion. */
  suggestedTimezone: string | null;
  hoursTemplate: WeeklyRule[];
}

/**
 * Reads a calendar's suggested weekly hours, keeping only well-formed ranges (Sunday = 0, minutes within the day, start before end). The
 * stored shape is the one weekly hours use everywhere ({ weekday, startMinute, endMinute }); { start, end } is accepted as well.
 */
export function parseHoursTemplate(raw: unknown): WeeklyRule[] {
  if (!Array.isArray(raw)) return [];
  const out: WeeklyRule[] = [];
  for (const r of raw.slice(0, 50)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const weekday = o.weekday;
    const startMinute = o.startMinute ?? o.start;
    const endMinute = o.endMinute ?? o.end;
    if (![weekday, startMinute, endMinute].every((v) => typeof v === "number" && Number.isInteger(v))) continue;
    const [w, a, b] = [weekday, startMinute, endMinute] as number[];
    if (w < 0 || w > 6 || a < 0 || a > 1439 || b < 1 || b > 1440 || b <= a) continue;
    out.push({ weekday: w, startMinute: a, endMinute: b });
  }
  out.sort((x, y) => x.weekday - y.weekday || x.startMinute - y.startMinute);
  // Overlapping ranges on one day can't be saved as weekly hours, so a template that has them is dropped from that day on.
  return out.filter((r, i) => !out.slice(0, i).some((p) => p.weekday === r.weekday && p.endMinute > r.startMinute));
}

const COLOR = /^#[0-9a-f]{6}$/;

export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || "calendar";
}

async function uniqueSlug(db: Queryable, base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  void db;
  let slug = base;
  for (let i = 2; await taken(slug); i++) slug = `${base.slice(0, 44)}-${i}`;
  return slug;
}

type TypeRow = {
  id: string; calendar_id: string; name: string; slug: string; description: string | null; duration_minutes: number; slot_interval_minutes: number | null; buffer_before_minutes: number;
  buffer_after_minutes: number; min_notice_minutes: number; max_days_ahead: number; daily_limit: number | null; capacity: number; location_kind: LocationKind; location_detail: string | null;
  meeting_provider: MeetingProvider; meeting_link: string | null; requires_confirmation: boolean; public: boolean; questions: BookingQuestion[]; color: string | null; position: number;
  confirmation_message: string | null; allow_customer_changes: boolean; change_cutoff_minutes: number; require_email: boolean; require_phone: boolean;
};

export const toTypeView = (r: TypeRow): AppointmentTypeView => ({
  id: r.id, calendarId: r.calendar_id, name: r.name, slug: r.slug, description: r.description, durationMinutes: r.duration_minutes, slotIntervalMinutes: r.slot_interval_minutes,
  bufferBeforeMinutes: r.buffer_before_minutes, bufferAfterMinutes: r.buffer_after_minutes, minNoticeMinutes: r.min_notice_minutes, maxDaysAhead: r.max_days_ahead, dailyLimit: r.daily_limit,
  capacity: r.capacity, locationKind: r.location_kind, locationDetail: r.location_detail, meetingProvider: r.meeting_provider, meetingLink: r.meeting_link, requiresConfirmation: r.requires_confirmation,
  public: r.public, questions: r.questions ?? [], color: r.color, position: r.position,
  confirmationMessage: r.confirmation_message ?? null, allowCustomerChanges: r.allow_customer_changes ?? true, changeCutoffMinutes: r.change_cutoff_minutes ?? 0,
  requireEmail: r.require_email ?? true, requirePhone: r.require_phone ?? false,
});

export const TYPE_COLUMNS = `t.id, t.calendar_id, t.name, t.slug, t.description, t.duration_minutes, t.slot_interval_minutes, t.buffer_before_minutes, t.buffer_after_minutes, t.min_notice_minutes,
  t.max_days_ahead, t.daily_limit, t.capacity, t.location_kind, t.location_detail, t.meeting_provider, t.meeting_link, t.requires_confirmation, t.public, t.questions, t.color, t.position,
  t.confirmation_message, t.allow_customer_changes, t.change_cutoff_minutes, t.require_email, t.require_phone`;

export async function loadCalendars(db: Queryable, orgId: string, opts: { includeArchived?: boolean } = {}): Promise<CalendarView[]> {
  const cals = await db.query<{
    id: string; name: string; slug: string; description: string | null; assignment: Assignment; round_robin_mode: "balanced" | "priority"; color: string | null; is_default: boolean; public: boolean;
    booking_intro: string | null; status: CalendarStatus; verified_at: Date | null; origin: CalendarView["origin"]; timezone: string | null; hours_template: unknown;
  }>(
    `select id, name, slug, description, assignment, round_robin_mode, color, is_default, public, booking_intro, status, verified_at, origin, timezone, hours_template
     from crm_calendars where org_id = $1 ${opts.includeArchived ? "" : "and archived_at is null"} order by is_default desc, lower(name)`,
    [orgId],
  );
  if (!cals.rows.length) return [];
  const ids = cals.rows.map((c) => c.id);
  const members = await db.query<{ calendar_id: string; user_id: string; name: string; priority: number; active: boolean }>(
    `select m.calendar_id, m.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as name, m.priority, m.active from crm_calendar_members m join users u on u.id = m.user_id
     where m.org_id = $1 and m.calendar_id = any($2::uuid[]) order by m.priority desc, lower(u.full_name)`,
    [orgId, ids],
  );
  const types = await db.query<TypeRow>(`select ${TYPE_COLUMNS} from crm_appointment_types t where t.org_id = $1 and t.calendar_id = any($2::uuid[]) and t.archived_at is null order by t.position, lower(t.name)`, [orgId, ids]);
  return cals.rows.map((c) => ({
    id: c.id, name: c.name, slug: c.slug, description: c.description, assignment: c.assignment, roundRobinMode: c.round_robin_mode, color: c.color, isDefault: c.is_default, public: c.public,
    bookingIntro: c.booking_intro,
    members: members.rows.filter((m) => m.calendar_id === c.id).map((m) => ({ userId: m.user_id, name: m.name, priority: m.priority, active: m.active })),
    types: types.rows.filter((t) => t.calendar_id === c.id).map(toTypeView),
    status: c.status, verifiedAt: c.verified_at ? new Date(c.verified_at).toISOString() : null, origin: c.origin,
    suggestedTimezone: c.timezone, hoursTemplate: parseHoursTemplate(c.hours_template),
  }));
}

export async function listCalendars(actor: CrmActor): Promise<CalendarView[]> {
  assertCan(actor, "appointments.view");
  return crmRead(actor, (db) => loadCalendars(db, actor.orgId));
}

async function assertHosts(db: Queryable, orgId: string, userIds: string[]) {
  if (!userIds.length) return;
  const { rows } = await db.query<{ user_id: string }>(
    "select m.user_id from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.user_id = any($2::uuid[]) and m.status = 'active' and u.status = 'active'",
    [orgId, userIds],
  );
  if (rows.length !== new Set(userIds).size) throw new AppError("invalid_input", "Every host must be an active member of this workspace.");
}

export interface CalendarInput {
  name: string;
  description?: string | null;
  assignment?: Assignment;
  roundRobinMode?: "balanced" | "priority";
  color?: string | null;
  public?: boolean;
  members?: Array<{ userId: string; priority?: number }>;
  isDefault?: boolean;
  bookingIntro?: string | null;
  /**
   * With `members`: give each host who has no weekly hours yet the calendar's suggested hours and time zone (from a Blueprint). Hosts who
   * already have hours keep theirs, because a person's hours apply to every calendar they host.
   */
  useHoursTemplate?: boolean;
}

/** Why a draft refuses a booking page or the default spot. Activation (src/server/calendars/activation.ts) is the way out of draft. */
export const DRAFT_HIDDEN_MESSAGE = "This calendar is still a draft. Verify and activate it before turning on its booking page or making it the default.";

/**
 * Copies a calendar's suggested weekly hours and time zone to the given hosts, inside the caller's transaction. Only hosts with no weekly
 * hours at all receive them: anyone who already has hours keeps them untouched (hours belong to the person, across every calendar), and a
 * host whose time zone is already set keeps that too. Returns who received the hours and who kept their own.
 */
export async function applyHoursTemplateInTx(db: Queryable, orgId: string, calendarId: string, userIds: string[]): Promise<{ applied: string[]; kept: string[] }> {
  const ids = [...new Set(userIds)];
  const cal = await db.query<{ timezone: string | null; hours_template: unknown }>("select timezone, hours_template from crm_calendars where id = $1 and org_id = $2 and archived_at is null", [calendarId, orgId]);
  if (!cal.rows[0]) throw new AppError("not_found", "Calendar not found.");
  const rules = parseHoursTemplate(cal.rows[0].hours_template);
  if (!rules.length || !ids.length) return { applied: [], kept: ids };
  await assertHosts(db, orgId, ids);
  const org = await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId]);
  const suggested = cal.rows[0].timezone && isValidTimeZone(cal.rows[0].timezone) ? cal.rows[0].timezone : null;
  const fallback = org.rows[0]?.timezone && isValidTimeZone(org.rows[0].timezone) ? org.rows[0].timezone : "UTC";
  const withHours = await db.query<{ user_id: string }>("select distinct user_id from crm_availability_rules where org_id = $1 and user_id = any($2::uuid[])", [orgId, ids]);
  const has = new Set(withHours.rows.map((r) => r.user_id));
  const applied: string[] = [];
  const kept: string[] = [];
  for (const userId of ids) {
    if (has.has(userId)) {
      kept.push(userId);
      continue;
    }
    // A host who already chose a time zone keeps it; a host with no settings starts in the suggested one (else the workspace's).
    await db.query(
      "insert into crm_host_settings (org_id, user_id, timezone, accepting) values ($1, $2, $3, true) on conflict (org_id, user_id) do nothing",
      [orgId, userId, suggested ?? fallback],
    );
    for (const r of rules) {
      await db.query("insert into crm_availability_rules (org_id, user_id, weekday, start_minute, end_minute) values ($1, $2, $3, $4, $5)", [orgId, userId, r.weekday, r.startMinute, r.endMinute]);
    }
    applied.push(userId);
  }
  return { applied, kept };
}

function checkCalendar(input: Partial<CalendarInput>) {
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 80)) throw new AppError("invalid_input", "Calendar names are 1 to 80 characters.");
  if (input.assignment && !["single", "round_robin", "collective"].includes(input.assignment)) throw new AppError("invalid_input", "Choose how bookings are assigned.");
  if (input.roundRobinMode && !["balanced", "priority"].includes(input.roundRobinMode)) throw new AppError("invalid_input", "Choose how round robin picks the next host.");
  if (input.color && !COLOR.test(input.color)) throw new AppError("invalid_input", "Choose a colour.");
  if (input.members && input.assignment === "single" && input.members.length > 1) throw new AppError("invalid_input", "A one-person calendar has exactly one host. Use round robin or collective for a team.");
  if (input.members && new Set(input.members.map((m) => m.userId)).size !== input.members.length) throw new AppError("invalid_input", "Each host is listed once.");
  if (input.members && input.members.length > 50) throw new AppError("invalid_input", "A calendar has at most 50 hosts.");
  if (input.bookingIntro && input.bookingIntro.trim().length > 500) throw new AppError("invalid_input", "Keep the booking page intro to 500 characters.");
}

/**
 * Why a calendar can't take bookings from its public page yet, or null when it can go public: it needs at least one active host
 * (a current member of the workspace) and at least one appointment type that is shown on the page. Working hours are not required
 * to publish, but the Booking Pages screen points out a page that has none.
 */
async function publishBlocker(db: Queryable, orgId: string, calendarId: string): Promise<string | null> {
  const cal = await db.query<{ status: CalendarStatus }>("select status from crm_calendars where id = $1 and org_id = $2", [calendarId, orgId]);
  if (cal.rows[0]?.status === "draft") return DRAFT_HIDDEN_MESSAGE;
  const hosts = await db.query<{ n: string }>(
    `select count(*)::text as n from crm_calendar_members cm
     join organization_memberships m on m.org_id = cm.org_id and m.user_id = cm.user_id and m.status = 'active'
     join users u on u.id = cm.user_id and u.status = 'active'
     where cm.calendar_id = $1 and cm.org_id = $2 and cm.active`,
    [calendarId, orgId],
  );
  if (Number(hosts.rows[0]?.n ?? 0) === 0) return "Nobody active hosts this calendar, so no one could take a booking. Add a current team member as a host first.";
  const types = await db.query<{ total: string; shown: string }>(
    "select count(*)::text as total, (count(*) filter (where public))::text as shown from crm_appointment_types where calendar_id = $1 and org_id = $2 and archived_at is null",
    [calendarId, orgId],
  );
  if (Number(types.rows[0]?.total ?? 0) === 0) return "This calendar has no appointment types yet, so there's nothing to book. Add one first.";
  if (Number(types.rows[0]?.shown ?? 0) === 0) return "Every appointment type on this calendar is hidden from the booking page. Show at least one first.";
  return null;
}

/**
 * Creates a calendar. `public: true` here only pre-marks the page for setup code that adds the types straight after (the page shows
 * nothing until a type exists); the checked switch people use is setCalendarPublic.
 */
export async function createCalendar(actor: CrmActor, input: CalendarInput): Promise<{ id: string }> {
  assertCan(actor, "calendars.manage");
  checkCalendar(input);
  const members = input.members?.length ? input.members : actor.userId ? [{ userId: actor.userId }] : [];
  if (!members.length) throw new AppError("invalid_input", "Choose who takes these appointments.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    await assertHosts(db, actor.orgId, members.map((m) => m.userId));
    const slug = await uniqueSlug(db, slugify(input.name), async (s) => (await db.query("select 1 from crm_calendars where org_id = $1 and slug = $2 and archived_at is null", [actor.orgId, s])).rows.length > 0);
    const hasDefault = (await db.query("select 1 from crm_calendars where org_id = $1 and is_default and archived_at is null", [actor.orgId])).rows.length > 0;
    const makeDefault = input.isDefault || !hasDefault;
    if (makeDefault && hasDefault) await db.query("update crm_calendars set is_default = false where org_id = $1 and is_default", [actor.orgId]);
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_calendars (org_id, name, slug, description, assignment, round_robin_mode, color, public, is_default, created_by, booking_intro) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [actor.orgId, input.name.trim(), slug, input.description?.trim().slice(0, 500) || null, input.assignment ?? (members.length > 1 ? "round_robin" : "single"), input.roundRobinMode ?? "balanced",
        input.color ?? null, input.public ?? false, makeDefault, actor.userId, input.bookingIntro?.trim() || null],
    );
    for (const m of members) await db.query("insert into crm_calendar_members (org_id, calendar_id, user_id, priority) values ($1, $2, $3, $4)", [actor.orgId, rows[0].id, m.userId, Math.max(0, Math.min(100, m.priority ?? 50))]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.calendar_created", targetType: "crm_calendar", targetId: rows[0].id, result: "success" }, db);
    return { id: rows[0].id };
  });
}

/** Changes a calendar's settings. Turning the booking page on here applies the same check as setCalendarPublic. */
export async function updateCalendar(actor: CrmActor, id: string, input: Partial<CalendarInput>): Promise<{ hoursApplied: string[] }> {
  assertCan(actor, "calendars.manage");
  checkCalendar(input);
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const cur = await db.query<{ assignment: Assignment; public: boolean; status: CalendarStatus }>(
      "select assignment, public, status from crm_calendars where id = $1 and org_id = $2 and archived_at is null for update",
      [id, actor.orgId],
    );
    if (!cur.rows[0]) throw new AppError("not_found", "Calendar not found.");
    if (cur.rows[0].status === "draft" && (input.public === true || input.isDefault)) throw new AppError("conflict", DRAFT_HIDDEN_MESSAGE);
    const assignment = input.assignment ?? cur.rows[0].assignment;
    if (input.members) {
      if (!input.members.length) throw new AppError("invalid_input", "A calendar needs at least one host.");
      if (assignment === "single" && input.members.length > 1) throw new AppError("invalid_input", "A one-person calendar has exactly one host. Use round robin or collective for a team.");
      await assertHosts(db, actor.orgId, input.members.map((m) => m.userId));
      await db.query("delete from crm_calendar_members where calendar_id = $1 and org_id = $2 and not (user_id = any($3::uuid[]))", [id, actor.orgId, input.members.map((m) => m.userId)]);
      for (const m of input.members) {
        await db.query(
          `insert into crm_calendar_members (org_id, calendar_id, user_id, priority) values ($1, $2, $3, $4) on conflict (calendar_id, user_id) do update set priority = excluded.priority, active = true`,
          [actor.orgId, id, m.userId, Math.max(0, Math.min(100, m.priority ?? 50))],
        );
      }
    } else if (assignment === "single") {
      const n = await db.query<{ n: string }>("select count(*)::text as n from crm_calendar_members where calendar_id = $1 and active", [id]);
      if (Number(n.rows[0].n) > 1) throw new AppError("invalid_input", "This calendar has several hosts. Keep one, or choose round robin or collective.");
    }
    if (input.public === true && !cur.rows[0].public) {
      const blocker = await publishBlocker(db, actor.orgId, id);
      if (blocker) throw new AppError("conflict", blocker);
    }
    if (input.isDefault) await db.query("update crm_calendars set is_default = false where org_id = $1 and is_default and id <> $2", [actor.orgId, id]);
    await db.query(
      `update crm_calendars set name = coalesce($3, name), description = case when $4::boolean then $5 else description end, assignment = $6,
         round_robin_mode = coalesce($7, round_robin_mode), color = case when $8::boolean then $9 else color end, public = coalesce($10, public), is_default = coalesce($11, is_default),
         booking_intro = case when $12::boolean then $13 else booking_intro end
       where id = $1 and org_id = $2`,
      [id, actor.orgId, input.name?.trim() ?? null, input.description !== undefined, input.description?.trim().slice(0, 500) || null, assignment, input.roundRobinMode ?? null,
        input.color !== undefined, input.color ?? null, input.public ?? null, input.isDefault ? true : null, input.bookingIntro !== undefined, input.bookingIntro?.trim() || null],
    );
    if (input.public !== undefined && input.public !== cur.rows[0].public) {
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: input.public ? "crm.calendar_published" : "crm.calendar_unpublished", targetType: "crm_calendar", targetId: id, result: "success" }, db);
    }
    const hoursApplied = input.useHoursTemplate && input.members?.length ? (await applyHoursTemplateInTx(db, actor.orgId, id, input.members.map((m) => m.userId))).applied : [];
    if (hoursApplied.length) {
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.calendar_hours_applied", targetType: "crm_calendar", targetId: id, result: "success", metadata: { hosts: hoursApplied.length } }, db);
    }
    return { hoursApplied };
  });
}

/**
 * Turns a calendar's public booking page on or off. Turning it on refuses, with the reason, while the calendar has no active host or
 * no appointment type shown on the page; turning it off always works and takes effect for the next visitor.
 */
export async function setCalendarPublic(actor: CrmActor, id: string, isPublic: boolean): Promise<void> {
  assertCan(actor, "calendars.manage");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const cur = await db.query<{ public: boolean }>("select public from crm_calendars where id = $1 and org_id = $2 and archived_at is null for update", [id, actor.orgId]);
    if (!cur.rows[0]) throw new AppError("not_found", "Calendar not found.");
    if (cur.rows[0].public === isPublic) return;
    if (isPublic) {
      const blocker = await publishBlocker(db, actor.orgId, id);
      if (blocker) throw new AppError("conflict", blocker);
    }
    await db.query("update crm_calendars set public = $3 where id = $1 and org_id = $2", [id, actor.orgId, isPublic]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: isPublic ? "crm.calendar_published" : "crm.calendar_unpublished", targetType: "crm_calendar", targetId: id, result: "success" }, db);
  });
}

/** Archiving stops new bookings. Appointments already booked stay, and so do their reminders. */
export async function archiveCalendar(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "calendars.manage");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const res = await db.query("update crm_calendars set archived_at = now(), is_default = false, public = false where id = $1 and org_id = $2 and archived_at is null", [id, actor.orgId]);
    if (!res.rowCount) throw new AppError("not_found", "Calendar not found.");
    await db.query(
      // A draft can't be the default (it takes no bookings), so the next default is the oldest active calendar.
      "update crm_calendars set is_default = true where id = (select id from crm_calendars where org_id = $1 and archived_at is null and status = 'active' order by created_at limit 1) and not exists (select 1 from crm_calendars where org_id = $1 and is_default and archived_at is null)",
      [actor.orgId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.calendar_archived", targetType: "crm_calendar", targetId: id, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Appointment types
// ---------------------------------------------------------------------------

export interface AppointmentTypeInput {
  name: string;
  description?: string | null;
  durationMinutes: number;
  slotIntervalMinutes?: number | null;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  minNoticeMinutes?: number;
  maxDaysAhead?: number;
  dailyLimit?: number | null;
  capacity?: number;
  locationKind?: LocationKind;
  locationDetail?: string | null;
  meetingProvider?: MeetingProvider;
  meetingLink?: string | null;
  requiresConfirmation?: boolean;
  public?: boolean;
  questions?: BookingQuestion[];
  color?: string | null;
  confirmationMessage?: string | null;
  allowCustomerChanges?: boolean;
  changeCutoffMinutes?: number;
  requireEmail?: boolean;
  requirePhone?: boolean;
}

const between = (v: number | null | undefined, lo: number, hi: number, msg: string) => {
  if (v === null || v === undefined) return;
  if (!Number.isInteger(v) || v < lo || v > hi) throw new AppError("invalid_input", msg);
};

function checkType(input: Partial<AppointmentTypeInput>) {
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 80)) throw new AppError("invalid_input", "Name the appointment type (up to 80 characters).");
  between(input.durationMinutes, 5, 720, "Length is 5 minutes to 12 hours.");
  between(input.slotIntervalMinutes ?? null, 5, 240, "Start times are offered every 5 to 240 minutes.");
  between(input.bufferBeforeMinutes, 0, 240, "Buffers are up to 4 hours.");
  between(input.bufferAfterMinutes, 0, 240, "Buffers are up to 4 hours.");
  between(input.minNoticeMinutes, 0, 43200, "Notice is up to 30 days.");
  between(input.maxDaysAhead, 1, 365, "Bookings open 1 to 365 days ahead.");
  between(input.dailyLimit ?? null, 1, 100, "The daily limit is 1 to 100.");
  between(input.capacity, 1, 500, "Group size is 1 to 500.");
  if (input.locationKind && !["phone", "video", "in_person", "custom", "none"].includes(input.locationKind)) throw new AppError("invalid_input", "Choose where it happens.");
  if (input.meetingProvider && !["none", "google_meet", "microsoft_teams", "custom_link"].includes(input.meetingProvider)) throw new AppError("invalid_input", "Choose a meeting link option.");
  if (input.meetingLink && !/^https:\/\/[^\s]{4,490}$/.test(input.meetingLink)) throw new AppError("invalid_input", "Meeting links must start with https://.");
  if (input.meetingProvider === "custom_link" && !input.meetingLink) throw new AppError("invalid_input", "Add the meeting link.");
  if (input.color && !COLOR.test(input.color)) throw new AppError("invalid_input", "Choose a colour.");
  if (input.questions) {
    if (input.questions.length > 10) throw new AppError("invalid_input", "Ask at most 10 extra questions.");
    const keys = new Set<string>();
    for (const q of input.questions) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(q.key) || keys.has(q.key)) throw new AppError("invalid_input", "Each question needs its own short key.");
      keys.add(q.key);
      if (!q.label?.trim() || q.label.length > 120) throw new AppError("invalid_input", "Each question needs a label of up to 120 characters.");
      if (!["text", "textarea", "select"].includes(q.type)) throw new AppError("invalid_input", "Questions are short text, long text or a choice.");
      if (q.type === "select" && (!q.options?.length || q.options.length > 20)) throw new AppError("invalid_input", "A choice question needs 1 to 20 options.");
      if (q.type === "select" && q.options) {
        const opts = q.options.map((o) => (typeof o === "string" ? o.trim() : ""));
        if (opts.some((o) => !o || o.length > 100)) throw new AppError("invalid_input", "Each choice is 1 to 100 characters.");
        if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) throw new AppError("invalid_input", "Each choice in a question is different.");
      }
    }
  }
  if (input.confirmationMessage && input.confirmationMessage.trim().length > 500) throw new AppError("invalid_input", "Keep the confirmation message to 500 characters.");
  between(input.changeCutoffMinutes, 0, 10080, "Customers can be stopped from changing a booking up to 7 days before it starts.");
  if (input.requireEmail === false && input.requirePhone === false) throw new AppError("invalid_input", "Ask for at least an email address or a phone number, so you can reach the person who booked.");
}

/** Questions as stored: trimmed labels, and options only on choice questions. */
function cleanQuestions(questions: BookingQuestion[]): BookingQuestion[] {
  return questions.map((q) => ({
    key: q.key, label: q.label.trim(), type: q.type, required: q.required === true,
    ...(q.type === "select" ? { options: (q.options ?? []).map((o) => o.trim()) } : {}),
  }));
}

export async function createAppointmentType(actor: CrmActor, calendarId: string, input: AppointmentTypeInput): Promise<{ id: string }> {
  assertCan(actor, "calendars.manage");
  checkType(input);
  if (!(input.requireEmail ?? true) && !(input.requirePhone ?? false)) throw new AppError("invalid_input", "Ask for at least an email address or a phone number, so you can reach the person who booked.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const cal = await db.query("select 1 from crm_calendars where id = $1 and org_id = $2 and archived_at is null", [calendarId, actor.orgId]);
    if (!cal.rows.length) throw new AppError("not_found", "Calendar not found.");
    const slug = await uniqueSlug(db, slugify(input.name), async (s) => (await db.query("select 1 from crm_appointment_types where calendar_id = $1 and slug = $2 and archived_at is null", [calendarId, s])).rows.length > 0);
    const pos = await db.query<{ n: number }>("select coalesce(max(position), 0) + 1 as n from crm_appointment_types where calendar_id = $1", [calendarId]);
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_appointment_types (org_id, calendar_id, name, slug, description, duration_minutes, slot_interval_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_minutes,
         max_days_ahead, daily_limit, capacity, location_kind, location_detail, meeting_provider, meeting_link, requires_confirmation, public, questions, color, position,
         confirmation_message, allow_customer_changes, change_cutoff_minutes, require_email, require_phone)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27) returning id`,
      [actor.orgId, calendarId, input.name.trim(), slug, input.description?.trim().slice(0, 1000) || null, input.durationMinutes, input.slotIntervalMinutes ?? null, input.bufferBeforeMinutes ?? 0,
        input.bufferAfterMinutes ?? 0, input.minNoticeMinutes ?? 120, input.maxDaysAhead ?? 60, input.dailyLimit ?? null, input.capacity ?? 1, input.locationKind ?? "phone",
        input.locationDetail?.trim().slice(0, 300) || null, input.meetingProvider ?? "none", input.meetingLink ?? null, input.requiresConfirmation ?? false, input.public ?? true,
        JSON.stringify(cleanQuestions(input.questions ?? [])), input.color ?? null, pos.rows[0].n,
        input.confirmationMessage?.trim() || null, input.allowCustomerChanges ?? true, input.changeCutoffMinutes ?? 0, input.requireEmail ?? true, input.requirePhone ?? false],
    );
    return { id: rows[0].id };
  });
}

export async function updateAppointmentType(actor: CrmActor, id: string, input: Partial<AppointmentTypeInput>): Promise<void> {
  assertCan(actor, "calendars.manage");
  checkType(input);
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const cur = await db.query<TypeRow>(`select ${TYPE_COLUMNS} from crm_appointment_types t where t.id = $1 and t.org_id = $2 and t.archived_at is null for update`, [id, actor.orgId]);
    const t = cur.rows[0];
    if (!t) throw new AppError("not_found", "Appointment type not found.");
    if (input.capacity !== undefined && input.capacity !== t.capacity && (t.capacity === 1) !== (input.capacity === 1)) {
      const live = await db.query("select 1 from appointment_refs where appointment_type_id = $1 and status in ('new', 'confirmed') and end_at > now() limit 1", [id]);
      if (live.rows.length) throw new AppError("conflict", "Upcoming appointments use this type, so it can't switch between one-to-one and group. Create a new type instead.");
    }
    const v = (k: keyof AppointmentTypeInput) => k in input;
    const merged = {
      name: input.name?.trim() ?? t.name, description: v("description") ? input.description?.trim().slice(0, 1000) || null : t.description,
      duration: input.durationMinutes ?? t.duration_minutes, interval: v("slotIntervalMinutes") ? input.slotIntervalMinutes ?? null : t.slot_interval_minutes,
      before: input.bufferBeforeMinutes ?? t.buffer_before_minutes, after: input.bufferAfterMinutes ?? t.buffer_after_minutes, notice: input.minNoticeMinutes ?? t.min_notice_minutes,
      ahead: input.maxDaysAhead ?? t.max_days_ahead, limit: v("dailyLimit") ? input.dailyLimit ?? null : t.daily_limit, capacity: input.capacity ?? t.capacity,
      locationKind: input.locationKind ?? t.location_kind, locationDetail: v("locationDetail") ? input.locationDetail?.trim().slice(0, 300) || null : t.location_detail,
      provider: input.meetingProvider ?? t.meeting_provider, link: v("meetingLink") ? input.meetingLink ?? null : t.meeting_link,
      confirm: input.requiresConfirmation ?? t.requires_confirmation, isPublic: input.public ?? t.public, questions: input.questions ? cleanQuestions(input.questions) : t.questions, color: v("color") ? input.color ?? null : t.color,
      confirmation: v("confirmationMessage") ? input.confirmationMessage?.trim() || null : t.confirmation_message,
      customerChanges: input.allowCustomerChanges ?? t.allow_customer_changes, cutoff: input.changeCutoffMinutes ?? t.change_cutoff_minutes,
      requireEmail: input.requireEmail ?? t.require_email, requirePhone: input.requirePhone ?? t.require_phone,
    };
    if (merged.provider === "custom_link" && !merged.link) throw new AppError("invalid_input", "Add the meeting link.");
    if (!merged.requireEmail && !merged.requirePhone) throw new AppError("invalid_input", "Ask for at least an email address or a phone number, so you can reach the person who booked.");
    await db.query(
      `update crm_appointment_types set name = $3, description = $4, duration_minutes = $5, slot_interval_minutes = $6, buffer_before_minutes = $7, buffer_after_minutes = $8,
         min_notice_minutes = $9, max_days_ahead = $10, daily_limit = $11, capacity = $12, location_kind = $13, location_detail = $14, meeting_provider = $15, meeting_link = $16,
         requires_confirmation = $17, public = $18, questions = $19, color = $20, confirmation_message = $21, allow_customer_changes = $22, change_cutoff_minutes = $23,
         require_email = $24, require_phone = $25 where id = $1 and org_id = $2`,
      [id, actor.orgId, merged.name, merged.description, merged.duration, merged.interval, merged.before, merged.after, merged.notice, merged.ahead, merged.limit, merged.capacity,
        merged.locationKind, merged.locationDetail, merged.provider, merged.link, merged.confirm, merged.isPublic, JSON.stringify(merged.questions), merged.color,
        merged.confirmation, merged.customerChanges, merged.cutoff, merged.requireEmail, merged.requirePhone],
    );
  });
}

/** Shows or hides one appointment type on its calendar's booking page. Staff and the AI can still book a hidden type. */
export async function setAppointmentTypePublic(actor: CrmActor, id: string, isPublic: boolean): Promise<void> {
  assertCan(actor, "calendars.manage");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const res = await db.query("update crm_appointment_types set public = $3 where id = $1 and org_id = $2 and archived_at is null", [id, actor.orgId, isPublic]);
    if (!res.rowCount) throw new AppError("not_found", "Appointment type not found.");
  });
}

/**
 * Puts a calendar's appointment types in the given order (the booking page lists them this way, and the first one is what a request
 * naming only the calendar books). Every live type of the calendar is listed exactly once.
 */
export async function reorderAppointmentTypes(actor: CrmActor, calendarId: string, ids: string[]): Promise<void> {
  assertCan(actor, "calendars.manage");
  if (new Set(ids).size !== ids.length) throw new AppError("invalid_input", "List each appointment type once.");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const cal = await db.query("select 1 from crm_calendars where id = $1 and org_id = $2 and archived_at is null for update", [calendarId, actor.orgId]);
    if (!cal.rows.length) throw new AppError("not_found", "Calendar not found.");
    const live = await db.query<{ id: string }>("select id from crm_appointment_types where calendar_id = $1 and org_id = $2 and archived_at is null", [calendarId, actor.orgId]);
    if (live.rows.length !== ids.length || !live.rows.every((r) => ids.includes(r.id))) throw new AppError("invalid_input", "The list changed while you were reordering. Reload and try again.");
    for (const [i, typeId] of ids.entries()) await db.query("update crm_appointment_types set position = $3 where id = $1 and org_id = $2", [typeId, actor.orgId, i + 1]);
  });
}

/** Copies an appointment type, settings and questions included, to the end of the same calendar. The copy starts hidden from the booking page. */
export async function duplicateAppointmentType(actor: CrmActor, id: string): Promise<{ id: string }> {
  assertCan(actor, "calendars.manage");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const cur = await db.query<{ calendar_id: string; name: string }>(
      `select t.calendar_id, t.name from crm_appointment_types t join crm_calendars c on c.id = t.calendar_id and c.org_id = t.org_id
       where t.id = $1 and t.org_id = $2 and t.archived_at is null and c.archived_at is null`,
      [id, actor.orgId],
    );
    const t = cur.rows[0];
    if (!t) throw new AppError("not_found", "Appointment type not found.");
    const name = `${t.name.trim().slice(0, 73).trim()} (copy)`;
    const slug = await uniqueSlug(db, slugify(name), async (s) => (await db.query("select 1 from crm_appointment_types where calendar_id = $1 and slug = $2 and archived_at is null", [t.calendar_id, s])).rows.length > 0);
    const pos = await db.query<{ n: number }>("select coalesce(max(position), 0) + 1 as n from crm_appointment_types where calendar_id = $1", [t.calendar_id]);
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_appointment_types (org_id, calendar_id, name, slug, description, duration_minutes, slot_interval_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_minutes,
         max_days_ahead, daily_limit, capacity, location_kind, location_detail, meeting_provider, meeting_link, requires_confirmation, public, questions, color, position,
         confirmation_message, allow_customer_changes, change_cutoff_minutes, require_email, require_phone)
       select org_id, calendar_id, $3, $4, description, duration_minutes, slot_interval_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_minutes,
         max_days_ahead, daily_limit, capacity, location_kind, location_detail, meeting_provider, meeting_link, requires_confirmation, false, questions, color, $5,
         confirmation_message, allow_customer_changes, change_cutoff_minutes, require_email, require_phone
       from crm_appointment_types where id = $1 and org_id = $2 returning id`,
      [id, actor.orgId, name, slug, pos.rows[0].n],
    );
    return { id: rows[0].id };
  });
}

export async function archiveAppointmentType(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "calendars.manage");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const res = await db.query("update crm_appointment_types set archived_at = now() where id = $1 and org_id = $2 and archived_at is null", [id, actor.orgId]);
    if (!res.rowCount) throw new AppError("not_found", "Appointment type not found.");
  });
}

// ---------------------------------------------------------------------------
// Working hours and exceptions
// ---------------------------------------------------------------------------

export interface HostAvailability {
  userId: string;
  name: string;
  timezone: string;
  accepting: boolean;
  rules: Array<{ weekday: number; startMinute: number; endMinute: number }>;
  configured: boolean;
}

export interface AvailabilityOverrideView {
  id: string;
  userId: string | null;
  person: string | null;
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  reason: string | null;
}

export async function listHostAvailability(actor: CrmActor): Promise<{ hosts: HostAvailability[]; overrides: AvailabilityOverrideView[]; orgTimezone: string }> {
  assertCan(actor, "appointments.view");
  return crmRead(actor, async (db) => {
    const people = await db.query<{ user_id: string; name: string; timezone: string | null; accepting: boolean | null }>(
      `select m.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as name, h.timezone, h.accepting from organization_memberships m join users u on u.id = m.user_id
       left join crm_host_settings h on h.org_id = m.org_id and h.user_id = m.user_id
       where m.org_id = $1 and m.status = 'active' and (h.user_id is not null or exists (select 1 from crm_calendar_members cm where cm.org_id = m.org_id and cm.user_id = m.user_id) or m.user_id = $2)
       order by lower(u.full_name)`,
      [actor.orgId, actor.userId],
    );
    const rules = await db.query<{ user_id: string; weekday: number; start_minute: number; end_minute: number }>("select user_id, weekday, start_minute, end_minute from crm_availability_rules where org_id = $1 order by weekday, start_minute", [actor.orgId]);
    const overrides = await db.query<{ id: string; user_id: string | null; person: string | null; on_date: string; start_minute: number | null; end_minute: number | null; reason: string | null }>(
      `select o.id, o.user_id, nullif(u.full_name, '') as person, o.on_date::text, o.start_minute, o.end_minute, o.reason from crm_availability_overrides o left join users u on u.id = o.user_id
       where o.org_id = $1 and o.on_date >= current_date - 1 order by o.on_date limit 200`,
      [actor.orgId],
    );
    const org = await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [actor.orgId]);
    const orgTz = org.rows[0]?.timezone ?? "UTC";
    return {
      orgTimezone: orgTz,
      hosts: people.rows.map((p) => ({
        userId: p.user_id, name: p.name, timezone: p.timezone ?? orgTz, accepting: p.accepting ?? true, configured: p.timezone !== null,
        rules: rules.rows.filter((r) => r.user_id === p.user_id).map((r) => ({ weekday: r.weekday, startMinute: r.start_minute, endMinute: r.end_minute })),
      })),
      overrides: overrides.rows.map((o) => ({ id: o.id, userId: o.user_id, person: o.person, date: o.on_date, startMinute: o.start_minute, endMinute: o.end_minute, reason: o.reason })),
    };
  });
}

/** Sets one person's weekly hours. People set their own; changing someone else's needs calendar management. */
export async function setHostAvailability(actor: CrmActor, userId: string, input: { timezone: string; accepting?: boolean; rules: Array<{ weekday: number; startMinute: number; endMinute: number }> }): Promise<void> {
  assertCan(actor, "appointments.view");
  if (userId !== actor.userId) assertCan(actor, "calendars.manage", "Changing someone else's hours needs calendar management.");
  if (!isValidTimeZone(input.timezone)) throw new AppError("invalid_input", "Choose a valid time zone.");
  if (input.rules.length > 50) throw new AppError("invalid_input", "Too many time ranges.");
  for (const r of input.rules) {
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6 || !Number.isInteger(r.startMinute) || !Number.isInteger(r.endMinute) || r.startMinute < 0 || r.endMinute > 1440 || r.endMinute <= r.startMinute) {
      throw new AppError("invalid_input", "Each range needs a start before its end, within one day.");
    }
  }
  for (let d = 0; d < 7; d++) {
    const day = input.rules.filter((r) => r.weekday === d).sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < day.length; i++) if (day[i].startMinute < day[i - 1].endMinute) throw new AppError("invalid_input", "Time ranges on the same day can't overlap.");
  }
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    await assertHosts(db, actor.orgId, [userId]);
    await db.query(
      `insert into crm_host_settings (org_id, user_id, timezone, accepting) values ($1, $2, $3, $4)
       on conflict (org_id, user_id) do update set timezone = excluded.timezone, accepting = excluded.accepting`,
      [actor.orgId, userId, input.timezone, input.accepting ?? true],
    );
    await db.query("delete from crm_availability_rules where org_id = $1 and user_id = $2", [actor.orgId, userId]);
    for (const r of input.rules) await db.query("insert into crm_availability_rules (org_id, user_id, weekday, start_minute, end_minute) values ($1, $2, $3, $4, $5)", [actor.orgId, userId, r.weekday, r.startMinute, r.endMinute]);
  });
}

export async function addAvailabilityOverride(actor: CrmActor, input: { userId: string | null; date: string; startMinute: number | null; endMinute: number | null; reason?: string | null }): Promise<{ id: string }> {
  assertCan(actor, "appointments.view");
  if (input.userId !== actor.userId) assertCan(actor, "calendars.manage", "Adding time off for someone else, or for everyone, needs calendar management.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) throw new AppError("invalid_input", "Choose a date.");
  if ((input.startMinute === null) !== (input.endMinute === null)) throw new AppError("invalid_input", "Give both a start and an end, or neither for the whole day.");
  if (input.startMinute !== null && input.endMinute !== null && (input.endMinute <= input.startMinute || input.startMinute < 0 || input.endMinute > 1440)) throw new AppError("invalid_input", "The start must be before the end.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    if (input.userId) await assertHosts(db, actor.orgId, [input.userId]);
    const { rows } = await db.query<{ id: string }>(
      "insert into crm_availability_overrides (org_id, user_id, on_date, start_minute, end_minute, reason) values ($1, $2, $3, $4, $5, $6) returning id",
      [actor.orgId, input.userId, input.date, input.startMinute, input.endMinute, input.reason?.trim().slice(0, 120) || null],
    );
    return { id: rows[0].id };
  });
}

export async function deleteAvailabilityOverride(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "appointments.view");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const { rows } = await db.query<{ user_id: string | null }>("select user_id from crm_availability_overrides where id = $1 and org_id = $2", [id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "That exception doesn't exist.");
    if (rows[0].user_id !== actor.userId) assertCan(actor, "calendars.manage", "Removing someone else's exception needs calendar management.");
    await db.query("delete from crm_availability_overrides where id = $1 and org_id = $2", [id, actor.orgId]);
  });
}

const isRealDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** Same rule as single exceptions: your own days are yours to change; someone else's, or a workspace holiday, needs calendar management. */
function assertExceptionOwner(actor: CrmActor, userId: string | null) {
  assertCan(actor, "appointments.view");
  if (userId !== actor.userId) assertCan(actor, "calendars.manage", "Adding time off for someone else, or for everyone, needs calendar management.");
}

/**
 * Sets what one day looks like for a person (or, with `userId: null`, for the whole workspace), replacing any exceptions already on
 * that day: closed all day (`windows: null`), or open only in the given windows, which replace the weekly hours for that date. Time off
 * for part of a day is the hours either side of it. A person's own exception still wins over a workspace holiday on the same date.
 */
export async function setDayException(
  actor: CrmActor,
  input: { userId: string | null; date: string; windows: Array<{ startMinute: number; endMinute: number }> | null; reason?: string | null },
): Promise<{ ids: string[] }> {
  assertExceptionOwner(actor, input.userId);
  if (!isRealDate(input.date)) throw new AppError("invalid_input", "Choose a date.");
  if (input.reason && input.reason.trim().length > 120) throw new AppError("invalid_input", "Keep the reason to 120 characters.");
  const windows = input.windows ? [...input.windows].sort((a, b) => a.startMinute - b.startMinute) : null;
  if (windows) {
    if (!windows.length) throw new AppError("invalid_input", "Add the hours you're available that day, or close the whole day.");
    if (windows.length > 6) throw new AppError("invalid_input", "Use at most 6 time ranges in a day.");
    for (const w of windows) {
      if (!Number.isInteger(w.startMinute) || !Number.isInteger(w.endMinute) || w.startMinute < 0 || w.startMinute > 1439 || w.endMinute > 1440 || w.endMinute <= w.startMinute) {
        throw new AppError("invalid_input", "Each range needs a start before its end, within one day.");
      }
    }
    for (let i = 1; i < windows.length; i++) if (windows[i].startMinute < windows[i - 1].endMinute) throw new AppError("invalid_input", "Time ranges on the same day can't overlap.");
  }
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    if (input.userId) await assertHosts(db, actor.orgId, [input.userId]);
    await db.query(
      "delete from crm_availability_overrides where org_id = $1 and on_date = $2 and (($3::uuid is null and user_id is null) or user_id = $3::uuid)",
      [actor.orgId, input.date, input.userId],
    );
    const reason = input.reason?.trim() || null;
    const ids: string[] = [];
    const rows: Array<{ startMinute: number | null; endMinute: number | null }> = windows ?? [{ startMinute: null, endMinute: null }];
    for (const w of rows) {
      const ins = await db.query<{ id: string }>(
        "insert into crm_availability_overrides (org_id, user_id, on_date, start_minute, end_minute, reason) values ($1, $2, $3, $4, $5, $6) returning id",
        [actor.orgId, input.userId, input.date, w.startMinute, w.endMinute, reason],
      );
      ids.push(ins.rows[0].id);
    }
    return { ids };
  });
}

/** Removes every exception on one day for a person (or the workspace holiday), so the weekly hours apply again. */
export async function clearDayException(actor: CrmActor, input: { userId: string | null; date: string }): Promise<{ removed: number }> {
  assertExceptionOwner(actor, input.userId);
  if (!isRealDate(input.date)) throw new AppError("invalid_input", "Choose a date.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const res = await db.query(
      "delete from crm_availability_overrides where org_id = $1 and on_date = $2 and (($3::uuid is null and user_id is null) or user_id = $3::uuid)",
      [actor.orgId, input.date, input.userId],
    );
    if (!res.rowCount) throw new AppError("not_found", "That exception doesn't exist.");
    return { removed: res.rowCount };
  });
}

// ---------------------------------------------------------------------------
// People and booking pages, for the scheduling settings screens
// ---------------------------------------------------------------------------

/** Everyone who can host: active members of the workspace, whatever their role. */
export async function listSchedulingPeople(actor: CrmActor): Promise<Array<{ id: string; name: string; role: string }>> {
  assertCan(actor, "appointments.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; name: string; role: string }>(
      `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name, m.role from organization_memberships m join users u on u.id = m.user_id
       where m.org_id = $1 and m.status = 'active' and u.status = 'active' order by lower(coalesce(nullif(u.full_name, ''), u.email::text))`,
      [actor.orgId],
    );
    return rows;
  });
}

/**
 * Hosts whose connected calendar can add events, by provider. Google Meet and Microsoft Teams links can only be created through such a
 * connection, so the appointment type editor shows this rather than promising a link. Connections themselves are managed elsewhere.
 */
export async function hostMeetingSupport(actor: CrmActor): Promise<Record<string, { google: boolean; microsoft: boolean }>> {
  assertCan(actor, "calendars.manage");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ user_id: string; provider: "google" | "microsoft" }>(
      `select distinct user_id, provider from crm_calendar_connections
       where org_id = $1 and status = 'connected' and write_events and external_calendar_id is not null and provider in ('google', 'microsoft')`,
      [actor.orgId],
    );
    const out: Record<string, { google: boolean; microsoft: boolean }> = {};
    for (const r of rows) {
      out[r.user_id] ??= { google: false, microsoft: false };
      out[r.user_id][r.provider] = true;
    }
    return out;
  });
}

/** Why a booking page isn't taking bookings. The screens turn these into words and a way to fix each. */
export type BookingPageBlocker =
  | { code: "draft" }
  | { code: "calendar_private" }
  | { code: "no_hosts" }
  | { code: "not_accepting" }
  | { code: "no_hours"; people: Array<{ userId: string; name: string }> }
  | { code: "no_types" }
  | { code: "no_public_types" };

export interface BookingPageView {
  calendarId: string;
  name: string;
  slug: string;
  color: string | null;
  assignment: Assignment;
  public: boolean;
  status: CalendarStatus;
  /** True only when a customer opening the page could actually book something. */
  live: boolean;
  blockers: BookingPageBlocker[];
  hosts: Array<{ userId: string; name: string; accepting: boolean; hasHours: boolean }>;
  types: Array<{ id: string; name: string; slug: string; public: boolean; durationMinutes: number; capacity: number; live: boolean }>;
}

/**
 * Every calendar's public booking page and whether it is live, with the reasons when it isn't: the page is off, nobody active hosts
 * it, every host has paused bookings, the people who would take the booking have no weekly hours, or there is nothing shown to book.
 * Hours are judged the way availability is computed: one-person calendars use their first accepting host, round robin needs any
 * accepting host with hours, and collective needs every accepting host to have hours.
 */
export async function listBookingPages(actor: CrmActor): Promise<{ orgSlug: string; pages: BookingPageView[] }> {
  assertCan(actor, "appointments.view");
  return crmRead(actor, async (db) => {
    const org = await db.query<{ slug: string }>("select slug from organizations where id = $1", [actor.orgId]);
    const cals = await loadCalendars(db, actor.orgId);
    const hosts = await db.query<{ calendar_id: string; user_id: string; name: string; accepting: boolean; has_hours: boolean }>(
      `select cm.calendar_id, cm.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as name, coalesce(h.accepting, true) as accepting,
              exists (select 1 from crm_availability_rules r where r.org_id = cm.org_id and r.user_id = cm.user_id) as has_hours
       from crm_calendar_members cm join organization_memberships m on m.org_id = cm.org_id and m.user_id = cm.user_id and m.status = 'active'
       join users u on u.id = cm.user_id and u.status = 'active'
       left join crm_host_settings h on h.org_id = cm.org_id and h.user_id = cm.user_id
       where cm.org_id = $1 and cm.active order by cm.priority desc, cm.created_at`,
      [actor.orgId],
    );
    const pages = cals.map((c): BookingPageView => {
      const mine = hosts.rows.filter((h) => h.calendar_id === c.id);
      const accepting = mine.filter((h) => h.accepting);
      const blockers: BookingPageBlocker[] = [];
      // A draft can't have a page at all until it is activated; the other reasons still show what verification will check.
      if (c.status === "draft") blockers.push({ code: "draft" });
      else if (!c.public) blockers.push({ code: "calendar_private" });
      if (!mine.length) blockers.push({ code: "no_hosts" });
      else if (!accepting.length) blockers.push({ code: "not_accepting" });
      else {
        // Who must have weekly hours for any time to be offered.
        const needHours = c.assignment === "single" ? accepting.slice(0, 1) : c.assignment === "collective" ? accepting : accepting.some((h) => h.has_hours) ? [] : accepting;
        const missing = needHours.filter((h) => !h.has_hours);
        if (missing.length) blockers.push({ code: "no_hours", people: missing.map((h) => ({ userId: h.user_id, name: h.name })) });
      }
      if (!c.types.length) blockers.push({ code: "no_types" });
      else if (!c.types.some((t) => t.public)) blockers.push({ code: "no_public_types" });
      const live = blockers.length === 0;
      return {
        calendarId: c.id, name: c.name, slug: c.slug, color: c.color, assignment: c.assignment, public: c.public, status: c.status, live, blockers,
        hosts: mine.map((h) => ({ userId: h.user_id, name: h.name, accepting: h.accepting, hasHours: h.has_hours })),
        types: c.types.map((t) => ({ id: t.id, name: t.name, slug: t.slug, public: t.public, durationMinutes: t.durationMinutes, capacity: t.capacity, live: live && t.public })),
      };
    });
    return { orgSlug: org.rows[0]?.slug ?? "", pages };
  });
}
