"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarPlus, KanbanSquare, MessageSquareText, RefreshCw, Rows3, Search, ShieldCheck, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input, Textarea } from "@/components/ui/primitives";
import { Segmented, Sheet } from "@/components/ui/overlays";
import { MetricCard,CoverageBar } from "@/components/ui/workspace";
import { addNoteAction, createTaskAction, listNotesAction, refreshCrmAction } from "@/app/actions/records";
import { cn, formatCurrency, formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";

interface Opp {
  id: string;
  ghl_opportunity_id: string;
  ghl_pipeline_id: string | null;
  stage_id: string | null;
  stage_name: string | null;
  name: string;
  status: string;
  monetary_value: number | null;
  contact_label: string | null;
  assigned_to: string | null;
  source: string | null;
  remote_updated_at: string | null;
  synced_at: string;
  notes: number;
}

interface Data {
  pipelines: Array<{ ghl_pipeline_id: string; name: string; stages: Array<{ id: string; name: string; position: number }>; synced_at: string }>;
  opportunities: Opp[];
  tasks: Array<{ id: string; title: string; due_at: string | null; related_id: string | null }>;
  pendingSalesApprovals: number;
}

const STATUS_TONE: Record<string, "primary" | "success" | "danger" | "neutral"> = { open: "primary", won: "success", lost: "danger", abandoned: "neutral" };

export function SalesBoard({ data, canNote, canTask, canRefresh, timeZone }: { data: Data; canNote: boolean; canTask: boolean; canRefresh: boolean; timeZone: string }) {
  const router = useRouter();
  const [view, setView] = React.useState<"board" | "table">("board");
  const [pipelineId, setPipelineId] = React.useState(data.pipelines[0]?.ghl_pipeline_id ?? "");
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [open, setOpen] = React.useState<Opp | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const pipeline = data.pipelines.find((p) => p.ghl_pipeline_id === pipelineId);
  const opps = data.opportunities.filter(
    (o) => (!pipelineId || o.ghl_pipeline_id === pipelineId) && (status === "all" || o.status === status) && (!query || `${o.name} ${o.contact_label ?? ""}`.toLowerCase().includes(query.toLowerCase())),
  );
  const openValue = opps.filter((o) => o.status === "open").reduce((s, o) => s + (o.monetary_value ?? 0), 0);
  const wonValue = opps.filter((o) => o.status === "won").reduce((s, o) => s + (o.monetary_value ?? 0), 0);
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Open opportunities" value={opps.filter((o)=>o.status==="open").length} detail="Opportunities in the current filtered view." icon={<KanbanSquare className="size-4"/>}/>
        <MetricCard label="Open pipeline value" value={formatCurrency(openValue)} detail="Only values recorded in your CRM." icon={<Rows3 className="size-4"/>} tone="violet"/>
        <MetricCard label="Won value" value={formatCurrency(wonValue)} detail="Closed-won opportunities in this view." icon={<Trophy className="size-4"/>} tone="green"/>
      </div>
      {stages.length>0&&<div className="control-panel p-4"><p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted">Opportunity distribution · {pipeline?.name}</p><CoverageBar label="Opportunities by pipeline stage" parts={stages.map((stage,index)=>({label:stage.name,count:opps.filter(opportunity=>opportunity.stage_id===stage.id).length,color:["var(--primary)","var(--violet)","var(--success)","var(--warning)"][index%4]}))}/></div>}

      {data.pendingSalesApprovals > 0 && (
        <Link href="/approvals" className="flex items-center gap-3 rounded-2xl border border-warning/30 bg-warning-soft/50 px-4 py-3 text-[13px] text-warning-ink">
          <ShieldCheck className="size-4" /> {data.pendingSalesApprovals} sales follow-up or CRM change{data.pendingSalesApprovals === 1 ? " is" : "s are"} waiting for your approval.
        </Link>
      )}

      <Card>
        <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
          {data.pipelines.length > 1 && (
            <label className="sr-only" htmlFor="pipeline-select">
              Pipeline
            </label>
          )}
          {data.pipelines.length > 1 && (
            <select id="pipeline-select" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className="h-9 rounded-xl border border-line-strong bg-surface px-3 text-[13.5px]">
              {data.pipelines.map((p) => (
                <option key={p.ghl_pipeline_id} value={p.ghl_pipeline_id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {data.pipelines.length === 1 && <p className="text-[14px] font-semibold">{pipeline?.name}</p>}
          <div className="relative lg:ml-auto lg:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <label htmlFor="opp-search" className="sr-only">
              Search opportunities
            </label>
            <Input id="opp-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search opportunities" className="h-9 pl-9" />
          </div>
          <Segmented id="opp-status" ariaLabel="Status" size="sm" value={status} onChange={setStatus} options={["all", "open", "won", "lost"].map((s) => ({ value: s, label: sentenceCase(s) }))} />
          <Segmented
            id="opp-view"
            ariaLabel="View"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "board", label: <span className="flex items-center gap-1.5"><KanbanSquare className="size-3.5" />Board</span> },
              { value: "table", label: <span className="flex items-center gap-1.5"><Rows3 className="size-3.5" />Table</span> },
            ]}
          />
          {canRefresh && (
            <Button
              size="sm"
              variant="ghost"
              loading={refreshing}
              onClick={async () => {
                setRefreshing(true);
                const res = await refreshCrmAction();
                setRefreshing(false);
                if (!res.ok) return toast.error(res.error);
                toast.success("Pipeline refreshed from your CRM");
                router.refresh();
              }}
            >
              <RefreshCw className="size-3.5" /> Refresh
            </Button>
          )}
        </div>

        {view === "board" ? (
          <div className="scrollbar-thin overflow-x-auto p-4">
            <div className="flex gap-3" style={{ minWidth: `${Math.max(stages.length, 1) * 260}px` }}>
              {stages.map((stage) => {
                const items = opps.filter((o) => o.stage_id === stage.id);
                const value = items.reduce((s, o) => s + (o.monetary_value ?? 0), 0);
                return (
                  <div key={stage.id} className="flex w-[260px] shrink-0 flex-col rounded-2xl bg-surface-2/70 p-2">
                    <div className="flex items-center justify-between px-2 py-1.5">
                      <p className="truncate text-[13px] font-semibold">{stage.name}</p>
                      <span className="rounded-full bg-surface px-2 py-0.5 text-[11.5px] font-medium text-muted">{items.length}</span>
                    </div>
                    <p className="px-2 pb-2 text-[11.5px] text-faint">{value ? formatCurrency(value) : "No value set"}</p>
                    <div className="space-y-2">
                      {items.map((o) => (
                        <button key={o.id} type="button" onClick={() => setOpen(o)} className="block w-full rounded-xl border border-line bg-surface p-3 text-left shadow-soft transition hover:-translate-y-0.5 hover:shadow-card">
                          <p className="text-[13px] font-medium leading-snug">{o.name}</p>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <span className="text-[12px] tabular-nums text-ink-2">{o.monetary_value ? formatCurrency(o.monetary_value) : "—"}</span>
                            <Badge tone={STATUS_TONE[o.status] ?? "neutral"} className="h-5 text-[11px]">
                              {sentenceCase(o.status)}
                            </Badge>
                          </div>
                          {o.notes > 0 && (
                            <p className="mt-1.5 flex items-center gap-1 text-[11px] text-faint">
                              <MessageSquareText className="size-3" /> {o.notes} note{o.notes === 1 ? "" : "s"}
                            </p>
                          )}
                        </button>
                      ))}
                      {items.length === 0 && <p className="px-2 py-4 text-center text-[12px] text-faint">Empty</p>}
                    </div>
                  </div>
                );
              })}
              {stages.length === 0 && <p className="p-6 text-[13px] text-muted">This pipeline has no stages yet.</p>}
            </div>
          </div>
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-[13.5px]">
              <thead className="bg-surface-2/60 text-[12px] text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Opportunity</th>
                  <th className="px-3 py-3 font-medium">Stage</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 text-right font-medium">Value</th>
                  <th className="px-4 py-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {opps.map((o) => (
                  <tr key={o.id} onClick={() => setOpen(o)} className="cursor-pointer hover:bg-surface-2/50">
                    <td className="px-4 py-3 font-medium">{o.name}</td>
                    <td className="px-3 py-3 text-ink-2">{o.stage_name ?? "—"}</td>
                    <td className="px-3 py-3">
                      <Badge tone={STATUS_TONE[o.status] ?? "neutral"}>{sentenceCase(o.status)}</Badge>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{o.monetary_value ? formatCurrency(o.monetary_value) : "—"}</td>
                    <td className="px-4 py-3 text-[12.5px] text-muted">{o.remote_updated_at ? relativeTime(o.remote_updated_at) : "—"}</td>
                  </tr>
                ))}
                {opps.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-[13px] text-muted">
                      No opportunities match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-[12px] text-faint">Read-only view of your CRM{pipeline?.synced_at ? ` · last synced ${relativeTime(pipeline.synced_at)}` : ""}.</p>

      <OpportunitySheet opp={open} onClose={() => setOpen(null)} canNote={canNote} canTask={canTask} timeZone={timeZone} />
    </div>
  );
}

function OpportunitySheet({ opp, onClose, canNote, canTask, timeZone }: { opp: Opp | null; onClose: () => void; canNote: boolean; canTask: boolean; timeZone: string }) {
  const router = useRouter();
  // Notes are tagged with their opportunity so a stale list never shows for a different record.
  const [loaded, setLoaded] = React.useState<{ id: string; notes: Array<{ id: string; body: string; created_at: string; author: string | null }> } | null>(null);
  const notes = opp && loaded?.id === opp.id ? loaded.notes : null;
  const [note, setNote] = React.useState("");
  const [task, setTask] = React.useState("");
  const [due, setDue] = React.useState("");
  const load = React.useCallback(async (id: string) => {
    const res = await listNotesAction("opportunity", id);
    setLoaded({ id, notes: res.ok ? res.data : [] });
  }, []);
  React.useEffect(() => {
    if (!opp) return;
    let live = true;
    listNotesAction("opportunity", opp.id).then((res) => live && setLoaded({ id: opp.id, notes: res.ok ? res.data : [] }));
    return () => {
      live = false;
    };
  }, [opp]);
  return (
    <Sheet open={Boolean(opp)} onOpenChange={(o) => !o && onClose()} title={opp?.name ?? "Opportunity"} description={opp?.stage_name ?? undefined}>
      {opp && (
        <div className="space-y-6 p-5">
          <dl className="grid grid-cols-2 gap-3 text-[13px]">
            {[
              ["Status", sentenceCase(opp.status)],
              ["Value", opp.monetary_value ? formatCurrency(opp.monetary_value) : "Not set"],
              ["Contact", opp.contact_label ?? "—"],
              ["Source", opp.source ?? "—"],
              ["Owner", opp.assigned_to ?? "Unassigned"],
              ["Updated", opp.remote_updated_at ? formatDateTime(opp.remote_updated_at, timeZone) : "—"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl bg-surface-2 p-3">
                <dt className="text-[11.5px] text-muted">{k}</dt>
                <dd className="mt-0.5 font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="rounded-xl border border-line p-3 text-[12.5px] text-muted">Proposal and requirements status, stage changes and follow-up messages are managed through your AI Sales Assistant and the Approval Center.</p>
          {canTask && (
            <div className="space-y-2">
              <p className="text-[13px] font-semibold">Add a follow-up task</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <label htmlFor="task-title" className="sr-only">
                  Task
                </label>
                <Input id="task-title" value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Call to confirm budget" maxLength={200} />
                <label htmlFor="task-due" className="sr-only">
                  Due date
                </label>
                <Input id="task-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="sm:w-40" />
                <Button
                  disabled={!task.trim()}
                  onClick={async () => {
                    const res = await createTaskAction({ title: task, dueAt: due ? `${due}T17:00:00` : null, category: "sales", relatedType: "opportunity", relatedId: opp.id });
                    if (!res.ok) return toast.error(res.error);
                    toast.success("Follow-up added");
                    setTask("");
                    setDue("");
                    router.refresh();
                  }}
                >
                  <CalendarPlus className="size-4" /> Add
                </Button>
              </div>
            </div>
          )}
          <div className="space-y-3">
            <p className="text-[13px] font-semibold">Notes</p>
            {canNote && (
              <div className="space-y-2">
                <Field label="New note" htmlFor="opp-note">
                  <Textarea id="opp-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} />
                </Field>
                <Button
                  size="sm"
                  disabled={!note.trim()}
                  onClick={async () => {
                    const res = await addNoteAction("opportunity", opp.id, note);
                    if (!res.ok) return toast.error(res.error);
                    setNote("");
                    void load(opp.id);
                  }}
                >
                  Save note
                </Button>
              </div>
            )}
            {notes === null ? (
              <div className="skeleton h-12 rounded-xl" />
            ) : notes.length === 0 ? (
              <p className="text-[13px] text-muted">No notes yet.</p>
            ) : (
              <ul className="space-y-2">
                {notes.map((n) => (
                  <li key={n.id} className={cn("rounded-xl border border-line p-3")}>
                    <p className="whitespace-pre-wrap text-[13px]">{n.body}</p>
                    <p className="mt-1 text-[11.5px] text-faint">
                      {n.author ?? "Someone"} · {relativeTime(n.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
