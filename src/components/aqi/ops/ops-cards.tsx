"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Copy, Info, Loader2, OctagonAlert, RefreshCw, TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { isSafeOpsHref } from "@/lib/aqi/ops/links";
import { cn } from "@/lib/utils";
import { OpsEmployeePill, OpsStatePill } from "@/components/aqi/ops/state";
import { ActionPreview, ActionResult } from "@/components/aqi/ops/ops-action";
import {
  OPS_EMPLOYEE_STATE_LABEL,
  type OpsBriefingCard,
  type OpsCard,
  type OpsChartCard,
  type OpsEmployeesCard,
  type OpsHealthCard,
  type OpsIncidentsCard,
  type OpsMetric,
  type OpsMetricsCard,
  type OpsNoticeCard,
  type OpsScopePickerCard,
  type OpsTableCard,
  type OpsTicketsCard,
  type OpsTimelineCard,
  type OpsWorkspaceCard,
} from "@/lib/aqi/ops/types";

type PickScope = (option: OpsScopePickerCard["options"][number]) => void;

export interface OpsCardViewProps {
  card: OpsCard;
  onRefresh?: (card: OpsCard) => Promise<string | null>;
  onPickScope?: PickScope;
  onActionOutcome: (actionId: string, cards: OpsCard[]) => void;
}

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown time" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const dateTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown time" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** A link only if it is a safe internal admin path; otherwise the label is shown as plain text, never as a broken control. */
export function SafeLink({ href, children, className }: { href?: string | null; children: React.ReactNode; className?: string }) {
  if (!href || !isSafeOpsHref(href)) return <span className={className}>{children}</span>;
  return <Link href={href} className={cn("font-medium text-primary-ink underline-offset-2 hover:underline", className)}>{children}</Link>;
}

function Chrome({ card, children, onRefresh }: { card: Exclude<OpsCard, { kind: "action_preview" | "action_result" }>; children: React.ReactNode; onRefresh?: OpsCardViewProps["onRefresh"] }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();
  async function refresh() {
    if (!onRefresh || busy) return;
    setBusy(true);
    setError(null);
    setError(await onRefresh(card));
    setBusy(false);
  }
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-2xl border border-line bg-surface shadow-soft">
      <header className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <h3 id={id} className="min-w-0 text-[13.5px] font-semibold leading-snug tracking-[-0.01em] text-ink">{card.title}</h3>
        {card.refresh && onRefresh && (
          <Button variant="ghost" size="icon-sm" onClick={() => void refresh()} disabled={busy} aria-label={`Refresh ${card.title}`} title="Re-read this from the system">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
          </Button>
        )}
      </header>
      <div className="px-4 pb-3.5 pt-2.5">{children}</div>
      {error && <p className="mx-4 mb-3 flex items-start gap-1.5 text-[12.5px] text-danger-ink" role="alert"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />{error}</p>}
      <footer className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line px-4 py-2 text-[11.5px] text-muted">
        <span>As of <time dateTime={card.asOf} suppressHydrationWarning>{time(card.asOf)}</time></span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate" title={card.source}>{card.source}</span>
      </footer>
    </section>
  );
}

function Disclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group mt-3 rounded-xl border border-line bg-surface-2/50 px-3 py-2 text-[12.5px] text-muted">
      <summary className="cursor-pointer select-none font-medium text-ink-2 marker:text-faint">{summary}</summary>
      <div className="mt-2 leading-relaxed">{children}</div>
    </details>
  );
}

function MetricGrid({ metrics }: { metrics: OpsMetric[] }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {metrics.map((m) => (
        <div key={m.label} className="min-w-0 rounded-xl border border-line bg-surface-2/50 px-3 py-2.5">
          <dt className="text-[11.5px] font-medium text-muted">{m.label}</dt>
          <dd className="mt-0.5 text-[16px] font-semibold tabular-nums leading-tight text-ink">{m.value}</dd>
          {(m.detail || m.state) && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] leading-snug text-muted">
              {m.state && <OpsStatePill state={m.state} size="sm" />}
              {m.detail && <span>{m.detail}</span>}
            </div>
          )}
        </div>
      ))}
    </dl>
  );
}

