import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { automationGate } from "@/server/automation/gate";
import { createApproval } from "@/server/approvals/service";
import { queueOutbound } from "@/server/messaging/send";
import { applyAppointmentEvent } from "@/server/appointments/ledger";
import { isSlotAvailable, loadPolicy } from "@/server/appointments/availability";
import { ghlAppointmentProvider, type AppointmentProvider } from "@/server/appointments/provider";
import { formatSlot, overlaps } from "@/lib/appointments";
import type { OrgContext } from "@/server/tenancy/context";
import { bookingIsNative, executeNativeBooking, requestNativeBooking } from "@/server/calendars/agent-booking";

export type BookingActor = { kind: "ai"; agentId: string | null } | { kind: "staff"; userId: string };

export interface BookingRequest {
  orgId: string;
  contactId: string;
  conversationId?: string | null;
  calendarId?: string | null;
  startAt: Date;
  title?: string;
  actor: BookingActor;
  assignedGhlUserId?: string | null;
  now?: Date;
}

export type BookingResult =
  | { status: "booked"; bookingId: string; appointmentId: string }
  | { status: "awaiting_approval"; bookingId: string; approvalId: string | null }
  | { status: "needs_manual"; bookingId: string; reason: string }
  | { status: "unavailable"; reason: "slot_taken" | "not_connected" | "no_calendar" | "too_soon" | "contact_unusable" | "provider_error" | "blocked"; detail: string; bookingId?: string }
  | { status: "failed"; bookingId: string; reason: string };

interface BookingRow {
  id: string;
  org_id: string;
  contact_id: string;
  conversation_id: string | null;
  calendar_id: string;
  start_at: Date;
  end_at: Date;
  timezone: string;
  title: string;
  assigned_ghl_user_id: string | null;
  requested_by_kind: "ai" | "staff";
  requested_by_user: string | null;
  agent_id: string | null;
  status: string;
  approval_id: string | null;
  availability_checked_at: Date | null;
}

const HOLDING = ["awaiting_approval", "requested", "booked", "needs_manual"];

const deps = (d: { provider?: AppointmentProvider }) => d.provider ?? ghlAppointmentProvider;

async function release(db: Queryable, id: string, status: "failed" | "cancelled", reason: string) {
  await db.query("update appointment_bookings set status = $2, failure_reason = $3 where id = $1 and status not in ('booked', 'cancelled', 'failed')", [id, status, reason.slice(0, 300)]);
}

/**
 * Asks for an appointment at one exact time. In order: the time is held so nobody else can take it, the calendar is asked again
 * whether it is really free, the AI employee's mode and the owner's rules decide whether a person must confirm, and only then is
 * the booking sent. A booking is never claimed until the calendar provider confirms it.
 */
