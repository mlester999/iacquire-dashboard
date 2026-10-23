import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { getWorkspace } from "@/server/crm/workspace";
import { listCatalogItems, listTaxRates } from "@/server/proposals/catalog";
import { CatalogPanel } from "@/components/proposals/catalog-panel";

export const metadata = { title: "Price book" };

export default async function ProposalCatalogPage() {
  const ctx = await requireOrgContext("proposals.view");
  const actor = memberActor(ctx);
  const [items, taxRates, workspace] = await Promise.all([listCatalogItems(actor, { includeArchived: true }), listTaxRates(actor, { includeArchived: true }), getWorkspace(actor)]);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Price book and tax rates</h1>
        <p className="mt-1 max-w-2xl text-[13.5px] text-muted">The prices your proposals use. They are yours: iAcquire does not suggest, fill in or change any price.</p>
      </header>
      <CatalogPanel orgId={null} items={items} taxRates={taxRates} canEdit={ctx.can("proposals.catalog")} defaultCurrency={workspace.defaultCurrency} />
    </div>
  );
}
