"use client";

import { useShowroom } from "@/components/demo/showroom/context";
import { Chip, SimTag } from "@/components/demo/showroom/ui";
import { BUSINESS_BRAIN_SECTIONS, BUSINESS_BRAIN_SECTION_TITLES } from "@/lib/ai-growth-partner";

const FACT_STYLES = {
  Verified: "ok",
  "Client confirmed": "info",
  "Draft suggestion": "violet",
  Unknown: "warn",
} as const;

/** An invented, industry-shaped sample of fact states. It never reads the visitor's Business Brain. */
export function BusinessBrainSample() {
  const { scenario } = useShowroom();
  const facts = [
    { label: "Example core offer", state: "Verified" as const, value: scenario.deal, evidence: "Sample evidence: approved service description" },
    { label: "Example appointment", state: "Client confirmed" as const, value: scenario.appointment, evidence: "Sample evidence: client confirmation" },
    { label: "Example enquiry pattern", state: "Draft suggestion" as const, value: `${scenario.people} asking about ${scenario.enquiry}`, evidence: "Sample evidence: suggestion awaiting review" },
    { label: "Exact pricing policy", state: "Unknown" as const, value: "Unknown", evidence: "No source in this sample" },
  ];

  return (
    <section aria-labelledby="business-brain-sample-heading" className="sx-panel space-y-5 p-5 @xl:p-7">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">Business Brain</p>
          <h2 id="business-brain-sample-heading" className="text-[20px] font-semibold tracking-[-0.015em] text-ink">What goes into the Business Brain</h2>
          <p className="max-w-3xl text-[14px] leading-relaxed text-ink-2">These invented examples show how a fact can be checked, confirmed, suggested for review, or left unknown. Nothing here was read from your business.</p>
        </div>
        <SimTag>Sample only</SimTag>
      </header>

      <ul className="grid gap-3 @2xl:grid-cols-2">
        {facts.map((fact) => (
          <li key={fact.label} className="rounded-xl border border-line bg-surface-2/55 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[14px] font-semibold text-ink">{fact.label}</h3>
              <Chip tone={FACT_STYLES[fact.state]}>{fact.state}</Chip>
            </div>
            <p className="mt-2 break-words text-[14px] leading-relaxed text-ink-2">{fact.value}</p>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">{fact.evidence}</p>
          </li>
        ))}
      </ul>

      <div className="space-y-3 border-t border-line pt-4">
        <p className="text-[14px] font-semibold text-ink">The Business Brain covers</p>
        <ul className="grid gap-2 sm:grid-cols-2 @4xl:grid-cols-3">
          {BUSINESS_BRAIN_SECTIONS.map((section) => (
            <li key={section} className="rounded-lg bg-surface-2/65 px-3 py-2 text-[13px] leading-relaxed text-ink-2">
              {BUSINESS_BRAIN_SECTION_TITLES[section]}
            </li>
          ))}
        </ul>
        <div className="grid gap-2 rounded-xl border border-line bg-surface-2/55 p-4 sm:grid-cols-2">
          <p className="text-[14px] font-medium leading-relaxed text-ink-2">Unknown stays unknown: it is never guessed.</p>
          <p className="text-[14px] font-medium leading-relaxed text-ink-2">You confirm what the partner may use.</p>
        </div>
      </div>
    </section>
  );
}
