import "server-only";
import type { Queryable } from "@/server/db";
import { crmRead } from "@/server/crm/actor";
import { num, ownerNote, type ReportScope } from "@/server/crm/reports/scope";
import type { AppointmentRow, AppointmentsReport, SectionResult } from "@/components/crm/reports/types";

export const BOOKED_VIA_LABELS: Record<string, string> = {
  booking_page: "Booking page",
  website: "Website",
  staff: "Booked by the team",
  agent: "AI employee",
  api: "API",
  import: "Import",
  ghl_migration: "GoHighLevel migration",
  unknown: "Not recorded",
};

// Native appointments only; a cancelled-and-rebooked appointment is its own row, and "invalid" rows (records that failed validation) never count.
// $1 org, $2 start, $3 end, $4 member, $5 source
const FROM = "from appointment_refs a left join contacts c on c.id = a.contact_id and c.org_id = a.org_id";
const WHERE = `where a.org_id = $1 and a.provider = 'native' and a.status <> 'invalid'
    and ($4::uuid is null or a.assigned_user_id = $4 or exists (select 1 from crm_appointment_hosts h where h.appointment_id = a.id and h.user_id = $4))
    and ($5::text is null or c.created_via = $5)`;
const IN_PERIOD = "a.start_at >= $2 and a.start_at < $3";
const OUTCOMES = `count(*)::text as scheduled,
  count(*) filter (where a.status = 'showed')::text as completed,
  count(*) filter (where a.status = 'noshow')::text as noshow,
  count(*) filter (where a.status = 'cancelled')::text as cancelled,
  count(*) filter (where a.status in ('new', 'confirmed') and a.start_at > now())::text as upcoming,
  count(*) filter (where a.status in ('new', 'confirmed') and a.start_at <= now())::text as unmarked`;

type OutcomeRow = { key: string | null; label: string | null; scheduled: string; completed: string; noshow: string; cancelled: string; upcoming: string; unmarked: string };
const toRow = (r: OutcomeRow, fallback: string): AppointmentRow => ({
  key: r.key ?? "none", label: r.label || fallback, scheduled: num(r.scheduled), completed: num(r.completed), noShows: num(r.noshow), cancelled: num(r.cancelled), upcoming: num(r.upcoming), unmarked: num(r.unmarked),
});

async function breakdown(db: Queryable, params: unknown[], select: string, join: string, group: string, fallback: string) {
  const { rows } = await db.query<OutcomeRow>(`select ${select}, ${OUTCOMES} ${FROM} ${join} ${WHERE} and ${IN_PERIOD} group by ${group} order by count(*) desc, 2 limit 25`, params);
  return rows.map((r) => toRow(r, fallback));
}

/**
 * Appointments on iAcquire's own calendar: how many were booked in the period (by how they were booked), and what happened to the ones
 * scheduled in it, by appointment type, calendar, host and booking path. A collective appointment counts once for each of its hosts in the
 * host table, and once everywhere else.
 */
export async function appointmentsSection(scope: ReportScope): Promise<SectionResult<"appointments">> {
  const { actor, filters: f } = scope;
  const data = await crmRead(actor, async (db) => {
    const p = [actor.orgId, scope.startsAt, scope.endsAt, f.member ?? null, f.source ?? null];
    const booked = await db.query<{ via: string; n: string }>(
      `select coalesce(a.booked_via, 'unknown') as via, count(*)::text as n ${FROM} ${WHERE} and a.created_at >= $2 and a.created_at < $3 group by 1 order by count(*) desc`,
      p,
    );
    const totals = await db.query<OutcomeRow & { late: string }>(
      `select null as key, null as label, ${OUTCOMES}, count(*) filter (where a.status = 'cancelled' and a.late_cancellation)::text as late ${FROM} ${WHERE} and ${IN_PERIOD}`,
      p,
    );
    const byType = await breakdown(db, p, "t.id::text as key, t.name as label", "left join crm_appointment_types t on t.id = a.appointment_type_id and t.org_id = a.org_id", "t.id, t.name", "Unknown type");
    const byCalendar = await breakdown(db, p, "cal.id::text as key, cal.name as label", "left join crm_calendars cal on cal.id = a.calendar_ref and cal.org_id = a.org_id", "cal.id, cal.name", "Unknown calendar");
    const byVia = await breakdown(db, p, "coalesce(a.booked_via, 'unknown') as key, coalesce(a.booked_via, 'unknown') as label", "", "1", "Not recorded");
    // Each host of an appointment: the listed hosts, or the assigned person when none are listed.
    const hostRows = await db.query<OutcomeRow>(
      `select hu.id::text as key, nullif(hu.full_name, '') as label, ${OUTCOMES}
       ${FROM}
       cross join lateral unnest(coalesce((select array_agg(h.user_id) from crm_appointment_hosts h where h.appointment_id = a.id), array[a.assigned_user_id])) as host(user_id)
       left join users hu on hu.id = host.user_id
       ${WHERE} and ${IN_PERIOD}
       group by hu.id, hu.full_name order by count(*) desc, 2 limit 25`,
      p,
    );
    const t = totals.rows[0];
    const completed = num(t?.completed);
    const noShows = num(t?.noshow);
    return {
      booked: booked.rows.reduce((n, r) => n + num(r.n), 0),
      bookedVia: booked.rows.map((r) => ({ key: r.via, label: BOOKED_VIA_LABELS[r.via] ?? r.via, count: num(r.n) })),
      scheduled: num(t?.scheduled),
      completed,
      noShows,
      cancelled: num(t?.cancelled),
      upcoming: num(t?.upcoming),
      unmarked: num(t?.unmarked),
      lateCancellations: num(t?.late),
      showRate: completed + noShows ? Math.round((completed / (completed + noShows)) * 1000) / 10 : null,
      byType,
      byCalendar,
      byHost: hostRows.rows.map((r) => toRow(r, "No host")),
      byBookedVia: byVia.map((r) => ({ ...r, label: BOOKED_VIA_LABELS[r.key] ?? r.label })),
    } satisfies AppointmentsReport;
  });
  return {
    section: "appointments",
    data,
    empty: data.booked === 0 && data.scheduled === 0,
    ignored: [],
    notes: ownerNote(scope, "appointments", "appointments"),
  };
}
