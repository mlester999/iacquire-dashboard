import { Badge, ProgressBar } from "@/components/ui/primitives";
import { CAPACITY_NOT_SET_TEXT, formatPoints } from "@/lib/staff-workload/rules";
import { LABEL_TEXT, type WorkloadResult } from "@/lib/staff-workload/labels";
import { LABEL_TONE, loadTone, percentText, SOURCE_SHORT } from "@/lib/staff-workload/screens";
import type { WorkSource } from "@/lib/staff-workload/sources";
import { cn } from "@/lib/utils";

/** A label pill with the reason a missing one is missing, never a made-up number. */
export function LabelPill({ result, className }: { result: Pick<WorkloadResult, "label" | "capacitySource" | "capacityPoints">; className?: string }) {
  if (!result.label) {
    return (
      <Badge tone="outline" className={className} title={CAPACITY_NOT_SET_TEXT}>
        {CAPACITY_NOT_SET_TEXT}
      </Badge>
    );
  }
  return (
    <Badge tone={LABEL_TONE[result.label]} className={className}>
      {LABEL_TEXT[result.label]}
    </Badge>
  );
}

/** Points against capacity, with the percentage the label was based on. */
export function LoadMeter({ result, compact = false }: { result: WorkloadResult; compact?: boolean }) {
  const percent = result.ratioPercent;
  return (
    <div className={cn("min-w-0", compact ? "space-y-1" : "space-y-1.5")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[12.5px]">
        <span className="font-medium text-ink">
          {formatPoints(result.pointsCenti)} pts
          {result.capacity !== null ? <span className="font-normal text-muted"> / {result.capacity} capacity</span> : <span className="font-normal text-muted"> · {CAPACITY_NOT_SET_TEXT.toLowerCase()}</span>}
        </span>
        <span className="tabular-nums text-muted">{percentText(percent)}</span>
      </div>
      <ProgressBar value={percent ?? 0} tone={loadTone(percent)} label={`${percentText(percent)} of capacity`} />
      <p className="text-[11.5px] text-muted">
        {result.items} open {result.items === 1 ? "item" : "items"}
        {result.overdue > 0 ? ` · ${result.overdue} overdue` : ""}
        {result.escalated > 0 ? ` · ${result.escalated} escalated` : ""}
        {result.away ? " · away" : ""}
      </p>
    </div>
  );
}

export function SourceBadge({ source }: { source: WorkSource }) {
  return (
    <Badge tone="outline" className="h-5 px-2 text-[11px]">
      {SOURCE_SHORT[source]}
    </Badge>
  );
}

/** A number and a word, the shape every summary tile on the workload pages uses. */
export function StatTile({ label, value, detail, tone = "text-ink" }: { label: string; value: number | string; detail?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 shadow-soft">
      <p className={cn("text-[22px] font-semibold leading-none tracking-[-0.03em] tabular-nums", tone)}>{value}</p>
      <p className="mt-1 text-[12.5px] font-medium text-ink-2">{label}</p>
      {detail && <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{detail}</p>}
    </div>
  );
}
