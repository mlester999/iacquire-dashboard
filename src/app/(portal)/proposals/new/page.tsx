import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { getContactDetail } from "@/server/crm/contacts";
import { getOpportunityDetail } from "@/server/crm/opportunities";
import { getWorkspace } from "@/server/crm/workspace";
import { isUuid } from "@/lib/social/address";
import { listCatalogItems } from "@/server/proposals/catalog";
import { getProposalSettings } from "@/server/proposals/settings";
import { listTemplates } from "@/server/proposals/templates";
import { NewProposal } from "@/components/proposals/new-proposal";

export const metadata = { title: "New proposal" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NewProposalPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireOrgContext("proposals.create");
  const sp = await searchParams;
  const actor = memberActor(ctx);
  const [workspace, settings, templates, items] = await Promise.all([getWorkspace(actor), getProposalSettings(actor), listTemplates(actor), listCatalogItems(actor)]);
  // A contact or deal chosen on its own page. The ids are only addresses: they are looked up in this workspace, and anything that is not found is ignored.
  const contactId = one(sp.contact);
  const dealId = one(sp.deal);
  const deal = isUuid(dealId) ? await getOpportunityDetail(actor, dealId).catch(() => null) : null;
  const contact = isUuid(contactId) ? await getContactDetail(actor, contactId).catch(() => null) : deal?.contact && ctx.can("contacts.view") ? await getContactDetail(actor, deal.contact.id).catch(() => null) : null;
  const canUseAi = settings.aiDraftsEnabled && items.length > 0;
  return (
    <div className="space-y-5">
      <div>
        <Link href="/proposals" className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Proposals</Link>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">New proposal</h1>
        <p className="mt-1 max-w-2xl text-[13.5px] text-muted">A proposal starts as a draft. Nothing reaches the customer until it has been approved where that is needed, and someone at your business sends it.</p>
      </div>
      <NewProposal
        templates={templates.filter((t) => t.status === "approved").map((t) => ({ id: t.id, name: t.name }))}
        defaultCurrency={workspace.defaultCurrency}
        contact={contact ? { id: contact.id, name: contact.displayName || contact.email || "Unnamed contact" } : null}
        deal={deal ? { id: deal.id, name: deal.name, currency: deal.currency } : null}
        ai={{
          available: canUseAi,
          reason: !settings.aiDraftsEnabled
            ? `AI drafting is switched off for this workspace.${ctx.can("proposals.settings") ? " You can switch it on in Settings." : " The business owner can switch it on in Settings."}`
            : "Add items to your price book first: the AI only drafts from price book items, and never writes a price.",
        }}
      />
    </div>
  );
}
