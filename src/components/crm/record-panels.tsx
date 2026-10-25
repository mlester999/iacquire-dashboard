"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity, CalendarClock, CheckCircle2, Circle, CircleDot, Handshake, MessageSquare, MoreHorizontal, Pencil, Pin, Plus, StickyNote, Tag, Trash2, UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import {
  addNoteAction, createOpportunityAction, createTaskAction, deleteNoteAction, editNoteAction, pinNoteAction, searchContactsAction, setTaskStatusAction, timelineAction,
} from "@/app/actions/crm";
import { money, RecordPicker, useCrmAction } from "@/components/crm/ui";
import type { CrmScope } from "@/server/crm/page";
import type { TimelineItem } from "@/server/crm/timeline";
import type { NoteView } from "@/server/crm/notes";
import type { TaskView } from "@/server/crm/tasks";
import { RelativeTime } from "@/components/crm/relative-time";

const SOURCE_ICON: Record<TimelineItem["source"], React.ComponentType<{ className?: string }>> = {
  activity: Activity, note: StickyNote, message: MessageSquare, appointment: CalendarClock, task: CheckCircle2, deal: Handshake,
};

function kindIcon(item: TimelineItem) {
  if (item.kind.startsWith("tag.")) return Tag;
  if (item.kind.includes("assigned")) return UserCheck;
  return SOURCE_ICON[item.source] ?? Activity;
}

