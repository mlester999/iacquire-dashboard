"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, PhoneCall, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { Pagination, PageTitle } from "@/components/crm/ui";
import { RelativeTime } from "@/components/crm/relative-time";
import { cn } from "@/lib/utils";
import { formatPhone } from "@/lib/crm/types";
import type { CrmScope } from "@/server/crm/page";
import type { CallRecordView, CallStatusFilter, VoiceConnectionView } from "@/server/crm/calls";
import { CALL_PROVIDER_LABELS, CALL_STATUS_LABELS, CALL_STATUS_TONES, dispositionLabel, durationLabel } from "@/components/crm/calls/model";
import { LogCallDialog } from "@/components/crm/calls/log-call-dialog";
import { CallDetailSheet } from "@/components/crm/calls/call-detail";
import { VoiceConnections } from "@/components/crm/calls/voice-connections";
import { RecoveryWorkspace } from "@/components/crm/recovery/recovery-workspace";
import { RecoverySettings } from "@/components/crm/recovery/recovery-settings";
import type { CaseDetail, CaseGroup, CaseView } from "@/server/missed-calls/ops";
import type { RecoveryStats } from "@/server/missed-calls/analytics";
import type { MissedCallPolicy } from "@/lib/missed-calls/policy";
import type { ReadinessItem } from "@/server/missed-calls/policy";

export type CallsTab = "calls" | "recovery" | "recovery-settings" | "connections";

/** What the Recovery tabs need, read on the server only when one of them is open. */
export type RecoveryData =
  | { stats: RecoveryStats; cases: { rows: CaseView[]; total: number; page: number; pageSize: number; counts: Record<CaseGroup, number> }; group: CaseGroup; selected: CaseDetail | null; policy: MissedCallPolicy; readiness: ReadinessItem[] }
  | { policy: MissedCallPolicy; readiness: ReadinessItem[]; businessName: string };

interface Filters {
  status: CallStatusFilter;
  provider: "vapi" | "retell" | "manual" | "all";
  direction: "inbound" | "outbound" | "all";
  match: "matched" | "unmatched" | "all";
  days: number | null;
}

const STATUS_FILTERS: Array<[CallStatusFilter, string]> = [["all", "All"], ["completed", "Completed"], ["missed", "Missed"], ["failed", "Failed"], ["live", "In progress"]];

function Pill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-[14px] font-medium transition-colors sm:min-h-9",
        active ? "border-primary/25 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2",
      )}
    >
      {children}
    </Link>
  );
}

/** One call in a list: who, which way, how it went and when, opening its details. Shared with the contact profile. */
export function CallRow({ scope, call, onOpen, showContact = true }: { scope: CrmScope; call: CallRecordView; onOpen: () => void; showContact?: boolean }) {
  const Icon = call.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;
  const who = call.contact?.name ?? (call.customerNumber ? formatPhone(call.customerNumber) : "Unknown caller");
  const reason = call.provider === "manual" ? call.disposition : dispositionLabel(call.disposition);
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
        <span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl", call.status === "completed" ? "bg-success-soft text-success-ink" : "bg-surface-2 text-ink-2")}>
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-medium text-ink">{showContact ? who : call.direction === "inbound" ? "Incoming call" : "Outgoing call"}</span>
            <Badge tone={CALL_STATUS_TONES[call.status]}>{CALL_STATUS_LABELS[call.status]}</Badge>
            {showContact && !call.contact && <Badge tone="outline">Not linked</Badge>}
          </span>
          <span className="mt-0.5 block text-[13px] text-muted">
            {call.direction === "inbound" ? "Incoming" : "Outgoing"} · {CALL_PROVIDER_LABELS[call.provider]}
            {call.durationSeconds ? ` · ${durationLabel(call.durationSeconds)}` : ""}
            {reason ? ` · ${reason}` : ""}
          </span>
          {call.summary && <span className="mt-1 line-clamp-2 block text-[13px] leading-relaxed text-ink-2">{call.summary}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
          {call.startedAt || call.createdAt ? <RelativeTime iso={call.startedAt ?? call.createdAt} timezone={scope.timezone} /> : null}
          <ChevronRight className="size-4" aria-hidden />
        </span>
      </button>
    </li>
  );
}

