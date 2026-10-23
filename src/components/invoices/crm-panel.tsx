import Link from "next/link";
import { Plus, Receipt } from "lucide-react";
import { EmptyState } from "@/components/ui/primitives";
import { formatDay, money } from "@/lib/invoices/labels";
import type { InvoiceView } from "@/server/invoices/views";
import { OverdueBadge, PaymentBadge, StatusBadge } from "@/components/invoices/status";

/** The invoices of one customer or deal, for the Invoices tab on their page. Rows open the invoice; nothing here changes anything. */
export function InvoicesPanel({ rows, newHref, canCreate }: { rows: InvoiceView[]; newHref: string; canCreate: boolean }) {
  const action = canCreate ? <Link href={newHref} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl brand-gradient px-4 text-[13.5px] font-medium text-white sm:min-h-10"><Plus className="size-4" aria-hidden />New invoice</Link> : undefined;
  if (rows.length === 0) return <EmptyState compact icon={<Receipt className="size-5" />} title="No invoices yet" description="Bill this customer, share a payment page with them, and keep a record of what was paid." action={action} />;
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-2xl border border-line bg-surface" aria-label="Invoices">
        {rows.map((i) => (
          <li key={i.id}>
            <Link href={`/invoices/${i.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-primary">
              <Receipt className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium tabular-nums text-ink">{i.number ?? "Draft"}</span>
                <span className="block text-[12.5px] text-muted">{i.dueOn ? `Due ${formatDay(i.dueOn)}` : "No due date yet"}</span>
              </span>
              <StatusBadge status={i.status} />
              {i.status === "issued" && <PaymentBadge status={i.paymentStatus} />}
              {i.overdue && <OverdueBadge days={i.daysOverdue} />}
              <span className="shrink-0 text-[13px] font-medium tabular-nums text-ink">{money(i.totalMinor, i.currency)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {action}
    </div>
  );
}
