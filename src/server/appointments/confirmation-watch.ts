import "server-only";
import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { queueOutbound } from "@/server/messaging/send";
import { launchNotificationsOn } from "@/server/setup/launch-notifications";
import { formatSlot } from "@/lib/appointments";

// What a customer is told about an appointment, and who is reminded when one is waiting for a person.
//
// A native appointment type can say "a person confirms each booking". The appointment is then on the calendar as `new` (the time is held) but nobody has said yes. Until a person
// does, nothing may call it booked or confirmed, to the customer or to the staff member who asked for it. The wording lives here so the AI booking flow, the customer reply and the
// confirmation message all use the same words, and the strings are reviewed in one place.

/** The appointment states a booking result can carry: waiting for a person (`new`) or confirmed. */
export type BookedAppointmentStatus = "new" | "confirmed";

/** The customer's message while a person has yet to confirm. Says "reserved", never "booked" or "confirmed". */
export const reservedText = (when: string) => `We've reserved ${when} for you. The team will confirm it shortly. Reply here if you need to change it.`;

/** The customer's message when the booking is confirmed at once (the type does not need a person's yes). Unchanged from before. */
export const bookedText = (when: string) => `You're booked for ${when}. We look forward to seeing you. Reply here if you need to change it.`;

/** The customer's message after the host confirms a booking that was waiting. */
export const hostConfirmedText = (when: string) => `Good news: ${when} is now confirmed. We look forward to seeing you. Reply here if you need to change it.`;

/** The customer text for a booking that landed, by the appointment's own status. */
export const bookingCustomerText = (status: BookedAppointmentStatus, when: string) => (status === "new" ? reservedText(when) : bookedText(when));

/**
 * The dedupe key of the one message a booking sends when it lands: "requested" while a person has yet to confirm, "confirm" when it is confirmed at once. The host's later confirmation
 * uses "confirm" too, so a booking can never send two confirmations: it sends the first only if the type needed no person, and the second only when a person said yes.
 */
export const bookingMessageKey = (bookingId: string, status: BookedAppointmentStatus) => `${status === "new" ? "booking-requested" : "booking-confirm"}:${bookingId}`;

/**
 * Tells the customer that the host confirmed their booking, once. Only a native booking that an AI employee made from a conversation has anyone to tell. The message goes through the same
 * rule chain as every other AI message with NO approval attached: an employee that needs approval leaves a draft for a person, and nothing is sent until then. Safe to call again: the
 * dedupe key means a second call finds the first message and does nothing.
 */
export async function queueHostConfirmationMessage(orgId: string, appointmentId: string, opts: { now?: Date } = {}): Promise<{ queued: boolean; status?: "queued" | "draft" | "blocked" }> {
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    // The time comes from the live appointment, never from the booking row: the booking keeps the time it was made for, and a waiting appointment can be moved before a person confirms it. The zone is the customer's, as in the reserved message.
    const { rows } = await db.query<{ id: string; conversation_id: string; agent_id: string; start_at: Date; timezone: string; appt_status: string }>(
      `select b.id, b.conversation_id, b.agent_id, a.start_at, coalesce(a.invitee_timezone, b.timezone) as timezone, a.status as appt_status
         from appointment_bookings b join appointment_refs a on a.id = b.appointment_id and a.org_id = b.org_id
        where b.org_id = $1 and b.appointment_id = $2 and b.provider = 'native' and b.status = 'booked' and b.requested_by_kind = 'ai' and b.conversation_id is not null and b.agent_id is not null`,
      [orgId, appointmentId],
    );
    const booking = rows[0];
    if (!booking) return { queued: false };
    const key = bookingMessageKey(booking.id, "confirmed");
    const already = await db.query("select 1 from conversation_messages where org_id = $1 and dedupe_key = $2", [orgId, key]);
    if (already.rows[0]) return { queued: false };
    // Nothing is said about a time that is no longer an upcoming, confirmed appointment (cancelled, moved into the past, already started): the team is left to speak to the customer.
    if (booking.appt_status !== "confirmed" || new Date(booking.start_at).getTime() <= now.getTime()) {
      await recordAudit({ orgId, actorKind: "system", action: "appointment.host_confirmation_message", targetType: "appointment", targetId: appointmentId, result: "denied", metadata: { messageStatus: "not_sent", reason: "no_longer_upcoming" } }, db);
      return { queued: false };
    }
    const result = await queueOutbound(db, {
      orgId, conversationId: booking.conversation_id, scope: "reply", actor: { kind: "ai", agentId: booking.agent_id }, now,
      body: hostConfirmedText(formatSlot(new Date(booking.start_at).toISOString(), booking.timezone)), dedupeKey: key,
    });
    await recordAudit({ orgId, actorKind: "system", action: "appointment.host_confirmation_message", targetType: "appointment", targetId: appointmentId, result: result.status === "blocked" ? "denied" : "success", metadata: { messageStatus: result.status, reason: result.reason ?? null } }, db);
    return { queued: true, status: result.status };
  });
}

