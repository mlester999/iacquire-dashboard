import "server-only";
import { AppError } from "@/server/errors";
import { crmRead, type CrmActor } from "@/server/crm/actor";
import { costPerLead, missingInputs, returnOnSpend, sourceLabel, UNKNOWN_SOURCE } from "@/lib/attribution/model";

// Leads, and what became of them, by where they came from. Every figure is counted from records that exist, and a figure that needs an input nobody
// supplied is not computed:
//   * a lead is a contact created in the period (not deleted); its source is its first touch (or latest touch when asked), and a contact with no touch is
//     counted as "No touch recorded", never assigned a guess;
//   * qualified = lead status qualified or customer; appointments = a booked, confirmed or attended appointment (not cancelled);
//   * deal value is the value of the contact's deals, by status, per currency: "won" is a deal marked won, which is NOT verified revenue;
//   * verified revenue needs verified payments, which this platform does not record yet, so it is null and return on spend is not computed;
//   * cost comes only from costs a person entered whose whole period sits inside the report's period, and cost per lead needs one currency.

export type AttributionModel = "first" | "latest";
export const NO_TOUCH = "no-touch-recorded";

export interface MoneyByCurrency {
  currency: string;
  amount: number;
}

export interface SourceRow {
  source: string;
  label: string;
  leads: number;
  qualified: number;
  appointments: number;
  opportunities: number;
  openValue: MoneyByCurrency[];
  wonCount: number;
  wonValue: MoneyByCurrency[];
  /** How the leads' sources were established. */
  known: number;
  inferred: number;
  unknown: number;
  cost: MoneyByCurrency[];
  /** Per currency, only where exactly one currency of cost was entered and the source has leads. */
  costPerLead: MoneyByCurrency | null;
  /** Null until the platform records verified payments. */
  verifiedRevenue: number | null;
  returnOnSpend: number | null;
  /** In words, what is missing for the figures that are not shown. */
  missing: string | null;
}

export interface AttributionReport {
  model: AttributionModel;
  startsAt: string;
  endsAt: string;
  rows: SourceRow[];
  totals: { leads: number; qualified: number; appointments: number; opportunities: number; wonCount: number };
  /** Entered costs that overlap the period but are not wholly inside it, so are left out of cost per lead. */
  excludedCosts: number;
  notes: string[];
}

const n = (v: unknown) => Number(v ?? 0);
const money = (rows: Array<{ currency: string | null; amount: string | null }>): MoneyByCurrency[] =>
  rows.filter((r) => r.currency && r.amount !== null).map((r) => ({ currency: r.currency as string, amount: Math.round(Number(r.amount) * 100) / 100 })).sort((a, b) => a.currency.localeCompare(b.currency));

