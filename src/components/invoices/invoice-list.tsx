import Link from "next/link";
import { AlertTriangle, Receipt } from "lucide-react";
import { EmptyState } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { formatDay, formatInstant, money, PROVIDER_NAMES } from "@/lib/invoices/labels";
import { LIST_FILTER_LABELS, LIST_FILTERS, type ListFilter } from "@/lib/invoices/screens";
import type { InvoiceView } from "@/server/invoices/views";
import type { ReceivablesSummary } from "@/server/invoices/invoices";
import type { NeedsLookRow } from "@/server/invoices/search";
import { OverdueBadge, PaymentBadge, StatusBadge } from "@/components/invoices/status";

// The invoices list and what sits above it. Nothing here changes anything. Amounts are per currency and are never added across currencies. "Overdue" is true when the page is
// read; the scheduled sweep that raises the notice runs only when the scheduler does, and the page says so.

export function ReceivablesCards({ summary }: { summary: ReceivablesSummary }) {
  if (summary.byCurrency.length === 0) return null;
  return (
    <section aria-label="What is owed" className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {summary.byCurrency.map((r) => (
          <div key={r.currency} className="rounded-2xl border border-line bg-surface p-4">
            <p className="text-[12px] font-semibold uppercase tracking-[.1em] text-muted">{r.currency}</p>
            <p className="mt-1 text-[24px] font-semibold tabular-nums text-ink">{money(r.outstandingMinor, r.currency)}</p>
            <p className="text-[12.5px] text-muted">owed on {r.openCount} {r.openCount === 1 ? "invoice" : "invoices"}</p>
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-muted">Overdue</dt>
              <dd className={cn("text-right tabular-nums", r.overdueMinor > 0 ? "font-medium text-danger-ink" : "text-ink-2")}>{money(r.overdueMinor, r.currency)}{r.overdueCount > 0 ? ` (${r.overdueCount})` : ""}</dd>
              <dt className="text-muted">Received, net of refunds</dt>
              <dd className="text-right tabular-nums text-ink-2">{money(r.netReceivedMinor, r.currency)}</dd>
              {r.testPaidMinor > 0 && (<><dt className="text-muted">Paid in test mode</dt><dd className="text-right tabular-nums text-ink-2" title="The payment provider ran these in test mode. No real money moved.">{money(r.testPaidMinor, r.currency)}</dd></>)}
            </dl>
          </div>
        ))}
      </div>
      <p className="text-[12.5px] text-muted">Each currency is shown on its own and is never converted. Overdue is worked out when you open this page; the reminder and overdue notices go out only while the scheduler runs. Payments the provider ran in test mode are never counted as received.</p>
    </section>
  );
}

export function InvoiceFilters({ active, search }: { active: ListFilter; search: string }) {
  const href = (f: ListFilter) => `/invoices?filter=${f}${search ? `&q=${encodeURIComponent(search)}` : ""}`;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <nav aria-label="Filter invoices" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1">
        {LIST_FILTERS.map((f) => (
          <Link key={f} href={href(f)} aria-current={active === f ? "page" : undefined} className={cn("inline-flex h-11 shrink-0 items-center rounded-xl px-3 text-[13px] font-medium sm:h-9", active === f ? "bg-primary-soft text-primary-ink" : "text-ink-2 hover:bg-surface-2")}>
            {LIST_FILTER_LABELS[f]}
          </Link>
        ))}
      </nav>
      <form action="/invoices" method="get" role="search" className="flex gap-2">
        <input type="hidden" name="filter" value={active} />
        <label htmlFor="invoice-search" className="sr-only">Search by invoice number or customer</label>
        <input id="invoice-search" name="q" defaultValue={search} placeholder="Number or customer" maxLength={80} className="h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3 text-[16px] text-ink shadow-soft outline-none focus:border-primary focus:ring-4 focus:ring-primary/12 sm:h-9 sm:w-56 sm:text-[13px]" />
        <button type="submit" className="inline-flex h-11 items-center rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-2 sm:h-9">Search</button>
      </form>
    </div>
  );
}

export function InvoiceList({ rows, empty }: { rows: InvoiceView[]; empty: { title: string; description: string; action?: React.ReactNode } }) {
  if (rows.length === 0) return <EmptyState icon={<Receipt className="size-5" />} title={empty.title} description={empty.description} action={empty.action} />;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label="Invoices">
      {rows.map((i) => (
        <li key={i.id}>
          <Link href={`/invoices/${i.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-primary">
            <span className="min-w-0 flex-1 basis-48">
              <span className="block truncate text-[14px] font-medium text-ink"><span className="tabular-nums">{i.number ?? "Draft"}</span>{i.contactName ? <span className="font-normal text-ink-2"> · {i.contactName}</span> : <span className="font-normal text-warning-ink"> · no customer yet</span>}</span>
              <span className="block truncate text-[12.5px] text-muted">{i.dueOn ? `Due ${formatDay(i.dueOn)}` : "No due date yet"}{i.opportunityName ? ` · Deal: ${i.opportunityName}` : ""}</span>
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={i.status} />
              {i.status === "issued" && <PaymentBadge status={i.paymentStatus} />}
              {i.overdue && <OverdueBadge days={i.daysOverdue} />}
            </span>
            <span className="min-w-24 text-right">
              <span className="block text-[14px] font-semibold tabular-nums text-ink">{money(i.totalMinor, i.currency)}</span>
              {i.status === "issued" && i.balanceMinor > 0 && i.balanceMinor !== i.totalMinor && <span className="block text-[12px] tabular-nums text-muted">{money(i.balanceMinor, i.currency)} left</span>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const LOOK_WORDS: Record<NeedsLookRow["status"], string> = {
  needs_review: "Reported by the provider but not counted. Compare it with the provider's dashboard.",
  disputed: "The customer disputed it with their bank.",
  pending: "Still being processed by the provider.",
};

export function NeedsLookList({ rows, tz }: { rows: NeedsLookRow[]; tz: string }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="needs-look" className="space-y-2">
      <h2 id="needs-look" className="flex items-center gap-2 text-[14px] font-semibold text-ink"><AlertTriangle className="size-4 text-warning-ink" aria-hidden />Payments that need a look</h2>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-warning-ink/30 bg-warning-soft/40">
        {rows.map((r) => (
          <li key={r.paymentId}>
            <Link href={`/invoices/${r.invoiceId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[13.5px] hover:bg-warning-soft/70 focus-visible:outline-2 focus-visible:outline-primary">
              <span className="font-medium tabular-nums text-ink">{r.invoiceNumber ?? "Invoice"}</span>
              <span className="tabular-nums text-ink-2">{money(r.amountMinor, r.currency)}</span>
              <span className="min-w-0 flex-1 basis-56 text-ink-2">{LOOK_WORDS[r.status]}</span>
              <span className="text-[12.5px] text-muted">{PROVIDER_NAMES[r.provider] ?? r.provider} · {formatInstant(r.at, tz)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