export async function requestBooking(req: BookingRequest, d: { provider?: AppointmentProvider } = {}): Promise<BookingResult> {
  // Native calendars: the same hold, check and approval steps, booking a native appointment type instead of a GoHighLevel calendar.
  if (!d.provider && (await withSystem((db) => bookingIsNative(db, req.orgId)))) return requestNativeBooking(req);
  const now = req.now ?? new Date();
  const provider = deps(d);

  // 1. Validate and hold the time. The per-calendar lock makes the overlap check and the insert one indivisible step.
  const held = await withSystem(async (db) => {
    const { rows: crow } = await db.query<{ id: string; display_name: string; ghl_contact_id: string | null; timezone: string | null; deleted_at: Date | null }>(
      "select id, display_name, ghl_contact_id, timezone, deleted_at from contacts where id = $1 and org_id = $2",
      [req.contactId, req.orgId],
    );
    const contact = crow[0];
    if (!contact || contact.deleted_at) return { kind: "refused" as const, reason: "contact_unusable" as const, detail: "That contact can't be booked." };
    const policy = await loadPolicy(db, req.orgId);
    const map = await db.query<{ calendar_ids: string[] }>("select calendar_ids from ghl_location_mappings where org_id = $1 and status <> 'disabled'", [req.orgId]);
    if (!map.rows[0]) return { kind: "refused" as const, reason: "not_connected" as const, detail: "The calendar isn't connected for this workspace." };
    const calendars = map.rows[0].calendar_ids;
    const calendarId = req.calendarId ?? policy.defaultCalendarId ?? (calendars.length === 1 ? calendars[0] : null);
    if (!calendarId) return { kind: "refused" as const, reason: "no_calendar" as const, detail: "Choose which calendar bookings go on." };
    if (!calendars.includes(calendarId)) return { kind: "refused" as const, reason: "no_calendar" as const, detail: "That calendar isn't connected to this workspace." };
    // People may book at short notice; the AI follows the workspace's notice rule.
    const earliest = now.getTime() + (req.actor.kind === "ai" ? policy.minNoticeMinutes * 60_000 : 0);
    if (req.startAt.getTime() < earliest) return { kind: "refused" as const, reason: "too_soon" as const, detail: "That time is too soon to book." };

    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`cal:${req.orgId}:${calendarId}`]);
    const key = `${req.contactId}:${calendarId}:${req.startAt.toISOString()}`;
    const same = await db.query<BookingRow>("select * from appointment_bookings where org_id = $1 and idempotency_key = $2", [req.orgId, key]);
    if (same.rows[0] && HOLDING.includes(same.rows[0].status)) return { kind: "existing" as const, booking: same.rows[0] };

    const end = new Date(req.startAt.getTime() + policy.slotMinutes * 60_000);
    const live = await db.query<{ start_at: Date; end_at: Date }>(
      `select start_at, end_at from appointment_refs where org_id = $1 and ghl_calendar_id = $2 and status not in ('cancelled', 'invalid') and end_at > $3 and start_at < $4
       union all select start_at, end_at from appointment_bookings where org_id = $1 and calendar_id = $2 and status in ('awaiting_approval', 'requested', 'needs_manual') and end_at > $3 and start_at < $4`,
      [req.orgId, calendarId, req.startAt.toISOString(), end.toISOString()],
    );
    if (live.rows.some((r) => overlaps({ start: req.startAt, end }, { start: new Date(r.start_at), end: new Date(r.end_at) }))) {
      return { kind: "refused" as const, reason: "slot_taken" as const, detail: "That time was just taken." };
    }
    const org = await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [req.orgId]);
    const timezone = contact.timezone ?? org.rows[0]?.timezone ?? "UTC";
    // A retry after a failed or cancelled attempt reuses the key, so the old row is superseded.
    if (same.rows[0]) await db.query("update appointment_bookings set idempotency_key = left(idempotency_key, 100) || ':' || id::text where id = $1", [same.rows[0].id]);
    const ins = await db.query<BookingRow>(
      `insert into appointment_bookings (org_id, contact_id, conversation_id, calendar_id, start_at, end_at, timezone, title, assigned_ghl_user_id, requested_by_kind, requested_by_user, agent_id, status, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'requested', $13) returning *`,
      [req.orgId, req.contactId, req.conversationId ?? null, calendarId, req.startAt.toISOString(), end.toISOString(), timezone, (req.title ?? `Appointment with ${contact.display_name || "a customer"}`).slice(0, 200), req.assignedGhlUserId ?? null,
        req.actor.kind, req.actor.kind === "staff" ? req.actor.userId : null, req.actor.kind === "ai" ? req.actor.agentId : null, key],
    );
    return { kind: "held" as const, booking: ins.rows[0], contactName: contact.display_name, ghlContactId: contact.ghl_contact_id, aiBooking: policy.aiBookingEnabled };
  });

  if (held.kind === "refused") return { status: "unavailable", reason: held.reason, detail: held.detail };
  if (held.kind === "existing") return resultFor(held.booking);
  const b = held.booking;

  // 2. Ask the calendar, now, whether this exact time is free. No answer means no booking.
  const check = await isSlotAvailable(req.orgId, b.calendar_id, new Date(b.start_at), { now, provider, ignoreBookingId: b.id });
  if (!check.ok) {
    await withSystem((db) => release(db, b.id, "failed", check.detail));
    return { status: "unavailable", reason: check.reason === "not_connected" ? "not_connected" : "provider_error", detail: check.detail, bookingId: b.id };
  }
  if (!check.available) {
    await withSystem((db) => release(db, b.id, "failed", "The calendar no longer shows this time as free."));
    return { status: "unavailable", reason: "slot_taken", detail: "That time is no longer free.", bookingId: b.id };
  }
  await withSystem((db) => db.query("update appointment_bookings set availability_checked_at = $2 where id = $1", [b.id, check.checkedAt]));

  // 3. Does a person need to say yes first?
  const decision = await withSystem(async (db) => {
    if (req.actor.kind === "staff") return { kind: "proceed" as const };
    const gate = await automationGate(db, { orgId: req.orgId, agentId: req.actor.agentId, scope: "reply" });
    if (gate.decision === "blocked") {
      await release(db, b.id, "cancelled", gate.detail);
      return { kind: "blocked" as const, detail: gate.detail };
    }
    // Even an autonomous employee only books on its own if the owner switched that on.
    if (gate.decision === "allow" && held.aiBooking) return { kind: "proceed" as const };
    const approvalId = await createApproval(db, {
      orgId: req.orgId, agentId: req.actor.agentId, kind: "appointment_booking", title: `Book ${held.contactName || "a customer"} for ${formatSlot(b.start_at.toISOString(), b.timezone)}`,
      action: { bookingId: b.id }, targetType: "appointment_booking", targetId: b.id, targetLabel: held.contactName || undefined,
      reason: "Your Appointment Setter found this time on your real calendar and the customer asked to book it.",
      expectedEffect: "The appointment is added to your calendar and the customer is told it is confirmed.", risk: "medium", expiresInHours: 48, idempotencyKey: `booking:${b.id}`, actorKind: "agent",
    });
    await db.query("update appointment_bookings set status = 'awaiting_approval', approval_id = $2 where id = $1", [b.id, approvalId]);
    await notifyOrgRoles(db, req.orgId, ["owner", "admin"], { kind: "approval_requested", severity: "info", title: `Confirm an appointment for ${held.contactName || "a customer"}`, body: formatSlot(b.start_at.toISOString(), b.timezone), link: "/approvals", dedupeKey: `booking-approval:${b.id}` });
    return { kind: "approval" as const, approvalId };
  });
  if (decision.kind === "blocked") return { status: "unavailable", reason: "blocked", detail: decision.detail, bookingId: b.id };
  if (decision.kind === "approval") return { status: "awaiting_approval", bookingId: b.id, approvalId: decision.approvalId };

  return executeBooking(req.orgId, b.id, { provider, now, ghlContactId: held.ghlContactId });
}

