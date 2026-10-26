"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, CircleAlert, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { useCrmAction } from "@/components/crm/ui";
import { setStudioWorkflowStatusAction } from "@/app/actions/automation-studio";
import { cn } from "@/lib/utils";

export interface UsageLineView {
  key: string;
  label: string;
  used: number;
  limit: number;
  state: "ok" | "warning" | "exceeded";
  percent: number;
  remaining: number;
  custom: boolean;
}
export interface UsageWorkflow {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  pausedForPlan: boolean;
  stepCount: number;
}
export interface UsageData {
  period: string;
  periodLabel: string;
  lines: UsageLineView[];
  counters: Array<{ label: string; quantity: number }>;
  hardStop: boolean;
  warnAtPercent: number;
  note: string | null;
}
export interface PlanSummary {
  state: "active" | "cancelling" | "past_due" | "pending" | "expired" | "cancelled" | "declined" | "none";
  title: string;
  detail: string;
  paidThrough: string | null;
  graceEnds: string | null;
  entitled: boolean;
}

const BAR = { ok: "bg-primary", warning: "bg-warning", exceeded: "bg-danger" } as const;
const STATE_TEXT = { ok: "Within your limit", warning: "Getting close to your limit", exceeded: "Limit reached" } as const;
const number = (n: number) => n.toLocaleString("en-US");

