"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ChevronRight, ClipboardCheck, MessageSquareText, PhoneMissed, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Select, Textarea } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/overlays";
import { Pagination } from "@/components/crm/ui";
import { RelativeTime } from "@/components/crm/relative-time";
import { useCrmAction } from "@/components/crm/ui";
import { cn, formatDateTime } from "@/lib/utils";
import { formatPhone } from "@/lib/crm/types";
import {
  approveRecoveryDraftAction, assignMissedCallAction, closeMissedCallAction, escalateMissedCallAction, pauseMissedCallAction, rejectRecoveryDraftAction,
  resumeMissedCallAction, retryMissedCallAction,
} from "@/app/actions/missed-calls";
import { ACTION_KIND_LABELS, ACTION_STATUS_LABELS, CALL_CLASS_HELP, caseStatusLabel, type ActionStatus, type CaseState } from "@/lib/missed-calls/state";
import { blockReasonText } from "@/lib/missed-calls/eligibility";
import type { CaseDetail, CaseGroup, CaseView } from "@/server/missed-calls/ops";
import type { RecoveryStats } from "@/server/missed-calls/analytics";
import type { MissedCallPolicy } from "@/lib/missed-calls/policy";
import type { ReadinessItem } from "@/server/missed-calls/policy";
import type { CrmScope } from "@/server/crm/page";

const GROUPS: Array<[CaseGroup, string]> = [["needs_you", "Needs you"], ["waiting", "Waiting"], ["recovered", "Recovered"], ["closed", "Closed"], ["all", "All"]];

const STATE_TONE: Record<CaseState, "primary" | "success" | "warning" | "danger" | "neutral" | "outline"> = {
  detected: "warning", awaiting_eligibility: "warning", eligible: "primary", suppressed: "outline", scheduled: "primary", in_progress: "primary", awaiting_response: "primary",
  recovered: "success", completed_without_recovery: "neutral", failed: "danger", canceled: "neutral",
};
const ACTION_TONE: Record<ActionStatus, "primary" | "success" | "warning" | "danger" | "neutral" | "outline"> = {
  planned: "outline", awaiting_approval: "warning", queued: "primary", sent: "success", delivered: "success", done: "success", blocked: "danger", failed: "danger", skipped: "neutral", canceled: "neutral",
};

function Stat({ label, value, help }: { label: string; value: React.ReactNode; help?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4" title={help}>
      <p className="text-[12px] font-medium text-muted">{label}</p>
      <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{value}</p>
      {help && <p className="mt-0.5 text-[11.5px] leading-snug text-faint">{help}</p>}
    </div>
  );
}

export function CaseStatusBadge({ c }: { c: Pick<CaseView, "state" | "stateReason" | "paused"> }) {
  return (
    <>
      <Badge tone={STATE_TONE[c.state]}>{caseStatusLabel(c.state, c.stateReason)}</Badge>
      {c.paused && <Badge tone="warning">Paused</Badge>}
    </>
  );
}

