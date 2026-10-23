import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { assertCan, type CrmActor } from "@/server/crm/actor";
import { assertSurveysEnabled } from "@/server/reputation/entitlement";
import { loadSettings } from "@/server/reputation/settings";
import { blockFrom, MIN_ACKNOWLEDGED_SAMPLE, responseShare, segmentsFrom, trendFrom, type SatisfactionReport, type ScoreRow } from "@/lib/reputation/satisfaction";
import type { FeedbackScale } from "@/lib/reputation/scores";

// The Satisfaction view's numbers, read from this workspace's own records (never another workspace's, never a review site's). Private feedback only: nothing here is a public
// review, and nothing links what a person said privately to what they may have posted elsewhere. The rules for what is counted and when a score is shown are in
// src/lib/reputation/satisfaction.ts; this file only reads the counts.

/** The answers that count as the customer's own on a scale: through their link, or in a survey that knew who they were. */
const NAMED = "(f.source = 'review_request' or (f.source = 'survey' and f.contact_id is not null))";
const ANONYMOUS = "(f.source = 'survey' and f.contact_id is null)";
const SCORED = "(f.rating is not null or f.nps_score is not null)";
/** A request that went out, by what is known about its message: the same reading as the Reviews numbers. */
const SENT = "(r.status in ('sent', 'opened', 'feedback_received', 'review_link_clicked') or m.status in ('sent', 'delivered', 'read'))";

interface CountRow { scale: FeedbackScale; value: number; n: number }
const asScoreRows = (rows: CountRow[]): ScoreRow[] => rows.map((r) => ({ scale: r.scale, value: Number(r.value), n: Number(r.n) }));

async function counts(db: Queryable, where: string, params: unknown[]): Promise<ScoreRow[]> {
  const { rows } = await db.query<CountRow>(
    `select f.scale, coalesce(f.rating, f.nps_score) as value, count(*)::int as n from customer_feedback f
     where f.org_id = $1 and f.received_at >= $2 and ${SCORED} and ${where} group by 1, 2`,
    params,
  );
  return asScoreRows(rows);
}

/** Counts of the customer's answers grouped by the appointment type or calendar the request was about (only requests tied to an appointment). */
async function segments(db: Queryable, orgId: string, since: Date, by: "type" | "calendar") {
  const join = by === "type"
    ? "join crm_appointment_types g on g.id = a.appointment_type_id and g.org_id = a.org_id"
    : "join crm_calendars g on g.id = a.calendar_ref and g.org_id = a.org_id";
  const { rows } = await db.query<CountRow & { id: string; name: string }>(
    `select g.id, g.name, f.scale, coalesce(f.rating, f.nps_score) as value, count(*)::int as n
     from customer_feedback f join crm_review_requests r on r.id = f.review_request_id and r.org_id = f.org_id
     join appointment_refs a on a.id = r.appointment_id and a.org_id = r.org_id ${join}
     where f.org_id = $1 and f.received_at >= $2 and f.source = 'review_request' and ${SCORED} group by 1, 2, 3, 4`,
    [orgId, since.toISOString()],
  );
  return segmentsFrom(rows.map((r) => ({ id: r.id, name: r.name, scale: r.scale, value: Number(r.value), n: Number(r.n) })));
}

/**
 * CSAT and NPS for a period, with the sample gates applied, apart for answers that knew who gave them and answers that didn't, with the response rate of review requests and
 * of surveys, a weekly trend, the busiest appointment types and calendars, and how the team is doing with low feedback. Anyone who can open contacts can read it.
 */
export async function getSatisfaction(actor: CrmActor, opts: { days?: number; now?: Date } = {}): Promise<SatisfactionReport> {
  assertCan(actor, "contacts.view");
  const days = [7, 30, 90, 365].includes(opts.days ?? 30) ? (opts.days ?? 30) : 30;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const orgId = actor.orgId;
  return withSystem(async (db) => {
    await assertSurveysEnabled(db, orgId);
    const p = [orgId, since.toISOString()];
    const settings = await loadSettings(db, orgId);
    const tz = (await db.query<{ timezone: string | null }>("select timezone from organizations where id = $1", [orgId])).rows[0]?.timezone || "UTC";

    const named = blockFrom(await counts(db, NAMED, p));
    const anonymous = blockFrom(await counts(db, ANONYMOUS, p));
    const handRecorded = Number((await db.query<{ n: string }>("select count(*)::text as n from customer_feedback f where f.org_id = $1 and f.received_at >= $2 and f.source in ('manual', 'import')", p)).rows[0].n);

    const reqs = await db.query<{ kind: "review" | "survey"; sent: string; answered: string }>(
      `select r.kind, count(*) filter (where ${SENT})::text as sent,
              count(*) filter (where ${SENT} and exists (select 1 from customer_feedback f where f.org_id = r.org_id and f.review_request_id = r.id))::text as answered
       from crm_review_requests r left join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
       where r.org_id = $1 and r.created_at >= $2 and r.status <> 'cancelled' group by r.kind`,
      p,
    );
    const share = (kind: "review" | "survey") => {
      const r = reqs.rows.find((x) => x.kind === kind);
      return responseShare(Number(r?.sent ?? 0), Number(r?.answered ?? 0));
    };

    const weeks = await db.query<CountRow & { week: string }>(
      `select to_char(date_trunc('week', f.received_at at time zone $3::text)::date, 'YYYY-MM-DD') as week, f.scale, coalesce(f.rating, f.nps_score) as value, count(*)::int as n
       from customer_feedback f where f.org_id = $1 and f.received_at >= $2 and ${SCORED} and ${NAMED} group by 1, 2, 3`,
      [orgId, since.toISOString(), tz],
    );

    const open = (await db.query<{ open: string; overdue: string }>(
      `select count(*) filter (where f.low_score and f.follow_up_status in ('new', 'escalated'))::text as open,
              count(*) filter (where f.low_score and f.follow_up_status in ('new', 'escalated') and f.acknowledged_at is null and f.received_at < $2::timestamptz - make_interval(hours => $3::int))::text as overdue
       from customer_feedback f where f.org_id = $1`,
      [orgId, now.toISOString(), settings.acknowledgeWithinHours],
    )).rows[0];
    const acked = (await db.query<{ n: string; median: string | null }>(
      `select count(*)::text as n, percentile_cont(0.5) within group (order by extract(epoch from (f.acknowledged_at - f.received_at)) / 3600)::text as median
       from customer_feedback f where f.org_id = $1 and f.low_score and f.acknowledged_at is not null and f.received_at >= $2`,
      p,
    )).rows[0];
    const ackedN = Number(acked.n);

    return {
      days, since: since.toISOString(), named, anonymous, handRecorded,
      response: { review: share("review"), survey: share("survey") },
      trend: trendFrom(weeks.rows.map((r) => ({ week: r.week, scale: r.scale, value: Number(r.value), n: Number(r.n) }))),
      byAppointmentType: await segments(db, orgId, since, "type"),
      byCalendar: await segments(db, orgId, since, "calendar"),
      followUp: {
        open: Number(open.open), overdue: Number(open.overdue), acknowledgeWithinHours: settings.acknowledgeWithinHours, acknowledged: ackedN,
        medianHoursToAcknowledge: ackedN >= MIN_ACKNOWLEDGED_SAMPLE && acked.median !== null ? Math.round(Number(acked.median) * 10) / 10 : null,
      },
    };
  });
}
