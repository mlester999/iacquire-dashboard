import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { automationGate } from "@/server/automation/gate";
import { createApproval } from "@/server/approvals/service";
import { queueOutbound } from "@/server/messaging/send";
import { systemActor, type CrmActor } from "@/server/crm/actor";
import { isSwitching, loadWorkspace } from "@/server/crm/workspace";
import { computeSlots, loadBookingContext } from "@/server/calendars/availability";
import { resolveNativeAppointmentType as resolveType } from "@/server/calendars/native-availability";
import { bookNativeAppointment } from "@/server/calendars/booking";
import { formatSlot } from "@/lib/appointments";
import type { BookingRequest, BookingResult } from "@/server/appointments/booking";

export { nativeAvailability } from "@/server/calendars/native-availability";

// The Appointment Setter and the Appointments page book through one request flow (hold, check, approval, send). For a workspace whose
// appointments are native, that flow books native appointment types instead of GoHighLevel calendars. In this flow `calendarId` names
// the native appointment type (a calendar's default type when a calendar id is given).

/**
 * Whether this workspace's booking requests go to native calendars: appointments are native and at least one calendar is set up. A draft
 * calendar counts here (the workspace's appointments are native either way); it is resolveType that refuses to book it.
 */
export async function bookingIsNative(db: Queryable, orgId: string): Promise<boolean> {
  const ws = await loadWorkspace(db, orgId).catch(() => null);
  if (!ws || ws.capabilities.appointments !== "native") return false;
  const cal = await db.query("select 1 from crm_calendars where org_id = $1 and archived_at is null limit 1", [orgId]);
  return cal.rows.length > 0;
}

const HOLDING = ["awaiting_approval", "requested", "booked", "needs_manual"];

