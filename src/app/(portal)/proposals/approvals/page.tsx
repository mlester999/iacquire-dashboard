import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { EmptyState } from "@/components/ui/primitives";
import { dayIn } from "@/lib/proposals/format";
import { groupTotalsText } from "@/lib/proposals/list";
import { listProposals } from "@/server/proposals/proposals";
import { AiBadge } from "@/components/proposals/status";

export const metadata = { title: "Proposal approvals" };

export default async function ProposalApprovalsPage() {
  const ctx = await requireOrgContext("proposals.view");
  const actor = memberActor(ctx);
  const tz = ctx.org.timezone || "UTC";
  const [waiting, changes] = await Promise.all([listProposals(actor, { statuses: ["pending_approval"], limit: 200 }), listProposals(actor, { statuses: ["changes_requested"], limit: 50 })]);
  const canApprove = ctx.can("proposals.approve");
  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-ink"><ClipboardCheck className="size-5 text-muted" aria-hidden />Approvals</h1>
        <p className="mt-1 max-w-2xl text-[13.5px] text-muted">Where a second look is needed, nothing is sent until the business owner or a manager approves it. An approval is of the exact text you see: if the text changes afterwards, it has to be approved again.{canApprove ? "" : " You can see what is waiting, but approving is for the owner and managers."}</p>
      </header>

      {waiting.length === 0 ? (
        <EmptyState compact icon={<ClipboardCheck className="size-5" />} title="Nothing is waiting for approval" description="Proposals that are sent for approval, including everything written by AI, appear here." />
      ) : (
        <ul className="space-y-3" aria-label="Proposals waiting for approval">
          {waiting.map((p) => (
            <li key={p.id}>
              <Link href={`/proposals/${p.id}`} className="block rounded-2xl border border-line bg-surface p-4 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
                  <span className="font-medium tabular-nums">{p.number}</span>
                  {p.origin === "ai" && <AiBadge />}
                  <span>Sent for approval {dayIn(p.updatedAt, tz)}</span>
                  <span>· {p.ownerName ?? "No owner"}</span>
                </span>
                <span className="mt-1.5 block break-words text-[15px] font-semibold text-ink">{p.title}</span>
                <span className="mt-0.5 block text-[13px] text-ink-2">{[p.clientName, p.clientCompany].filter((x) => x.trim()).join(", ") || "No customer chosen"} · {groupTotalsText(p.totals, p.currency)}</span>
                <span className="mt-2 inline-block text-[13px] font-medium text-primary-ink underline">{canApprove ? "Review and decide" : "Open"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {changes.length > 0 && (
        <section aria-label="Changes requested">
          <h2 className="mb-2 text-[14px] font-semibold text-ink">Waiting for changes</h2>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {changes.map((p) => (
              <li key={p.id}>
                <Link href={`/proposals/${p.id}`} className="block px-4 py-3 text-[13.5px] hover:bg-surface-2">
                  <span className="font-medium text-ink">{p.number} · {p.title}</span> <span className="text-muted">· {p.ownerName ?? "No owner"}</span>
                  <span className="mt-0.5 block text-ink-2">A reviewer asked for changes. Open it to see what.</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
