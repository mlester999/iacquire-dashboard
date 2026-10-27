"use client";

import * as React from "react";
import { Check, ChevronDown, Layers, Minus, RefreshCw, Receipt } from "lucide-react";
import { CORE_INCLUDES, MAINTENANCE_INCLUDES_FALLBACK, PLAN_NOT_INCLUDED, STUDIO_INCLUDES, USAGE_NOTE, faqs } from "@/lib/demo/showroom/content";
import { SCOPE_NOTE } from "@/lib/demo/showroom/employees";
import { ROOM_COPY } from "@/lib/demo/outcomes";
import { useShowroom } from "@/components/demo/showroom/context";
import { ConsultCta, ConversionPanel, StartCta } from "@/components/demo/showroom/cta";
import { Chip, ScrollRegion, SectionHead, dollars, usd } from "@/components/demo/showroom/ui";

// Plans & pricing, stated exactly as the offer is: a one-time implementation (with no mandatory subscription), an OPTIONAL monthly plan that adds monitoring, troubleshooting and
// Automation Studio, and usage costs shown in the portal. The two prices come from src/lib/billing.ts through the room's view and the plan's list from the published catalog; no
// tier, discount, promotion, guarantee or number of AI Employees is stated beyond that. What is configured for a client is set by their written scope.

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

function Price({ amount, prefix, suffix }: { amount: string; prefix: string; suffix: string }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2">
      <span className="w-full text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">{prefix}</span>
      <span className="text-[44px] font-semibold leading-none tracking-[-0.04em] tabular-nums text-ink">{amount}</span>
      <span className="text-[14px] font-medium text-muted">{suffix}</span>
    </p>
  );
}

export function PricingView() {
  const { setupFeeUsd, monthlyPlanUsd, plan } = useShowroom();
  const maintenance = plan.included && plan.included.length > 0 ? plan.included : MAINTENANCE_INCLUDES_FALLBACK;
  const setup = usd(setupFeeUsd);
  const monthly = usd(monthlyPlanUsd);
  return (
    <div className="space-y-10">
      <SectionHead
        as="h1"
        eyebrow="Plans & pricing"
        title="One implementation. One optional plan."
        lead="The system you agree is yours to use without a monthly platform fee. Managed Maintenance is there if you want us watching over it, plus the Automation Studio builder."
      />

      <div className="grid gap-5 @3xl:grid-cols-2">
        <section aria-labelledby="core-plan" className="sx-panel flex flex-col gap-5 p-6">
          <header className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="core-plan" className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Core implementation</h2>
              <Chip tone="ok">No mandatory subscription</Chip>
            </div>
            <Price prefix="Starting at" amount={setup} suffix="One-time implementation" />
            <p className="text-[14px] leading-relaxed text-ink-2">Your CRM and AI team, set up around your business, verified with you and switched on. Paid once.</p>
          </header>
          <ul className="flex-1 space-y-2.5 border-t border-line pt-5">
            {CORE_INCLUDES.map((t) => (
              <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
                <Check className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <ConsultCta size="lg" />
            <StartCta size="lg" />
          </div>
        </section>

        <section aria-labelledby="plus-plan" className="sx-panel sx-panel-hot relative flex flex-col gap-5 overflow-hidden p-6">
          <span aria-hidden className="brand-gradient absolute inset-x-0 top-0 h-1" />
          <header className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="plus-plan" className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Managed Maintenance</h2>
              <Chip tone="violet">Optional add-on</Chip>
            </div>
            <Price prefix="Add it any time" amount={monthly} suffix="per month, only if you choose it" />
            <p className="text-[14px] leading-relaxed text-ink-2">Everything in the core implementation, with our team watching over it and Automation Studio to build with.</p>
          </header>
          <div className="flex-1 space-y-4 border-t border-line pt-5">
            <ul className="space-y-2.5">
              {maintenance.map((t) => (
                <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-violet-ink" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
            <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-violet-ink">Automation Studio</p>
            <ul className="space-y-2.5">
              {STUDIO_INCLUDES.map((t) => (
                <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-violet-ink" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
            {plan.monthlyRequestAllowance !== null && <p className="text-[13px] leading-relaxed text-muted">The published plan covers up to {plan.monthlyRequestAllowance} change requests a month.</p>}
          </div>
          <ConsultCta size="lg" quiet label="Ask about Managed Maintenance" />
        </section>
      </div>

      <section aria-labelledby="costs-heading" className="space-y-4">
        <h2 id="costs-heading" className="text-[18px] font-semibold tracking-[-0.01em] text-ink">How the costs fit together</h2>
        <div className="grid gap-4 @2xl:grid-cols-3">
          <div className="sx-panel space-y-2 p-5">
            <span className="grid size-9 place-items-center rounded-xl bg-primary-soft text-primary-ink"><Layers className="size-[18px]" aria-hidden /></span>
            <p className="text-[15px] font-semibold text-ink">One time</p>
            <p className="text-[14px] leading-relaxed text-ink-2">The implementation, from {setup}. A written scope and the price are confirmed with you before any work starts.</p>
          </div>
          <div className="sx-panel space-y-2 p-5">
            <span className="grid size-9 place-items-center rounded-xl bg-violet-soft text-violet-ink"><RefreshCw className="size-[18px]" aria-hidden /></span>
            <p className="text-[15px] font-semibold text-ink">Optional, monthly</p>
            <p className="text-[14px] leading-relaxed text-ink-2">Managed Maintenance at {monthly} a month. {ROOM_COPY.planNote}</p>
          </div>
          <div className="sx-panel space-y-2 p-5">
            <span className="grid size-9 place-items-center rounded-xl bg-warning-soft text-warning-ink"><Receipt className="size-[18px]" aria-hidden /></span>
            <p className="text-[15px] font-semibold text-ink">Billed separately</p>
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

      <section aria-labelledby="matrix-heading" className="space-y-4">
        <h2 id="matrix-heading" className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Side by side</h2>
        <ScrollRegion label="Core compared with core plus Managed Maintenance" className="bg-surface">
          <table className="w-full min-w-[560px] text-left text-[14px]">
            <caption className="sr-only">Core implementation compared with core plus Managed Maintenance</caption>
            <thead className="bg-surface-2 text-[12px] uppercase tracking-[0.08em] text-muted">
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

      <section aria-labelledby="pricing-faq" className="space-y-4">
        <h2 id="pricing-faq" className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Questions about pricing</h2>
        <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {faqs(dollars(setupFeeUsd), dollars(monthlyPlanUsd))
            .filter((f) => /monthly fee|usage|Automation Studio|consultation|setup take/i.test(f.q))
            .map((f) => (
              <details key={f.q} className="group px-5 py-4 open:bg-surface-2">
                <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-ink-2">{f.a}</p>
              </details>
            ))}
        </div>
      </section>

      <ConversionPanel title="Want to talk it through?" />
    </div>
  );
}
