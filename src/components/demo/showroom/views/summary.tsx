"use client";

import * as React from "react";
import { ArrowRight, Check, X } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { IMPLEMENTATION_SETS, NEXT_STEPS } from "@/lib/demo/showroom/content";
import { SCOPE_NOTE } from "@/lib/demo/showroom/employees";
import { useShowroom } from "@/components/demo/showroom/context";
import { StepNav } from "@/components/demo/showroom/journey";
import { ConversionPanel } from "@/components/demo/showroom/cta";
import { PlanTag, SectionHead, dollars } from "@/components/demo/showroom/ui";

// Step 4: how it all comes together for the visitor's business. The before and after are about the WORK (where an enquiry goes, who prepares what), written as what could change, never as a
// measured result; the six roles are shown handing work along; and the page ends with what the iAcquire team sets up, what is optional, and the next steps.

const BEFORE = ["Enquiries arrive in several places and wait for whoever sees them first", "Replies and bookings depend on who is free", "Follow-ups are remembered, or they are not", "Records are spread across inboxes, notes and spreadsheets", "Understanding the numbers means building a report by hand"];
const AFTER = ["Every channel lands in one inbox, connected to one CRM", "A reply and a set of times are prepared for you to approve", "Quiet deals get a prepared nudge, so the next step is always visible", "The CRM Manager keeps contacts, owners and stages tidy", "A weekly note explains what stood out and where it came from"];

const CHAIN: Array<{ role: AgentRoleKey; gives: string }> = [
  { role: "lead_hunter", gives: "finds and scores prospects" },
  { role: "crm_manager", gives: "checks and records them" },
  { role: "appointment_setter", gives: "turns interest into meetings" },
  { role: "sales_assistant", gives: "prepares the follow-up" },
  { role: "performance_analyst", gives: "explains what is working" },
];

