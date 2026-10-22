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

type PerformancePeriod = {
  orgId: string;
  label: string;
  previousLabel: string;
  currentStart: Date;
  currentEnd: Date;
  previousStart: Date;
  previousEnd: Date;
};

/** Use calendar-month boundaries in the workspace's own time zone when the person asks for a month. */
async function resolvePeriod(db: Queryable, job: WorkJobRow): Promise<PerformancePeriod> {
  const currentMonth = job.input.period === "current_month";
  const { rows } = await db.query<{
    current_start: Date;
    current_end: Date;
    previous_start: Date;
    previous_end: Date;
  }>(
    `with settings as (
       select coalesce(nullif(o.timezone, ''), 'UTC') as tz
         from organizations o where o.id = $1
     ), local_time as (
       select tz, timezone(tz, now()) as now_local from settings
     ), month_anchor as (
       select tz, date_trunc('month', now_local) as month_start from local_time
     )
     select
       case when $2::boolean then timezone(tz, month_start) else now() - interval '30 days' end as current_start,
       now() as current_end,
       case when $2::boolean then timezone(tz, month_start - interval '1 month') else now() - interval '60 days' end as previous_start,
       case when $2::boolean then timezone(tz, month_start) else now() - interval '30 days' end as previous_end
       from month_anchor`,
    [job.org_id, currentMonth],
  );
  const bounds = rows[0];
  if (!bounds) throw new Error("performance_period_unavailable");
  return {
    orgId: job.org_id,
    label: currentMonth ? "Current calendar month" : "Last 30 days",
    previousLabel: currentMonth ? "Previous calendar month" : "Previous 30 days",
    currentStart: bounds.current_start,
    currentEnd: bounds.current_end,
    previousStart: bounds.previous_start,
    previousEnd: bounds.previous_end,
  };
}

const noLeadFlow = (period: PerformancePeriod): ReviewCheck => async (db) => {
  const count = await scalar(
    db,
    "select count(*)::int as count from leads where org_id = $1 and created_at >= $2 and created_at < $3",
    [period.orgId, period.currentStart, period.currentEnd],
  );
  if (count > 0) return null;
  return reviewFinding({
    key: "no_lead_flow",
    severity: "info",
    title: `No leads were created in ${period.label.toLocaleLowerCase("en-US")}`,
    detail: `The measured count is zero for ${period.label.toLocaleLowerCase("en-US")}. This may be intentional; the review does not infer the cause or set a target.`,
    count: 1,
    samples: [],
    evidenceHref: "/leads",
    recommendedAction: "Check whether lead research or intake is expected to be active, then run or approve the appropriate work.",
    requiresApproval: false,
  });
};

