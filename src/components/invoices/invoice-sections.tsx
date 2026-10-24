import Link from "next/link";
import { BellRing, History } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { eventSentence, formatDay, formatInstant, madeByText, money, moneyCode } from "@/lib/invoices/labels";
import { formatBps } from "@/lib/invoices/lines";
import { stepLabel } from "@/lib/invoices/reminders";
import type { InvoiceFullDetail } from "@/server/invoices/invoices";
import { OverdueBadge, PaymentBadge, StatusBadge, TestBadge } from "@/components/invoices/status";

// The read-only parts of an invoice page: what it says, what happened to it, and what will be said to the customer. Nothing here changes anything.

export function InvoiceSummary({ detail, tz }: { detail: InvoiceFullDetail; tz: string }) {
  const i = detail.invoice;
  const dealHref = i.opportunityId ? `/crm/opportunities/${i.opportunityId}` : null;
  return (
    <section aria-label="Summary" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={i.status} />
        {i.isTest && <TestBadge />}
        {i.status === "issued" && (!i.isTest || i.paymentStatus !== "unpaid") && <PaymentBadge status={i.paymentStatus} />}
        {i.overdue && <OverdueBadge days={i.daysOverdue} />}
        {i.writtenOffAt && <Badge tone="outline" title={i.writeOffReason ?? undefined}>Written off</Badge>}
        {madeByText(i.createdVia) && <Badge tone="violet">{madeByText(i.createdVia)}</Badge>}
      </div>
      {i.isTest && <p role="note" className="rounded-xl border border-violet-ink/20 bg-violet-soft px-3 py-2 text-[13px] text-violet-ink">This is a test invoice: nothing is owed on it and no money moves. It has its own numbers, is never reminded about, is left out of what is owed, overdue, your revenue and your deals, and can be voided or deleted even after a test payment.</p>}
      <dl className="grid gap-x-8 gap-y-3 text-[13.5px] sm:grid-cols-2 lg:grid-cols-3">
        <div><dt className="text-muted">Customer</dt><dd className="font-medium text-ink">{i.contactId ? <Link href={`/crm/contacts/${i.contactId}`} className="inline-flex min-h-11 items-center underline-offset-2 hover:underline sm:min-h-0">{i.contactName ?? "Customer"}</Link> : <span className="text-warning-ink">Not chosen yet</span>}{i.companyName ? <span className="font-normal text-ink-2"> · {i.companyName}</span> : null}</dd></div>
        {dealHref && <div><dt className="text-muted">Deal</dt><dd className="font-medium text-ink"><Link href={dealHref} className="inline-flex min-h-11 items-center underline-offset-2 hover:underline sm:min-h-0">{i.opportunityName ?? "Deal"}</Link></dd></div>}
        <div><dt className="text-muted">Issued</dt><dd className="text-ink">{i.issueOn ? formatDay(i.issueOn) : "Not issued yet"}</dd></div>
        <div><dt className="text-muted">Due</dt><dd className="text-ink">{i.dueOn ? formatDay(i.dueOn) : "Set when it is issued"}</dd></div>
        <div><dt className="text-muted">Version</dt><dd className="text-ink">{i.version}{i.approvedVersion ? ` · approved version ${i.approvedVersion}${i.approvedByName ? ` by ${i.approvedByName}` : ""}` : ""}</dd></div>
        <div><dt className="text-muted">Written by</dt><dd className="text-ink">{i.createdByName ?? "A team member"} · {formatInstant(i.createdAt, tz)}</dd></div>
        {i.firstViewedAt && <div><dt className="text-muted">Customer opened it</dt><dd className="text-ink">{formatInstant(i.firstViewedAt, tz)}</dd></div>}
        {i.voidedAt && <div className="sm:col-span-2"><dt className="text-muted">Voided</dt><dd className="text-ink">{formatInstant(i.voidedAt, tz)}{i.voidReason ? ` · ${i.voidReason}` : ""}</dd></div>}
        {i.writtenOffAt && <div className="sm:col-span-2"><dt className="text-muted">Written off</dt><dd className="text-ink">{formatInstant(i.writtenOffAt, tz)}{i.writeOffReason ? ` · ${i.writeOffReason}` : ""}</dd></div>}
      </dl>
      <dl className="grid grid-cols-2 gap-3 border-t border-line pt-4 sm:grid-cols-4" aria-label="Amounts">
        {[["Total", i.totalMinor], ["Paid", i.paidMinor], ["Refunded", i.refundedMinor], ["Balance", i.balanceMinor]].map(([label, minor]) => (
          <div key={label as string} className="rounded-xl bg-surface-2/60 px-3 py-2"><dt className="text-[12px] text-muted">{label as string}</dt><dd className="text-[17px] font-semibold tabular-nums text-ink">{money(minor as number, i.currency)}</dd></div>
        ))}
      </dl>
      {i.overpaidMinor > 0 && <p role="status" className="rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">More than the total was received ({money(i.overpaidMinor, i.currency)} extra). Nothing was refunded; decide what to do with the difference.</p>}
    </section>
  );
}

