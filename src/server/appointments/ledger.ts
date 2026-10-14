import "server-only";
import type { Queryable } from "@/server/db";
import { notifyOrgRoles } from "@/server/notifications";
import { onBooking } from "@/server/messaging/followups";
import { syncRemindersFor } from "@/server/appointments/reminders";
import { appointmentDedupeKey, isLateCancellation, isLiveStatus, type AppointmentStatus, type GhlAppointmentEvent } from "@/lib/appointments";
import { formatSlot } from "@/lib/appointments";

export interface LedgerInput {
  orgId: string;
  source: "webhook" | "sync" | "portal";
  /** The delivery or run this came from. Different deliveries of the same logical event still collapse (see the dedupe key). */
  providerEventId: string;
  event: GhlAppointmentEvent;
  now?: Date;
}

export type LedgerOutcome = "applied" | "conflict" | "stale" | "ignored" | "duplicate" | "failed";
export interface LedgerResult {
  outcome: LedgerOutcome;
  appointmentId?: string;
  detail?: string;
}

interface Row {
  id: string;
  status: AppointmentStatus;
  start_at: Date;
  end_at: Date;
  ghl_calendar_id: string;
  assigned_ghl_user_id: string | null;
  last_event_at: Date | null;
  cancelled_at: Date | null;
  reschedule_count: number;
  contact_id: string | null;
  title: string;
}

const LIFECYCLE_BEFORE_APPOINTMENT = ["lead_captured", "validated", "qualified", "follow_up"];

/**
 * Applies one appointment event to the portal's record of that appointment, in order of the provider's own clock.
 *
 * - The same logical event twice changes nothing and is not recorded twice.
 * - An event older than what we already know is kept in the ledger as stale and never overwrites newer state, so a late
 *   cancellation, a delayed update or a retry that arrives out of order cannot undo what actually happened last.
 * - A delete that arrives before its create is remembered by the ledger, so the create that follows is recognised as stale.
 * - Concurrent events for one appointment are serialised by a lock, so two workers cannot interleave half-applied states.
 * Runs inside the caller's transaction.
 */
