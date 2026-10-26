import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { isUuid } from "@/lib/social/address";
import { getCreditNote } from "@/server/invoices/credit-notes";
import { formatInstant, money } from "@/lib/invoices/labels";
import { PrintButton } from "@/components/invoices/print-button";

export const metadata = { title: "Credit note" };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function Party({ title, name, lines }: { title: string; name: string | null; lines: string[] }) {
  return (
    <div>
      <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[.1em] text-muted">{title}</h2>
      {name || lines.length ? (
        <div className="text-[14px] leading-relaxed text-ink-2">
          {name && <p className="font-medium text-ink">{name}</p>}
          {lines.map((l, n) => <p key={n}>{l}</p>)}
        </div>
      ) : <p className="text-[14px] text-muted">Customer details are not shown on this copy.</p>}
    </div>
  );
}

/**
 * The issued credit note as a document: the business, the customer as the invoice froze them, the number, the invoice it is against, the reason and the amount. It says what it is not
 * (a payment or a refund). The wording has not been checked by counsel and no jurisdiction's credit-note rule is promised here.
 */
export default async function CreditNotePage({ params }: { params: Promise<{ id: string; creditId: string }> }) {
  const ctx = await requireOrgContext("invoices.view");
  const { id, creditId } = await params;
  if (!isUuid(id) || !isUuid(creditId)) notFound();
  let note;
  try {
    note = await getCreditNote(ctx, creditId);
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
  if (note.invoiceId !== id) notFound();
  // Only an issued credit note is a document; a draft is worked on from the invoice.
  if (note.status !== "issued" || !note.number) redirect(`/invoices/${id}`);
  const tz = ctx.org.timezone || "UTC";
  const from = note.billFrom;
  const to = note.billTo;
  const erased = to.erased === true;
  const fromExtra = [text(from.taxId) ? `${text(from.taxLabel) ?? "Tax number"}: ${text(from.taxId)}` : text(from.taxLabel), text(from.replyToEmail)].filter((x): x is string => Boolean(x));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href={`/invoices/${id}`} className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Invoice {note.invoiceNumber ?? ""}</Link>
        <PrintButton label="Print this credit note" />
      </div>
      <article aria-labelledby="credit-title" className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-8 print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 id="credit-title" className="text-[26px] font-semibold tracking-[-0.03em] text-ink">Credit note</h1>
            <p className="mt-0.5 text-[15px] font-medium tabular-nums text-ink-2">{note.number}</p>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-[14px]">
            <dt className="text-muted">Issued</dt><dd className="font-medium text-ink">{formatInstant(note.issuedAt, tz)}</dd>
            <dt className="text-muted">Against invoice</dt><dd className="font-medium tabular-nums text-ink">{note.invoiceNumber ?? ""}</dd>
            <dt className="text-muted">Currency</dt><dd className="font-medium text-ink">{note.currency}</dd>
          </dl>
        </header>
        <section aria-label="Parties" className="mt-6 grid gap-5 sm:grid-cols-2">
          <Party title="From" name={text(from.name)} lines={[...strings(from.addressLines), ...fromExtra]} />
          <Party title="Credited to" name={erased ? null : text(to.name)} lines={erased ? [] : [...(text(to.company) ? [text(to.company) as string] : []), ...strings(to.addressLines)]} />
        </section>
        <section aria-label="What is credited" className="mt-6 border-t border-line pt-5">
          <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[.1em] text-muted">Reason</h2>
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-2">{note.reason}</p>
          <dl className="ml-auto mt-5 grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[14px]">
            {note.taxPortionMinor > 0 && <><dt className="text-muted">Of which tax</dt><dd className="text-right tabular-nums text-ink">{money(note.taxPortionMinor, note.currency)}</dd></>}
            <dt className="border-t border-line-strong pt-1.5 font-semibold text-ink">Credit</dt><dd className="border-t border-line-strong pt-1.5 text-right text-[15px] font-semibold tabular-nums text-ink">{money(note.amountMinor, note.currency)}</dd>
          </dl>
        </section>
        <p className="mt-6 border-t border-line pt-4 text-[13px] leading-relaxed text-muted">
          This credit note takes the amount above off what is owed on the invoice named. It is not a payment and not a refund; if money was already paid and should go back, that is recorded separately.
          {note.approvedByName ? ` Approved by ${note.approvedByName}.` : ""}
        </p>
      </article>
    </div>
  );
}