function resultFor(b: BookingRow): BookingResult {
  if (b.status === "booked") return { status: "booked", bookingId: b.id, appointmentId: "" };
  if (b.status === "awaiting_approval") return { status: "awaiting_approval", bookingId: b.id, approvalId: b.approval_id };
  if (b.status === "needs_manual") return { status: "needs_manual", bookingId: b.id, reason: "A person needs to add this to the calendar." };
  return { status: "unavailable", reason: "slot_taken", detail: "This time is already being booked.", bookingId: b.id };
}

/**
 * Sends a held booking to the calendar provider. Called directly for a person's booking, and by the approval executor once a
 * person confirms an AI proposal. The mode and the pauses are checked again here, immediately before the write.
 */
export async function executeBooking(orgId: string, bookingId: string, opts: { provider?: AppointmentProvider; now?: Date; ghlContactId?: string | null; approvalId?: string | null } = {}): Promise<BookingResult> {
  const kind = await withSystem((db) => db.query<{ provider: string }>("select provider from appointment_bookings where id = $1 and org_id = $2", [bookingId, orgId]));
  if (kind.rows[0]?.provider === "native") return executeNativeBooking(orgId, bookingId, { now: opts.now, approvalId: opts.approvalId });
  const provider = deps(opts);
  const now = opts.now ?? new Date();
  const loaded = await withSystem(async (db) => {
    const { rows } = await db.query<BookingRow & { ghl_contact_id: string | null; contact_name: string }>(
      `select b.*, c.ghl_contact_id, c.display_name as contact_name from appointment_bookings b join contacts c on c.id = b.contact_id and c.org_id = b.org_id
       where b.id = $1 and b.org_id = $2 for update of b`,
      [bookingId, orgId],
    );
    const b = rows[0];
    if (!b) throw new AppError("not_found", "Booking not found.");
    if (!["requested", "awaiting_approval"].includes(b.status)) return { b, skip: true as const };
    // Only one worker sends a given booking. A claim older than five minutes is treated as abandoned.
    const claim = await db.query("update appointment_bookings set claimed_at = now() where id = $1 and (claimed_at is null or claimed_at < now() - interval '5 minutes')", [bookingId]);
    if (!claim.rowCount) return { b, skip: true as const };
    if (b.requested_by_kind === "ai") {
      const gate = await automationGate(db, { orgId, agentId: b.agent_id, scope: "reply", approvalId: opts.approvalId ?? b.approval_id });
      if (gate.decision !== "allow") {
        await release(db, bookingId, "cancelled", gate.decision === "blocked" ? gate.detail : "A person has not approved this yet.");
        return { b, skip: false as const, gated: gate.decision === "blocked" ? gate.detail : "A person has not approved this yet." };
      }
    }
    return { b, skip: false as const, gated: null };
  });
  const { b } = loaded;
  if (loaded.skip) return resultFor(b);
  if (loaded.gated) return { status: "unavailable", reason: "blocked", detail: loaded.gated, bookingId };

  // The approval may have waited a while. Ask the calendar again unless it was checked a moment ago.
  const checkedAt = b.availability_checked_at ? new Date(b.availability_checked_at).getTime() : 0;
  if (now.getTime() - checkedAt > 2 * 60_000) {
    const check = await isSlotAvailable(orgId, b.calendar_id, new Date(b.start_at), { now, provider, ignoreBookingId: b.id });
    if (!check.ok) {
      await withSystem((db) => release(db, bookingId, "failed", check.detail));
      return { status: "unavailable", reason: "provider_error", detail: check.detail, bookingId };
    }
    if (!check.available) {
      await withSystem((db) => release(db, bookingId, "failed", "The calendar no longer shows this time as free."));
      return { status: "unavailable", reason: "slot_taken", detail: "That time is no longer free.", bookingId };
    }
  }

  const ghlContactId = opts.ghlContactId ?? (b as { ghl_contact_id?: string | null }).ghl_contact_id ?? null;
  const contactName = (b as { contact_name?: string }).contact_name ?? "the customer";
  if (!ghlContactId) {
    const reason = "This contact isn't linked to your CRM yet, so the calendar can't be booked automatically.";
    await markNeedsManual(orgId, b, contactName, reason);
    return { status: "needs_manual", bookingId, reason };
  }

  const res = await provider.create({ orgId, calendarId: b.calendar_id, contactRef: ghlContactId, startAt: new Date(b.start_at), endAt: new Date(b.end_at), title: b.title, assignedUserId: b.assigned_ghl_user_id });
  if (!res.ok) {
    if (res.blocked) {
      await markNeedsManual(orgId, b, contactName, res.error);
      return { status: "needs_manual", bookingId, reason: res.error };
    }
    await withSystem(async (db) => {
      await release(db, bookingId, "failed", res.slotTaken ? "The calendar did not accept that time." : res.error);
      if (res.reconnectRequired) {
        await notifyOrgRoles(db, orgId, ["owner", "admin"], { kind: "integration_reconnect_required", severity: "warning", title: "Reconnect GoHighLevel to book appointments", link: "/settings/integrations", dedupeKey: `reconnect:ghl:${new Date().toISOString().slice(0, 10)}` });
      }
    });
    return res.slotTaken ? { status: "unavailable", reason: "slot_taken", detail: res.error, bookingId } : { status: "failed", bookingId, reason: res.error };
  }

  // The provider confirmed. Record it as an appointment right away; its own webhook later confirms the same state.
  const appointmentId = await withSystem(async (db) => {
    const ledger = await applyAppointmentEvent(db, {
      orgId, source: "portal", providerEventId: `portal:${bookingId}`, now,
      event: { kind: "create", locationId: "", appointmentId: res.appointmentId, calendarId: b.calendar_id, contactId: ghlContactId, status: "confirmed", assignedUserId: b.assigned_ghl_user_id, title: b.title, address: null, startAt: new Date(b.start_at), endAt: new Date(b.end_at), eventTime: now, source: "portal" },
    });
    const apptId = ledger.appointmentId ?? null;
    if (apptId) await db.query("update appointment_refs set origin = $2 where id = $1 and org_id = $3", [apptId, b.requested_by_kind === "ai" ? "portal_ai" : "portal_staff", orgId]);
    await db.query("update appointment_bookings set status = 'booked', ghl_appointment_id = $2, appointment_id = $3, booked_at = now() where id = $1", [bookingId, res.appointmentId, apptId]);
    await recordAudit({ orgId, actorUserId: b.requested_by_user, actorKind: b.requested_by_kind === "ai" ? "agent" : "user", agentInstanceId: b.agent_id, action: "appointment.booked", targetType: "appointment_booking", targetId: bookingId, result: "success", metadata: { calendarId: b.calendar_id, start: new Date(b.start_at).toISOString() } }, db);
    return apptId;
  });
  // The customer hears about it through the same gate as any other AI message; if a person has taken over or messaging is paused, it simply isn't sent.
  if (b.requested_by_kind === "ai" && b.conversation_id && b.agent_id) {
    await withSystem((db) =>
      queueOutbound(db, {
        orgId, conversationId: b.conversation_id as string, scope: "reply", actor: { kind: "ai", agentId: b.agent_id, approvalId: opts.approvalId ?? b.approval_id }, now,
        body: `You're booked for ${formatSlot(new Date(b.start_at).toISOString(), b.timezone)}. We look forward to seeing you. Reply here if you need to change it.`,
        dedupeKey: `booking-confirm:${bookingId}`,
      }),
    ).catch(() => undefined);
  }
  return { status: "booked", bookingId, appointmentId: appointmentId ?? "" };
}

