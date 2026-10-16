"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Calendar, Check, CircleDollarSign, Download, FileText, FolderOpen, Lock, Plus, Receipt, Send, Trash2, MessageSquare, Flag, ClipboardCheck, UserRound, Clock, ListChecks, Megaphone, Paperclip, Inbox } from "lucide-react";
import { MetricCard } from "@/components/ui/workspace";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { bytesLabel, useRunner } from "@/components/projects/common";
import {
  agencyMessageAction, assignAction, completeTaskAction, deleteMilestoneAction, handoverAction, milestoneStatusAction, progressUpdateAction, saveMilestoneAction,
  saveNotesAction, saveQuoteAction, sendQuoteAction, setStatusAction, withdrawQuoteAction,
} from "@/app/(admin)/admin/projects/actions";
import { PROJECT_STATUS_TONE, MILESTONE_LABEL, MILESTONE_STATUSES, PROJECT_STATUS_LABEL, QUOTE_STATUS_LABEL, STATUS_TRANSITIONS, formatMoney, type MilestoneStatus, type ProjectStatus } from "@/lib/projects";
import type { AgencyProjectDetail } from "@/server/projects/agency";
import type { QuoteView } from "@/server/projects/shared";
import { cn, formatDate, formatDateTime, relativeTime } from "@/lib/utils";

function SectionTitle({ icon, children, tone = "primary" }: { icon: React.ReactNode; children: React.ReactNode; tone?: "primary" | "warning" | "violet" | "success" | "neutral" }) {
  const t = { primary: "bg-primary-soft text-primary", warning: "bg-warning-soft text-warning-ink", violet: "bg-violet-soft text-violet-ink", success: "bg-success-soft text-success-ink", neutral: "bg-surface-2 text-ink-2" }[tone];
  return (
    <CardTitle className="flex items-center gap-2.5">
      <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-[10px] ring-1 ring-inset ring-line [&>svg]:size-4", t)}>{icon}</span>
      {children}
    </CardTitle>
  );
}

