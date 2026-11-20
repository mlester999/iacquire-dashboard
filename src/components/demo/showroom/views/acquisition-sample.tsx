
"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, BarChart3, ClipboardList, FileText, RotateCcw, ScanSearch, ShieldCheck, UserRoundCheck } from "lucide-react";
import { Chip, SimTag } from "@/components/demo/showroom/ui";
import type { SampleScenario } from "@/lib/demo/showroom/industry";

type Stage = "ready" | "review" | "rejected" | "imported" | "prepared";

const UPDATES: Record<Stage, string> = {
  ready: "Start with the criteria in the sample Business Brain.",
  review: "One sample prospect qualified. Review the evidence before approving the CRM import.",
  rejected: "The sample prospect was rejected. No contact or follow-up task was created.",
  imported: "The approved prospect was added to the sample CRM. A follow-up task is planned.",
  prepared: "The follow-up draft is ready for review in the sample Work Board.",
};

const actionClass = "inline-flex min-h-11 items-center gap-2 rounded-xl px-4 py-2.5 text-left text-[14px] font-semibold";

export function AcquisitionSample({ scenario }: { scenario: SampleScenario }) {
  const [stage, setStage] = useState<Stage>("ready");
  const status = useRef<HTMLDivElement>(null);
  const interacted = useRef(false);
  useEffect(() => {
    if (interacted.current) status.current?.focus();
  }, [stage]);

  const advance = (next: Stage) => {
    interacted.current = true;
    setStage(next);
  };
  const hasContact = stage === "imported" || stage === "prepared";
  const hasDraft = stage === "prepared";

  return (
    <section aria-labelledby="sample-acquisition" className="sx-panel space-y-5 p-5 @xl:p-7">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="sample-acquisition" className="text-[21px] font-semibold tracking-[-0.02em] text-ink">Try a lead review</h2>
          <p className="max-w-2xl text-[14px] leading-relaxed text-ink-2">
            Follow one AI Growth Partner from a sample discovery through your lead decision and a follow-up draft. The simulation uses invented evidence. Real leads, CRM records, messages, and bookings are untouched.
          </p>
        </div>
        <SimTag>Simulation</SimTag>
      </header>

      <div className="grid gap-3 @2xl:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface-2/60 p-4">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <FileText className="size-4 text-primary-ink" aria-hidden /> Business Brain criteria
          </p>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">Look for {scenario.people} who have expressed interest in {scenario.deal}.</p>
        </div>
        {stage !== "ready" && (
          <div className="min-w-0 rounded-xl border border-line bg-surface-2/60 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <ScanSearch className="size-4 text-primary-ink" aria-hidden /> Qualification
              </p>
              <Chip tone={stage === "rejected" ? "neutral" : "ok"}>{stage === "rejected" ? "Rejected" : "Sample match"}</Chip>
            </div>
            <p className="mt-2 break-words text-[14px] font-semibold text-ink">{scenario.lead}</p>
            <p className="mt-1 text-[14px] leading-relaxed text-ink-2">Sample evidence: an intake form records interest in {scenario.deal}.</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">Appointment preference is unknown. The sample CRM has no matching record.</p>
          </div>
        )}
      </div>

      <div ref={status} role="status" tabIndex={-1} className="rounded-xl border border-line bg-surface px-4 py-3 text-[14px] leading-relaxed text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{UPDATES[stage]}</div>
      <div className="flex flex-wrap items-center gap-2">
        {stage === "ready" && (
          <button type="button" onClick={() => advance("review")} className={"sx-btn-primary " + actionClass}>
            <ScanSearch className="size-4 shrink-0" aria-hidden /> Discover a sample prospect
          </button>
        )}
        {stage === "review" && (
          <>
            <button type="button" onClick={() => advance("imported")} className={"sx-btn-primary " + actionClass}>
              <ShieldCheck className="size-4 shrink-0" aria-hidden /> Approve and add to sample CRM
            </button>
            <button type="button" onClick={() => advance("rejected")} className={"sx-btn-quiet " + actionClass}>Reject sample prospect</button>
          </>
        )}
        {stage === "imported" && (
          <button type="button" onClick={() => advance("prepared")} className={"sx-btn-primary " + actionClass}>
            Prepare sample follow-up <ArrowRight className="size-4 shrink-0" aria-hidden />
          </button>
        )}
        {stage !== "ready" && (
          <button type="button" onClick={() => advance("ready")} className={"sx-btn-quiet " + actionClass}>
            <RotateCcw className="size-4 shrink-0" aria-hidden /> Restart simulation
          </button>
        )}
      </div>

      {hasContact && (
        <div className="grid gap-3 @2xl:grid-cols-2">
          <section aria-label="Sample CRM" className="rounded-xl border border-line bg-surface-2/60 p-4">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <UserRoundCheck className="size-4 text-primary-ink" aria-hidden /> Sample CRM
            </h3>
            <p className="mt-2 break-words text-[14px] text-ink-2">{scenario.lead} · Qualified</p>
          </section>
          <section aria-label="Sample AI Work Board" className="rounded-xl border border-line bg-surface-2/60 p-4">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <ClipboardList className="size-4 text-primary-ink" aria-hidden /> Sample AI Work Board
            </h3>
            <p className="mt-2 text-[14px] text-ink-2">Follow-up · {hasDraft ? "Awaiting approval" : "Planned"}</p>
            {hasDraft && (
              <blockquote className="mt-3 border-l-2 border-primary/30 pl-3 text-[14px] leading-relaxed text-ink-2">
                Thanks for your interest. When would be a good time to discuss your needs and possible next steps?
              </blockquote>
            )}
          </section>
        </div>
      )}

      {(hasContact || stage === "rejected") && (
        <div className="flex items-start gap-2 border-t border-line pt-4 text-[13px] leading-relaxed text-muted">
          <BarChart3 className="mt-0.5 size-4 shrink-0 text-primary-ink" aria-hidden />
          <p><strong className="text-ink">Simulation summary</strong> · {hasContact ? "1 approved lead" : "1 rejected prospect"} · {hasDraft ? "1 follow-up draft" : "0 follow-up drafts"} · 0 messages sent</p>
        </div>
      )}
    </section>
  );
}
