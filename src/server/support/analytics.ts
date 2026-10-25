import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import { PRIORITIES, REQUEST_TYPES, TICKET_STATUSES, type RequestType, type TicketPriority, type TicketStatus } from "@/lib/support/lifecycle";
import { assertAgencySupportPermission, loadAgencySupportCaps } from "@/server/support/access";
import { loadSupportSettings } from "@/server/support/settings";

// Support analytics, computed from the request, timeline and message tables the support module already keeps. Nothing is estimated or
// filled in: a metric with no data reports no data. Every number is limited to the clients the person can reach (and, without the
// "see the full queue" permission, to the requests assigned to them).

export interface AnalyticsFilters {
  /** First day included, YYYY-MM-DD. Defaults to 30 days before `to`. */
  from?: string;
  /** Last day included, YYYY-MM-DD. Defaults to today. */
  to?: string;
  orgId?: string;
  category?: string;
  requestType?: RequestType;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | "unassigned";
}

export interface CountBy { key: string; count: number }
export interface TimeBucket { bucket: string; created: number; resolved: number }
export interface Duration { avgMinutes: number | null; medianMinutes: number | null; sample: number }

export interface SupportAnalytics {
  range: { from: string; to: string; bucket: "day" | "week"; timezone: string };
  totals: { createdInRange: number; resolvedInRange: number; reopenedInRange: number; openNow: number; unassignedNow: number; assignedNow: number; overdueNow: number; escalatedNow: number; waitingOnClientNow: number };
  byCategory: CountBy[];
  byPriority: CountBy[];
  byType: CountBy[];
  byStatus: CountBy[];
  series: TimeBucket[];
  firstResponse: Duration;
  resolution: Duration;
  reopen: { tickets: number; ratePercent: number | null };
  workload: Array<{ userId: string; name: string; active: number; resolvedInRange: number }>;
  feedback: { byStage: CountBy[]; byCategory: CountBy[]; monthly: Array<{ month: string; count: number }> };
  /** The one-question surveys, when the workspace has them on. Answers are only ever counted; comments stay in the survey record. */
  satisfaction: { requested: number; answered: number; averageRating: number | null; helpfulPercent: number | null };
  commonIssues: Array<{ category: string; feature: string | null; count: number }>;
  topClients: Array<{ orgId: string; name: string; count: number }>;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

function parseDay(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  if (!ISO_DAY.test(value)) throw new AppError("invalid_input", "Dates must look like 2026-10-19.");
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new AppError("invalid_input", "That date doesn't exist.");
  return d;
}

const dur = (r: { avg: string | number | null; med: string | number | null; n: number } | undefined): Duration => ({
  avgMinutes: r && r.n > 0 && r.avg !== null ? Math.round(Number(r.avg) * 10) / 10 : null,
  medianMinutes: r && r.n > 0 && r.med !== null ? Math.round(Number(r.med) * 10) / 10 : null,
  sample: r?.n ?? 0,
});

export async function supportAnalytics(user: SessionUser, filters: AnalyticsFilters = {}): Promise<SupportAnalytics> {
  await assertAgencySupportPermission(user, null, "agency.support.view");
  await assertAgencySupportPermission(user, null, "agency.support.analytics");
  const caps = await loadAgencySupportCaps(user.id);
  const settings = await loadSupportSettings();
  const today = parseDay(new Date().toISOString().slice(0, 10), new Date());
  const to = parseDay(filters.to, today);
  const from = parseDay(filters.from, new Date(to.getTime() - 29 * DAY_MS));
  if (from.getTime() > to.getTime()) throw new AppError("invalid_input", "The start date must be before the end date.");
  if ((to.getTime() - from.getTime()) / DAY_MS > 366) throw new AppError("invalid_input", "Choose a range of up to a year.");
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  const bucket: "day" | "week" = days > 90 ? "week" : "day";
  const end = new Date(to.getTime() + DAY_MS);

  // $1 person, $2 full-queue permission, $3 range start, $4 range end (exclusive), $5 time zone, then the optional filters.
  const params: unknown[] = [user.id, caps["agency.support.queue"], from.toISOString(), end.toISOString(), settings.timezone];
  // The three no-op tests mention $3, $4 and $5 so every query below carries the same parameter list.
  const where = ["app.user_can_access_org($1, t.org_id)", "($2 or t.assigned_to = $1)", "$3::timestamptz is not null", "$4::timestamptz is not null", "$5::text is not null"];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (filters.orgId) {
    if (!ID.test(filters.orgId)) throw new AppError("invalid_input", "Choose a client from the list.");
    add("t.org_id = ?", filters.orgId);
  }
  if (filters.category) {
    if (!/^[a-z_]{2,40}$/.test(filters.category)) throw new AppError("invalid_input", "Choose a category from the list.");
    add("t.category = ?", filters.category);
  }
  if (filters.requestType) {
    if (!(REQUEST_TYPES as readonly string[]).includes(filters.requestType)) throw new AppError("invalid_input", "Choose a request type from the list.");
    add("t.request_type = ?", filters.requestType);
  }
  if (filters.status) {
    if (!(TICKET_STATUSES as readonly string[]).includes(filters.status)) throw new AppError("invalid_input", "Choose a status from the list.");
    add("t.status = ?", filters.status);
  }
  if (filters.priority) {
    if (!(PRIORITIES as readonly string[]).includes(filters.priority)) throw new AppError("invalid_input", "Choose a priority from the list.");
    add("t.priority = ?", filters.priority);
  }
  if (filters.assigneeId === "unassigned") where.push("t.assigned_to is null");
  else if (filters.assigneeId) {
    if (!ID.test(filters.assigneeId)) throw new AppError("invalid_input", "Choose a team member from the list.");
    add("t.assigned_to = ?", filters.assigneeId);
  }
  const W = where.join(" and ");
  const inRange = "t.created_at >= $3::timestamptz and t.created_at < $4::timestamptz";
  const eventInRange = "e.created_at >= $3::timestamptz and e.created_at < $4::timestamptz";
  const ACTIVE = "t.status in ('new', 'open', 'in_progress', 'waiting_for_client')";

  return withUser(user.id, async (db) => {
    const q = async <T>(sql: string) => (await db.query<T>(sql, params)).rows;
    const [t] = await q<{ created: number; open_now: number; unassigned: number; assigned: number; waiting: number; reopened_tickets: number }>(
      `select count(*) filter (where ${inRange})::int as created,
              count(*) filter (where ${ACTIVE})::int as open_now,
              count(*) filter (where ${ACTIVE} and t.assigned_to is null)::int as unassigned,
              count(*) filter (where ${ACTIVE} and t.assigned_to is not null)::int as assigned,
              count(*) filter (where t.status = 'waiting_for_client')::int as waiting,
              count(*) filter (where ${inRange} and t.reopened_count > 0)::int as reopened_tickets
       from support_tickets t where ${W}`,
    );
    const [sat] = await q<{ requested: number; answered: number; avg: string | null; helpful: number }>(
      `select count(*) filter (where s.status in ('requested', 'answered'))::int as requested,
              count(*) filter (where s.status = 'answered')::int as answered,
              avg(s.rating) filter (where s.status = 'answered') as avg,
              count(*) filter (where s.status = 'answered' and s.helpful)::int as helpful
       from support_surveys s join support_tickets t on t.id = s.ticket_id
       where ${W} and s.requested_at >= $3::timestamptz and s.requested_at < $4::timestamptz`,
    );
    const [ev] = await q<{ resolved: number; reopened: number }>(
      `select count(distinct e.ticket_id) filter (where e.kind = 'resolved')::int as resolved, count(*) filter (where e.kind = 'reopened')::int as reopened
       from support_ticket_events e join support_tickets t on t.id = e.ticket_id where ${W} and ${eventInRange}`,
    );
    const [ops] = await q<{ overdue: number; escalated: number }>(
      `select count(*) filter (where t.status in ('new', 'open', 'in_progress') and o.response_due_at is not null and o.response_due_at < now())::int as overdue,
              count(*) filter (where ${ACTIVE} and o.escalated_at is not null)::int as escalated
       from support_tickets t left join support_ticket_ops o on o.ticket_id = t.id where ${W}`,
    );
    const group = (column: string) => q<{ key: string; n: number }>(`select ${column} as key, count(*)::int as n from support_tickets t where ${W} and ${inRange} group by 1 order by 2 desc, 1`);
    const [byCategory, byPriority, byType, byStatus] = await Promise.all([group("t.category"), group("t.priority"), group("t.request_type"), group("t.status")]);
    const series = await q<{ bucket: string; created: number; resolved: number }>(
      `with b as (select generate_series(date_trunc('${bucket}', $3::timestamptz at time zone $5::text), date_trunc('${bucket}', ($4::timestamptz - interval '1 second') at time zone $5::text), interval '1 ${bucket}') as d)
       select to_char(b.d, 'YYYY-MM-DD') as bucket,
         (select count(*)::int from support_tickets t where ${W} and ${inRange} and date_trunc('${bucket}', t.created_at at time zone $5::text) = b.d) as created,
         (select count(distinct e.ticket_id)::int from support_ticket_events e join support_tickets t on t.id = e.ticket_id
            where ${W} and e.kind = 'resolved' and ${eventInRange} and date_trunc('${bucket}', e.created_at at time zone $5::text) = b.d) as resolved
       from b order by b.d`,
    );
    const [first] = await q<{ avg: string | null; med: string | null; n: number }>(
      `select avg(extract(epoch from (t.first_responded_at - t.created_at)) / 60) as avg,
              percentile_cont(0.5) within group (order by extract(epoch from (t.first_responded_at - t.created_at)) / 60) as med, count(*)::int as n
       from support_tickets t where ${W} and ${inRange} and t.first_responded_at is not null`,
    );
    const [res] = await q<{ avg: string | null; med: string | null; n: number }>(
      `select avg(m) as avg, percentile_cont(0.5) within group (order by m) as med, count(*)::int as n from (
         select extract(epoch from (r.first_resolved - t.created_at)) / 60 as m from support_tickets t
         join lateral (select min(e.created_at) as first_resolved from support_ticket_events e where e.ticket_id = t.id and e.kind = 'resolved') r on r.first_resolved is not null
         where ${W} and ${inRange}) x`,
    );
    const workload = await q<{ id: string; name: string; active: number; resolved: number }>(
      `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name,
              count(*) filter (where ${ACTIVE})::int as active,
              count(*) filter (where t.status in ('resolved', 'closed') and t.resolved_at >= $3::timestamptz and t.resolved_at < $4::timestamptz)::int as resolved
       from support_tickets t join users u on u.id = t.assigned_to where ${W} group by u.id, u.full_name, u.email order by active desc, name limit 50`,
    );
    const feedbackBy = (column: string) => q<{ key: string; n: number }>(`select ${column} as key, count(*)::int as n from support_tickets t where ${W} and t.request_type = 'feedback' and ${inRange} group by 1 order by 2 desc, 1`);
    const [stages, fbCategories] = await Promise.all([feedbackBy("t.feedback_stage"), feedbackBy("t.category")]);
    const monthly = await q<{ month: string; n: number }>(
      `select to_char(date_trunc('month', t.created_at at time zone $5::text), 'YYYY-MM') as month, count(*)::int as n from support_tickets t
       where ${W} and t.request_type = 'feedback' and t.created_at >= ($4::timestamptz - interval '6 months') and t.created_at < $4::timestamptz group by 1 order by 1`,
    );
    const common = await q<{ category: string; feature: string | null; n: number }>(
      `select t.category, t.affected_feature as feature, count(*)::int as n from support_tickets t where ${W} and ${inRange} and t.request_type = 'issue' group by 1, 2 order by 3 desc, 1 limit 10`,
    );
    const clients = await q<{ id: string; name: string; n: number }>(
      `select o.id, o.name, count(*)::int as n from support_tickets t join organizations o on o.id = t.org_id where ${W} and ${inRange} group by o.id, o.name order by 3 desc, 2 limit 10`,
    );
    const pairs = (rows: Array<{ key: string; n: number }>) => rows.filter((r) => r.key !== null).map((r) => ({ key: r.key, count: r.n }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), bucket, timezone: settings.timezone },
      totals: { createdInRange: t.created, resolvedInRange: ev.resolved, reopenedInRange: ev.reopened, openNow: t.open_now, unassignedNow: t.unassigned, assignedNow: t.assigned, overdueNow: ops.overdue, escalatedNow: ops.escalated, waitingOnClientNow: t.waiting },
      byCategory: pairs(byCategory), byPriority: pairs(byPriority), byType: pairs(byType), byStatus: pairs(byStatus),
      series, firstResponse: dur(first), resolution: dur(res),
      reopen: { tickets: t.reopened_tickets, ratePercent: t.created > 0 ? Math.round((t.reopened_tickets / t.created) * 1000) / 10 : null },
      workload: workload.map((r) => ({ userId: r.id, name: r.name, active: r.active, resolvedInRange: r.resolved })),
      feedback: { byStage: pairs(stages), byCategory: pairs(fbCategories), monthly: monthly.map((m) => ({ month: m.month, count: m.n })) },
      satisfaction: {
        requested: sat.requested,
        answered: sat.answered,
        averageRating: sat.avg === null || sat.answered === 0 ? null : Math.round(Number(sat.avg) * 10) / 10,
        helpfulPercent: sat.answered === 0 ? null : Math.round((sat.helpful / sat.answered) * 1000) / 10,
      },
      commonIssues: common.map((c) => ({ category: c.category, feature: c.feature, count: c.n })),
      topClients: clients.map((c) => ({ orgId: c.id, name: c.name, count: c.n })),
    };
  });
}