export function SummaryView() {
  const { business, go, setupFeeUsd, monthlyPlanUsd } = useShowroom();
  const name = business?.trim();
  return (
    <div className="space-y-12">
      <SectionHead
        as="h1"
        eyebrow="Step 4 · Your business, powered by iAcquireOS"
        title={
          <>
            How this could look for <span className="sx-gradient-text break-words">{name ? name : "your business"}</span>
          </>
        }
        lead="Put together: an inbox and CRM that stay current, an AI team that prepares the work, and you approving what matters."
      />

      <section aria-labelledby="ba-heading" className="grid gap-5 @4xl:grid-cols-[1fr_auto_1fr] @4xl:items-stretch">
        <h2 id="ba-heading" className="sr-only">Before and after</h2>
        <div className="sx-panel-flat space-y-4 p-6">
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">Today, for many businesses</p>
          <ul className="space-y-3">
            {BEFORE.map((t) => (
              <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
                <X className="mt-1 size-4 shrink-0 text-muted" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="hidden items-center @4xl:flex" aria-hidden>
          <span className="grid size-12 place-items-center rounded-full border border-primary/40 bg-primary-soft text-primary-ink shadow-[var(--glow)]">
            <ArrowRight className="size-5" />
          </span>
        </div>
        <div className="sx-panel sx-panel-hot space-y-4 p-6">
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-primary-ink">With iAcquireOS</p>
          <ul className="space-y-3">
            {AFTER.map((t) => (
              <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink">
                <Check className="mt-1 size-4 shrink-0 text-success-ink" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="team-heading" className="space-y-6">
        <SectionHead as="h2" eyebrow="Six roles, one flow" title="How the AI team hands work along" lead="The Operations Manager keeps the others coordinated and tells you what only a person should decide." />
        <div className="sx-panel p-5 @xl:p-7">
          <ol className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-5">
            {CHAIN.map((c, i) => (
              <li key={c.role} className="relative flex items-center gap-3 @4xl:flex-col @4xl:text-center">
                <AgentAvatar role={AGENT_BY_KEY[c.role]} size="lg" eager />
                <span>
                  <span className="block text-[14px] font-semibold text-ink">{AGENT_BY_KEY[c.role].shortName}</span>
                  <span className="block text-[13px] leading-snug text-muted">{c.gives}</span>
                </span>
                {i < CHAIN.length - 1 && <ArrowRight className="absolute -right-3 top-6 hidden size-4 text-primary-ink @4xl:block" aria-hidden />}
              </li>
            ))}
          </ol>
          <div className="mt-6 flex items-center gap-3 rounded-xl border border-line bg-surface-2/60 p-4">
            <AgentAvatar role={AGENT_BY_KEY.operations_manager} size="md" eager />
            <p className="text-[14px] leading-relaxed text-ink-2">
              <strong className="font-semibold text-ink">Operations Manager (Zeng)</strong> watches the whole flow: what is blocked, what is overdue, and what is waiting for you.
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-5 @2xl:grid-cols-2">
        <section className="sx-panel space-y-3 p-6" aria-labelledby="crm-sum">
          <PlanTag plan="core" />
          <h2 id="crm-sum" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">One CRM for the whole journey</h2>
          <p className="text-[14px] leading-relaxed text-ink-2">Leads, contacts, the pipeline, the inbox, appointments, tasks and approvals live together, and the AI Employees work on that same data.</p>
          <button type="button" onClick={() => go("crm")} className="inline-flex min-h-10 items-center gap-1.5 text-[14px] font-semibold text-primary-ink hover:text-ink">
            Revisit the CRM
            <ArrowRight className="size-4" aria-hidden />
          </button>
        </section>
        <section className="sx-panel space-y-3 p-6" aria-labelledby="auto-sum">
          <PlanTag plan="maintenance" />
          <h2 id="auto-sum" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">Automations, when you want them</h2>
          <p className="text-[14px] leading-relaxed text-ink-2">Automation Studio is part of the optional monthly plan. Without it, your system still connects to outside automation tools through supported APIs and webhooks.</p>
          <button type="button" onClick={() => go("automation")} className="inline-flex min-h-10 items-center gap-1.5 text-[14px] font-semibold text-primary-ink hover:text-ink">
            Revisit Automation Studio
            <ArrowRight className="size-4" aria-hidden />
          </button>
        </section>
      </div>

      <section aria-labelledby="config-heading" className="grid gap-6 @4xl:grid-cols-2">
        <div className="sx-panel space-y-4 p-6">
          <h2 id="config-heading" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">What our team sets up for you</h2>
          <ul className="space-y-2.5">
            {IMPLEMENTATION_SETS.map((s) => (
              <li key={s} className="flex gap-2.5 text-[14px] leading-relaxed text-ink-2">
                <Check className="mt-1 size-4 shrink-0 text-success-ink" aria-hidden />
                {s}
              </li>
            ))}
          </ul>
          <p className="text-[13px] leading-relaxed text-muted">{SCOPE_NOTE}</p>
        </div>
        <div className="space-y-4">
          <div className="sx-panel space-y-2 p-6">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-ink">Support, and what is optional</h2>
            <p className="text-[14px] leading-relaxed text-ink-2">
              The implementation starts at {dollars(setupFeeUsd)}, paid once. Managed Maintenance ({dollars(monthlyPlanUsd)} a month) is optional and adds monitoring, troubleshooting and Automation Studio.
            </p>
            <button type="button" onClick={() => go("pricing")} className="inline-flex min-h-10 items-center gap-1.5 text-[14px] font-semibold text-primary-ink hover:text-ink">
              Compare the plans
              <ArrowRight className="size-4" aria-hidden />
            </button>
          </div>
          <div className="sx-panel space-y-2 p-6">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-ink">Compared with doing it yourself</h2>
            <p className="text-[14px] leading-relaxed text-ink-2">One implementation instead of five subscriptions to connect, an approval step built in, and a team to call when something needs fixing.</p>
            <button type="button" onClick={() => go("why")} className="inline-flex min-h-10 items-center gap-1.5 text-[14px] font-semibold text-primary-ink hover:text-ink">
              Read the full comparison
              <ArrowRight className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      </section>

      <section aria-labelledby="next-heading" className="space-y-5">
        <SectionHead as="h2" eyebrow="What happens next" title="Four steps from here" />
        <ol className="grid gap-4 @2xl:grid-cols-2 @5xl:grid-cols-4">
          {NEXT_STEPS.map((s, i) => (
            <li key={s.title} className="sx-panel-flat space-y-2 p-5">
              <span className="grid size-8 place-items-center rounded-full bg-primary-soft text-[13px] font-semibold text-primary-ink">{i + 1}</span>
              <h3 className="text-[16px] font-semibold text-ink">{s.title}</h3>
              <p className="text-[14px] leading-relaxed text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <ConversionPanel title="Let's talk about your business" />
      <StepNav />
    </div>
  );
}
