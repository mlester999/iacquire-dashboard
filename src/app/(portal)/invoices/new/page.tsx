import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { getContactDetail } from "@/server/crm/contacts";
import { getOpportunityDetail } from "@/server/crm/opportunities";
import { isCurrency } from "@/lib/money";
import { isUuid } from "@/lib/social/address";
import { getInvoiceSettings } from "@/server/invoices/settings";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { emptyFormState } from "@/lib/invoices/form-state";

export const metadata = { title: "New invoice" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireOrgContext("invoices.view");
  if (!ctx.can("invoices.create")) redirect("/invoices");
  const sp = await searchParams;
  const actor = memberActor(ctx);
  const settings = await getInvoiceSettings(ctx);
  const dealId = one(sp.deal);
  const contactId = one(sp.contact);
  // The address may carry the customer or the deal this invoice starts from. Each is read through the person's own access, so an id from elsewhere finds nothing.
  const deal = dealId && isUuid(dealId) ? await getOpportunityDetail(actor, dealId).catch(() => null) : null;
  const contact = contactId && isUuid(contactId) ? await getContactDetail(actor, contactId).catch(() => null) : null;
  const currency = deal?.currency && isCurrency(deal.currency) ? deal.currency : settings.defaultCurrency ?? "USD";
  const initial = emptyFormState({
    currency,
    contact: contact ? { id: contact.id, name: contact.displayName || "Customer" } : deal?.contact ? { id: deal.contact.id, name: deal.contact.name } : null,
    deal: deal ? { id: deal.id, name: deal.name } : null,
    paymentInstructions: settings.defaultPaymentInstructions ?? "",
  });
  return (
    <div className="space-y-5">
      <div>
        <Link href="/invoices" className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Invoices</Link>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">New invoice</h1>
        <p className="mt-1 max-w-2xl text-[13.5px] text-muted">You are writing a draft. It gets its number when it is issued, and nothing goes to the customer until you give them the link.</p>
      </div>
      <InvoiceForm mode={{ kind: "new" }} initial={initial} termsDays={settings.paymentTermsDays} />
    </div>
  );
}
