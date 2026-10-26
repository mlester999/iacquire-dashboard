import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { EmptyState } from "@/components/ui/primitives";
import { groupTotalsText } from "@/lib/proposals/list";
import type { ProposalSummary } from "@/server/proposals/view";
import { AiBadge, StatusBadge } from "@/components/proposals/status";

/** The proposals of one contact or deal, for the Proposals tab on their page. Rows open the proposal; nothing here changes anything. */
export function ProposalsPanel({ rows, newHref, canCreate }: { rows: ProposalSummary[]; newHref: string; canCreate: boolean }) {
  const action = canCreate ? <Link href={newHref} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl brand-gradient px-4 text-[14px] font-medium text-white sm:min-h-10"><Plus className="size-4" aria-hidden />New proposal</Link> : undefined;
  if (rows.length === 0) return <EmptyState compact icon={<FileText className="size-5" />} title="No proposals yet" description="Write a proposal for this customer, get it approved, and keep what they answer." action={action} />;
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-2xl border border-line bg-surface" aria-label="Proposals">
        {rows.map((p) => (
          <li key={p.id}>
            <Link href={`/proposals/${p.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-primary">
              <FileText className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-ink">{p.number} · {p.title}</span>
                <span className="block text-[13px] text-muted">Version {p.version}</span>
              </span>
              <StatusBadge status={p.status} />
              {p.origin === "ai" && <AiBadge />}
              <span className="shrink-0 text-[14px] font-medium tabular-nums text-ink">{groupTotalsText(p.totals, p.currency)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {action}
    </div>
  );
}