/** The native version of requestBooking: same hold → check → approval → book order, same results. */
export async function requestNativeBooking(req: BookingRequest): Promise<BookingResult> {
  const now = req.now ?? new Date();
  const held = await withSystem(async (db) => {
    const c = await db.query<{ display_name: string; timezone: string | null; deleted_at: Date | null }>("select display_name, timezone, deleted_at from contacts where id = $1 and org_id = $2", [req.contactId, req.orgId]);
    if (!c.rows[0] || c.rows[0].deleted_at) return { kind: "refused" as const, reason: "contact_unusable" as const, detail: "That contact can't be booked." };
    const resolved = await resolveType(db, req.orgId, req.calendarId);
    if ("refused" in resolved) return { kind: "refused" as const, reason: "no_calendar" as const, detail: resolved.refused };
    const typeId = resolved.typeId;
    const ctx = await loadBookingContext(db, req.orgId, typeId);
    const policy = await db.query<{ ai_booking_enabled: boolean }>("select ai_booking_enabled from appointment_settings where org_id = $1", [req.orgId]);
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`crm-cal:${ctx.calendar.id}`]);
    const key = `${req.contactId}:${typeId}:${req.startAt.toISOString()}`;
    const same = await db.query<{ id: string; status: string; approval_id: string | null }>("select id, status, approval_id from appointment_bookings where org_id = $1 and idempotency_key = $2", [req.orgId, key]);
    if (same.rows[0] && HOLDING.includes(same.rows[0].status)) return { kind: "existing" as const, booking: same.rows[0] };
    // People may book inside the notice period; the AI follows the type's notice rule.
    const slots = await computeSlots(db, ctx, { from: new Date(req.startAt.getTime() - 60_000), to: new Date(req.startAt.getTime() + 60_000), now, ignoreNotice: req.actor.kind === "staff" });
    const slot = slots.find((s) => new Date(s.start).getTime() === req.startAt.getTime());
    if (!slot) return { kind: "refused" as const, reason: "slot_taken" as const, detail: "That time is no longer free." };
    // Requests still waiting for approval hold their place: one per free host (round robin), one in all for a collective, one per seat for a group.
    const pending = await db.query<{ n: string }>("select count(*)::text as n from appointment_bookings where org_id = $1 and provider = 'native' and calendar_id = $2 and start_at = $3 and status in ('awaiting_approval', 'requested', 'needs_manual')", [req.orgId, typeId, req.startAt]);
    const room = ctx.type.capacity > 1 ? slot.remaining ?? 1 : ctx.calendar.assignment === "collective" ? 1 : slot.hostIds.length;
    if (Number(pending.rows[0].n) >= room) return { kind: "refused" as const, reason: "slot_taken" as const, detail: "That time is already being booked." };
    if (same.rows[0]) await db.query("update appointment_bookings set idempotency_key = left(idempotency_key, 100) || ':' || id::text where id = $1", [same.rows[0].id]);
    const end = new Date(req.startAt.getTime() + ctx.type.durationMinutes * 60_000);
    const ins = await db.query<{ id: string }>(
      `insert into appointment_bookings (org_id, provider, contact_id, conversation_id, calendar_id, start_at, end_at, timezone, title, requested_by_kind, requested_by_user, agent_id, status, idempotency_key, availability_checked_at)
       values ($1, 'native', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'requested', $12, now()) returning id`,
      [req.orgId, req.contactId, req.conversationId ?? null, typeId, req.startAt, end, c.rows[0].timezone ?? ctx.orgTimezone, (req.title ?? `${ctx.type.name} with ${c.rows[0].display_name || "a customer"}`).slice(0, 200),
        req.actor.kind, req.actor.kind === "staff" ? req.actor.userId : req.requestedByUserId ?? null, req.actor.kind === "ai" ? req.actor.agentId : null, key],
    );
    return { kind: "held" as const, bookingId: ins.rows[0].id, contactName: c.rows[0].display_name, typeName: ctx.type.name, timezone: c.rows[0].timezone ?? ctx.orgTimezone, aiBooking: policy.rows[0]?.ai_booking_enabled ?? false };
  });
  if (held.kind === "refused") return { status: "unavailable", reason: held.reason, detail: held.detail };
  if (held.kind === "existing") {
    const b = held.booking;
    if (b.status === "awaiting_approval") return { status: "awaiting_approval", bookingId: b.id, approvalId: b.approval_id };
    if (b.status === "booked") return { status: "booked", bookingId: b.id, appointmentId: "" };
    return { status: "unavailable", reason: "slot_taken", detail: "This time is already being booked.", bookingId: b.id };
  }

  const decision = await withSystem(async (db) => {
    if (req.actor.kind === "staff") return { kind: "proceed" as const };
    const gate = await automationGate(db, { orgId: req.orgId, agentId: req.actor.agentId, scope: "reply" });
    if (gate.decision === "blocked") {
      await db.query("update appointment_bookings set status = 'cancelled', failure_reason = $2 where id = $1", [held.bookingId, gate.detail.slice(0, 300)]);
      return { kind: "blocked" as const, detail: gate.detail };
    }
    // While a CRM provider switch cuts over, an AI booking waits for a person's yes instead of going straight in.
    if (gate.decision === "allow" && held.aiBooking && !(await isSwitching(db, req.orgId))) return { kind: "proceed" as const };
    const label = formatSlot(req.startAt.toISOString(), held.timezone);
    const approvalId = await createApproval(db, {
      orgId: req.orgId, agentId: req.actor.agentId, kind: "appointment_booking", title: `Book ${held.contactName || "a customer"} for ${label}`,
      action: { bookingId: held.bookingId }, targetType: "appointment_booking", targetId: held.bookingId, targetLabel: held.contactName || undefined,
      reason: req.requestSource === "staff_chat"
        ? `A team member selected and explicitly confirmed this contact and time in AI Employee Chat for the ${held.typeName} calendar. The booking still needs your approval.`
        : `Your Appointment Setter found this time free on your ${held.typeName} calendar and the customer asked to book it.`,
      expectedEffect: req.requestSource === "staff_chat"
        ? "The appointment is added to the selected calendar. Any customer invitation follows the calendar provider's settings."
        : "The appointment is added to your calendar and the customer is told it is confirmed.",
      risk: "medium", expiresInHours: 48, idempotencyKey: `booking:${held.bookingId}`, actorKind: "agent",
    });
    await db.query("update appointment_bookings set status = 'awaiting_approval', approval_id = $2 where id = $1", [held.bookingId, approvalId]);
    await notifyOrgRoles(db, req.orgId, ["owner", "admin"], { kind: "approval_requested", severity: "info", title: `Confirm an appointment for ${held.contactName || "a customer"}`, body: label, link: "/approvals", dedupeKey: `booking-approval:${held.bookingId}` });
    return { kind: "approval" as const, approvalId };
  });
  if (decision.kind === "blocked") return { status: "unavailable", reason: "blocked", detail: decision.detail, bookingId: held.bookingId };
  if (decision.kind === "approval") return { status: "awaiting_approval", bookingId: held.bookingId, approvalId: decision.approvalId };
  return executeNativeBooking(req.orgId, held.bookingId, { now });
}

