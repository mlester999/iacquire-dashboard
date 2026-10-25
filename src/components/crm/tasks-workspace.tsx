"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CheckCircle2, LayoutList, ListChecks, Plus, Search, SquareKanban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Sheet } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { addTaskCommentAction, createTaskAction, searchContactsAction, setTaskStatusAction, taskCommentsAction, updateTaskAction } from "@/app/actions/crm";
import { RecordPicker, useCrmAction } from "@/components/crm/ui";
import { PRIORITY_TONE, TaskList } from "@/components/crm/record-panels";
import { useUrlSearch } from "@/components/crm/url-search";
import type { TaskPriority, TaskStatus, TaskView, TaskView_ } from "@/server/crm/tasks";
import type { CrmScope } from "@/server/crm/page";
import { RelativeTime } from "@/components/crm/relative-time";

const VIEWS: Array<{ value: TaskView_; label: string }> = [
  { value: "mine", label: "My tasks" },
  { value: "team", label: "Team" },
  { value: "overdue", label: "Overdue" },
  { value: "upcoming", label: "Due this week" },
  { value: "completed", label: "Completed" },
];
const STATUS_LABEL: Record<TaskStatus, string> = { open: "To do", in_progress: "In progress", done: "Done", cancelled: "Cancelled" };
const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

