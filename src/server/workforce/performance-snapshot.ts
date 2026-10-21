import "server-only";
import type { Queryable } from "@/server/db";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck, type ReviewMetric } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";

const n = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

async function scalar(db: Queryable, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ count: number }>(sql, params);
  return n(rows[0]?.count);
}

const noLeadFlow: ReviewCheck = async (db, job) => {
  const count = await scalar(db, "select count(*)::int as count from leads where org_id = $1 and created_at >= now() - interval '30 days'", [job.org_id]);
  if (count > 0) return null;
  return reviewFinding({
    key: "no_lead_flow",
    severity: "info",
    title: "No leads were created in the last 30 days",
    detail: "The measured count is zero. This may be intentional; the review does not infer the cause or set a target.",
    count: 1,
    samples: [],
    evidenceHref: "/leads",
    recommendedAction: "Check whether lead research or intake is expected to be active, then run or approve the appropriate work.",
    requiresApproval: false,
  });
};

const aiFailureRate: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ total: number; failed: number }>(
    `select count(*)::int as total,
            count(*) filter (where status in ('failed', 'timeout', 'interrupted'))::int as failed
       from agent_runs
      where org_id = $1 and started_at >= now() - interval '30 days'`,
    [job.org_id],
  );
  const total = n(rows[0]?.total);
  const failed = n(rows[0]?.failed);
  if (total < 5 || failed / total < 0.2) return null;
  return reviewFinding({
    key: "ai_run_failure_rate",
    severity: "warning",
    title: `${failed} of ${total} AI runs did not complete (${Math.round((failed / total) * 100)}%)`,
    detail: "This is above the 20% review threshold used by this review. It is a review prompt, not a business benchmark.",
    count: failed,
    samples: [],
    evidenceHref: "/activity",
    recommendedAction: "Read the recorded failure reasons and fix the connection or configuration before scaling AI work.",
    requiresApproval: false,
  });
};

