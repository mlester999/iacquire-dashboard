import "server-only";
import { AppError } from "@/server/errors";
import { assertCan, crmRead, type CrmActor } from "@/server/crm/actor";
import { CALL_CLASSES, type CallClass } from "@/lib/missed-calls/state";

// Recovery numbers, read from what was actually recorded. Every figure is a count of rows that exist: nothing is estimated unless it says so,
// and nothing is multiplied by an assumed value. Revenue is never invented: the one money figure is deals the CRM itself marks won, for contacts
// recovered after a missed call, labelled as an association (a deal won later may have nothing to do with the call).

export const STAT_PERIODS = [7, 30, 90] as const;

export interface RecoveryStats {
  periodDays: number;
  since: string;
  calls: { inbound: number; missed: number; answered: number; missedByClass: Record<CallClass, number>; afterHours: number };
  cases: { total: number; open: number; waitingOnTeam: number; recovered: number; closedWithoutRecovery: number; failed: number; canceled: number };
  funnel: {
    /** Cases a follow-up text was allowed for (a draft or a text exists). */
    eligible: number;
    /** Follow-up texts that were attempted (queued, sent, delivered, blocked or failed). */
    attempts: number;
    /** Cases where a text actually reached the provider (sent or delivered). */
    contacted: number;
    responded: number;
    appointments: number;
    callbacks: number;
    recovered: number;
    suppressed: number;
    failed: number;
  };
  rates: { recoveryRate: number | null; responseRate: number | null };
  speed: { medianMinutesToFirstAction: number | null; casesWithAnAction: number };
  association: { wonDeals: number; wonValueByCurrency: Array<{ currency: string; total: string }>; note: string };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

export async function recoveryStats(actor: CrmActor, periodDays: number): Promise<RecoveryStats> {
  assertCan(actor, "calls.view", "Your role doesn't include call records.");
  if (!(STAT_PERIODS as readonly number[]).includes(periodDays)) throw new AppError("invalid_input", "Choose 7, 30 or 90 days.");
  const since = new Date(Date.now() - periodDays * 86_400_000);
  return crmRead(actor, async (db) => {
    const p = [actor.orgId, since];
    const one = async <T>(sql: string, params: unknown[] = p) => (await db.query<T & Record<string, unknown>>(sql, params)).rows;

    const [calls] = await one<{ inbound: string; answered: string }>(
      `select count(*)::text as inbound,
              count(*) filter (where status = 'completed' and not exists (select 1 from missed_call_case_calls l where l.org_id = r.org_id and l.call_record_id = r.id and l.counted))::text as answered
       from crm_call_records r where r.org_id = $1 and r.direction = 'inbound' and coalesce(r.started_at, r.created_at) >= $2`,
    );
    const byClass = await one<{ classification: CallClass; n: string; after: string }>(
      "select classification, count(*)::text as n, count(*) filter (where after_hours)::text as after from missed_call_case_calls where org_id = $1 and counted and called_at >= $2 group by classification",
    );
    const missedByClass = Object.fromEntries(CALL_CLASSES.map((c) => [c, 0])) as Record<CallClass, number>;
    let missed = 0;
    let afterHours = 0;
    for (const r of byClass) {
      missedByClass[r.classification] = Number(r.n);
      missed += Number(r.n);
      afterHours += Number(r.after);
    }

    const states = await one<{ state: string; reason: string | null; recovered_via: string | null; n: string }>(
      "select state, state_reason as reason, recovered_via, count(*)::text as n from missed_call_cases where org_id = $1 and first_called_at >= $2 group by state, state_reason, recovered_via",
    );
    const cases = { total: 0, open: 0, waitingOnTeam: 0, recovered: 0, closedWithoutRecovery: 0, failed: 0, canceled: 0 };
    const funnel = { eligible: 0, attempts: 0, contacted: 0, responded: 0, appointments: 0, callbacks: 0, recovered: 0, suppressed: 0, failed: 0 };
    for (const r of states) {
      const n = Number(r.n);
      cases.total += n;
      if (r.state === "recovered") {
        cases.recovered += n;
        funnel.recovered += n;
        if (r.recovered_via === "customer_reply") funnel.responded += n;
        if (r.recovered_via === "appointment_booked") funnel.appointments += n;
        if (r.recovered_via === "callback_completed") funnel.callbacks += n;
      } else if (r.state === "completed_without_recovery") cases.closedWithoutRecovery += n;
      else if (r.state === "failed") { cases.failed += n; funnel.failed += n; }
      else if (r.state === "canceled") cases.canceled += n;
      else {
        cases.open += n;
        if (r.state === "suppressed") {
          funnel.suppressed += n;
          if (r.reason === "messages_off") cases.waitingOnTeam += n;
        }
      }
    }
    const [f] = await one<{ eligible: string; attempts: string; contacted: string }>(
      `select count(distinct a.case_id) filter (where a.kind = 'message')::text as eligible,
              count(*) filter (where a.kind = 'message' and a.status in ('queued', 'sent', 'delivered', 'blocked', 'failed'))::text as attempts,
              count(distinct a.case_id) filter (where a.kind = 'message' and a.status in ('sent', 'delivered'))::text as contacted
       from missed_call_actions a join missed_call_cases c on c.id = a.case_id and c.org_id = a.org_id where a.org_id = $1 and c.first_called_at >= $2`,
    );
    funnel.eligible = Number(f.eligible);
    funnel.attempts = Number(f.attempts);
    funnel.contacted = Number(f.contacted);

    const times = await one<{ minutes: string }>(
      "select (extract(epoch from (first_action_at - first_called_at)) / 60)::text as minutes from missed_call_cases where org_id = $1 and first_called_at >= $2 and first_action_at is not null",
    );
    const won = await one<{ currency: string; total: string; n: string }>(
      `select coalesce(o.currency, 'USD') as currency, sum(o.monetary_value)::text as total, count(*)::text as n
       from crm_opportunities o join missed_call_cases c on c.contact_id = o.contact_id and c.org_id = o.org_id
       where o.org_id = $1 and c.first_called_at >= $2 and c.state = 'recovered' and o.status = 'won' and o.provider = 'native' and o.closed_at >= c.first_called_at group by 1`,
    );
    const total = cases.total - cases.canceled;
    return {
      periodDays,
      since: since.toISOString(),
      calls: { inbound: Number(calls.inbound), missed, answered: Number(calls.answered), missedByClass, afterHours },
      cases,
      funnel,
      rates: {
        recoveryRate: total > 0 ? Math.round((cases.recovered / total) * 1000) / 10 : null,
        responseRate: funnel.contacted > 0 ? Math.round((funnel.responded / funnel.contacted) * 1000) / 10 : null,
      },
      speed: { medianMinutesToFirstAction: median(times.map((t) => Number(t.minutes))), casesWithAnAction: times.length },
      association: {
        wonDeals: won.reduce((n, w) => n + Number(w.n), 0),
        wonValueByCurrency: won.filter((w) => w.total !== null).map((w) => ({ currency: w.currency, total: w.total })),
        note: "Deals the CRM marks won, for contacts recovered after a missed call, closed after the call. It shows an association, not proof the call caused the deal.",
      },
    };
  });
}
