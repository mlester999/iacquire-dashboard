"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Ban, CheckCircle2, Clock3, Hand, Info, KeyRound, OctagonAlert, PenLine, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { AgentAvatar } from "@/components/brand";
import { ConfirmDialog, PageTitle, useCrmAction } from "@/components/crm/ui";
import { revokeAgentToolAccessAction } from "@/app/actions/crm-agent-tools";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/crm/relative-time";
import type { AgentToolsOverview, EmployeeToolAccess, ToolBehaviour, ToolCallEntry } from "@/server/crm/agent-tools/overview";
import type { CrmScope } from "@/server/crm/page";

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet" | "outline";

const MODE: Record<string, { label: string; tone: Tone; help: string }> = {
  autonomous: { label: "Autonomous", tone: "success", help: "Makes routine CRM changes itself. High-impact changes still wait for a person." },
  approval_required: { label: "Asks before changes", tone: "primary", help: "Looks things up freely. Every change waits in the Approval Center." },
  paused: { label: "Paused", tone: "warning", help: "Every tool call is refused until it is resumed." },
};

const BEHAVIOUR: Record<Exclude<ToolBehaviour, "not_for_role">, { label: string; tone: Tone; description: string }> = {
  runs: { label: "On its own", tone: "success", description: "Runs straight away" },
  asks_first: { label: "Asks first", tone: "primary", description: "Waits for a person's approval" },
  always_asks: { label: "Always asks", tone: "warning", description: "Always waits for a person, whatever the mode" },
  proposes: { label: "Proposes", tone: "violet", description: "Prepares a draft or request; your rules decide" },
  stopped: { label: "Stopped", tone: "neutral", description: "Refused while the employee is paused or not included" },
};

