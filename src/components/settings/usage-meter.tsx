import * as React from "react";
import { ProgressBar } from "@/components/ui/primitives";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { IconTile } from "@/components/settings/panel";
import { cn } from "@/lib/utils";

/** One measured quantity: an icon tile and name, a state pill, the figure against its allowance, and a bar when there is a cap. */
export function UsageMeter({
  icon,
  label,
  window,
  value,
  limit,
  percent,
  tone,
  stateLabel,
  hint,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  window?: string;
  value: string;
  limit?: string | null;
  /** 0 to 100, or null when there is no cap. */
  percent: number | null;
  tone: StatusTone;
  stateLabel: string;
  hint?: React.ReactNode;
  className?: string;
}) {
  const barTone = tone === "danger" ? "danger" : tone === "warning" ? "warning" : tone === "success" ? "success" : "primary";
  return (
    <div className={cn("flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-4", className)}>
      <div className="flex items-start gap-3">
        <IconTile icon={icon} tone={tone === "neutral" ? "neutral" : tone} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold leading-snug text-ink">{label}</p>
          {window && <p className="mt-0.5 text-[12px] text-muted">{window}</p>}
        </div>
        <StatusPill tone={tone} size="sm">{stateLabel}</StatusPill>
      </div>
      <p className="mt-4 flex flex-wrap items-baseline gap-x-1.5 text-[24px] font-semibold leading-none tracking-[-0.03em] text-ink tabular-nums">
        {value}
        {limit && <span className="text-[14px] font-medium tracking-normal text-muted">of {limit}</span>}
        {percent !== null && <InfoChip className="ml-auto self-center tabular-nums">{Math.round(percent)}%</InfoChip>}
      </p>
      {percent !== null && <ProgressBar className="mt-3.5" tone={barTone} value={percent} label={`${label} used`} />}
      {hint && <p className="mt-3 text-[13px] leading-relaxed text-muted">{hint}</p>}
    </div>
  );
}
