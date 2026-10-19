"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2, CircleSlash, KanbanSquare, ListChecks, MoreHorizontal, Plus, Search, Settings2, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Segmented } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { moveOpportunityAction } from "@/app/actions/crm";
import { Avatar, money, ReadOnlyNotice, shortDate, TagChip, totalsText, useCrmAction } from "@/components/crm/ui";
import { NewDealDialog } from "@/components/crm/record-panels";
import { PipelineSettingsSheet, NewPipelineDialog } from "@/components/crm/pipeline-settings";
import { useUrlSearch } from "@/components/crm/url-search";
import type { BoardColumn, OpportunityCard, PipelineMetrics } from "@/server/crm/opportunities";
import type { PipelineView } from "@/server/crm/pipelines";
import type { CrmScope } from "@/server/crm/page";

type Pending = { card: OpportunityCard; from: string; to: string } | null;

export function PipelineBoard({
  scope, pipelines, pipelineId, columns, metrics, members, state,
}: {
  scope: CrmScope;
  pipelines: PipelineView[];
  pipelineId: string;
  columns: BoardColumn[];
  metrics: PipelineMetrics;
  members: Array<{ id: string; name: string }>;
  state: { q: string; mine: boolean; closed: number };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { run } = useCrmAction();
  const [cols, setCols] = React.useState(columns);
  const [source, setSource] = React.useState(columns);
  if (source !== columns) {
    setSource(columns);
    setCols(columns);
  }
  const [dragging, setDragging] = React.useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  const [lost, setLost] = React.useState<Pending>(null);
  const [newDeal, setNewDeal] = React.useState<{ stageId?: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [newPipeOpen, setNewPipeOpen] = React.useState(false);
  const [announce, setAnnounce] = React.useState("");
  const pipeline = pipelines.find((p) => p.id === pipelineId)!;
  const canMove = !!scope.can["opportunities.edit"] && !scope.readOnly;
  const canReopen = !!scope.can["opportunities.reopen"];

  const hrefWith = React.useCallback(
    (changes: Partial<Record<"p" | "q" | "mine" | "closed", string | null>>) => {
      const cur: Record<string, string | null> = { p: pipelineId, q: state.q || null, mine: state.mine ? "1" : null, closed: state.closed !== 30 ? String(state.closed) : null };
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...cur, ...changes })) if (v) params.set(k, v);
      const s = params.toString();
      return `${pathname}${s ? `?${s}` : ""}`;
    },
    [pathname, pipelineId, state],
  );

  // Typing replaces the address after a pause; a search changed elsewhere (Back, a link, a filter that clears it) replaces the box's text.
  const search = useUrlSearch(state.q, state, (q) => router.replace(hrefWith({ q: q || null })));

  const stageOf = (id: string) => cols.find((c) => c.stage.id === id)?.stage;

  async function move(card: OpportunityCard, from: string, to: string, lostReason?: string) {
    if (from === to) return;
    const target = stageOf(to);
    if (!target) return;
    if (target.kind === "lost" && !lostReason) {
      setLost({ card, from, to });
      return;
    }
    const before = cols;
    // Optimistic: the card lands in its new column straight away; the server's answer replaces this either way.
    setCols((prev) =>
      prev.map((c) => {
        if (c.stage.id === from) return { ...c, cards: c.cards.filter((x) => x.id !== card.id), count: Math.max(0, c.count - 1) };
        if (c.stage.id === to) return { ...c, cards: [{ ...card, stageId: to, daysInStage: 0, status: target.kind === "open" ? "open" : target.kind }, ...c.cards], count: c.count + 1 };
        return c;
      }),
    );
    setAnnounce(`Moving ${card.name} to ${target.name}.`);
    const res = await run("move", () => moveOpportunityAction(scope.orgId, card.id, to, card.version, lostReason ?? null), (r) => (r.status === "won" ? `${card.name} marked as won.` : r.status === "lost" ? `${card.name} marked as lost.` : null));
    if (!res) {
      setCols(before);
      setAnnounce(`${card.name} was not moved.`);
    } else setAnnounce(`${card.name} moved to ${target.name}.`);
  }

  function onKeyMove(e: React.KeyboardEvent, card: OpportunityCard) {
    if (!canMove || !e.altKey || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    e.preventDefault();
    const idx = cols.findIndex((c) => c.stage.id === card.stageId);
    const next = cols[idx + (e.key === "ArrowRight" ? 1 : -1)];
    if (next) void move(card, card.stageId, next.stage.id);
  }

  const openValue = totalsText(metrics.openValue);
  const openCount = metrics.byStage.filter((s) => s.kind === "open").reduce((n, s) => n + s.count, 0);
  const hasProbabilities = metrics.byStage.some((s) => s.kind === "open" && s.probability !== null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label htmlFor="pipe-select" className="sr-only">Pipeline</label>
          <Select id="pipe-select" value={pipelineId} onChange={(e) => router.push(hrefWith({ p: e.target.value, q: null }))} className="w-auto min-w-[200px] font-medium">
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isDefault ? " (default)" : ""}</option>)}
          </Select>
          <div className="inline-flex rounded-xl border border-line bg-surface-2 p-0.5" role="group" aria-label="View">
            <span className="inline-flex min-h-11 items-center gap-1.5 rounded-[10px] bg-surface px-3 text-[13px] font-medium text-ink shadow-soft sm:min-h-8"><KanbanSquare className="size-4" aria-hidden />Board</span>
            <Link href={`${scope.base}/opportunities?pipeline=${pipelineId}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-medium text-muted hover:text-ink sm:min-h-8"><Table2 className="size-4" aria-hidden />Table</Link>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {scope.can["pipelines.manage"] && !scope.readOnly && (
            <Menu>
              <MenuTrigger asChild>
                <Button variant="secondary" aria-label="Pipeline settings"><Settings2 className="size-4" />Pipeline</Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => setSettingsOpen(true)}>Edit stages and settings</MenuItem>
                <MenuItem onSelect={() => setNewPipeOpen(true)}>New pipeline</MenuItem>
              </MenuContent>
            </Menu>
          )}
          {canMove && <Button data-aqi-target="crm.pipelines.new-deal" onClick={() => setNewDeal({})}><Plus className="size-4" />New deal</Button>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Open pipeline" value={openCount ? openValue : "No open deals"} sub={`${openCount.toLocaleString("en-US")} open ${openCount === 1 ? "deal" : "deals"}`} />
        <Metric
          label="Weighted forecast"
          value={hasProbabilities ? totalsText(metrics.weightedForecast) : "Not set up"}
          sub={hasProbabilities ? (metrics.dealsWithoutProbability ? `${metrics.dealsWithoutProbability} in stages without a probability aren't counted` : "From your stage probabilities") : "Add stage probabilities to forecast"}
        />
        <Metric label="Won, last 90 days" value={metrics.wonCount ? totalsText(metrics.wonValue) : "None yet"} sub={`${metrics.wonCount} won · ${metrics.lostCount} lost`} />
        <Metric label="Win rate, last 90 days" value={metrics.winRate === null ? "—" : `${metrics.winRate}%`} sub={metrics.winRate === null ? "No deals closed yet" : `${metrics.createdCount} new deals in the period`} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label="Search deals" placeholder="Search deals, contacts, companies" className="pl-9" value={search.text} onChange={(e) => search.setText(e.target.value)} />
        </div>
        {scope.userId && !scope.agency && (
          <Segmented id="board-owner" ariaLabel="Whose deals" size="sm" value={state.mine ? "mine" : "all"} onChange={(v) => router.push(hrefWith({ mine: v === "mine" ? "1" : null }))}
            options={[{ value: "all", label: "All deals" }, { value: "mine", label: "My deals" }]} />
        )}
        <label htmlFor="board-closed" className="sr-only">Closed deals shown</label>
        <Select id="board-closed" value={String(state.closed)} onChange={(e) => router.push(hrefWith({ closed: e.target.value }))} className="w-auto">
          <option value="7">Closed: last 7 days</option>
          <option value="30">Closed: last 30 days</option>
          <option value="90">Closed: last 90 days</option>
          <option value="365">Closed: last year</option>
        </Select>
        {canMove && <p className="ml-auto hidden text-[12px] text-faint xl:block">Drag cards between stages, or focus a card and press Alt + ← / →.</p>}
      </div>

      {scope.readOnly && <ReadOnlyNotice>Read-only support access: you can view this board but not move deals.</ReadOnlyNotice>}

      <p className="sr-only" aria-live="polite">{announce}</p>
      <p id="board-kbd-hint" className="sr-only">Press Alt and the left or right arrow to move this deal to the previous or next stage.</p>

      <div data-aqi-target="crm.pipelines.board" className="scrollbar-thin -mx-1 snap-x snap-mandatory overflow-x-auto scroll-px-1 px-1 pb-3 sm:snap-none">
        <ol className="flex min-h-[420px] gap-3" aria-label={`${pipeline.name} stages`}>
          {cols.map((col) => {
            const isOver = over === col.stage.id && dragging && dragging.from !== col.stage.id;
            return (
              <li
                key={col.stage.id}
                aria-label={`${col.stage.name}, ${col.count} ${col.count === 1 ? "deal" : "deals"}`}
                className={cn("flex w-[min(264px,82vw)] shrink-0 snap-start flex-col rounded-2xl border bg-surface-2/60 transition-colors", isOver ? "border-primary/50 bg-primary-soft/40" : "border-line")}
                onDragOver={(e) => {
                  if (!dragging || !canMove) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (over !== col.stage.id) setOver(col.stage.id);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === col.stage.id ? null : o));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const d = dragging;
                  setDragging(null);
                  if (!d) return;
                  const card = cols.find((c) => c.stage.id === d.from)?.cards.find((c) => c.id === d.id);
                  if (card) void move(card, d.from, col.stage.id);
                }}
              >
                <div className="flex items-start justify-between gap-2 border-b border-line px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                      {col.stage.color && <i className="size-2 shrink-0 rounded-full" style={{ background: col.stage.color }} aria-hidden />}
                      {col.stage.kind === "won" && <CheckCircle2 className="size-3.5 text-success" aria-hidden />}
                      {col.stage.kind === "lost" && <CircleSlash className="size-3.5 text-muted" aria-hidden />}
                      <span className="truncate">{col.stage.name}</span>
                      <span className="rounded-full bg-surface px-1.5 text-[11.5px] font-medium tabular-nums text-muted ring-1 ring-line">{col.count}</span>
                    </p>
                    <p className="mt-0.5 truncate text-[12px] text-muted">
                      {col.totals.length ? totalsText(col.totals) : "No value"}
                      {col.stage.probability !== null && col.stage.kind === "open" ? ` · ${col.stage.probability}%` : ""}
                    </p>
                  </div>
                  {canMove && col.stage.kind === "open" && (
                    <button type="button" onClick={() => setNewDeal({ stageId: col.stage.id })} aria-label={`Add a deal to ${col.stage.name}`} className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-ink">
                      <Plus className="size-4" />
                    </button>
                  )}
                </div>
                <ul className="flex flex-1 flex-col gap-2 p-2">
                  {col.cards.map((card) => (
                    <DealCard
                      key={card.id}
                      card={card}
                      scope={scope}
                      columns={cols}
                      canMove={canMove && (card.status === "open" || canReopen)}
                      dragging={dragging?.id === card.id}
                      onDragStart={() => setDragging({ id: card.id, from: col.stage.id })}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onMove={(to) => void move(card, col.stage.id, to)}
                      onKeyDown={(e) => onKeyMove(e, card)}
                    />
                  ))}
                  {!col.cards.length && (
                    <li className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-line px-3 py-6 text-center text-[12.5px] text-faint">
                      {col.stage.kind === "open" ? "No deals here" : `No deals ${col.stage.kind} in the last ${state.closed} days`}
                    </li>
                  )}
                  {col.truncated && (
                    <li className="px-1 text-center text-[12px] text-muted">
                      Showing {col.cards.length} of {col.count}. <Link href={`${scope.base}/opportunities?pipeline=${pipelineId}&stage=${col.stage.id}`} className="font-medium text-primary hover:underline">See all in the table</Link>
                    </li>
                  )}
                </ul>
              </li>
            );
          })}
        </ol>
      </div>

      {!cols.some((c) => c.count) && !state.q && (
        <EmptyState
          icon={<KanbanSquare className="size-5" />}
          title="No deals in this pipeline yet"
          description="Deals you add, deals created from bookings and forms, and deals your AI employees open will all land here."
          action={canMove ? <Button onClick={() => setNewDeal({})}><Plus className="size-4" />Add the first deal</Button> : undefined}
        />
      )}

      {newDeal && (
        <NewDealDialog
          open
          onOpenChange={(o) => !o && setNewDeal(null)}
          scope={scope}
          stay
          pipelines={pipelines.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault, stages: p.stages.filter((s) => s.kind === "open").map((s) => ({ id: s.id, name: s.name })) }))}
          members={members}
          defaults={{ pipelineId, stageId: newDeal.stageId }}
        />
      )}
      {lost && <LostReasonDialog pending={lost} onCancel={() => setLost(null)} onConfirm={(reason) => { const p = lost; setLost(null); void move(p.card, p.from, p.to, reason); }} />}
      {settingsOpen && <PipelineSettingsSheet open onOpenChange={setSettingsOpen} scope={scope} pipeline={pipeline} pipelineCount={pipelines.length} />}
      {newPipeOpen && <NewPipelineDialog open onOpenChange={setNewPipeOpen} scope={scope} onCreated={(id) => router.push(hrefWith({ p: id, q: null }))} />}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="p-3.5">
      <p className="text-[12px] font-medium text-muted">{label}</p>
      <p className="mt-1 truncate text-[17px] font-semibold tracking-[-0.02em] text-ink tabular-nums">{value}</p>
      <p className="mt-0.5 truncate text-[11.5px] text-faint">{sub}</p>
    </Card>
  );
}

