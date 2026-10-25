"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, MessageCircleQuestion, Plug, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/primitives";
import { OpsStatePill, tileAccent } from "@/components/aqi/ops/state";
import { useOpsConsole } from "@/components/aqi/ops/ops-context";
import { cn } from "@/lib/utils";
import type { OpsOverview } from "@/lib/aqi/ops/types";

export function OpsOverviewSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the operations overview" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-[132px] rounded-2xl" />)}
    </div>
  );
}

/**
 * Real measurements only. A tile that has no data source says so; there are no percentages and no
 * decorative gauges. "Ask AQi" sends a real question; "Open" goes to the module that owns the data.
 */
export function OpsOverviewPanel({ initial, initialError }: { initial: OpsOverview | null; initialError?: string | null }) {
  const [data, setData] = React.useState<OpsOverview | null>(initial);
  const [error, setError] = React.useState<string | null>(initialError ?? null);
  const [busy, setBusy] = React.useState(false);
  const { ask } = useOpsConsole();

  const refresh = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/aqi/ops/overview", { cache: "no-store" });
      if (!res.ok) throw new Error((((await res.json().catch(() => null)) as { error?: string } | null)?.error) ?? "The overview could not be loaded.");
      setData((await res.json()) as OpsOverview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The overview could not be loaded.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section aria-labelledby="ops-overview-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="ops-overview-heading" className="text-[17px] font-semibold tracking-[-0.025em] text-ink">Operations overview</h2>
          <p className="mt-1 text-[13px] text-muted">
            {data ? <>Read from recorded system state at <time dateTime={data.generatedAt} suppressHydrationWarning>{new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> in {data.durationMs} ms. It does not update by itself.</> : "Real figures from the platform, with the source of each."}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}Refresh
        </Button>
      </div>
      {error && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-danger/25 bg-danger-soft/50 px-3 py-2.5 text-[13px] text-danger-ink" role="alert">
          <TriangleAlert className="size-4 shrink-0" aria-hidden /><span className="min-w-0 flex-1">{error} The figures below, if any, may be out of date.</span>
          {!data && <Button size="sm" variant="secondary" onClick={() => void refresh()}>Try again</Button>}
        </div>
      )}
      {!data ? (busy ? <OpsOverviewSkeleton /> : null) : (
        <>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Operational indicators">
            {data.tiles.map((t) => (
              <li key={t.key} className={cn("relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface p-4 shadow-soft before:absolute before:inset-y-0 before:left-0 before:w-1", tileAccent[t.state])}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 text-[12.5px] font-medium text-muted">{t.label}</h3>
                  <OpsStatePill state={t.state} size="sm" />
                </div>
                <p className="mt-2 text-[20px] font-semibold leading-tight tracking-[-0.03em] text-ink">{t.headline}</p>
                <p className="mt-1 flex-1 text-[12.5px] leading-relaxed text-muted">{t.detail}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
                  <Link href={t.href} className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-line px-2 font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">Open<ArrowUpRight className="size-3" aria-hidden /></Link>
                  <button type="button" onClick={() => ask(t.ask)} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 font-medium text-primary-ink hover:bg-primary-soft">
                    <MessageCircleQuestion className="size-3.5" aria-hidden />Ask AQi
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {data.notConfigured.length > 0 && (
            <details className="mt-3 rounded-xl border border-line bg-surface-2/50 px-3 py-2.5 text-[12.5px] text-muted">
              <summary className="flex cursor-pointer select-none items-center gap-2 font-medium text-ink-2"><Plug className="size-3.5" aria-hidden />Not measured in this deployment ({data.notConfigured.length})</summary>
              <ul className="mt-2 space-y-1.5">
                {data.notConfigured.map((n) => <li key={n.label}><span className="font-medium text-ink-2">{n.label}.</span> Needs: {n.needs}</li>)}
              </ul>
              <p className="mt-2">These are shown as unknown rather than healthy: silence from a source that is not connected is not evidence that nothing is wrong.</p>
            </details>
          )}
        </>
      )}
    </section>
  );
}
