import "server-only";
import { withSystem } from "@/server/db";
import { notifyOrgRoles } from "@/server/notifications";

/**
 * Releases times that were held for a booking nobody finished. A held time blocks everyone else, so a hold that can no longer
 * turn into an appointment must not linger: a declined or expired approval, a send that was abandoned, or a booking nobody added
 * to the calendar by hand within a day.
 */
export async function expireBookingHolds(now = new Date()): Promise<number> {
  return withSystem(async (db) => {
    const at = now.toISOString();
    const declined = await db.query(
      `update appointment_bookings b set status = 'cancelled', failure_reason = 'The approval expired or was declined.'
       where b.status = 'awaiting_approval' and exists (select 1 from approval_requests a where a.id = b.approval_id and a.status in ('expired', 'rejected', 'cancelled', 'changes_requested'))`,
    );
    const abandoned = await db.query(
      `update appointment_bookings set status = 'failed', failure_reason = 'The booking was not completed, so the time was released.'
       where status = 'requested' and updated_at < $1::timestamptz - interval '15 minutes' and (claimed_at is null or claimed_at < $1::timestamptz - interval '15 minutes')`,
      [at],
    );
    const manual = await db.query<{ id: string; org_id: string }>(
      `update appointment_bookings set status = 'cancelled', failure_reason = 'Nobody added it to the calendar within a day, so the time was released.'
       where status = 'needs_manual' and updated_at < $1::timestamptz - interval '24 hours' returning id, org_id`,
      [at],
    );
    for (const m of manual.rows) {
      await notifyOrgRoles(db, m.org_id, ["owner", "admin"], { kind: "booking_needs_action", severity: "warning", title: "A requested appointment was never added to the calendar", body: "The time was released. Contact the customer to rebook.", link: "/appointments", dedupeKey: `booking-manual-expired:${m.id}` });
    }
    return declined.rowCount + abandoned.rowCount + manual.rowCount;
  });
}
