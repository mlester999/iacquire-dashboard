import { CircleAlert, CircleCheck, Clock3, Info } from "lucide-react";
import { formatBps } from "@/lib/invoices/lines";
import { formatDay, money } from "@/lib/invoices/labels";
import type { InvoiceBannerKind } from "@/lib/invoices/public-status";
import type { PublicInvoice } from "@/server/invoices/public";

// The invoice as the customer reads it. It says what the database holds and nothing it computed in the browser; it prints as a plain document (the buttons and the page
// frame drop out). No script is needed to read it.

const BANNER_ICON = { ok: CircleCheck, wait: Clock3, problem: CircleAlert, info: Info } as const;
const BANNER_STYLE = {
  ok: "border-success-ink/25 bg-success-soft text-success-ink",
  wait: "border-warning-ink/30 bg-warning-soft text-warning-ink",
  problem: "border-danger/25 bg-danger-soft text-danger-ink",
  info: "border-line bg-surface-2 text-ink-2",
} as const;

export function bannerText(kind: InvoiceBannerKind, i: Pick<PublicInvoice, "balanceMinor" | "currency" | "dueOn" | "business">): string {
  switch (kind) {
    case "test": return "This is a test invoice: nothing is owed and no money moves.";
    case "paid": return "Paid in full. Thank you.";
    case "partly_paid": return `Partly paid. ${money(i.balanceMinor, i.currency)} is still due.`;
    case "under_review": return "A payment on this invoice is being reviewed. You do not need to pay again.";
    case "pending": return "A payment is being processed by your payment provider. Please do not pay again.";
    case "overdue": return `This invoice was due on ${formatDay(i.dueOn)}.`;
    case "pay_online": return "You can pay this invoice online, or use the instructions below.";
    case "pay_other_way": return `Online payment is not available for this invoice. Please follow the payment instructions below${i.business.email || i.business.phone ? ", or contact the business" : ""}.`;
  }
}

function Address({ name, lines, extra }: { name?: string | null; lines: string[]; extra?: string[] }) {
  return (
    <div className="text-[14px] leading-relaxed text-ink-2">
      {name && <p className="font-medium text-ink">{name}</p>}
      {lines.map((l, i) => <p key={i}>{l}</p>)}
      {(extra ?? []).map((l, i) => <p key={`x${i}`}>{l}</p>)}
    </div>
  );
}

