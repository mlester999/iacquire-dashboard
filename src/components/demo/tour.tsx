import * as React from "react";
import { ChevronDown } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Badge } from "@/components/ui/primitives";
import { ROOM_COPY } from "@/lib/demo/outcomes";
import { TOUR } from "@/lib/demo/tour";

// The guided tour: the six AI Employees, one expandable card each, with an invented example. Static on purpose (no database, no model), so it is what a prospect always gets,
// whether or not the AI chat is open. Every example says it is a sample.

export function DemoTour() {
  return (
    <section aria-labelledby="tour-heading" className="space-y-3">
      <div>
        <h2 id="tour-heading" className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
          {ROOM_COPY.tourHeading}
        </h2>
        <p className="mt-1 text-[14px] leading-relaxed text-muted">{ROOM_COPY.tourIntro}</p>
      </div>
      <ul className="space-y-2">
        {TOUR.map((step, i) => (
          <li key={step.role}>
            <details open={i === 0} className="group card-surface rounded-2xl">
              <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-2xl px-4 py-3 [&::-webkit-details-marker]:hidden">
                <AgentAvatar role={step.meta} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold tracking-[-0.01em] text-ink">{step.meta.name}</span>
                  <span className="block text-[14px] leading-snug text-muted">{step.meta.tagline}</span>
                </span>
                <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="space-y-3 border-t border-line px-4 pb-4 pt-3">
                <p className="text-[14px] leading-relaxed text-ink-2">{step.does}</p>
                <div className="rounded-xl border border-line bg-surface-2/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[14px] font-semibold text-ink">{step.sampleTitle}</p>
                    <Badge tone="warning">Sample</Badge>
                  </div>
                  <dl className="mt-2 space-y-2">
                    {step.sample.map((line) => (
                      <div key={line.label}>
                        <dt className="text-[12px] font-medium text-muted">{line.label}</dt>
                        <dd className="text-[14px] leading-relaxed text-ink">{line.text}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <p className="text-[14px] leading-relaxed text-muted">{step.person}</p>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
