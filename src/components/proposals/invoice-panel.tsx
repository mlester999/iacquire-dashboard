"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FilePlus2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/ui";
import { createInvoiceFromProposalAction } from "@/app/actions/invoices";
import { PaymentBadge, StatusBadge } from "@/components/invoices/status";
import { confirmText, madeText, makeOfferFor, type MadeResult } from "@/lib/invoices/from-proposal-ui";
import { formatBps } from "@/lib/invoices/lines";
import { moneyCode } from "@/lib/invoices/labels";
import { isCurrency } from "@/lib/money";
import { whenIn } from "@/lib/proposals/format";
import type { ProposalInvoicing } from "@/server/invoices/from-proposal";
import type { ProposalDetail } from "@/server/proposals/view";

// Turning an accepted proposal into a draft invoice. A person sees exactly what would be copied (the lines the customer pays once, from the version that was accepted), what is left
// off (the monthly and yearly lines, which are the owner's to decide) and how the proposal was accepted, and confirms. The result is a draft: nothing is issued, sent, charged or
// closed, and a linked deal is not touched. The server decides every rule again; this only offers what it will accept.

const BILLING_WORDS = { monthly: "every month", yearly: "every year" } as const;

export function InvoicePanel({ detail, invoicing, tz }: { detail: ProposalDetail; invoicing: ProposalInvoicing; tz: string }) {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState<null | "make" | "another">(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<MadeResult | null>(null);
  const statusRef = React.useRef<HTMLDivElement>(null);
  const preview = invoicing.preview;
  const currency = preview && isCurrency(preview.currency) ? preview.currency : null;
  const offer = preview ? makeOfferFor({ canCreate: invoicing.canCreate, canMakeAnother: invoicing.canMakeAnother, problem: preview.problem, alreadyForThisVersion: preview.alreadyForThisVersion }) : null;

  React.useEffect(() => {
    if (result) statusRef.current?.focus();
  }, [result]);

  async function make(another: boolean) {
    setBusy(true);
    let next: MadeResult;
    try {
      const res = await createInvoiceFromProposalAction(detail.id, { version: detail.version, another });
      next = res.ok ? (res.data as MadeResult) : { status: "error", text: res.error };
    } catch {
      next = { status: "error", text: "That didn't go through. Check your connection and try again." };
    }
    setBusy(false);
    setConfirm(null);
    setResult(next);
    // The list below and the proposal's history have a new line.
    router.refresh();
  }

  const said = result ? madeText(result) : null;
  const openHref = result && (result.status === "created" || result.status === "already") ? `/invoices/${result.invoiceId}` : null;

  return (
    <div className="space-y-6">
      {invoicing.existing.length > 0 && (
        <section aria-label="Invoices made from this proposal" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-[15px] font-semibold text-ink">Invoices made from this proposal</h2>
          <ul className="space-y-2">
            {invoicing.existing.map((i) => (
              <li key={i.id}>
                <Link href={`/invoices/${i.id}`} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line px-3 py-2.5 text-[13.5px] hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-primary">
                  <span className="font-medium tabular-nums text-ink">{i.number ?? "Draft invoice"}</span>
                  <StatusBadge status={i.status} />
                  {i.status === "issued" && <PaymentBadge status={i.paymentStatus} />}
                  <span className="tabular-nums text-ink-2">{moneyCode(i.totalMinor, i.currency)}</span>
                  <span className="text-[12.5px] text-muted">from version {i.proposalVersion} · {whenIn(i.createdAt, tz)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Invoice this proposal" className="space-y-4 rounded-2xl border border-line bg-surface p-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Invoice this proposal</h2>
          <p className="mt-1 text-[13px] text-muted">
            An invoice is made as a draft from the version the customer accepted. Only the lines the customer pays once are copied. Making it issues nothing, sends nothing, charges no one and does not change the deal.
          </p>
        </div>

        {!preview && (
          <p role="status" className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">
            {invoicing.canCreate
              ? detail.status === "accepted" ? "This proposal's saved version could not be read, so no invoice can be made from it." : "Only an accepted proposal can be invoiced. When the customer's answer is accepted, what would be invoiced is shown here."
              : "Your role can't make invoices. Ask the business owner or a manager."}
          </p>
        )}

        {preview && (
          <>
            {preview.basis && <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2"><span className="font-medium text-ink">How it was accepted.</span> {preview.basis.text}</p>}
            {preview.problem && <p role="status" className="rounded-xl bg-warning-soft px-3 py-2.5 text-[13px] text-warning-ink">{preview.problem.text}</p>}

            {!preview.problem && currency && (
              <>
                <div className="overflow-x-auto rounded-xl border border-line" role="region" aria-label="Lines that would be on the invoice" tabIndex={0}>
                  <table className="w-full min-w-[480px] text-left text-[13.5px]">
                    <caption className="sr-only">Lines that would be copied onto the invoice, amounts in {currency}</caption>
                    <thead className="border-b border-line text-[12px] text-muted">
                      <tr><th scope="col" className="px-3 py-2 font-medium">Description</th><th scope="col" className="px-2 py-2 text-right font-medium">Qty</th><th scope="col" className="px-2 py-2 text-right font-medium">Price</th><th scope="col" className="px-2 py-2 text-right font-medium">Tax</th><th scope="col" className="px-3 py-2 text-right font-medium">Line total</th></tr>
                    </thead>
                    <tbody>
                      {preview.lines.map((l, n) => (
                        <tr key={n} className="border-b border-line last:border-0">
                          <th scope="row" className="whitespace-pre-wrap break-words px-3 py-2 font-normal text-ink">{l.description}{l.discountMinor > 0 ? <span className="block text-[12px] text-muted">Discount {moneyCode(l.discountMinor, currency)}</span> : null}</th>
                          <td className="px-2 py-2 text-right tabular-nums">{l.quantity}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{moneyCode(l.unitPriceMinor, currency)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{l.taxRateBps !== null ? `${formatBps(l.taxRateBps)}%` : "None"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{moneyCode(l.totalMinor, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.totals && (
                  <dl className="ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-[13.5px]">
                    <dt className="text-muted">Subtotal</dt><dd className="text-right tabular-nums text-ink">{moneyCode(preview.totals.subtotalMinor, currency)}</dd>
                    <dt className="text-muted">Tax</dt><dd className="text-right tabular-nums text-ink">{moneyCode(preview.totals.taxMinor, currency)}</dd>
                    <dt className="font-semibold text-ink">Total</dt><dd className="text-right font-semibold tabular-nums text-ink">{moneyCode(preview.totals.totalMinor, currency)}</dd>
                  </dl>
                )}
                <p className="text-[13px] text-ink-2">{preview.customerName ? `The draft is for ${preview.customerName}.` : "This proposal is not linked to a customer record, so you choose the customer on the draft."}</p>
              </>
            )}

            {preview.notes.map((n) => <p key={n} className="rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">{n}</p>)}
            {preview.recurring.length > 0 && currency && (
              <div className="rounded-xl border border-line px-3 py-2.5 text-[13px] text-ink-2">
                <p className="font-medium text-ink">Not on the invoice, because the customer pays {preview.recurring.length === 1 ? "it" : "them"} every month or every year:</p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5" aria-label="Lines that would be left off">
                  {preview.recurring.map((r, n) => <li key={n} className="break-words">{r.name}, {BILLING_WORDS[r.billing]}, {moneyCode(r.totalMinor, currency)} each time</li>)}
                </ul>
                <p className="mt-1.5">Nothing here bills on a schedule, so these are for you to invoice when you choose.</p>
              </div>
            )}

            {offer?.note && !preview.problem && <p role="status" className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">{offer.note}</p>}
            {offer && offer.kind !== "none" && (
              <Button type="button" variant={offer.kind === "make" ? "brand" : "secondary"} onClick={() => setConfirm(offer.kind === "another" ? "another" : "make")}>
                <FilePlus2 className="size-4" aria-hidden />{offer.kind === "make" ? "Make a draft invoice" : "Make a further draft invoice"}
              </Button>
            )}
          </>
        )}

        <div ref={statusRef} tabIndex={-1} role={said?.tone === "error" ? "alert" : "status"} className="outline-none">
          {said && (
            <p className={`rounded-xl px-3 py-2 text-[13px] ${said.tone === "error" ? "bg-danger-soft text-danger-ink" : said.tone === "info" ? "bg-surface-2 text-ink-2" : "bg-success-soft text-success-ink"}`}>
              {said.text}
              {openHref && <> <Link href={openHref} className="inline-flex min-h-11 items-center font-medium underline underline-offset-2 sm:min-h-0">Open the draft invoice</Link></>}
            </p>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)} title={confirm === "another" ? "Make a further draft invoice?" : "Make a draft invoice?"} confirmLabel="Make the draft" loading={busy}
        description={preview && !preview.problem ? confirmText({ lines: preview.lines.length, recurring: preview.recurring.length, customerName: preview.customerName, another: confirm === "another" }) : undefined}
        onConfirm={() => make(confirm === "another")}
      />
    </div>
  );
}
