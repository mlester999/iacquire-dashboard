"use client";

import * as React from "react";
import { ArrowRight, Play, ShieldCheck } from "lucide-react";
import { ROOM_COPY } from "@/lib/demo/outcomes";
import { VIEWS } from "@/lib/demo/showroom/content";
import { useShowroom } from "@/components/demo/showroom/context";
import { useJourney } from "@/components/demo/showroom/journey";
import { BusinessHub } from "@/components/demo/showroom/hub-diagram";
import { MessageMeter, WindowClock } from "@/components/demo/showroom/clock";
import { ConversionPanel } from "@/components/demo/showroom/cta";
import { Eyebrow, PlanTag, SectionHead, ViewIcon } from "@/components/demo/showroom/ui";

// The first screen of the demo, and the one a visitor returns to: a headline about THEIR business (the name they gave us, nothing inferred), a picture of the six AI Employees around it,
// the live state of the demo, the four-step journey, and a way to just look around.

const AREAS = VIEWS.filter((v) => !["overview", "workforce"].includes(v.id));
const AREA_PLAN: Record<string, "core" | "maintenance" | null> = { crm: "core", inbox: "core", automation: "maintenance", reports: "core", pricing: null, why: null };

export function OverviewView() {
  const { firstName, business, industryLabel, scenario, go } = useShowroom();
  const { visited, nextStep } = useJourney();
  const name = business?.trim();
  const seen = visited.length;

  return (
    <div className="space-y-10">
      <section aria-labelledby="hero-heading" className="grid items-center gap-8 @4xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] @4xl:gap-10">
        <div className="sx-rise space-y-6">
          <Eyebrow>
            Welcome, {firstName}
            {industryLabel ? <span className="text-muted"> · {industryLabel}</span> : null}
          </Eyebrow>
          <h1 id="hero-heading" className="sx-display text-[30px] leading-[1.1] text-ink @xl:text-[38px] @5xl:text-[44px]">
            Meet the AI team that could help run{" "}
            <span className="sx-gradient-text break-words">{name ? name : "your business"}</span>.
          </h1>
          <p className="max-w-xl text-[17px] leading-relaxed text-ink-2">{scenario.benefit}</p>
          <p className="max-w-xl text-[15px] leading-relaxed text-muted">
            Explore a working system built around sample {scenario.people}: six AI Employees, a native CRM and an automation builder.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => go("workforce")} className="sx-btn-primary inline-flex h-13 items-center gap-2.5 rounded-xl px-6 py-3.5 text-[16px] font-semibold">
              Explore your AI team
              <ArrowRight className="size-4" aria-hidden />
            </button>
            <a href="#areas" className="sx-btn-quiet inline-flex h-13 items-center gap-2 rounded-xl px-6 py-3.5 text-[16px] font-semibold">
              Explore freely
            </a>
          </div>
          {seen > 0 && seen < 4 && (
            <button type="button" onClick={() => go(nextStep.view)} className="inline-flex items-center gap-2 text-[14px] font-medium text-primary-ink hover:text-ink">
              <Play className="size-3.5" aria-hidden />
              Continue your tour: step {nextStep.step}, {nextStep.title.toLowerCase()}
            </button>
          )}
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden />
            <span>{ROOM_COPY.sampleBanner}</span>
          </p>
        </div>
        <div className="sx-fade sx-delay-2">
          <BusinessHub />
        </div>
      </section>

      <section aria-label="Your demo at a glance" className="grid gap-4 @2xl:grid-cols-3">
        <div className="sx-panel p-5">
          <WindowClock />
        </div>
        <div className="sx-panel p-5">
          <MessageMeter />
        </div>
        <div className="sx-panel space-y-2 p-5">
          <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">Guided tour</p>
          <p className="whitespace-nowrap">
            <span className="text-[24px] font-semibold tabular-nums tracking-[-0.02em] text-ink">{seen}</span>
            <span className="ml-1.5 text-[13px] font-medium text-muted">of 4 steps seen</span>
          </p>
          <div className="sx-track" aria-hidden>
            <span style={{ width: `${(seen / 4) * 100}%` }} />
          </div>
          <p className="text-[13px] leading-snug text-muted">{seen === 0 ? "Start at step 1, or skip to anything." : seen >= 4 ? "You have seen every step. Revisit any of them." : `Next: step ${nextStep.step}, ${nextStep.title.toLowerCase()}.`}</p>
        </div>
      </section>

      <section id="areas" aria-labelledby="areas-heading" className="scroll-mt-24 space-y-6">
        <SectionHead eyebrow="Look around" title="What would you like to see?" as="h2" lead="Everything is one click away, in any order. Moving around never uses an AI message." />
        <ul className="grid gap-4 @xl:grid-cols-2 @5xl:grid-cols-3">
          {AREAS.map((a) => {
            const plan = AREA_PLAN[a.id];
            return (
              <li key={a.id}>
                <button type="button" onClick={() => go(a.id)} className="sx-panel group flex h-full w-full flex-col gap-2.5 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-line-strong">
                  <span className="flex items-center justify-between">
                    <span className="grid size-10 place-items-center rounded-xl bg-primary-soft text-primary-ink">
                      <ViewIcon name={a.icon} className="size-5" />
                    </span>
                    {plan && <PlanTag plan={plan} />}
                  </span>
                  <span className="text-[17px] font-semibold tracking-[-0.01em] text-ink">{a.label}</span>
                  <span className="flex-1 text-[14px] leading-relaxed text-ink-2">{a.hint}</span>
                  <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-primary-ink group-hover:text-ink">
                    Open
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <ConversionPanel />
    </div>
  );
}
