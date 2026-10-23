import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { isUuid } from "@/lib/social/address";
import { lineToForm } from "@/lib/invoices/lines";
import { toDecimalString } from "@/lib/money";
import { canEditDraft } from "@/lib/invoices/state";
import { getInvoiceDetail } from "@/server/invoices/invoices";
import { getInvoiceSettings } from "@/server/invoices/settings";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { emptyFormState } from "@/lib/invoices/form-state";

export const metadata = { title: "Edit invoice" };

const text = (v: unknown) => (typeof v === "string" ? v : "");

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOrgContext("invoices.view");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  let detail;
  try {
    detail = await getInvoiceDetail(ctx, id);
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
  const i = detail.invoice;
  // Only a draft can be changed, and only by the person who wrote it or a manager. Anyone else is sent back to read it.
  if (i.status !== "draft" || !canEditDraft({ canCreate: ctx.can("invoices.create"), canApprove: ctx.can("invoices.approve"), isAuthor: i.createdBy === ctx.user.id })) redirect(`/invoices/${id}`);
  const settings = await getInvoiceSettings(ctx);
  const bt = i.billTo;
  const initial = emptyFormState({
    currency: i.currency, taxInclusive: i.taxInclusive,
    contact: i.contactId ? { id: i.contactId, name: i.contactName ?? "Customer" } : null,
    deal: i.opportunityId ? { id: i.opportunityId, name: i.opportunityName ?? "Deal" } : null,
    ...(detail.lines.length ? { lines: detail.lines.map((l) => lineToForm({ description: l.description, quantityMilli: l.quantityMilli, unitPriceMinor: l.unitPriceMinor, discountBps: l.discountBps, discountMinor: l.discountMinor, taxRateBps: l.taxRateBps }, i.currency, toDecimalString)) } : {}),
    dueOn: i.dueOn ?? "",
    billTo: { name: text(bt.name), company: text(bt.company), email: text(bt.email), phone: text(bt.phone), address: Array.isArray(bt.addressLines) ? (bt.addressLines as unknown[]).map(text).join("\n") : "", taxId: text(bt.taxId) },
    paymentInstructions: i.paymentInstructions ?? "", notes: i.notes ?? "", terms: i.terms ?? "", closesDeal: i.closesDeal,
  });
  return (
    <div className="space-y-5">
      <div>
        <Link href={`/invoices/${id}`} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Back to the draft</Link>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">Edit draft</h1>
        <p className="mt-1 max-w-2xl text-[13.5px] text-muted">Version {i.version}. Saving a change makes it a new version, so anyone who looked at the earlier one has to look again.</p>
      </div>
      <InvoiceForm mode={{ kind: "edit", id, version: i.version }} initial={initial} termsDays={settings.paymentTermsDays} />
    </div>
  );
}
