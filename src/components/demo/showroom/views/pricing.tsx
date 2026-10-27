"use client";

import * as React from "react";
import { Check, Minus } from "lucide-react";
import { CORE_INCLUDES, MAINTENANCE_INCLUDES_FALLBACK, PLAN_NOT_INCLUDED, STUDIO_INCLUDES, USAGE_NOTE } from "@/lib/demo/showroom/content";
import { SCOPE_NOTE } from "@/lib/demo/showroom/employees";
import { ROOM_COPY } from "@/lib/demo/outcomes";
import { useShowroom } from "@/components/demo/showroom/context";
import { ConsultCta, ConversionPanel } from "@/components/demo/showroom/cta";
import { Chip, ScrollRegion, SectionHead, dollars } from "@/components/demo/showroom/ui";

// Plans & pricing, stated exactly as the offer is: a one-time implementation (with no mandatory subscription), an OPTIONAL monthly plan that adds monitoring, troubleshooting and
// Automation Studio, and usage costs shown in the portal. The two prices come from src/lib/billing.ts through the room's view and the plan's list from the published catalog; no
// tier, discount, limit or number of AI Employees is stated beyond that. What is configured for a client is set by their written scope.

const COMPARE: Array<{ row: string; core: boolean; plus: boolean }> = [
  { row: "Native CRM: contacts, pipelines, deals, tasks", core: true, plus: true },
  { row: "AI Employees, set up to your agreement", core: true, plus: true },
  { row: "Unified inbox, calendars and booking", core: true, plus: true },
  { row: "Reports and the Performance Analyst", core: true, plus: true },
  { row: "Connect external automation tools through APIs and webhooks", core: true, plus: true },
  { row: "Use your system with no mandatory subscription", core: true, plus: true },
  { row: "Monitoring and alerts for your integrations", core: false, plus: true },
  { row: "Troubleshooting and reasonable configuration adjustments", core: false, plus: true },
  { row: "Automation Studio", core: false, plus: true },
  { row: "Managed media storage for social posts", core: false, plus: true },
];

function Tick({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <span className="inline-flex items-center gap-1.5 text-success-ink">
      <Check className="size-4" aria-hidden />
      <span className="sr-only">Included: {label}</span>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-faint">
      <Minus className="size-4" aria-hidden />
      <span className="sr-only">Not included: {label}</span>
    </span>
  );
}

export function PricingView() {
  const { setupFeeUsd, monthlyPlanUsd, plan } = useShowroom();
  const maintenance = plan.included && plan.included.length > 0 ? plan.included : MAINTENANCE_INCLUDES_FALLBACK;
  return (
    <div className="space-y-10">
      <SectionHead
        as="h1"
        eyebrow="Plans & pricing"
        title="One implementation. One optional plan."
        lead="The system you agree is yours to use without a monthly fee. Managed Maintenance is there if you want us watching over it and the Automation Studio builder."
      />

      <div className="grid gap-5 @4xl:grid-cols-2">
        <section aria-labelledby="core-plan" className="sx-panel flex flex-col gap-5 p-6 @xl:p-8">
          <header className="space-y-3">
            <Chip tone="ok">No mandatory subscription</Chip>
            <h2 id="core-plan" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Core implementation</h2>
            <p>
              <span className="text-[13px] font-medium text-muted">Starting at</span>
              <span className="sx-display ml-2 text-[52px] leading-none text-ink">{dollars(setupFeeUsd)}</span>
              <span className="ml-2 text-[14px] text-muted">paid once</span>
            </p>
          </header>
          <ul className="flex-1 space-y-3">
            {CORE_INCLUDES.map((t) => (
              <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
                <Check className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
          <ConsultCta size="lg" />
        </section>

        <section aria-labelledby="plus-plan" className="sx-panel sx-panel-hot flex flex-col gap-5 p-6 @xl:p-8">
          <header className="space-y-3">
            <Chip tone="violet">Optional · add it any time you choose</Chip>
            <h2 id="plus-plan" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Core + Managed Maintenance</h2>
            <p>
              <span className="text-[13px] font-medium text-muted">Plus</span>
              <span className="sx-display ml-2 text-[52px] leading-none text-ink">{dollars(monthlyPlanUsd)}</span>
              <span className="ml-2 text-[14px] text-muted">a month, only if you choose it</span>
            </p>
          </header>
          <div className="flex-1 space-y-4">
            <p className="text-[14px] font-medium text-ink">Everything in the core implementation, and:</p>
            <ul className="space-y-3">
              {maintenance.map((t) => (
                <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-violet-ink" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
            <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-violet-ink">Automation Studio</p>
            <ul className="space-y-3">
              {STUDIO_INCLUDES.map((t) => (
                <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-violet-ink" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
            {plan.monthlyRequestAllowance !== null && <p className="text-[13px] leading-relaxed text-muted">The published plan covers up to {plan.monthlyRequestAllowance} change requests a month.</p>}
          </div>
          <ConsultCta size="lg" quiet />
        </section>
      </div>

      <section aria-labelledby="matrix-heading" className="space-y-4">
        <h2 id="matrix-heading" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">Side by side</h2>
        <ScrollRegion label="Core compared with core plus Managed Maintenance">
          <table className="w-full min-w-[560px] text-left text-[14px]">
            <caption className="sr-only">Core implementation compared with core plus Managed Maintenance</caption>
            <thead className="bg-surface-2/70 text-[12px] uppercase tracking-[0.08em] text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">What you get</th>
                <th scope="col" className="w-36 px-4 py-3 text-center font-semibold">Core</th>
                <th scope="col" className="w-44 px-4 py-3 text-center font-semibold">Core + Maintenance</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((r) => (
                <tr key={r.row} className="border-t border-line">
                  <th scope="row" className="px-4 py-3 font-medium text-ink-2">{r.row}</th>
                  <td className="px-4 py-3 text-center"><Tick on={r.core} label={r.row} /></td>
                  <td className="px-4 py-3 text-center"><Tick on={r.plus} label={r.row} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>

      <section aria-labelledby="costs-heading" className="space-y-4">
        <h2 id="costs-heading" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">How the costs fit together</h2>
        <div className="grid gap-4 @2xl:grid-cols-3">
          <div className="sx-panel-flat space-y-1.5 p-5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-primary-ink">One time</p>
            <p className="text-[14px] leading-relaxed text-ink-2">The implementation, from {dollars(setupFeeUsd)}. A written scope and the price are confirmed with you before any work starts.</p>
          </div>
          <div className="sx-panel-flat space-y-1.5 p-5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-violet-ink">Optional, monthly</p>
            <p className="text-[14px] leading-relaxed text-ink-2">Managed Maintenance at {dollars(monthlyPlanUsd)} a month. {ROOM_COPY.planNote}</p>
          </div>
          <div className="sx-panel-flat space-y-1.5 p-5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-warning-ink">Separate</p>
            <p className="text-[14px] leading-relaxed text-ink-2">{USAGE_NOTE}</p>
          </div>
        </div>
        <ul className="grid gap-2 text-[14px] leading-relaxed text-muted @2xl:grid-cols-2">
          {PLAN_NOT_INCLUDED.map((t) => (
            <li key={t} className="flex gap-2.5">
              <Minus className="mt-1 size-3.5 shrink-0" aria-hidden />
              {t}
            </li>
          ))}
        </ul>
        <p className="max-w-3xl text-[14px] leading-relaxed text-muted">{SCOPE_NOTE}</p>
      </section>

      <ConversionPanel title="Want to talk it through?" />
    </div>
  );
}
