import * as React from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Module identity and context, with space for meaningful status or structural visuals. */
export function PageHero({ eyebrow = "iAcquire workspace", title, description, action, aside, icon, tone = "blue", children, className, target }: {
  eyebrow?: string; title: string; description?: React.ReactNode; action?: React.ReactNode;
  aside?: React.ReactNode; icon?: React.ReactNode; tone?: "blue" | "dark" | "neutral";
  children?: React.ReactNode; className?: string;
  /** Approved AQi guidance target id. Never a CSS selector. */
  target?: string;
}) {
  return <section data-aqi-target={target} className={cn("workspace-hero", `workspace-hero-${tone}`, className)}>
    <div className="relative grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="hero-eyebrow">{icon && <span className="hero-module-icon" aria-hidden>{icon}</span>}{eyebrow}</p>
        <h1 className="mt-3 text-balance text-[26px] font-semibold leading-[1.15] tracking-[-0.045em] sm:text-[32px]">{title}</h1>
        {description && <div className="hero-description mt-3 max-w-2xl text-[14px] leading-[1.7]">{description}</div>}
        {action && <div className="mt-5 flex flex-wrap gap-2">{action}</div>}
      </div>
      {aside && <div className="relative min-w-0 self-center lg:max-w-[340px]">{aside}</div>}
    </div>
    {children && <div className="hero-detail relative mt-6 border-t pt-5">{children}</div>}
  </section>;
}

export function MetricCard({ label, value, detail, icon, tone = "blue", href, className }: {
  label: string; value: React.ReactNode; detail?: React.ReactNode; icon?: React.ReactNode;
  tone?: "blue" | "violet" | "green" | "amber" | "neutral"; href?: string; className?: string;
}) {
  const content = <>
    <div className="flex items-center justify-between gap-3"><span className={cn("metric-icon", `metric-icon-${tone}`)} aria-hidden>{icon}</span>{href && <ArrowUpRight className="size-4 text-faint transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />}</div>
    <p className="mt-4 text-[12px] font-medium text-muted">{label}</p>
    <div className="metric-value mt-1 text-[28px] font-semibold leading-tight tracking-[-0.04em] text-ink sm:text-[32px]">{value}</div>
    {detail && <div className="mt-2 text-[12px] leading-relaxed text-muted">{detail}</div>}
  </>;
  const style = cn("metric-card group min-w-0", className);
  return href ? <Link href={href} className={style}>{content}</Link> : <div className={style}>{content}</div>;
}

export function SectionLabel({ title, description, action, count }: { title: string; description?: React.ReactNode; action?: React.ReactNode; count?: number }) {
  return <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><h2 className="text-[17px] font-semibold tracking-[-0.025em] text-ink">{title}</h2>{count !== undefined && <span className="rounded-md bg-surface-3 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-2">{count}</span>}</div>{description && <div className="mt-1 text-[13px] leading-relaxed text-muted">{description}</div>}</div>{action}</div>;
}

export function DataToolbar({ children, trailing, className }: { children: React.ReactNode; trailing?: React.ReactNode; className?: string }) {
  return <div className={cn("data-toolbar flex flex-wrap items-center justify-between gap-3", className)}><div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>{trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}</div>;
}

/** Accessible segment visualization from real counts, never an illustrative activity chart. */
export function CoverageBar({ parts, label }: { parts: Array<{ label: string; count: number; color: string }>; label: string }) {
  const total = parts.reduce((sum, p) => sum + p.count, 0);
  return <div><div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.count}`).join(", ")}`}>{total > 0 && parts.filter((p) => p.count > 0).map((p) => <span key={p.label} className="h-full transition-[width] duration-700" style={{ width: `${p.count / total * 100}%`, background: p.color }} />)}</div><div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[12px] text-muted">{parts.map((p) => <span key={p.label} className="inline-flex items-center gap-1.5"><i className="size-2 rounded-sm" style={{ background: p.color }} aria-hidden />{p.label}<strong className="font-medium tabular-nums text-ink">{p.count}</strong></span>)}</div></div>;
}