/** A booking waiting for a person is flagged once it has waited this long, or once it starts within this long. */
export const STALE_CONFIRMATION_HOURS = 24;

/**
 * Reminds people about native bookings that are still waiting for a person's yes: ones that have waited a day, or that start within a day. The owners and admins and the booking's own
 * hosts are told, once per appointment per day (the notification's dedupe key), so a booking nobody looks at is not lost quietly and nobody is nagged by the minute. Suspended and archived
 * workspaces are skipped, and so is any workspace where launch notices are off (the default). Writes only notifications; it confirms and cancels nothing.
 */
export async function runStaleConfirmationWatch(opts: { now?: Date; limit?: number } = {}): Promise<{ checked: number; notified: number }> {
  const now = opts.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; title: string; start_at: Date; timezone: string }>(
      `select a.id, a.org_id, a.title, a.start_at, a.timezone
         from appointment_refs a join organizations o on o.id = a.org_id
        where a.provider = 'native' and a.status = 'new' and a.start_at > $1::timestamptz and o.status not in ('suspended', 'archived')
          and (a.created_at <= $1::timestamptz - make_interval(hours => $3::int) or a.start_at <= $1::timestamptz + make_interval(hours => $3::int))
        order by a.start_at limit $2`,
      [now.toISOString(), Math.min(500, opts.limit ?? 200), STALE_CONFIRMATION_HOURS],
    );
    let notified = 0;
    // The reminders are new, so a workspace gets them only where launch notices are on (src/server/setup/launch-notifications.ts): switching the scheduler on must not start telling a
    // client that was already using the product about bookings it has lived with. Read once per workspace.
    const allowed = new Map<string, boolean>();
    for (const a of rows) {
      if (!allowed.has(a.org_id)) allowed.set(a.org_id, await launchNotificationsOn(a.org_id, db));
      if (!allowed.get(a.org_id)) continue;
      const dedupeKey = `booking-confirm-stale:${a.id}:${day}`;
      const done = await db.query("select 1 from notifications where org_id = $1 and dedupe_key = $2 limit 1", [a.org_id, dedupeKey]);
      if (done.rows[0]) continue;
      const notice = {
        kind: "booking_needs_action" as const, severity: "warning" as const, title: "A booking is waiting for a person to confirm it",
        body: `${a.title} on ${formatSlot(new Date(a.start_at).toISOString(), a.timezone)} has not been confirmed yet. The customer was told the team will confirm it.`,
        link: `/crm/calendar?appointment=${a.id}`, dedupeKey,
      };
      await notifyOrgRoles(db, a.org_id, ["owner", "admin"], notice);
      const hosts = await db.query<{ user_id: string }>("select user_id from crm_appointment_hosts where appointment_id = $1 and org_id = $2", [a.id, a.org_id]);
      for (const host of hosts.rows) await notifyUser(db, host.user_id, a.org_id, notice);
      notified += 1;
    }
    return { checked: rows.length, notified };
  });
}