const unvaluedPipeline: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(name order by created_at asc), '{}') as samples
       from crm_opportunities
      where org_id = $1 and status = 'open' and archived_at is null and monetary_value is null`,
    [job.org_id],
  );
  const count = n(rows[0]?.count);
  if (!count) return null;
  return reviewFinding({
    key: "unvalued_open_pipeline",
    severity: "info",
    title: `${count} open deal${count === 1 ? " cannot" : "s cannot"} contribute to pipeline value`,
    detail: "The value is missing from the record. The KPI excludes it rather than estimating it.",
    count,
    samples: Array.isArray(rows[0]?.samples) ? rows[0].samples : [],
    evidenceHref: "/crm/pipelines",
    recommendedAction: "Record an approved value, or keep the deal out of value reporting.",
    requiresApproval: false,
  });
};

const noConfirmedAppointments: ReviewCheck = async (db, job) => {
  const confirmed = await scalar(
    db,
    "select count(*)::int as count from appointment_bookings where org_id = $1 and status = 'booked' and booked_at >= now() - interval '30 days'",
    [job.org_id],
  );
  if (confirmed > 0) return null;
  const pending = await scalar(
    db,
    "select count(*)::int as count from appointment_bookings where org_id = $1 and status in ('awaiting_approval', 'requested', 'needs_manual')",
    [job.org_id],
  );
  if (pending === 0) return null;
  return reviewFinding({
    key: "no_confirmed_appointments",
    severity: "warning",
    title: `No appointments were confirmed in the last 30 days while ${pending} request${pending === 1 ? " is" : "s are"} incomplete`,
    detail: "The measured confirmation count is zero. The review does not claim the requests were ignored.",
    count: pending,
    samples: [],
    evidenceHref: "/appointments",
    recommendedAction: "Review the pending booking requests and complete or decline them.",
    requiresApproval: false,
  });
};

async function metrics(db: Queryable, job: WorkJobRow): Promise<ReviewMetric[]> {
  const leadRows = await db.query<{ created: number; approved: number; pending: number; rejected: number }>(
    `select
       count(*) filter (where created_at >= now() - interval '30 days')::int as created,
       count(*) filter (where review_status = 'approved' and reviewed_at >= now() - interval '30 days')::int as approved,
       count(*) filter (where review_status = 'pending')::int as pending,
       count(*) filter (where review_status = 'rejected' and reviewed_at >= now() - interval '30 days')::int as rejected
     from leads where org_id = $1`,
    [job.org_id],
  );
  const contactRows = await db.query<{ count: number }>(
    "select count(*)::int as count from contacts where org_id = $1 and deleted_at is null and created_at >= now() - interval '30 days'",
    [job.org_id],
  );
  const appointmentRows = await db.query<{ booked: number; upcoming: number }>(
    `select
       count(*) filter (where status = 'booked' and booked_at >= now() - interval '30 days')::int as booked,
       count(*) filter (where status = 'booked' and start_at between now() and now() + interval '7 days')::int as upcoming
     from appointment_bookings where org_id = $1`,
    [job.org_id],
  );
  const dealRows = await db.query<{ open: number; won: number; lost: number }>(
    `select
       count(*) filter (where status = 'open' and archived_at is null)::int as open,
       count(*) filter (where status = 'won' and closed_at >= now() - interval '30 days')::int as won,
       count(*) filter (where status = 'lost' and closed_at >= now() - interval '30 days')::int as lost
     from crm_opportunities where org_id = $1`,
    [job.org_id],
  );
  const runRows = await db.query<{ completed: number; failed: number }>(
    `select
       count(*) filter (where status = 'completed')::int as completed,
       count(*) filter (where status in ('failed', 'timeout', 'interrupted'))::int as failed
     from agent_runs where org_id = $1 and started_at >= now() - interval '30 days'`,
    [job.org_id],
  );
  const lead = leadRows.rows[0];
  const appointment = appointmentRows.rows[0];
  const deal = dealRows.rows[0];
  const runs = runRows.rows[0];
  const last30 = { period: "Last 30 days", source: "Persisted workspace records" };
  return [
    { key: "leads_created", label: "Leads created", value: n(lead?.created), period: last30.period, definition: "Lead rows created in the period.", source: "leads" },
    { key: "leads_approved", label: "Leads approved", value: n(lead?.approved), period: last30.period, definition: "Leads approved by a person in the period.", source: "leads" },
    { key: "leads_pending", label: "Leads awaiting review", value: n(lead?.pending), period: "Current", definition: "Lead rows still pending human review.", source: "leads" },
    { key: "leads_rejected", label: "Leads rejected", value: n(lead?.rejected), period: last30.period, definition: "Leads rejected by a person in the period.", source: "leads" },
    { key: "contacts_created", label: "Contacts created", value: n(contactRows.rows[0]?.count), period: last30.period, definition: "Active contact rows created in the period.", source: "contacts" },
    { key: "appointments_booked", label: "Appointments confirmed", value: n(appointment?.booked), period: last30.period, definition: "Bookings whose provider confirmation was recorded in the period.", source: "appointment_bookings" },
    { key: "appointments_upcoming", label: "Upcoming appointments", value: n(appointment?.upcoming), period: "Next 7 days", definition: "Confirmed bookings starting in the next seven days.", source: "appointment_bookings" },
    { key: "open_deals", label: "Open deals", value: n(deal?.open), period: "Current", definition: "Opportunities currently open and not archived.", source: "crm_opportunities" },
    { key: "deals_won", label: "Deals won", value: n(deal?.won), period: last30.period, definition: "Opportunities marked won with a close time in the period.", source: "crm_opportunities" },
    { key: "deals_lost", label: "Deals lost", value: n(deal?.lost), period: last30.period, definition: "Opportunities marked lost with a close time in the period.", source: "crm_opportunities" },
    { key: "ai_runs_completed", label: "AI runs completed", value: n(runs?.completed), period: last30.period, definition: "Agent runs recorded as completed in the period.", source: "agent_runs" },
    { key: "ai_runs_failed", label: "AI runs failed", value: n(runs?.failed), period: last30.period, definition: "Agent runs recorded as failed, timed out or interrupted in the period.", source: "agent_runs" },
  ];
}

export async function runPerformanceSnapshotJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "performance_snapshot",
    allowedRoles: ["performance_analyst"],
    scanningMessage: "Reading persisted leads, contacts, appointments, opportunities and AI runs…",
    analyzingMessage: "Calculating measured KPIs and checking only the stated anomaly thresholds…",
    checks: [noLeadFlow, aiFailureRate, unvaluedPipeline, noConfirmedAppointments],
    metrics,
    limitations: "KPIs cover only records stored in this workspace for the stated period. No provider was contacted, no estimate was produced and no metric was inferred.",
    subject: "Performance",
  });
}