export async function applyAppointmentEvent(db: Queryable, input: LedgerInput): Promise<LedgerResult> {
  const e = input.event;
  const now = input.now ?? new Date();
  const orgId = input.orgId;
  const dedupeKey = appointmentDedupeKey(e);

  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`appt:${orgId}:${e.appointmentId}`]);

  const dup = await db.query("select 1 from appointment_events where org_id = $1 and dedupe_key = $2", [orgId, dedupeKey]);
  if (dup.rows[0]) return { outcome: "duplicate" };

  const record = async (outcome: Exclude<LedgerOutcome, "duplicate">, detail: string | null, appointmentId: string | null) => {
    await db.query(
      `insert into appointment_events (org_id, source, provider_event_id, dedupe_key, kind, ghl_appointment_id, ghl_calendar_id, ghl_contact_id, appointment_id,
         event_time, appointment_status, start_at, end_at, outcome, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [orgId, input.source, input.providerEventId.slice(0, 200), dedupeKey, e.kind, e.appointmentId, e.calendarId, e.contactId, appointmentId, e.eventTime.toISOString(), e.status,
        e.startAt?.toISOString() ?? null, e.endAt?.toISOString() ?? null, outcome, detail?.slice(0, 300) ?? null],
    );
    return { outcome, appointmentId: appointmentId ?? undefined, detail: detail ?? undefined } as LedgerResult;
  };

  const { rows } = await db.query<Row>(
    `select id, status, start_at, end_at, ghl_calendar_id, assigned_ghl_user_id, last_event_at, cancelled_at, reschedule_count, contact_id, title
     from appointment_refs where org_id = $1 and ghl_appointment_id = $2 for update`,
    [orgId, e.appointmentId],
  );
  const cur = rows[0] ?? null;

  // A delete we already know about, at or after this event's time, outranks it: the appointment was removed.
  if (e.kind !== "delete") {
    const del = await db.query(
      "select 1 from appointment_events where org_id = $1 and ghl_appointment_id = $2 and kind = 'delete' and outcome in ('applied', 'conflict', 'ignored') and event_time >= $3 limit 1",
      [orgId, e.appointmentId, e.eventTime.toISOString()],
    );
    if (del.rows[0]) return record("stale", "A later deletion of this appointment is already recorded.", cur?.id ?? null);
  }
  if (cur?.last_event_at) {
    const known = new Date(cur.last_event_at).getTime();
    if (known > e.eventTime.getTime()) return record("stale", "A newer change to this appointment is already recorded.", cur.id);
    // Same instant but we would be reviving something already cancelled: nothing proves which came last, so cancellation stands.
    if (known === e.eventTime.getTime() && cur.status === "cancelled" && e.kind !== "delete" && e.status !== "cancelled") {
      return record("stale", "Cancelled at the same moment; the cancellation is kept.", cur.id);
    }
  }

  const settings = (await db.query<{ late_cancel_hours: number | null; reminders_enabled: boolean }>("select late_cancel_hours, reminders_enabled from appointment_settings where org_id = $1", [orgId])).rows[0];

  if (e.kind === "delete") {
    if (!cur) return record("ignored", "Deleted before this portal ever saw it.", null);
    const cancelledAt = cur.status === "cancelled" && cur.cancelled_at ? new Date(cur.cancelled_at) : e.eventTime;
    const late = cur.status !== "cancelled" && isLateCancellation(new Date(cur.start_at), e.eventTime, settings?.late_cancel_hours);
    await db.query(
      `update appointment_refs set status = 'cancelled', deleted_remote = true, cancelled_at = $3, late_cancellation = late_cancellation or $4,
         last_event_at = $5, remote_updated_at = $5, conflict = false, synced_at = now() where id = $1 and org_id = $2`,
      [cur.id, orgId, cancelledAt.toISOString(), late, e.eventTime.toISOString()],
    );
    await afterCancel(db, orgId, cur, late, now);
    await recomputeConflicts(db, orgId, cur.ghl_calendar_id, new Date(cur.start_at), new Date(cur.end_at));
    await syncRemindersFor(db, orgId, cur.id, now);
    return record("applied", late ? "Deleted close to the start time (late cancellation)." : "Deleted.", cur.id);
  }

  const startAt = e.startAt!;
  const endAt = e.endAt!;
  const calendarId = e.calendarId ?? cur?.ghl_calendar_id;
  if (!calendarId) return record("ignored", "The event named no calendar.", cur?.id ?? null);

  const contact = e.contactId
    ? (await db.query<{ id: string; timezone: string | null }>("select id, timezone from contacts where org_id = $1 and ghl_contact_id = $2 and deleted_at is null", [orgId, e.contactId])).rows[0] ?? null
    : null;
  const org = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId])).rows[0];
  const timezone = contact?.timezone ?? org?.timezone ?? "UTC";
  const link = e.address && /^https:\/\//.test(e.address) ? e.address.slice(0, 500) : null;
  const live = isLiveStatus(e.status);

  let id: string;
  let becameCancelled = false;
  let late = false;
  let rescheduled = false;
  let created = false;
  if (!cur) {
    created = true;
    becameCancelled = e.status === "cancelled";
    late = becameCancelled && isLateCancellation(startAt, e.eventTime, settings?.late_cancel_hours);
    const ins = await db.query<{ id: string }>(
      `insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, timezone, meeting_link, contact_id, ghl_contact_id,
         assigned_ghl_user_id, origin, cancelled_at, late_cancellation, last_event_at, remote_updated_at, synced_at, contact_label)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, now(), $17) returning id`,
      [orgId, e.appointmentId, calendarId, e.title, e.status, startAt.toISOString(), endAt.toISOString(), timezone, link, contact?.id ?? null, e.contactId, e.assignedUserId,
        input.source === "webhook" ? "webhook" : "sync", becameCancelled ? e.eventTime.toISOString() : null, late, e.eventTime.toISOString(), null],
    );
    id = ins.rows[0].id;
  } else {
    id = cur.id;
    const wasLive = isLiveStatus(cur.status);
    becameCancelled = cur.status !== "cancelled" && e.status === "cancelled";
    const revived = cur.status === "cancelled" && e.status !== "cancelled" && live;
    rescheduled = wasLive && live && new Date(cur.start_at).getTime() !== startAt.getTime();
    late = becameCancelled && isLateCancellation(new Date(cur.start_at), e.eventTime, settings?.late_cancel_hours);
    await db.query(
      `update appointment_refs set ghl_calendar_id = $3, title = $4, status = $5, start_at = $6, end_at = $7, meeting_link = coalesce($8, meeting_link),
         contact_id = coalesce($9, contact_id), ghl_contact_id = coalesce($10, ghl_contact_id), assigned_ghl_user_id = coalesce($11, assigned_ghl_user_id),
         timezone = coalesce(timezone, $12), last_event_at = $13, remote_updated_at = $13, synced_at = now(),
         reschedule_count = reschedule_count + $14::int, previous_start_at = case when $14::int = 1 then start_at else previous_start_at end,
         cancelled_at = case when $15 then $13 when $16 then null else cancelled_at end,
         late_cancellation = case when $15 then $17 when $16 then false else late_cancellation end,
         deleted_remote = case when $16 then false else deleted_remote end
       where id = $1 and org_id = $2`,
      [id, orgId, calendarId, e.title, e.status, startAt.toISOString(), endAt.toISOString(), link, contact?.id ?? null, e.contactId, e.assignedUserId, timezone, e.eventTime.toISOString(),
        rescheduled ? 1 : 0, becameCancelled, revived, late],
    );
  }

  const windowStart = cur ? new Date(Math.min(new Date(cur.start_at).getTime(), startAt.getTime())) : startAt;
  const windowEnd = cur ? new Date(Math.max(new Date(cur.end_at).getTime(), endAt.getTime())) : endAt;
  await recomputeConflicts(db, orgId, calendarId, windowStart, windowEnd);
  const flagged = live && (await db.query<{ conflict: boolean }>("select conflict from appointment_refs where id = $1", [id])).rows[0]?.conflict === true;

  // What the change means for people and for automation.
  const contactId = contact?.id ?? cur?.contact_id ?? null;
  const when = formatSlot(startAt.toISOString(), timezone);
  if (live && contactId) {
    await onBooking(db, orgId, contactId);
    await db.query(
      "update contacts set lifecycle_stage = 'appointment' where org_id = $1 and id = $2 and lifecycle_stage = any($3::text[])",
      [orgId, contactId, LIFECYCLE_BEFORE_APPOINTMENT],
    );
  }
  if (live && contactId) {
    // The calendar itself now shows this booking, so a request waiting for someone to add it by hand is done. A booking is only
    // ever marked booked because the provider's own record says so.
    await db.query(
      `update appointment_bookings set status = 'booked', ghl_appointment_id = $5, appointment_id = $6, booked_at = now()
       where org_id = $1 and contact_id = $2 and calendar_id = $3 and start_at = $4 and status in ('requested', 'needs_manual')`,
      [orgId, contactId, calendarId, startAt.toISOString(), e.appointmentId, id],
    );
  }
  if (created && live) {
    await notifyOrgRoles(db, orgId, ["owner", "admin", "sales_rep"], { kind: "booking_confirmed", severity: "success", title: `New appointment: ${e.title}`, body: when, link: "/appointments", dedupeKey: `appt:${id}:created` });
  }
  if (becameCancelled) await afterCancel(db, orgId, { id, title: e.title, start_at: startAt, contact_id: contactId } as Row, late, now);
  if (rescheduled) {
    await notifyOrgRoles(db, orgId, ["owner", "admin", "sales_rep"], { kind: "booking_rescheduled", severity: "info", title: `Appointment moved: ${e.title}`, body: `Now ${when}.`, link: "/appointments", dedupeKey: `appt:${id}:moved:${e.eventTime.getTime()}` });
  }
  if (flagged) {
    await notifyOrgRoles(db, orgId, ["owner", "admin"], { kind: "booking_conflict", severity: "warning", title: `Two appointments overlap: ${e.title}`, body: `${when}. Check your calendar and move one of them.`, link: "/appointments", dedupeKey: `appt:${id}:conflict:${startAt.getTime()}` });
  }
  await syncRemindersFor(db, orgId, id, now);
  const detail = created ? "Recorded a new appointment." : becameCancelled ? (late ? "Cancelled close to the start time (late cancellation)." : "Cancelled.") : rescheduled ? "Moved to a new time." : "Updated.";
  return record(flagged ? "conflict" : "applied", flagged ? `${detail} It overlaps another appointment for the same person.` : detail, id);
}

async function afterCancel(db: Queryable, orgId: string, a: Pick<Row, "id" | "title" | "start_at" | "contact_id">, late: boolean, now: Date) {
  void now;
  await notifyOrgRoles(db, orgId, ["owner", "admin", "sales_rep"], {
    kind: "booking_cancelled",
    severity: late ? "warning" : "info",
    title: `${late ? "Late cancellation" : "Appointment cancelled"}: ${a.title}`,
    body: late ? "This was cancelled close to the start time." : undefined,
    link: "/appointments",
    dedupeKey: `appt:${a.id}:cancelled`,
  });
}

/**
 * Recomputes the overlap flag for live appointments on a calendar near a changed time. Two appointments only conflict when they
 * are for the same named person: a calendar that seats several people at once is not a clash.
 */
export async function recomputeConflicts(db: Queryable, orgId: string, calendarId: string, from: Date, to: Date) {
  await db.query(
    `update appointment_refs a set conflict = exists (
       select 1 from appointment_refs b where b.org_id = a.org_id and b.ghl_calendar_id = a.ghl_calendar_id and b.id <> a.id
         and b.status not in ('cancelled', 'invalid') and a.assigned_ghl_user_id is not null and b.assigned_ghl_user_id = a.assigned_ghl_user_id
         and b.start_at < a.end_at and a.start_at < b.end_at)
     where a.org_id = $1 and a.ghl_calendar_id = $2 and a.start_at < $4 and a.end_at > $3`,
    [orgId, calendarId, from.toISOString(), to.toISOString()],
  );
  await db.query("update appointment_refs set conflict = false where org_id = $1 and ghl_calendar_id = $2 and status in ('cancelled', 'invalid') and conflict", [orgId, calendarId]);
}