export function Timeline({ scope, target, initial }: { scope: CrmScope; target: { contactId?: string; companyId?: string; opportunityId?: string }; initial: { items: TimelineItem[]; nextBefore: string | null } }) {
  const [items, setItems] = React.useState(initial.items);
  const [next, setNext] = React.useState(initial.nextBefore);
  const [loading, setLoading] = React.useState(false);
  // Reset to the server's page when it changes (after a refresh), without an effect.
  const [source, setSource] = React.useState(initial);
  if (source !== initial) {
    setSource(initial);
    setItems(initial.items);
    setNext(initial.nextBefore);
  }
  if (!items.length) return <EmptyState compact icon={<Activity className="size-5" />} title="Nothing recorded yet" description="Changes, messages, notes, tasks and deal moves appear here as they happen." />;
  return (
    <div>
      <ol className="relative space-y-1 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-line">
        {items.map((item) => {
          const Icon = kindIcon(item);
          return (
            <li key={item.id} className="relative flex gap-3 rounded-xl px-1 py-2">
              <span className="relative z-10 mt-0.5 inline-flex size-[30px] shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted"><Icon className="size-3.5" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="text-[14px] font-medium text-ink">{item.link ? <Link href={item.link.startsWith("/crm") ? item.link.replace(/^\/crm/, scope.base) : item.link} className="hover:underline">{item.title}</Link> : item.title}</p>
                  <RelativeTime iso={item.at} timezone={scope.timezone} className="shrink-0 text-[12px] text-muted" />
                </div>
                {item.detail && <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-[14px] leading-relaxed text-ink-2">{item.detail}</p>}
                {item.actor && <p className="mt-0.5 text-[12px] text-faint">{item.actor}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {next && (
        <div className="mt-3 text-center">
          <Button variant="secondary" size="sm" loading={loading} onClick={async () => {
            setLoading(true);
            const r = await timelineAction(scope.orgId, target, next);
            setLoading(false);
            if (r.ok) {
              setItems((cur) => [...cur, ...r.data.items.filter((i) => !cur.some((c) => c.id === i.id))]);
              setNext(r.data.nextBefore);
            }
          }}>Show earlier activity</Button>
        </div>
      )}
    </div>
  );
}

export function NotesPanel({ scope, type, recordId, notes }: { scope: CrmScope; type: "contact" | "company" | "opportunity"; recordId: string; notes: NoteView[] }) {
  const { run, busy } = useCrmAction();
  const [body, setBody] = React.useState("");
  const [editing, setEditing] = React.useState<{ id: string; body: string } | null>(null);
  const canWrite = Boolean(scope.can["notes.write"]) && !scope.readOnly;
  const canModerate = Boolean(scope.can["contacts.delete"]) && !scope.readOnly;
  return (
    <div className="space-y-4">
      {canWrite && (
        <form onSubmit={async (e) => { e.preventDefault(); if (await run("note-add", () => addNoteAction(scope.orgId, type, recordId, body), "Note added.")) setBody(""); }} className="space-y-2">
          <label htmlFor={`note-${recordId}`} className="sr-only">Add a note</label>
          <Textarea id={`note-${recordId}`} rows={3} placeholder="Add a note for your team…" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
          <div className="flex justify-end"><Button size="sm" type="submit" disabled={!body.trim()} loading={busy("note-add")}>Add note</Button></div>
        </form>
      )}
      {!notes.length ? (
        <EmptyState compact icon={<StickyNote className="size-5" />} title="No notes yet" description={canWrite ? "Notes are visible to everyone on your team who can see this record." : undefined} />
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className={cn("rounded-2xl border p-3.5", n.pinned ? "border-warning/30 bg-warning-soft/40" : "border-line bg-surface")}>
              {editing?.id === n.id ? (
                <div className="space-y-2">
                  <Textarea aria-label="Edit note" rows={3} value={editing.body} onChange={(e) => setEditing({ id: n.id, body: e.target.value })} />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                    <Button size="sm" loading={busy(`note-edit-${n.id}`)} onClick={async () => { if (await run(`note-edit-${n.id}`, () => editNoteAction(scope.orgId, n.id, editing.body), "Note saved.")) setEditing(null); }}>Save</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <p className="whitespace-pre-line text-[14px] leading-relaxed text-ink">{n.body}</p>
                    {(n.mine && canWrite) || canModerate ? (
                      <Menu>
                        <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Note options"><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => run(`note-pin-${n.id}`, () => pinNoteAction(scope.orgId, n.id, !n.pinned))}><Pin className="mr-2 size-4" />{n.pinned ? "Unpin" : "Pin to top"}</MenuItem>
                          {(n.mine || canModerate) && <MenuItem onSelect={() => setEditing({ id: n.id, body: n.body })}><Pencil className="mr-2 size-4" />Edit</MenuItem>}
                          {(n.mine || canModerate) && <MenuItem destructive onSelect={() => run(`note-del-${n.id}`, () => deleteNoteAction(scope.orgId, n.id), "Note deleted.")}><Trash2 className="mr-2 size-4" />Delete</MenuItem>}
                        </MenuContent>
                      </Menu>
                    ) : null}
                  </div>
                  <p className="mt-2 text-[12px] text-muted">{n.authorName ?? "Someone"} · <RelativeTime iso={n.createdAt} timezone={scope.timezone} />{n.updatedAt ? " · edited" : ""}{n.pinned ? " · pinned" : ""}</p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const PRIORITY_TONE = { low: "neutral", normal: "neutral", high: "warning", urgent: "danger" } as const;

export function TaskList({ scope, tasks, showLinks = true, emptyText, onOpen }: { scope: CrmScope; tasks: TaskView[]; showLinks?: boolean; emptyText?: string; onOpen?: (task: TaskView) => void }) {
  const { run } = useCrmAction();
  const canManage = Boolean(scope.can["tasks.manage"]) && !scope.readOnly;
  if (!tasks.length) return <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[14px] text-muted">{emptyText ?? "No tasks."}</p>;
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
      {tasks.map((t) => {
        const done = t.status === "done";
        return (
          <li key={t.id} className="flex items-start gap-3 px-3.5 py-3">
            <button
              type="button"
              disabled={!canManage}
              onClick={() => run(`task-${t.id}`, () => setTaskStatusAction(scope.orgId, t.id, done ? "open" : "done"), done ? "Task reopened." : "Task completed.")}
              aria-label={done ? `Reopen ${t.title}` : `Mark ${t.title} done`}
              className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted hover:text-primary disabled:pointer-events-none"
            >
              {done ? <CheckCircle2 className="size-5 text-success" /> : t.status === "in_progress" ? <CircleDot className="size-5 text-primary" /> : <Circle className="size-5" />}
            </button>
            <div className="min-w-0 flex-1">
              {onOpen ? (
                <button type="button" onClick={() => onOpen(t)} className={cn("text-left text-[14px] font-medium hover:text-primary", done ? "text-muted line-through" : "text-ink")}>{t.title}</button>
              ) : (
                <p className={cn("text-[14px] font-medium", done ? "text-muted line-through" : "text-ink")}>{t.title}</p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                {t.dueAt && <span className={cn(t.overdue && "font-semibold text-danger-ink")}>{t.overdue ? "Overdue · " : "Due "}{new Date(t.dueAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: scope.timezone })}</span>}
                {t.assignee && <span>· {t.assignee.name}</span>}
                {t.priority !== "normal" && <Badge tone={PRIORITY_TONE[t.priority]} className="h-5 px-2 text-[12px] capitalize">{t.priority}</Badge>}
                {showLinks && t.contact && <Link href={`${scope.base}/contacts/${t.contact.id}`} className="hover:underline">· {t.contact.name}</Link>}
                {showLinks && t.opportunity && <Link href={`${scope.base}/opportunities/${t.opportunity.id}`} className="hover:underline">· {t.opportunity.name}</Link>}
                {t.comments > 0 && <span>· {t.comments} {t.comments === 1 ? "comment" : "comments"}</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function QuickTask({ scope, members, link, onDone }: { scope: CrmScope; members: Array<{ id: string; name: string }>; link: { contactId?: string; opportunityId?: string; companyId?: string }; onDone?: () => void }) {
  const { run, busy } = useCrmAction();
  const [title, setTitle] = React.useState("");
  const [due, setDue] = React.useState("");
  const [assignee, setAssignee] = React.useState(scope.userId ?? "");
  const [priority, setPriority] = React.useState<"low" | "normal" | "high" | "urgent">("normal");
  if (!scope.can["tasks.manage"] || scope.readOnly) return null;
  return (
    <form
      className="grid gap-2 rounded-2xl border border-line bg-surface-2/50 p-3 sm:grid-cols-[minmax(0,1fr)_170px_150px_110px_auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run("task-add", () => createTaskAction(scope.orgId, { title, dueAt: due ? new Date(due).toISOString() : null, assigneeId: assignee || null, priority, ...link }), "Task added.");
        if (ok) {
          setTitle("");
          setDue("");
          onDone?.();
        }
      }}
    >
      <Field label="New task" htmlFor={`qt-${JSON.stringify(link)}`}><Input id={`qt-${JSON.stringify(link)}`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call back about the quote" maxLength={200} /></Field>
      <Field label="Due" htmlFor="qt-due" optional><Input id="qt-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      <Field label="Assign to" htmlFor="qt-who">
        <Select id="qt-who" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Nobody yet</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
      </Field>
      <Field label="Priority" htmlFor="qt-pri">
        <Select id="qt-pri" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
          <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
        </Select>
      </Field>
      <Button type="submit" size="md" disabled={!title.trim()} loading={busy("task-add")}><Plus className="size-4" />Add</Button>
    </form>
  );
}

export function NewDealDialog({
  open, onOpenChange, scope, pipelines, members, defaults, stay,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  scope: CrmScope;
  pipelines: Array<{ id: string; name: string; isDefault: boolean; stages: Array<{ id: string; name: string }> }>;
  members: Array<{ id: string; name: string }>;
  defaults: { contactId?: string; contactName?: string; companyId?: string; name?: string; pipelineId?: string; stageId?: string };
  /** Stay on the current page after creating (the board) instead of opening the new deal. */
  stay?: boolean;
}) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const firstPipe = pipelines.find((p) => p.id === defaults.pipelineId) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const [form, setForm] = React.useState({ name: defaults.name ?? "", pipelineId: firstPipe?.id ?? "", stageId: defaults.stageId ?? firstPipe?.stages[0]?.id ?? "", value: "", currency: scope.currency, ownerId: scope.userId ?? "", expectedCloseDate: "" });
  const [contact, setContact] = React.useState<{ id: string; name: string } | null>(defaults.contactId ? { id: defaults.contactId, name: defaults.contactName ?? "" } : null);
  const pipe = pipelines.find((p) => p.id === form.pipelineId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New deal" description={defaults.contactName ? `For ${defaults.contactName}` : undefined} size="md"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button form="deal-form" type="submit" loading={busy("deal")} disabled={!form.name.trim()}>Create deal</Button></>}>
      <form id="deal-form" className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run("deal", () => createOpportunityAction(scope.orgId, {
          name: form.name, pipelineId: form.pipelineId || null, stageId: form.stageId || null, value: form.value ? Number(form.value) : null, currency: form.currency,
          ownerId: form.ownerId || null, expectedCloseDate: form.expectedCloseDate || null, contactId: contact?.id ?? null, companyId: defaults.companyId ?? null,
        }), "Deal created.");
        if (r) {
          onOpenChange(false);
          if (!stay) router.push(`${scope.base}/opportunities/${r.id}`);
        }
      }}>
        <Field label="Deal name" htmlFor="d-name" className="sm:col-span-2"><Input id="d-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Kitchen renovation" autoFocus /></Field>
        {!defaults.contactId && scope.can["contacts.view"] && (
          <Field label="Contact" htmlFor="d-contact" optional className="sm:col-span-2">
            <RecordPicker id="d-contact" label="Contact" placeholder="Search contacts by name, email or phone" value={contact ? contact.name || "Unnamed contact" : undefined} onClear={() => setContact(null)}
              search={async (q) => { const r = await searchContactsAction(scope.orgId, q); return r.ok ? r.data : []; }}
              render={(c) => <span className="flex min-w-0 flex-col"><span className="truncate">{c.name || "Unnamed contact"}</span><span className="truncate text-[12px] text-muted">{c.email ?? c.phone ?? ""}</span></span>}
              onPick={(c) => { setContact({ id: c.id, name: c.name }); if (!form.name.trim() && c.name) setForm((f) => ({ ...f, name: `${c.name} deal` })); }} />
          </Field>
        )}
        <Field label="Pipeline" htmlFor="d-pipe">
          <Select id="d-pipe" value={form.pipelineId} onChange={(e) => { const p = pipelines.find((x) => x.id === e.target.value); setForm({ ...form, pipelineId: e.target.value, stageId: p?.stages[0]?.id ?? "" }); }}>
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Stage" htmlFor="d-stage">
          <Select id="d-stage" value={form.stageId} onChange={(e) => setForm({ ...form, stageId: e.target.value })}>
            {pipe?.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Value" htmlFor="d-value" optional hint={form.value ? money(Number(form.value), form.currency) : undefined}><Input id="d-value" type="number" min={0} step="0.01" inputMode="decimal" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></Field>
        <Field label="Currency" htmlFor="d-cur"><Input id="d-cur" maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field>
        <Field label="Owner" htmlFor="d-owner" optional>
          <Select id="d-owner" value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })} disabled={!scope.can["contacts.assign"]}>
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="Expected close" htmlFor="d-close" optional><Input id="d-close" type="date" value={form.expectedCloseDate} onChange={(e) => setForm({ ...form, expectedCloseDate: e.target.value })} /></Field>
      </form>
    </Dialog>
  );
}

export function SectionCard({ title, action, children, className }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("card-surface rounded-2xl", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function DefinitionList({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="grid gap-x-4 gap-y-2.5 text-[14px] sm:grid-cols-[minmax(0,140px)_minmax(0,1fr)]">
      {items.map((i) => (
        <React.Fragment key={i.label}>
          <dt className="text-muted">{i.label}</dt>
          <dd className="min-w-0 break-words text-ink">{i.value ?? <span className="text-faint">—</span>}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
