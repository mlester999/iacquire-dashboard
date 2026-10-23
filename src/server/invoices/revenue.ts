import "server-only";
import type { Queryable } from "@/server/db";
import { COUNTED_PAYMENT_STATUSES, REVENUE_PROVIDERS, figuresFromRows, type RevenueFigures, type RevenueRow } from "@/lib/invoices/revenue";

// Verified revenue for the Lead Sources report, read from the customer payment records. The rules are src/lib/invoices/revenue.ts, applied here in SQL so a large workspace
// is summed by the database; tests/invoices-revenue.test.ts runs both over the same random payments and refuses any difference.
//
// It reads only customer_* tables (never iAcquire's own billing), and runs as the person looking at the report, so row-level security still applies: someone who may not
// see invoices reads nothing (the report does not ask them to).

const COUNTED = COUNTED_PAYMENT_STATUSES.map((s) => `'${s}'`).join(", ");
const PROVIDERS = REVENUE_PROVIDERS.map((s) => `'${s}'`).join(", ");

/** What a payment is, by the same words as classifyPayment. */
const IS_VERIFIED = `(p_status in (${COUNTED}) and verification = 'provider_confirmed' and livemode and provider in (${PROVIDERS}))`;
const IS_BY_HAND = `(p_status in (${COUNTED}) and verification = 'manual')`;
const IS_TEST = `(p_status in (${COUNTED}) and verification = 'provider_confirmed' and not (livemode and provider in (${PROVIDERS})))`;

interface PaymentScope {
  /** Extra columns for each payment row, with a trailing comma ("l.source,"). */
  select: string;
  /** The invoices the payments belong to, and how they were reached. `i` is the invoice. */
  from: string;
  /** A where clause for the invoices, or "". */
  where: string;
  /** The placeholders the query was written with. */
  org: string;
  asOf: string;
}

/**
 * One row per payment, with the part that is revenue before refunds and the part of it that was refunded (both without tax). The refunded tax is capped at the tax the
 * payment held, and the refunded part at what the payment kept, exactly as paymentRevenue does it. A payment dated after `asOf` is left out.
 */
function paymentRows(s: PaymentScope): string {
  return `pay as (
    select ${s.select} p.currency, p.verification, p.status as p_status, p.provider, p.livemode,
      p.amount_minor - p.tax_portion_minor as paid_ex,
      least(coalesce(rf.amount, 0) - least(coalesce(rf.tax, 0), p.tax_portion_minor), p.amount_minor - p.tax_portion_minor) as refunded_ex
    from ${s.from}
      join customer_payments p on p.org_id = ${s.org} and p.invoice_id = i.id and p.received_at <= ${s.asOf}
      left join lateral (
        select sum(r.amount_minor) as amount, sum(r.tax_portion_minor) as tax from customer_refunds r where r.org_id = ${s.org} and r.payment_id = p.id and r.status = 'succeeded'
      ) rf on true
    ${s.where}
  )`;
}

export interface CohortRevenue {
  /** By the source each lead is credited to. */
  bySource: Map<string, RevenueFigures>;
  /** Payments of these leads the provider confirmed in test mode (or the simulated provider): left out. */
  testPaymentsExcluded: number;
  /** Payments of these leads under an open dispute: held out until it is settled. */
  disputedHeldOut: number;
}

/**
 * Revenue of the leads in the report's cohort (`base` is the report's `with leads as (...)`, written for $1 workspace, $2 start, $3 end), for payments received any time up to
 * `asOf`. A lead is credited with the invoices that are now on its contact, so a contact that was merged into another brings its invoices with it.
 */
export async function cohortRevenue(db: Queryable, base: string, params: [string, Date, Date], asOf: Date, manualCounted: boolean): Promise<CohortRevenue> {
  const pay = paymentRows({ select: "l.source,", from: "leads l join customer_invoices i on i.org_id = $1 and i.contact_id = l.id and i.status = 'issued'", where: "", org: "$1", asOf: "$4" });
  const all = [...params, asOf];
  const sums = await db.query<{ source: string } & RevenueRow>(
    `${base}, ${pay}
     select source, currency, verification, sum(paid_ex)::text as "paidExTax", sum(refunded_ex)::text as "refundedExTax"
     from pay where ${IS_VERIFIED} or ${IS_BY_HAND} group by source, currency, verification`,
    all,
  );
  const counts = await db.query<{ test: string; held: string }>(
    `${base}, ${pay}
     select count(*) filter (where ${IS_TEST})::text as test, count(*) filter (where p_status = 'disputed')::text as held from pay`,
    all,
  );
  const bySource = new Map<string, RevenueFigures>();
  for (const source of new Set(sums.rows.map((r) => r.source))) {
    bySource.set(source, figuresFromRows(sums.rows.filter((r) => r.source === source), manualCounted));
  }
  return { bySource, testPaymentsExcluded: Number(counts.rows[0]?.test ?? 0), disputedHeldOut: Number(counts.rows[0]?.held ?? 0) };
}

/** Revenue on invoices that belong to no customer any more (after a privacy erasure), which cannot be credited to a source. All time up to `asOf`. */
export async function unattributedRevenue(db: Queryable, orgId: string, asOf: Date, manualCounted: boolean): Promise<RevenueFigures> {
  const pay = paymentRows({ select: "", from: "customer_invoices i", where: "where i.org_id = $1 and i.contact_id is null and i.status = 'issued'", org: "$1", asOf: "$2" });
  const { rows } = await db.query<RevenueRow>(
    `with ${pay}
     select currency, verification, sum(paid_ex)::text as "paidExTax", sum(refunded_ex)::text as "refundedExTax" from pay where ${IS_VERIFIED} or ${IS_BY_HAND} group by currency, verification`,
    [orgId, asOf],
  );
  return figuresFromRows(rows, manualCounted);
}

/** Whether the workspace has recorded any customer payment at all (of any kind): the report says "needs verified payments" only until it has. */
export async function workspaceHasPayments(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from customer_payments where org_id = $1 limit 1", [orgId]);
  return rows.length > 0;
}

/** Whether the owner counts payments recorded by hand as verified revenue (invoice settings; off until they choose). */
export async function manualCountsAsVerified(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ count_manual_as_verified: boolean }>("select count_manual_as_verified from customer_invoice_settings where org_id = $1", [orgId]);
  return rows[0]?.count_manual_as_verified === true;
}
