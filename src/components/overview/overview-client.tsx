"use client";

import * as React from "react";
import { AreaChart, Funnel, StatTile } from "@/components/charts";
import Link from "next/link";

export function KpiGrid({
  tiles,
}: {
  tiles: Array<{
    key: string;
    label: string;
    icon: React.ReactNode;
    definition: string;
    href: string;
    accent: "primary" | "violet" | "success" | "warning";
    value: number | null;
    unavailableReason?: string;
  }>;
}) {
  return (
    <section aria-label="Key metrics" className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5">{tiles.slice(0,5).map((t, i) => (
        <StatTile key={t.key} index={i} label={t.label} icon={t.icon} definition={t.definition} href={t.href} accent={t.accent} value={t.value} unavailableReason={t.unavailableReason} />
      ))}</div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-5">{tiles.slice(5).map(tile=><Link key={tile.key} href={tile.href} title={tile.definition} className="flex min-w-0 items-center gap-3 bg-surface px-4 py-3 transition hover:bg-surface-2"><span className="shrink-0 text-primary">{tile.icon}</span><span className="min-w-0"><span className="block text-[11px] leading-relaxed text-muted">{tile.label}</span><strong className="block text-[20px] font-semibold tracking-tight">{tile.value===null?<span className="text-[11px] font-medium text-muted">Not available</span>:tile.value.toLocaleString()}</strong></span></Link>)}</div>
    </section>
  );
}

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function ActivityChart({ data }: { data: Array<{ x: string; y: number }> }) {
  const total = data.reduce((s, d) => s + d.y, 0);
  if (!total) {
    return (
      <div className="flex h-[220px] flex-col justify-center rounded-xl bg-surface-2/70 px-6">
        <p className="mb-4 text-[36px] font-semibold tracking-[-.04em] text-ink">0<span className="ml-2 text-[12px] font-normal tracking-normal text-muted">recorded messages</span></p>
        <p className="text-[15px] font-semibold text-ink">Your activity story starts here</p>
        <p className="mt-1 max-w-md text-[13px] text-muted">No AI activity has been recorded. Once your employees are verified and you start working together, real activity appears here.</p>
      </div>
    );
  }
  return <AreaChart data={data} label="AI messages per day" unit="messages" formatX={(x) => dayFmt.format(new Date(`${x}T00:00:00Z`))} />;
}

export function OverviewFunnel({ stages }: { stages: Array<{ label: string; value: number | null; source?: string }> }) {
  return <Funnel stages={stages} />;
}
