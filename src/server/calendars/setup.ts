import "server-only";
import { type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { isValidTimeZone } from "@/lib/calendars/slots";

export type Assignment = "single" | "round_robin" | "collective";
export type LocationKind = "phone" | "video" | "in_person" | "custom" | "none";
export type MeetingProvider = "none" | "google_meet" | "microsoft_teams" | "custom_link";

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
  members: Array<{ userId: string; name: string; priority: number; active: boolean }>;
  types: AppointmentTypeView[];
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
};

export const toTypeView = (r: TypeRow): AppointmentTypeView => ({
  id: r.id, calendarId: r.calendar_id, name: r.name, slug: r.slug, description: r.description, durationMinutes: r.duration_minutes, slotIntervalMinutes: r.slot_interval_minutes,
  bufferBeforeMinutes: r.buffer_before_minutes, bufferAfterMinutes: r.buffer_after_minutes, minNoticeMinutes: r.min_notice_minutes, maxDaysAhead: r.max_days_ahead, dailyLimit: r.daily_limit,
  capacity: r.capacity, locationKind: r.location_kind, locationDetail: r.location_detail, meetingProvider: r.meeting_provider, meetingLink: r.meeting_link, requiresConfirmation: r.requires_confirmation,
  public: r.public, questions: r.questions ?? [], color: r.color, position: r.position,
});

export const TYPE_COLUMNS = `t.id, t.calendar_id, t.name, t.slug, t.description, t.duration_minutes, t.slot_interval_minutes, t.buffer_before_minutes, t.buffer_after_minutes, t.min_notice_minutes,
  t.max_days_ahead, t.daily_limit, t.capacity, t.location_kind, t.location_detail, t.meeting_provider, t.meeting_link, t.requires_confirmation, t.public, t.questions, t.color, t.position`;

