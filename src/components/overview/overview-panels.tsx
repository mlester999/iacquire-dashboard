import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, ArrowUpRight, CalendarClock, Check, CheckCircle2, ChevronDown, ChevronRight, ClipboardCheck, Clock, Cog, Info, ListChecks, Sparkles, XCircle } from "lucide-react";
import { AgentAvatar, AgentStatusBadge } from "@/components/brand";
import { Card, EmptyState, ProgressBar } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { IconTile, TINT } from "@/components/overview/panel";
import { describeAction } from "@/lib/activity";
import { AGENT_BY_KEY, agentIdentityLabel, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { cn, relativeTime } from "@/lib/utils";

/** The next best steps, as three actionable cards instead of a dark text band. */
export function NextActions({ actions }: { actions: Array<{ title: string; body: string; href: string; cta: string }> }) {
  if (!actions.length) return null;
  return (
    <section aria-label="What needs your attention" className="card-surface relative overflow-hidden rounded-2xl">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] bg-gradient-to-r from-primary to-violet" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-primary-soft/70 to-transparent" />
      <div className="relative flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div className="flex items-center gap-3">
          <IconTile tone="primary" className="size-10">
            <Sparkles />
          </IconTile>
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">Needs your attention</h2>
            <p className="text-[12.5px] text-muted">The quickest ways to keep things moving.</p>
          </div>
        </div>
        <StatusPill tone="primary">{actions.length === 1 ? "1 next step" : `${actions.length} next steps`}</StatusPill>
      </div>
      <ul className={cn("relative grid gap-3 p-4 sm:p-5", actions.length >= 3 ? "md:grid-cols-3" : actions.length === 2 ? "md:grid-cols-2" : "")}>
        {actions.map((a, i) => (
          <li key={a.title} className="min-w-0">
            <Link
              href={a.href}
              className="group flex h-full flex-col gap-3 rounded-2xl bg-surface p-4 ring-1 ring-inset ring-line transition duration-200 hover:-translate-y-0.5 hover:shadow-card hover:ring-line-strong"
            >
              <div className="flex items-center justify-between gap-3">
                <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-primary-soft text-[12px] font-semibold tabular-nums text-primary-ink ring-1 ring-inset ring-primary/20">
                  {i + 1}
                </span>
                <ArrowUpRight className="size-4 text-faint transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold leading-snug text-ink">{a.title}</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{a.body}</p>
              </div>
              <span className="mt-auto inline-flex items-center gap-1 text-[12.5px] font-semibold text-primary-ink">
                {a.cta}
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const ALERT_TONE = {
  critical: { tone: "danger", label: "Critical", Icon: XCircle },
  warning: { tone: "warning", label: "Heads up", Icon: AlertTriangle },
  info: { tone: "primary", label: "For your info", Icon: Info },
} as const;

export function AlertsList({ alerts }: { alerts: Array<{ tone: "warning" | "critical" | "info"; title: string; body: string; href: string }> }) {
  if (alerts.length === 0) {
    return <EmptyState compact icon={<CheckCircle2 className="size-5" />} title="All clear" description="Nothing needs your attention right now." />;
  }
  return (
    <ul className="space-y-2.5">
      {alerts.map((a, i) => {
        const t = ALERT_TONE[a.tone];
        return (
          <li key={i}>
            <Link href={a.href} className={cn("group flex items-start gap-3 rounded-xl border p-3 transition hover:-translate-y-px hover:shadow-card", TINT[t.tone].row)}>
              <IconTile tone={t.tone}>
                <t.Icon />
              </IconTile>
              <span className="min-w-0 flex-1">
                <StatusPill tone={t.tone} size="sm">
                  {t.label}
                </StatusPill>
                <span className="mt-1.5 block text-[13px] font-semibold leading-snug text-ink">{a.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted">{a.body}</span>
              </span>
              <ChevronRight className="mt-1 size-4 shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function TeamGrid({ agents }: { agents: Array<{ id: string; role_key: AgentRoleKey; display_name: string; enabled: boolean; status: AgentStatus }> }) {
  return (
    <ul className="grid grid-cols-1 h-full auto-rows-fr gap-3 sm:grid-cols-2">
      {agents.map((a) => {
        const meta = AGENT_BY_KEY[a.role_key];
        return (
          <li key={a.id} className="min-w-0">
            <Link
              href={a.enabled ? `/chat/${meta.slug}` : `/employees/${meta.slug}`}
              className="group flex h-full items-center gap-3 rounded-2xl border border-line bg-surface p-3.5 transition duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-card"
            >
              <AgentAvatar role={meta} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-semibold text-ink" title={agentIdentityLabel(a.display_name, meta)}>
                  {agentIdentityLabel(a.display_name, meta)}
                </p>
                <p className="mt-0.5 line-clamp-1 text-[12px] leading-snug text-muted" title={meta.tagline}>
                  {meta.tagline}
                </p>
                <div className="mt-2">
                  <AgentStatusBadge status={a.enabled ? a.status : "disabled"} size="sm" />
                </div>
              </div>
              <ArrowUpRight className="size-4 shrink-0 self-start text-faint transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function FollowUps({ tasks }: { tasks: Array<{ id: string; title: string; due_at: string | Date | null; overdue: boolean }> }) {
  if (tasks.length === 0) {
    return <EmptyState compact icon={<ClipboardCheck className="size-5" />} title="You're all caught up" description="Follow-ups your team adds will appear here, soonest first." />;
  }
  return (
    <ul className="space-y-2.5">
      {tasks.map((t) => (
        <li key={t.id} className={cn("flex items-start gap-3 rounded-xl border p-3", t.overdue ? TINT.danger.row : "border-line bg-surface")}>
          <IconTile tone={t.overdue ? "danger" : "neutral"}>
            <CalendarClock />
          </IconTile>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium leading-snug text-ink">{t.title}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {t.due_at ? (
                <>
                  {t.overdue && <StatusPill tone="danger" size="sm">Overdue</StatusPill>}
                  <InfoChip icon={<Clock />}>{t.overdue ? relativeTime(t.due_at) : `Due ${relativeTime(t.due_at)}`}</InfoChip>
                </>
              ) : (
                <InfoChip icon={<Clock />}>No due date</InfoChip>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ActivityFeed({ rows }: { rows: Array<{ id: string; action: string; actor: string | null; agent: string | null; result: string; at: string | Date }> }) {
  return (
    <ol className="divide-y divide-line">
      {rows.map((r) => {
        const person = r.actor && r.actor.trim().toLowerCase() !== "system" ? r.actor : null;
        const failed = r.result !== "success";
        return (
          <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            {person ? (
              <AvatarTile name={person} size="sm" />
            ) : (
              <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2 ring-1 ring-inset ring-line-strong">
                <Cog className="size-3.5" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug text-ink-2">
                <span className="font-semibold text-ink">{person ?? "iAcquire system"}</span> {describeAction(r.action, r.agent)}
              </p>
              <p className="mt-0.5 text-[12px] text-muted" suppressHydrationWarning>
                {relativeTime(r.at)}
              </p>
            </div>
            {failed && (
              <StatusPill tone={r.result === "denied" ? "warning" : "danger"} size="sm">
                {r.result === "denied" ? "Denied" : "Failed"}
              </StatusPill>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The getting-started checklist, collapsed by default so it never crowds the dashboard. */
export function SetupChecklist({ steps }: { steps: Array<{ key: string; label: string; href: string; done: boolean }> }) {
  const done = steps.filter((s) => s.done).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  return (
    <Card className="overflow-hidden">
      <details className="group">
        <summary className="flex min-h-[76px] cursor-pointer list-none flex-wrap items-center gap-x-3.5 gap-y-2 px-5 py-4 transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
          <IconTile tone="primary" size="lg">
            <ListChecks />
          </IconTile>
          <span className="min-w-0 flex-1 basis-48">
            <span className="block text-[15px] font-semibold tracking-tight text-ink">Make the workspace yours</span>
            <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">Getting-started steps. Your full system setup is tracked separately.</span>
          </span>
          <StatusPill tone={done === steps.length ? "success" : "primary"}>
            {done} of {steps.length} done
          </StatusPill>
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="space-y-4 border-t border-line p-5">
          <ProgressBar value={pct} label="Getting-started progress" />
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {steps.map((s) => (
              <li key={s.key}>
                <Link
                  href={s.href}
                  className={cn(
                    "group/step flex min-h-11 items-center gap-2.5 rounded-xl border px-3 py-2 text-[13px] transition hover:-translate-y-px hover:shadow-card",
                    s.done ? TINT.success.row : "border-line bg-surface hover:border-line-strong",
                  )}
                >
                  <IconTile tone={s.done ? "success" : "neutral"} size="sm">
                    {s.done ? <Check /> : <span className="size-1.5 rounded-full bg-faint" />}
                  </IconTile>
                  <span className={cn("min-w-0 flex-1 truncate", s.done ? "font-medium text-success-ink" : "text-ink-2")} title={s.label}>
                    {s.label}
                  </span>
                  {s.done ? <span className="sr-only">Done</span> : <ChevronRight className="size-3.5 shrink-0 text-faint transition group-hover/step:translate-x-0.5 group-hover/step:text-ink" aria-hidden />}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </Card>
  );
}
