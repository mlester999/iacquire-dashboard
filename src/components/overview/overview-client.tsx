"use client";

import * as React from "react";
import { Activity, ArrowUpRight } from "lucide-react";
import { AreaChart, Funnel, StatTile } from "@/components/charts";
import { EmptyState } from "@/components/ui/primitives";
import { StatusPill, type StatusTone } from "@/components/ui/status";
import { IconTile } from "@/components/overview/panel";
import Link from "next/link";
import { cn } from "@/lib/utils";

const ACCENT_TONE: Record<"primary" | "violet" | "success" | "warning", StatusTone> = { primary: "primary", violet: "violet", success: "success", warning: "warning" };

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
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5 [&>*:last-child]:col-span-2 xl:[&>*:last-child]:col-span-1">
        {tiles.slice(0, 5).map((t, i) => (
          <StatTile key={t.key} index={i} label={t.label} icon={t.icon} definition={t.definition} href={t.href} accent={t.accent} value={t.value} unavailableReason={t.unavailableReason} />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5 [&>*:last-child]:col-span-2 xl:[&>*:last-child]:col-span-1">
        {tiles.slice(5).map((tile) => (
          <li key={tile.key} className="min-w-0">
            <Link
              href={tile.href}
              title={tile.unavailableReason ?? tile.definition}
              className={cn("card-surface group flex h-full min-w-0 items-center gap-3 rounded-2xl p-3.5 transition duration-200 hover:-translate-y-0.5 hover:shadow-float sm:p-4")}
            >
              <IconTile tone={ACCENT_TONE[tile.accent]} size="md">
                {tile.icon}
              </IconTile>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium leading-snug text-muted">{tile.label}</span>
                {tile.value === null ? (
                  <StatusPill tone="neutral" size="sm" className="mt-1">
                    Not available
                  </StatusPill>
                ) : (
                  <strong className="mt-0.5 block text-[22px] font-semibold leading-none tracking-tight tabular-nums text-ink">{tile.value.toLocaleString()}</strong>
                )}
              </span>
              <ArrowUpRight className="size-4 shrink-0 self-start text-faint transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function ActivityChart({ data }: { data: Array<{ x: string; y: number }> }) {
  const total = data.reduce((s, d) => s + d.y, 0);
  if (!total) {
    return (
      <EmptyState
        compact
        className="min-h-[220px] rounded-xl bg-surface-2/60 ring-1 ring-inset ring-line"
        icon={<Activity className="size-5" />}
        title="Your activity story starts here"
        description="No AI activity has been recorded yet. Once your employees are verified and you start working together, real activity appears here."
        action={<StatusPill tone="neutral">0 recorded messages</StatusPill>}
      />
    );
  }
  return <AreaChart data={data} label="AI messages per day" unit="messages" formatX={(x) => dayFmt.format(new Date(`${x}T00:00:00Z`))} />;
}

export function OverviewFunnel({ stages }: { stages: Array<{ label: string; value: number | null; source?: string }> }) {
  return <Funnel stages={stages} />;
}