async function markNeedsManual(orgId: string, b: BookingRow, contactName: string, reason: string) {
  await withSystem(async (db) => {
    await db.query("update appointment_bookings set status = 'needs_manual', failure_reason = $2 where id = $1 and status in ('requested', 'awaiting_approval')", [b.id, reason.slice(0, 300)]);
    await notifyOrgRoles(db, orgId, ["owner", "admin", "sales_rep"], {
      kind: "booking_needs_action", severity: "warning", title: `Add an appointment to your calendar for ${contactName || "a customer"}`,
      body: `${formatSlot(new Date(b.start_at).toISOString(), b.timezone)}. ${reason}`, link: "/appointments", dedupeKey: `booking-manual:${b.id}`,
    });
  });
}

/** Runs when a person approves an AI-proposed booking in the Approval Center. */
export async function executeApprovedBooking(orgId: string, approvalId: string, bookingId: string): Promise<{ status: "succeeded" | "failed" | "blocked"; detail: string }> {
  const r = await executeBooking(orgId, bookingId, { approvalId });
  switch (r.status) {
    case "booked": return { status: "succeeded", detail: "The appointment was added to your calendar." };
    case "needs_manual": return { status: "blocked", detail: `Approved, but not booked automatically: ${r.reason}` };
    case "unavailable": return { status: r.reason === "blocked" ? "blocked" : "failed", detail: r.detail };
    case "failed": return { status: "failed", detail: r.reason };
    default: return { status: "failed", detail: "The booking is still waiting for approval." };
  }
}