export async function attributionReport(actor: CrmActor, input: { startsAt: Date; endsAt: Date; model?: AttributionModel }): Promise<AttributionReport> {
  if (!actor.can("analytics.view")) throw new AppError("forbidden", "Your role can't see reports.");
  const model: AttributionModel = input.model === "latest" ? "latest" : "first";
  if (!(input.startsAt < input.endsAt)) throw new AppError("invalid_input", "The period must end after it starts.");
  const pointer = model === "latest" ? "latest_touch_id" : "first_touch_id";

  return crmRead(actor, async (db) => {
    const p = [actor.orgId, input.startsAt, input.endsAt];
    // One row per lead with its chosen touch; everything else is counted from it.
    const base = `
      with leads as (
        select c.id, c.lead_status, coalesce(t.source, '${NO_TOUCH}') as source, t.confidence
        from contacts c left join lead_touches t on t.id = c.${pointer} and t.org_id = c.org_id
        where c.org_id = $1 and c.deleted_at is null and c.created_at >= $2 and c.created_at < $3
      )`;
    const counts = await db.query<{ source: string; leads: string; qualified: string; appointments: string; opportunities: string; won_count: string; known: string; inferred: string; unknown: string }>(
      `${base}
       select l.source, count(*)::text as leads,
         count(*) filter (where l.lead_status in ('qualified', 'customer'))::text as qualified,
         count(*) filter (where exists (select 1 from appointment_refs a where a.org_id = $1 and a.contact_id = l.id and a.status not in ('cancelled', 'invalid')))::text as appointments,
         count(*) filter (where exists (select 1 from crm_opportunities o where o.org_id = $1 and o.contact_id = l.id and o.archived_at is null))::text as opportunities,
         count(*) filter (where exists (select 1 from crm_opportunities o where o.org_id = $1 and o.contact_id = l.id and o.archived_at is null and o.status = 'won'))::text as won_count,
         count(*) filter (where l.confidence = 'known')::text as known, count(*) filter (where l.confidence = 'inferred')::text as inferred,
         count(*) filter (where l.confidence is null or l.confidence = 'unknown')::text as unknown
       from leads l group by l.source`,
      p,
    );
    const deals = await db.query<{ source: string; status: string; currency: string | null; amount: string | null }>(
      `${base}
       select l.source, o.status, o.currency, sum(o.monetary_value)::text as amount
       from leads l join crm_opportunities o on o.contact_id = l.id and o.org_id = $1 and o.archived_at is null and o.status in ('open', 'won')
       group by l.source, o.status, o.currency`,
      p,
    );
    const costs = await db.query<{ source: string; currency: string; amount: string }>(
      `select source, currency, sum(amount)::text as amount from attribution_costs where org_id = $1 and period_start >= $2::date and period_end < $3::date group by source, currency`,
      [actor.orgId, input.startsAt, input.endsAt],
    );
    const partial = await db.query<{ n: string }>(
      "select count(*)::text as n from attribution_costs where org_id = $1 and period_end >= $2::date and period_start < $3::date and not (period_start >= $2::date and period_end < $3::date)",
      [actor.orgId, input.startsAt, input.endsAt],
    );

    const rows: SourceRow[] = counts.rows.map((r) => {
      const dealsOf = (status: string) => money(deals.rows.filter((d) => d.source === r.source && d.status === status));
      const cost = money(costs.rows.filter((c) => c.source === r.source).map((c) => ({ currency: c.currency, amount: c.amount })));
      const leads = n(r.leads);
      const single = cost.length === 1 ? cost[0] : null;
      const cpl = single ? costPerLead(single.amount, leads) : null;
      const noCost = cost.length === 0;
      return {
        source: r.source, label: r.source === NO_TOUCH ? "No touch recorded" : sourceLabel(r.source), leads, qualified: n(r.qualified), appointments: n(r.appointments), opportunities: n(r.opportunities),
        openValue: dealsOf("open"), wonCount: n(r.won_count), wonValue: dealsOf("won"), known: n(r.known), inferred: n(r.inferred), unknown: n(r.unknown),
        cost, costPerLead: single && cpl !== null ? { currency: single.currency, amount: cpl } : null,
        verifiedRevenue: null,
        returnOnSpend: returnOnSpend({ verifiedRevenue: null, cost: single?.amount ?? null }),
        missing: r.source === NO_TOUCH || r.source === UNKNOWN_SOURCE ? "Cost and return are not shown for leads with no known source." : missingInputs({ verifiedRevenue: null, cost: noCost ? null : single?.amount ?? 0 }),
      };
    }).sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));

    const sum = (f: (r: SourceRow) => number) => rows.reduce((t, r) => t + f(r), 0);
    const notes = [
      "Sources are read from what each lead's visit or contact carried. Inferred sources come from a referring site or the channel; they are labelled and counted apart.",
      "Won deal value is the value of deals marked won. It is not verified revenue: this platform does not record verified customer payments yet, so return on spend is not calculated.",
    ];
    if (n(partial.rows[0].n) > 0) notes.push(`${partial.rows[0].n} entered cost${n(partial.rows[0].n) === 1 ? "" : "s"} only partly overlap this period and ${n(partial.rows[0].n) === 1 ? "is" : "are"} left out of cost per lead.`);
    return {
      model, startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(), rows,
      totals: { leads: sum((r) => r.leads), qualified: sum((r) => r.qualified), appointments: sum((r) => r.appointments), opportunities: sum((r) => r.opportunities), wonCount: sum((r) => r.wonCount) },
      excludedCosts: n(partial.rows[0].n), notes,
    };
  });
}