export function InvoiceDocument({ invoice: i }: { invoice: PublicInvoice }) {
  const Icon = BANNER_ICON[i.banner.tone];
  const hasDiscount = i.lines.some((l) => l.discountMinor > 0);
  const businessExtra = [i.business.taxId ? `${i.business.taxLabel ?? "Tax number"}: ${i.business.taxId}` : i.business.taxLabel ?? ""].filter(Boolean);
  return (
    <article aria-labelledby="invoice-title" className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-8 print:rounded-none print:border-0 print:p-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 id="invoice-title" className="text-[26px] font-semibold tracking-[-0.03em] text-ink">{i.isTest ? "Test invoice" : "Invoice"}</h1>
          <p className="mt-0.5 text-[15px] font-medium tabular-nums text-ink-2">{i.number}</p>
          {/* Printed too: a test invoice must never pass for a real one on paper. */}
          {i.isTest && <p data-test-label className="mt-1 inline-block rounded-md border-2 border-violet-ink px-2 py-0.5 text-[12px] font-bold uppercase tracking-[.14em] text-violet-ink">Test · nothing is owed</p>}
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-[14px]">
          <dt className="text-muted">Issued</dt><dd className="font-medium text-ink">{formatDay(i.issueOn)}</dd>
          <dt className="text-muted">Due</dt><dd className="font-medium text-ink">{formatDay(i.dueOn)}</dd>
          <dt className="text-muted">Currency</dt><dd className="font-medium text-ink">{i.currency}</dd>
        </dl>
      </header>

      <p role="status" className={`mt-5 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-[14px] print:hidden ${BANNER_STYLE[i.banner.tone]}`}>
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{bannerText(i.banner.kind, i)}</span>
      </p>

      <section aria-label="Parties" className="mt-6 grid gap-5 sm:grid-cols-2">
        <div>
          <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[.1em] text-muted">From</h2>
          <Address name={i.business.name} lines={i.business.addressLines} extra={[...businessExtra, ...(i.business.email ? [i.business.email] : []), ...(i.business.phone ? [i.business.phone] : [])]} />
        </div>
        <div>
          <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[.1em] text-muted">Billed to</h2>
          {i.billTo.name || i.billTo.company || i.billTo.addressLines.length ? <Address name={i.billTo.name} lines={[...(i.billTo.company ? [i.billTo.company] : []), ...i.billTo.addressLines]} /> : <p className="text-[14px] text-muted">Customer details are not shown on this copy.</p>}
        </div>
      </section>

      {/* On a phone the page's text column is about 300 px wide, so the table has no minimum width: the description wraps (even a word with no spaces) and the Amount column keeps
          its width. Quantity and price are stacked under the description there and become their own columns from the small breakpoint and on paper. The box still scrolls and is
          reachable by keyboard if something ever does not fit. */}
      <div className="mt-6 overflow-x-auto" role="region" aria-label="Invoice lines" tabIndex={0}>
        <table className="w-full text-left text-[14px]">
          <caption className="sr-only">Lines on invoice {i.number}, amounts in {i.currency}</caption>
          <thead className="border-b border-line-strong text-[12px] text-muted">
            <tr>
              <th scope="col" className="py-2 pr-3 font-medium">Description</th>
              <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell print:table-cell">Qty</th>
              <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell print:table-cell">Price</th>
              <th scope="col" className="whitespace-nowrap py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {i.lines.map((l) => (
              <tr key={l.position} className="border-b border-line align-top">
                <th scope="row" className="py-2.5 pr-3 font-normal text-ink [overflow-wrap:anywhere]">
                  <span className="whitespace-pre-wrap">{l.description}</span>
                  <span className="mt-0.5 block text-[12px] text-muted sm:hidden print:hidden">{l.quantity} × {money(l.unitPriceMinor, i.currency)}</span>
                  {l.taxRateBps !== null && l.taxRateBps > 0 && <span className="mt-0.5 block text-[12px] text-muted">{i.taxInclusive ? "Includes" : "Plus"} {formatBps(l.taxRateBps)}% {i.business.taxLabel ?? "tax"}</span>}
                  {hasDiscount && l.discountMinor > 0 && <span className="mt-0.5 block text-[12px] text-muted">Discount: {money(l.discountMinor, i.currency)}</span>}
                </th>
                <td className="hidden py-2.5 pr-3 text-right tabular-nums sm:table-cell print:table-cell">{l.quantity}</td>
                <td className="hidden py-2.5 pr-3 text-right tabular-nums sm:table-cell print:table-cell">{money(l.unitPriceMinor, i.currency)}</td>
                <td className="whitespace-nowrap py-2.5 text-right tabular-nums text-ink">{money(l.amountMinor, i.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ml-auto mt-4 grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[14px]">
        <dt className="text-muted">Subtotal{i.taxInclusive ? " (before tax)" : ""}</dt><dd className="text-right tabular-nums text-ink">{money(i.subtotalMinor, i.currency)}</dd>
        {i.taxMinor > 0 && <><dt className="text-muted">{i.business.taxLabel ?? "Tax"}{i.taxInclusive ? " (included)" : ""}</dt><dd className="text-right tabular-nums text-ink">{money(i.taxMinor, i.currency)}</dd></>}
        <dt className="border-t border-line-strong pt-1.5 font-semibold text-ink">Total</dt><dd className="border-t border-line-strong pt-1.5 text-right text-[15px] font-semibold tabular-nums text-ink">{money(i.totalMinor, i.currency)}</dd>
        {i.paidMinor > 0 && <><dt className="text-muted">Paid</dt><dd className="text-right tabular-nums text-ink">{money(i.paidMinor, i.currency)}</dd></>}
        <dt className="font-semibold text-ink">Balance due</dt><dd className="text-right text-[15px] font-semibold tabular-nums text-ink">{money(i.balanceMinor, i.currency)}</dd>
      </dl>

      {(i.paymentInstructions || i.notes || i.terms || i.footerNote) && (
        <div className="mt-6 space-y-4 border-t border-line pt-5 text-[14px] leading-relaxed text-ink-2">
          {i.paymentInstructions && <section><h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[.1em] text-muted">How to pay</h2><p className="whitespace-pre-wrap break-words">{i.paymentInstructions}</p></section>}
          {i.notes && <section><h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[.1em] text-muted">Notes</h2><p className="whitespace-pre-wrap break-words">{i.notes}</p></section>}
          {i.terms && <section><h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[.1em] text-muted">Terms</h2><p className="whitespace-pre-wrap break-words">{i.terms}</p></section>}
          {i.footerNote && <p className="whitespace-pre-wrap break-words text-[13px] text-muted">{i.footerNote}</p>}
        </div>
      )}
    </article>
  );
}
