"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Archive, ArrowDown, ArrowUp, Handshake, KanbanSquare, MoveRight, Plus, Search, Table2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { archiveOpportunitiesAction, bulkMoveOpportunitiesAction } from "@/app/actions/crm";
import { Avatar, ConfirmDialog, money, Pagination, shortDate, useCrmAction } from "@/components/crm/ui";
import { NewDealDialog } from "@/components/crm/record-panels";
import { RelativeTime } from "@/components/crm/relative-time";
import { useUrlSearch } from "@/components/crm/url-search";
import type { OpportunityCard } from "@/server/crm/opportunities";
import type { PipelineView } from "@/server/crm/pipelines";
import type { CrmScope } from "@/server/crm/page";

type Row = OpportunityCard & { pipelineName: string; stageName: string; createdAt: string; updatedAt: string; closedAt: string | null; lostReason: string | null };
type SortKey = "name" | "value" | "created_at" | "updated_at" | "expected_close_date" | "stage_entered_at";
type Keys = "pipeline" | "stage" | "status" | "owner" | "q" | "sort" | "dir" | "page";

export const STATUS_TONE = { open: "primary", won: "success", lost: "neutral" } as const;
export const STATUS_LABEL = { open: "Open", won: "Won", lost: "Lost" } as const;

export function OpportunitiesTable({
  scope, rows, total, page, pageSize, pipelines, members, state,
}: {
  scope: CrmScope;
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  pipelines: PipelineView[];
  members: Array<{ id: string; name: string }>;
  state: { pipeline: string | null; stage: string | null; status: "open" | "won" | "lost" | "all"; owner: string | null; q: string; sort: SortKey | null; dir: "asc" | "desc" };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { run, busy } = useCrmAction();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const key = `${page}|${state.pipeline}|${state.stage}|${state.status}|${state.owner}|${state.q}`;
  const [selectionFor, setSelectionFor] = React.useState(key);
  if (selectionFor !== key) {
    setSelectionFor(key);
    setSelected(new Set());
  }
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const pipeline = pipelines.find((p) => p.id === state.pipeline) ?? null;
  const canEdit = !!scope.can["opportunities.edit"] && !scope.readOnly;

  const hrefWith = React.useCallback(
    (changes: Partial<Record<Keys, string | null>>) => {
      const cur: Record<Keys, string | null> = {
        pipeline: state.pipeline, stage: state.stage, status: state.status === "open" ? null : state.status, owner: state.owner, q: state.q || null,
        sort: state.sort, dir: state.sort ? state.dir : null, page: page > 1 ? String(page) : null,
      };
      const next = { ...cur, ...changes };
      if (!("page" in changes)) next.page = null;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
      const s = params.toString();
      return `${pathname}${s ? `?${s}` : ""}`;
    },
    [pathname, page, state],
  );

  // Typing replaces the address after a pause; a search changed elsewhere (Back, a link, a filter that clears it) replaces the box's text.
  const search = useUrlSearch(state.q, state, (q) => router.replace(hrefWith({ q: q || null })));

  const sortHeader = (label: string, by: SortKey, className?: string) => {
    const active = state.sort === by;
    const nextDir = active && state.dir === "desc" ? "asc" : "desc";
    return (
      <th scope="col" className={cn("whitespace-nowrap px-3 py-2.5 text-left font-medium", className)} aria-sort={active ? (state.dir === "asc" ? "ascending" : "descending") : undefined}>
        <Link href={hrefWith({ sort: by, dir: nextDir })} className="inline-flex items-center gap-1 hover:text-ink">
          {label}
          {active && (state.dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}
        </Link>
      </th>
    );
  };

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const samePipeline = selectedRows.length > 0 && selectedRows.every((r) => r.pipelineId === selectedRows[0].pipelineId) ? selectedRows[0].pipelineId : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold tracking-[-0.03em] text-ink">Opportunities</h2>
          <p className="mt-1 text-[14px] text-muted">{total.toLocaleString("en-US")} {total === 1 ? "deal" : "deals"}{pipeline ? ` in ${pipeline.name}` : " across all pipelines"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl border border-line bg-surface-2 p-0.5" role="group" aria-label="View">
            <Link href={`${scope.base}/pipelines${state.pipeline ? `?p=${state.pipeline}` : ""}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-3 text-[14px] font-medium text-muted hover:text-ink sm:min-h-8"><KanbanSquare className="size-4" aria-hidden />Board</Link>
            <span className="inline-flex min-h-11 items-center gap-1.5 rounded-[10px] bg-surface px-3 text-[14px] font-medium text-ink shadow-soft sm:min-h-8"><Table2 className="size-4" aria-hidden />Table</span>
          </div>
          {canEdit && <Button onClick={() => setNewOpen(true)}><Plus className="size-4" />New deal</Button>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label="Search deals" placeholder="Search deals, contacts, companies" className="pl-9" value={search.text} onChange={(e) => search.setText(e.target.value)} />
        </div>
        <Segmented id="opp-status" ariaLabel="Status" size="sm" value={state.status} onChange={(v) => router.push(hrefWith({ status: v === "open" ? null : v }))}
          options={[{ value: "open", label: "Open" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }, { value: "all", label: "All" }]} />
        <label htmlFor="opp-pipe" className="sr-only">Pipeline</label>
        <Select id="opp-pipe" className="w-auto" value={state.pipeline ?? ""} onChange={(e) => router.push(hrefWith({ pipeline: e.target.value || null, stage: null }))}>
          <option value="">All pipelines</option>
          {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        {pipeline && (
          <>
            <label htmlFor="opp-stage" className="sr-only">Stage</label>
            <Select id="opp-stage" className="w-auto" value={state.stage ?? ""} onChange={(e) => router.push(hrefWith({ stage: e.target.value || null }))}>
              <option value="">All stages</option>
              {pipeline.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </>
        )}
        <label htmlFor="opp-owner" className="sr-only">Owner</label>
        <Select id="opp-owner" className="w-auto" value={state.owner ?? ""} onChange={(e) => router.push(hrefWith({ owner: e.target.value || null }))}>
          <option value="">Any owner</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
        {(state.pipeline || state.stage || state.owner || state.q || state.status !== "open") && (
          <Link href={pathname} className="inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-[14px] font-medium text-muted hover:text-ink sm:min-h-9"><X className="size-3.5" />Clear</Link>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/25 bg-primary-soft/50 px-3 py-2" role="region" aria-label="Bulk actions">
          <span className="text-[14px] font-medium text-primary-ink">{selected.size} selected</span>
          {canEdit && scope.can["contacts.bulk"] && (
            <Button size="sm" variant="secondary" disabled={!samePipeline} title={samePipeline ? undefined : "Select deals from one pipeline to move them together"} onClick={() => setMoveOpen(true)}><MoveRight className="size-4" />Move to stage</Button>
          )}
          {scope.can["opportunities.delete"] && !scope.readOnly && <Button size="sm" variant="secondary" onClick={() => setArchiveOpen(true)}><Archive className="size-4" />Archive</Button>}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}

      {rows.length ? (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="w-full min-w-[860px] text-[14px]">
              <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
                <tr>
                  <th scope="col" className="w-10 px-3 py-2.5">
                    <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)))} className="size-4 accent-[var(--color-primary)]" />
                  </th>
                  {sortHeader("Deal", "name")}
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-left font-medium">Stage</th>
                  {sortHeader("Value", "value", "text-right")}
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-left font-medium">Owner</th>
                  {sortHeader("Expected close", "expected_close_date")}
                  {sortHeader("In stage", "stage_entered_at")}
                  {sortHeader("Updated", "updated_at")}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className={cn("hover:bg-surface-2/50", selected.has(r.id) && "bg-primary-soft/30")}>
                    <td className="px-3 py-2.5">
                      <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} className="size-4 accent-[var(--color-primary)]" />
                    </td>
                    <td className="max-w-[280px] px-3 py-2.5">
                      <Link href={`${scope.base}/opportunities/${r.id}`} className="block truncate font-medium text-ink hover:text-primary">{r.name}</Link>
                      <span className="block truncate text-[12px] text-muted">{[r.contact?.name, r.company?.name].filter(Boolean).join(" · ") || "No contact"}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-1.5">
                        {r.status !== "open" && <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>}
                        {(r.status === "open" || r.stageName.toLowerCase() !== r.status) && <span className="truncate text-ink-2">{r.stageName}</span>}
                      </span>
                      {!state.pipeline && <span className="block truncate text-[12px] text-faint">{r.pipelineName}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums">{r.value === null ? <span className="font-normal text-faint">—</span> : money(r.value, r.currency)}</td>
                    <td className="max-w-[180px] px-3 py-2.5">{r.owner ? <span className="flex items-center gap-2"><Avatar name={r.owner.name} size="sm" /><span className="truncate">{r.owner.name}</span></span> : <span className="text-faint">Unassigned</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-ink-2">{r.expectedCloseDate ? shortDate(r.expectedCloseDate) : <span className="text-faint">—</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-ink-2">{r.status === "open" ? `${r.daysInStage}d` : <span className="text-faint">Closed</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted"><RelativeTime iso={r.updatedAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card>
          <EmptyState icon={<Handshake className="size-5" />} title={state.q || state.owner || state.stage ? "No deals match" : "No deals yet"}
            description={state.q || state.owner || state.stage ? "Try a different search or clear the filters." : "Deals you add, and deals created from bookings, forms and your AI employees, appear here."} />
        </Card>
      )}

      <Pagination page={page} pageSize={pageSize} total={total} hrefFor={(p) => hrefWith({ page: String(p) })} />

      {moveOpen && samePipeline && (
        <BulkMoveDialog stages={pipelines.find((p) => p.id === samePipeline)?.stages ?? []} count={selected.size} busy={busy("bulkmove")} onClose={() => setMoveOpen(false)}
          onMove={async (stageId) => { if (await run("bulkmove", () => bulkMoveOpportunitiesAction(scope.orgId, [...selected], stageId), (r) => `${r.changed} ${r.changed === 1 ? "deal" : "deals"} moved.`)) { setMoveOpen(false); setSelected(new Set()); } }} />
      )}
      <ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen} title={`Archive ${selected.size} ${selected.size === 1 ? "deal" : "deals"}?`} confirmLabel="Archive" danger loading={busy("archive")}
        description="Archived deals leave the board and reports. Their history is kept."
        onConfirm={async () => { if (await run("archive", () => archiveOpportunitiesAction(scope.orgId, [...selected]), (r) => `${r.changed} archived.`)) { setArchiveOpen(false); setSelected(new Set()); } }} />
      {newOpen && (
        <NewDealDialog open onOpenChange={setNewOpen} scope={scope} members={members} defaults={{ pipelineId: state.pipeline ?? undefined }}
          pipelines={pipelines.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault, stages: p.stages.filter((s) => s.kind === "open").map((s) => ({ id: s.id, name: s.name })) }))} />
      )}
    </div>
  );
}

function BulkMoveDialog({ stages, count, busy, onClose, onMove }: { stages: PipelineView["stages"]; count: number; busy: boolean; onClose: () => void; onMove: (stageId: string) => void }) {
  const openStages = stages.filter((s) => s.kind !== "lost");
  const [stageId, setStageId] = React.useState(openStages[0]?.id ?? "");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Move ${count} ${count === 1 ? "deal" : "deals"}`} description="Each deal moves through the same rules as a drag on the board, and each move is recorded. To mark deals lost, do it one at a time so each has a reason." size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!stageId} onClick={() => onMove(stageId)}>Move</Button></>}>
      <Field label="Stage" htmlFor="bm-stage">
        <Select id="bm-stage" value={stageId} onChange={(e) => setStageId(e.target.value)}>
          {openStages.map((s) => <option key={s.id} value={s.id}>{s.name}{s.kind === "won" ? " (won)" : ""}</option>)}
        </Select>
      </Field>
    </Dialog>
  );
}
