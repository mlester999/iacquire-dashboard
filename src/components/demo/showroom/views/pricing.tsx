"use client";

import * as React from "react";
import { ArrowDown, Check, Layers, MessageSquareText, Minus, Plus, Receipt, RefreshCw, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/brand";
import { AGENT_BY_KEY } from "@/lib/agents";
import { CORE_INCLUDES, MAINTENANCE_INCLUDES_FALLBACK, PLAN_NOT_INCLUDED, STUDIO_INCLUDES, USAGE_NOTE, faqs } from "@/lib/demo/showroom/content";
import { EMPLOYEE_ORDER, SCOPE_NOTE } from "@/lib/demo/showroom/employees";
import { ROOM_COPY } from "@/lib/demo/outcomes";
import { useShowroom } from "@/components/demo/showroom/context";
import { ConsultCta, ConversionPanel, StartCta } from "@/components/demo/showroom/cta";
import { Chip, FaqItem, ScrollRegion, SectionHead, dollars, usd } from "@/components/demo/showroom/ui";

// Plans & pricing, stated exactly as the offer is: a one-time implementation (with no mandatory subscription), an OPTIONAL monthly plan that adds monitoring, troubleshooting and
// Automation Studio, and usage costs shown in the portal. The two prices come from src/lib/billing.ts through the room's view and the plan's list from the published catalog; no
// tier, discount, promotion, guarantee or number of AI Employees is stated beyond that. What is configured for a client is set by their written scope.
//
// Layout: the two plans are cards of the same anatomy (name, price, what it is, the buttons centred under the price, what is included) and each ends in a tinted panel that takes up
// whatever height the other card needs, so neither ever has an empty stretch in it, at any width.

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

/** What the pricing questions in the chat offer too: the same three, put in the box without being sent. */
const ASK_ABOUT_PRICING = ["What does the implementation cost?", "What does Managed Maintenance add?", "What costs are separate?"] as const;

function Tick({ on, label, tone = "ok" }: { on: boolean; label: string; tone?: "ok" | "violet" }) {
  return on ? (
    <span className={cn("inline-grid size-6 place-items-center rounded-full", tone === "violet" ? "bg-violet-soft text-violet-ink" : "bg-success-soft text-success-ink")}>
      <Check className="size-3.5" strokeWidth={2.75} aria-hidden />
      <span className="sr-only">Included: {label}</span>
    </span>
  ) : (
    <span className="inline-grid size-6 place-items-center text-faint">
      <Minus className="size-4" aria-hidden />
      <span className="sr-only">Not included: {label}</span>
    </span>
  );
}

function Price({ amount, prefix, suffix }: { amount: string; prefix: string; suffix: string }) {
  return (
    <p className="mt-5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <span className="w-full text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">{prefix}</span>
      <span className="text-[46px] font-semibold leading-none tracking-[-0.04em] tabular-nums text-ink">{amount}</span>
      <span className="text-[14px] font-medium text-muted">{suffix}</span>
    </p>
  );
}

function PlanHead({ id, icon, tone, title, chip }: { id: string; icon: React.ReactNode; tone: "primary" | "violet"; title: string; chip: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className={cn("grid size-10 shrink-0 place-items-center rounded-xl", tone === "primary" ? "bg-primary-soft text-primary-ink" : "bg-violet-soft text-violet-ink")}>
          {icon}
        </span>
        <h2 id={id} className="text-[19px] font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h2>
      </div>
      {chip}
    </div>
  );
}

function Includes({ items, tone, label }: { items: readonly string[]; tone: "ok" | "violet"; label: string }) {
  return (
    <ul aria-label={label} className="space-y-3">
      {items.map((t) => (
        <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
          <span aria-hidden className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full", tone === "ok" ? "bg-success-soft text-success-ink" : "bg-violet-soft text-violet-ink")}>
            <Check className="size-3" strokeWidth={3} />
          </span>
          {t}
        </li>
      ))}
    </ul>
  );
}

const Eyebrow = ({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "violet" }) => (
  <p className={cn("mb-3.5 text-[12px] font-semibold uppercase tracking-[0.1em]", tone === "violet" ? "text-violet-ink" : "text-muted")}>{children}</p>
);

function Sub({ id, title, lead }: { id: string; title: string; lead?: string }) {
  return (
    <div className="space-y-1">
      <h2 id={id} className="sx-display text-[22px] leading-tight text-ink">
        {title}
      </h2>
      {lead && <p className="max-w-2xl text-[14px] leading-relaxed text-muted">{lead}</p>}
    </div>
  );
}

export function PricingView() {
  const { setupFeeUsd, monthlyPlanUsd, plan, ask, aiEnabled, ended } = useShowroom();
  const maintenance = plan.included && plan.included.length > 0 ? plan.included : MAINTENANCE_INCLUDES_FALLBACK;
  const setup = usd(setupFeeUsd);
  const monthly = usd(monthlyPlanUsd);
  const canAsk = aiEnabled && !ended;
  const questions = faqs(dollars(setupFeeUsd), dollars(monthlyPlanUsd)).filter((f) => /monthly fee|usage|Automation Studio|consultation|setup take/i.test(f.q));
  const inBoth = COMPARE.filter((r) => r.core);
  const added = COMPARE.filter((r) => !r.core);

  return (
    <div className="space-y-14">
      <SectionHead
        as="h1"
        eyebrow="Plans & pricing"
        title="One implementation. One optional plan."
        lead="The system you agree is yours to use without a monthly platform fee. Managed Maintenance is there if you want us watching over it, plus the Automation Studio builder."
      />

      <div className="grid gap-5 @3xl:grid-cols-2">
        <section aria-labelledby="core-plan" className="sx-panel flex flex-col p-6 @xl:p-7">
          <PlanHead id="core-plan" tone="primary" icon={<Layers className="size-5" />} title="Core implementation" chip={<Chip tone="ok">No mandatory subscription</Chip>} />
          <Price prefix="Starting at" amount={setup} suffix="One-time implementation" />
          <p className="mt-3 text-[14px] leading-relaxed text-ink-2">Your CRM and AI team, set up around your business, verified with you and switched on. Paid once.</p>

          <div className="mt-6 grid gap-2.5">
            <ConsultCta size="lg" className="w-full justify-center" />
            <StartCta size="lg" className="w-full justify-center" />
          </div>

          <div className="mt-7 border-t border-line pt-6">
            <Eyebrow>What is included</Eyebrow>
            <Includes items={CORE_INCLUDES} tone="ok" label="Included in the core implementation" />
          </div>

          <div className="@container/team mt-7 flex flex-1 flex-col justify-center rounded-2xl border border-line bg-surface-2/60 p-4">
            <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">The six AI Employees</p>
            <ul className="mt-3.5 grid grid-cols-3 gap-x-2 gap-y-4 @sm/team:grid-cols-6">
              {EMPLOYEE_ORDER.map((key) => {
                const m = AGENT_BY_KEY[key];
                return (
                  <li key={key} className="flex flex-col items-center gap-1.5 text-center">
                    <AgentAvatar role={m} size="md" eager />
                    <span className="text-[12px] font-medium leading-tight text-ink-2">{m.shortName}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        <section aria-labelledby="plus-plan" className="sx-panel sx-panel-hot relative flex flex-col overflow-hidden p-6 @xl:p-7">
          <span aria-hidden className="brand-gradient absolute inset-x-0 top-0 h-1" />
          <PlanHead id="plus-plan" tone="violet" icon={<ShieldCheck className="size-5" />} title="Managed Maintenance" chip={<Chip tone="violet">Optional add-on</Chip>} />
          <Price prefix="Add it any time" amount={monthly} suffix="per month, only if you choose it" />
          <p className="mt-3 text-[14px] leading-relaxed text-ink-2">Everything in the core implementation, with our team watching over it and Automation Studio to build with.</p>

          <div className="mt-6 grid gap-2.5">
            <ConsultCta size="lg" quiet className="w-full justify-center" label="Ask about Managed Maintenance" />
            <a href="#compare-plans" className="inline-flex h-12 items-center justify-center gap-2 rounded-xl text-[14px] font-semibold text-primary-ink transition-colors hover:bg-primary-soft">
              Compare the two plans
              <ArrowDown className="size-4" aria-hidden />
            </a>
          </div>

          <div className="mt-7 border-t border-line pt-6">
            <Eyebrow>What it adds</Eyebrow>
            <Includes items={maintenance} tone="violet" label="What Managed Maintenance adds" />
            <p className="mb-3.5 mt-7 text-[12px] font-semibold uppercase tracking-[0.1em] text-violet-ink">Automation Studio</p>
            <Includes items={STUDIO_INCLUDES} tone="violet" label="Automation Studio, part of Managed Maintenance" />
          </div>

          <div className="mt-7 flex flex-1 flex-col justify-center rounded-2xl border border-line bg-surface-2/60 p-4">
            <div className="flex gap-3">
              <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-soft text-violet-ink">
                <RefreshCw className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-ink">Never needed to use your core system</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
                  {plan.monthlyRequestAllowance !== null ? `The published plan covers up to ${plan.monthlyRequestAllowance} change requests a month.` : "Add it any time, only if you choose it."}
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>

      <section aria-labelledby="costs-heading" className="space-y-5">
        <Sub id="costs-heading" title="How the costs fit together" lead="What you pay once, what you may add, and what is billed by usage." />
        <ul className="grid gap-4 @2xl:grid-cols-3 @2xl:gap-6">
          <li className="sx-panel relative space-y-2 p-5">
            <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-primary-soft text-primary-ink">
              <Layers className="size-[19px]" />
            </span>
            <p className="pt-1 text-[15px] font-semibold text-ink">One time</p>
            <p className="text-[14px] leading-relaxed text-ink-2">The implementation, from {setup}. A written scope and the price are confirmed with you before any work starts.</p>
            <Plus aria-hidden className="absolute -right-[26px] top-1/2 hidden size-6 -translate-y-1/2 rounded-full border border-line bg-surface p-1 text-muted @2xl:block" />
          </li>
          <li className="sx-panel relative space-y-2 p-5">
            <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-violet-soft text-violet-ink">
              <RefreshCw className="size-[19px]" />
            </span>
            <p className="pt-1 text-[15px] font-semibold text-ink">Optional, monthly</p>
            <p className="text-[14px] leading-relaxed text-ink-2">
              Managed Maintenance at {monthly} a month. {ROOM_COPY.planNote}
            </p>
            <Plus aria-hidden className="absolute -right-[26px] top-1/2 hidden size-6 -translate-y-1/2 rounded-full border border-line bg-surface p-1 text-muted @2xl:block" />
          </li>
          <li className="sx-panel space-y-2 p-5">
            <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-warning-soft text-warning-ink">
              <Receipt className="size-[19px]" />
            </span>
            <p className="pt-1 text-[15px] font-semibold text-ink">Billed separately</p>
            <p className="text-[14px] leading-relaxed text-ink-2">{USAGE_NOTE}</p>
          </li>
        </ul>

        <div className="sx-panel-flat flex flex-col gap-3 p-5 @2xl:flex-row @2xl:items-start @2xl:gap-8">
          <p className="shrink-0 text-[14px] font-semibold text-ink @2xl:w-40">Not part of either plan</p>
          <ul className="grid flex-1 gap-3 @2xl:grid-cols-2 @2xl:gap-8">
            {PLAN_NOT_INCLUDED.map((t) => (
              <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
                <span aria-hidden className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 text-muted">
                  <X className="size-3" strokeWidth={3} />
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="max-w-3xl text-[14px] leading-relaxed text-muted">{SCOPE_NOTE}</p>
      </section>

      <section id="compare-plans" aria-labelledby="matrix-heading" className="scroll-mt-28 space-y-5">
        <Sub id="matrix-heading" title="Side by side" lead="What each option gives you." />
        <ScrollRegion label="Core compared with core plus Managed Maintenance" className="bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[600px] text-left text-[14px]">
            <caption className="sr-only">Core implementation compared with core plus Managed Maintenance</caption>
            <thead>
              <tr className="bg-surface-2/60">
                <th scope="col" className="px-5 py-4 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
                  What you get
                </th>
                <th scope="col" className="w-44 px-4 py-4 text-center">
                  <span className="block text-[14px] font-semibold text-ink">Core</span>
                  <span className="block text-[12px] font-normal text-muted">{setup}, once</span>
                </th>
                <th scope="col" className="w-52 bg-violet-soft/60 px-4 py-4 text-center">
                  <span className="block text-[14px] font-semibold text-ink">Core + Maintenance</span>
                  <span className="block text-[12px] font-normal text-muted">plus {monthly} a month</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="rowgroup" colSpan={3} className="border-t border-line bg-surface-2/40 px-5 py-2.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
                  In every implementation
                </th>
              </tr>
              {inBoth.map((r) => (
                <tr key={r.row} className="border-t border-line">
                  <th scope="row" className="px-5 py-3.5 font-medium text-ink-2">
                    {r.row}
                  </th>
                  <td className="px-4 py-3.5 text-center">
                    <Tick on={r.core} label={r.row} />
                  </td>
                  <td className="bg-violet-soft/30 px-4 py-3.5 text-center">
                    <Tick on={r.plus} label={r.row} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tbody>
              <tr>
                <th scope="rowgroup" colSpan={3} className="border-t border-line bg-surface-2/40 px-5 py-2.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-violet-ink">
                  Added by Managed Maintenance
                </th>
              </tr>
              {added.map((r) => (
                <tr key={r.row} className="border-t border-line">
                  <th scope="row" className="px-5 py-3.5 font-medium text-ink-2">
                    {r.row}
                  </th>
                  <td className="px-4 py-3.5 text-center">
                    <Tick on={r.core} label={r.row} />
                  </td>
                  <td className="bg-violet-soft/30 px-4 py-3.5 text-center">
                    <Tick on={r.plus} label={r.row} tone="violet" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>

      <section aria-labelledby="pricing-faq" className="grid gap-8 @4xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)] @4xl:gap-12">
        <div className="space-y-5">
          <Sub id="pricing-faq" title="Questions about pricing" lead="Plain answers on what you pay, and when." />
          <div className="space-y-2.5">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted">
              <MessageSquareText className="size-4" aria-hidden />
              {canAsk ? "Ask AQi:" : "Questions to ask the team:"}
            </p>
            <div className="flex flex-wrap gap-2">
              {ASK_ABOUT_PRICING.map((q) => (
                <button key={q} type="button" onClick={() => ask(q)} className="sx-btn-quiet rounded-full px-3 py-1.5 text-left text-[13px] font-medium">
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="space-y-3">
          {questions.map((f) => (
            <FaqItem key={f.q} question={f.q}>
              <p className="max-w-2xl text-[14px] leading-relaxed text-ink-2">{f.a}</p>
            </FaqItem>
          ))}
        </div>
      </section>

      <ConversionPanel title="Want to talk it through?" />
    </div>
  );
}
