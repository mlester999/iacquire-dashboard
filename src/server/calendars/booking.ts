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

/** Gives back a host's time for one appointment: its own blocks are released; a group block loses one place and is released when empty. */
async function releaseTime(db: Queryable, orgId: string, appointmentId: string) {
  await db.query("update crm_busy_blocks set released_at = now() where org_id = $1 and appointment_id = $2 and released_at is null", [orgId, appointmentId]);
  const shared = await db.query<{ busy_block_id: string | null }>("select busy_block_id from appointment_refs where id = $1 and org_id = $2", [appointmentId, orgId]);
  const blockId = shared.rows[0]?.busy_block_id;
  if (blockId) {
    await db.query(
      `update crm_busy_blocks set booked = greatest(booked - 1, 0), released_at = case when booked - 1 <= 0 then now() else released_at end
       where id = $1 and org_id = $2 and appointment_id is null and released_at is null`,
      [blockId, orgId],
    );
  }
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
    if (input.idempotencyKey) {
      const prior = await db.query<{ id: string; status: "new" | "confirmed"; start_at: Date; end_at: Date }>(
        "select id, status, start_at, end_at from appointment_refs where org_id = $1 and idempotency_key = $2",
        [actor.orgId, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        const hosts = await db.query<{ user_id: string }>("select user_id from crm_appointment_hosts where appointment_id = $1", [prior.rows[0].id]);
        return { appointmentId: prior.rows[0].id, status: prior.rows[0].status, hostIds: hosts.rows.map((h) => h.user_id), manageToken: null, created: false, startAt: new Date(prior.rows[0].start_at).toISOString(), endAt: new Date(prior.rows[0].end_at).toISOString() };
      }
    }
    const ctx = await loadBookingContext(db, actor.orgId, input.typeId);
    if ((input.via === "booking_page" || input.via === "website") && (!ctx.type.public || !ctx.calendar.public)) throw new AppError("not_found", "That booking page isn't available.");
    // Bookings in one calendar are decided one at a time, so round robin sees the previous booking's choice.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`crm-cal:${ctx.calendar.id}`]);
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
      if (!c.email?.trim() && !c.phone?.trim()) throw new AppError("invalid_input", "Please enter an email address or a phone number so we can confirm.");
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

    // Hold the time. Round robin tries each free host in turn; collective needs every host.
    const held: string[] = [];
    let sharedBlock: string | null = null;
    if (ctx.calendar.assignment === "collective") {
      for (const hostId of candidates) {
        const r = await holdTime(db, ctx, hostId, start, appointmentId);
        if (!r.ok) throw new AppError("conflict", TAKEN);
        held.push(hostId);
        if (r.shared) sharedBlock ??= r.blockId;
      }
    } else {
      for (const hostId of candidates) {
        const r = await holdTime(db, ctx, hostId, start, appointmentId);
        if (!r.ok) continue;
        held.push(hostId);
        if (r.shared) sharedBlock = r.blockId;
        break;
      }
      if (!held.length) throw new AppError("conflict", TAKEN);
    }
    await db.query("update appointment_refs set assigned_user_id = $3, busy_block_id = $4 where id = $1 and org_id = $2", [appointmentId, actor.orgId, held[0], sharedBlock]);
    for (const h of held) await db.query("insert into crm_appointment_hosts (org_id, appointment_id, user_id) values ($1, $2, $3)", [actor.orgId, appointmentId, h]);
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
    const ctx = await loadBookingContext(db, actor.orgId, a.appointment_type_id as string);
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`crm-cal:${ctx.calendar.id}`]);
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
    await db.query("update appointment_refs set busy_block_id = null where id = $1", [id]);
    const held: string[] = [];
    let shared: string | null = null;
    for (const h of next) {
      const r = await holdTime(db, ctx, h, start, id);
      if (!r.ok) {
        if (ctx.calendar.assignment === "collective" || next.length === 1) throw new AppError("conflict", TAKEN);
        continue;
      }
      held.push(h);
      if (r.shared) shared = r.blockId;
      if (ctx.calendar.assignment !== "collective") break;
    }
    if (!held.length) throw new AppError("conflict", TAKEN);
    const end = start + ctx.type.durationMinutes * 60_000;
    const upd = await db.query<{ version: number }>(
      `update appointment_refs set start_at = $3, end_at = $4, previous_start_at = start_at, reschedule_count = reschedule_count + 1, assigned_user_id = $5, busy_block_id = $6,
         version = version + 1, last_event_at = now() where id = $1 and org_id = $2 returning version`,
      [id, actor.orgId, new Date(start), new Date(end), held[0], shared],
    );
    await db.query("delete from crm_appointment_hosts where appointment_id = $1 and not (user_id = any($2::uuid[]))", [id, held]);
    for (const h of held) await db.query("insert into crm_appointment_hosts (org_id, appointment_id, user_id) values ($1, $2, $3) on conflict do nothing", [actor.orgId, id, h]);
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
    const a = await lockNative(db, actor.orgId, id);
    if (a.status === "cancelled") return { changed: false, late: false };
    if (!["new", "confirmed"].includes(a.status)) throw new AppError("conflict", "Only an upcoming appointment can be cancelled.");
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
      await notifyUser(db, h.user_id, actor.orgId, { kind: "booking_cancelled", severity: "info", title: `Appointment cancelled: ${a.title}`, body: formatSlot(new Date(a.start_at).toISOString(), "UTC"), link: `/crm/calendar?appointment=${id}`, dedupeKey: `crm-cancel:${id}:${h.user_id}` });
    }
    return { changed: true, late };
  });
}