/** CRM → Calls. The rules are in src/server/crm/calls.ts; the provider adapters in src/server/integrations/voice. */
export function CallsWorkspace({ scope, tab, filters, calls, connections, recovery = null, canWorkCases = false, canConfigureRecovery = false, members, canLog, canFollowUp, canConnect, vapiAuthModes }: {
  scope: CrmScope;
  tab: CallsTab;
  filters: Filters;
  calls: { rows: CallRecordView[]; total: number; page: number; pageSize: number; counts: Record<CallStatusFilter, number> };
  connections: VoiceConnectionView[];
  recovery?: RecoveryData | null;
  canWorkCases?: boolean;
  canConfigureRecovery?: boolean;
  members: Array<{ id: string; name: string }>;
  canLog: boolean;
  canFollowUp: boolean;
  canConnect: boolean;
  vapiAuthModes: Array<{ value: string; label: string }>;
}) {
  const [logging, setLogging] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const open = calls.rows.find((c) => c.id === openId) ?? null;
  const href = (patch: Partial<Filters> & { tab?: CallsTab; page?: number }) => {
    const f = { ...filters, ...patch };
    const sp = new URLSearchParams();
    if ((patch.tab ?? tab) !== "calls") sp.set("tab", patch.tab ?? tab);
    if ((patch.tab ?? tab) !== "calls") {
      // The other tabs carry their own filters.
    } else {
      if (f.status !== "all") sp.set("status", f.status);
      if (f.provider !== "all") sp.set("provider", f.provider);
      if (f.direction !== "all") sp.set("direction", f.direction);
      if (f.match !== "all") sp.set("match", f.match);
      if (f.days) sp.set("days", String(f.days));
      if (patch.page && patch.page > 1) sp.set("page", String(patch.page));
    }
    const s = sp.toString();
    return `${scope.base}/calls${s ? `?${s}` : ""}`;
  };
  const anyConnected = connections.some((c) => c.status === "connected" || c.status === "credentials_saved");

  return (
    <div className="space-y-6">
      <PageTitle
        title="Calls"
        description="Calls your voice assistants reported and calls your team logged. Each is matched to a contact only by the caller's exact phone number."
        actions={canLog ? <Button onClick={() => setLogging(true)}><PhoneCall className="size-4" aria-hidden />Log a call</Button> : undefined}
      />

      <nav aria-label="Calls sections" className="flex gap-1 border-b border-line">
        {([["calls", "Calls"], ["recovery", "Missed-call recovery"], ["recovery-settings", "Recovery settings"], ["connections", "Voice connections"]] as const).map(([k, label]) => (
          <Link
            key={k}
            href={href({ tab: k })}
            aria-current={tab === k ? "page" : undefined}
            className={cn("-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-[14px] font-medium transition-colors", tab === k ? "border-primary text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {label}
          </Link>
        ))}
      </nav>

      {tab === "connections" ? (
        <VoiceConnections scope={scope} connections={connections} canConnect={canConnect} vapiAuthModes={vapiAuthModes} />
      ) : tab === "recovery" && recovery && "stats" in recovery ? (
        <RecoveryWorkspace
          scope={scope} stats={recovery.stats} cases={recovery.cases} group={recovery.group} policy={recovery.policy} readiness={recovery.readiness} members={members}
          selected={recovery.selected} canWork={canWorkCases} canConfigure={canConfigureRecovery}
          hrefFor={(p) => {
            const sp = new URLSearchParams({ tab: p.tab ?? "recovery" });
            if (!p.tab) {
              const g = p.group ?? recovery.group;
              if (g !== "needs_you") sp.set("group", g);
              if (recovery.stats.periodDays !== 30) sp.set("days", String(recovery.stats.periodDays));
              if (p.page && p.page > 1) sp.set("page", String(p.page));
              if (p.case) sp.set("case", p.case);
            }
            return `${scope.base}/calls?${sp.toString()}`;
          }}
        />
      ) : tab === "recovery-settings" && recovery && "businessName" in recovery ? (
        <RecoverySettings scope={scope} policy={recovery.policy} readiness={recovery.readiness} members={members} businessName={recovery.businessName} canConfigure={canConfigureRecovery} />
      ) : (
        <section aria-label="Calls" className="space-y-4">
          <div className="space-y-2">
            <nav aria-label="Filter by outcome" className="relative scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:px-0 lg:flex-wrap lg:overflow-visible">
              {STATUS_FILTERS.map(([k, label]) => (
                <Pill key={k} href={href({ status: k, page: 1 })} active={filters.status === k}>
                  {label}<span className="tabular-nums text-muted">{calls.counts[k]}</span>
                </Pill>
              ))}
            </nav>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
              <nav aria-label="Filter by direction" className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted">Direction</span>
                {(["all", "inbound", "outbound"] as const).map((d) => <Pill key={d} href={href({ direction: d })} active={filters.direction === d}>{d === "all" ? "Any" : d === "inbound" ? "Incoming" : "Outgoing"}</Pill>)}
              </nav>
              <nav aria-label="Filter by source" className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted">Source</span>
                {(["all", "vapi", "retell", "manual"] as const).map((p) => <Pill key={p} href={href({ provider: p })} active={filters.provider === p}>{p === "all" ? "Any" : CALL_PROVIDER_LABELS[p]}</Pill>)}
              </nav>
              <nav aria-label="Filter by contact" className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted">Contact</span>
                {(["all", "matched", "unmatched"] as const).map((m) => <Pill key={m} href={href({ match: m })} active={filters.match === m}>{m === "all" ? "Any" : m === "matched" ? "Linked" : "Not linked"}</Pill>)}
              </nav>
              <nav aria-label="Filter by period" className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted">Period</span>
                {([null, 1, 7, 30, 90] as const).map((d) => <Pill key={String(d)} href={href({ days: d })} active={filters.days === d}>{d === null ? "All time" : d === 1 ? "Today" : `${d} days`}</Pill>)}
              </nav>
            </div>
          </div>

          {calls.rows.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label="Calls">
              {calls.rows.map((c) => <CallRow key={c.id} scope={scope} call={c} onOpen={() => setOpenId(c.id)} />)}
            </ul>
          ) : (
            <EmptyState
              icon={<PhoneCall className="size-5" />}
              title={calls.counts.all ? "No calls match these filters" : "No calls yet"}
              description={calls.counts.all
                ? "Try another filter."
                : anyConnected
                  ? "Calls appear here as soon as your voice assistant reports them, and when your team logs a call."
                  : "Calls appear here when your team logs one, or once your agency connects your Vapi or Retell assistant under Voice connections."}
              action={!calls.counts.all && canLog ? <Button variant="secondary" onClick={() => setLogging(true)}><PhoneCall className="size-4" aria-hidden />Log a call</Button> : undefined}
            />
          )}
          <Pagination page={calls.page} pageSize={calls.pageSize} total={calls.total} hrefFor={(n) => href({ page: n })} />
        </section>
      )}

      {canLog && <LogCallDialog scope={scope} open={logging} onOpenChange={setLogging} members={members} canFollowUp={canFollowUp} />}
      <CallDetailSheet scope={scope} call={open} onClose={() => setOpenId(null)} canLog={canLog} canFollowUp={canFollowUp} members={members} />
    </div>
  );
}