function DealCard({
  card, scope, columns, canMove, dragging, onDragStart, onDragEnd, onMove, onKeyDown,
}: {
  card: OpportunityCard;
  scope: CrmScope;
  columns: BoardColumn[];
  canMove: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (stageId: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const overdue = card.status === "open" && card.expectedCloseDate && card.expectedCloseDate < new Date().toISOString().slice(0, 10);
  return (
    <li
      draggable={canMove}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      className={cn(
        "group relative rounded-xl border border-line bg-surface p-3 shadow-soft transition-[box-shadow,opacity] hover:shadow-float",
        canMove && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link href={`${scope.base}/opportunities/${card.id}`} className="min-w-0 text-[13.5px] font-semibold leading-snug text-ink after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-primary hover:text-primary" aria-describedby={canMove ? "board-kbd-hint" : undefined}>
          <span className="line-clamp-2">{card.name}</span>
        </Link>
        {canMove && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={`Move ${card.name}`} className="relative z-10 -mr-1 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted opacity-100 hover:bg-surface-2 hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 sm:data-[state=open]:opacity-100">
                <MoreHorizontal className="size-4" />
              </button>
            </MenuTrigger>
            <MenuContent>
              <MenuLabel>Move to stage</MenuLabel>
              {columns.filter((c) => c.stage.kind === "open").map((c) => (
                <MenuItem key={c.stage.id} disabled={c.stage.id === card.stageId} onSelect={() => onMove(c.stage.id)}>{c.stage.name}</MenuItem>
              ))}
              {columns.some((c) => c.stage.kind !== "open") && <MenuSeparator />}
              {columns.filter((c) => c.stage.kind === "won").map((c) => <MenuItem key={c.stage.id} disabled={c.stage.id === card.stageId} onSelect={() => onMove(c.stage.id)}>Mark won</MenuItem>)}
              {columns.filter((c) => c.stage.kind === "lost").map((c) => <MenuItem key={c.stage.id} disabled={c.stage.id === card.stageId} onSelect={() => onMove(c.stage.id)}>Mark lost…</MenuItem>)}
            </MenuContent>
          </Menu>
        )}
      </div>
      {(card.contact || card.company) && (
        <p className="mt-1 truncate text-[12.5px] text-muted">{[card.contact?.name, card.company?.name].filter(Boolean).join(" · ")}</p>
      )}
      {card.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {card.tags.slice(0, 3).map((t) => <TagChip key={t.id} name={t.name} color={t.color} className="h-5 text-[11px]" />)}
          {card.tags.length > 3 && <span className="text-[11px] text-muted">+{card.tags.length - 3}</span>}
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold tabular-nums text-ink">{card.value === null ? <span className="font-normal text-faint">No value</span> : money(card.value, card.currency)}</span>
        <span className="flex items-center gap-2 text-[11.5px] text-muted">
          {card.openTasks > 0 && <span className="inline-flex items-center gap-0.5" title={`${card.openTasks} open ${card.openTasks === 1 ? "task" : "tasks"}`}><ListChecks className="size-3.5" aria-hidden />{card.openTasks}<span className="sr-only"> open tasks</span></span>}
          {card.expectedCloseDate && card.status === "open" && (
            <span className={cn("inline-flex items-center gap-0.5", overdue && "text-danger-ink")} title={`Expected close ${card.expectedCloseDate}`}><CalendarClock className="size-3.5" aria-hidden />{shortDate(card.expectedCloseDate)}</span>
          )}
          <span title="Days in this stage">{card.daysInStage}d</span>
          {card.owner ? <span title={`Owner: ${card.owner.name}`}><Avatar name={card.owner.name} size="sm" className="size-6 text-[10px]" /></span> : <Badge tone="neutral" className="h-5 px-1.5 text-[10.5px]">Unassigned</Badge>}
        </span>
      </div>
    </li>
  );
}

function LostReasonDialog({ pending, onCancel, onConfirm }: { pending: NonNullable<Pending>; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = React.useState("");
  const presets = ["Went with a competitor", "Price", "No response", "Not a fit", "Timing"];
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()} title={`Why was "${pending.card.name}" lost?`} description="The reason is kept with the deal and used in your win/loss reporting." size="sm"
      footer={<><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>Mark lost</Button></>}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button key={p} type="button" onClick={() => setReason(p)} className={cn("min-h-9 rounded-full border px-3 text-[12.5px]", reason === p ? "border-primary/40 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}>{p}</button>
          ))}
        </div>
        <Field label="Reason" htmlFor="lost-reason"><Textarea id="lost-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus /></Field>
      </div>
    </Dialog>
  );
}