const minutesText = (m: number | null) => (m === null ? "—" : m < 1 ? "under a minute" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m / 144) / 10} days`);

export function RecoveryWorkspace({ scope, stats, cases, group, policy, readiness, members, selected, canWork, canConfigure, hrefFor }: {
  scope: CrmScope;
  stats: RecoveryStats;
  cases: { rows: CaseView[]; total: number; page: number; pageSize: number; counts: Record<CaseGroup, number> };
  group: CaseGroup;
  policy: MissedCallPolicy;
  readiness: ReadinessItem[];
  members: Array<{ id: string; name: string }>;
  selected: CaseDetail | null;
  canWork: boolean;
  canConfigure: boolean;
  hrefFor: (patch: { group?: CaseGroup; page?: number; case?: string | null; tab?: "recovery-settings" }) => string;
}) {
  const [openId, setOpenId] = React.useState<string | null>(selected?.id ?? null);
  const open = selected && selected.id === openId ? selected : null;
  const noCalls = stats.calls.inbound === 0 && cases.counts.all === 0;
  const attention = readiness.filter((i) => !i.ok && (i.blocking || i.key === "policy_enabled" || i.key === "scheduler" || i.key.startsWith("sending_")));

  return (
    <section aria-label="Missed-call recovery" className="space-y-5">
      {!policy.enabled ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[13px]" role="note">
          <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
          <p className="min-w-0 flex-1 text-ink-2"><span className="font-medium text-ink">Recovery is off.</span> Missed calls are listed here, but nobody is told and nothing is followed up until you switch it on.</p>
          <Link href={hrefFor({ tab: "recovery-settings" })} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 font-medium text-ink hover:bg-surface-3 sm:min-h-9"><Settings2 className="size-4" aria-hidden />{canConfigure ? "Set it up" : "See settings"}</Link>
        </div>
      ) : attention.length > 0 ? (
        <ul className="space-y-1.5 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[12.5px] text-warning-ink" aria-label="Things to know">
          {/* The checklist labels are written as the good state ("... is on"); beside a failing detail they are prefixed so the line never contradicts itself. */}
          {attention.slice(0, 3).map((i) => <li key={i.key}><span className="font-medium">Not yet: {i.label.charAt(0).toLowerCase()}{i.label.slice(1)}.</span> {i.detail}</li>)}
          <li><Link href={hrefFor({ tab: "recovery-settings" })} className="inline-flex min-h-11 items-center font-medium underline sm:min-h-0">Open recovery settings</Link></li>
        </ul>
      ) : null}

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-ink">Last {stats.periodDays} days</h2>
          <nav aria-label="Period" className="flex gap-1">
            {[7, 30, 90].map((d) => (
              <Link key={d} href={`${scope.base}/calls?tab=recovery&days=${d}${group !== "needs_you" ? `&group=${group}` : ""}`} aria-current={stats.periodDays === d ? "page" : undefined}
                className={cn("inline-flex min-h-11 items-center rounded-xl border px-3 text-[12.5px] font-medium sm:min-h-8", stats.periodDays === d ? "border-primary/25 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}>{d} days</Link>
            ))}
          </nav>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Incoming calls" value={stats.calls.inbound} help={`${stats.calls.answered} answered`} />
          <Stat label="Missed" value={stats.calls.missed} help={stats.calls.afterHours ? `${stats.calls.afterHours} after hours` : "Provider-confirmed or hung up in seconds"} />
          <Stat label="Texted" value={stats.funnel.contacted} help={`${stats.funnel.attempts} attempt${stats.funnel.attempts === 1 ? "" : "s"}; sent means the provider took it`} />
          <Stat label="Replied or booked" value={stats.funnel.responded + stats.funnel.appointments} help={`${stats.funnel.responded} replies, ${stats.funnel.appointments} bookings`} />
          <Stat label="Recovered" value={stats.cases.recovered} help={stats.rates.recoveryRate === null ? "No cases yet" : `${stats.rates.recoveryRate}% of cases`} />
          <Stat label="First action" value={minutesText(stats.speed.medianMinutesToFirstAction)} help={stats.speed.casesWithAnAction ? `Median across ${stats.speed.casesWithAnAction}` : "None yet"} />
        </div>
        {stats.association.wonDeals > 0 && (
          <p className="mt-2 text-[12px] text-muted">{stats.association.wonDeals} deal{stats.association.wonDeals === 1 ? "" : "s"} marked won for recovered callers after the call
            {stats.association.wonValueByCurrency.length ? ` (${stats.association.wonValueByCurrency.map((v) => `${v.currency} ${Number(v.total).toLocaleString("en-US")}`).join(", ")})` : ""}. {stats.association.note}</p>
        )}
      </div>

      <div className="space-y-3">
        <nav aria-label="Filter missed calls" className="relative scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {GROUPS.map(([k, label]) => (
            <Link key={k} href={hrefFor({ group: k, page: 1, case: null })} aria-current={group === k ? "page" : undefined}
              className={cn("inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-[13px] font-medium transition-colors sm:min-h-9", group === k ? "border-primary/25 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}>
              {label}<span className="tabular-nums text-muted">{cases.counts[k]}</span>
            </Link>
          ))}
        </nav>

        {cases.rows.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label="Missed calls">
            {cases.rows.map((c) => (
              <li key={c.id}>
                <Link href={hrefFor({ case: c.id })} scroll={false} onClick={() => setOpenId(c.id)} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><PhoneMissed className="size-4" aria-hidden /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13.5px] font-medium text-ink">{c.contact?.name ?? (c.callerNumber ? formatPhone(c.callerNumber) : "Number withheld")}</span>
                      <CaseStatusBadge c={c} />
                      {c.afterHours && <Badge tone="outline">After hours</Badge>}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-muted">
                      {c.classificationLabel}{c.callCount > 1 ? ` · ${c.callCount} calls` : ""}{c.attempts ? ` · ${c.attempts} text${c.attempts === 1 ? "" : "s"}` : ""}
                      {c.owner.name ? ` · ${c.owner.name}` : c.owner.kind === "unassigned" ? " · Nobody has it" : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted"><RelativeTime iso={c.lastCalledAt} timezone={scope.timezone} /><ChevronRight className="size-4" aria-hidden /></span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<PhoneMissed className="size-5" />}
            title={noCalls ? "No missed calls yet" : cases.counts.all ? "Nothing here" : "No missed calls in this view"}
            description={noCalls
              ? "When a caller reaches your voice assistant and nobody helps them, it shows up here with a plain reason, and your team can follow up. Nothing is invented: this list only ever holds calls your provider reported."
              : "Try another filter."}
          />
        )}
        <Pagination page={cases.page} pageSize={cases.pageSize} total={cases.total} hrefFor={(n) => hrefFor({ page: n })} />
      </div>

      <CaseSheet scope={scope} detail={open} onClose={() => { setOpenId(null); window.history.replaceState(null, "", hrefFor({ case: null })); }} members={members} canWork={canWork} />
    </section>
  );
}

function CaseSheet({ scope, detail, onClose, members, canWork }: { scope: CrmScope; detail: CaseDetail | null; onClose: () => void; members: Array<{ id: string; name: string }>; canWork: boolean }) {
  if (!detail) return <Sheet open={false} onOpenChange={() => onClose()} title="Missed call"><span /></Sheet>;
  return <CaseBody key={`${detail.id}:${detail.version}:${detail.ownerVersion}`} scope={scope} detail={detail} onClose={onClose} members={members} canWork={canWork} />;
}

function CaseBody({ scope, detail, onClose, members, canWork }: { scope: CrmScope; detail: CaseDetail; onClose: () => void; members: Array<{ id: string; name: string }>; canWork: boolean }) {
  const who = detail.contact?.name ?? (detail.callerNumber ? formatPhone(detail.callerNumber) : "Number withheld");
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }} title={who} description={`${detail.classificationLabel}${detail.afterHours ? ", after hours" : ""}`}>
      <CaseDetailContent scope={scope} detail={detail} members={members} canWork={canWork} />
    </Sheet>
  );
}

/** What is inside the case sheet. Separate from the sheet so it can be rendered (and tested) on its own. */
export function CaseDetailContent({ scope, detail, members, canWork }: { scope: CrmScope; detail: CaseDetail; members: Array<{ id: string; name: string }>; canWork: boolean }) {
  const { run, busy } = useCrmAction();
  const [assignee, setAssignee] = React.useState(detail.owner.userId ?? "");
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const finished = ["recovered", "completed_without_recovery", "canceled"].includes(detail.state);
  const act = (key: string, fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, msg: string) => run(key, fn as never, msg);

  return (
      <div className="space-y-5 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <CaseStatusBadge c={detail} />
          {detail.attempts > 0 && <Badge tone="outline">{detail.attempts} text{detail.attempts === 1 ? "" : "s"} tried</Badge>}
        </div>
        <p className="text-[12.5px] text-muted">{CALL_CLASS_HELP[detail.classification]}</p>
        {detail.nextActionAt && !finished && <p className="text-[12.5px] text-muted">Next look: {formatDateTime(detail.nextActionAt, scope.timezone)}</p>}
        {detail.stateReason && detail.state === "suppressed" && <p className="text-[12.5px] text-ink-2">{blockReasonText(detail.stateReason.replace(/^message_/, ""))}</p>}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          {detail.contact && <Link href={`${scope.base}/contacts/${detail.contact.id}`} className="inline-flex min-h-11 items-center font-medium text-primary-ink hover:underline sm:min-h-0">Open contact</Link>}
          {detail.conversationId && scope.can["inbox.view"] && <Link href={`/inbox?conversation=${detail.conversationId}`} className="inline-flex min-h-11 items-center font-medium text-primary-ink hover:underline sm:min-h-0">Open conversation</Link>}
        </div>

        <section aria-label="Calls">
          <h3 className="mb-2 text-[13px] font-semibold text-ink">Calls</h3>
          <ul className="space-y-1.5 text-[13px]">
            {detail.calls.map((c) => (
              <li key={c.id} className={cn("flex items-center justify-between gap-2", !c.counted && "text-faint line-through")}>
                <span>{formatDateTime(c.calledAt, scope.timezone)}{c.afterHours ? " · after hours" : ""}</span>
                <span className="text-muted">{c.counted ? "" : "answered after all"}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Follow-up">
          <h3 className="mb-2 text-[13px] font-semibold text-ink">What was done</h3>
          {detail.actions.length ? (
            <ul className="space-y-3">
              {detail.actions.map((a) => (
                <li key={a.id} className="rounded-xl border border-line p-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{ACTION_KIND_LABELS[a.kind]}{a.channel ? ` (${a.channel === "sms" ? "text" : "email"})` : ""}</span>
                    <Badge tone={ACTION_TONE[a.status]}>{ACTION_STATUS_LABELS[a.status]}</Badge>
                  </div>
                  {a.reason && <p className="mt-1 text-[12.5px] text-muted">{blockReasonText(a.reason) !== "A rule held this back." ? blockReasonText(a.reason) : a.reason.replace(/_/g, " ")}</p>}
                  {a.kind === "ai_callback" && <p className="mt-1 text-[12.5px] text-muted">An AI call-back needs an outbound-calling connection that has been verified. None exists, so nothing was called.</p>}
                  {a.status === "awaiting_approval" && a.draftBody && (
                    <div className="mt-2 space-y-2">
                      <Textarea aria-label="Text to send" rows={3} maxLength={480} value={drafts[a.id] ?? a.draftBody} disabled={!canWork} onChange={(e) => setDrafts({ ...drafts, [a.id]: e.target.value })} />
                      {canWork && (
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" loading={busy(`ok-${a.id}`)} onClick={() => act(`ok-${a.id}`, () => approveRecoveryDraftAction(scope.orgId, detail.id, a.id, { body: drafts[a.id] ?? null, expectedOwnerVersion: detail.ownerVersion }), "Queued to send.")}><MessageSquareText className="size-4" aria-hidden />Approve and send</Button>
                          <Button size="sm" variant="ghost" loading={busy(`no-${a.id}`)} onClick={() => act(`no-${a.id}`, () => rejectRecoveryDraftAction(scope.orgId, detail.id, a.id, detail.ownerVersion), "Draft discarded.")}>Discard</Button>
                        </div>
                      )}
                    </div>
                  )}
                  {a.taskId && <Link href={`${scope.base}/tasks`} className="mt-1 inline-flex min-h-11 items-center text-[12.5px] font-medium text-primary-ink hover:underline sm:min-h-0"><ClipboardCheck className="mr-1 inline size-3.5" aria-hidden />View task</Link>}
                </li>
              ))}
            </ul>
          ) : <p className="text-[13px] text-muted">Nothing yet.</p>}
        </section>

        {canWork && !finished && (
          <section aria-label="Work this missed call" className="space-y-3 rounded-xl bg-surface-2 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 text-[12.5px] font-medium text-ink-2">Owner
                <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="mt-1">
                  <option value="">Nobody</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </label>
              <Button size="sm" variant="secondary" loading={busy("assign")} onClick={() => act("assign", () => assignMissedCallAction(scope.orgId, detail.id, assignee || null, detail.ownerVersion), "Owner updated.")}>Save owner</Button>
              {scope.userId && assignee !== scope.userId && <Button size="sm" variant="ghost" onClick={() => setAssignee(scope.userId!)}>Me</Button>}
            </div>
            <div className="flex flex-wrap gap-2">
              {detail.paused
                ? <Button size="sm" variant="secondary" loading={busy("resume")} onClick={() => act("resume", () => resumeMissedCallAction(scope.orgId, detail.id, detail.ownerVersion), "Automatic follow-up is back on.")}>Resume automatic follow-up</Button>
                : <Button size="sm" variant="secondary" loading={busy("pause")} onClick={() => act("pause", () => pauseMissedCallAction(scope.orgId, detail.id, detail.ownerVersion), "Automatic follow-up paused.")}>Pause automatic follow-up</Button>}
              <Button size="sm" variant="secondary" loading={busy("escalate")} onClick={() => act("escalate", () => escalateMissedCallAction(scope.orgId, detail.id), "Owners and managers have been told.")}>Escalate</Button>
              <Button size="sm" loading={busy("rec")} onClick={() => act("rec", () => closeMissedCallAction(scope.orgId, detail.id, "recovered"), "Marked as recovered.")}>Mark recovered</Button>
              <Button size="sm" variant="ghost" loading={busy("none")} onClick={() => act("none", () => closeMissedCallAction(scope.orgId, detail.id, "no_recovery"), "Closed.")}>Close without recovery</Button>
              <Button size="sm" variant="ghost" loading={busy("cancel")} onClick={() => act("cancel", () => closeMissedCallAction(scope.orgId, detail.id, "canceled"), "Canceled.")}>Not a real missed call</Button>
            </div>
          </section>
        )}
        {canWork && detail.state === "failed" && (
          <Button variant="secondary" loading={busy("retry")} onClick={() => act("retry", () => retryMissedCallAction(scope.orgId, detail.id), "Put back in the queue.")}>Try again</Button>
        )}

        <section aria-label="History">
          <h3 className="mb-2 text-[13px] font-semibold text-ink">History</h3>
          <ol className="space-y-2 border-l border-line pl-4 text-[12.5px]">
            {detail.events.map((e) => (
              <li key={e.id} className="relative">
                <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-line-strong" aria-hidden />
                <span className="text-ink">{eventText(e)}</span>
                <span className="block text-muted">{formatDateTime(e.at, scope.timezone)} · {actorText(e.actor)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
  );
}

const actorText = (a: { kind: string; name: string | null }) => (a.name ? a.name : a.kind === "provider" ? "Voice provider" : a.kind === "ai" ? "AI employee" : a.kind === "workflow" ? "Automation" : a.kind === "agency" ? "iAcquire support" : "iAcquire");
function eventText(e: CaseDetail["events"][number]): string {
  switch (e.kind) {
    case "case_created": return "Missed call detected";
    case "call_added": return "Another missed call from the same number";
    case "call_reclassified": return e.detail.counted === false ? "A call turned out to have been answered" : "A call was reclassified";
    case "state_changed": return `${caseStatusLabel((e.toState ?? "detected") as CaseState, typeof e.detail.reason === "string" ? e.detail.reason : null)}`;
    case "owner_assigned": return "Owner assigned";
    case "owner_cleared": return "Owner removed";
    case "paused": return "Automatic follow-up paused";
    case "resumed": return "Automatic follow-up resumed";
    case "escalated": return "Escalated to owners and managers";
    case "draft_approved": return "Drafted text approved";
    case "draft_rejected": return "Drafted text discarded";
    case "ai_callback_blocked": return "AI call-back blocked: no verified outbound-call connection";
    default: return e.kind.replace(/_/g, " ");
  }
}
