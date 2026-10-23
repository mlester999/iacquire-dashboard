import "server-only";
import type { Queryable } from "@/server/db";
import { formatMinor, isCurrency, type CurrencyCode } from "@/lib/money";
import { AUTHORIZATION_PROBLEM_TEXT, reminderReasonText } from "@/lib/invoices/reminder-rules";
import { readSettings, toMinor } from "@/server/invoices/core";
import { invoicesEnabledIn } from "@/server/invoices/feature";
import { currentAuthorizationProblem } from "@/server/invoices/reminder-auth";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck, type ReviewMetric } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";

// The Performance Analyst's read-only look at what customers owe. It reads issued invoices, the payments and refunds recorded against them, the payment provider's deliveries
// and the state of the payment account's connection. It issues nothing, sends nothing, voids nothing, records nothing, refunds nothing, and contacts neither a customer nor a
// payment provider. It never adds amounts in different currencies together, never says why a customer has not paid, and names no customer: an invoice is identified by its
// number, its amount and how late it is.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const LATE_RED_DAYS = 30;

/** A check that reads nothing for a workspace whose owner never had customer invoices switched on. */
const whenEnabled = (check: ReviewCheck): ReviewCheck => async (db, job) => ((await invoicesEnabledIn(db, job.org_id)) ? check(db, job) : null);

export const notSwitchedOn: ReviewCheck = async (db, job) => {
  if (await invoicesEnabledIn(db, job.org_id)) return null;
  return reviewFinding({
    key: "receivables_not_switched_on", severity: "info", count: 1,
    title: "Customer invoices are not switched on for this workspace",
    detail: "There is nothing to review: no invoices are kept here until iAcquire switches the feature on for the workspace.",
    evidenceHref: "/invoices", recommendedAction: "Ask your iAcquire team to switch customer invoices on if you want to use them.", requiresApproval: false,
  });
};

interface OverdueRow {
  number: string | null;
  currency: CurrencyCode;
  balance_minor: string;
  late_days: number;
}

/** Issued, still owing, not written off or disputed, due before today in the workspace's own time zone. */
const OVERDUE_FROM = `from customer_invoices i join organizations o on o.id = i.org_id
  where i.org_id = $1 and i.status = 'issued' and i.payment_status in ('unpaid', 'partially_paid') and i.written_off_at is null and i.due_on is not null
    and i.due_on < (now() at time zone coalesce(o.timezone, 'UTC'))::date`;

export const overdueInvoices: ReviewCheck = whenEnabled(async (db, job) => {
  const { rows } = await db.query<OverdueRow>(
    `select i.number, i.currency, i.balance_minor::text as balance_minor, ((now() at time zone coalesce(o.timezone, 'UTC'))::date - i.due_on)::int as late_days ${OVERDUE_FROM} order by i.due_on, i.id limit 200`,
    [job.org_id],
  );
  if (!rows.length) return null;
  // Per currency: amounts in different currencies are never added together, and no rate is ever invented.
  const totals = new Map<CurrencyCode, number>();
  for (const r of rows) if (isCurrency(r.currency)) totals.set(r.currency, (totals.get(r.currency) ?? 0) + toMinor(r.balance_minor));
  const worst = Math.max(...rows.map((r) => r.late_days));
  const owed = [...totals].map(([c, minor]) => formatMinor(minor, c, "code")).join(" and ");
  return reviewFinding({
    key: "receivables_overdue", severity: worst >= LATE_RED_DAYS ? "critical" : "warning", count: rows.length,
    samples: rows.slice(0, 3).map((r) => `${r.number ?? "An invoice"}: ${formatMinor(toMinor(r.balance_minor), r.currency, "code")}, ${plural(r.late_days, "day")} late`),
    title: `${plural(rows.length, "unpaid invoice")} ${rows.length === 1 ? "is" : "are"} past ${rows.length === 1 ? "its" : "their"} due date`,
    detail: `Still owed on ${rows.length === 1 ? "it" : "them"}: ${owed}. The longest is ${plural(worst, "day")} late. This is as of now; the overdue notices go out only while the scheduler runs. Invoices that were written off or have a disputed payment are left out.`,
    evidenceHref: "/invoices", recommendedAction: "Contact the customers who owe, or write an invoice off if you will not collect it. Reminders go only if the owner authorized them.", requiresApproval: false,
  });
});

export const paymentsNeedReview: ReviewCheck = whenEnabled(async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce((array_agg(coalesce(i.number, 'An invoice') order by p.received_at))[1:3], '{}') as samples
     from customer_payments p join customer_invoices i on i.id = p.invoice_id and i.org_id = p.org_id where p.org_id = $1 and p.status = 'needs_review'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "receivables_payments_review", severity: "critical", count, samples: rows[0]?.samples ?? [],
    title: `${plural(count, "payment")} the provider reported ${count === 1 ? "is" : "are"} held out of the books`,
    detail: "The amount, the currency or the invoice did not match what was asked for, or the invoice could not take it. Nothing was counted as paid, and nothing was refunded.",
    evidenceHref: "/invoices", recommendedAction: "Check each one in your payment provider's dashboard, then record it by hand if it is real.", requiresApproval: false,
  });
});

