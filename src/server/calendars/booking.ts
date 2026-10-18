import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyUser } from "@/server/notifications";
import { randomToken, sha256 } from "@/server/security/crypto";
import { assertCan, auditActor, crmWrite, systemActor, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { createContactInTx, type ContactInput } from "@/server/crm/contacts";
import { syncRemindersFor } from "@/server/appointments/reminders";
import { computeSlots, loadBookingContext, orderHosts, type BookingContext } from "@/server/calendars/availability";
import { formatSlot, isLateCancellation } from "@/lib/appointments";
import { isValidTimeZone } from "@/lib/calendars/slots";

export type BookingVia = "booking_page" | "staff" | "agent" | "api" | "website";

export interface NativeBookingInput {
  typeId: string;
  startAt: Date;
  /** An existing contact, or the details a customer typed on a booking page. */
  contact: { id: string } | (ContactInput & { email?: string | null; phone?: string | null });
  answers?: Record<string, string>;
  inviteeTimezone?: string | null;
  notes?: string | null;
  via: BookingVia;
  hostId?: string | null;
  idempotencyKey?: string | null;
  now?: Date;
}

export interface NativeBookingResult {
  appointmentId: string;
  status: "new" | "confirmed";
  hostIds: string[];
  /** The secret for the customer's reschedule/cancel link. Returned once, never stored. */
  manageToken: string | null;
  created: boolean;
  startAt: string;
  endAt: string;
}

const isOverlap = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return e?.code === "23P01" || /crm_busy_blocks_no_overlap|conflicting key value violates exclusion constraint/.test(e?.message ?? "");
};

const TAKEN = "That time was just taken. Choose another time.";

function locationText(ctx: BookingContext): string | null {
  const t = ctx.type;
  switch (t.locationKind) {
    case "phone": return t.locationDetail ? `Phone: ${t.locationDetail}` : "Phone call";
    case "in_person": return t.locationDetail ? `In person: ${t.locationDetail}` : "In person";
    case "video": return t.meetingProvider === "custom_link" ? "Video call" : t.locationDetail ? `Video: ${t.locationDetail}` : "Video call";
    case "custom": return t.locationDetail;
    default: return null;
  }
}

function cleanAnswers(ctx: BookingContext, raw: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of ctx.type.questions) {
    const v = (raw?.[q.key] ?? "").toString().trim().slice(0, q.type === "textarea" ? 2000 : 300);
    if (!v && q.required) throw new AppError("invalid_input", `Please answer: ${q.label}`);
    if (v && q.type === "select" && !q.options?.includes(v)) throw new AppError("invalid_input", `Choose one of the options for: ${q.label}`);
    if (v) out[q.key] = v;
  }
  return out;
}