/** Confirms a booking that was waiting for a person, or records how a finished appointment went. */
export async function setNativeAppointmentStatus(actor: CrmActor, id: string, status: "confirmed" | "showed" | "noshow"): Promise<void> {
  assertCan(actor, "appointments.manage");
  await crmWrite(actor, async (db) => {
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

export interface ManagedAppointment {
  id: string;
  orgId: string;
  orgName: string;
  title: string;
  typeId: string;
  typeName: string;
  status: string;
  startAt: string;
  endAt: string;
  timezone: string;
  location: string | null;
  meetingLink: string | null;
  canChange: boolean;
}

/** Finds the appointment for a customer's manage link. The token is compared by hash; an unknown token reveals nothing. */
export async function findByManageToken(token: string): Promise<ManagedAppointment | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; org_name: string; title: string; type_id: string; type_name: string; status: string; start_at: Date; end_at: Date; invitee_timezone: string | null; timezone: string | null; location: string | null; meeting_link: string | null }>(
      `select a.id, a.org_id, o.name as org_name, a.title, t.id as type_id, t.name as type_name, a.status, a.start_at, a.end_at, a.invitee_timezone, a.timezone, a.location, a.meeting_link
       from appointment_refs a join organizations o on o.id = a.org_id join crm_appointment_types t on t.id = a.appointment_type_id
       where a.manage_token_hash = $1 and a.provider = 'native'`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, orgId: r.org_id, orgName: r.org_name, title: r.title, typeId: r.type_id, typeName: r.type_name, status: r.status, startAt: new Date(r.start_at).toISOString(), endAt: new Date(r.end_at).toISOString(),
      timezone: r.invitee_timezone ?? r.timezone ?? "UTC", location: r.location, meetingLink: r.meeting_link,
      canChange: ["new", "confirmed"].includes(r.status) && new Date(r.start_at).getTime() > Date.now(),
    };
  });
}

/** The booking page's actor: acts for the workspace, recorded as the booking page. */
export async function bookingPageActor(orgId: string): Promise<CrmActor> {
  const org = await withSystem((db) => db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1 and kind = 'client'", [orgId]));
  if (!org.rows[0]) throw new AppError("not_found", "Not found.");
  return systemActor(org.rows[0], "Booking page");
}
