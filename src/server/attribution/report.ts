import "server-only";
import { AppError } from "@/server/errors";
import { crmRead, type CrmActor } from "@/server/crm/actor";
import { costPerLead, missingInputs, returnOnSpendFor, sourceLabel, UNKNOWN_SOURCE } from "@/lib/attribution/model";
import { emptyFigures, sumMoney, type RevenueFigures } from "@/lib/invoices/revenue";
import { invoicesEnabledIn } from "@/server/invoices/feature";
import { cohortRevenue, manualCountsAsVerified, unattributedRevenue, workspaceHasPayments } from "@/server/invoices/revenue";

// Leads, and what became of them, by where they came from. Every figure is counted from records that exist, and a figure that needs an input nobody
// supplied is not computed:
//   * a lead is a contact created in the period (not deleted); its source is its first touch (or latest touch when asked), and a contact with no touch is
//     counted as "No touch recorded", never assigned a guess;
//   * qualified = lead status qualified or customer; appointments = a booked, confirmed or attended appointment (not cancelled);
//   * deal value is the value of the contact's deals, by status, per currency: "won" is a deal marked won, which is NOT verified revenue;
//   * verified revenue is money a payment provider confirmed in live mode on the invoices of these leads' contacts, net of refunds and without tax, per currency, for
//     payments received any time up to the moment of the report ("cohort revenue to date", said so on the screen). A provider's test mode and payments somebody recorded by
//     hand are left out (the latter are shown on their own line unless the owner chose to count them). It is shown only to people who may see invoices;
//   * return on spend needs exactly one cost currency that is also a verified revenue currency: nothing is ever converted;
//   * cost comes only from costs a person entered whose whole period sits inside the report's period, and cost per lead needs one currency.

export type AttributionModel = "first" | "latest";
export const NO_TOUCH = "no-touch-recorded";

export interface MoneyByCurrency {
  currency: string;
  amount: number;
  /** The exact amount in the currency's minor unit, as text. Present on revenue figures, which are summed from it. */
  minor?: string;
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
  /** Per currency, net of refunds and without tax: money a payment provider confirmed in live mode (and, only if the owner chose, payments recorded by hand). Empty when there is none. */
  verifiedRevenue: MoneyByCurrency[];
  /** What was refunded (without tax) and is already taken off verifiedRevenue. */
  refunded: MoneyByCurrency[];
  /** Payments a person recorded, net of refunds and without tax. Counted in verifiedRevenue only when the owner chose to. */
  recordedByHand: MoneyByCurrency[];
  returnOnSpend: number | null;
  /** The currency the return was worked out in. */
  returnCurrency: string | null;
  /** In words, what is missing for the figures that are not shown, or what was left out of one that is. */
  missing: string | null;
}

export type RevenueState = "shown" | "hidden" | "off";

export interface RevenueSummary {
  /** shown: the revenue figures are real. hidden: this person may not see invoices, so none were read. off: invoicing is not switched on for the workspace. */
  state: RevenueState;
  /** The moment the report was made: revenue counts payments received up to it. */
  asOf: string;
  /** The owner counts payments recorded by hand as verified revenue. */
  manualCounted: boolean;
  /** The workspace has recorded at least one customer payment of any kind. */
  workspaceHasPayments: boolean;
  /** Payments of these leads that a provider confirmed in test mode: left out, and counted so the screen can say so. */
  testPaymentsExcluded: number;
  /** Payments of these leads under an open dispute: held out until it is settled. */
  disputedHeldOut: number;
  /** Per currency, across the sources listed. */
  total: MoneyByCurrency[];
  /** Revenue on invoices that belong to no customer any more (after a privacy erasure): it cannot be credited to a source, and is not in any row. */
  unattributed: RevenueFigures;
}

export interface AttributionReport {
  model: AttributionModel;
  startsAt: string;
  endsAt: string;
  rows: SourceRow[];
  totals: { leads: number; qualified: number; appointments: number; opportunities: number; wonCount: number };
  revenue: RevenueSummary;
  /** Entered costs that overlap the period but are not wholly inside it, so are left out of cost per lead. */
  excludedCosts: number;
  notes: string[];
}

const n = (v: unknown) => Number(v ?? 0);
const money = (rows: Array<{ currency: string | null; amount: string | null }>): MoneyByCurrency[] =>
  rows.filter((r) => r.currency && r.amount !== null).map((r) => ({ currency: r.currency as string, amount: Math.round(Number(r.amount) * 100) / 100 })).sort((a, b) => a.currency.localeCompare(b.currency));

const HIDDEN_WORDS = "Verified revenue is shown to people who can see invoices.";