export async function loadCalendars(db: Queryable, orgId: string, opts: { includeArchived?: boolean } = {}): Promise<CalendarView[]> {
  const cals = await db.query<{ id: string; name: string; slug: string; description: string | null; assignment: Assignment; round_robin_mode: "balanced" | "priority"; color: string | null; is_default: boolean; public: boolean }>(
    `select id, name, slug, description, assignment, round_robin_mode, color, is_default, public from crm_calendars where org_id = $1 ${opts.includeArchived ? "" : "and archived_at is null"} order by is_default desc, lower(name)`,
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
    members: members.rows.filter((m) => m.calendar_id === c.id).map((m) => ({ userId: m.user_id, name: m.name, priority: m.priority, active: m.active })),
    types: types.rows.filter((t) => t.calendar_id === c.id).map(toTypeView),
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
}

function checkCalendar(input: Partial<CalendarInput>) {
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 80)) throw new AppError("invalid_input", "Calendar names are 1 to 80 characters.");
  if (input.assignment && !["single", "round_robin", "collective"].includes(input.assignment)) throw new AppError("invalid_input", "Choose how bookings are assigned.");
  if (input.color && !COLOR.test(input.color)) throw new AppError("invalid_input", "Choose a colour.");
  if (input.members && input.assignment === "single" && input.members.length > 1) throw new AppError("invalid_input", "A one-person calendar has exactly one host. Use round robin or collective for a team.");
}

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
      `insert into crm_calendars (org_id, name, slug, description, assignment, round_robin_mode, color, public, is_default, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [actor.orgId, input.name.trim(), slug, input.description?.trim().slice(0, 500) || null, input.assignment ?? (members.length > 1 ? "round_robin" : "single"), input.roundRobinMode ?? "balanced",
        input.color ?? null, input.public ?? false, makeDefault, actor.userId],
    );
    for (const m of members) await db.query("insert into crm_calendar_members (org_id, calendar_id, user_id, priority) values ($1, $2, $3, $4)", [actor.orgId, rows[0].id, m.userId, m.priority ?? 50]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.calendar_created", targetType: "crm_calendar", targetId: rows[0].id, result: "success" }, db);
    return { id: rows[0].id };
  });
}

export async function updateCalendar(actor: CrmActor, id: string, input: Partial<CalendarInput>): Promise<void> {
  assertCan(actor, "calendars.manage");
  checkCalendar(input);
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const cur = await db.query<{ assignment: Assignment }>("select assignment from crm_calendars where id = $1 and org_id = $2 and archived_at is null for update", [id, actor.orgId]);
    if (!cur.rows[0]) throw new AppError("not_found", "Calendar not found.");
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
    if (input.isDefault) await db.query("update crm_calendars set is_default = false where org_id = $1 and is_default and id <> $2", [actor.orgId, id]);
    await db.query(
      `update crm_calendars set name = coalesce($3, name), description = case when $4::boolean then $5 else description end, assignment = $6,
         round_robin_mode = coalesce($7, round_robin_mode), color = case when $8::boolean then $9 else color end, public = coalesce($10, public), is_default = coalesce($11, is_default)
       where id = $1 and org_id = $2`,
      [id, actor.orgId, input.name?.trim() ?? null, input.description !== undefined, input.description?.trim().slice(0, 500) || null, assignment, input.roundRobinMode ?? null,
        input.color !== undefined, input.color ?? null, input.public ?? null, input.isDefault ? true : null],
    );
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
      "update crm_calendars set is_default = true where id = (select id from crm_calendars where org_id = $1 and archived_at is null order by created_at limit 1) and not exists (select 1 from crm_calendars where org_id = $1 and is_default and archived_at is null)",
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
    }
  }
}

export async function createAppointmentType(actor: CrmActor, calendarId: string, input: AppointmentTypeInput): Promise<{ id: string }> {
  assertCan(actor, "calendars.manage");
  checkType(input);
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const cal = await db.query("select 1 from crm_calendars where id = $1 and org_id = $2 and archived_at is null", [calendarId, actor.orgId]);
    if (!cal.rows.length) throw new AppError("not_found", "Calendar not found.");
    const slug = await uniqueSlug(db, slugify(input.name), async (s) => (await db.query("select 1 from crm_appointment_types where calendar_id = $1 and slug = $2 and archived_at is null", [calendarId, s])).rows.length > 0);
    const pos = await db.query<{ n: number }>("select coalesce(max(position), 0) + 1 as n from crm_appointment_types where calendar_id = $1", [calendarId]);
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_appointment_types (org_id, calendar_id, name, slug, description, duration_minutes, slot_interval_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_minutes,
         max_days_ahead, daily_limit, capacity, location_kind, location_detail, meeting_provider, meeting_link, requires_confirmation, public, questions, color, position)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) returning id`,
      [actor.orgId, calendarId, input.name.trim(), slug, input.description?.trim().slice(0, 1000) || null, input.durationMinutes, input.slotIntervalMinutes ?? null, input.bufferBeforeMinutes ?? 0,
        input.bufferAfterMinutes ?? 0, input.minNoticeMinutes ?? 120, input.maxDaysAhead ?? 60, input.dailyLimit ?? null, input.capacity ?? 1, input.locationKind ?? "phone",
        input.locationDetail?.trim().slice(0, 300) || null, input.meetingProvider ?? "none", input.meetingLink ?? null, input.requiresConfirmation ?? false, input.public ?? true,
        JSON.stringify(input.questions ?? []), input.color ?? null, pos.rows[0].n],
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
      confirm: input.requiresConfirmation ?? t.requires_confirmation, isPublic: input.public ?? t.public, questions: input.questions ?? t.questions, color: v("color") ? input.color ?? null : t.color,
    };
    if (merged.provider === "custom_link" && !merged.link) throw new AppError("invalid_input", "Add the meeting link.");
    await db.query(
      `update crm_appointment_types set name = $3, description = $4, duration_minutes = $5, slot_interval_minutes = $6, buffer_before_minutes = $7, buffer_after_minutes = $8,
         min_notice_minutes = $9, max_days_ahead = $10, daily_limit = $11, capacity = $12, location_kind = $13, location_detail = $14, meeting_provider = $15, meeting_link = $16,
         requires_confirmation = $17, public = $18, questions = $19, color = $20 where id = $1 and org_id = $2`,
      [id, actor.orgId, merged.name, merged.description, merged.duration, merged.interval, merged.before, merged.after, merged.notice, merged.ahead, merged.limit, merged.capacity,
        merged.locationKind, merged.locationDetail, merged.provider, merged.link, merged.confirm, merged.isPublic, JSON.stringify(merged.questions), merged.color],
    );
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
    const { rows } = await db.query<{ user_id: string | null }>("select user_id from crm_availability_overrides where id = $1 and org_id = $2", [id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "That exception doesn't exist.");
    if (rows[0].user_id !== actor.userId) assertCan(actor, "calendars.manage", "Removing someone else's exception needs calendar management.");
    await db.query("delete from crm_availability_overrides where id = $1 and org_id = $2", [id, actor.orgId]);
  });
}
