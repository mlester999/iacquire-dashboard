"use client";

import * as React from "react";
import { Check, MessageSquareText, ShieldCheck, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/brand";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { OVERSIGHT_FOOTER, SCOPE_NOTE, profiles, scenarioOf } from "@/lib/demo/showroom/employees";
import { useShowroom } from "@/components/demo/showroom/context";
import { StepNav } from "@/components/demo/showroom/journey";
import { ContextCta } from "@/components/demo/showroom/cta";
import { ScenarioPlayer } from "@/components/demo/showroom/scenario-player";
import { SectionHead, SimTag } from "@/components/demo/showroom/ui";

// Step 1: the six AI Employees. A rail to pick one, a profile that answers "what is it for, what does it do all day, what does it need from me", and a simulated scenario that shows the
// work instead of describing it.

// The order a business meets them in: find, coordinate, book, follow up, keep clean, explain.
const ORDER: AgentRoleKey[] = ["lead_hunter", "operations_manager", "appointment_setter", "sales_assistant", "crm_manager", "performance_analyst"];

const questionsFor = (short: string) => [`What would the ${short} do in a typical week?`, `What does the ${short} need me to approve?`, `How does the ${short} work with the other AI Employees?`];

export function WorkforceView() {
  const { scenario, focusRole, ask, aiEnabled, ended } = useShowroom();
  const all = React.useMemo(() => profiles(), []);
  const [role, setRole] = React.useState<AgentRoleKey>(focusRole ?? "lead_hunter");
  const p = all.find((x) => x.role === role) ?? all[0];
  const meta = AGENT_BY_KEY[p.role];
  const sample = React.useMemo(() => scenarioOf(p.role, scenario), [p.role, scenario]);
  const canAsk = aiEnabled && !ended;

  return (
    <div className="space-y-8">
      <SectionHead
        as="h1"
        eyebrow="Step 1 · Discover your AI workforce"
        title="Six AI Employees. One job each."
        lead="Pick one to see what it takes off your plate, what it does all day and what it will never do without you. Then watch it work on a sample."
      />

      <div className="grid gap-6 @5xl:grid-cols-[260px_minmax(0,1fr)]">
        <nav aria-label="AI Employees" className="sx-noscrollbar relative -mx-4 overflow-x-auto px-4 @5xl:mx-0 @5xl:overflow-visible @5xl:px-0">
          <ul className="flex gap-2 @5xl:flex-col">
            {ORDER.map((key) => {
              const m = AGENT_BY_KEY[key];
              const on = key === role;
              return (
                <li key={key} className="shrink-0 @5xl:shrink">
                  <button
                    type="button"
                    onClick={() => setRole(key)}
                    aria-pressed={on}
                    className={cn("flex w-full items-center gap-3 rounded-2xl border p-2.5 pr-4 text-left transition-colors @5xl:p-3", on ? "border-primary/60 bg-primary-soft shadow-[var(--glow)]" : "border-line bg-surface/70 hover:border-line-strong hover:bg-surface-2")}
                  >
                    <AgentAvatar role={m} size="md" eager />
                    <span className="min-w-0">
                      <span className="block whitespace-nowrap text-[14px] font-semibold text-ink @5xl:whitespace-normal">{m.shortName}</span>
                      <span className="hidden text-[12px] leading-snug text-muted @5xl:block">{m.tagline}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div key={p.role} className="sx-rise min-w-0 space-y-5">
          <article className="sx-panel space-y-6 p-5 @xl:p-7">
            <header className="flex flex-wrap items-start gap-4">
              <AgentAvatar role={meta} size="xl" eager />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="sx-display text-[26px] leading-none text-ink @xl:text-[30px]">{meta.shortName}</h2>
                </div>
                <p className="text-[15px] text-ink-2">{meta.tagline}</p>
              </div>
            </header>

            <div className="rounded-2xl border border-line bg-surface-2/60 p-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-primary-ink">The problem it takes off your plate</p>
              <p className="mt-1.5 text-[16px] leading-relaxed text-ink">{p.solves}</p>
            </div>

            <div className="grid gap-6 @2xl:grid-cols-2">
              <section aria-labelledby={`day-${p.role}`}>
                <h3 id={`day-${p.role}`} className="text-[15px] font-semibold text-ink">
                  A typical day
                </h3>
                <ol className="mt-3 space-y-3">
                  {p.typicalDay.map((t, i) => (
                    <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
                      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary-soft text-[12px] font-semibold text-primary-ink">{i + 1}</span>
                      {t}
                    </li>
                  ))}
                </ol>
              </section>
              <section aria-labelledby={`cap-${p.role}`}>
                <h3 id={`cap-${p.role}`} className="text-[15px] font-semibold text-ink">
                  What it can do
                </h3>
                <ul className="mt-3 space-y-2.5">
                  {p.capabilities.map((c) => (
                    <li key={c} className="flex gap-2.5 text-[14px] leading-relaxed text-ink-2">
                      <Check className="mt-1 size-4 shrink-0 text-success-ink" aria-hidden />
                      {c}
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <section aria-labelledby={`ex-${p.role}`} className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id={`ex-${p.role}`} className="text-[15px] font-semibold text-ink">
                  An example
                </h3>
                <SimTag>Invented example</SimTag>
              </div>
              <div className="grid gap-3 @2xl:grid-cols-2">
                <div className="rounded-2xl rounded-bl-md border border-line bg-surface-2/70 p-4">
                  <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">You ask</p>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{p.example.input}</p>
                </div>
                <div className="rounded-2xl rounded-br-md border border-primary/30 bg-primary-soft p-4">
                  <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-primary-ink">{meta.shortName} prepares</p>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{p.example.output}</p>
                </div>
              </div>
            </section>

            <div className="grid gap-6 @2xl:grid-cols-2">
              <section aria-labelledby={`with-${p.role}`}>
                <h3 id={`with-${p.role}`} className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                  <Users className="size-4 text-primary-ink" aria-hidden />
                  Works with
                </h3>
                <ul className="mt-3 space-y-2.5">
                  {p.worksWith.map((w) => (
                    <li key={w.role} className="text-[14px] leading-relaxed text-ink-2">
                      <button type="button" onClick={() => setRole(w.role)} className="font-semibold text-primary-ink underline-offset-4 hover:text-ink hover:underline">
                        {AGENT_BY_KEY[w.role].shortName}
                      </button>{" "}
                      {w.how}
                    </li>
                  ))}
                </ul>
              </section>
              <section aria-labelledby={`ok-${p.role}`}>
                <h3 id={`ok-${p.role}`} className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                  <ShieldCheck className="size-4 text-success-ink" aria-hidden />
                  Always waits for you
                </h3>
                <ul className="mt-3 space-y-2.5">
                  {p.needsApproval.map((a) => (
                    <li key={a} className="text-[14px] leading-relaxed text-ink-2">
                      {a}
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <span className="mr-1 flex items-center gap-1.5 text-[13px] font-medium text-muted">
                <MessageSquareText className="size-4" aria-hidden />
                {canAsk ? "Ask the guide:" : "Questions to ask the team:"}
              </span>
              {questionsFor(meta.shortName).map((q) => (
                <button key={q} type="button" onClick={() => ask(q)} className="sx-btn-quiet rounded-full px-3 py-1.5 text-left text-[13px] font-medium">
                  {q}
                </button>
              ))}
            </div>
          </article>

          <ScenarioPlayer key={p.role} scenario={sample} onAsk={() => ask(questionsFor(meta.shortName)[1])} askLabel={`Ask what the ${meta.shortName} needs me to approve`} />
        </div>
      </div>

      <p className="max-w-3xl text-[14px] leading-relaxed text-muted">
        {SCOPE_NOTE} {OVERSIGHT_FOOTER}
      </p>

      <ContextCta
        plan="core"
        title="Want your own AI team configured for your business?"
        body="The six AI Employees are part of the core implementation. We configure them to your business, test them with you and switch them on, with your approval in charge."
        consultLabel="Get this AI team for my business"
        secondary={{ view: "pricing", label: "See what it costs" }}
      />

      <StepNav />
    </div>
  );
}