const BILLING_WORDS = { monthly: "every month", yearly: "every year" } as const;

/** Where an invoice made from a proposal came from, and the monthly or yearly lines that were left for the owner to decide. Nothing here changes anything. */
export function SourceNote({ detail }: { detail: InvoiceFullDetail }) {
  const s = detail.source;
  if (!s) return null;
  const i = detail.invoice;
  const hidden = Math.max(0, s.recurringCount - s.recurring.length);
  return (
    <section aria-labelledby="inv-source" className="space-y-2 rounded-2xl border border-line bg-surface p-4">
      <h2 id="inv-source" className="text-[15px] font-semibold text-ink">Made from a proposal</h2>
      <p className="text-[13.5px] text-ink-2">
        The lines the customer pays once were copied from{" "}
        {s.proposalNumber ? <Link href={`/proposals/${s.proposalId}`} className="inline-flex min-h-11 items-center font-medium text-ink underline-offset-2 hover:underline sm:min-h-0">proposal {s.proposalNumber}</Link> : "an accepted proposal"}
        , version {s.proposalVersion}, as that version was accepted. Nothing else was copied, and nothing was issued or sent.
        {i.status === "draft" || i.status === "pending_approval" ? " You can change this draft before it is issued." : ""}
      </p>
      {s.recurringCount > 0 && (
        <div className="rounded-xl bg-warning-soft px-3 py-2.5 text-[13px] text-warning-ink">
          <p className="font-medium">{s.recurringCount === 1 ? "One line is" : `${s.recurringCount} lines are`} not on this invoice.</p>
          <p className="mt-0.5">The customer pays {s.recurringCount === 1 ? "it" : "them"} every month or every year, and whether and when to invoice {s.recurringCount === 1 ? "it" : "them"} is yours to decide.</p>
          {s.recurring.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5" aria-label="Lines that were not copied">
              {s.recurring.map((r, n) => <li key={n} className="break-words">{r.name}, {BILLING_WORDS[r.billing]}, {moneyCode(r.totalMinor, i.currency)} each time</li>)}
              {hidden > 0 && <li>and {hidden} more</li>}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function LinesTable({ detail }: { detail: InvoiceFullDetail }) {
  const i = detail.invoice;
  return (
    <section aria-labelledby="inv-lines-read" className="space-y-2">
      <h2 id="inv-lines-read" className="text-[15px] font-semibold text-ink">Lines</h2>
      <div className="overflow-x-auto rounded-2xl border border-line bg-surface" role="region" aria-label="Invoice lines" tabIndex={0}>
        <table className="w-full min-w-[520px] text-left text-[13.5px]">
          <caption className="sr-only">Lines on this invoice, amounts in {i.currency}</caption>
          <thead className="border-b border-line text-[12px] text-muted">
            <tr><th scope="col" className="px-4 py-2 font-medium">Description</th><th scope="col" className="px-2 py-2 text-right font-medium">Qty</th><th scope="col" className="px-2 py-2 text-right font-medium">Price</th><th scope="col" className="px-2 py-2 text-right font-medium">Tax</th><th scope="col" className="px-4 py-2 text-right font-medium">Amount</th></tr>
          </thead>
          <tbody>
            {detail.lines.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0">
                <th scope="row" className="whitespace-pre-wrap break-words px-4 py-2 font-normal text-ink">{l.description}{l.discountMinor > 0 ? <span className="block text-[12px] text-muted">Discount {money(l.discountMinor, i.currency)}{l.discountBps !== null ? ` (${formatBps(l.discountBps)}%)` : ""}</span> : null}</th>
                <td className="px-2 py-2 text-right tabular-nums">{l.quantity}</td>
                <td className="px-2 py-2 text-right tabular-nums">{money(l.unitPriceMinor, i.currency)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{l.taxRateBps !== null ? `${formatBps(l.taxRateBps)}%` : "None"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(i.taxInclusive ? l.totalMinor : l.exTaxMinor, i.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-[13.5px]">
        <dt className="text-muted">Subtotal{i.taxInclusive ? " (before tax)" : ""}</dt><dd className="text-right tabular-nums text-ink">{money(i.subtotalMinor, i.currency)}</dd>
        <dt className="text-muted">Tax{i.taxInclusive ? " (included)" : ""}</dt><dd className="text-right tabular-nums text-ink">{money(i.taxMinor, i.currency)}</dd>
        <dt className="font-semibold text-ink">Total</dt><dd className="text-right font-semibold tabular-nums text-ink">{money(i.totalMinor, i.currency)}</dd>
      </dl>
      {(i.paymentInstructions || i.notes || i.terms) && (
        <div className="grid gap-3 text-[13px] text-ink-2 sm:grid-cols-3">
          {i.paymentInstructions && <div><p className="text-[12px] font-medium text-muted">How to pay</p><p className="whitespace-pre-wrap break-words">{i.paymentInstructions}</p></div>}
          {i.notes && <div><p className="text-[12px] font-medium text-muted">Notes</p><p className="whitespace-pre-wrap break-words">{i.notes}</p></div>}
          {i.terms && <div><p className="text-[12px] font-medium text-muted">Terms</p><p className="whitespace-pre-wrap break-words">{i.terms}</p></div>}
        </div>
      )}
    </section>
  );
}

const MESSAGE_WORDS: Record<string, string> = { queued: "waiting to send", sending: "sending", sent: "sent", delivered: "delivered", failed: "failed to send", blocked: "blocked", cancelled: "withdrawn" };
const STATUS_TONE: Record<string, React.ComponentProps<typeof Badge>["tone"]> = { scheduled: "primary", queued: "success", blocked: "warning", skipped: "outline", cancelled: "outline" };
const STATUS_WORDS: Record<string, string> = { scheduled: "Scheduled", queued: "Handed to the message queue", blocked: "Blocked", skipped: "Not sent", cancelled: "Withdrawn" };

export function RemindersList({ detail, tz }: { detail: InvoiceFullDetail; tz: string }) {
  const rows = detail.reminders;
  if (detail.invoice.status !== "issued" && rows.length === 0) return null;
  return (
    <section aria-labelledby="inv-reminders" className="space-y-2">
      <h2 id="inv-reminders" className="flex items-center gap-2 text-[15px] font-semibold text-ink"><BellRing className="size-4 text-muted" aria-hidden />Reminders</h2>
      {rows.length === 0 && detail.invoice.isTest ? (
        <p className="rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">A test invoice is never reminded about: nothing is owed on it, so no customer is asked to pay it.</p>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">No reminders are planned for this invoice. Reminders go out only after the owner has authorized their exact wording in the invoice settings, and only to a customer who has agreed to receive service messages. They are checked when the scheduler runs, not live.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label="Reminders">
          {rows.map((r) => {
            const offset = Number(r.stepKey.split(":")[1]);
            return (
              <li key={r.stepKey} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-[13.5px]">
                <span className="min-w-36 font-medium text-ink">{Number.isFinite(offset) ? stepLabel(offset) : r.stepKey}</span>
                <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{STATUS_WORDS[r.status] ?? r.status}</Badge>
                <span className="text-[12.5px] text-muted">{formatInstant(r.dueAt, tz)}{r.channel ? ` · ${r.channel}` : ""}{r.messageStatus ? ` · ${MESSAGE_WORDS[r.messageStatus] ?? r.messageStatus}` : ""}</span>
                {r.reasonText && <span className="basis-full text-[12.5px] text-ink-2">{r.reasonText}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function Timeline({ detail, tz }: { detail: InvoiceFullDetail; tz: string }) {
  const rows = [...detail.events].reverse();
  return (
    <section aria-labelledby="inv-history" className="space-y-2">
      <h2 id="inv-history" className="flex items-center gap-2 text-[15px] font-semibold text-ink"><History className="size-4 text-muted" aria-hidden />History</h2>
      <ol className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {rows.map((e) => (
          <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-[13.5px]">
            <span className="min-w-0 flex-1 basis-64 text-ink">{eventSentence(e.kind, e.detail)}</span>
            <span className="text-[12.5px] text-muted">{e.actorName ? `${e.actorName} · ` : e.actorKind === "customer" ? "The customer · " : e.actorKind === "provider" ? "Payment provider · " : e.actorKind === "system" ? "Automatic · " : ""}{formatInstant(e.at, tz)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