/** Turns a held native request into an appointment. Runs for a person's booking straight away, and after an approval for the AI's. */
export async function executeNativeBooking(orgId: string, bookingId: string, opts: { now?: Date; approvalId?: string | null } = {}): Promise<BookingResult> {
  const now = opts.now ?? new Date();
  const loaded = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; status: string; contact_id: string; conversation_id: string | null; calendar_id: string; start_at: Date; timezone: string; requested_by_kind: "ai" | "staff"; requested_by_user: string | null; agent_id: string | null; approval_id: string | null }>(
      "select id, status, contact_id, conversation_id, calendar_id, start_at, timezone, requested_by_kind, requested_by_user, agent_id, approval_id from appointment_bookings where id = $1 and org_id = $2 and provider = 'native' for update",
      [bookingId, orgId],
    );
    const b = rows[0];
    if (!b) throw new AppError("not_found", "Booking not found.");
    if (!["requested", "awaiting_approval"].includes(b.status)) return { b, skip: true as const, gated: null };
    const claim = await db.query("update appointment_bookings set claimed_at = now() where id = $1 and (claimed_at is null or claimed_at < now() - interval '5 minutes')", [bookingId]);
    if (!claim.rowCount) return { b, skip: true as const, gated: null };
    if (b.requested_by_kind === "ai") {
      const gate = await automationGate(db, { orgId, agentId: b.agent_id, scope: "reply", approvalId: opts.approvalId ?? b.approval_id });
      if (gate.decision !== "allow") {
        const why = gate.decision === "blocked" ? gate.detail : "A person has not approved this yet.";
        await db.query("update appointment_bookings set status = 'cancelled', failure_reason = $2 where id = $1", [bookingId, why.slice(0, 300)]);
        return { b, skip: false as const, gated: why };
      }
    }
    const org = await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1", [orgId]);
    return { b, skip: false as const, gated: null, org: org.rows[0] };
  });
  const { b } = loaded;
  if (loaded.skip) return b.status === "booked" ? { status: "booked", bookingId, appointmentId: "" } : { status: "unavailable", reason: "slot_taken", detail: "This booking is no longer pending.", bookingId };
  if (loaded.gated) return { status: "unavailable", reason: "blocked", detail: loaded.gated, bookingId };

  const base = systemActor(loaded.org!, b.requested_by_kind === "ai" ? "Appointment Setter" : "Team");
  const actor: CrmActor = b.requested_by_kind === "ai" ? { ...base, kind: "agent", agentId: b.agent_id } : { ...base, kind: "system", userId: b.requested_by_user };
  try {
    const res = await bookNativeAppointment(actor, {
      typeId: b.calendar_id, startAt: new Date(b.start_at), contact: { id: b.contact_id }, via: b.requested_by_kind === "ai" ? "agent" : "staff", idempotencyKey: `booking:${bookingId}`, now,
      inviteeTimezone: b.timezone,
    });
    await withSystem(async (db) => {
      await db.query("update appointment_bookings set status = 'booked', appointment_id = $2, booked_at = now() where id = $1", [bookingId, res.appointmentId]);
      await recordAudit({ orgId, actorUserId: b.requested_by_user, actorKind: b.requested_by_kind === "ai" ? "agent" : "user", agentInstanceId: b.agent_id, action: "appointment.booked", targetType: "appointment_booking", targetId: bookingId, result: "success", metadata: { provider: "native", start: new Date(b.start_at).toISOString() } }, db);
    });
    if (b.requested_by_kind === "ai" && b.conversation_id && b.agent_id) {
      await withSystem((db) =>
        queueOutbound(db, {
          orgId, conversationId: b.conversation_id as string, scope: "reply", actor: { kind: "ai", agentId: b.agent_id as string, approvalId: opts.approvalId ?? b.approval_id }, now,
          body: `You're booked for ${formatSlot(new Date(b.start_at).toISOString(), b.timezone)}. We look forward to seeing you. Reply here if you need to change it.`,
          dedupeKey: `booking-confirm:${bookingId}`,
        }),
      ).catch(() => undefined);
    }
    return { status: "booked", bookingId, appointmentId: res.appointmentId };
  } catch (err) {
    const reason = err instanceof AppError ? err.message : "The booking could not be completed.";
    await withSystem((db) => db.query("update appointment_bookings set status = 'failed', failure_reason = $2 where id = $1 and status in ('requested', 'awaiting_approval')", [bookingId, reason.slice(0, 300)]));
    if (err instanceof AppError && err.code === "conflict") return { status: "unavailable", reason: "slot_taken", detail: reason, bookingId };
    if (!(err instanceof AppError)) throw err;
    return { status: "failed", bookingId, reason };
  }
}