function Links({ links }: { links: Array<{ label: string; href: string }> }) {
  const safe = links.filter((l) => isSafeOpsHref(l.href));
  if (!safe.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {safe.map((l) => (
        <Link key={l.href + l.label} href={l.href} className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
          {l.label}<ArrowUpRight className="size-3" aria-hidden />
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Health({ card }: { card: OpsHealthCard }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2"><OpsStatePill state={card.state} /><p className="text-[13px] text-ink-2">{card.summary}</p></div>
      <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
        {card.components.map((c) => (
          <li key={c.key} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[170px_auto_1fr] sm:items-start sm:gap-3">
            <span className="text-[13px] font-medium text-ink">{c.href ? <SafeLink href={c.href}>{c.label}</SafeLink> : c.label}</span>
            <span><OpsStatePill state={c.state} size="sm" /></span>
            <span className="text-[12.5px] leading-relaxed text-muted">{c.detail}</span>
          </li>
        ))}
      </ul>
      {card.unavailable.length > 0 && (
        <Disclosure summary={`Not measurable here (${card.unavailable.length})`}>
          <ul className="list-disc space-y-1 pl-4">{card.unavailable.map((u) => <li key={u}>{u}</li>)}</ul>
        </Disclosure>
      )}
      <Links links={card.links} />
    </>
  );
}

function Incidents({ card }: { card: OpsIncidentsCard }) {
  if (!card.rows.length) return <p className="text-[13px] text-muted">No incidents matched. This only means none are recorded: incident collectors run from the scheduler.</p>;
  return (
    <>
      <p className="mb-2 text-[12.5px] text-muted">{card.open} open{card.critical ? `, ${card.critical} critical` : ""}{card.truncated ? ". Showing the most severe." : ""}</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {card.rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5">
            <StatusPill tone={r.severity === "critical" ? "danger" : r.severity === "warning" ? "warning" : "neutral"} icon={r.severity === "critical" ? <OctagonAlert className="size-3.5" aria-hidden /> : <TriangleAlert className="size-3.5" aria-hidden />}>{r.severity}</StatusPill>
            <div className="min-w-0 flex-1">
              <SafeLink href={r.href} className="text-[13px]">{r.title}</SafeLink>
              <p className="mt-0.5 text-[12px] text-muted">{[r.org ?? "Platform", r.source, `${r.status}`, `seen ${r.occurrences}×`, `first ${dateTime(r.detectedAt)}`].join(" · ")}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function Workspace({ card }: { card: OpsWorkspaceCard }) {
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2"><OpsStatePill state={card.state} /><span className="text-[13px] text-muted">Workspace is {card.status}</span></div>
      <MetricGrid metrics={card.metrics} />
      <h4 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-muted">{card.blockers.length ? `${card.blockers.length} blocker${card.blockers.length === 1 ? "" : "s"} found` : "Blockers"}</h4>
      {card.blockers.length ? (
        <ul className="mt-1.5 space-y-2">
          {card.blockers.map((b) => (
            <li key={b.title + b.detail} className="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft/50 px-3 py-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden />
              <div className="min-w-0 text-[13px]"><SafeLink href={b.href} className="font-semibold text-ink">{b.title}</SafeLink><p className="text-[12.5px] leading-relaxed text-muted">{b.detail}</p></div>
            </li>
          ))}
        </ul>
      ) : <p className="mt-1.5 text-[13px] text-muted">No blockers are recorded for this workspace.</p>}
      <Links links={card.links} />
    </>
  );
}

function Employees({ card }: { card: OpsEmployeesCard }) {
  const counts = Object.entries(card.counts).filter(([, n]) => n);
  return (
    <>
      <div className="flex flex-wrap gap-1.5">{counts.map(([state, n]) => <span key={state} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-ink-2"><strong className="tabular-nums text-ink">{n}</strong>{OPS_EMPLOYEE_STATE_LABEL[state as keyof typeof OPS_EMPLOYEE_STATE_LABEL]}</span>)}</div>
      {card.rows.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
          {card.rows.map((r) => (
            <li key={r.id} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(0,200px)_auto_1fr] sm:items-start sm:gap-3">
              <span className="min-w-0 text-[13px]"><SafeLink href={r.href} className="text-ink">{r.name}</SafeLink><span className="block truncate text-[12px] text-muted">{r.role} · {r.org}</span></span>
              <span><OpsEmployeePill state={r.state} /></span>
              <span className="text-[12.5px] leading-relaxed text-muted">{r.evidence}</span>
            </li>
          ))}
        </ul>
      )}
      {card.truncated && <p className="mt-2 text-[12px] text-muted">Showing the employees that most need attention first.</p>}
      <Disclosure summary="How these states are determined">
        <ul className="list-disc space-y-1 pl-4">{card.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </Disclosure>
    </>
  );
}

const TONE_DOT = { neutral: "bg-faint", success: "bg-success", warning: "bg-warning", danger: "bg-danger" } as const;

function Timeline({ card }: { card: OpsTimelineCard }) {
  return (
    <>
      {card.verdict && <p className="mb-3 text-[13px] text-ink-2">{card.verdict}</p>}
      {card.events.length > 0 && (
        <ol className="relative ml-1.5 space-y-3 border-l border-line pl-4">
          {card.events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="relative">
              <span className={cn("absolute -left-[21px] top-1.5 size-2.5 rounded-full ring-2 ring-surface", TONE_DOT[e.tone ?? "neutral"])} aria-hidden />
              <p className="text-[12.5px] font-medium text-ink"><time dateTime={e.at} suppressHydrationWarning className="mr-2 font-normal text-muted">{dateTime(e.at)}</time>{e.label}</p>
              {e.detail && <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{e.detail}</p>}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Tickets({ card }: { card: OpsTicketsCard }) {
  return (
    <>
      <p className="mb-2 text-[12.5px] text-muted">{card.total} matching request{card.total === 1 ? "" : "s"}{card.total > card.rows.length ? `, showing ${card.rows.length}` : ""}</p>
      {card.groups && card.groups.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5">{card.groups.map((g) => <span key={g.label} className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[12px] text-ink-2">{g.label} <strong className="tabular-nums">{g.count}</strong></span>)}</div>}
      {card.rows.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {card.rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5">
              <SafeLink href={r.href} className="font-mono text-[12px]">{r.ref}</SafeLink>
              <div className="min-w-0 flex-1 text-[13px]"><span className="text-ink">{r.subject}</span><p className="text-[12px] text-muted">{r.org} · {r.type} · {r.ageHours} h old</p></div>
              <span className="flex flex-wrap items-center gap-1.5">
                <StatusPill status={r.priority} size="sm" />
                <StatusPill status={r.status} size="sm" />
                {r.escalated && <StatusPill tone="violet" size="sm">Escalated</StatusPill>}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="text-[13px] text-muted">Nothing to show.</p>}
    </>
  );
}

function DataTable({ card }: { card: OpsTableCard }) {
  return (
    <>
      {card.caption && <p className="mb-2 text-[12.5px] text-muted">{card.caption}</p>}
      {card.rows.length ? (
        <div className="scrollbar-thin overflow-x-auto rounded-xl border border-line" role="region" aria-label={card.title} tabIndex={0}>
          <table className="min-w-full text-left text-[12.5px]">
            <thead className="bg-surface-2 text-[11.5px] uppercase tracking-wide text-muted">
              <tr>{card.columns.map((c) => <th key={c.key} scope="col" className={cn("whitespace-nowrap px-3 py-2 font-medium", c.align === "right" && "text-right")}>{c.label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {card.rows.map((row, i) => (
                <tr key={i}>
                  {card.columns.map((c, ci) => {
                    const value = row[c.key];
                    const text = value === null || value === undefined ? "—" : String(value);
                    const href = ci === 0 && typeof row._href === "string" ? row._href : null;
                    return <td key={c.key} className={cn("px-3 py-2 align-top text-ink-2", c.align === "right" && "text-right tabular-nums", ci === 0 && "font-medium text-ink")}>{href ? <SafeLink href={href}>{text}</SafeLink> : text}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-[13px] text-muted">Nothing to show for this selection.</p>}
      {card.truncated && <p className="mt-2 text-[12px] text-muted">More rows exist than are shown.</p>}
    </>
  );
}

function Chart({ card }: { card: OpsChartCard }) {
  const max = Math.max(...card.series.map((s) => s.value), 0);
  return (
    <>
      {card.caption && <p className="mb-2 text-[12.5px] text-muted">{card.caption}</p>}
      <ul className="space-y-2" aria-label={`${card.title} (${card.unit})`}>
        {card.series.map((s) => (
          <li key={s.label} className="grid grid-cols-[minmax(0,140px)_1fr_auto] items-center gap-3 text-[12.5px]">
            <span className="truncate text-ink-2" title={s.label}>{s.label}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-surface-3" aria-hidden><span className="block h-full rounded-full bg-primary" style={{ width: `${max > 0 ? Math.max(2, (s.value / max) * 100) : 0}%` }} /></span>
            <span className="tabular-nums font-medium text-ink">{s.value.toLocaleString("en-US")} <span className="font-normal text-muted">{card.unit}</span>{s.detail ? <span className="ml-1 font-normal text-muted">· {s.detail}</span> : null}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Metrics({ card }: { card: OpsMetricsCard }) {
  return (
    <>
      {card.period && <p className="mb-2 text-[12.5px] text-muted">{card.period}</p>}
      <MetricGrid metrics={card.metrics} />
      {card.methodology && <Disclosure summary="How this is calculated">{card.methodology}</Disclosure>}
      {card.caveats && card.caveats.length > 0 && (
        <ul className="mt-3 space-y-1.5">{card.caveats.map((c) => <li key={c} className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-muted"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{c}</li>)}</ul>
      )}
    </>
  );
}

function Briefing({ card }: { card: OpsBriefingCard }) {
  return (
    <>
      <p className="text-[13px] text-ink-2">{card.summary}</p>
      <p className="mt-1 text-[12px] text-muted">Reporting period {dateTime(card.period.from)} to {dateTime(card.period.to)} ({card.period.hours} h)</p>
      <div className="mt-3 space-y-3">
        {card.sections.map((s) => (
          <section key={s.key} aria-label={s.title} className="rounded-xl border border-line px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2"><h4 className="text-[13px] font-semibold text-ink">{s.title}</h4><OpsStatePill state={s.state} size="sm" /></div>
            <ul className="mt-1.5 space-y-1">{s.items.map((it) => <li key={it.text} className="text-[12.5px] leading-relaxed text-muted">{it.href ? <SafeLink href={it.href}>{it.text}</SafeLink> : it.text}</li>)}</ul>
          </section>
        ))}
      </div>
      {card.recommended.length > 0 && (
        <div className="mt-3 rounded-xl border border-primary/20 bg-primary-soft/50 px-3 py-2.5">
          <h4 className="text-[12px] font-semibold uppercase tracking-wide text-primary-ink">Recommended next steps</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[12.5px] text-ink-2">{card.recommended.map((r) => <li key={r.text}>{r.href ? <SafeLink href={r.href}>{r.text}</SafeLink> : r.text}</li>)}</ul>
        </div>
      )}
      <Disclosure summary={`Data sources (${card.sources.length})`}><ul className="list-disc space-y-1 pl-4">{card.sources.map((s) => <li key={s}>{s}</li>)}</ul></Disclosure>
    </>
  );
}

function ScopePicker({ card, onPick }: { card: OpsScopePickerCard; onPick?: PickScope }) {
  return (
    <>
      <p className="text-[13px] text-ink-2">{card.body}</p>
      {card.options.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {card.options.map((o) => (
            <Button key={o.id} variant="secondary" size="sm" onClick={() => onPick?.(o)} disabled={!onPick}>
              Investigate {o.label}{o.detail ? <span className="font-normal text-muted"> · {o.detail}</span> : null}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

function Notice({ card }: { card: OpsNoticeCard }) {
  const [copied, setCopied] = React.useState(false);
  const Icon = card.tone === "danger" ? OctagonAlert : card.tone === "warning" ? TriangleAlert : Info;
  return (
    <div className={cn("rounded-xl border px-3 py-2.5", card.tone === "danger" ? "border-danger/30 bg-danger-soft/50" : card.tone === "warning" ? "border-warning/30 bg-warning-soft/50" : "border-line bg-surface-2/50")} role={card.tone === "info" ? undefined : "status"}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-ink-2" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink">{card.title}</p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{card.body}</p>
          {card.copyable && (
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => { void navigator.clipboard?.writeText(card.body).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }).catch(() => undefined); }}>
              {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}{copied ? "Copied" : "Copy draft"}
            </Button>
          )}
          {card.links && <Links links={card.links} />}
        </div>
      </div>
    </div>
  );
}

export function OpsCardView({ card, onRefresh, onPickScope, onActionOutcome }: OpsCardViewProps) {
  switch (card.kind) {
    case "action_preview": return <ActionPreview card={card} onOutcome={onActionOutcome} />;
    case "action_result": return <ActionResult card={card} />;
    case "notice": return <Notice card={card} />;
    case "health": return <Chrome card={card} onRefresh={onRefresh}><Health card={card} /></Chrome>;
    case "incidents": return <Chrome card={card} onRefresh={onRefresh}><Incidents card={card} /></Chrome>;
    case "workspace": return <Chrome card={card} onRefresh={onRefresh}><Workspace card={card} /></Chrome>;
    case "employees": return <Chrome card={card} onRefresh={onRefresh}><Employees card={card} /></Chrome>;
    case "timeline": return <Chrome card={card} onRefresh={onRefresh}><Timeline card={card} /></Chrome>;
    case "tickets": return <Chrome card={card} onRefresh={onRefresh}><Tickets card={card} /></Chrome>;
    case "table": return <Chrome card={card} onRefresh={onRefresh}><DataTable card={card} /></Chrome>;
    case "chart": return <Chrome card={card} onRefresh={onRefresh}><Chart card={card} /></Chrome>;
    case "metrics": return <Chrome card={card} onRefresh={onRefresh}><Metrics card={card} /></Chrome>;
    case "briefing": return <Chrome card={card} onRefresh={onRefresh}><Briefing card={card} /></Chrome>;
    case "scope_picker": return <Chrome card={card} onRefresh={onRefresh}><ScopePicker card={card} onPick={onPickScope} /></Chrome>;
    default: return null;
  }
}