export async function attributionReport(actor: CrmActor, input: { startsAt: Date; endsAt: Date; model?: AttributionModel; asOf?: Date }): Promise<AttributionReport> {
  if (!actor.can("analytics.view")) throw new AppError("forbidden", "Your role can't see reports.");
  const model: AttributionModel = input.model === "latest" ? "latest" : "first";
  if (!(input.startsAt < input.endsAt)) throw new AppError("invalid_input", "The period must end after it starts.");
  const pointer = model === "latest" ? "latest_touch_id" : "first_touch_id";
  const asOf = input.asOf ?? new Date();
  // Customer payments are the client's finances: only people who may see invoices are shown revenue (the database enforces it too), and agency staff in a support session are not.
  const mayReadRevenue = actor.can("invoices.view");

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

    // Verified revenue: read only when this person may see invoices and the workspace has them switched on. Otherwise nothing is read and the report says why.
    const state: RevenueState = !mayReadRevenue ? "hidden" : (await invoicesEnabledIn(db, actor.orgId)) ? "shown" : "off";
    const manualCounted = state === "shown" ? await manualCountsAsVerified(db, actor.orgId) : false;
    const hasPayments = state === "shown" ? await workspaceHasPayments(db, actor.orgId) : false;
    const revenue = state === "shown" ? await cohortRevenue(db, base, [actor.orgId, input.startsAt, input.endsAt], asOf, manualCounted) : null;
    const unattributed = state === "shown" ? await unattributedRevenue(db, actor.orgId, asOf, manualCounted) : emptyFigures();

    const rows: SourceRow[] = counts.rows.map((r) => {
      const dealsOf = (status: string) => money(deals.rows.filter((d) => d.source === r.source && d.status === status));
      const cost = money(costs.rows.filter((c) => c.source === r.source).map((c) => ({ currency: c.currency, amount: c.amount })));
      const leads = n(r.leads);
      const single = cost.length === 1 ? cost[0] : null;
      const cpl = single ? costPerLead(single.amount, leads) : null;
      const noCost = cost.length === 0;
      const figures = revenue?.bySource.get(r.source) ?? emptyFigures();
      const noSource = r.source === NO_TOUCH || r.source === UNKNOWN_SOURCE;
      const ret = state === "shown" && !noSource ? returnOnSpendFor({ cost, verifiedRevenue: figures.verifiedRevenue, workspaceHasPayments: hasPayments }) : null;
      return {
        source: r.source, label: r.source === NO_TOUCH ? "No touch recorded" : sourceLabel(r.source), leads, qualified: n(r.qualified), appointments: n(r.appointments), opportunities: n(r.opportunities),
        openValue: dealsOf("open"), wonCount: n(r.won_count), wonValue: dealsOf("won"), known: n(r.known), inferred: n(r.inferred), unknown: n(r.unknown),
        cost, costPerLead: single && cpl !== null ? { currency: single.currency, amount: cpl } : null,
        verifiedRevenue: figures.verifiedRevenue, refunded: figures.refunded, recordedByHand: figures.recordedByHand,
        returnOnSpend: ret?.returnOnSpend ?? null, returnCurrency: ret?.currency ?? null,
        missing: noSource ? "Cost and return are not shown for leads with no known source."
          : state === "hidden" ? HIDDEN_WORDS
          : ret ? ret.missing
          : missingInputs({ verifiedRevenue: null, cost: noCost ? null : single?.amount ?? 0 }),
      };
    }).sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));

    const sum = (f: (r: SourceRow) => number) => rows.reduce((t, r) => t + f(r), 0);
    const notes = [
      "Sources are read from what each lead's visit or contact carried. Inferred sources come from a referring site or the channel; they are labelled and counted apart.",
      "Won deal value is the value of deals marked won. It is not verified revenue.",
    ];
    if (state === "shown") {
      notes.push(
        `Verified revenue is money your payment provider confirmed in live mode, on invoices to the leads created in this period, received at any time up to ${asOf.toISOString().slice(0, 16).replace("T", " ")} UTC. It is net of refunds and leaves out tax. Currencies are never added together or converted.`,
        manualCounted
          ? "Payments you recorded by hand are counted as verified revenue, because you chose that in your invoice settings."
          : "Payments you recorded by hand are shown on their own line and are not counted as verified revenue.",
      );
      if (!hasPayments) notes.push("No customer payment has been recorded yet, so verified revenue and return on spend are not calculated.");
      if (revenue && revenue.testPaymentsExcluded > 0) notes.push(`${revenue.testPaymentsExcluded} payment${revenue.testPaymentsExcluded === 1 ? "" : "s"} made in a payment provider's test mode ${revenue.testPaymentsExcluded === 1 ? "is" : "are"} left out: no real money moved.`);
      if (revenue && revenue.disputedHeldOut > 0) notes.push(`${revenue.disputedHeldOut} payment${revenue.disputedHeldOut === 1 ? " is" : "s are"} under an open dispute and held out until ${revenue.disputedHeldOut === 1 ? "it is" : "they are"} settled.`);
    } else if (state === "hidden") {
      notes.push(HIDDEN_WORDS);
    } else {
      notes.push("Verified revenue needs customer invoices and payments, which are not switched on for this workspace, so return on spend is not calculated.");
    }
    if (n(partial.rows[0].n) > 0) notes.push(`${partial.rows[0].n} entered cost${n(partial.rows[0].n) === 1 ? "" : "s"} only partly overlap this period and ${n(partial.rows[0].n) === 1 ? "is" : "are"} left out of cost per lead.`);
    return {
      model, startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(), rows,
      totals: { leads: sum((r) => r.leads), qualified: sum((r) => r.qualified), appointments: sum((r) => r.appointments), opportunities: sum((r) => r.opportunities), wonCount: sum((r) => r.wonCount) },
      revenue: {
        state, asOf: asOf.toISOString(), manualCounted, workspaceHasPayments: hasPayments, testPaymentsExcluded: revenue?.testPaymentsExcluded ?? 0, disputedHeldOut: revenue?.disputedHeldOut ?? 0,
        total: sumMoney(rows.map((r) => r.verifiedRevenue.map((l) => ({ currency: l.currency, amount: l.amount, minor: l.minor ?? "0" })))), unattributed,
      },
      excludedCosts: n(partial.rows[0].n), notes,
    };
  });
}
