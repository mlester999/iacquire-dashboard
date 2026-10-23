import Link from "next/link";
import { FileText, Search } from "lucide-react";
import { EmptyState } from "@/components/ui/primitives";
import { dayIn } from "@/lib/proposals/format";
import { groupTotalsText, LIST_FILTERS, nextStep, validityNote, type ListFilterKey } from "@/lib/proposals/list";
import { cn } from "@/lib/utils";
import type { ProposalSummary } from "@/server/proposals/view";
import { AiBadge, StatusBadge } from "@/components/proposals/status";

// The proposals list. Rows are links to the proposal; colour is never the only signal (every status and warning has its words).

export interface ListViewerCan {
  approve: boolean;
  send: boolean;
  create: boolean;
}

export function ProposalFilters({ active, search }: { active: ListFilterKey; search: string }) {
  return (
    <div className="space-y-3">
      <nav aria-label="Filter proposals" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1">
        {LIST_FILTERS.map((f) => (
          <Link
            key={f.key} href={{ pathname: "/proposals", query: { ...(f.key === "open" ? {} : { filter: f.key }), ...(search ? { q: search } : {}) } }} aria-current={active === f.key ? "page" : undefined}
            className={cn("inline-flex h-11 shrink-0 items-center rounded-xl px-3.5 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary sm:h-9", active === f.key ? "border border-primary/30 bg-primary-soft text-primary-ink" : "text-ink-2 hover:bg-surface-2")}
          >{f.label}</Link>
        ))}
      </nav>
      <form action="/proposals" method="get" role="search" className="flex max-w-md items-center gap-2">
        {active !== "open" && <input type="hidden" name="filter" value={active} />}
        <label htmlFor="pl-search" className="sr-only">Search proposals by number, title or customer</label>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input id="pl-search" name="q" type="search" defaultValue={search} maxLength={80} placeholder="Search by number, title or customer" className="h-11 w-full rounded-xl border border-line-strong bg-surface pl-9 pr-3 text-[16px] text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-primary sm:h-10 sm:text-[14px]" />
        </div>
        <button type="submit" className="inline-flex h-11 items-center rounded-xl border border-line bg-surface px-4 text-[13.5px] font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary sm:h-10">Search</button>
      </form>
    </div>
  );
}

export function ProposalList({ rows, today, tz, can, empty }: { rows: ProposalSummary[]; today: string; tz: string; can: ListViewerCan; empty: { title: string; description: string; action?: React.ReactNode } }) {
  if (rows.length === 0) return <EmptyState icon={<FileText className="size-5" />} title={empty.title} description={empty.description} action={empty.action} />;
  return (
    <ul className="space-y-3" aria-label="Proposals">
      {rows.map((p) => {
        const valid = p.status === "sent" || p.status === "approved" || p.status === "draft" || p.status === "pending_approval" || p.status === "changes_requested" ? validityNote(p.validUntil, today) : null;
        const step = nextStep(p.status, { canApprove: can.approve, canSend: can.send, canCreate: can.create });
        const customer = [p.clientName, p.clientCompany].filter((x) => x.trim()).join(", ");
        return (
          <li key={p.id}>
            <Link href={`/proposals/${p.id}`} className="block rounded-2xl border border-line bg-surface p-4 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[12.5px] font-medium tabular-nums text-muted">{p.number}</span>
                <StatusBadge status={p.status} />
                {p.origin === "ai" && <AiBadge />}
                {p.requiresSignature && <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] font-semibold text-ink-2">Needs a signature</span>}
              </span>
              <span className="mt-1.5 block break-words text-[15px] font-semibold text-ink">{p.title}</span>
              <span className="mt-0.5 block break-words text-[13px] text-ink-2">{customer || "No customer chosen yet"}</span>
              <span className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
                <span className="font-medium tabular-nums text-ink">{groupTotalsText(p.totals, p.currency)}</span>
                {valid && <span className={valid.tone === "danger" ? "text-danger-ink" : valid.tone === "warning" ? "text-warning-ink" : "text-muted"}>{valid.text}</span>}
                <span className="text-muted">Version {p.version} · {p.ownerName ?? "No owner"} · Updated {dayIn(p.updatedAt, tz)}</span>
              </span>
              {step && <span className="mt-2 block text-[13px] font-medium text-primary-ink underline">{step}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
