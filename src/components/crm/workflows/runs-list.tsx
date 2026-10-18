"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, ScrollText } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, Select } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/utils";
import { RelativeTime } from "@/components/crm/relative-time";
import { RunStatusBadge } from "@/components/crm/workflows/parts";
import { RUN_FILTERS, type RunFilter } from "@/components/crm/workflows/summaries";
import type { RunListItem } from "@/components/crm/workflows/types";

export interface RunsListProps {
  base: string;
  runs: RunListItem[];
  filter: RunFilter;
  timezone: string;
  /** The cursor for the next (older) page, when there is one. */
  nextBefore: string | null;
  /** This page starts below the newest runs (a `before` cursor is set). */
  paged: boolean;
  /** The workspace-wide activity page offers a workflow filter; a workflow's own Runs tab doesn't. */
  workflows?: Array<{ id: string; name: string }>;
  workflowId?: string | null;
  showWorkflow?: boolean;
}

/** Runs, newest first, filtered by outcome. Filters and the page live in the address, so a link or a refresh shows the same list. */
export function RunsList({ base, runs, filter, timezone, nextBefore, paged, workflows, workflowId, showWorkflow }: RunsListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const href = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    return `${pathname}${sp.toString() ? `?${sp}` : ""}`;
  };
  const go = (patch: Record<string, string | null>) => router.replace(href({ ...patch, before: null }), { scroll: false });
  const filtered = !!filter || !!workflowId;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter runs" className="scrollbar-thin -mx-1 flex max-w-full gap-1 overflow-x-auto px-1 py-0.5">
          {RUN_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => go({ status: f.value || null })}
              className={
                filter === f.value
                  ? "inline-flex min-h-11 shrink-0 items-center rounded-xl border border-primary/25 bg-primary-soft px-3 text-[13px] font-medium text-primary-ink sm:min-h-8"
                  : "inline-flex min-h-11 shrink-0 items-center rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2 sm:min-h-8"
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        {workflows && (
          <>
            <label className="sr-only" htmlFor="runs-filter-workflow">Workflow</label>
            <Select id="runs-filter-workflow" value={workflowId ?? ""} onChange={(e) => go({ workflow: e.target.value || null })} className="w-full min-w-48 sm:w-auto">
              <option value="">All workflows</option>
              {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </>
        )}
      </div>

      {!runs.length ? (
        <Card>
          <EmptyState
            compact
            icon={<ScrollText className="size-5" />}
            title={paged ? "No older runs" : filtered ? "No runs match these filters" : "No runs yet"}
            description={paged ? "You've reached the oldest run." : filtered ? "Try another filter." : "Runs appear here once an active workflow starts for a matching event, when someone starts one, or when you test one."}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <ul className="divide-y divide-line">
            {runs.map((r) => (
              <li key={r.id}>
                <Link href={`${base}/workflows/${r.workflowId}/runs/${r.id}`} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2/60">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <RunStatusBadge status={r.status} test={r.startedVia === "test"} />
                      {showWorkflow && <span className="min-w-0 truncate text-[13.5px] font-medium text-ink">{r.workflowName}</span>}
                      <span className="min-w-0 truncate text-[13px] text-ink-2">{r.contactName ?? (r.contactId ? "A contact" : "No contact")}</span>
                    </div>
                    <p className="mt-1 text-[12.5px] text-muted">
                      {r.triggerLabel}
                      {r.version ? ` · v${r.version}` : ""} · started <RelativeTime iso={r.createdAt} timezone={timezone} />
                      {r.finishedAt ? <> · finished <RelativeTime iso={r.finishedAt} timezone={timezone} /></> : null}
                      {!r.finishedAt && r.currentStep ? ` · at “${r.currentStep}”` : ""}
                      {!r.finishedAt && r.status === "waiting" && r.nextRunAt ? ` · continues ${formatDateTime(r.nextRunAt, timezone)}` : ""}
                    </p>
                    {r.outcome ? <p className="mt-1 line-clamp-2 text-[12.5px] text-warning-ink">{r.outcome}</p>
                      : r.lastError && (r.status === "failed" || r.status === "dead") ? <p className="mt-1 line-clamp-2 text-[12.5px] text-danger-ink">{r.currentStep ? `${r.currentStep}: ` : ""}{r.lastError}</p> : null}
                  </div>
                  <ChevronRight className="mt-1 size-4 shrink-0 text-faint" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {(paged || nextBefore) && (
        <nav aria-label="Older and newer runs" className="flex flex-wrap items-center justify-between gap-2">
          {paged ? <ButtonLink variant="secondary" size="sm" href={href({ before: null })}>Newest runs</ButtonLink> : <span />}
          {nextBefore && <ButtonLink variant="secondary" size="sm" href={href({ before: nextBefore })}>Older runs</ButtonLink>}
        </nav>
      )}
    </div>
  );
}