/** A datetime-local value in the browser's time zone, and back. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export function TasksWorkspace({
  scope, tasks, counts, members, state, openTask,
}: {
  scope: CrmScope;
  tasks: TaskView[];
  counts: Record<"mine" | "team" | "overdue" | "upcoming", number>;
  members: Array<{ id: string; name: string }>;
  state: { view: TaskView_; layout: "list" | "board"; assignee: string | null; q: string };
  openTask: TaskView | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { run } = useCrmAction();
  const [newOpen, setNewOpen] = React.useState(false);
  const [open, setOpen] = React.useState<TaskView | null>(openTask);
  const canManage = !!scope.can["tasks.manage"] && !scope.readOnly;

  const hrefWith = React.useCallback(
    (changes: Partial<Record<"view" | "layout" | "assignee" | "q", string | null>>) => {
      const cur = { view: state.view === "mine" ? null : state.view, layout: state.layout === "list" ? null : state.layout, assignee: state.assignee, q: state.q || null };
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...cur, ...changes })) if (v) params.set(k, v);
      const s = params.toString();
      return `${pathname}${s ? `?${s}` : ""}`;
    },
    [pathname, state],
  );

  // Typing replaces the address after a pause; a search changed elsewhere (Back, a link, a filter that clears it) replaces the box's text.
  const search = useUrlSearch(state.q, state, (q) => router.replace(hrefWith({ q: q || null })));

  // Keep the open task's details current after a refresh.
  const current = open ? tasks.find((t) => t.id === open.id) ?? open : null;

  return (
    <div className="space-y-4">
      <div data-aqi-target="crm.tasks.header" className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold tracking-[-0.03em] text-ink">Tasks</h2>
          <p className="mt-1 text-[13px] text-muted">{"Follow-ups and to-dos for your team, linked to the contacts and deals they're about."}</p>
        </div>
        {canManage && <Button data-aqi-target="crm.tasks.new" onClick={() => setNewOpen(true)}><Plus className="size-4" />New task</Button>}
      </div>

      <nav aria-label="Task views" data-aqi-target="crm.tasks.views" className="relative scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1">
        {VIEWS.map((v) => {
          const active = state.view === v.value;
          const n = v.value in counts ? counts[v.value as keyof typeof counts] : null;
          return (
            <Link key={v.value} href={hrefWith({ view: v.value === "mine" ? null : v.value })} aria-current={active ? "page" : undefined}
              className={cn("inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-3.5 text-[13.5px] font-medium sm:min-h-9", active ? "bg-surface text-ink shadow-soft ring-1 ring-line" : "text-muted hover:text-ink")}>
              {v.label}
              {n !== null && <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold", v.value === "overdue" && n > 0 ? "bg-danger-soft text-danger-ink" : "bg-surface-3 text-ink-2")}>{n}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label="Search tasks" placeholder="Search tasks" className="pl-9" value={search.text} onChange={(e) => search.setText(e.target.value)} />
        </div>
        {state.view !== "mine" && (
          <>
            <label htmlFor="task-assignee" className="sr-only">Assignee</label>
            <Select id="task-assignee" className="w-auto" value={state.assignee ?? ""} onChange={(e) => router.push(hrefWith({ assignee: e.target.value || null }))}>
              <option value="">Anyone</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </>
        )}
        <div className="ml-auto inline-flex rounded-xl border border-line bg-surface-2 p-0.5" role="group" aria-label="Layout">
          {(["list", "board"] as const).map((l) => (
            <Link key={l} href={hrefWith({ layout: l === "list" ? null : l })} aria-current={state.layout === l ? "true" : undefined}
              className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-medium sm:min-h-8", state.layout === l ? "bg-surface text-ink shadow-soft" : "text-muted hover:text-ink")}>
              {l === "list" ? <LayoutList className="size-4" aria-hidden /> : <SquareKanban className="size-4" aria-hidden />}
              {l === "list" ? "List" : "Board"}
            </Link>
          ))}
        </div>
      </div>

      {!tasks.length ? (
        <Card>
          <EmptyState icon={<ListChecks className="size-5" />} title={state.view === "completed" ? "Nothing completed yet" : state.view === "overdue" ? "Nothing overdue" : "No tasks here"}
            description={state.view === "mine" ? "Tasks assigned to you will show up here, including follow-ups your AI employees create for you." : "Tasks from contacts, deals and automations appear here."}
            action={canManage && state.view !== "completed" ? <Button variant="secondary" onClick={() => setNewOpen(true)}><Plus className="size-4" />Add a task</Button> : undefined} />
        </Card>
      ) : state.layout === "board" ? (
        <div className="grid gap-3 md:grid-cols-3">
          {(["open", "in_progress", "done"] as const).map((status) => {
            const items = tasks.filter((t) => t.status === status);
            return (
              <section key={status} className="rounded-2xl border border-line bg-surface-2/60" aria-label={STATUS_LABEL[status]}>
                <h3 className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-[13px] font-semibold text-ink">{STATUS_LABEL[status]}<span className="rounded-full bg-surface px-1.5 text-[11.5px] font-medium text-muted ring-1 ring-line">{items.length}</span></h3>
                <ul className="space-y-2 p-2">
                  {items.map((t) => (
                    <li key={t.id} className="rounded-xl border border-line bg-surface p-3 shadow-soft">
                      <button type="button" onClick={() => setOpen(t)} className="text-left text-[13.5px] font-medium text-ink hover:text-primary">{t.title}</button>
                      <p className="mt-1 text-[12px] text-muted">
                        {t.dueAt ? <span className={cn(t.overdue && "font-semibold text-danger-ink")}>{new Date(t.dueAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: scope.timezone })}</span> : "No due date"}
                        {t.assignee ? ` · ${t.assignee.name}` : ""}
                      </p>
                      {canManage && (
                        <div className="mt-2 flex gap-1">
                          {(["open", "in_progress", "done"] as const).filter((s) => s !== status).map((s) => (
                            <Button key={s} size="sm" variant="ghost" className="h-8 px-2 text-[12px]" onClick={() => run(`st-${t.id}`, () => setTaskStatusAction(scope.orgId, t.id, s))}>{s === "done" ? <><CheckCircle2 className="size-3.5" />Done</> : `Move to ${STATUS_LABEL[s]}`}</Button>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                  {!items.length && <li className="px-2 py-4 text-center text-[12.5px] text-faint">Nothing here</li>}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <TaskList scope={scope} tasks={tasks} onOpen={setOpen} />
      )}

      {newOpen && <TaskDialog scope={scope} members={members} onClose={() => setNewOpen(false)} />}
      {current && <TaskSheet key={current.id} scope={scope} task={current} members={members} onClose={() => { setOpen(null); if (openTask) router.replace(hrefWith({})); }} />}
    </div>
  );
}

function TaskDialog({ scope, members, onClose }: { scope: CrmScope; members: Array<{ id: string; name: string }>; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [form, setForm] = React.useState({ title: "", description: "", due: "", priority: "normal" as TaskPriority, assigneeId: scope.userId ?? "" });
  const [contact, setContact] = React.useState<{ id: string; name: string } | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New task" size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="task-form" type="submit" disabled={!form.title.trim()} loading={busy("create")}>Create task</Button></>}>
      <form id="task-form" className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run("create", () => createTaskAction(scope.orgId, { title: form.title, description: form.description || null, dueAt: fromLocalInput(form.due), priority: form.priority, assigneeId: form.assigneeId || null, contactId: contact?.id ?? null }), "Task created.");
        if (r) onClose();
      }}>
        <Field label="Title" htmlFor="t-title" className="sm:col-span-2"><Input id="t-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} placeholder="Call back about the quote" autoFocus /></Field>
        <Field label="Due" htmlFor="t-due" optional><Input id="t-due" type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} /></Field>
        <Field label="Priority" htmlFor="t-priority"><Select id="t-priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}>{PRIORITIES.map((p) => <option key={p} value={p} className="capitalize">{p[0].toUpperCase() + p.slice(1)}</option>)}</Select></Field>
        <Field label="Assignee" htmlFor="t-assignee" className="sm:col-span-2">
          <Select id="t-assignee" value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        {scope.can["contacts.view"] && (
          <Field label="Contact" htmlFor="t-contact" optional className="sm:col-span-2">
            <RecordPicker id="t-contact" label="Contact" placeholder="Search contacts" value={contact ? contact.name || "Unnamed contact" : undefined} onClear={() => setContact(null)}
              search={async (q) => { const r = await searchContactsAction(scope.orgId, q); return r.ok ? r.data : []; }}
              render={(c) => <span className="flex flex-col"><span>{c.name || "Unnamed contact"}</span><span className="text-[12px] text-muted">{c.email ?? c.phone ?? ""}</span></span>}
              onPick={(c) => setContact({ id: c.id, name: c.name })} />
          </Field>
        )}
        <Field label="Details" htmlFor="t-desc" optional className="sm:col-span-2"><Textarea id="t-desc" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={2000} /></Field>
      </form>
    </Dialog>
  );
}

function TaskSheet({ scope, task, members, onClose }: { scope: CrmScope; task: TaskView; members: Array<{ id: string; name: string }>; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const canManage = !!scope.can["tasks.manage"] && !scope.readOnly;
  const [form, setForm] = React.useState({ title: task.title, description: task.description ?? "", due: toLocalInput(task.dueAt), remind: toLocalInput(task.remindAt), priority: task.priority, assigneeId: task.assignee?.id ?? "" });
  const [comments, setComments] = React.useState<Array<{ id: string; body: string; author: string | null; mine: boolean; createdAt: string }> | null>(null);
  const [comment, setComment] = React.useState("");
  const [commentsVersion, setCommentsVersion] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    taskCommentsAction(scope.orgId, task.id).then((r) => {
      if (live && r.ok) setComments(r.data);
    });
    return () => {
      live = false;
    };
  }, [scope.orgId, task.id, commentsVersion]);
  const dirty = form.title !== task.title || form.description !== (task.description ?? "") || form.due !== toLocalInput(task.dueAt) || form.remind !== toLocalInput(task.remindAt) || form.priority !== task.priority || form.assigneeId !== (task.assignee?.id ?? "");
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Task" description={task.source !== "user" ? <>Created by {task.source === "agent" ? "an AI employee" : task.source === "workflow" ? "an automation" : "iAcquire"} · <RelativeTime iso={task.createdAt} timezone={scope.timezone} /></> : <>Created <RelativeTime iso={task.createdAt} timezone={scope.timezone} /></>}>
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="ts-status" className="sr-only">Status</label>
          <Select id="ts-status" className="w-auto" value={task.status} disabled={!canManage} onChange={(e) => run("status", () => setTaskStatusAction(scope.orgId, task.id, e.target.value as TaskStatus), "Status updated.")}>
            {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </Select>
          {task.priority !== "normal" && <Badge tone={PRIORITY_TONE[task.priority]} className="capitalize">{task.priority}</Badge>}
          {task.overdue && <Badge tone="danger">Overdue</Badge>}
        </div>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          await run("save", () => updateTaskAction(scope.orgId, task.id, { title: form.title, description: form.description || null, dueAt: fromLocalInput(form.due), remindAt: fromLocalInput(form.remind), priority: form.priority, assigneeId: form.assigneeId || null }), "Task saved.");
        }}>
          <Field label="Title" htmlFor="ts-title" className="sm:col-span-2"><Input id="ts-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} disabled={!canManage} maxLength={200} /></Field>
          <Field label="Due" htmlFor="ts-due" optional><Input id="ts-due" type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} disabled={!canManage} /></Field>
          <Field label="Remind me" htmlFor="ts-remind" optional hint="The assignee gets a notification then"><Input id="ts-remind" type="datetime-local" value={form.remind} onChange={(e) => setForm({ ...form, remind: e.target.value })} disabled={!canManage} /></Field>
          <Field label="Priority" htmlFor="ts-priority"><Select id="ts-priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })} disabled={!canManage}>{PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</Select></Field>
          <Field label="Assignee" htmlFor="ts-assignee">
            <Select id="ts-assignee" value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} disabled={!canManage}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="Details" htmlFor="ts-desc" optional className="sm:col-span-2"><Textarea id="ts-desc" rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!canManage} maxLength={2000} /></Field>
          {canManage && <div className="flex justify-end sm:col-span-2"><Button type="submit" disabled={!dirty || !form.title.trim()} loading={busy("save")}>Save changes</Button></div>}
        </form>

        {(task.contact || task.opportunity || task.company) && (
          <div className="space-y-1 rounded-2xl border border-line p-3 text-[13px]">
            <p className="text-[12px] font-medium text-muted">Linked to</p>
            {task.contact && <Link href={`${scope.base}/contacts/${task.contact.id}`} className="block font-medium text-primary hover:underline">{task.contact.name}</Link>}
            {task.opportunity && <Link href={`${scope.base}/opportunities/${task.opportunity.id}`} className="block font-medium text-primary hover:underline">{task.opportunity.name}</Link>}
            {task.company && <Link href={`${scope.base}/companies/${task.company.id}`} className="block font-medium text-primary hover:underline">{task.company.name}</Link>}
          </div>
        )}

        <section>
          <h3 className="text-[13px] font-semibold text-ink">Comments</h3>
          <ul className="mt-2 space-y-2">
            {comments === null && <li className="text-[13px] text-muted">Loading…</li>}
            {comments?.map((c) => (
              <li key={c.id} className={cn("rounded-xl px-3 py-2 text-[13px]", c.mine ? "bg-primary-soft/50" : "bg-surface-2")}>
                <p className="whitespace-pre-wrap text-ink">{c.body}</p>
                <p className="mt-1 text-[11.5px] text-muted">{c.author ?? "Teammate"} · <RelativeTime iso={c.createdAt} timezone={scope.timezone} /></p>
              </li>
            ))}
            {comments?.length === 0 && <li className="text-[13px] text-muted">No comments yet.</li>}
          </ul>
          {canManage && (
            <form className="mt-2 flex gap-2" onSubmit={async (e) => {
              e.preventDefault();
              if (await run("comment", () => addTaskCommentAction(scope.orgId, task.id, comment))) {
                setComment("");
                setCommentsVersion((v) => v + 1);
              }
            }}>
              <label htmlFor="ts-comment" className="sr-only">Add a comment</label>
              <Input id="ts-comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" maxLength={2000} />
              <Button type="submit" variant="secondary" disabled={!comment.trim()} loading={busy("comment")}>Post</Button>
            </form>
          )}
        </section>
      </div>
    </Sheet>
  );
}