export const failedPayments: ReviewCheck = whenEnabled(async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce((array_agg(coalesce(i.number, 'An invoice') order by p.received_at desc))[1:3], '{}') as samples
     from customer_payments p join customer_invoices i on i.id = p.invoice_id and i.org_id = p.org_id
     where p.org_id = $1 and p.status = 'failed' and p.created_at > now() - interval '14 days' and i.payment_status in ('unpaid', 'partially_paid') and i.written_off_at is null`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "receivables_payments_failed", severity: "warning", count, samples: rows[0]?.samples ?? [],
    title: `${plural(count, "payment attempt")} failed in the last 14 days on ${count === 1 ? "an invoice" : "invoices"} still owed`,
    detail: "The customer tried to pay online and the payment did not go through. Why is the payment provider's to say; this product does not know it.",
    evidenceHref: "/invoices", recommendedAction: "Ask the customer to try again from their invoice link, or to pay another way.", requiresApproval: false,
  });
});

export const disputedPayments: ReviewCheck = whenEnabled(async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(distinct i.id)::int as count, coalesce((array_agg(distinct coalesce(i.number, 'An invoice')))[1:3], '{}') as samples
     from customer_payments p join customer_invoices i on i.id = p.invoice_id and i.org_id = p.org_id where p.org_id = $1 and p.status = 'disputed'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "receivables_disputes", severity: "warning", count, samples: rows[0]?.samples ?? [],
    title: `${plural(count, "invoice")} ${count === 1 ? "has" : "have"} a payment the customer disputed with their bank`,
    detail: "Reminders to these customers stop, and nothing about their deals changes while a dispute is open. How to answer a dispute is decided in the payment provider's dashboard.",
    evidenceHref: "/invoices", recommendedAction: "Respond to the dispute with your payment provider before its deadline.", requiresApproval: false,
  });
});

export const overpaidInvoices: ReviewCheck = whenEnabled(async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce((array_agg(coalesce(i.number, 'An invoice') order by i.updated_at desc))[1:3], '{}') as samples
     from customer_invoices i where i.org_id = $1 and i.status = 'issued' and i.overpaid_minor > 0`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "receivables_overpaid", severity: "warning", count, samples: rows[0]?.samples ?? [],
    title: `${plural(count, "invoice")} received more than ${count === 1 ? "it was" : "they were"} for`,
    detail: "The difference was kept in the books as received and nothing was refunded automatically.",
    evidenceHref: "/invoices", recommendedAction: "Decide with each customer whether to refund the difference or credit it, then record a refund if you hand money back.", requiresApproval: false,
  });
});

