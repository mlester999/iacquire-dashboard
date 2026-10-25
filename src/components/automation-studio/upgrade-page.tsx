import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, BarChart3, Check, ChevronRight, LayoutTemplate, Lock, Minus, PlugZap, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { ButtonLink } from "@/components/ui/button";
import { BuilderDemo } from "@/components/automation-studio/demo/builder-demo";
import { ApprovalVisual, Capability, EditorVisual, HeroVisual, TestVisual, VersionsVisual } from "@/components/automation-studio/upgrade-visuals";
import { STUDIO_TEMPLATES } from "@/lib/automation-studio/templates";
import { STUDIO_DEFAULT_LIMITS, STUDIO_LAPSE_POLICY, STUDIO_PLAN_NAME, PAYMENT_GRACE_DAYS, type StudioEntitlementState } from "@/lib/automation-studio/plan";
import "@/components/automation-studio/upgrade.css";

/** What the upgrade page shows for a plan that isn't active. Nothing here is the person's data: the example and the pictures are labelled samples. */

const USD = (n: number) => `$${n.toLocaleString("en-US")}`;
const NUM = (n: number) => n.toLocaleString("en-US");

export interface UpgradeProps {
  state: StudioEntitlementState;
  /** In words: why the plan isn't active (a pending request, an expired plan…). */
  reason: string;
  /** The plan's monthly price: the published maintenance plan's price in the service catalog (what a request records), else the approved default. */
  monthlyUsd: number;
  setupFeeUsd: number;
  /** Maintenance requests included each month, from the published plan; null when the catalog doesn't say. */
  requestAllowance: number | null;
  /** The existing enrolment flow can take the request now (the core system is activated and this person is the owner). */
  canRequest: boolean;
  /** Why the plan can't be requested yet, in words, or null. */
  requestNote: string | null;
  /** Automations built before the plan ended, kept and paused. */
  saved: Array<{ id: string; name: string }>;
}

type CtaProps = Pick<UpgradeProps, "state" | "canRequest" | "requestNote">;

/**
 * What the button says and the line under it. Every button opens the Maintenance page, where the owner reviews the terms and sends the request,
 * and iAcquire activates the plan; nothing is charged or started from this page. Someone who can't request it is told why, and the button says
 * only where it goes.
 */
export function ctaCopy({ state, canRequest, requestNote }: CtaProps) {
  if (state === "pending") return { label: "View your request", primary: true, note: "Your request is on the Maintenance page. iAcquire activates the plan after reviewing it, and billing starts on the date they confirm." };
  if (!canRequest) return { label: "Open the Maintenance page", primary: false, note: requestNote ?? "Only the owner of your workspace can request the plan." };
  const lapsed = state === "expired" || state === "cancelled";
  return {
    label: lapsed ? "Reactivate the plan" : "Review and request the plan",
    primary: true,
    note: "Opens the Maintenance page, where you review the terms and send the request. iAcquire confirms it before anything is billed.",
  };
}

function Cta({ align = "start", tone = "light", ...p }: CtaProps & { align?: "start" | "center"; tone?: "light" | "stage" }) {
  const { label, primary, note } = ctaCopy(p);
  return (
    <div className={cn("flex flex-col gap-3", align === "center" ? "items-center text-center" : "items-start")}>
      <ButtonLink href="/maintenance" variant={primary ? "brand" : "secondary"} size="lg" className="group w-full sm:w-auto">
        {label}<ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" aria-hidden />
      </ButtonLink>
      <p className={cn("max-w-md text-pretty text-[12.5px] leading-relaxed", tone === "stage" ? "text-[var(--stage-muted)]" : "text-muted", align === "center" && "mx-auto")}>{note}</p>
    </div>
  );
}

function SectionHeader({ id, eyebrow, title, children, className }: { id: string; eyebrow: string; title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("max-w-2xl", className)}>
      <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-primary-ink">{eyebrow}</p>
      <h2 id={id} className="mt-2 scroll-mt-28 text-balance text-[26px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink sm:text-[30px]">{title}</h2>
      {children && <p className="mt-3 text-pretty text-[15px] leading-relaxed text-muted">{children}</p>}
    </div>
  );
}

const STEPS = [
  { t: "Describe it", d: "Write what should happen, the way you’d explain it to a colleague." },
  { t: "Watch it build", d: "The builder explains its plan, then draws each step on a canvas, already connected." },
  { t: "Refine and publish", d: "Ask for changes or edit the canvas yourself, test it, and publish when it’s right." },
];