const OUTCOME: Record<ToolCallEntry["outcome"], { label: string; tone: Tone }> = {
  done: { label: "Done", tone: "success" },
  draft: { label: "Draft saved", tone: "violet" },
  pending_approval: { label: "Waiting for approval", tone: "primary" },
  unavailable: { label: "Not possible", tone: "neutral" },
  refused: { label: "Refused", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  queued: { label: "Queued", tone: "primary" },
  blocked: { label: "Blocked", tone: "warning" },
};

const KIND_GROUPS = [
  { kind: "read", title: "Looks up" },
  { kind: "write", title: "Changes records" },
  { kind: "proposal", title: "Proposes" },
] as const;

export function AiToolsScreen({ scope, overview }: { scope: CrmScope; overview: AgentToolsOverview }) {
  const { employees, calls, counts, pauses, liveRunsVerified } = overview;
  const canStop = overview.canStop && !scope.readOnly && !scope.agency;
  return (
    <div className="space-y-6">
      <PageTitle
        title="AI Employee Tools"
        description="The CRM tools your own AI employees can use, what each may do on its own, and every call they made. Each call is checked on our servers against the employee's role, its operating mode and your pauses. Anything that would reach a customer, close a deal or change several records at once always waits for a person."
        actions={<ButtonLink href="/approvals" variant="secondary" size="sm"><Clock3 className="size-4" aria-hidden />Approval Center</ButtonLink>}
      />

      {!liveRunsVerified && (
        <Card className="flex items-start gap-3 border-primary/25 bg-primary-soft/40 p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-primary-ink" aria-hidden />
          <div className="text-[13px] leading-relaxed text-ink-2">
            <p className="font-medium text-ink">Not in use yet</p>
            <p className="mt-0.5">Live AI employee runs stay switched off until iAcquire can verify each employee&apos;s complete tool permissions, so these tools aren&apos;t being called yet. The rules on this page are already enforced for every call once they are.</p>
          </div>
        </Card>
      )}
      {pauses.agency && (
        <Card role="status" className="flex items-start gap-3 border-warning/40 bg-warning-soft/60 p-4">
          <OctagonAlert className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden />
          <p className="text-[13px] leading-relaxed text-ink-2"><span className="font-medium text-ink">Automation is on hold.</span> iAcquire has paused automation for your workspace, so every CRM tool call is refused for now.</p>
        </Card>
      )}

      <section aria-labelledby="ai-tools-stats" className="space-y-3">
        <h3 id="ai-tools-stats" className="sr-only">Last 7 days</h3>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Tool calls (7 days)" value={counts.calls7d} icon={<Wrench className="size-4" aria-hidden />} />
          <Stat label="Completed or drafted" value={counts.done7d} icon={<CheckCircle2 className="size-4" aria-hidden />} />
          <Stat label="Refused" value={counts.refused7d} icon={<Ban className="size-4" aria-hidden />} />
          <Stat label="Waiting for approval" value={counts.pendingApprovals} icon={<Clock3 className="size-4" aria-hidden />} href={counts.pendingApprovals ? "/approvals" : undefined} />
        </dl>
      </section>

      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><Hand className="size-4" aria-hidden /></span>
            <div>
              <h3 className="text-[15px] font-semibold tracking-tight text-ink">Emergency stop</h3>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">
                Pausing an employee refuses every CRM tool call from it at once. <span className="text-ink-2">Stop tool access</span> below also ends the credentials it holds right now.
                The messaging and outbound pauses stop messages to customers (an approved draft is held), not CRM lookups or record changes.
              </p>
              {(pauses.messaging || pauses.outbound) && (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-2">
                  <span className="text-muted">On now:</span>
                  {pauses.messaging && <Badge tone="warning">Customer messaging paused</Badge>}
                  {pauses.outbound && <Badge tone="warning">Outbound actions paused</Badge>}
                </p>
              )}
            </div>
          </div>
          <ButtonLink href="/employees" variant="secondary" size="sm" className="shrink-0"><ShieldCheck className="size-4" aria-hidden />Safety controls</ButtonLink>
        </div>
      </Card>

      <section aria-labelledby="ai-tools-employees">
        <h3 id="ai-tools-employees" className="mb-3 text-[15px] font-semibold tracking-tight text-ink">What each employee can do</h3>
        {employees.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {employees.map((e) => <EmployeeCard key={e.id} employee={e} canStop={canStop} />)}
          </div>
        ) : (
          <Card><EmptyState icon={<Sparkles className="size-5" />} title="No AI employees yet" description="Your AI employees appear here once your workspace is set up." /></Card>
        )}
      </section>

      <section aria-labelledby="ai-tools-calls">
        <h3 id="ai-tools-calls" className="mb-3 text-[15px] font-semibold tracking-tight text-ink">Recent tool calls</h3>
        {calls.length ? <CallList calls={calls} timezone={scope.timezone} /> : (
          <Card><EmptyState compact icon={<Wrench className="size-5" />} title="No tool calls yet" description="Every CRM tool call an AI employee makes is listed here with what happened, including refused ones." /></Card>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, icon, href }: { label: string; value: number; icon: React.ReactNode; href?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
      <dt className="flex items-center gap-1.5 text-[12px] text-muted">{icon}{label}</dt>
      <dd className="mt-1.5 text-[22px] font-semibold tabular-nums tracking-tight text-ink">{value.toLocaleString("en-US")}</dd>
      {href && (
        <dd>
          <Link href={href} className="inline-flex min-h-11 items-center gap-1 text-[12.5px] font-medium text-primary-ink underline-offset-2 hover:underline sm:min-h-0">
            Review<span className="sr-only"> {label.toLowerCase()}</span><ArrowUpRight className="size-3" aria-hidden />
          </Link>
        </dd>
      )}
    </div>
  );
}

function EmployeeCard({ employee: e, canStop }: { employee: EmployeeToolAccess; canStop: boolean }) {
  const { run, busy } = useCrmAction();
  const [confirm, setConfirm] = React.useState(false);
  const meta = isAgentRoleKey(e.roleKey) ? AGENT_BY_KEY[e.roleKey] : null;
  const mode = !e.enabled ? { label: "Not included", tone: "neutral" as Tone, help: "This employee isn't part of your workspace, so it can't use any tool." } : MODE[e.mode] ?? MODE.approval_required;
  const available = e.tools.filter((t) => t.behaviour !== "not_for_role");
  const unavailable = e.tools.length - available.length;
  const headingId = `employee-${e.id}`;

  async function stop() {
    const res = await run(`stop:${e.id}`, () => revokeAgentToolAccessAction(null, e.id), (d) => (d.revoked ? `Ended ${d.revoked} tool ${d.revoked === 1 ? "credential" : "credentials"} for ${e.name}.` : `${e.name} had no live tool credentials.`));
    if (res) setConfirm(false);
  }

  return (
    <Card className="flex flex-col p-0" role="group" aria-labelledby={headingId}>
      <div className="flex items-start gap-3 border-b border-line p-4">
        {meta ? <AgentAvatar role={meta} size="md" /> : <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2"><Sparkles className="size-4" aria-hidden /></span>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 id={headingId} className="truncate text-[14px] font-semibold text-ink">{e.name}</h4>
            <Badge tone={mode.tone}>{mode.label}</Badge>
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{mode.help}</p>
          {!e.connected && e.enabled && <p className="mt-1 text-[12px] text-muted">Not connected to its AI service yet.</p>}
        </div>
      </div>

      <div className="flex-1 space-y-4 p-4">
        {available.length === 0 ? (
          <p className="text-[13px] text-muted">This role has no CRM tools.</p>
        ) : (
          KIND_GROUPS.map((g) => {
            const tools = available.filter((t) => t.kind === g.kind);
            if (!tools.length) return null;
            return (
              <div key={g.kind}>
                <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">{g.title}</p>
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {tools.map((t) => {
                    const b = BEHAVIOUR[t.behaviour as Exclude<ToolBehaviour, "not_for_role">];
                    return (
                      <li key={t.name} className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-[13px] text-ink">{t.label}</p>
                          {t.note && <p className="text-[12px] text-muted">{t.note}</p>}
                        </div>
                        <Badge tone={b.tone} title={b.description}>{b.label}<span className="sr-only">: {b.description}</span></Badge>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
        {unavailable > 0 && <p className="text-[12px] text-muted">{unavailable} other {unavailable === 1 ? "tool isn't" : "tools aren't"} available to this role.</p>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
        <p className="flex items-center gap-1.5 text-[12.5px] text-muted">
          <KeyRound className="size-3.5" aria-hidden />
          {e.liveTokens ? `${e.liveTokens} live tool ${e.liveTokens === 1 ? "credential" : "credentials"}` : "No live tool credentials"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {meta && <ButtonLink href={`/employees/${meta.slug}`} variant="ghost" size="sm"><PenLine className="size-3.5" aria-hidden />Mode<span className="sr-only"> for {e.name}</span></ButtonLink>}
          {canStop && e.liveTokens > 0 && (
            <Button variant="outline" size="sm" onClick={() => setConfirm(true)} aria-label={`Stop tool access for ${e.name}`}>
              <Ban className="size-3.5" aria-hidden />Stop tool access
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Stop ${e.name}'s tool access?`}
        description="Every live CRM tool credential it holds ends now, so its current work can't read or change your CRM. Its next run gets a new credential unless you also pause it."
        confirmLabel="Stop tool access"
        danger
        loading={busy(`stop:${e.id}`)}
        onConfirm={stop}
      />
    </Card>
  );
}

function CallList({ calls, timezone }: { calls: ToolCallEntry[]; timezone: string }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="hidden grid-cols-[9rem_10rem_minmax(0,1fr)_11rem] gap-3 border-b border-line bg-surface-2/60 px-4 py-2.5 text-[12px] font-medium text-muted md:grid" aria-hidden>
        <span>When</span><span>Employee</span><span>Tool and details</span><span className="text-right">Outcome</span>
      </div>
      <ul className="divide-y divide-line">
        {calls.map((c) => {
          const o = OUTCOME[c.outcome];
          return (
            <li key={c.id} className="grid gap-1.5 px-4 py-3 text-[13px] md:grid-cols-[9rem_10rem_minmax(0,1fr)_11rem] md:items-center md:gap-3">
              <RelativeTime iso={c.at} timezone={timezone} className="text-[12.5px] text-muted" />
              <span className="truncate font-medium text-ink">{c.employee ?? "AI employee"}</span>
              <div className="min-w-0">
                <p className="text-ink">{c.toolLabel}{c.approved && <span className="text-muted"> · approved by a person</span>}</p>
                {c.detail && <p className="line-clamp-2 text-[12.5px] text-muted">{c.detail}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <Badge tone={o.tone}>{o.label}</Badge>
                {c.outcome === "pending_approval" && c.approvalId && (
                  <Link href="/approvals" className={cn("inline-flex min-h-11 items-center gap-1 text-[12.5px] font-medium text-primary-ink underline-offset-2 hover:underline md:min-h-0")}>
                    Review<ArrowUpRight className="size-3" aria-hidden />
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
