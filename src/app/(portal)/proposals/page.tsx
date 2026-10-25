import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { PageHero } from "@/components/ui/workspace";
import { parseListFilter, statusesFor } from "@/lib/proposals/list";
import { todayIn } from "@/lib/proposals/validity";
import { listProposals } from "@/server/proposals/proposals";
import { ProposalFilters, ProposalList } from "@/components/proposals/proposal-list";

export const metadata = { title: "Proposals" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ProposalsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireOrgContext("proposals.view");
  const sp = await searchParams;
  const filter = parseListFilter(sp.filter);
  const search = (one(sp.q) ?? "").trim().slice(0, 80);
  const actor = memberActor(ctx);
  const rows = await listProposals(actor, { statuses: statusesFor(filter), search: search || undefined, limit: 200 });
  const canCreate = ctx.can("proposals.create");
  const tz = ctx.org.timezone || "UTC";
  const newLink = canCreate ? (
    <Link href="/proposals/new" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl brand-gradient px-4 text-[14px] font-medium text-white shadow-glow sm:min-h-10"><Plus className="size-4" aria-hidden />New proposal</Link>
  ) : undefined;
  return (
    <div className="space-y-5">
      <PageHero
        eyebrow="Sales" title="Proposals" icon={<FileText className="size-4" />} tone="neutral" action={newLink}
        description="Write a proposal, get it approved, send it to the customer, and keep what they answer. Every proposal is reviewed by a person before it goes out, and what happened to each one is kept."
      />
      <ProposalFilters active={filter} search={search} />
      <ProposalList
        rows={rows} today={todayIn(tz, new Date())} tz={tz} can={{ approve: ctx.can("proposals.approve"), send: ctx.can("proposals.send"), create: canCreate }}
        empty={search
          ? { title: "No proposals match that search", description: "Try a different word, or clear the search." }
          : filter === "open"
            ? { title: "No open proposals", description: canCreate ? "Start one for a customer or a deal. You can write it yourself or ask the AI for a first draft that a person then approves." : "Proposals your team writes appear here.", action: newLink }
            : { title: "Nothing here", description: "No proposal is in this group." }}
      />
    </div>
  );
}