/** What a workspace has today and what the plan adds, row by row. Kept to what exists; the plan's limits are in the fine print below. */
function comparison(allowance: number | null) {
  return {
    now: [
      "Your CRM, its workflow builder and every workflow you already run",
      "Your AI employees, their schedules and their jobs",
      "n8n, Zapier and Make connections, webhooks and the API",
      "Support, and fixes for anything iAcquire got wrong",
    ],
    plan: [
      "The AI Automation Builder and its canvas",
      "The full visual editor, with undo and version history",
      "Test runs and run history for Automation Studio automations",
      `${STUDIO_TEMPLATES.length} ready-made templates, and HTTP and Slack steps`,
      allowance === null ? "Managed maintenance by iAcquire" : `Managed maintenance by iAcquire, ${allowance} request${allowance === 1 ? "" : "s"} a month`,
    ],
  };
}

function Mark({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <span className="inline-flex size-6 items-center justify-center rounded-full bg-success-soft text-success-ink"><Check className="size-3.5" aria-hidden /><span className="sr-only">{label}: included</span></span>
  ) : (
    <span className="inline-flex size-6 items-center justify-center text-faint"><Minus className="size-3.5" aria-hidden /><span className="sr-only">{label}: not included</span></span>
  );
}

export function UpgradePage(p: UpgradeProps) {
  const l = STUDIO_DEFAULT_LIMITS;
  const lapsed = p.state === "expired" || p.state === "cancelled";
  const rows = comparison(p.requestAllowance);
  const closing = p.state === "pending" ? "Your request is with iAcquire" : lapsed ? "Pick up where you left off" : "Start with one sentence";
  const closingNote = p.state === "pending"
    ? "You’ll hear from iAcquire when the plan is active. Until then, everything you have keeps working as it does now."
    : lapsed
      ? "Reactivate the plan and your saved automations are ready to check and switch back on."
      : "Request the plan and iAcquire confirms it with you. Until then, everything you have keeps working as it does now.";

  return (
    <div className="@container mx-auto max-w-[1280px] space-y-20 pb-6 sm:space-y-24">
      {/* 1. The promise, the one action, and the picture of a sentence becoming steps. */}
      <section aria-labelledby="up-h" className="studio-wash relative overflow-hidden rounded-[28px] border border-line shadow-card">
        <div aria-hidden className="studio-dots pointer-events-none absolute inset-y-0 right-0 hidden w-1/2 [mask-image:linear-gradient(90deg,transparent,#000_70%)] opacity-60 @4xl:block" />
        <div className="relative grid items-center gap-10 px-5 py-9 sm:px-10 sm:py-12 @4xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] @4xl:gap-12 @4xl:py-14 @4xl:pl-12 @6xl:gap-16 @6xl:px-14 @6xl:py-16">
          <div className="min-w-0">
            <p className="inline-flex w-fit items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12px] font-semibold text-ink-2 shadow-soft">
              <Lock className="size-3.5 text-primary" aria-hidden />Automation Studio<span aria-hidden className="text-faint">·</span><span className="font-medium text-muted">Optional plan</span>
            </p>
            <h1 id="up-h" className="mt-5 text-balance text-[36px] font-semibold leading-[1.04] tracking-[-0.03em] text-ink @2xl:text-[48px] @6xl:text-[58px]">
              <span className="@2xl:block">Describe an automation.</span> <span className="text-gradient @2xl:block">Watch it get built.</span>
            </h1>
            <p className="mt-5 max-w-[48ch] text-pretty text-[16px] leading-relaxed text-ink-2 sm:text-[17px]">
              Tell the AI Automation Builder what should happen, in plain English. It drafts a real, editable automation on a visual canvas, and you shape it by chatting or editing. Nothing runs until you publish it.
            </p>
            {lapsed && <p className="mt-5 max-w-xl rounded-xl bg-warning-soft px-3.5 py-2.5 text-[13.5px] text-warning-ink" role="note">{p.reason}</p>}
            {p.state === "pending" && <p className="mt-5 max-w-xl rounded-xl bg-primary-soft px-3.5 py-2.5 text-[13.5px] text-primary-ink" role="note">{p.reason}</p>}
            <div className="mt-8 flex flex-col gap-x-5 gap-y-4 sm:flex-row sm:items-start">
              <Cta state={p.state} canRequest={p.canRequest} requestNote={p.requestNote} />
              <a href="#up-see" className="inline-flex h-12 shrink-0 items-center gap-1.5 self-start rounded-xl px-1 text-[14px] font-medium text-primary-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                Watch the example<ArrowDown className="size-4" aria-hidden />
              </a>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-5 text-[13px] text-ink-2">
              {["Everything you have keeps working without it", "Nothing is charged from this page"].map((t) => (
                <li key={t} className="inline-flex items-center gap-2"><Check className="size-4 text-success" aria-hidden />{t}</li>
              ))}
              <li><a href="#up-plan" className="inline-flex items-center gap-1 rounded font-medium text-primary-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">Plan and pricing<ChevronRight className="size-3.5" aria-hidden /></a></li>
            </ul>
          </div>
          <HeroVisual className="hidden @2xl:block" />
        </div>
      </section>

      {/* 2. How it works: three steps on one line, like the automation they describe. */}
      <section aria-labelledby="up-how" className="grid gap-8 @4xl:grid-cols-[minmax(0,260px)_minmax(0,1fr)] @4xl:gap-12">
        <SectionHeader id="up-how" eyebrow="How it works" title="One conversation, start to finish" />
        <ol className="relative grid gap-6 @2xl:grid-cols-3 @2xl:gap-8">
          <span aria-hidden className="absolute bottom-3 left-[17px] top-3 w-px bg-[linear-gradient(var(--line-strong),var(--line-strong)_70%,transparent)] @2xl:inset-x-[18px] @2xl:bottom-auto @2xl:top-[17px] @2xl:h-px @2xl:w-auto @2xl:bg-[linear-gradient(90deg,var(--line-strong),var(--line-strong)_80%,transparent)]" />
          {STEPS.map((s, i) => (
            <li key={s.t} className="relative flex gap-4 @2xl:flex-col @2xl:gap-4">
              <span aria-hidden className={cn("relative inline-flex size-9 shrink-0 items-center justify-center rounded-full border text-[12.5px] font-semibold tabular-nums", i === 1 ? "brand-gradient border-transparent text-white shadow-glow" : "border-line-strong bg-surface text-ink-2")}>{i + 1}</span>
              <div className="min-w-0 pt-1 @2xl:pt-0">
                <h3 className="text-[16px] font-semibold text-ink"><span className="sr-only">Step {i + 1}: </span>{s.t}</h3>
                <p className="mt-1.5 text-pretty text-[14px] leading-relaxed text-muted">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* 3. The example, played back. */}
      <section aria-labelledby="up-see" className="space-y-7">
        <SectionHeader id="up-see" eyebrow="See it in action" title="One request, built step by step">
          Play it, step through it, or jump to a chapter. It’s a fixed example with sample steps: nothing here is your data, and nothing calls the builder.
        </SectionHeader>
        <BuilderDemo />
      </section>

      {/* 4. What the plan unlocks, each shown the way it looks in the product. */}
      <section aria-labelledby="up-get" className="space-y-7">
        <SectionHeader id="up-get" eyebrow="What the plan unlocks" title="Build it, test it, ship it safely">
          The builder is the start. These are the tools around it. Pictures use sample data.
        </SectionHeader>
        <ul className="grid gap-4 @2xl:grid-cols-2 @6xl:grid-cols-4">
          <Capability title="A real visual editor" visual={<EditorVisual />}>
            Drag, connect, copy and delete steps, with undo. The chat and the canvas change the same automation.
          </Capability>
          <Capability title="Test before it’s live" visual={<TestVisual />}>
            Run it for a real contact as a dry run. It shows what each step would do, and sends, calls and changes nothing.
          </Capability>
          <Capability title="Version history" visual={<VersionsVisual />}>
            Every published version is kept. Bring one back into your draft; what’s live keeps running until you publish.
          </Capability>
          <Capability title="Approval comes first" visual={<ApprovalVisual />}>
            Anything that messages customers or calls an outside system waits for the owner to approve that exact version. Consent, opt-out, quiet-hours and sending rules still apply.
          </Capability>
        </ul>
        <ul className="grid gap-x-8 gap-y-5 rounded-3xl border border-line bg-surface-2/70 p-5 sm:p-6 @2xl:grid-cols-2 @5xl:grid-cols-4">
          {[
            { icon: LayoutTemplate, t: "Templates", d: `${STUDIO_TEMPLATES.length} ready-made automations, each showing what your workspace still needs.` },
            { icon: PlugZap, t: "Connections", d: "HTTP requests and Slack messages, through connections you set up and check." },
            { icon: BarChart3, t: "Usage at a glance", d: "Runs, steps and builder messages against your monthly allowances." },
            { icon: Wrench, t: "Managed maintenance", d: `Monitoring, troubleshooting and reasonable changes by iAcquire${p.requestAllowance === null ? "" : `, within ${p.requestAllowance} request${p.requestAllowance === 1 ? "" : "s"} a month`}.` },
          ].map((x) => (
            <li key={x.t} className="flex gap-3">
              <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-primary-ink"><x.icon className="size-[18px]" /></span>
              <div className="min-w-0">
                <h3 className="text-[14.5px] font-semibold text-ink">{x.t}</h3>
                <p className="mt-0.5 text-pretty text-[13.5px] leading-relaxed text-muted">{x.d}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* 5. The plan: the price once, what changes and what doesn't, and every cost and limit. */}
      <section aria-labelledby="up-plan" className="scroll-mt-24 space-y-7">
        <SectionHeader id="up-plan" eyebrow="Plan and pricing" title="One optional plan. Nothing you have depends on it." />
        <div className="grid gap-4 @4xl:grid-cols-[minmax(0,400px)_minmax(0,1fr)] @6xl:grid-cols-[minmax(0,430px)_minmax(0,1fr)]">
          <div className="studio-stage flex flex-col rounded-3xl p-6 sm:p-8">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--stage-accent)]">{STUDIO_PLAN_NAME}</p>
            <p className="mt-4 flex items-baseline gap-2">
              <span className="text-[52px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{USD(p.monthlyUsd)}</span>
              <span className="text-[15px] text-[var(--stage-ink-2)]">/ month</span>
            </p>
            <p className="mt-4 text-pretty text-[14px] leading-relaxed text-[var(--stage-ink-2)]">
              Billed monthly from the date iAcquire confirms your plan. Separate from your {USD(p.setupFeeUsd)} one-time setup, which it doesn’t change.
            </p>
            <div className="mt-7"><Cta tone="stage" state={p.state} canRequest={p.canRequest} requestNote={p.requestNote} /></div>
            <div className="mt-auto pt-8">
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--stage-muted)]">What happens when you request</p>
              <ol className="mt-3 space-y-2.5 text-[13px] leading-snug text-[var(--stage-ink-2)]">
                {["You review the plan’s scope and price on the Maintenance page.", "The workspace owner sends the request.", "iAcquire reviews it and activates the plan. Billing starts on the date they confirm."].map((t, i) => (
                  <li key={t} className="flex gap-3">
                    <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--stage-line)] text-[12px] font-semibold tabular-nums text-[var(--stage-accent)]">{i + 1}</span>{t}
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="overflow-hidden rounded-3xl border border-line bg-surface">
            <table className="w-full text-left text-[14px]">
              <caption className="sr-only">What you have now, and what the plan adds</caption>
              <thead>
                <tr className="border-b border-line bg-surface-2/70 text-[12px] font-semibold text-muted">
                  <th scope="col" className="px-4 py-3 font-semibold sm:px-6"><span className="sr-only">Feature</span></th>
                  <th scope="col" className="w-[72px] px-1 py-3 text-center font-semibold sm:w-[120px]">Now</th>
                  <th scope="col" className="w-[72px] px-1 py-3 text-center font-semibold text-primary-ink sm:w-[120px]">With the plan</th>
                </tr>
              </thead>
              <tbody>
                <tr><th colSpan={3} scope="colgroup" className="px-4 pb-1 pt-4 text-[12px] font-semibold uppercase tracking-[0.12em] text-faint sm:px-6">Stays exactly as it is</th></tr>
                {rows.now.map((t) => (
                  <tr key={t} className="border-b border-line last:border-0">
                    <th scope="row" className="px-4 py-3 font-normal leading-snug text-ink-2 sm:px-6">{t}</th>
                    <td className="px-1 py-3 text-center"><Mark on label="Now" /></td>
                    <td className="px-1 py-3 text-center"><Mark on label="With the plan" /></td>
                  </tr>
                ))}
                <tr><th colSpan={3} scope="colgroup" className="px-4 pb-1 pt-5 text-[12px] font-semibold uppercase tracking-[0.12em] text-primary-ink sm:px-6">Added by the plan</th></tr>
                {rows.plan.map((t) => (
                  <tr key={t} className="border-b border-line last:border-0">
                    <th scope="row" className="px-4 py-3 font-medium leading-snug text-ink sm:px-6">{t}</th>
                    <td className="px-1 py-3 text-center"><Mark on={false} label="Now" /></td>
                    <td className="px-1 py-3 text-center"><Mark on label="With the plan" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* The fine print, in full: billing, limits, usage costs, and what happens without the plan. */}
        <dl className="gap-x-10 rounded-3xl border border-line bg-surface-2/60 p-5 *:mb-6 *:break-inside-avoid *:last:mb-0 sm:p-7 @2xl:columns-2 @6xl:columns-4">
          <div>
            <dt className="text-[14px] font-semibold text-ink">Billing</dt>
            <dd className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
              If a payment doesn’t go through, you keep Automation Studio for {PAYMENT_GRACE_DAYS} days while it’s sorted out, and you’re told the date. Work you ask iAcquire to do beyond the plan’s monthly request allowance, and new automations or software you ask them to build, are quoted separately, as they are today.
            </dd>
          </div>
          <div>
            <dt className="text-[14px] font-semibold text-ink">Fair-use allowances <span className="font-normal text-muted">(provisional)</span></dt>
            <dd className="mt-2.5">
              <ul className="grid grid-cols-2 gap-2">
                {[
                  [NUM(l.monthlyRuns), "automation runs"],
                  [NUM(l.monthlySteps), "steps"],
                  [NUM(l.monthlyBuilderMessages), "builder messages"],
                  [NUM(l.maxActiveWorkflows), "switched on at once"],
                ].map(([n, t]) => (
                  <li key={t} className="rounded-xl border border-line bg-surface px-3 py-2">
                    <span className="block text-[16px] font-semibold leading-tight text-ink tabular-nums">{n}</span>
                    <span className="block text-[12px] leading-snug text-muted">{t}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted">Runs, steps and builder messages are per month. You’re warned before you reach a limit. At a limit, new runs aren’t started and the builder pauses until the next month, unless iAcquire raises it; you can still edit by hand. These numbers may be adjusted as we learn what real usage costs.</p>
            </dd>
          </div>
          <div>
            <dt className="text-[14px] font-semibold text-ink">Usage costs stay as they are</dt>
            <dd className="mt-1.5 text-[13.5px] leading-relaxed text-muted">The AI builder is included, within the allowance. Texts, WhatsApp messages and emails your automations send are charged from your usage credits at today’s rates; the plan doesn’t change them. A workflow can’t send anything until it’s approved.</dd>
          </div>
          <div>
            <dt className="text-[14px] font-semibold text-ink">Without the plan, or if it ends</dt>
            <dd className="mt-1.5 text-[13.5px] leading-relaxed text-muted">Everything you have keeps working. If the plan ends, automations built in Automation Studio are paused, not deleted. {STUDIO_LAPSE_POLICY.kept} {STUDIO_LAPSE_POLICY.resume}</dd>
          </div>
        </dl>
      </section>

      {/* 6. The close: the same one action as the top. */}
      <section aria-labelledby="up-cta" className="studio-wash relative overflow-hidden rounded-[28px] border border-line px-5 py-12 shadow-card sm:px-10 sm:py-16">
        <div aria-hidden className="studio-dots pointer-events-none absolute inset-0 [mask-image:radial-gradient(60%_80%_at_50%_0%,#000,transparent)] opacity-70" />
        <div className="relative mx-auto flex max-w-xl flex-col items-center text-center">
          <h2 id="up-cta" className="text-balance text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[34px]">{closing}</h2>
          <p className="mt-3 text-pretty text-[15px] leading-relaxed text-muted">{closingNote}</p>
          <div className="mt-8 w-full"><Cta align="center" state={p.state} canRequest={p.canRequest} requestNote={p.requestNote} /></div>
          {p.saved.length > 0 && (
            <div className="mt-10 w-full max-w-md border-t border-line pt-6 text-left">
              <p className="text-[13px] font-semibold text-ink">Your saved automations <span className="font-normal text-muted">(paused)</span></p>
              <ul className="mt-3 space-y-1.5">
                {p.saved.map((w) => (
                  <li key={w.id}><Link href={`/automation-studio/${w.id}`} className="inline-flex items-center gap-1 rounded text-[13.5px] font-medium text-primary-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{w.name}<ChevronRight className="size-3.5" aria-hidden /></Link></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