const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
const toLines = (v: string[]) => v.join("\n");
const toCents = (v: string) => {
  const n = Number.parseFloat(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const fromCents = (c: number | null) => (c === null || c === 0 ? "" : String(c / 100));

export function AdminProjectWorkspace({ project: p, currentUserId }: { project: AgencyProjectDetail; currentUserId: string }) {
  const r = p.request;
  const closed = r.status === "cancelled" || r.status === "completed";
  return (
    <div className="space-y-5">
      <HeaderCard project={p} currentUserId={currentUserId} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><MetricCard label="Delivery milestones" value={p.milestones.length?`${p.milestones.filter(m=>m.status==="completed").length}/${p.milestones.length}`:"Not set"} detail="Completed against agreed scope" tone="green" icon={<Flag className="size-4"/>}/><MetricCard label="Conversation" value={p.messages.length} detail="Client and internal messages" tone="blue" icon={<MessageSquare className="size-4"/>}/><MetricCard label="Agency tasks" value={p.tasks.length} detail="Outstanding work for this request" tone="amber" icon={<ClipboardCheck className="size-4"/>}/><MetricCard label="Assigned owner" value={<span className="text-lg">{p.assignedTo?.name??"Unassigned"}</span>} detail={p.orgName} tone="neutral" icon={<UserRound className="size-4"/>}/></div>
      <nav aria-label="Project workspace sections" className="scrollbar-thin flex gap-1 overflow-x-auto rounded-2xl border border-line bg-surface p-1.5 shadow-soft">{[{id:"conversation",label:"Conversation",icon:MessageSquare},{id:"quote",label:"Quote builder",icon:Receipt},{id:"milestones",label:"Milestones",icon:Flag},{id:"updates",label:"Progress updates",icon:Megaphone}].map(s=><a key={s.id} href={`#agency-project-${s.id}`} className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl px-3.5 text-[13px] font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink [&>svg]:size-3.5 [&>svg]:text-muted"><s.icon />{s.label}</a>)}</nav>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          <div id="agency-project-conversation" className="scroll-mt-24"><Conversation project={p} closed={closed}/></div>
          <div id="agency-project-quote" className="scroll-mt-24"><QuoteBuilder project={p}/></div>
          <div id="agency-project-milestones" className="scroll-mt-24"><MilestonesEditor project={p} closed={closed}/></div>
          <div id="agency-project-updates" className="scroll-mt-24"><UpdatesPanel project={p} closed={closed}/></div>
          {r.status === "ready_for_review" && <HandoverCard project={p} />}
        </div>
        <aside className="min-w-0 space-y-5">
          {p.tasks.length > 0 && <TasksCard project={p} />}
          <RequestInfo project={p} />
          <NotesCard project={p} />
          <FilesPanel project={p} closed={closed} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function HeaderCard({ project: p, currentUserId }: { project: AgencyProjectDetail; currentUserId: string }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const r = p.request;
  const allowed = STATUS_TRANSITIONS[r.status].filter((s) => s !== "completed");
  const [next, setNext] = React.useState<ProjectStatus | "">("");
  const [reason, setReason] = React.useState("");
  const needsReason = next === "cancelled" || next === "on_hold";
  async function apply(change: { status?: ProjectStatus; resume?: boolean }) {
    const ok = await run("status", () => setStatusAction(r.id, { ...change, reason }), "Status updated");
    if (ok !== null) {
      setNext("");
      setReason("");
      router.refresh();
    }
  }
  return (
    <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-br from-primary-soft/55 via-surface to-surface">
      <CardContent className="grid gap-5 pt-5 lg:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-muted ring-1 ring-inset ring-line">{r.ref}</span>
            <StatusPill tone={PROJECT_STATUS_TONE[r.status]}>{PROJECT_STATUS_LABEL[r.status]}</StatusPill>
            {r.serviceName && <InfoChip>{r.serviceName}</InfoChip>}
          </div>
          <h1 className="mt-2 text-[24px] font-semibold leading-tight tracking-[-0.02em]">{r.title}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Link href={`/admin/clients/${r.orgId}`} className="inline-flex h-7 items-center gap-2 rounded-lg bg-surface pl-1 pr-2.5 text-[12px] font-medium text-primary-ink ring-1 ring-inset ring-line hover:bg-primary-soft">
              <AvatarTile name={p.orgName} size="sm" className="!size-5 !rounded-md !text-[8.5px]" />
              {p.orgName}
            </Link>
            {p.createdByName && <InfoChip icon={<UserRound />}>Requested by {p.createdByName}</InfoChip>}
            <InfoChip icon={<Calendar />}>{formatDate(r.submittedAt)}</InfoChip>
            <InfoChip icon={<Clock />}>Active {relativeTime(r.lastActivityAt)}</InfoChip>
            {p.delivery && (
              <InfoChip icon={<CircleDollarSign />} className="tabular-nums">
                Agreed {formatMoney(p.delivery.agreedPriceCents, p.delivery.currency)}
                {p.delivery.ongoingMonthlyCents ? ` + ${formatMoney(p.delivery.ongoingMonthlyCents, p.delivery.currency)}/month` : ""}
              </InfoChip>
            )}
          </div>
        </div>
        <div className="grid min-w-0 gap-3 rounded-xl border border-line bg-surface/90 p-3 lg:min-w-[280px]">
          <Field label="Assigned to" htmlFor="assignee">
            <Select
              id="assignee"
              value={p.assignedTo?.id ?? ""}
              onChange={async (e) => {
                const ok = await run("assign", () => assignAction(r.id, e.target.value || null), "Assignment saved");
                if (ok !== null) router.refresh();
              }}
            >
              <option value="">Unassigned</option>
              {p.assignable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.id === currentUserId ? " (you)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          {r.status === "on_hold" ? (
            <Button variant="brand" loading={isPending("status")} onClick={() => void apply({ resume: true })}>
              Resume project
            </Button>
          ) : allowed.length > 0 ? (
            <div className="space-y-2">
              <Field label="Move to" htmlFor="next-status">
                <Select id="next-status" value={next} onChange={(e) => setNext(e.target.value as ProjectStatus | "")}>
                  <option value="">Choose a status…</option>
                  {allowed.map((s) => (
                    <option key={s} value={s}>
                      {PROJECT_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              {needsReason && <Input aria-label="Reason" placeholder={next === "cancelled" ? "Reason for cancelling (required)" : "Why is it on hold? (shown to the client)"} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
              <Button variant="secondary" size="sm" disabled={!next || (next === "cancelled" && reason.trim().length < 3)} loading={isPending("status")} onClick={() => next && void apply({ status: next })}>
                Update status
              </Button>
            </div>
          ) : (
            <p className="text-[12.5px] text-muted">This project is closed.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function TasksCard({ project: p }: { project: AgencyProjectDetail }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  return (
    <Card className="border-warning/30">
      <CardHeader>
        <SectionTitle icon={<ListChecks />} tone="warning">To do</SectionTitle>
        <StatusPill tone="warning" size="sm">{p.tasks.length} open</StatusPill>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {p.tasks.map((t) => (
            <li key={t.id} className="flex items-start gap-2 rounded-xl bg-warning-soft/50 p-3 text-[13px]">
              <span className="min-w-0 flex-1">
                {t.title}
                <span className="block text-[11.5px] text-muted">{t.dueAt ? `Due ${formatDate(t.dueAt)}` : "No due date"}</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                loading={isPending(t.id)}
                onClick={async () => {
                  const ok = await run(t.id, () => completeTaskAction(p.request.id, t.id));
                  if (ok !== null) router.refresh();
                }}
              >
                <Check className="size-3.5" /> Done
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RequestInfo({ project: p }: { project: AgencyProjectDetail }) {
  const r = p.request;
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Inbox />}>What the client asked for</SectionTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="space-y-3">
          {p.requirements
            .filter((x) => x.answer)
            .map((x) => (
              <div key={x.key}>
                <dt className="text-[11.5px] font-medium text-muted">{x.label}</dt>
                <dd className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{/^\d{4}-\d{2}-\d{2}$/.test(x.answer ?? "") ? formatDate(x.answer as string) : x.answer}</dd>
              </div>
            ))}
        </dl>
        {p.suggestedServices.length > 0 && (
          <div className="border-t border-line pt-3">
            <p className="text-[11.5px] font-medium text-muted">Matching published services</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {p.suggestedServices.map((s) => (
                <Badge key={s.id} tone="outline">
                  {s.name}
                </Badge>
              ))}
            </div>
            <p className="mt-1.5 text-[11.5px] text-faint">Keyword matches only. Review fit before quoting.</p>
          </div>
        )}
        {(r.budgetRange || r.preferredDeadline) && (
          <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
            {r.budgetRange && <InfoChip icon={<CircleDollarSign />}>Budget {r.budgetRange}</InfoChip>}
            {r.preferredDeadline && <InfoChip icon={<Calendar />}>Deadline {formatDate(r.preferredDeadline)}</InfoChip>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NotesCard({ project: p }: { project: AgencyProjectDetail }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [notes, setNotes] = React.useState(p.internalNotes ?? "");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="size-4 text-muted" /> Internal notes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Textarea aria-label="Internal notes" rows={5} value={notes} maxLength={8000} placeholder="Only the agency can see this." onChange={(e) => setNotes(e.target.value)} />
        <Button
          size="sm"
          variant="secondary"
          loading={isPending("notes")}
          disabled={notes === (p.internalNotes ?? "")}
          onClick={async () => {
            const ok = await run("notes", () => saveNotesAction(p.request.id, notes), "Notes saved");
            if (ok !== null) router.refresh();
          }}
        >
          Save notes
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Conversation({ project: p, closed }: { project: AgencyProjectDetail; closed: boolean }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [mode, setMode] = React.useState<"message" | "internal" | "info">("message");
  const [body, setBody] = React.useState("");
  async function send() {
    const ok = await run("msg", () => agencyMessageAction(p.request.id, body, { internal: mode === "internal", infoRequest: mode === "info" }), mode === "internal" ? "Internal note saved" : "Sent to the client");
    if (ok !== null) {
      setBody("");
      router.refresh();
    }
  }
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<MessageSquare />}>Conversation</SectionTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {p.messages.length === 0 ? (
          <EmptyState compact icon={<MessageSquare className="size-5" />} title="No messages yet" description="Replies to the client and internal notes will appear here." />
        ) : (
          <ul className="space-y-3">
            {p.messages.map((m) => (
              <li key={m.id} className={cn("max-w-[92%] rounded-2xl px-4 py-3 text-[13.5px] leading-relaxed", m.internal ? "border border-dashed border-warning/50 bg-warning-soft/40" : m.authorKind === "client" ? "bg-primary-soft text-primary-ink" : "ml-auto bg-surface-2 text-ink-2")}>
                {m.internal && (
                  <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[.08em] text-warning-ink">
                    <Lock className="size-3" /> Internal note
                  </p>
                )}
                {m.kind === "info_request" && <p className="mb-1 text-[11px] font-semibold uppercase tracking-[.08em] text-warning-ink">Information requested</p>}
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className="mt-1.5 text-[11.5px]">
                  {m.authorKind === "client" ? (m.authorName ?? "Client") : m.authorKind === "system" ? "System" : (m.authorName ?? "iAcquire")} · {formatDateTime(m.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
        {!closed && (
          <div className="space-y-2 border-t border-line pt-4">
            <div role="radiogroup" aria-label="Message type" className="flex flex-wrap gap-1.5 text-[12.5px]">
              {(
                [
                  ["message", "Reply to client"],
                  ["info", "Request information"],
                  ["internal", "Internal note"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)} className={cn("rounded-full border px-3 py-1 font-medium transition", mode === k ? "border-primary bg-primary-soft text-primary-ink" : "border-line text-muted hover:text-ink")}>
                  {label}
                </button>
              ))}
            </div>
            <Textarea aria-label="Message" rows={3} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} placeholder={mode === "internal" ? "Visible to the agency only." : mode === "info" ? "What do you need from the client? Moves the project to Discovery Needed." : "Your reply is shown to the client and they're notified."} />
            <div className="flex justify-end">
              <Button size="sm" variant="brand" loading={isPending("msg")} disabled={!body.trim()} onClick={() => void send()}>
                <Send className="size-3.5" /> {mode === "internal" ? "Save note" : "Send"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

const BLOCKING: ProjectStatus[] = ["approved", "in_development", "testing", "ready_for_review", "completed", "cancelled"];

function QuoteBuilder({ project: p }: { project: AgencyProjectDetail }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const draft = p.quotes.find((q) => q.status === "draft") ?? null;
  const last = p.quotes[0] ?? null;
  const locked = BLOCKING.includes(p.request.status);
  const [editing, setEditing] = React.useState(false);
  const seed = draft ?? last;
  const [f, setF] = React.useState(() => ({
    projectName: seed?.projectName ?? p.request.title,
    scope: seed?.scope ?? "",
    deliverables: toLines(seed?.deliverables ?? []),
    integrations: toLines(seed?.includedIntegrations ?? []),
    exclusions: toLines(seed?.exclusions ?? []),
    timelineText: seed?.timelineText ?? "",
    weeksMin: seed?.estimatedWeeksMin ? String(seed.estimatedWeeksMin) : "",
    weeksMax: seed?.estimatedWeeksMax ? String(seed.estimatedWeeksMax) : "",
    oneTime: fromCents(seed?.oneTimeCents ?? 0),
    ongoing: fromCents(seed?.ongoingMonthlyCents ?? null),
    ongoingDescription: seed?.ongoingDescription ?? "",
    revisionTerms: seed?.revisionTerms ?? "",
    paymentTerms: seed?.paymentTerms ?? "",
    warrantyTerms: seed?.warrantyTerms ?? "",
    validUntil: seed?.validUntil ?? "",
    internalNotes: draft ? (p.quoteInternalNotes[draft.id] ?? "") : "",
  }));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const payload = () => ({
    ...(draft ? { id: draft.id } : {}),
    projectName: f.projectName,
    scope: f.scope,
    deliverables: lines(f.deliverables),
    includedIntegrations: lines(f.integrations),
    exclusions: lines(f.exclusions),
    timelineText: f.timelineText,
    estimatedWeeksMin: f.weeksMin ? Number(f.weeksMin) : null,
    estimatedWeeksMax: f.weeksMax ? Number(f.weeksMax) : null,
    oneTimeCents: toCents(f.oneTime),
    ongoingMonthlyCents: f.ongoing ? toCents(f.ongoing) : null,
    ongoingDescription: f.ongoingDescription || null,
    revisionTerms: f.revisionTerms,
    paymentTerms: f.paymentTerms,
    warrantyTerms: f.warrantyTerms,
    validUntil: f.validUntil || null,
    internalNotes: f.internalNotes || null,
  });
  async function save(andSend: boolean) {
    const saved = await run(andSend ? "send" : "save", () => saveQuoteAction(p.request.id, payload()), andSend ? undefined : "Draft saved");
    if (!saved) return;
    if (andSend) {
      const ok = await run("send", () => sendQuoteAction(p.request.id, saved.id), "Quote sent to the client");
      if (ok === null) {
        router.refresh();
        return;
      }
    }
    setEditing(false);
    router.refresh();
  }
  const live = p.quotes.find((q) => q.status === "sent");
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Receipt />} tone="violet">Quote</SectionTitle>
        {!locked && !editing && !draft && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            <Plus className="size-3.5" /> {last ? `New version (v${last.version + 1})` : "Prepare a quote"}
          </Button>
        )}
        {!locked && !editing && draft && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Edit draft v{draft.version}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {p.quotes.length === 0 && !editing && <EmptyState compact icon={<Receipt className="size-5" />} title="No quote yet" description="Only agency staff can set pricing; the client sees a quote only after you send it." />}
        {locked && <p className="text-[12.5px] text-muted">A quote can&apos;t be added now that the project is {PROJECT_STATUS_LABEL[p.request.status].toLowerCase()}.</p>}
        {p.quotes.length > 0 && (
          <ul className="space-y-2">
            {p.quotes.map((q) => (
              <QuoteRow key={q.id} q={q} requestId={p.request.id} live={live?.id === q.id} />
            ))}
          </ul>
        )}
        {editing && (
          <div className="space-y-4 rounded-2xl border border-line bg-surface-2/40 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project name" htmlFor="qb-name" className="sm:col-span-2">
                <Input id="qb-name" value={f.projectName} maxLength={160} onChange={set("projectName")} />
              </Field>
              <Field label="Scope of work" htmlFor="qb-scope" className="sm:col-span-2" hint="What will be built, in plain language. Shown to the client.">
                <Textarea id="qb-scope" rows={6} value={f.scope} maxLength={8000} onChange={set("scope")} />
              </Field>
              <Field label="Deliverables" htmlFor="qb-del" hint="One per line.">
                <Textarea id="qb-del" rows={4} value={f.deliverables} onChange={set("deliverables")} />
              </Field>
              <Field label="Included integrations" htmlFor="qb-int" hint="One per line.">
                <Textarea id="qb-int" rows={4} value={f.integrations} onChange={set("integrations")} />
              </Field>
              <Field label="Exclusions" htmlFor="qb-exc" hint="One per line. Be explicit.">
                <Textarea id="qb-exc" rows={4} value={f.exclusions} onChange={set("exclusions")} />
              </Field>
              <div className="space-y-4">
                <Field label="Estimated timeline" htmlFor="qb-time" hint="For example: 3–4 weeks after kickoff.">
                  <Input id="qb-time" value={f.timelineText} maxLength={300} onChange={set("timelineText")} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Weeks (from)" htmlFor="qb-w1" optional>
                    <Input id="qb-w1" type="number" min={1} value={f.weeksMin} onChange={set("weeksMin")} />
                  </Field>
                  <Field label="Weeks (to)" htmlFor="qb-w2" optional>
                    <Input id="qb-w2" type="number" min={1} value={f.weeksMax} onChange={set("weeksMax")} />
                  </Field>
                </div>
              </div>
              <Field label="One-time cost (USD)" htmlFor="qb-price" hint="Visible to the client when you send.">
                <Input id="qb-price" inputMode="decimal" value={f.oneTime} placeholder="0.00" onChange={set("oneTime")} />
              </Field>
              <Field label="Optional ongoing cost (USD / month)" htmlFor="qb-ongoing" optional>
                <Input id="qb-ongoing" inputMode="decimal" value={f.ongoing} onChange={set("ongoing")} />
              </Field>
              <Field label="What the ongoing cost covers" htmlFor="qb-ongd" optional className="sm:col-span-2">
                <Input id="qb-ongd" value={f.ongoingDescription} maxLength={1000} onChange={set("ongoingDescription")} />
              </Field>
              <Field label="Revision terms" htmlFor="qb-rev">
                <Textarea id="qb-rev" rows={3} value={f.revisionTerms} onChange={set("revisionTerms")} />
              </Field>
              <Field label="Payment terms" htmlFor="qb-pay">
                <Textarea id="qb-pay" rows={3} value={f.paymentTerms} onChange={set("paymentTerms")} />
              </Field>
              <Field label="Support or warranty period" htmlFor="qb-war">
                <Textarea id="qb-war" rows={3} value={f.warrantyTerms} onChange={set("warrantyTerms")} />
              </Field>
              <Field label="Valid until" htmlFor="qb-valid" optional>
                <Input id="qb-valid" type="date" value={f.validUntil} onChange={set("validUntil")} />
              </Field>
              <Field label="Internal drafting notes" htmlFor="qb-int-notes" optional className="sm:col-span-2" hint="Agency only. Never shown to the client.">
                <Textarea id="qb-int-notes" rows={2} value={f.internalNotes} onChange={set("internalNotes")} />
              </Field>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button variant="secondary" loading={isPending("save")} onClick={() => void save(false)}>
                Save draft
              </Button>
              <Button variant="brand" loading={isPending("send")} onClick={() => void save(true)}>
                <Send className="size-4" /> Save &amp; send to client
              </Button>
            </div>
            <p className="text-[12px] text-muted">Sending shows the client the price and terms. A sent quote can&apos;t be edited; draft a new version to change it. Acceptance is recorded against the client&apos;s account and the exact terms. It is not an electronic signature.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuoteRow({ q, requestId, live }: { q: QuoteView; requestId: string; live: boolean }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  return (
    <li className="rounded-xl border border-line p-3.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          v{q.version} · {formatMoney(q.oneTimeCents, q.currency)}
          {q.ongoingMonthlyCents ? ` + ${formatMoney(q.ongoingMonthlyCents, q.currency)}/mo` : ""}
        </span>
        <StatusPill tone={q.status === "accepted" ? "success" : q.status === "sent" ? "warning" : q.status === "declined" ? "danger" : "neutral"}>{QUOTE_STATUS_LABEL[q.status] ?? q.status}</StatusPill>
        {q.firstViewedAt && live && <span className="text-[11.5px] text-muted">viewed {relativeTime(q.firstViewedAt)}</span>}
        {(live || q.status === "draft") && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            loading={isPending(q.id)}
            onClick={async () => {
              const ok = await run(q.id, () => withdrawQuoteAction(requestId, q.id), "Quote withdrawn");
              if (ok !== null) router.refresh();
            }}
          >
            <Trash2 className="size-3.5" /> {live ? "Withdraw" : "Discard"}
          </Button>
        )}
      </div>
      {q.decision && (
        <p className="mt-1.5 text-muted">
          {q.decision.decision.replace("_", " ")} · {q.decision.decidedByName ?? "client"} · {formatDateTime(q.decision.decidedAt)}
          {q.decision.note ? ` — “${q.decision.note}”` : ""}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------

function MilestonesEditor({ project: p, closed }: { project: AgencyProjectDetail; closed: boolean }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [dueOn, setDueOn] = React.useState("");
  const [needsApproval, setNeedsApproval] = React.useState(false);
  async function add() {
    const ok = await run("add", () => saveMilestoneAction(p.request.id, { title, description: description || null, dueOn: dueOn || null, requiresClientApproval: needsApproval }), "Milestone added");
    if (ok !== null) {
      setTitle("");
      setDescription("");
      setDueOn("");
      setNeedsApproval(false);
      router.refresh();
    }
  }
  async function setStatus(id: string, status: MilestoneStatus) {
    const ok = await run(id, () => milestoneStatusAction(p.request.id, id, status));
    if (ok !== null) router.refresh();
  }
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Flag />} tone="success">Milestones</SectionTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {p.milestones.length === 0 ? (
          <EmptyState compact icon={<Flag className="size-5" />} title="No milestones yet" description="Add them once the scope is agreed so the client can follow progress." />
        ) : (
          <ul className="space-y-2">
            {p.milestones.map((m) => (
              <li key={m.id} className="flex flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium">{m.title}</p>
                  <p className="text-[12px] text-muted">
                    {m.requiresClientApproval ? "Needs client approval" : "No client approval"}
                    {m.dueOn ? ` · target ${formatDate(m.dueOn)}` : ""}
                    {m.clientApprovedAt ? ` · approved ${formatDate(m.clientApprovedAt)}` : ""}
                  </p>
                  {m.clientNote && <p className="mt-0.5 text-[12px] text-ink-2">Client note: “{m.clientNote}”</p>}
                </div>
                <Select aria-label={`Status of ${m.title}`} className="sm:w-48" value={m.status} disabled={isPending(m.id)} onChange={(e) => void setStatus(m.id, e.target.value as MilestoneStatus)}>
                  {MILESTONE_STATUSES.filter((s) => s !== "awaiting_approval" || m.requiresClientApproval).map((s) => (
                    <option key={s} value={s}>
                      {s === "awaiting_approval" ? "Ask client to approve" : MILESTONE_LABEL[s]}
                    </option>
                  ))}
                </Select>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${m.title}`}
                  onClick={async () => {
                    const ok = await run(`del-${m.id}`, () => deleteMilestoneAction(p.request.id, m.id), "Milestone removed");
                    if (ok !== null) router.refresh();
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {!closed && (
          <div className="grid gap-3 rounded-2xl bg-surface-2/50 p-4 sm:grid-cols-2">
            <Field label="New milestone" htmlFor="ms-title" className="sm:col-span-2">
              <Input id="ms-title" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Voice agent development" />
            </Field>
            <Field label="Description" htmlFor="ms-desc" optional>
              <Input id="ms-desc" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Target date" htmlFor="ms-due" optional>
              <Input id="ms-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-[13px] text-ink-2 sm:col-span-2">
              <input type="checkbox" checked={needsApproval} onChange={(e) => setNeedsApproval(e.target.checked)} /> The client must approve this milestone
            </label>
            <div className="sm:col-span-2">
              <Button size="sm" variant="secondary" loading={isPending("add")} disabled={title.trim().length < 2} onClick={() => void add()}>
                <Plus className="size-3.5" /> Add milestone
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UpdatesPanel({ project: p, closed }: { project: AgencyProjectDetail; closed: boolean }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [body, setBody] = React.useState("");
  const [visible, setVisible] = React.useState(true);
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Megaphone />}>Progress updates</SectionTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!closed && (
          <div className="space-y-2">
            <Textarea aria-label="Progress update" rows={3} value={body} maxLength={4000} placeholder="Share what changed since the last update." onChange={(e) => setBody(e.target.value)} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
                <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Visible to the client
              </label>
              <Button
                size="sm"
                variant="secondary"
                loading={isPending("upd")}
                disabled={!body.trim()}
                onClick={async () => {
                  const ok = await run("upd", () => progressUpdateAction(p.request.id, body, visible ? "client" : "internal"), "Update posted");
                  if (ok !== null) {
                    setBody("");
                    router.refresh();
                  }
                }}
              >
                Post update
              </Button>
            </div>
          </div>
        )}
        <ul className="space-y-3">
          {p.updates.slice(0, 20).map((u) => (
            <li key={u.id} className="flex gap-3">
              <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", u.visibility === "internal" ? "bg-warning" : "bg-primary/60")} />
              <div className="min-w-0">
                <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{u.body}</p>
                <p className="mt-0.5 text-[12px] text-faint">
                  {u.visibility === "internal" ? "Internal · " : ""}
                  {u.authorName ? `${u.authorName} · ` : ""}
                  {formatDateTime(u.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function HandoverCard({ project: p }: { project: AgencyProjectDetail }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [notes, setNotes] = React.useState("");
  return (
    <Card className="border-success/30">
      <CardHeader>
        <SectionTitle icon={<ClipboardCheck />} tone="success">Record completion &amp; handover</SectionTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[13px] text-muted">Completes the project and shows these notes to the client: what was delivered, where it lives, and how to use it. All client-approval milestones must be complete first.</p>
        <Textarea aria-label="Handover notes" rows={5} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
        <Button
          variant="brand"
          loading={isPending("handover")}
          disabled={notes.trim().length < 10}
          onClick={async () => {
            const ok = await run("handover", () => handoverAction(p.request.id, notes), "Project completed");
            if (ok !== null) router.refresh();
          }}
        >
          Complete project
        </Button>
      </CardContent>
    </Card>
  );
}

function FilesPanel({ project: p, closed }: { project: AgencyProjectDetail; closed: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [visibility, setVisibility] = React.useState<"client" | "internal">("client");
  const [kind, setKind] = React.useState<"deliverable" | "reference" | "handover">("deliverable");
  const ref = React.useRef<HTMLInputElement>(null);
  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("visibility", visibility);
      body.set("kind", kind);
      const res = await fetch(`/api/admin/projects/${p.request.id}/files`, { method: "POST", body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "That file couldn't be saved.");
      toast.success("File added");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That file couldn't be saved.");
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Paperclip />} tone="neutral">Files</SectionTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {p.files.length === 0 ? (
          <EmptyState compact icon={<FolderOpen className="size-5" />} title="No files yet" description="Deliverables and shared documents will appear here." />
        ) : (
          <ul className="space-y-2">
            {p.files.map((f) => (
              <li key={f.id}>
                <a href={`/api/projects/files/${f.id}`} className="flex min-w-0 items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px] hover:bg-surface-3">
                  <FileText className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{f.filename}</span>
                    <span className="block text-[11px] text-faint">
                      {f.uploadedByKind === "client" ? "Client" : "Agency"} · {f.kind}
                      {f.visibility === "internal" ? " · internal" : ""} · {bytesLabel(f.sizeBytes)}
                    </span>
                  </span>
                  <Download className="size-3.5 shrink-0 text-muted" />
                </a>
              </li>
            ))}
          </ul>
        )}
        {!closed && (
          <div className="space-y-2 border-t border-line pt-3">
            <div className="grid grid-cols-2 gap-2">
              <Select aria-label="File type" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="deliverable">Deliverable</option>
                <option value="reference">Reference</option>
                <option value="handover">Handover doc</option>
              </Select>
              <Select aria-label="Visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
                <option value="client">Share with client</option>
                <option value="internal">Agency only</option>
              </Select>
            </div>
            <input ref={ref} type="file" aria-label="Upload a file" accept=".pdf,.docx,.png,.jpg,.jpeg,.txt,.md,.csv" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} className="block w-full min-w-0 text-[12px] file:mr-3 file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-2 file:text-ink" />
            <p className="text-[11.5px] text-faint">Up to 10 MB. Stored privately.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
