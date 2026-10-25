import { AlertTriangle, BellRing, CheckCircle2, Clock, OctagonAlert } from "lucide-react";
import type { IncidentRow } from "@/server/ops/incidents";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { cn, relativeTime } from "@/lib/utils";

const TONE: Record<"success" | "danger" | "warning", { strip: string; wash: string; tile: string }> = {
  success: { strip: "from-success to-success/20", wash: "from-success-soft/70", tile: "bg-success-soft text-success-ink ring-success/20" },
  danger: { strip: "from-danger to-danger/20", wash: "from-danger-soft/70", tile: "bg-danger-soft text-danger-ink ring-danger/20" },
  warning: { strip: "from-warning to-warning/20", wash: "from-warning-soft/70", tile: "bg-warning-soft text-warning-ink ring-warning/25" },
};

/**
 * Plain-language notices about the client's own service: a connection that failed, a website that is not being served.
 * Shown to owners and managers only, and only for incidents the agency marked client-visible. Resolved items stay for three days
 * so "it's fixed" is visible, with the honest difference between a verified recovery and one closed by hand.
 */
export function ServiceNotices({ incidents }: { incidents: IncidentRow[] }) {
  if (!incidents.length) return null;
  return (
    <section aria-label="Service notices" className="space-y-3">
      {incidents.map((i) => {
        const resolved = i.status === "resolved";
        const critical = !resolved && i.severity === "critical";
        const tone: "success" | "danger" | "warning" = resolved ? "success" : critical ? "danger" : "warning";
        const pillTone: StatusTone = tone;
        const Icon = resolved ? CheckCircle2 : critical ? OctagonAlert : AlertTriangle;
        return (
          <div key={i.id} role={resolved ? "status" : "alert"} className="card-surface relative overflow-hidden rounded-2xl">
            <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] bg-gradient-to-r", TONE[tone].strip)} />
            <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b to-transparent", TONE[tone].wash)} />
            <div className="relative flex items-start gap-3.5 p-4 sm:p-5">
              <span aria-hidden className={cn("grid size-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset", TONE[tone].tile)}>
                <Icon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={pillTone}>{resolved ? "Fixed" : critical ? "Service issue" : "Needs attention"}</StatusPill>
                  {!resolved && (
                    <InfoChip icon={<Clock />}>
                      <span suppressHydrationWarning>Noticed {relativeTime(i.detectedAt)}</span>
                    </InfoChip>
                  )}
                  {!resolved && <InfoChip icon={<BellRing />}>iAcquire team notified</InfoChip>}
                </div>
                <p className="mt-2.5 text-[14.5px] font-semibold leading-snug text-ink">{i.title}</p>
                <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                  {resolved
                    ? i.resolution === "verified_recovery"
                      ? `A check confirmed this is working again ${i.resolvedAt ? relativeTime(i.resolvedAt) : ""}.`
                      : "The iAcquire team marked this as fixed."
                    : (i.recoveryGuidance ?? i.detail)}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
