"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowUpRight, Building2, CalendarClock, CheckCircle2, Flame, GitMerge, History, Link2, Loader2, PencilRuler, RotateCcw, ShieldCheck, Sparkles, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Label, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { Timeline } from "@/components/support/parts";
import {
  adviseAction, assignAction, changePriorityAction, changeStatusAction, classifyChangeAction, clearEscalationAction, escalateAction, linkAction, mergeAction, setFeedbackStageAction, similarAction, summarizeAction,
} from "@/app/actions/support-agency";
import { CHANGE_CLASSIFICATIONS, CHANGE_CLASSIFICATION_LABELS, CHANGE_TARGET_LABELS, type ChangeClassification } from "@/lib/support/change";
import {
  FEEDBACK_STAGES, FEEDBACK_STAGE_LABELS, PRIORITIES, REQUEST_TYPE_LABELS, STATUS_TRANSITIONS, categoryLabel, clientProgressSentence, featureLabel, statusLabelForAgency, CLIENT_URGENCY_LABELS,
  type ClientUrgency, type FeedbackStage, type TicketPriority, type TicketStatus,
} from "@/lib/support/lifecycle";
import { SLA_STATE_LABELS } from "@/lib/support/sla";
import { describeDiagnostics } from "@/lib/support/content";
import { formatDateTime, sentenceCase } from "@/lib/utils";
import { SLA_TONE } from "@/components/admin/support/meta";
import type { AgencyRequestDetail } from "@/server/support/agency";
import type { SimilarRequest } from "@/server/support/duplicates";
import type { EscalationAdvice } from "@/lib/support/suggest";

const DUE_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: undefined, timeStyle: undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <dt className="shrink-0 text-[12.5px] text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[13px] font-medium text-ink">{children}</dd>
    </div>
  );
}

/**
 * The right-hand pane: who owns the request, where it stands against its response target, and everything the team can do to it
 * (status, priority, assignment, escalation, linking), each control enabled only if the person's role allows it. The buttons are
 * convenience: every one of these actions is re-checked on the server, so a disabled control is guidance, not the lock.
 */
