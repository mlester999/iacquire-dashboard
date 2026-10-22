"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Bot, Building2, CalendarDays, CheckSquare, ExternalLink, Handshake, Lock, NotebookPen, PhoneCall, Plus, RotateCcw, StickyNote, TriangleAlert, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Input, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { addContactNoteFromConversationAction, createDealFromConversationAction, createTaskFromConversationAction, setLeadStatusAction } from "@/app/actions/inbox";
import { employeeShortName } from "@/components/inbox/inbox-list-panel";
import { InboxMissedCallCard, InboxPriorityCard } from "@/components/inbox/priority-panel";
import { LEAD_STATUSES } from "@/lib/crm/types";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";
import type { InboxCrmContext, Section } from "@/server/messaging/inbox-context";

type State = { kind: "loading" } | { kind: "ready"; data: InboxCrmContext } | { kind: "error"; message: string };

/** Reads the CRM side of the conversation. Re-reads whenever `version` changes (a new revision of the conversation), keeping what is shown meanwhile. */
function useCrmContext(conversationId: string, version: number) {
  const [state, setState] = React.useState<State>({ kind: "loading" });
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/inbox/conversations/${conversationId}/context`, { cache: "no-store", credentials: "same-origin", signal: ac.signal });
        const body = await res.json().catch(() => null);
        if (ac.signal.aborted) return;
        if (!res.ok || !body) setState((s) => (s.kind === "ready" ? s : { kind: "error", message: body?.error ?? "The customer details couldn't be loaded." }));
        else setState({ kind: "ready", data: body as InboxCrmContext });
      } catch {
        if (!ac.signal.aborted) setState((s) => (s.kind === "ready" ? s : { kind: "error", message: "The customer details couldn't be loaded." }));
      }
    })();
    return () => ac.abort();
  }, [conversationId, version, nonce]);
  return { state, reload: () => setNonce((n) => n + 1) };
}

function Card({ title, icon: Icon, action, children }: { title: string; icon: React.ComponentType<{ className?: string }>; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold"><Icon className="size-4 text-muted" aria-hidden />{title}</h2>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function SectionBody<T>({ section, empty, render }: { section: Section<T>; empty: string; render: (items: T[]) => React.ReactNode }) {
  if (section.state === "no_access") return <p className="flex items-center gap-1.5 text-[12.5px] text-muted"><Lock className="size-3.5 shrink-0" aria-hidden />Your role can&apos;t see this.</p>;
  if (section.state === "error") return <p className="flex items-center gap-1.5 text-[12.5px] text-warning-ink"><TriangleAlert className="size-3.5 shrink-0" aria-hidden />This couldn&apos;t be loaded.</p>;
  if (!section.items.length) return <p className="text-[12.5px] text-muted">{empty}</p>;
  return <>{render(section.items)}</>;
}

const money = (value: number | null, currency: string) => (value === null ? null : new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(value));

export function CrmContextPanel({ conversationId, version, timeZone, onChanged }: { conversationId: string; version: number; timeZone: string; onChanged: () => void }) {
  const { state, reload } = useCrmContext(conversationId, version);
  if (state.kind === "loading") {
    return (
      <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading customer details">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2 rounded-2xl border border-line bg-surface p-4"><Skeleton className="h-3.5 w-1/3" /><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-3/5" /></div>
        ))}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div role="alert" className="rounded-2xl border border-danger/30 bg-danger-soft/50 p-4 text-[13px] text-danger-ink">
        <p className="font-medium">{state.message}</p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={reload}><RotateCcw className="size-3.5" aria-hidden />Try again</Button>
      </div>
    );
  }
  const d = state.data;
  const changed = () => {
    reload();
    onChanged();
  };
  return (
    <div className="space-y-4">
      <ContactCard d={d} conversationId={conversationId} onChanged={changed} />
      {d.missedCall && <InboxMissedCallCard view={d.missedCall} timeZone={timeZone} />}
      {d.priority && <InboxPriorityCard view={d.priority} contactHref={d.links.contact} timeZone={timeZone} />}
      <QuickActions d={d} conversationId={conversationId} onChanged={changed} />
      <Card title="Deals" icon={Handshake} action={<Link href={d.links.deals} className="inline-flex items-center gap-1 text-[12px] text-primary">Pipeline<ExternalLink className="size-3" aria-hidden /></Link>}>
        <SectionBody section={d.deals} empty="No deals for this customer yet." render={(items) => (
          <ul className="space-y-2 text-[12.5px]">
            {items.map((o) => (
              <li key={o.id}>
                <Link href={`/crm/opportunities/${o.id}`} className="block rounded-lg hover:bg-surface-2">
                  <span className="flex items-center justify-between gap-2"><span className="truncate font-medium">{o.name}</span>{money(o.value, o.currency) && <span className="shrink-0 tabular-nums">{money(o.value, o.currency)}</span>}</span>
                  <span className="text-muted">{o.pipeline} · {o.stage}{o.status !== "open" ? ` · ${sentenceCase(o.status)}` : ""}</span>
                </Link>
              </li>
            ))}
          </ul>
        )} />
      </Card>
      <Card title="Tasks" icon={CheckSquare} action={<Link href={d.links.tasks} className="inline-flex items-center gap-1 text-[12px] text-primary">All tasks<ExternalLink className="size-3" aria-hidden /></Link>}>
        <SectionBody section={d.tasks} empty="No open tasks." render={(items) => (
          <ul className="space-y-1.5 text-[12.5px]">
            {items.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0"><span className="block truncate font-medium">{t.title}</span><span className="text-muted">{t.assignee ?? "Unassigned"}{t.dueAt ? ` · due ${formatDateTime(t.dueAt, timeZone)}` : ""}</span></span>
                {t.overdue ? <Badge tone="danger">Overdue</Badge> : t.priority === "urgent" || t.priority === "high" ? <Badge tone="warning">{sentenceCase(t.priority)}</Badge> : null}
              </li>
            ))}
          </ul>
        )} />
      </Card>
      <Card title="Appointments" icon={CalendarDays} action={<Link href={d.links.appointments} className="inline-flex items-center gap-1 text-[12px] text-primary">Calendar<ExternalLink className="size-3" aria-hidden /></Link>}>
        <SectionBody section={d.appointments} empty="No appointments." render={(items) => (
          <ul className="space-y-1.5 text-[12.5px]">
            {items.slice(0, 5).map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0"><span className="block truncate font-medium">{a.title}</span><span className="text-muted" suppressHydrationWarning>{formatDateTime(a.startAt, timeZone)}</span></span>
                <Badge tone={a.status === "cancelled" ? "outline" : new Date(a.startAt) > new Date() ? "primary" : "neutral"}>{sentenceCase(a.status)}</Badge>
              </li>
            ))}
          </ul>
        )} />
      </Card>
      <Card title="Calls" icon={PhoneCall} action={<Link href={d.links.calls} className="inline-flex items-center gap-1 text-[12px] text-primary">All calls<ExternalLink className="size-3" aria-hidden /></Link>}>
        <SectionBody section={d.calls} empty="No calls from this customer." render={(items) => (
          <ul className="space-y-2 text-[12.5px]">
            {items.slice(0, 4).map((c) => (
              <li key={c.id}>
                <span className="flex items-center justify-between gap-2"><span className="font-medium">{c.direction === "inbound" ? "Incoming" : "Outgoing"} · {sentenceCase(c.status.replace(/_/g, " "))}</span><span className="text-faint" suppressHydrationWarning>{c.startedAt ? relativeTime(c.startedAt) : ""}</span></span>
                {c.summary && <span className="mt-0.5 line-clamp-2 block text-muted">{c.summary}</span>}
                {(c.hasRecording || c.hasTranscript) && <span className="text-[11.5px] text-faint">{c.hasTranscript ? "Transcript" : "Recording"} on the call record</span>}
              </li>
            ))}
          </ul>
        )} />
      </Card>
      <Card title="Notes" icon={NotebookPen}>
        <SectionBody section={d.notes} empty="No notes on this customer." render={(items) => (
          <ul className="space-y-2 text-[12.5px]">
            {items.slice(0, 4).map((n) => (
              <li key={n.id} className="rounded-lg bg-surface-2 p-2"><p className="line-clamp-4 whitespace-pre-wrap">{n.body}</p><p className="mt-1 text-[11px] text-faint" suppressHydrationWarning>{n.authorName ?? "Teammate"} · {relativeTime(n.createdAt)}{n.pinned ? " · pinned" : ""}</p></li>
            ))}
          </ul>
        )} />
      </Card>
      <Card title="Other conversations" icon={Users}>
        <SectionBody section={d.otherConversations} empty="This is their only conversation." render={(items) => (
          <ul className="space-y-1.5 text-[12.5px]">
            {items.map((c) => (
              <li key={c.id}>
                <Link href={`/inbox?conversation=${c.id}`} className="block rounded-lg hover:bg-surface-2">
                  <span className="font-medium">{CHANNEL_LABELS[c.channel as Channel] ?? c.channel}</span>
                  <span className="text-muted"> · {c.status === "closed" ? "Resolved" : "Open"}{c.lastMessageAt ? ` · ${relativeTime(c.lastMessageAt)}` : ""}</span>
                  {c.preview && <span className="line-clamp-1 block text-muted">{c.preview}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )} />
      </Card>
      <Card title="AI employee activity" icon={Bot}>
        <dl className="space-y-1.5 text-[12.5px]">
          <div className="flex justify-between gap-2"><dt className="text-muted">Employees involved</dt><dd className="text-right">{d.ai.employees.length ? d.ai.employees.map((e) => employeeShortName(e)).join(", ") : "None"}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-muted">Messages the AI sent</dt><dd>{d.ai.aiMessages}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-muted">Drafts waiting for approval</dt><dd>{d.ai.draftsWaiting}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-muted">Asked for a person</dt><dd>{d.ai.handoffs}</dd></div>
          {d.ai.lastAiMessageAt && <div className="flex justify-between gap-2"><dt className="text-muted">Last AI message</dt><dd suppressHydrationWarning>{relativeTime(d.ai.lastAiMessageAt)}</dd></div>}
        </dl>
        <p className="mt-2 text-[11.5px] text-muted">Counted from the conversation&apos;s own record.</p>
      </Card>
    </div>
  );
}

function ContactCard({ d, conversationId, onChanged }: { d: InboxCrmContext; conversationId: string; onChanged: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const c = d.contact;
  if (!c) {
    return (
      <Card title="Customer record" icon={Users}>
        <p className="flex items-center gap-1.5 text-[12.5px] text-muted"><Lock className="size-3.5 shrink-0" aria-hidden />Your role can&apos;t open the customer&apos;s CRM record.</p>
      </Card>
    );
  }
  return (
    <Card title="Customer record" icon={Users} action={<Link href={d.links.contact} className="inline-flex items-center gap-1 text-[12px] text-primary">Open in CRM<ExternalLink className="size-3" aria-hidden /></Link>}>
      <dl className="space-y-1.5 text-[12.5px]">
        <div className="flex justify-between gap-2"><dt className="text-muted">Lead status</dt>
          <dd>
            {d.can.leadStatus ? (
              <>
                <label className="sr-only" htmlFor="lead-status">Lead status</label>
                <Select id="lead-status" value={c.leadStatus} disabled={busy} onChange={async (e) => {
                  setBusy(true);
                  const r = await setLeadStatusAction(conversationId, e.target.value);
                  setBusy(false);
                  if (!r.ok) toast.error(r.error ?? "That didn't work.");
                  else { toast.success("Lead status updated."); onChanged(); }
                }}>
                  {LEAD_STATUSES.map((s) => <option key={s} value={s}>{sentenceCase(s)}</option>)}
                </Select>
              </>
            ) : <Badge>{sentenceCase(c.leadStatus)}</Badge>}
          </dd>
        </div>
        {c.leadScore !== null && <div className="flex justify-between gap-2"><dt className="text-muted">Lead score</dt><dd>{c.leadScore}</dd></div>}
        <div className="flex justify-between gap-2"><dt className="text-muted">Owner</dt><dd>{c.owner?.name ?? "Unassigned"}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-muted">Source</dt><dd>{sentenceCase(c.source)}</dd></div>
        {c.timezone && <div className="flex justify-between gap-2"><dt className="text-muted">Time zone</dt><dd>{c.timezone}</dd></div>}
        {c.preferredChannel && <div className="flex justify-between gap-2"><dt className="text-muted">Prefers</dt><dd>{sentenceCase(c.preferredChannel)}</dd></div>}
      </dl>
      {c.companies.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px]"><Building2 className="size-3.5 text-muted" aria-hidden />{c.companies.map((co) => <Link key={co.id} href={`/crm/companies/${co.id}`} className="text-primary hover:underline">{co.name}{co.title ? ` (${co.title})` : ""}</Link>)}</p>
      )}
      {c.tags.length > 0 && <p className="mt-2 flex flex-wrap gap-1.5">{c.tags.map((t) => <Badge key={t.id} tone="outline">{t.name}</Badge>)}</p>}
      {d.possibleDuplicates.length > 0 && (
        <p className="mt-3 rounded-lg bg-warning-soft p-2 text-[12px] text-warning-ink">
          Another record has the same name: {d.possibleDuplicates.map((p, i) => <React.Fragment key={p.id}>{i > 0 ? ", " : ""}<Link href={`/crm/contacts/${p.id}`} className="underline">{p.name}</Link></React.Fragment>)}. They are not merged. Check before combining them in the CRM.
        </p>
      )}
    </Card>
  );
}

function QuickActions({ d, conversationId, onChanged }: { d: InboxCrmContext; conversationId: string; onChanged: () => void }) {
  const [taskOpen, setTaskOpen] = React.useState(false);
  const [noteOpen, setNoteOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [due, setDue] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  if (!d.contact || (!d.can.task && !d.can.deal && !d.can.note)) return null;
  async function go(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error ?? "That didn't work.");
      return false;
    }
    toast.success(ok);
    onChanged();
    return true;
  }
  return (
    <section aria-label="Quick actions" className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-[13px] font-semibold">Quick actions</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {d.can.task && (
          <Popover open={taskOpen} onOpenChange={setTaskOpen}>
            <PopoverTrigger asChild><Button size="sm" variant="secondary"><Plus className="size-3.5" aria-hidden />Task</Button></PopoverTrigger>
            <PopoverContent align="start" className="w-[min(320px,calc(100vw-32px))] space-y-2 p-3">
              <label className="text-[12.5px] font-medium" htmlFor="qa-task-title">Task for this customer</label>
              <Input id="qa-task-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Send the quote" />
              <label className="text-[12.5px] font-medium" htmlFor="qa-task-due">Due (optional)</label>
              <Input id="qa-task-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setTaskOpen(false)}>Cancel</Button>
                <Button size="sm" variant="brand" disabled={!title.trim()} loading={busy === "task"} onClick={async () => { if (await go("task", () => createTaskFromConversationAction(conversationId, { title, dueAt: due ? new Date(due).toISOString() : null }), "Task created.")) { setTitle(""); setDue(""); setTaskOpen(false); } }}>Create task</Button>
              </div>
            </PopoverContent>
          </Popover>
        )}
        {d.can.deal && <Button size="sm" variant="secondary" loading={busy === "deal"} onClick={() => go("deal", () => createDealFromConversationAction(conversationId, {}), "Deal created (or opened, if one already exists for this conversation).")}><Handshake className="size-3.5" aria-hidden />Deal</Button>}
        {d.can.note && (
          <Popover open={noteOpen} onOpenChange={setNoteOpen}>
            <PopoverTrigger asChild><Button size="sm" variant="secondary"><StickyNote className="size-3.5" aria-hidden />CRM note</Button></PopoverTrigger>
            <PopoverContent align="start" className="w-[min(320px,calc(100vw-32px))] space-y-2 p-3">
              <label className="text-[12.5px] font-medium" htmlFor="qa-note">Note on the customer&apos;s record</label>
              <Textarea id="qa-note" rows={3} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} placeholder="Saved to the CRM record. Your team sees it everywhere the record appears." />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setNoteOpen(false)}>Cancel</Button>
                <Button size="sm" variant="brand" disabled={!note.trim()} loading={busy === "note"} onClick={async () => { if (await go("note", () => addContactNoteFromConversationAction(conversationId, note), "Note saved to the record.")) { setNote(""); setNoteOpen(false); } }}>Save note</Button>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
      <p className="mt-2 text-[11.5px] text-muted">These use your CRM permissions and appear on the customer&apos;s timeline.</p>
    </section>
  );
}
