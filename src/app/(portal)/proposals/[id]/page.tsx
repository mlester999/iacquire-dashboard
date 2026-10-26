import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { AppError } from "@/server/errors";
import { isUuid } from "@/lib/social/address";
import type { CatalogChoice } from "@/lib/proposals/editor";
import { listCatalogItems, listTaxRates } from "@/server/proposals/catalog";
import { getProposal } from "@/server/proposals/proposals";
import { getProposalSettings } from "@/server/proposals/settings";
import { invoicingForProposal } from "@/server/invoices/from-proposal";
import { parseWorkspaceTab } from "@/lib/proposals/list";
import { ProposalWorkspace } from "@/components/proposals/workspace";

export const metadata = { title: "Proposal" };

export default async function ProposalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const ctx = await requireOrgContext("proposals.view");
  const { id } = await params;
  const sp = await searchParams;
  // The column is a uuid: an address that only looks like one would make the database raise instead of the page saying "not found".
  if (!isUuid(id)) notFound();
  const actor = memberActor(ctx);
  let detail;
  try {
    detail = await getProposal(actor, id);
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
  const [items, taxRates, settings, invoicing] = await Promise.all([listCatalogItems(actor), listTaxRates(actor, { includeArchived: true }), getProposalSettings(actor), invoicingForProposal(ctx, id)]);
  const catalog: CatalogChoice[] = items.map((i) => ({
    id: i.id, name: i.name, description: i.description, unitLabel: i.unitLabel, unitPriceMinor: i.unitPriceMinor, currency: i.currency, billing: i.billing, taxRateId: i.taxRateId, taxBps: i.taxBps,
  }));
  const customer = [detail.clientName, detail.clientCompany].filter((x) => x.trim()).join(", ");
  return (
    <div className="space-y-5">
      <div>
        <Link href="/proposals" className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Proposals</Link>
        <h1 className="mt-1 break-words text-[22px] font-semibold tracking-tight text-ink"><span className="tabular-nums text-muted">{detail.number}</span> {detail.title}</h1>
        <p className="mt-1 text-[14px] text-muted">{customer ? `For ${customer}` : "No customer chosen yet"}{detail.ownerName ? ` · Owner: ${detail.ownerName}` : ""}</p>
      </div>
      <ProposalWorkspace
        detail={detail} catalog={catalog} twoPerson={settings.twoPerson} tz={ctx.org.timezone || "UTC"} initialTab={parseWorkspaceTab(sp.tab)} invoicing={invoicing}
        taxRates={taxRates.map((t) => ({ id: t.id, name: t.name, rateBps: t.rateBps, archived: t.archived }))}
        can={{ create: ctx.can("proposals.create"), approve: ctx.can("proposals.approve"), send: ctx.can("proposals.send"), record: ctx.can("proposals.record_decision"), discount: ctx.can("proposals.discount") }}
      />
    </div>
  );
}
