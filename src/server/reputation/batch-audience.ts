import "server-only";
import type { Queryable } from "@/server/db";
import { REVIEW_REQUEST_COOLDOWN_DAYS } from "@/server/crm/reviews";
import { identityKind, type Channel } from "@/lib/messaging";
import { MAX_BATCH_PEOPLE, PREVIEW_REASONS } from "@/lib/reputation/batches";
import type { BatchCriteria } from "@/lib/reputation/ask-criteria";

// Who a batch is for, and which of them may be asked right now. The people come from a completed service (an appointment a person marked attended, a deal that was won, a
// customer since a date) inside the criteria's window, one row per customer with the most recent such service. Nothing else chooses them. The rules that then leave someone
// out are the ones the send path applies to a single review request, in the same order: an address on the channel, not opted out, consent to service messages on that
// channel exactly "granted", not asked in the cool-down, and no person's hold on automatic messages. This is a read in one pass so a thousand people can be previewed at
// once; each person is checked again, by the real send path, at the moment they are asked (tests/reputation-batches.test.ts keeps the two in step).

export type PersonOutcome = "eligible" | (typeof PREVIEW_REASONS)[number];

export interface AudiencePerson {
  contactId: string;
  name: string;
  appointmentId: string | null;
  opportunityId: string | null;
  factAt: Date;
  outcome: PersonOutcome;
}

/**
 * The window as timestamps: the first day from midnight to the end of the last day, in the workspace's own time zone. Both are placeholders for dates bound by the caller.
 */
const startOfDay = (p: string, tz: string) => `((${p}::date)::timestamp at time zone ${tz})`;
const startOfNextDay = (p: string, tz: string) => `((${p}::date + 1)::timestamp at time zone ${tz})`;

/** The query that finds the people (and the service each is here for). Values are bound in the returned params, in order. */
function peopleSql(orgId: string, timezone: string, c: BatchCriteria): { sql: string; params: unknown[] } {
  const params: unknown[] = [orgId];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const tz = `${bind(timezone)}::text`;
  const from = startOfDay(bind(c.from), tz);
  const to = startOfNextDay(bind(c.to), tz);
  if (c.source === "appointments_showed") {
    const calendars = c.calendarIds?.length ? `and a.calendar_ref = any(${bind(c.calendarIds)}::uuid[])` : "";
    const types = c.appointmentTypeIds?.length ? `and a.appointment_type_id = any(${bind(c.appointmentTypeIds)}::uuid[])` : "";
    return {
      params,
      sql: `select distinct on (a.contact_id) a.contact_id, a.id as appointment_id, null::uuid as opportunity_id, a.end_at as fact_at
            from appointment_refs a
            where a.org_id = $1 and a.status = 'showed' and a.contact_id is not null and a.end_at >= ${from} and a.end_at < ${to} ${calendars} ${types}
            order by a.contact_id, a.end_at desc, a.id`,
    };
  }
  if (c.source === "deals_won") {
    const pipeline = c.pipelineId ? `and o.pipeline_ref = ${bind(c.pipelineId)}::uuid` : "";
    return {
      params,
      sql: `select distinct on (o.contact_id) o.contact_id, null::uuid as appointment_id, o.id as opportunity_id, o.closed_at as fact_at
            from crm_opportunities o
            where o.org_id = $1 and o.status = 'won' and o.contact_id is not null and o.closed_at >= ${from} and o.closed_at < ${to} ${pipeline}
            order by o.contact_id, o.closed_at desc, o.id`,
    };
  }
  return {
    params,
    sql: `select s.id as contact_id, null::uuid as appointment_id, null::uuid as opportunity_id, s.customer_since as fact_at
          from contacts s where s.org_id = $1 and s.customer_since >= ${from} and s.customer_since < ${to}`,
  };
}

/**
 * Everyone the criteria name, newest service first, each with the first rule that leaves them out right now or "eligible". Deleted and archived contacts are not on the list
 * at all. At most `limit` people are returned; `tooLarge` says there were more (the batch is then refused rather than sent in part).
 */
export async function loadAudience(
  db: Queryable,
  orgId: string,
  timezone: string,
  criteria: BatchCriteria,
  channel: Channel,
  now: Date,
  limit = MAX_BATCH_PEOPLE,
): Promise<{ people: AudiencePerson[]; tooLarge: boolean }> {
  const q = peopleSql(orgId, timezone, criteria);
  const bind = (v: unknown) => {
    q.params.push(v);
    return `$${q.params.length}`;
  };
  const ch = `${bind(channel)}::text`;
  const kind = `${bind(identityKind(channel))}::text`;
  const at = `${bind(now.toISOString())}::timestamptz`;
  const days = `${bind(REVIEW_REQUEST_COOLDOWN_DAYS)}::int`;
  const cap = bind(limit + 1);
  const { rows } = await db.query<{ contact_id: string; name: string | null; appointment_id: string | null; opportunity_id: string | null; fact_at: Date; outcome: PersonOutcome }>(
    `select f.contact_id, c.display_name as name, f.appointment_id, f.opportunity_id, f.fact_at,
       case
         when a.value is null then 'no_address'
         when exists (select 1 from suppressions s where s.org_id = c.org_id and s.channel = ${ch} and s.address = a.value and s.lifted_at is null) then 'suppressed'
         when k.status = 'revoked' then 'consent_withdrawn'
         when k.status is distinct from 'granted' then 'no_consent'
         when exists (
           select 1 from crm_review_requests r left join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
           where r.org_id = c.org_id and r.contact_id = c.id and r.status not in ('failed', 'cancelled') and coalesce(m.status, '') not in ('failed', 'blocked')
             and r.created_at > ${at} - make_interval(days => ${days})
         ) then 'recently_requested'
         when c.retention_paused then 'held_by_person'
         else 'eligible'
       end as outcome
     from (${q.sql}) f
     join contacts c on c.id = f.contact_id and c.org_id = $1 and c.deleted_at is null and c.archived_at is null
     left join lateral (select i.value from contact_identities i where i.org_id = c.org_id and i.contact_id = c.id and i.kind = ${kind} order by i.verified desc, i.created_at limit 1) a on true
     left join lateral (select e.status from contact_consent_events e where e.org_id = c.org_id and e.contact_id = c.id and e.channel = ${ch} and e.purpose = 'service' order by e.id desc limit 1) k on true
     order by f.fact_at desc, f.contact_id
     limit ${cap}`,
    q.params,
  );
  const people = rows.slice(0, limit).map((r) => ({
    contactId: r.contact_id, name: r.name || "Unnamed contact", appointmentId: r.appointment_id, opportunityId: r.opportunity_id, factAt: new Date(r.fact_at), outcome: r.outcome,
  }));
  return { people, tooLarge: rows.length > limit };
}

export interface AudienceSummary {
  total: number;
  eligible: number;
  /** People who can't be asked, by the first rule that applies. */
  excluded: Partial<Record<(typeof PREVIEW_REASONS)[number], number>>;
}

export function summarize(people: readonly AudiencePerson[]): AudienceSummary {
  const out: AudienceSummary = { total: people.length, eligible: 0, excluded: {} };
  for (const p of people) {
    if (p.outcome === "eligible") out.eligible += 1;
    else out.excluded[p.outcome] = (out.excluded[p.outcome] ?? 0) + 1;
  }
  return out;
}
