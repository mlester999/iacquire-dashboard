import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { IncidentRow } from "@/server/ops/incidents";
import { relativeTime } from "@/lib/utils";

/**
 * Plain-language notices about the client's own service: a connection that failed, a website that is not being served.
 * Shown to owners and managers only, and only for incidents the agency marked client-visible. Resolved items stay for three days
 * so "it's fixed" is visible, with the honest difference between a verified recovery and one closed by hand.
 */
export function ServiceNotices({ incidents }: { incidents: IncidentRow[] }) {
  if (!incidents.length) return null;
  return (
    <section aria-label="Service notices" className="space-y-2">
      {incidents.map((i) => {
        const resolved = i.status === "resolved";
        return (
          <div
            key={i.id}
            role={resolved ? "status" : "alert"}
            className={`flex items-start gap-3 rounded-2xl border px-4 py-3.5 ${resolved ? "border-transparent bg-success-soft/60 text-success-ink" : i.severity === "critical" ? "border-transparent bg-danger-soft text-danger-ink" : "border-transparent bg-warning-soft text-warning-ink"}`}
          >
            {resolved ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold leading-snug">{resolved ? `Fixed: ${i.title}` : i.title}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed">
                {resolved
                  ? i.resolution === "verified_recovery"
                    ? `A check confirmed this is working again ${i.resolvedAt ? relativeTime(i.resolvedAt) : ""}.`
                    : "The iAcquire team marked this as fixed."
                  : (i.recoveryGuidance ?? i.detail)}
              </p>
              {!resolved && <p className="mt-1 text-[11.5px] opacity-80">Noticed {relativeTime(i.detectedAt)}. The iAcquire team has been told.</p>}
            </div>
          </div>
        );
      })}
    </section>
  );
}