export const approvalsWaiting: ReviewCheck = whenEnabled(async (db, job) => {
  const { rows } = await db.query<{ count: number }>(
    `select count(*)::int as count from customer_invoices i where i.org_id = $1 and i.status = 'pending_approval'
       and (select max(e.at) from customer_invoice_events e where e.invoice_id = i.id and e.org_id = i.org_id and e.kind = 'submitted') < now() - interval '1 day'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "receivables_approvals_waiting", severity: "warning", count,
    title: `${plural(count, "invoice")} ${count === 1 ? "has" : "have"} been waiting for approval for over a day`,
    detail: "A customer cannot be billed until the owner or a manager has looked at the exact invoice and issued it.",
    evidenceHref: "/invoices", recommendedAction: "Approve and issue each one, or send it back with a note.", requiresApproval: false,
  });
});

export const deliveriesNotApplied: ReviewCheck = whenEnabled(async (db, job) => {
  const { rows } = await db.query<{ errors: number; waiting: number }>(
    `select count(*) filter (where outcome = 'error')::int as errors,
            count(*) filter (where outcome in ('received', 'deferred') and received_at < now() - interval '30 minutes')::int as waiting
     from customer_payment_events where org_id = $1`,
    [job.org_id],
  );
  const errors = Number(rows[0]?.errors ?? 0);
  const waiting = Number(rows[0]?.waiting ?? 0);
  const count = errors + waiting;
  if (!count) return null;
  return reviewFinding({
    key: "receivables_deliveries_stuck", severity: "critical", count,
    title: `${plural(count, "notice")} from your payment provider ${count === 1 ? "has" : "have"} not been applied`,
    detail: `${errors ? `${plural(errors, "notice")} failed to apply and ${errors === 1 ? "is" : "are"} tried again by the scheduler. ` : ""}${waiting ? `${plural(waiting, "notice")} ${waiting === 1 ? "is" : "are"} still waiting for the payment ${waiting === 1 ? "it refers" : "they refer"} to. ` : ""}A payment can be real before it is counted here.`,
    evidenceHref: "/settings/payments", recommendedAction: "Check the payment provider's dashboard for payments not shown on the invoices, and record them by hand if they are real.", requiresApproval: false,
  });
});

export const connectionNeedsAttention: ReviewCheck = whenEnabled(async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce((array_agg(provider order by provider))[1:3], '{}') as samples
     from customer_payment_connections where org_id = $1 and status = 'needs_attention'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "receivables_connection_attention", severity: "critical", count, samples: rows[0]?.samples ?? [],
    title: `${plural(count, "payment account")} ${count === 1 ? "needs" : "need"} attention`,
    detail: "The payment provider no longer accepts the saved key, so customers cannot pay online until it is reconnected.",
    evidenceHref: "/settings/payments", recommendedAction: "Ask the business owner to reconnect the account.", requiresApproval: false,
  });
});

export const remindersOnHold: ReviewCheck = whenEnabled(async (db, job) => {
  const s = await readSettings(db, job.org_id);
  if (!s.remindersEnabled) return null;
  const problem = await currentAuthorizationProblem(db, job.org_id, s, new Date());
  if (!problem) return null;
  return reviewFinding({
    key: "receivables_reminders_on_hold", severity: "warning", count: 1,
    title: "Invoice reminders are switched on but on hold",
    detail: `${AUTHORIZATION_PROBLEM_TEXT[problem]} No reminder goes to a customer until the owner authorizes them again.`,
    evidenceHref: "/invoices/settings", recommendedAction: "Ask the business owner to read the reminders and authorize them again.", requiresApproval: false,
  });
});

export const remindersNotSent: ReviewCheck = whenEnabled(async (db, job) => {
  const { rows } = await db.query<{ reason: string | null; n: number }>(
    `select reason, count(*)::int as n from customer_invoice_reminders where org_id = $1 and status = 'blocked' and updated_at > now() - interval '14 days' group by reason order by n desc`,
    [job.org_id],
  );
  const count = rows.reduce((t, r) => t + Number(r.n), 0);
  if (!count) return null;
  return reviewFinding({
    key: "receivables_reminders_blocked", severity: "info", count, samples: rows.slice(0, 3).map((r) => `${plural(Number(r.n), "reminder")}: ${reminderReasonText(r.reason) || "not sent"}`),
    title: `${plural(count, "reminder")} could not be sent in the last 14 days`,
    detail: "The rules every message to a customer follows stopped them: for example no consent on record, an opted-out address, no email address, no service credits or a channel that is not ready. They were not forced through.",
    evidenceHref: "/invoices", recommendedAction: "Fix what each reason says, or contact those customers yourself.", requiresApproval: false,
  });
});

export const metrics = async (db: Queryable, job: WorkJobRow): Promise<ReviewMetric[]> => {
  if (!(await invoicesEnabledIn(db, job.org_id))) return [];
  const { rows } = await db.query<{ open: number; overdue: number; paid: number }>(
    `select count(*) filter (where i.status = 'issued' and i.payment_status in ('unpaid', 'partially_paid') and i.written_off_at is null)::int as open,
            count(*) filter (where i.status = 'issued' and i.payment_status in ('unpaid', 'partially_paid') and i.written_off_at is null and i.due_on < (now() at time zone coalesce(o.timezone, 'UTC'))::date)::int as overdue,
            count(*) filter (where i.status = 'issued' and exists (select 1 from customer_invoice_events e where e.invoice_id = i.id and e.org_id = i.org_id and e.kind = 'paid' and e.at > now() - interval '30 days'))::int as paid
     from customer_invoices i join organizations o on o.id = i.org_id where i.org_id = $1`,
    [job.org_id],
  );
  const r = rows[0] ?? { open: 0, overdue: 0, paid: 0 };
  return [
    { key: "receivables_open_invoices", label: "Unpaid invoices", value: r.open, period: "Now", definition: "Issued invoices that still owe something and were not written off. Amounts are not added up: they can be in different currencies.", source: "Customer invoices" },
    { key: "receivables_overdue_invoices", label: "Overdue invoices", value: r.overdue, period: "Now", definition: "Unpaid invoices whose due date is before today in the workspace's time zone.", source: "Customer invoices" },
    { key: "receivables_paid_invoices", label: "Invoices paid in the last 30 days", value: r.paid, period: "Last 30 days", definition: "Invoices that became paid in full in the period, by a provider-confirmed payment or one a person recorded by hand.", source: "Customer invoices" },
  ];
};

export async function runReceivablesReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "receivables_review",
    allowedRoles: ["performance_analyst"],
    scanningMessage: "Reading issued invoices, recorded payments and refunds, payment provider notices and the payment account's connection…",
    analyzingMessage: "Working out which invoices are overdue and which payments need a person…",
    checks: [notSwitchedOn, connectionNeedsAttention, deliveriesNotApplied, paymentsNeedReview, overdueInvoices, failedPayments, disputedPayments, overpaidInvoices, approvalsWaiting, remindersOnHold, remindersNotSent],
    metrics,
    limitations: "Only stored records in this workspace were read. Nothing was issued, sent, voided, recorded or refunded, and neither a customer nor a payment provider was contacted. Amounts in different currencies are never added together and no exchange rate is used. Overdue is judged as of this review in the workspace's time zone, not live. The review says what is owed and what needs a person; it does not know why a customer has not paid.",
    subject: "Receivables",
  });
}
