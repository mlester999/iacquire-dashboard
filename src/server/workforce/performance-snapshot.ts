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

const PERIOD = "Last 30 days";
const PREVIOUS_PERIOD = "Previous 30 days";

function comparison(value: number, previous: number, higherIsBetter: boolean): Pick<ReviewMetric, "previous" | "change" | "changePct" | "trend" | "comparisonPeriod" | "higherIsBetter"> {
  const change = value - previous;
  return {
    previous,
    change,
    changePct: previous > 0 ? Math.round((change / previous) * 100) : null,
    trend: change > 0 ? "up" : change < 0 ? "down" : "flat",
    comparisonPeriod: PREVIOUS_PERIOD,
    higherIsBetter,
  };
}

async function metrics(db: Queryable, job: WorkJobRow): Promise<ReviewMetric[]> {
  const leadRows = await db.query<{
    created: number; created_previous: number; approved: number; approved_previous: number;
    pending: number; rejected: number; rejected_previous: number;
  }>(
    `select
       count(*) filter (where created_at >= now() - interval '30 days')::int as created,
       count(*) filter (where created_at >= now() - interval '60 days' and created_at < now() - interval '30 days')::int as created_previous,
       count(*) filter (where review_status = 'approved' and reviewed_at >= now() - interval '30 days')::int as approved,
       count(*) filter (where review_status = 'approved' and reviewed_at >= now() - interval '60 days' and reviewed_at < now() - interval '30 days')::int as approved_previous,
       count(*) filter (where review_status = 'pending')::int as pending,
       count(*) filter (where review_status = 'rejected' and reviewed_at >= now() - interval '30 days')::int as rejected,
       count(*) filter (where review_status = 'rejected' and reviewed_at >= now() - interval '60 days' and reviewed_at < now() - interval '30 days')::int as rejected_previous
     from leads where org_id = $1`,
    [job.org_id],
  );
  const contactRows = await db.query<{ count: number; previous: number }>(
    `select
       count(*) filter (where created_at >= now() - interval '30 days')::int as count,
       count(*) filter (where created_at >= now() - interval '60 days' and created_at < now() - interval '30 days')::int as previous
     from contacts where org_id = $1 and deleted_at is null`,
    [job.org_id],
  );
  const appointmentRows = await db.query<{ booked: number; booked_previous: number; upcoming: number }>(
    `select
       count(*) filter (where status = 'booked' and booked_at >= now() - interval '30 days')::int as booked,
       count(*) filter (where status = 'booked' and booked_at >= now() - interval '60 days' and booked_at < now() - interval '30 days')::int as booked_previous,
       count(*) filter (where status = 'booked' and start_at between now() and now() + interval '7 days')::int as upcoming
     from appointment_bookings where org_id = $1`,
    [job.org_id],
  );
  const dealRows = await db.query<{ open: number; won: number; won_previous: number; lost: number; lost_previous: number }>(
    `select
       count(*) filter (where status = 'open' and archived_at is null)::int as open,
       count(*) filter (where status = 'won' and closed_at >= now() - interval '30 days')::int as won,
       count(*) filter (where status = 'won' and closed_at >= now() - interval '60 days' and closed_at < now() - interval '30 days')::int as won_previous,
       count(*) filter (where status = 'lost' and closed_at >= now() - interval '30 days')::int as lost,
       count(*) filter (where status = 'lost' and closed_at >= now() - interval '60 days' and closed_at < now() - interval '30 days')::int as lost_previous
     from crm_opportunities where org_id = $1`,
    [job.org_id],
  );
  const runRows = await db.query<{ completed: number; completed_previous: number; failed: number; failed_previous: number }>(
    `select
       count(*) filter (where status = 'completed' and started_at >= now() - interval '30 days')::int as completed,
       count(*) filter (where status = 'completed' and started_at >= now() - interval '60 days' and started_at < now() - interval '30 days')::int as completed_previous,
       count(*) filter (where status in ('failed', 'timeout', 'interrupted') and started_at >= now() - interval '30 days')::int as failed,
       count(*) filter (where status in ('failed', 'timeout', 'interrupted') and started_at >= now() - interval '60 days' and started_at < now() - interval '30 days')::int as failed_previous
     from agent_runs where org_id = $1`,
    [job.org_id],
  );
  const lead = leadRows.rows[0];
  const contact = contactRows.rows[0];
  const appointment = appointmentRows.rows[0];
  const deal = dealRows.rows[0];
  const runs = runRows.rows[0];
  return [
    { key: "leads_created", label: "Leads created", value: n(lead?.created), period: PERIOD, definition: "Lead rows created in the period.", source: "leads", ...comparison(n(lead?.created), n(lead?.created_previous), true) },
    { key: "leads_approved", label: "Leads approved", value: n(lead?.approved), period: PERIOD, definition: "Leads approved by a person in the period.", source: "leads", ...comparison(n(lead?.approved), n(lead?.approved_previous), true) },
    { key: "leads_pending", label: "Leads awaiting review", value: n(lead?.pending), period: "Current", definition: "Lead rows still pending human review.", source: "leads" },
    { key: "leads_rejected", label: "Leads rejected", value: n(lead?.rejected), period: PERIOD, definition: "Leads rejected by a person in the period.", source: "leads", ...comparison(n(lead?.rejected), n(lead?.rejected_previous), false) },
    { key: "contacts_created", label: "Contacts created", value: n(contact?.count), period: PERIOD, definition: "Active contact rows created in the period.", source: "contacts", ...comparison(n(contact?.count), n(contact?.previous), true) },
    { key: "appointments_booked", label: "Appointments confirmed", value: n(appointment?.booked), period: PERIOD, definition: "Bookings whose provider confirmation was recorded in the period.", source: "appointment_bookings", ...comparison(n(appointment?.booked), n(appointment?.booked_previous), true) },
    { key: "appointments_upcoming", label: "Upcoming appointments", value: n(appointment?.upcoming), period: "Next 7 days", definition: "Confirmed bookings starting in the next seven days.", source: "appointment_bookings" },
    { key: "open_deals", label: "Open deals", value: n(deal?.open), period: "Current", definition: "Opportunities currently open and not archived.", source: "crm_opportunities" },
    { key: "deals_won", label: "Deals won", value: n(deal?.won), period: PERIOD, definition: "Opportunities marked won with a close time in the period.", source: "crm_opportunities", ...comparison(n(deal?.won), n(deal?.won_previous), true) },
    { key: "deals_lost", label: "Deals lost", value: n(deal?.lost), period: PERIOD, definition: "Opportunities marked lost with a close time in the period.", source: "crm_opportunities", ...comparison(n(deal?.lost), n(deal?.lost_previous), false) },
    { key: "ai_runs_completed", label: "AI runs completed", value: n(runs?.completed), period: PERIOD, definition: "Agent runs recorded as completed in the period.", source: "agent_runs", ...comparison(n(runs?.completed), n(runs?.completed_previous), true) },
    { key: "ai_runs_failed", label: "AI runs failed", value: n(runs?.failed), period: PERIOD, definition: "Agent runs recorded as failed, timed out or interrupted in the period.", source: "agent_runs", ...comparison(n(runs?.failed), n(runs?.failed_previous), false) },
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
