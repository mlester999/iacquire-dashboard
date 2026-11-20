"use client";

import { Check, MessageSquareText, ShieldCheck, Sparkles } from "lucide-react";
import { useShowroom } from "@/components/demo/showroom/context";
import { ContextCta } from "@/components/demo/showroom/cta";
import { StepNav } from "@/components/demo/showroom/journey";
import { SectionHead } from "@/components/demo/showroom/ui";
import { AcquisitionSample } from "@/components/demo/showroom/views/acquisition-sample";
import { BusinessBrainSample } from "@/components/demo/showroom/views/business-brain-sample";
import { WorkBoardSample } from "@/components/demo/showroom/views/work-board-sample";
import { DEMO_CAPABILITY_AREAS } from "@/lib/demo/showroom/content";

export const WORKFORCE_AQI_QUESTIONS = [
  "What is the AI Work Board?",
  "How does a fact in the Business Brain get confirmed?",
] as const;
/** A sample view of the AI Growth Partner coordinating several capability areas. It performs no live research or business action. */
export function WorkforceView() {
  const { scenario, ask, aiEnabled, ended } = useShowroom();
  const canAsk = aiEnabled && !ended;

  return (
    <div className="space-y-8">
      <SectionHead
        as="h1"
        eyebrow="Step 1 · AI Growth Partner"
        title="Your AI Growth Partner, from brief to follow-up."
        lead="AI Growth Partner works from a shared business context across acquisition, sales, appointments, CRM, operations and analytics. You stay in control of the tools and decisions it is allowed to use."
      />

      <section aria-labelledby="partner-capabilities" className="grid gap-5 @4xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="sx-panel sx-panel-hot space-y-5 p-5 @xl:p-7">
          <div className="flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl border border-primary/15 bg-surface text-primary shadow-[var(--glow)]">
              <Sparkles className="size-6" aria-hidden />
            </span>
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-primary-ink">One AI Growth Partner identity</p>
              <h2 id="partner-capabilities" className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-ink">AI Growth Partner</h2>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">A stable product identity. The business-specific facts, limits and working preferences come from the approved Business Brain and connected workspace settings.</p>
            </div>
          </div>
          <div className="flex items-start gap-2.5 border-t border-line pt-4 text-[13px] leading-relaxed text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden />
            <p>Every action still follows the workspace, user, integration and tool permissions, along with its approval rules.</p>
          </div>
        </div>

        <ul className="grid gap-3 sm:grid-cols-2">
          {DEMO_CAPABILITY_AREAS.map((area) => (
            <li key={area.key} className="sx-panel flex items-start gap-3 p-4">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-ink">
                <Check className="size-4" aria-hidden />
              </span>
              <span>
                <span className="block text-[14px] font-semibold leading-snug text-ink">{area.title}</span>
                <span className="mt-1 block text-[13px] leading-relaxed text-ink-2">{area.description}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <AcquisitionSample scenario={scenario} />

      <BusinessBrainSample />
      <WorkBoardSample />

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <span className="mr-1 flex items-center gap-1.5 text-[13px] font-medium text-muted">
          <MessageSquareText className="size-4" aria-hidden />
          {canAsk ? "Ask AQi:" : "Questions to ask:"}
        </span>
        {WORKFORCE_AQI_QUESTIONS.map((question) => (
          <button key={question} type="button" onClick={() => ask(question)} className="sx-btn-quiet rounded-full px-3 py-1.5 text-left text-[13px] font-medium">
            {question}
          </button>
        ))}
      </div>

      <ContextCta
        plan="core"
        title="Want an AI Growth Partner configured for your business?"
        body="The product is designed around one AI Growth Partner identity and six connected capabilities. Your written scope, permissions, approved knowledge and connected tools determine what can actually run."
        consultLabel="Ask about an AI Growth Partner"
        secondary={{ view: "pricing", label: "See current pricing" }}
      />

      <StepNav />
    </div>
  );
}
