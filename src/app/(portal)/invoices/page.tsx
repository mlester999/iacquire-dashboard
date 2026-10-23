import Link from "next/link";
import { Plus, Receipt } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { PageHero } from "@/components/ui/workspace";
import { filterQuery, parseListFilter } from "@/lib/invoices/screens";
import { listInvoices, receivablesSummary } from "@/server/invoices/invoices";
import { paymentsNeedingLook } from "@/server/invoices/search";
import { InvoiceFilters, InvoiceList, NeedsLookList, ReceivablesCards } from "@/components/invoices/invoice-list";

export const metadata = { title: "Invoices" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireOrgContext("invoices.view");
  const sp = await searchParams;
  const filter = parseListFilter(sp.filter);
  const search = (one(sp.q) ?? "").trim().slice(0, 80);
  const [rows, summary, look] = await Promise.all([
    listInvoices(ctx, { ...filterQuery(filter), search: search || undefined, limit: 200 }),
    receivablesSummary(ctx),
    paymentsNeedingLook(ctx),
  ]);
  const canCreate = ctx.can("invoices.create");
  const newLink = canCreate ? (
    <Link href="/invoices/new" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl brand-gradient px-4 text-[13.5px] font-medium text-white shadow-glow sm:min-h-10"><Plus className="size-4" aria-hidden />New invoice</Link>
  ) : undefined;
  return (
    <div className="space-y-5">
      <PageHero
        eyebrow="Sales" title="Invoices" icon={<Receipt className="size-4" />} tone="neutral" action={newLink}
        description="Bill your own customers, share a payment page with them, and keep a record of what was paid. A payment is counted only when your payment provider confirms it, or when you record it yourself with your evidence."
      />
      <ReceivablesCards summary={summary} />
      <NeedsLookList rows={look} tz={ctx.org.timezone || "UTC"} />
      <InvoiceFilters active={filter} search={search} />
      <InvoiceList
        rows={rows}
        empty={search
          ? { title: "No invoices match that search", description: "Try a different number or name, or clear the search." }
          : filter === "open"
            ? { title: "Nothing is owed right now", description: canCreate ? "Start an invoice for a customer or a deal. Nothing is sent to anyone until you issue it and give the customer the link." : "Invoices your team issues appear here.", action: newLink }
            : { title: "Nothing here", description: "No invoice is in this group." }}
      />
    </div>
  );
}
