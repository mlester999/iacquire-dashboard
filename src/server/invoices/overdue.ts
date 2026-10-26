import "server-only";
import { withSystem } from "@/server/db";
import { notifyOrgRoles } from "@/server/notifications";
import { sanitizeErrorText } from "@/lib/ops";
import { formatMinor, toDecimalString, type CurrencyCode } from "@/lib/money";
import { daysOverdue, isOverdue, type InvoicePaymentStatus } from "@/lib/invoices/state";
import { dayWords } from "@/lib/invoices/reminder-text";
import { addInvoiceEvent, toMinor } from "@/server/invoices/core";
import { announceOverdue } from "@/server/invoices/crm-effects";

// The scheduled check that notices an invoice has gone past its due date (invoiceOverdueSweep). It runs only when the scheduler does, and in a staged start only when
// SCHEDULER_JOBS_ONLY names it. What it does for each invoice that is newly overdue is bounded and happens once per invoice and due date: a line in the invoice's history,
// a notice to the owner and managers, and an announcement Automation Studio can start a workflow from. It sends nothing to a customer; reminders are a separate job with
// their own authorization (src/server/invoices/reminders.ts).
//
// "Overdue" is true when it is read (src/lib/invoices/state.ts isOverdue: in the workspace's own time zone, not for a written-off or disputed invoice). This sweep is the
// only thing that says so out loud, so the screens say "checked when the scheduler runs" and never imply live monitoring.

const LIMIT = 500;

interface Candidate {
  id: string;
  org_id: string;
  due_on: string;
  timezone: string;
}

export interface OverdueReport {
  marked: number;
  failed: number;
}

export async function runInvoiceOverdueSweep(opts: { now?: Date; limit?: number } = {}): Promise<OverdueReport> {
  const now = opts.now ?? new Date();
  // Candidates by the UTC date (an overdue invoice is due before today in every time zone, and no zone is more than a day from UTC); each is then judged in its own zone.
  const candidates = (await withSystem((db) =>
    db.query<Candidate>(
      `select i.id, i.org_id, to_char(i.due_on, 'YYYY-MM-DD') as due_on, o.timezone
       from customer_invoices i
       join organizations o on o.id = i.org_id and o.kind = 'client' and o.status not in ('suspended', 'archived')
       join org_features f on f.org_id = i.org_id and f.feature = 'invoices' and f.enabled
       where i.status = 'issued' and not i.is_test and i.payment_status in ('unpaid', 'partially_paid') and i.written_off_at is null and i.due_on is not null
         and i.due_on <= ($1::timestamptz at time zone 'UTC')::date
         and not exists (select 1 from customer_invoice_events e where e.invoice_id = i.id and e.org_id = i.org_id and e.kind = 'overdue' and e.detail->>'dueOn' = to_char(i.due_on, 'YYYY-MM-DD'))
       order by i.due_on, i.id limit $2`,
      [now.toISOString(), Math.min(opts.limit ?? LIMIT, 2000)],
    ),
  )).rows;
  const out: OverdueReport = { marked: 0, failed: 0 };
  for (const c of candidates) {
    try {
      if (await markOverdue(c, now)) out.marked += 1;
    } catch (e) {
      out.failed += 1;
      console.error("[iacquire] an overdue invoice could not be recorded", { error: sanitizeErrorText(e, 120) });
    }
  }
  return out;
}

async function markOverdue(c: Candidate, now: Date): Promise<boolean> {
  return withSystem(async (db) => {
    // Locked and read again: a payment, a void or a write-off in the meantime wins.
    const inv = (await db.query<{ status: "draft" | "pending_approval" | "issued" | "void"; payment_status: InvoicePaymentStatus; written_off_at: Date | null; due_on: string; number: string | null; currency: CurrencyCode; balance_minor: string; is_test: boolean }>(
      `select status, payment_status, written_off_at, to_char(due_on, 'YYYY-MM-DD') as due_on, number, currency, balance_minor::text as balance_minor, is_test from customer_invoices where id = $1 and org_id = $2 for update`,
      [c.id, c.org_id],
    )).rows[0];
    if (!inv || !isOverdue({ status: inv.status, paymentStatus: inv.payment_status, dueOn: inv.due_on, writtenOff: inv.written_off_at !== null, isTest: inv.is_test }, now, c.timezone)) return false;
    const seen = await db.query("select 1 from customer_invoice_events where invoice_id = $1 and org_id = $2 and kind = 'overdue' and detail->>'dueOn' = $3 limit 1", [c.id, c.org_id, inv.due_on]);
    if (seen.rows[0]) return false;
    const days = daysOverdue(inv.due_on, now, c.timezone);
    const balance = toMinor(inv.balance_minor);
    await addInvoiceEvent(db, c.org_id, c.id, "overdue", { id: null, kind: "system" }, { dueOn: inv.due_on, daysOverdue: days, balance: toDecimalString(balance, inv.currency), currency: inv.currency });
    await notifyOrgRoles(db, c.org_id, ["owner", "admin"], {
      kind: "invoice_overdue", severity: "warning", title: `${inv.number ?? "An invoice"} is overdue`, body: `${formatMinor(balance, inv.currency, "code")} was due ${dayWords(inv.due_on)} and is still unpaid.`,
      link: `/invoices/${c.id}`, dedupeKey: `invoice-overdue:${c.id}:${inv.due_on}`,
    });
    await announceOverdue(db, c.org_id, c.id, days);
    return true;
  });
}
