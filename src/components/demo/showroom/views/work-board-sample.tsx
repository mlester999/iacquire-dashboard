"use client";

import * as React from "react";
import { Chip, ScrollRegion, SimTag } from "@/components/demo/showroom/ui";
import { useShowroom } from "@/components/demo/showroom/context";
import { DEMO_CAPABILITY_AREAS } from "@/lib/demo/showroom/content";

const SAMPLE_LANES = [
  { label: "Queued", evidence: "Sample evidence: public company website entry", capabilityIndex: 0 },
  { label: "Working", evidence: "Sample evidence: draft based on the sample enquiry", capabilityIndex: 1 },
  { label: "Waiting for approval", evidence: "Sample evidence: invitation draft and sample calendar", capabilityIndex: 2, approval: true },
  { label: "Blocked", evidence: "Sample evidence: two sample records need a person to compare them", capabilityIndex: 3 },
  { label: "Prepared, not finished", evidence: "Sample evidence: handoff draft saved for review", capabilityIndex: 4 },
  { label: "Completed", evidence: "Sample evidence: saved execution record", capabilityIndex: 5 },
] as const;

/** A local-only sample board whose approval buttons change React state and never trigger work. */
export function WorkBoardSample() {
  const { scenario } = useShowroom();
  const [decision, setDecision] = React.useState<"approved" | "declined" | null>(null);

  return (
    <section aria-labelledby="work-board-sample-heading" className="sx-panel space-y-5 p-5 @xl:p-7">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">Shared work view</p>
          <h2 id="work-board-sample-heading" className="text-[20px] font-semibold tracking-[-0.015em] text-ink">AI Work Board</h2>
          <p className="max-w-3xl text-[14px] leading-relaxed text-ink-2">A sample task moves through real work states. Every person, task and evidence note here is invented for a scenario about {scenario.deal}.</p>
        </div>
        <SimTag>Sample only</SimTag>
      </header>

      <ScrollRegion label="AI Work Board sample lanes">
        <div className="grid min-w-[1080px] grid-cols-6 divide-x divide-line bg-surface">
          {SAMPLE_LANES.map((lane) => {
            const capability = DEMO_CAPABILITY_AREAS[lane.capabilityIndex];
            const title = lane.label === "Queued" ? `Find businesses that may need ${scenario.deal}`
              : lane.label === "Working" ? `Prepare a reply to ${scenario.enquiry}`
                : lane.label === "Waiting for approval" ? `Review a draft invitation for ${scenario.appointment}`
                  : lane.label === "Blocked" ? `Check a duplicate contact before handoff to ${scenario.people}`
                    : lane.label === "Prepared, not finished" ? `Prepare a handoff for the next ${scenario.appointment}`
                      : `Summarize the sample work around ${scenario.deal}`;
            return (
              <section key={lane.label} aria-label={lane.label} className="min-w-0 space-y-3 p-3">
                <div className="min-h-12">
                  <h3 className="text-[13px] font-semibold leading-snug text-ink">{lane.label}</h3>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted">{lane.label === "Completed" ? "Saved execution evidence" : lane.label === "Waiting for approval" ? "A person must decide" : "Sample task state"}</p>
                </div>
                <article className="space-y-3 rounded-xl border border-line bg-surface-2/55 p-3">
                  <p className="text-[13px] font-semibold leading-snug text-ink">{title}</p>
                  <div className="space-y-1">
                    <p className="text-[12px] font-medium text-ink-2">AI Growth Partner</p>
                    <p className="text-[12px] leading-relaxed text-muted">{capability.title}</p>
                  </div>
                  <p className="border-t border-line pt-2 text-[12px] leading-relaxed text-muted">{lane.evidence}</p>
                  {("approval" in lane && lane.approval) && (decision ? (
                    <p role="status" className="text-[12px] font-medium leading-relaxed text-success-ink">
                      {decision === "approved" ? "Approved in this demo. Nothing was sent." : "Declined in this demo. Nothing was sent."}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setDecision("approved")} className="sx-btn-primary min-h-10 rounded-lg px-3 text-[12px] font-semibold">Approve</button>
                      <button type="button" onClick={() => setDecision("declined")} className="sx-btn-quiet min-h-10 rounded-lg px-3 text-[12px] font-semibold">Decline</button>
                    </div>
                  ))}
                </article>
                {lane.label === "Completed" && <Chip tone="ok">Evidence saved in sample</Chip>}
              </section>
            );
          })}
        </div>
      </ScrollRegion>

      <p className="border-t border-line pt-4 text-[13px] leading-relaxed text-muted">Completed means saved execution evidence; drafts waiting for a decision stay in Prepared, not finished.</p>
    </section>
  );
}