export function DetailsPane({ detail, timeZone, meId, onChanged }: { detail: AgencyRequestDetail; timeZone: string; meId: string; onChanged: () => Promise<unknown> }) {
  const t = detail.ticket;
  const caps = detail.caps;
  const [busy, setBusy] = React.useState<string | null>(null);
  const [escalateOpen, setEscalateOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [similar, setSimilar] = React.useState<SimilarRequest[] | { reason: string } | null>(null);
  const [mergeTarget, setMergeTarget] = React.useState<SimilarRequest | null>(null);
  const [summary, setSummary] = React.useState<{ text: string; at: string } | { reason: string } | null>(t.aiSummary);
  const [advice, setAdvice] = React.useState<EscalationAdvice | null>(null);
  const [classification, setClassification] = React.useState<string>(detail.change?.classification ?? "");
  const [classNote, setClassNote] = React.useState(detail.change?.resolutionNote ?? "");
  const finished = t.status === "resolved" || t.status === "closed";
  const canWrite = caps["agency.support.manage"];

  const act = async (key: string, run: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    setBusy(key);
    const res = await run();
    setBusy(null);
    if (!res.ok) { toast.error(res.error ?? "That didn't work. Please try again."); return false; }
    toast.success(success);
    await onChanged();
    return true;
  };

  const allowedStatuses = (STATUS_TRANSITIONS[t.status] as readonly TicketStatus[]).filter((s) => {
    if ((s === "resolved" || s === "closed" || finished) && !caps["agency.support.resolve"]) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={t.status}>{t.requestType === "feedback" && t.feedbackStage ? FEEDBACK_STAGE_LABELS[t.feedbackStage as FeedbackStage].label : statusLabelForAgency(t.status)}</StatusPill>
          <StatusPill status={t.priority}>{sentenceCase(t.priority)} priority</StatusPill>
          {t.escalated && <StatusPill tone="danger" icon={<Flame className="size-3" aria-hidden />}>Escalated</StatusPill>}
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{clientProgressSentence({ status: t.status, type: t.requestType, stage: t.feedbackStage as FeedbackStage | null, assigned: Boolean(t.assignedToId), hasAgencyReply: Boolean(t.firstRespondedAt) })} <span className="text-faint">(what the client reads)</span></p>

        <div className="mt-4 grid gap-3">
          {t.requestType === "feedback" ? (
            <div className="space-y-1.5">
              <Label htmlFor="d-stage">Feedback status</Label>
              <Select id="d-stage" disabled={!canWrite || busy === "stage"} value={t.feedbackStage ?? "received"}
                onChange={(e) => void act("stage", () => setFeedbackStageAction(t.id, e.target.value as FeedbackStage), "Feedback status updated")}>
                {FEEDBACK_STAGES.map((s) => <option key={s} value={s} disabled={(s === "completed" || s === "not_planned") && !caps["agency.support.resolve"]}>{FEEDBACK_STAGE_LABELS[s].label}</option>)}
              </Select>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="d-status">Status</Label>
              <Select id="d-status" disabled={!canWrite || busy === "status"} value={t.status} onChange={(e) => void act("status", () => changeStatusAction(t.id, e.target.value as TicketStatus), "Status updated")}>
                <option value={t.status}>{statusLabelForAgency(t.status)}{t.status === "new" ? " (not yet picked up)" : ""}</option>
                {allowedStatuses.filter((s) => s !== t.status).map((s) => <option key={s} value={s}>{statusLabelForAgency(s)}{finished && s === "open" ? " (reopen)" : ""}</option>)}
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="d-priority">Priority</Label>
            <Select id="d-priority" disabled={!caps["agency.support.priority"] || !canWrite || busy === "priority"} value={t.priority} title={caps["agency.support.priority"] ? undefined : "Your role doesn't allow changing priority"}
              onChange={(e) => void act("priority", () => changePriorityAction(t.id, e.target.value as TicketPriority), "Priority updated")}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{sentenceCase(p)}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-assignee">Assigned to</Label>
            <Select id="d-assignee" disabled={!caps["agency.support.assign"] || !canWrite || busy === "assign"} value={t.assignedToId ?? ""} title={caps["agency.support.assign"] ? undefined : "Your role lets you take a request for yourself, not assign it to others"}
              onChange={(e) => void act("assign", () => assignAction(t.id, e.target.value || null), e.target.value ? "Assigned" : "Unassigned")}>
              <option value="">Unassigned</option>
              {t.assignedToId && !detail.assignable.some((a) => a.id === t.assignedToId) && <option value={t.assignedToId}>{t.assignedToName ?? "Someone"}</option>}
              {detail.assignable.map((a) => <option key={a.id} value={a.id}>{a.name}{a.id === meId ? " (you)" : ""} · {a.openAssigned} open</option>)}
            </Select>
            <p className="text-[12px] text-muted">The number is how many active requests each person already has.</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {canWrite && t.assignedToId !== meId && <Button size="sm" variant="secondary" loading={busy === "me"} onClick={() => void act("me", () => assignAction(t.id, meId), "Assigned to you")}><UserCheck className="size-3.5" aria-hidden /> Assign to me</Button>}
          {canWrite && !finished && caps["agency.support.resolve"] && t.requestType !== "feedback" && <Button size="sm" variant="secondary" loading={busy === "resolve"} onClick={() => void act("resolve", () => changeStatusAction(t.id, "resolved"), "Marked resolved")}><CheckCircle2 className="size-3.5" aria-hidden /> Resolve</Button>}
          {canWrite && finished && caps["agency.support.resolve"] && t.requestType !== "feedback" && <Button size="sm" variant="secondary" loading={busy === "reopen"} onClick={() => void act("reopen", () => changeStatusAction(t.id, "open"), "Reopened")}><RotateCcw className="size-3.5" aria-hidden /> Reopen</Button>}
          {canWrite && !finished && !t.escalated && <Button size="sm" variant="ghost" onClick={() => setEscalateOpen(true)}><Flame className="size-3.5" aria-hidden /> Escalate…</Button>}
        </div>

        {t.escalation && (
          <div className="mt-4 rounded-xl border border-danger/25 bg-danger-soft/60 p-3 text-[12.5px] leading-relaxed text-danger-ink" role="status">
            <p className="flex items-center gap-1.5 font-semibold"><Flame className="size-3.5" aria-hidden /> Escalated {formatDateTime(t.escalation.at, timeZone)}{t.escalation.byName ? ` by ${t.escalation.byName}` : " automatically"}</p>
            {t.escalation.reason && <p className="mt-1">{t.escalation.reason}</p>}
            {caps["agency.support.priority"] && <Button size="sm" variant="ghost" className="mt-2" loading={busy === "clear"} onClick={() => void act("clear", () => clearEscalationAction(t.id), "Escalation cleared")}>Clear escalation</Button>}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><CalendarClock className="size-4 text-muted" aria-hidden /> Response target</h3>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusPill tone={SLA_TONE[t.sla.state]}>{SLA_STATE_LABELS[t.sla.state]}</StatusPill>
          {t.sla.dueAt && <span className="text-[12.5px] text-ink-2">{t.sla.kind === "first" ? "First reply" : "Reply"} due <time dateTime={t.sla.dueAt} className="font-medium text-ink">{formatDateTime(t.sla.dueAt, timeZone, DUE_FORMAT)}</time></span>}
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">
          {t.sla.state === "none" ? "No response target applies. Targets are configured by a Super Admin in Support settings." : t.sla.state === "waiting_on_client" ? "The clock is paused while the client's answer is awaited." : t.sla.state === "resolved" ? "No clock is running." : "Counted in support hours only. A public reply from the team stops this clock; an automatic acknowledgement never does."}
        </p>
      </Card>

      <Card className="p-4">
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><Building2 className="size-4 text-muted" aria-hidden /> Client</h3>
        <dl className="mt-3 divide-y divide-line">
          <Row label="Workspace"><Link href={`/admin/clients/${detail.org.id}`} className="inline-flex items-center gap-1 text-primary-ink hover:underline">{detail.org.name}<ArrowUpRight className="size-3" aria-hidden /></Link></Row>
          <Row label="Opened by">{t.createdByName ?? "Client"}</Row>
          {detail.org.ownerName && <Row label="Business owner">{detail.org.ownerName}</Row>}
          {detail.org.ownerEmail && <Row label="Owner email"><span className="break-all">{detail.org.ownerEmail}</span></Row>}
          <Row label="Active requests">{detail.org.openRequests}</Row>
          <Row label="Their time zone">{detail.org.timezone.replace(/_/g, " ")}</Row>
        </dl>
      </Card>

      <Card className="p-4">
        <h3 className="text-[13.5px] font-semibold text-ink">About this request</h3>
        <dl className="mt-3 divide-y divide-line">
          <Row label="Type">{REQUEST_TYPE_LABELS[t.requestType].label}</Row>
          <Row label="Topic">{categoryLabel(t.category)}</Row>
          {t.affectedFeature && <Row label="Feature">{featureLabel(t.affectedFeature)}</Row>}
          {t.clientUrgency && <Row label="Client says">{CLIENT_URGENCY_LABELS[t.clientUrgency as ClientUrgency]?.label ?? t.clientUrgency}</Row>}
          <Row label="Opened"><time dateTime={t.createdAt}>{formatDateTime(t.createdAt, timeZone)}</time></Row>
          <Row label="First reply">{t.firstRespondedAt ? <time dateTime={t.firstRespondedAt}>{formatDateTime(t.firstRespondedAt, timeZone)}</time> : "Not yet"}</Row>
          {t.resolvedAt && <Row label="Resolved"><time dateTime={t.resolvedAt}>{formatDateTime(t.resolvedAt, timeZone)}</time></Row>}
          {t.reopenedCount > 0 && <Row label="Reopened">{t.reopenedCount === 1 ? "Once" : `${t.reopenedCount} times`}</Row>}
          {t.pageContext && <Row label="Opened from"><code className="rounded bg-surface-2 px-1.5 py-0.5 text-[12px]">{t.pageContext}</code></Row>}
          {t.projectId && <Row label="Project"><Link href={`/admin/projects/${t.projectId}`} className="text-primary-ink hover:underline">View project</Link></Row>}
          <Row label="Outside alert"><StatusPill status={t.externalNotification} size="sm" /></Row>
        </dl>
      </Card>

      {detail.change && (
        <Card className="p-4">
          <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><PencilRuler className="size-4 text-muted" aria-hidden /> Change request</h3>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">Only the team sees this. It is a working label: it prices nothing, promises no date and the client never reads it.</p>
          <dl className="mt-3 divide-y divide-line">
            <Row label="About">{CHANGE_TARGET_LABELS[detail.change.targetKind]}</Row>
            {detail.change.project && <Row label="Project"><Link href={`/admin/projects/${detail.change.project.id}`} className="text-primary-ink hover:underline">{detail.change.project.ref} · {detail.change.project.title}</Link></Row>}
            {detail.change.linked && <Row label="On the change list"><Link href={`/admin/projects/${detail.change.linked.projectId}#agency-project-changes`} className="text-primary-ink hover:underline">{detail.change.linked.ref} · {detail.change.linked.status.replace(/_/g, " ")}</Link></Row>}
            {detail.change.classifiedAt && <Row label="Classified"><time dateTime={detail.change.classifiedAt}>{formatDateTime(detail.change.classifiedAt, timeZone)}</time>{detail.change.classifiedByName ? ` by ${detail.change.classifiedByName}` : ""}</Row>}
          </dl>
          <div className="mt-3 space-y-1.5">
            <Label htmlFor="d-class">What kind of change is it?</Label>
            <Select id="d-class" disabled={!canWrite || busy === "classify"} value={classification} onChange={(e) => setClassification(e.target.value)}>
              <option value="">Not looked at yet</option>
              {CHANGE_CLASSIFICATIONS.map((c) => <option key={c} value={c}>{CHANGE_CLASSIFICATION_LABELS[c].label}</option>)}
            </Select>
            {classification && <p className="text-[12px] leading-relaxed text-muted">{CHANGE_CLASSIFICATION_LABELS[classification as ChangeClassification].hint}</p>}
          </div>
          <div className="mt-3 space-y-1.5">
            <Label htmlFor="d-class-note">Note for the team <span className="text-[12px] font-normal text-faint">Optional</span></Label>
            <Textarea id="d-class-note" rows={2} maxLength={1000} disabled={!canWrite || busy === "classify"} value={classNote} onChange={(e) => setClassNote(e.target.value)} placeholder="Why you classified it this way." />
          </div>
          <Button className="mt-3" size="sm" variant="secondary" loading={busy === "classify"} disabled={!canWrite || !classification || (classification === (detail.change.classification ?? "") && classNote === (detail.change.resolutionNote ?? ""))}
            onClick={() => void act("classify", () => classifyChangeAction(t.id, classification, classNote), "Classification saved")}>Save classification</Button>
          {detail.change.project && !detail.change.linked && <p className="mt-3 text-[12px] leading-relaxed text-muted">To quote a change to what was agreed, the client files it from the project&apos;s Change requests, or ticks &ldquo;This changes what we agreed&rdquo; here. Nothing is priced from this request.</p>}
        </Card>
      )}

      {t.diagnostics && (
        <Card className="p-4">
          <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><ShieldCheck className="size-4 text-muted" aria-hidden /> Technical details shared by the client</h3>
          <dl className="mt-3 divide-y divide-line">{describeDiagnostics(t.diagnostics).map((r) => <Row key={r.label} label={r.label}><span className="break-words">{r.value}</span></Row>)}</dl>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><Link2 className="size-4 text-muted" aria-hidden /> Related requests</h3>
        {detail.links.length > 0 && (
          <ul className="mt-3 space-y-1.5">{detail.links.map((l) => (
            <li key={`${l.id}-${l.kind}`} className="flex flex-wrap items-center gap-2 text-[13px]">
              <Link href={`/admin/support?ticket=${l.id}`} className="font-mono text-[12px] text-primary-ink hover:underline">{l.ref}</Link>
              <span className="min-w-0 flex-1 truncate text-ink-2" title={l.subject}>{l.subject}</span>
              <InfoChip>{l.kind === "merged_into" ? (l.direction === "from" ? "merged into" : "merged here") : l.kind === "duplicate_of" ? "duplicate" : "related"}</InfoChip>
            </li>))}
          </ul>
        )}
        {detail.recent.length > 0 && (
          <details className="mt-3 group"><summary className="cursor-pointer text-[12.5px] font-medium text-ink-2 hover:text-ink">Recent from this client ({detail.recent.length})</summary>
            <ul className="mt-2 space-y-1.5">{detail.recent.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-[12.5px]"><Link href={`/admin/support?ticket=${r.id}`} className="font-mono text-[12px] text-primary-ink hover:underline">{r.ref}</Link><span className="min-w-0 flex-1 truncate text-ink-2">{r.subject}</span><StatusPill status={r.status} size="sm" /></li>))}
            </ul>
          </details>
        )}
        <div className="mt-3">
          <Button size="sm" variant="secondary" loading={busy === "similar"} onClick={async () => { setBusy("similar"); const res = await similarAction(t.id); setBusy(null); setSimilar(!res.ok ? { reason: res.error } : res.data); }}>Find possible duplicates</Button>
        </div>
        {similar && ("reason" in similar ? <p className="mt-2 text-[12.5px] text-danger-ink">{similar.reason}</p> : similar.length === 0 ? <p className="mt-2 text-[12.5px] text-muted">No similar requests from this client.</p> : (
          <ul className="mt-3 space-y-2.5" aria-label="Possible duplicates">{similar.map((s) => (
            <li key={s.id} className="rounded-xl border border-line bg-surface-2/60 p-2.5">
              <p className="flex items-center gap-2 text-[12.5px]"><Link href={`/admin/support?ticket=${s.id}`} className="font-mono text-[12px] text-primary-ink hover:underline">{s.ref}</Link><span className="min-w-0 flex-1 truncate font-medium text-ink" title={s.subject}>{s.subject}</span><span className="text-[12px] text-muted">{Math.round(s.score * 100)}% alike</span></p>
              {canWrite && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => void act(`link-${s.id}`, () => linkAction(t.id, s.id, "related"), "Linked").then(() => setSimilar((list) => (Array.isArray(list) ? list.filter((x) => x.id !== s.id) : list)))}>Link as related</Button>
                  {caps["agency.support.assign"] && caps["agency.support.resolve"] && !finished && <Button size="sm" variant="ghost" onClick={() => setMergeTarget(s)}><GitMerge className="size-3.5" aria-hidden /> Merge into this one…</Button>}
                </div>
              )}
            </li>))}
          </ul>
        ))}
      </Card>

      <Card className="p-4">
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><Sparkles className="size-4 text-muted" aria-hidden /> AI help &amp; advice</h3>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">Suggestions only. Nothing here changes the request or contacts the client.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={busy === "sum"} disabled={!canWrite} onClick={async () => { setBusy("sum"); const res = await summarizeAction(t.id); setBusy(null); if (!res.ok) setSummary({ reason: res.error }); else if (!res.data.ok) setSummary({ reason: res.data.reason }); else setSummary(res.data.data); }}>Summarize conversation</Button>
          <Button size="sm" variant="secondary" loading={busy === "adv"} disabled={!canWrite} onClick={async () => { setBusy("adv"); const res = await adviseAction(t.id); setBusy(null); if (res.ok) setAdvice(res.data); else toast.error(res.error); }}>Priority &amp; escalation advice</Button>
        </div>
        {summary && ("reason" in summary ? <p className="mt-3 text-[12.5px] text-ink-2">{summary.reason}</p> : (
          <div className="mt-3 rounded-xl border border-primary/20 bg-primary-soft/40 p-3"><p className="text-[12px] font-semibold uppercase tracking-wide text-primary-ink">Summary · {formatDateTime(summary.at, timeZone)}</p><p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{summary.text}</p></div>
        ))}
        {advice && (
          <div className="mt-3 rounded-xl border border-line bg-surface-2/60 p-3" role="status">
            <p className="text-[12.5px] font-semibold text-ink">{advice.recommend ? "Worth a closer look" : "Nothing alarming"} · consider <strong>{advice.suggestedPriority}</strong> priority</p>
            {advice.reasons.length > 0 ? <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-2">{advice.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="mt-1 text-[12.5px] text-muted">No signals found in this request.</p>}
            <p className="mt-2 text-[12px] text-muted">This is a prompt for your judgement; it doesn&apos;t change anything.</p>
          </div>
        )}
      </Card>

      {detail.looseAttachments.length > 0 && (
        <Card className="p-4">
          <h3 className="text-[13.5px] font-semibold text-ink">Files added to the request</h3>
          <ul className="mt-2 space-y-1.5">{detail.looseAttachments.map((a) => <li key={a.id}><a className="text-[13px] font-medium text-primary-ink hover:underline" href={`/api/support/attachments/${a.id}`}>{a.filename}</a>{a.visibility === "internal" && <span className="ml-2 text-[12px] text-warning-ink">team only</span>}</li>)}</ul>
        </Card>
      )}

      <Card className="p-4">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13.5px] font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"><History className="size-4 text-muted" aria-hidden /> History <span className="ml-auto text-[12px] font-normal text-muted group-open:hidden">Show</span><span className="ml-auto hidden text-[12px] font-normal text-muted group-open:inline">Hide</span></summary>
          <div className="mt-4"><Timeline entries={detail.timeline} viewer="agency" timeZone={timeZone} /></div>
        </details>
      </Card>

      <Dialog open={escalateOpen} onOpenChange={setEscalateOpen} title="Escalate this request" icon={<Flame />} size="sm" description="Managers are told. This doesn't change the priority or what the client sees."
        footer={<><Button variant="secondary" onClick={() => setEscalateOpen(false)}>Cancel</Button><Button variant="danger" loading={busy === "esc"} disabled={reason.trim().length < 3} onClick={async () => { if (await act("esc", () => escalateAction(t.id, reason), "Escalated")) { setEscalateOpen(false); setReason(""); } }}>Escalate</Button></>}>
        <Label htmlFor="esc-reason">Why does it need attention?</Label>
        <Textarea id="esc-reason" className="mt-1.5" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the client cannot take payments and has asked twice." />
      </Dialog>

      <Dialog open={Boolean(mergeTarget)} onOpenChange={(o) => !o && setMergeTarget(null)} title={`Merge ${mergeTarget?.ref ?? ""} into this request?`} icon={<GitMerge />} size="sm"
        description="The other request is closed and its client is told it was merged into this one. Nothing is deleted and both histories stay."
        footer={<><Button variant="secondary" onClick={() => setMergeTarget(null)}>Cancel</Button><Button variant="brand" loading={busy === "merge"} onClick={async () => { if (mergeTarget && await act("merge", () => mergeAction(mergeTarget.id, t.id), "Merged")) { setMergeTarget(null); setSimilar(null); } }}>Merge</Button></>}>
        <p className="text-[13px] text-ink-2"><strong className="font-medium">{mergeTarget?.ref}</strong> · {mergeTarget?.subject}</p>
      </Dialog>
      {busy && <span className="sr-only" role="status"><Loader2 className="size-3 animate-spin" aria-hidden /> Working…</span>}
    </div>
  );
}