/** The workspace's Automation Studio usage this month against its limits, the plan's state, and each automation's pause and turn-on controls. */
export function UsagePanel({ plan, usage, workflows, canManage, connectionsNeedingAttention }: {
  plan: PlanSummary;
  usage: UsageData;
  workflows: UsageWorkflow[];
  canManage: boolean;
  connectionsNeedingAttention: number;
}) {
  const { run, busy } = useCrmAction();
  const waiting = workflows.filter((w) => w.status === "paused" && w.pausedForPlan);
  const tone = plan.state === "active" ? "success" : plan.state === "past_due" || plan.state === "cancelling" ? "warning" : plan.state === "none" ? "neutral" : "danger";

  return (
    <div className="space-y-6">
      <div>
        <Link href="/automation-studio" className="inline-flex items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink"><ArrowLeft className="size-3.5" aria-hidden />Automation Studio</Link>
        <h1 className="mt-3 text-[24px] font-semibold tracking-tight text-ink">Usage and plan</h1>
        <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">What your automations used in {usage.periodLabel}, set against the limits that keep every workspace fast and fair.</p>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Your plan</CardTitle>
            <CardDescription>{plan.title}</CardDescription>
          </div>
          <Badge tone={tone}>{plan.state === "active" ? "Active" : plan.state === "past_due" ? "Payment past due" : plan.state === "cancelling" ? "Ending" : plan.state === "expired" ? "Expired" : plan.state === "pending" ? "Awaiting activation" : "Not active"}</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[14px] leading-relaxed text-ink-2">{plan.detail}</p>
          {plan.paidThrough && <p className="text-[13px] text-muted">Paid through {plan.paidThrough}, as recorded by iAcquire after the payment was verified.</p>}
          {plan.state === "past_due" && plan.graceEnds && <p className="rounded-xl bg-warning-soft px-3 py-2 text-[14px] text-warning-ink" role="status">Automation Studio keeps working until {plan.graceEnds}. After that your automations are paused, never deleted.</p>}
          <div className="flex flex-wrap gap-2">
            <Link href="/maintenance" className="inline-flex h-9 items-center rounded-xl border border-line-strong bg-surface px-3 text-[14px] font-medium text-ink hover:border-primary hover:text-primary">{plan.entitled ? "Manage your plan" : "See how to get the plan"}</Link>
            {connectionsNeedingAttention > 0 && <Link href="/automation-studio/connections" className="inline-flex h-9 items-center rounded-xl bg-danger-soft px-3 text-[14px] font-medium text-danger-ink">{connectionsNeedingAttention} connection{connectionsNeedingAttention === 1 ? "" : "s"} need{connectionsNeedingAttention === 1 ? "s" : ""} attention</Link>}
          </div>
        </CardContent>
      </Card>

      {waiting.length > 0 && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Paused because of the plan</CardTitle>
              <CardDescription>Nothing was deleted or changed. Look each one over, then turn it back on when you’re ready.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-line">
              {waiting.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <Link href={`/automation-studio/${w.id}`} className="min-w-0 truncate text-[14px] font-medium text-ink hover:text-primary">{w.name}</Link>
                  <div className="flex items-center gap-2">
                    <Link href={`/automation-studio/${w.id}`} className="text-[13px] font-medium text-primary hover:underline">Review</Link>
                    {canManage && plan.entitled && (
                      <Button size="sm" variant="secondary" loading={busy(`on-${w.id}`)} onClick={() => void run(`on-${w.id}`, () => setStudioWorkflowStatusAction(w.id, "active"), "Turned on.")}><Play className="size-3.5" aria-hidden />Turn on</Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <section aria-labelledby="usage-limits">
        <h2 id="usage-limits" className="text-[16px] font-semibold text-ink">This month</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {usage.lines.map((l) => (
            <li key={l.key} className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[14px] font-medium text-ink">{l.label}</p>
                <p className="tabular-nums text-[14px] text-ink-2">{number(l.used)} of {number(l.limit)}</p>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={l.label} aria-valuemin={0} aria-valuemax={l.limit} aria-valuenow={Math.min(l.used, l.limit)} aria-valuetext={`${number(l.used)} of ${number(l.limit)}. ${STATE_TEXT[l.state]}`}>
                <div className={cn("h-full rounded-full transition-[width]", BAR[l.state])} style={{ width: `${Math.min(100, Math.max(l.used > 0 ? 2 : 0, l.percent))}%` }} />
              </div>
              <p className={cn("mt-1.5 text-[12px]", l.state === "ok" ? "text-muted" : l.state === "warning" ? "text-warning-ink" : "text-danger-ink")}>
                {l.state === "ok" ? `${number(l.remaining)} left` : l.state === "warning" ? `${number(l.remaining)} left. ${STATE_TEXT.warning}.` : usage.hardStop ? "New work waits until next month, or until your limit is raised." : "You’re over this limit. Work continues, and your agency has been told."}
                {l.custom ? " (A limit set for your workspace.)" : ""}
              </p>
            </li>
          ))}
        </ul>
        {usage.note && <p className="mt-3 flex items-start gap-1.5 text-[13px] text-muted"><CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />{usage.note}</p>}
      </section>

      <section aria-labelledby="usage-activity">
        <h2 id="usage-activity" className="text-[16px] font-semibold text-ink">What ran</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {usage.counters.map((c) => (
            <div key={c.label} className="rounded-2xl border border-line bg-surface px-4 py-3">
              <dt className="text-[12px] text-muted">{c.label}</dt>
              <dd className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{number(c.quantity)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="usage-workflows">
        <h2 id="usage-workflows" className="text-[16px] font-semibold text-ink">Your automations</h2>
        {workflows.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-line-strong p-6 text-center text-[14px] text-muted">You haven’t built an automation yet. <Link href="/automation-studio" className="font-medium text-primary hover:underline">Start one</Link>.</p>
        ) : (
          <Card className="mt-3">
            <ul className="divide-y divide-line">
              {workflows.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <Link href={`/automation-studio/${w.id}`} className="block truncate text-[14px] font-medium text-ink hover:text-primary">{w.name}</Link>
                    <p className="text-[12px] text-muted">{w.stepCount} step{w.stepCount === 1 ? "" : "s"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={w.status === "active" ? "success" : w.status === "paused" ? "warning" : "neutral"}>{w.status === "paused" && w.pausedForPlan ? "Paused: plan" : w.status === "active" ? "On" : w.status === "paused" ? "Paused" : "Draft"}</Badge>
                    {canManage && w.status === "active" && (
                      <Button size="sm" variant="ghost" loading={busy(`off-${w.id}`)} onClick={() => void run(`off-${w.id}`, () => setStudioWorkflowStatusAction(w.id, "paused"), "Paused. Runs already started finish their current step and wait.")}><Pause className="size-3.5" aria-hidden />Pause</Button>
                    )}
                    {canManage && plan.entitled && w.status === "paused" && !w.pausedForPlan && (
                      <Button size="sm" variant="ghost" loading={busy(`on-${w.id}`)} onClick={() => void run(`on-${w.id}`, () => setStudioWorkflowStatusAction(w.id, "active"), "Turned on.")}><Play className="size-3.5" aria-hidden />Turn on</Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