/** A rejected proposal releases the held time straight away. */
export async function releaseRejectedBooking(orgId: string, bookingId: string) {
  await withSystem((db) => db.query("update appointment_bookings set status = 'cancelled', failure_reason = 'Not approved.' where id = $1 and org_id = $2 and status = 'awaiting_approval'", [bookingId, orgId]));
}

/** A person drops a booking that is still waiting for approval or for someone to add it to the calendar. */
export async function cancelPendingBooking(ctx: OrgContext, bookingId: string): Promise<void> {
  if (!ctx.can("appointments.book")) throw new AppError("forbidden", "You can't change bookings.");
  await withSystem(async (db) => {
    const res = await db.query<{ approval_id: string | null }>(
      "update appointment_bookings set status = 'cancelled', failure_reason = 'Cancelled by a person.' where id = $1 and org_id = $2 and status in ('awaiting_approval', 'needs_manual') returning approval_id",
      [bookingId, ctx.org.orgId],
    );
    if (!res.rows[0]) throw new AppError("not_found", "That booking can't be cancelled any more.");
    if (res.rows[0].approval_id) await db.query("update approval_requests set status = 'cancelled' where id = $1 and org_id = $2 and status = 'pending'", [res.rows[0].approval_id, ctx.org.orgId]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "appointment.booking_cancelled", targetType: "appointment_booking", targetId: bookingId, result: "success" }, db);
  });
}

/** A person books for a contact: the time must come from the calendar's own free slots, and is checked again as it is sent. */
export async function bookForContact(ctx: OrgContext, input: { contactId: string; startAt: Date; calendarId?: string | null; conversationId?: string | null; title?: string }, d: { provider?: AppointmentProvider; now?: Date } = {}): Promise<BookingResult> {
  if (!ctx.can("appointments.book")) throw new AppError("forbidden", "You can't book appointments.");
  const result = await requestBooking({ orgId: ctx.org.orgId, contactId: input.contactId, calendarId: input.calendarId ?? null, conversationId: input.conversationId ?? null, startAt: input.startAt, title: input.title, actor: { kind: "staff", userId: ctx.user.id }, now: d.now }, { provider: d.provider });
  return result;
}
