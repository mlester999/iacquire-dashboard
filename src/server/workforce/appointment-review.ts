import "server-only";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";

const samples = (value: unknown) => (Array.isArray(value) ? (value as string[]).filter((item) => typeof item === "string") : []);

const awaitingApproval: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(title order by start_at asc), '{}') as samples
       from appointment_bookings
      where org_id = $1 and status = 'awaiting_approval' and created_at < now() - interval '24 hours'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "bookings_awaiting_approval",
    severity: "warning",
    title: `${count} booking${count === 1 ? " is" : "s are"} waiting over a day for approval`,
    detail: "Nothing has been confirmed with the customer while the request waits. The approved calendar write has not happened.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/appointments",
    recommendedAction: "Review the proposed slot and approve, reject or ask for a different time.",
    requiresApproval: false,
  });
};

const manualBookings: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(title order by start_at asc), '{}') as samples
       from appointment_bookings
      where org_id = $1 and status = 'needs_manual'
        and start_at between now() and now() + interval '7 days'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "manual_bookings_upcoming",
    severity: "warning",
    title: `${count} upcoming booking${count === 1 ? " needs" : "s need"} manual calendar entry`,
    detail: "The portal cannot complete these provider writes, so a person must book them before the appointment.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/appointments",
    recommendedAction: "Book the slot in the calendar by hand and record the confirmation in the portal.",
    requiresApproval: false,
  });
};

const stuckRequests: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(title order by created_at asc), '{}') as samples
       from appointment_bookings
      where org_id = $1 and status = 'requested' and created_at < now() - interval '2 hours'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "stuck_booking_requests",
    severity: "warning",
    title: `${count} booking request${count === 1 ? " has" : "s have"} been pending for over 2 hours`,
    detail: "The booking has not reached a confirmed state. The portal does not claim it is booked.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/appointments",
    recommendedAction: "Check the provider connection and the booking detail, then retry or book manually.",
    requiresApproval: false,
  });
};

const unassignedUpcoming: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(title order by start_at asc), '{}') as samples
       from appointment_bookings
      where org_id = $1 and status = 'booked'
        and start_at between now() and now() + interval '7 days'
        and assigned_user_id is null
        and (assigned_ghl_user_id is null or btrim(assigned_ghl_user_id) = '')`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "upcoming_unassigned",
    severity: "info",
    title: `${count} confirmed appointment${count === 1 ? " has" : "s have"} no assigned person`,
    detail: "A confirmed booking without an owner can leave nobody responsible for preparing or attending.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/appointments",
    recommendedAction: "Assign the person responsible, or confirm the meeting is intentionally unassigned.",
    requiresApproval: false,
  });
};

export async function runAppointmentReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "appointment_review",
    allowedRoles: ["appointment_setter"],
    scanningMessage: "Reading persisted appointment requests, confirmations and ownership…",
    analyzingMessage: "Assessing booking risks and preparing recommended next actions…",
    checks: [awaitingApproval, manualBookings, stuckRequests, unassignedUpcoming],
    limitations: "Only appointment records stored in this workspace were read. No calendar provider was contacted and no booking was confirmed, moved or cancelled.",
    subject: "Appointment",
  });
}