const aiFailureRate = (period: PerformancePeriod): ReviewCheck => async (db) => {
  const { rows } = await db.query<{ total: number; failed: number }>(
    `select count(*)::int as total,
            count(*) filter (where status in ('failed', 'timeout', 'interrupted'))::int as failed
       from agent_runs
      where org_id = $1 and started_at >= $2 and started_at < $3`,
    [period.orgId, period.currentStart, period.currentEnd],
  );
  const total = n(rows[0]?.total);
  const failed = n(rows[0]?.failed);
  if (total < 5 || failed / total < 0.2) return null;
  return reviewFinding({
    key: "ai_run_failure_rate",
    severity: "warning",
    title: `${failed} of ${total} AI runs did not complete in ${period.label.toLocaleLowerCase("en-US")} (${Math.round((failed / total) * 100)}%)`,
    detail: `This is above the 20% review threshold used for ${period.label.toLocaleLowerCase("en-US")}. It is a review prompt, not a business benchmark.`,
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

const noConfirmedAppointments = (period: PerformancePeriod): ReviewCheck => async (db) => {
  const confirmed = await scalar(
    db,
    "select count(*)::int as count from appointment_bookings where org_id = $1 and status = 'booked' and booked_at >= $2 and booked_at < $3",
    [period.orgId, period.currentStart, period.currentEnd],
  );
  if (confirmed > 0) return null;
  const pending = await scalar(
    db,
    "select count(*)::int as count from appointment_bookings where org_id = $1 and status in ('awaiting_approval', 'requested', 'needs_manual')",
    [period.orgId],
  );
  if (pending === 0) return null;
  return reviewFinding({
    key: "no_confirmed_appointments",
    severity: "warning",
    title: `No appointments were confirmed in ${period.label.toLocaleLowerCase("en-US")} while ${pending} request${pending === 1 ? " is" : "s are"} incomplete`,
    detail: `The measured confirmation count is zero for ${period.label.toLocaleLowerCase("en-US")}. The review does not claim the requests were ignored.`,
    count: pending,
    samples: [],
    evidenceHref: "/appointments",
    recommendedAction: "Review the pending booking requests and complete or decline them.",
    requiresApproval: false,
  });
};

function comparison(
  value: number,
  previous: number,
  higherIsBetter: boolean,
  comparisonPeriod: string,
): Pick<ReviewMetric, "previous" | "change" | "changePct" | "trend" | "comparisonPeriod" | "higherIsBetter"> {
  const change = value - previous;
  return {
    previous,
    change,
    changePct: previous > 0 ? Math.round((change / previous) * 100) : null,
    trend: change > 0 ? "up" : change < 0 ? "down" : "flat",
    comparisonPeriod,
    higherIsBetter,
  };
}

async function metrics(db: Queryable, period: PerformancePeriod): Promise<ReviewMetric[]> {
  const range = [period.orgId, period.currentStart, period.currentEnd, period.previousStart, period.previousEnd];
  const leadRows = await db.query<{
    created: number; created_previous: number; approved: number; approved_previous: number;
    pending: number; rejected: number; rejected_previous: number;
  }>(
    `select
       count(*) filter (where created_at >= $2 and created_at < $3)::int as created,
       count(*) filter (where created_at >= $4 and created_at < $5)::int as created_previous,
       count(*) filter (where review_status = 'approved' and reviewed_at >= $2 and reviewed_at < $3)::int as approved,
       count(*) filter (where review_status = 'approved' and reviewed_at >= $4 and reviewed_at < $5)::int as approved_previous,
       count(*) filter (where review_status = 'pending')::int as pending,
       count(*) filter (where review_status = 'rejected' and reviewed_at >= $2 and reviewed_at < $3)::int as rejected,
       count(*) filter (where review_status = 'rejected' and reviewed_at >= $4 and reviewed_at < $5)::int as rejected_previous
     from leads where org_id = $1`,
    range,
  );
  const contactRows = await db.query<{ count: number; previous: number }>(
    `select
       count(*) filter (where created_at >= $2 and created_at < $3)::int as count,
       count(*) filter (where created_at >= $4 and created_at < $5)::int as previous
     from contacts where org_id = $1 and deleted_at is null`,
    range,
  );
  const appointmentRows = await db.query<{ booked: number; booked_previous: number; upcoming: number }>(
    `select
       count(*) filter (where status = 'booked' and booked_at >= $2 and booked_at < $3)::int as booked,
       count(*) filter (where status = 'booked' and booked_at >= $4 and booked_at < $5)::int as booked_previous,
       count(*) filter (where status = 'booked' and start_at between now() and now() + interval '7 days')::int as upcoming
     from appointment_bookings where org_id = $1`,
    range,
  );
  const dealRows = await db.query<{ open: number; won: number; won_previous: number; lost: number; lost_previous: number }>(
    `select
       count(*) filter (where status = 'open' and archived_at is null)::int as open,
       count(*) filter (where status = 'won' and closed_at >= $2 and closed_at < $3)::int as won,
       count(*) filter (where status = 'won' and closed_at >= $4 and closed_at < $5)::int as won_previous,
       count(*) filter (where status = 'lost' and closed_at >= $2 and closed_at < $3)::int as lost,
       count(*) filter (where status = 'lost' and closed_at >= $4 and closed_at < $5)::int as lost_previous
     from crm_opportunities where org_id = $1`,
    range,
  );
  const runRows = await db.query<{ completed: number; completed_previous: number; failed: number; failed_previous: number }>(
    `select
       count(*) filter (where status = 'completed' and started_at >= $2 and started_at < $3)::int as completed,
       count(*) filter (where status = 'completed' and started_at >= $4 and started_at < $5)::int as completed_previous,
       count(*) filter (where status in ('failed', 'timeout', 'interrupted') and started_at >= $2 and started_at < $3)::int as failed,
       count(*) filter (where status in ('failed', 'timeout', 'interrupted') and started_at >= $4 and started_at < $5)::int as failed_previous
     from agent_runs where org_id = $1`,
    range,
  );
  const lead = leadRows.rows[0];
  const contact = contactRows.rows[0];
  const appointment = appointmentRows.rows[0];
  const deal = dealRows.rows[0];
  const runs = runRows.rows[0];
  const compare = (value: number, previous: number, higherIsBetter: boolean) => comparison(value, previous, higherIsBetter, period.previousLabel);
  return [
    { key: "leads_created", label: "Leads created", value: n(lead?.created), period: period.label, definition: "Lead rows created in the period.", source: "leads", ...compare(n(lead?.created), n(lead?.created_previous), true) },
    { key: "leads_approved", label: "Leads approved", value: n(lead?.approved), period: period.label, definition: "Lead rows approved by a person in the period.", source: "leads", ...compare(n(lead?.approved), n(lead?.approved_previous), true) },
    { key: "leads_pending", label: "Leads awaiting review", value: n(lead?.pending), period: "Current", definition: "Lead rows still pending human review.", source: "leads" },
    { key: "leads_rejected", label: "Leads rejected", value: n(lead?.rejected), period: period.label, definition: "Lead rows rejected by a person in the period.", source: "leads", ...compare(n(lead?.rejected), n(lead?.rejected_previous), false) },
    { key: "contacts_created", label: "Contacts created", value: n(contact?.count), period: period.label, definition: "Active contact rows created in the period.", source: "contacts", ...compare(n(contact?.count), n(contact?.previous), true) },
    { key: "appointments_booked", label: "Appointments confirmed", value: n(appointment?.booked), period: period.label, definition: "Bookings whose provider confirmation was recorded in the period.", source: "appointment_bookings", ...compare(n(appointment?.booked), n(appointment?.booked_previous), true) },
    { key: "appointments_upcoming", label: "Upcoming appointments", value: n(appointment?.upcoming), period: "Next 7 days", definition: "Confirmed bookings starting in the next seven days.", source: "appointment_bookings" },
    { key: "open_deals", label: "Open deals", value: n(deal?.open), period: "Current", definition: "Opportunities currently open and not archived.", source: "crm_opportunities" },
    { key: "deals_won", label: "Deals won", value: n(deal?.won), period: period.label, definition: "Opportunities marked won with a close time in the period.", source: "crm_opportunities", ...compare(n(deal?.won), n(deal?.won_previous), true) },
    { key: "deals_lost", label: "Deals lost", value: n(deal?.lost), period: period.label, definition: "Opportunities marked lost with a close time in the period.", source: "crm_opportunities", ...compare(n(deal?.lost), n(deal?.lost_previous), false) },
    { key: "ai_runs_completed", label: "AI runs completed", value: n(runs?.completed), period: period.label, definition: "Agent runs recorded as completed in the period.", source: "agent_runs", ...compare(n(runs?.completed), n(runs?.completed_previous), true) },
    { key: "ai_runs_failed", label: "AI runs failed", value: n(runs?.failed), period: period.label, definition: "Agent runs recorded as failed, timed out or interrupted in the period.", source: "agent_runs", ...compare(n(runs?.failed), n(runs?.failed_previous), false) },
  ];
}

export async function runPerformanceSnapshotJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  // Resolve lazily inside the shared handler, after it verifies the employee's role. A malformed
  // job cannot query even organization settings before the capability gate passes.
  let periodPromise: Promise<PerformancePeriod> | null = null;
  const getPeriod = (db: Queryable) => {
    periodPromise ??= resolvePeriod(db, job);
    return periodPromise;
  };
  return runReadOnlyReviewJob(job, {
    capability: "performance_snapshot",
    allowedRoles: ["performance_analyst"],
    scanningMessage: "Reading persisted leads, contacts, appointments, opportunities and AI runs for the requested period…",
    analyzingMessage: "Calculating measured KPIs for the requested period and checking only the stated anomaly thresholds…",
    checks: [
      async (db) => noLeadFlow(await getPeriod(db))(db, job),
      async (db) => aiFailureRate(await getPeriod(db))(db, job),
      unvaluedPipeline,
      async (db) => noConfirmedAppointments(await getPeriod(db))(db, job),
    ],
    metrics: async (db) => metrics(db, await getPeriod(db)),
    limitations: "KPIs cover only records stored in this workspace for the requested calendar month or last 30 days, compared with the matching prior period. No provider was contacted, no estimate was produced and no metric was inferred.",
    subject: "Performance",
  });
}