/** Takes the host's time. Returns false when another booking holds it (the exclusion constraint said no). */
async function holdTime(db: Queryable, ctx: BookingContext, hostId: string, start: number, appointmentId: string): Promise<{ ok: true; blockId: string; shared: boolean } | { ok: false }> {
  const t = ctx.type;
  const blockStart = new Date(start - t.bufferBeforeMinutes * 60_000);
  const blockEnd = new Date(start + (t.durationMinutes + t.bufferAfterMinutes) * 60_000);
  if (t.capacity > 1) {
    const joined = await db.query<{ id: string }>(
      `update crm_busy_blocks set booked = booked + 1 where org_id = $1 and user_id = $2 and appointment_type_id = $3 and starts_at = $4 and released_at is null and booked < capacity returning id`,
      [ctx.orgId, hostId, t.id, blockStart],
    );
    if (joined.rows[0]) return { ok: true, blockId: joined.rows[0].id, shared: true };
  }
  await db.query("savepoint hold_time");
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_busy_blocks (org_id, user_id, appointment_type_id, appointment_id, starts_at, ends_at, capacity, booked) values ($1, $2, $3, $4, $5, $6, $7, 1) returning id`,
      [ctx.orgId, hostId, t.id, t.capacity > 1 ? null : appointmentId, blockStart, blockEnd, t.capacity],
    );
    await db.query("release savepoint hold_time");
    return { ok: true, blockId: rows[0].id, shared: t.capacity > 1 };
  } catch (err) {
    await db.query("rollback to savepoint hold_time");
    if (isOverlap(err)) return { ok: false };
    throw err;
  }
}

/**
 * Gives back the hosts' time for one appointment: its own blocks are released; each group block it joined loses one place and is released
 * when empty. A collective group booking holds one shared block per host, recorded on that host's crm_appointment_hosts row
 * (appointment_refs.busy_block_id names only one of them, and is the only record for bookings made before 0030). Each block is counted
 * once, and the references are cleared so a second release can never give back someone else's place.
 */
async function releaseTime(db: Queryable, orgId: string, appointmentId: string) {
  await db.query("update crm_busy_blocks set released_at = now() where org_id = $1 and appointment_id = $2 and released_at is null", [orgId, appointmentId]);
  const shared = await db.query<{ id: string }>(
    `select busy_block_id as id from crm_appointment_hosts where appointment_id = $1 and org_id = $2 and busy_block_id is not null
     union select busy_block_id from appointment_refs where id = $1 and org_id = $2 and busy_block_id is not null`,
    [appointmentId, orgId],
  );
  const ids = shared.rows.map((r) => r.id);
  if (ids.length) {
    await db.query(
      `update crm_busy_blocks set booked = greatest(booked - 1, 0), released_at = case when booked - 1 <= 0 then now() else released_at end
       where id = any($1::uuid[]) and org_id = $2 and appointment_id is null and released_at is null`,
      [ids, orgId],
    );
  }
  await db.query("update crm_appointment_hosts set busy_block_id = null where appointment_id = $1 and org_id = $2 and busy_block_id is not null", [appointmentId, orgId]);
  await db.query("update appointment_refs set busy_block_id = null where id = $1 and org_id = $2 and busy_block_id is not null", [appointmentId, orgId]);
}

/**
 * Decides bookings in one calendar one at a time. Taken before the booking context (and so every host's last assignment) is read, so
 * round robin ranks hosts with the choice the previous booking just committed. A type that doesn't exist takes no lock; reading its
 * context then reports it.
 */
async function lockCalendarOf(db: Queryable, orgId: string, typeId: string) {
  const { rows } = await db.query<{ calendar_id: string }>("select calendar_id from crm_appointment_types where id = $1 and org_id = $2", [typeId, orgId]);
  if (rows[0]) await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`crm-cal:${rows[0].calendar_id}`]);
}

/** Records who hosts an appointment and, for a group type, which shared block each host's place is in. */
async function saveHosts(db: Queryable, orgId: string, appointmentId: string, held: string[], blocks: Map<string, string>) {
  for (const h of held) {
    await db.query(
      `insert into crm_appointment_hosts (org_id, appointment_id, user_id, busy_block_id) values ($1, $2, $3, $4)
       on conflict (appointment_id, user_id) do update set busy_block_id = excluded.busy_block_id`,
      [orgId, appointmentId, h, blocks.get(h) ?? null],
    );
  }
}

/** What an appointment type lets the people booking it do themselves (0030 booking page options). */
export interface CustomerRules {
  allowCustomerChanges: boolean;
  changeCutoffMinutes: number;
  requireEmail: boolean;
  requirePhone: boolean;
}

export async function loadCustomerRules(db: Queryable, orgId: string, typeId: string): Promise<CustomerRules> {
  const { rows } = await db.query<{ allow_customer_changes: boolean; change_cutoff_minutes: number; require_email: boolean; require_phone: boolean }>(
    "select allow_customer_changes, change_cutoff_minutes, require_email, require_phone from crm_appointment_types where id = $1 and org_id = $2",
    [typeId, orgId],
  );
  const r = rows[0];
  // A type that no longer exists keeps the safest rules: no self-service changes.
  if (!r) return { allowCustomerChanges: false, changeCutoffMinutes: 0, requireEmail: true, requirePhone: false };
  return { allowCustomerChanges: r.allow_customer_changes, changeCutoffMinutes: r.change_cutoff_minutes, requireEmail: r.require_email, requirePhone: r.require_phone };
}

export type CustomerChangeBlock = "not_upcoming" | "started" | "not_allowed" | "past_cutoff";

/** Whether the customer may still move or cancel this appointment themselves, and if not, why. */
export function customerChangeBlock(a: { status: string; startAt: Date }, rules: Pick<CustomerRules, "allowCustomerChanges" | "changeCutoffMinutes">, now: Date): CustomerChangeBlock | null {
  if (!["new", "confirmed"].includes(a.status)) return "not_upcoming";
  const start = a.startAt.getTime();
  if (start <= now.getTime()) return "started";
  if (!rules.allowCustomerChanges) return "not_allowed";
  if (now.getTime() >= start - rules.changeCutoffMinutes * 60_000) return "past_cutoff";
  return null;
}

async function assertCustomerMayChange(db: Queryable, orgId: string, a: ApptRow, now: Date) {
  const rules = await loadCustomerRules(db, orgId, a.appointment_type_id as string);
  const block = customerChangeBlock({ status: a.status, startAt: new Date(a.start_at) }, rules, now);
  if (block === "not_allowed") throw new AppError("forbidden", "This booking can't be changed online. Contact the business to change it.");
  if (block === "past_cutoff") throw new AppError("conflict", "It's too close to the appointment to change it online. Contact the business to change it.");
  if (block === "started") throw new AppError("conflict", "This appointment has already started.");
}

/** The appointment an earlier submit with the same idempotency key made, if any. Its manage link was returned to that submit only. */
async function priorBooking(db: Queryable, orgId: string, key: string | null | undefined): Promise<NativeBookingResult | null> {
  if (!key) return null;
  const prior = await db.query<{ id: string; status: "new" | "confirmed"; start_at: Date; end_at: Date }>(
    "select id, status, start_at, end_at from appointment_refs where org_id = $1 and idempotency_key = $2",
    [orgId, key],
  );
  const p = prior.rows[0];
  if (!p) return null;
  const hosts = await db.query<{ user_id: string }>("select user_id from crm_appointment_hosts where appointment_id = $1", [p.id]);
  return { appointmentId: p.id, status: p.status, hostIds: hosts.rows.map((h) => h.user_id), manageToken: null, created: false, startAt: new Date(p.start_at).toISOString(), endAt: new Date(p.end_at).toISOString() };
}

/**
 * Books a native appointment, transactionally: the time is checked again inside the transaction, the host is chosen (round robin
 * walks the free hosts in order and takes the first whose time it can actually hold), and each host's time is held by a busy block that
 * the database refuses to overlap. Two people booking the last slot at once: one succeeds, the other is told the time was just taken.
 */
export async function bookNativeAppointment(actor: CrmActor, input: NativeBookingInput): Promise<NativeBookingResult> {
  if (input.via === "staff") assertCan(actor, "appointments.book");
  const now = input.now ?? new Date();
  if (input.inviteeTimezone && !isValidTimeZone(input.inviteeTimezone)) throw new AppError("invalid_input", "Choose a valid time zone.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "appointments");
    const earlier = await priorBooking(db, actor.orgId, input.idempotencyKey);
    if (earlier) return earlier;
    await lockCalendarOf(db, actor.orgId, input.typeId);
    const ctx = await loadBookingContext(db, actor.orgId, input.typeId);
    if ((input.via === "booking_page" || input.via === "website") && (!ctx.type.public || !ctx.calendar.public)) throw new AppError("not_found", "That booking page isn't available.");
    // A public form asks for the contact details the type requires; staff, agents and the API book existing or partial contacts as before.
    if ((input.via === "booking_page" || input.via === "website") && !("id" in input.contact)) {
      const rules = await loadCustomerRules(db, actor.orgId, ctx.type.id);
      if (rules.requireEmail && !input.contact.email?.trim()) throw new AppError("invalid_input", "Please enter your email address.");
      if (rules.requirePhone && !input.contact.phone?.trim()) throw new AppError("invalid_input", "Please enter your phone number.");
    }
    // A double submit that waited on the calendar's lock finds the booking the first one made, instead of "that time was just taken".
    const raced = await priorBooking(db, actor.orgId, input.idempotencyKey);
    if (raced) return raced;
    const start = input.startAt.getTime();
    if (Number.isNaN(start)) throw new AppError("invalid_input", "Choose a time.");
    const slots = await computeSlots(db, ctx, { from: new Date(start - 60_000), to: new Date(start + 60_000), now, ignoreNotice: input.via === "staff" });
    const slot = slots.find((s) => new Date(s.start).getTime() === start);
    if (!slot) throw new AppError("conflict", "That time is no longer available. Choose another time.");
    let candidates = ctx.calendar.assignment === "round_robin" ? orderHosts(ctx, slot.hostIds) : slot.hostIds;
    if (input.hostId) {
      if (!slot.hostIds.includes(input.hostId)) throw new AppError("conflict", "That person isn't free at that time.");
      if (ctx.calendar.assignment !== "collective") candidates = [input.hostId];
    }

    // The contact: an existing one, or the person booking (matched by email or phone, never by name).
    let contactId: string;
    if ("id" in input.contact) {
      const c = await db.query<{ id: string }>("select id from contacts where id = $1 and org_id = $2 and deleted_at is null", [input.contact.id, actor.orgId]);
      if (!c.rows[0]) throw new AppError("not_found", "Contact not found.");
      contactId = c.rows[0].id;
    } else {
      const c = input.contact;
      if (!c.firstName?.trim() && !c.displayName?.trim()) throw new AppError("invalid_input", "Please enter your name.");
      if (!c.email?.trim() && !c.phone?.trim()) throw new AppError("invalid_input", "Please enter an email address or a phone number so the business can reach you.");
      contactId = (await createContactInTx(db, actor, { ...c, source: c.source ?? "Booking page" }, { via: "booking", onDuplicate: "return_existing", tagSource: "booking" })).id;
    }
    const contact = await db.query<{ display_name: string; timezone: string | null }>("select display_name, timezone from contacts where id = $1", [contactId]);
    const answers = cleanAnswers(ctx, input.answers);
    const token = randomToken(24);
    const status: "new" | "confirmed" = ctx.type.requiresConfirmation && input.via !== "staff" ? "new" : "confirmed";
    const end = start + ctx.type.durationMinutes * 60_000;
    const inviteeTz = input.inviteeTimezone ?? contact.rows[0]?.timezone ?? ctx.orgTimezone;
    const appt = await db.query<{ id: string }>(
      `insert into appointment_refs (org_id, provider, calendar_ref, appointment_type_id, title, status, start_at, end_at, timezone, invitee_timezone, meeting_link, location, description,
         contact_id, contact_label, assigned_user_id, origin, booked_via, answers, manage_token_hash, created_by, idempotency_key)
       values ($1, 'native', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) returning id`,
      [
        actor.orgId, ctx.calendar.id, ctx.type.id, `${ctx.type.name} with ${contact.rows[0]?.display_name || "a customer"}`.slice(0, 200), status, new Date(start), new Date(end),
        ctx.orgTimezone, inviteeTz, ctx.type.meetingProvider === "custom_link" ? ctx.type.meetingLink : null, locationText(ctx), input.notes?.trim().slice(0, 2000) || null,
        contactId, contact.rows[0]?.display_name ?? null, null,
        input.via === "booking_page" || input.via === "website" ? "booking_page" : input.via === "agent" ? "portal_ai" : input.via === "api" ? "api" : "portal_staff",
        input.via, JSON.stringify(answers), sha256(token), actor.kind === "member" || actor.kind === "agency" ? actor.userId : null, input.idempotencyKey ?? null,
      ],
    );
    const appointmentId = appt.rows[0].id;

    // Hold the time. Round robin tries each free host in turn; collective needs every host. A group type's place is in each host's shared block.
    const held: string[] = [];
    const blocks = new Map<string, string>();
    if (ctx.calendar.assignment === "collective") {
      for (const hostId of candidates) {
        const r = await holdTime(db, ctx, hostId, start, appointmentId);
        if (!r.ok) throw new AppError("conflict", TAKEN);
        held.push(hostId);
        if (r.shared) blocks.set(hostId, r.blockId);
      }
    } else {
      for (const hostId of candidates) {
        const r = await holdTime(db, ctx, hostId, start, appointmentId);
        if (!r.ok) continue;
        held.push(hostId);
        if (r.shared) blocks.set(hostId, r.blockId);
        break;
      }
      if (!held.length) throw new AppError("conflict", TAKEN);
    }
    await db.query("update appointment_refs set assigned_user_id = $3, busy_block_id = $4 where id = $1 and org_id = $2", [appointmentId, actor.orgId, held[0], blocks.get(held[0]) ?? null]);
    await saveHosts(db, actor.orgId, appointmentId, held, blocks);
    await db.query("update crm_calendar_members set last_assigned_at = now() where calendar_id = $1 and user_id = any($2::uuid[])", [ctx.calendar.id, held]);

    const when = formatSlot(new Date(start).toISOString(), ctx.orgTimezone);
    await emitEvent(db, actor, {
      type: "appointment.booked", entityType: "appointment", entityId: appointmentId, contactId,
      payload: { appointmentTypeId: ctx.type.id, calendarId: ctx.calendar.id, startAt: new Date(start).toISOString(), hostIds: held, status, via: input.via },
      dedupeKey: `appointment.booked:${appointmentId}`,
    });
    await recordActivity(db, actor, { kind: "appointment.booked", summary: `Booked ${ctx.type.name} for ${when}`, contactId, refType: "appointment", refId: appointmentId });
    await syncRemindersFor(db, actor.orgId, appointmentId, now);
    for (const h of held) {
      if (h === actor.userId) continue;
      await notifyUser(db, h, actor.orgId, {
        kind: "crm_booking_new", severity: "info", title: status === "new" ? `New booking to confirm: ${ctx.type.name}` : `New booking: ${ctx.type.name}`,
        body: `${contact.rows[0]?.display_name || "A customer"} · ${when}`, link: `/crm/calendar?appointment=${appointmentId}`, dedupeKey: `crm-booking:${appointmentId}:${h}`,
      });
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "appointment.native_booked", targetType: "appointment", targetId: appointmentId, result: "success", metadata: { via: input.via, type: ctx.type.id } }, db);
    return { appointmentId, status, hostIds: held, manageToken: token, created: true, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
  });
}

interface ApptRow {
  id: string;
  org_id: string;
  provider: string;
  status: string;
  start_at: Date;
  end_at: Date;
  contact_id: string | null;
  appointment_type_id: string | null;
  calendar_ref: string | null;
  title: string;
  version: number;
  reschedule_count: number;
}

async function lockNative(db: Queryable, orgId: string, id: string): Promise<ApptRow> {
  const { rows } = await db.query<ApptRow>(
    "select id, org_id, provider, status, start_at, end_at, contact_id, appointment_type_id, calendar_ref, title, version, reschedule_count from appointment_refs where id = $1 and org_id = $2 for update",
    [id, orgId],
  );
  const a = rows[0];
  if (!a || a.provider !== "native") throw new AppError("not_found", "Appointment not found.");
  return a;
}

/** Moves a native appointment. The new time is held before the old one is given back, all in one transaction. */
export async function rescheduleNativeAppointment(actor: CrmActor, id: string, input: { startAt: Date; by: "staff" | "customer" | "agent"; expectedVersion?: number; now?: Date }): Promise<{ startAt: string; endAt: string }> {
  if (input.by === "staff") assertCan(actor, "appointments.manage");
  const now = input.now ?? new Date();
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "appointments");
    const a = await lockNative(db, actor.orgId, id);
    if (!["new", "confirmed"].includes(a.status)) throw new AppError("conflict", "Only an upcoming appointment can be moved.");
    if (input.expectedVersion !== undefined && a.version !== input.expectedVersion) throw new AppError("conflict", "Someone else changed this appointment. Reload and try again.");
    if (input.by === "customer" && new Date(a.start_at).getTime() <= now.getTime()) throw new AppError("conflict", "This appointment has already started.");
    if (input.by === "customer") await assertCustomerMayChange(db, actor.orgId, a, now);
    await lockCalendarOf(db, actor.orgId, a.appointment_type_id as string);
    const ctx = await loadBookingContext(db, actor.orgId, a.appointment_type_id as string);
    const start = input.startAt.getTime();
    const hosts = (await db.query<{ user_id: string }>("select user_id from crm_appointment_hosts where appointment_id = $1", [id])).rows.map((r) => r.user_id);
    const slots = await computeSlots(db, ctx, { from: new Date(start - 60_000), to: new Date(start + 60_000), now, ignoreNotice: input.by === "staff", excludeAppointmentId: id });
    const slot = slots.find((s) => new Date(s.start).getTime() === start);
    if (!slot) throw new AppError("conflict", "That time is no longer available. Choose another time.");
    // Keep the same host when they're free; otherwise a round-robin calendar may move it to another free host.
    let next = hosts.filter((h) => slot.hostIds.includes(h));
    if (ctx.calendar.assignment === "collective" && next.length !== hosts.length) throw new AppError("conflict", "Not everyone is free at that time.");
    if (!next.length) {
      if (ctx.calendar.assignment !== "round_robin") throw new AppError("conflict", "The host isn't free at that time.");
      next = orderHosts(ctx, slot.hostIds).slice(0, 1);
    }
    await releaseTime(db, actor.orgId, id);
    const held: string[] = [];
    const blocks = new Map<string, string>();
    for (const h of next) {
      const r = await holdTime(db, ctx, h, start, id);
      if (!r.ok) {
        if (ctx.calendar.assignment === "collective" || next.length === 1) throw new AppError("conflict", TAKEN);
        continue;
      }
      held.push(h);
      if (r.shared) blocks.set(h, r.blockId);
      if (ctx.calendar.assignment !== "collective") break;
    }
    if (!held.length) throw new AppError("conflict", TAKEN);
    const end = start + ctx.type.durationMinutes * 60_000;
    const upd = await db.query<{ version: number }>(
      `update appointment_refs set start_at = $3, end_at = $4, previous_start_at = start_at, reschedule_count = reschedule_count + 1, assigned_user_id = $5, busy_block_id = $6,
         version = version + 1, last_event_at = now() where id = $1 and org_id = $2 returning version`,
      [id, actor.orgId, new Date(start), new Date(end), held[0], blocks.get(held[0]) ?? null],
    );
    await db.query("delete from crm_appointment_hosts where appointment_id = $1 and not (user_id = any($2::uuid[]))", [id, held]);
    await saveHosts(db, actor.orgId, id, held, blocks);
    const when = formatSlot(new Date(start).toISOString(), ctx.orgTimezone);
    await emitEvent(db, actor, { type: "appointment.rescheduled", entityType: "appointment", entityId: id, contactId: a.contact_id, payload: { from: new Date(a.start_at).toISOString(), to: new Date(start).toISOString(), by: input.by }, dedupeKey: `appointment.rescheduled:${id}:v${upd.rows[0].version}` });
    await recordActivity(db, actor, { kind: "appointment.rescheduled", summary: `Appointment moved to ${when}`, contactId: a.contact_id, refType: "appointment", refId: id });
    await syncRemindersFor(db, actor.orgId, id, now);
    for (const h of held) {
      if (h === actor.userId) continue;
      await notifyUser(db, h, actor.orgId, { kind: "booking_rescheduled", severity: "info", title: `Appointment moved: ${ctx.type.name}`, body: when, link: `/crm/calendar?appointment=${id}`, dedupeKey: `crm-resched:${id}:${upd.rows[0].version}:${h}` });
    }
    return { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
  });
}

/** Cancels a native appointment and gives the time back. Cancelling twice changes nothing. */
export async function cancelNativeAppointment(actor: CrmActor, id: string, input: { reason?: string | null; by: "staff" | "customer" | "agent"; now?: Date }): Promise<{ changed: boolean; late: boolean }> {
  if (input.by === "staff") assertCan(actor, "appointments.manage");
  const now = input.now ?? new Date();
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "appointments");
    const a = await lockNative(db, actor.orgId, id);
    if (a.status === "cancelled") return { changed: false, late: false };
    if (!["new", "confirmed"].includes(a.status)) throw new AppError("conflict", "Only an upcoming appointment can be cancelled.");
    if (input.by === "customer") await assertCustomerMayChange(db, actor.orgId, a, now);
    const policy = await db.query<{ late_cancel_hours: number | null }>("select late_cancel_hours from appointment_settings where org_id = $1", [actor.orgId]);
    const late = isLateCancellation(new Date(a.start_at), now, policy.rows[0]?.late_cancel_hours ?? null);
    await releaseTime(db, actor.orgId, id);
    await db.query(
      `update appointment_refs set status = 'cancelled', cancelled_at = now(), cancel_reason = $3, late_cancellation = $4, version = version + 1, last_event_at = now() where id = $1 and org_id = $2`,
      [id, actor.orgId, input.reason?.trim().slice(0, 300) || null, late],
    );
    await emitEvent(db, actor, { type: "appointment.cancelled", entityType: "appointment", entityId: id, contactId: a.contact_id, payload: { by: input.by, late, reason: input.reason ?? null }, dedupeKey: `appointment.cancelled:${id}` });
    await recordActivity(db, actor, { kind: "appointment.cancelled", summary: `Appointment cancelled${input.by === "customer" ? " by the customer" : ""}`, contactId: a.contact_id, refType: "appointment", refId: id });
    await syncRemindersFor(db, actor.orgId, id, now);
    const hosts = await db.query<{ user_id: string }>("select user_id from crm_appointment_hosts where appointment_id = $1", [id]);
    for (const h of hosts.rows) {
      if (h.user_id === actor.userId) continue;
      await notifyUser(db, h.user_id, actor.orgId, { kind: "booking_cancelled", severity: "info", title: `Appointment cancelled: ${a.title}`, body: formatSlot(new Date(a.start_at).toISOString(), actor.timezone || "UTC"), link: `/crm/calendar?appointment=${id}`, dedupeKey: `crm-cancel:${id}:${h.user_id}` });
    }
    return { changed: true, late };
  });
}

/** Confirms a booking that was waiting for a person, or records how a finished appointment went. */
export async function setNativeAppointmentStatus(actor: CrmActor, id: string, status: "confirmed" | "showed" | "noshow"): Promise<void> {
  assertCan(actor, "appointments.manage");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "appointments");
    const a = await lockNative(db, actor.orgId, id);
    if (status === "confirmed" && a.status !== "new") throw new AppError("conflict", "Only a booking waiting for confirmation can be confirmed.");
    if ((status === "showed" || status === "noshow") && !["new", "confirmed", "showed", "noshow"].includes(a.status)) throw new AppError("conflict", "A cancelled appointment has no outcome.");
    if ((status === "showed" || status === "noshow") && new Date(a.start_at).getTime() > Date.now()) throw new AppError("conflict", "Record the outcome once the appointment has started.");
    if (a.status === status) return;
    await db.query("update appointment_refs set status = $3, version = version + 1, last_event_at = now() where id = $1 and org_id = $2", [id, actor.orgId, status]);
    await emitEvent(db, actor, { type: `appointment.${status === "noshow" ? "no_show" : status}`, entityType: "appointment", entityId: id, contactId: a.contact_id, dedupeKey: `appointment.${status}:${id}` });
    await recordActivity(db, actor, { kind: `appointment.${status === "noshow" ? "no_show" : status}`, summary: status === "confirmed" ? "Appointment confirmed" : status === "showed" ? "Showed up to the appointment" : "Didn't show up to the appointment", contactId: a.contact_id, refType: "appointment", refId: id });
    await syncRemindersFor(db, actor.orgId, id);
  });
}

// ---------------------------------------------------------------------------
// The customer's own link (reschedule or cancel without signing in)
// ---------------------------------------------------------------------------

export type ManageLinkPurpose = "confirmation" | "reminder" | "staff" | "reschedule";

export interface ManagedAppointment {
  id: string;
  orgId: string;
  orgName: string;
  /** The internal title names the contact as the CRM knows them. Public pages show `typeName` instead. */
  title: string;
  typeId: string;
  typeName: string;
  status: string;
  startAt: string;
  endAt: string;
  timezone: string;
  location: string | null;
  meetingLink: string | null;
  /** Whether the customer may reschedule or cancel from their link right now (status, start, and the type's rules). */
  canChange: boolean;
  /** Why `canChange` is false, or null when it is true. */
  cannotChangeReason: CustomerChangeBlock | null;
  /** The last moment the customer can change it online, or null when the type doesn't allow changes. */
  changeDeadline: string | null;
  allowCustomerChanges: boolean;
  changeCutoffMinutes: number;
  orgSlug: string;
  calendarSlug: string;
  typeSlug: string;
  durationMinutes: number;
  version: number;
  /** Which link opened it: the one returned at booking, or one issued later. */
  linkIssuedFor: "booking" | ManageLinkPurpose;
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,64}$/;

/**
 * Finds the appointment for a customer's manage link: the link returned at booking, or a live link issued later (not revoked, not
 * expired). The token is compared by hash; an unknown, expired or revoked token reveals nothing.
 */
export async function findByManageToken(token: string, opts: { now?: Date } = {}): Promise<ManagedAppointment | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const hash = sha256(token);
    const { rows } = await db.query<{
      id: string; org_id: string; org_name: string; org_slug: string; title: string; type_id: string; type_name: string; type_slug: string; calendar_slug: string; status: string; start_at: Date; end_at: Date;
      invitee_timezone: string | null; timezone: string | null; location: string | null; meeting_link: string | null; duration_minutes: number; version: number;
      allow_customer_changes: boolean; change_cutoff_minutes: number; primary_match: boolean; issued_for: ManageLinkPurpose | null;
    }>(
      `with link as (
         select l.appointment_id, l.org_id, l.issued_for from crm_appointment_links l where l.token_hash = $1 and l.revoked_at is null and l.expires_at > $2
       )
       select a.id, a.org_id, o.name as org_name, o.slug as org_slug, a.title, t.id as type_id, t.name as type_name, t.slug as type_slug, c.slug as calendar_slug, a.status, a.start_at, a.end_at,
              a.invitee_timezone, a.timezone, a.location, a.meeting_link, t.duration_minutes, a.version, t.allow_customer_changes, t.change_cutoff_minutes,
              coalesce(a.manage_token_hash = $1, false) as primary_match, (select issued_for from link where link.appointment_id = a.id and link.org_id = a.org_id limit 1) as issued_for
       from appointment_refs a join organizations o on o.id = a.org_id
       join crm_appointment_types t on t.id = a.appointment_type_id and t.org_id = a.org_id
       join crm_calendars c on c.id = t.calendar_id and c.org_id = t.org_id
       where a.provider = 'native' and (a.manage_token_hash = $1 or exists (select 1 from link where link.appointment_id = a.id and link.org_id = a.org_id))
       limit 1`,
      [hash, now],
    );
    const r = rows[0];
    if (!r) return null;
    const rules = { allowCustomerChanges: r.allow_customer_changes, changeCutoffMinutes: r.change_cutoff_minutes };
    const block = customerChangeBlock({ status: r.status, startAt: new Date(r.start_at) }, rules, now);
    return {
      id: r.id, orgId: r.org_id, orgName: r.org_name, title: r.title, typeId: r.type_id, typeName: r.type_name, status: r.status, startAt: new Date(r.start_at).toISOString(), endAt: new Date(r.end_at).toISOString(),
      timezone: r.invitee_timezone ?? r.timezone ?? "UTC", location: r.location, meetingLink: r.meeting_link,
      canChange: block === null,
      cannotChangeReason: block,
      changeDeadline: r.allow_customer_changes ? new Date(new Date(r.start_at).getTime() - r.change_cutoff_minutes * 60_000).toISOString() : null,
      allowCustomerChanges: r.allow_customer_changes,
      changeCutoffMinutes: r.change_cutoff_minutes,
      orgSlug: r.org_slug, calendarSlug: r.calendar_slug, typeSlug: r.type_slug, durationMinutes: r.duration_minutes, version: r.version,
      linkIssuedFor: r.primary_match ? "booking" : (r.issued_for ?? "booking"),
    };
  });
}

const MAX_LINK_MINUTES = 400 * 24 * 60;

/**
 * Issues another manage link for a native appointment (for a reminder, a confirmation page, a staff "send link", or after a reschedule)
 * without invalidating the others. Returns the raw secret once; only its sha256 is stored, with an expiry. Runs in the caller's transaction.
 */
export async function issueManageLink(db: Queryable, orgId: string, appointmentId: string, issuedFor: ManageLinkPurpose, ttlMinutes: number, now: Date = new Date()): Promise<string> {
  if (!["confirmation", "reminder", "staff", "reschedule"].includes(issuedFor)) throw new AppError("invalid_input", "Choose what the link is for.");
  if (!Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > MAX_LINK_MINUTES) throw new AppError("invalid_input", "A link lasts from one minute to 400 days.");
  const appt = await db.query("select 1 from appointment_refs where id = $1 and org_id = $2 and provider = 'native'", [appointmentId, orgId]);
  if (!appt.rows[0]) throw new AppError("not_found", "Appointment not found.");
  const token = randomToken(24);
  await db.query(
    "insert into crm_appointment_links (org_id, appointment_id, token_hash, issued_for, created_at, expires_at) values ($1, $2, $3, $4, $5, $6)",
    [orgId, appointmentId, sha256(token), issuedFor, now, new Date(now.getTime() + Math.ceil(ttlMinutes) * 60_000)],
  );
  return token;
}

/**
 * Revokes issued manage links for an appointment: one link (by its raw secret) or all of them. The link returned at booking is not in
 * this table and is unaffected. Returns how many were revoked.
 */
export async function revokeManageLinks(db: Queryable, orgId: string, appointmentId: string, opts: { token?: string } = {}): Promise<number> {
  const res = await db.query(
    "update crm_appointment_links set revoked_at = now() where org_id = $1 and appointment_id = $2 and revoked_at is null and ($3::text is null or token_hash = $3)",
    [orgId, appointmentId, opts.token ? sha256(opts.token) : null],
  );
  return res.rowCount ?? 0;
}

/** The booking page's actor: acts for the workspace, recorded as the booking page. */
export async function bookingPageActor(orgId: string): Promise<CrmActor> {
  const org = await withSystem((db) => db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1 and kind = 'client'", [orgId]));
  if (!org.rows[0]) throw new AppError("not_found", "Not found.");
  return systemActor(org.rows[0], "Booking page");
}
