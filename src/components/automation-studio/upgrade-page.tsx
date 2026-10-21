import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, Bot, Check, ChevronRight, FlaskConical, History, LayoutTemplate, Lock, MessageSquareText, MousePointerClick, ShieldCheck, Wand2, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { ButtonLink } from "@/components/ui/button";
import { BuilderDemo } from "@/components/automation-studio/builder-demo";
import { STARTERS } from "@/lib/automation-studio/starters";
import { STUDIO_TEMPLATES } from "@/lib/automation-studio/templates";
import { STUDIO_DEFAULT_LIMITS, STUDIO_LAPSE_POLICY, STUDIO_PLAN_NAME, PAYMENT_GRACE_DAYS, type StudioEntitlementState } from "@/lib/automation-studio/plan";

/** What the upgrade page shows for a plan that isn't active. Nothing here is the person's data: the canvas and the conversation are labelled examples. */

const USD = (n: number) => `$${n.toLocaleString("en-US")}`;
const NUM = (n: number) => n.toLocaleString("en-US");

export interface UpgradeProps {
  state: StudioEntitlementState;
  /** In words: why the plan isn't active (a pending request, an expired plan…). */
  reason: string;
  monthlyUsd: number;
  setupFeeUsd: number;
  /** The existing enrolment flow can take the request now (the core system is activated and this person is the owner). */
  canRequest: boolean;
  /** Why the plan can't be requested yet, in words, or null. */
  requestNote: string | null;
  /** Automations built before the plan ended, kept and paused. */
  saved: Array<{ id: string; name: string }>;
}

/** What the button says and what the line under it explains. The button only ever opens the Maintenance page, where the real request is made. */
function ctaCopy({ state, canRequest, requestNote }: Pick<UpgradeProps, "state" | "canRequest" | "requestNote">) {
  const label = state === "pending" ? "View your request" : state === "expired" || state === "cancelled" ? "Reactivate the plan" : "Request Automation Studio";
  const note = state === "pending"
    ? "iAcquire activates the plan after reviewing your request. Nothing is charged from this page."
    : canRequest
      ? "You’ll review the terms and send the request on the Maintenance page. Billing starts on the date iAcquire confirms. Nothing is charged from this page."
      : requestNote ?? "Only the owner of your workspace can request the plan.";
  return { label, note };
}

function Cta({ align = "start", ...p }: Pick<UpgradeProps, "state" | "canRequest" | "requestNote"> & { align?: "start" | "center" }) {
  const { label, note } = ctaCopy(p);
  return (
    <div className={cn("flex flex-col gap-3", align === "center" ? "items-center text-center" : "items-start")}>
      <ButtonLink href="/maintenance" variant="brand" size="lg" className="group w-full sm:w-auto">
        {label}<ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" aria-hidden />
      </ButtonLink>
      <p className={cn("max-w-md text-[12.5px] leading-relaxed text-muted", align === "center" && "mx-auto")}>{note}</p>
    </div>
  );
}

function SectionHeader({ id, eyebrow, title, children, center }: { id: string; eyebrow: string; title: string; children?: ReactNode; center?: boolean }) {
  return (
    <div className={cn("max-w-2xl", center && "mx-auto text-center")}>
      <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-primary-ink">{eyebrow}</p>
      <h2 id={id} className="mt-2 scroll-mt-28 text-balance text-[24px] font-semibold leading-tight tracking-tight text-ink sm:text-[28px]">{title}</h2>
      {children && <p className="mt-2.5 text-pretty text-[15px] leading-relaxed text-muted">{children}</p>}
    </div>
  );
}

const STEPS = [
  { icon: MessageSquareText, t: "Describe it", d: "Write what should happen, the way you’d explain it to a colleague." },
  { icon: Wand2, t: "Watch it build", d: "Each step appears on a live canvas as it’s saved, already connected." },
  { icon: MousePointerClick, t: "Refine it", d: "Ask for a change in the chat or edit a step yourself. Both change the same automation." },
];

const CORE = [
  "Your iAcquire CRM, its workflow builder and every workflow you already run",
  "Your AI employees, their schedules and their jobs",
  "n8n, Zapier and Make connections, webhooks and the API",
  "Support, and fixes for anything iAcquire got wrong",
];
const PLAN_ONLY = [
  "The AI Automation Builder and the live canvas",
  "The full visual editor, with undo and version history",
  "Testing, debugging and run history for every automation",
  "Managed maintenance: monitoring, reasonable changes and AI optimisation each month",
];

function Tile({ icon: Icon, title, children, className, visual }: { icon: ComponentType<{ className?: string }>; title: string; children: ReactNode; className?: string; visual?: ReactNode }) {
  return (
    <li className={cn("group flex flex-col rounded-2xl border border-line bg-surface p-5 transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-md sm:p-6", className)}>
      <div className="flex items-center gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-ink"><Icon className="size-[18px]" aria-hidden /></span>
        <h3 className="text-[15.5px] font-semibold leading-snug text-ink">{title}</h3>
      </div>
      <p className="mt-3 text-pretty text-[14px] leading-relaxed text-muted">{children}</p>
      {visual && <div aria-hidden className="mt-5 flex flex-1 items-end">{visual}</div>}
    </li>
  );
}

export function UpgradePage(p: UpgradeProps) {
  const l = STUDIO_DEFAULT_LIMITS;
  const lapsed = p.state === "expired" || p.state === "cancelled";
  const closing = p.state === "pending" ? "Your request is with iAcquire" : lapsed ? "Pick up where you left off" : "Start with one sentence";
  const closingNote = p.state === "pending"
    ? "You’ll hear from iAcquire when the plan is active. Until then, everything you have keeps working as it does now."
    : lapsed
      ? "Reactivate the plan and your saved automations are ready to check and switch back on."
      : "Request the plan and iAcquire confirms it with you. Until then, everything you have keeps working as it does now.";

  return (
    <div className="@container mx-auto max-w-[1180px] space-y-16 pb-4 sm:space-y-20">
      {/* Hero: the promise on the left, the price beside it, one composition. */}
      <section aria-labelledby="up-h" className="relative overflow-hidden rounded-3xl border border-line bg-surface shadow-md">
        <div aria-hidden className="pointer-events-none absolute inset-0 [background:radial-gradient(70%_90%_at_0%_0%,color-mix(in_srgb,var(--primary)_11%,transparent),transparent_65%)]" />
        <div className="relative grid @4xl:grid-cols-[minmax(0,1fr)_340px] @6xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex flex-col justify-center px-5 py-10 sm:px-10 sm:py-14 @4xl:py-16 @4xl:pl-12 @4xl:pr-10">
            <p className="inline-flex w-fit items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12px] font-semibold text-muted">
              <Lock className="size-3.5" aria-hidden />Automation Studio<span aria-hidden className="text-faint">·</span><span className="font-medium">Optional plan</span>
            </p>
            <h1 id="up-h" className="mt-5 text-balance text-[34px] font-semibold leading-[1.08] tracking-[-0.025em] text-ink @2xl:text-[44px] @6xl:text-[52px]">
              <span className="@2xl:block">Describe an automation.</span> <span className="text-gradient @2xl:block">Watch it get built.</span>
            </h1>
            <p className="mt-5 max-w-[46ch] text-pretty text-[16px] leading-relaxed text-muted sm:text-[17px]">
              Tell the AI Automation Builder what you want in plain English. It builds a real, editable automation in front of you, and you keep shaping it by chatting or editing.
            </p>
            {lapsed && <p className="mt-5 max-w-xl rounded-xl bg-warning-soft px-3.5 py-2.5 text-[13.5px] text-warning-ink" role="note">{p.reason}</p>}
            {p.state === "pending" && <p className="mt-5 max-w-xl rounded-xl bg-primary-soft px-3.5 py-2.5 text-[13.5px] text-primary-ink" role="note">{p.reason}</p>}
            <div className="mt-8"><Cta state={p.state} canRequest={p.canRequest} requestNote={p.requestNote} /></div>
            <a href="#up-see" className="mt-6 inline-flex w-fit items-center gap-1.5 rounded-lg text-[13.5px] font-medium text-primary-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
              See it build an automation<ArrowDown className="size-3.5" aria-hidden />
            </a>
          </div>

          {/* Stacked under the copy it reads as a row (price, then the terms beside it); beside the copy, as a column. */}
          <aside aria-label="Plan price" className="grid content-center gap-6 border-t border-line bg-surface-2/70 px-5 py-8 sm:px-10 @2xl:grid-cols-2 @2xl:items-center @2xl:gap-10 @4xl:grid-cols-1 @4xl:gap-6 @4xl:border-l @4xl:border-t-0 @4xl:px-9 @4xl:py-12">
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-faint">{STUDIO_PLAN_NAME}</p>
              <p className="mt-3 flex items-baseline gap-1.5">
                <span className="text-[48px] font-semibold leading-none tracking-tight text-ink tabular-nums">{USD(p.monthlyUsd)}</span>
                <span className="text-[15px] text-muted">/ month</span>
              </p>
              <p className="mt-4 text-pretty text-[14px] leading-relaxed text-ink-2">The builder, the visual editor, testing tools and managed maintenance, in one optional monthly plan.</p>
            </div>
            <div>
              <dl className="divide-y divide-line rounded-xl border border-line bg-surface text-[13px]">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <dt className="text-muted">One-time setup</dt>
                  <dd className="font-medium text-ink tabular-nums">{USD(p.setupFeeUsd)} <span className="font-normal text-muted">· separate</span></dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <dt className="text-muted">Needed for what you have</dt>
                  <dd className="font-medium text-ink">No</dd>
                </div>
              </dl>
              <a href="#up-plan" className="mt-5 inline-flex w-fit items-center gap-1 rounded-lg text-[13px] font-medium text-primary-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
                What’s included and what it costs<ChevronRight className="size-3.5" aria-hidden />
              </a>
            </div>
          </aside>
        </div>
      </section>

      {/* How it works: three steps, read left to right. */}
      <section aria-labelledby="up-how" className="space-y-7">
        <SectionHeader id="up-how" eyebrow="How it works" title="From a sentence to a working automation" />
        <ol className="grid overflow-hidden rounded-2xl border border-line bg-surface @2xl:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.t} className={cn("relative flex gap-4 p-5 sm:p-6 @2xl:flex-col @2xl:gap-0", i > 0 && "border-t border-line @2xl:border-l @2xl:border-t-0")}>
              <div className="flex shrink-0 items-center gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary-ink"><s.icon className="size-5" aria-hidden /></span>
                <span aria-hidden className="hidden text-[12px] font-semibold tabular-nums tracking-[0.14em] text-faint @2xl:inline">0{i + 1}</span>
              </div>
              <div className="min-w-0 @2xl:mt-4">
                <h3 className="text-[16px] font-semibold text-ink"><span className="sr-only">Step {i + 1}: </span><span aria-hidden className="mr-1.5 tabular-nums text-faint @2xl:hidden">{i + 1}.</span>{s.t}</h3>
                <p className="mt-1.5 text-pretty text-[14px] leading-relaxed text-muted">{s.d}</p>
              </div>
              {i < STEPS.length - 1 && (
                <span aria-hidden className="absolute -right-3 top-1/2 z-10 hidden size-6 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface text-faint shadow-sm @2xl:inline-flex"><ChevronRight className="size-3.5" /></span>
              )}
            </li>
          ))}
        </ol>
      </section>

      {/* The example, played back on the real canvas. */}
      <section aria-labelledby="up-see" className="space-y-7">
        <SectionHeader id="up-see" eyebrow="See it in action" title="Ask in plain English. Refine by chatting.">
          A short example of the builder at work. It’s an illustration, not your data, and nothing is saved.
        </SectionHeader>
        <BuilderDemo />
      </section>

      {/* What the plan adds, as one composition rather than a row of identical cards. */}
      <section aria-labelledby="up-get" className="space-y-7">
        <SectionHeader id="up-get" eyebrow="What the plan includes" title="Everything you need to build, test and keep automations running" />
        <ul className="grid gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
          <Tile
            icon={Bot}
            title="An AI that edits, not just answers"
            className="@2xl:col-span-2"
            visual={
              <div className="w-full space-y-2 rounded-xl border border-line bg-surface-2 p-3">
                <p className="ml-auto w-fit max-w-[85%] rounded-xl rounded-br-sm bg-primary px-3 py-1.5 text-[12.5px] text-primary-on">Only remind the owner, not the whole team.</p>
                <p className="w-fit max-w-[85%] rounded-xl rounded-bl-sm border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink">Updated “Remind the team” so only the owner is notified. Nothing else changed.</p>
              </div>
            }
          >
            It changes the automation you already have instead of starting over, remembers the conversation for each automation, and explains what failed and why.
          </Tile>
          <Tile
            icon={MousePointerClick}
            title="A real visual editor"
            visual={
              <div className="flex w-full items-center gap-1.5 text-[12px] font-medium text-ink-2">
                <span className="rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 shadow-sm">Trigger</span>
                <span className="h-px flex-1 bg-line-strong" />
                <span className="rounded-lg border border-primary bg-primary-soft px-2.5 py-1.5 text-primary-ink shadow-sm">Step</span>
                <span className="h-px flex-1 bg-line-strong" />
                <span className="rounded-lg border border-dashed border-line-strong px-2.5 py-1.5 text-faint">+</span>
              </div>
            }
          >
            Drag, connect, copy and delete steps, with undo and redo.
          </Tile>
          <Tile
            icon={History}
            title="Version history"
            visual={
              <ul className="w-full divide-y divide-line rounded-xl border border-line text-[12px]">
                <li className="flex items-center justify-between px-3 py-1.5"><span className="font-medium text-ink">Version 3</span><span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success-ink">Live</span></li>
                <li className="flex items-center justify-between px-3 py-1.5 text-muted"><span>Version 2</span><span>Restore</span></li>
              </ul>
            }
          >
            Go back to an earlier published version whenever you need to.
          </Tile>
          <Tile icon={FlaskConical} title="Test before it’s live">
            Run any automation as a dry run for a real contact. It shows what each step would do and sends nothing.
          </Tile>
          <Tile icon={ShieldCheck} title="Safe by design">
            Anything that messages a customer or calls an outside system needs your approval first, and every message still follows consent, opt-out, quiet-hours and sending rules.
          </Tile>
          <Tile icon={LayoutTemplate} title="Templates and ideas">
            Start from {STUDIO_TEMPLATES.length} ready-made automations or {STARTERS.length} common requests, and see up front what your workspace still needs for each.
          </Tile>
          <Tile
            icon={Wrench}
            title="Managed maintenance"
            className="@5xl:col-span-2"
            visual={
              <ul className="flex flex-wrap gap-2 text-[12px] font-medium text-ink-2">
                {["Monitoring", "Reasonable changes", "AI optimisation"].map((t) => <li key={t} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1"><Check className="size-3 text-primary" />{t}</li>)}
              </ul>
            }
          >
            iAcquire keeps an eye on your automations and makes reasonable changes and improvements each month, within the plan’s monthly request allowance.
          </Tile>
        </ul>
      </section>

      {/* The plan, in full: what changes, what stays, and every cost. */}
      <section aria-labelledby="up-plan" className="space-y-7">
        <SectionHeader id="up-plan" eyebrow="Plan and pricing" title="Optional, and nothing you have depends on it" />
        <div className="grid gap-4 @2xl:grid-cols-2">
          <div className="flex flex-col rounded-2xl border border-line bg-surface p-5 sm:p-7">
            <h3 className="text-[16px] font-semibold text-ink">Without the plan</h3>
            <p className="mt-1 text-[13.5px] text-muted">Everything you have keeps working.</p>
            <ul className="mb-6 mt-5 space-y-3 text-[14px] leading-snug text-ink-2">
              {CORE.map((t) => <li key={t} className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />{t}</li>)}
            </ul>
            <p className="mt-auto border-t border-line pt-4 text-[13px] leading-relaxed text-muted">{STUDIO_LAPSE_POLICY.kept} If the plan ends, automations built in Automation Studio are paused, not deleted. {STUDIO_LAPSE_POLICY.resume}</p>
          </div>
          <div className="flex flex-col rounded-2xl border border-primary/40 bg-surface p-5 shadow-md sm:p-7">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="text-[16px] font-semibold text-ink">With the plan</h3>
              <p className="text-[14px] text-muted"><span className="text-[20px] font-semibold text-ink tabular-nums">{USD(p.monthlyUsd)}</span> / month</p>
            </div>
            <p className="mt-1 text-[13.5px] text-muted">All of the above, plus:</p>
            <ul className="mb-6 mt-5 space-y-3 text-[14px] leading-snug text-ink-2">
              {PLAN_ONLY.map((t) => <li key={t} className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />{t}</li>)}
            </ul>
            <p className="mt-auto border-t border-line pt-4 text-[13px] leading-relaxed text-muted">Separate from your {USD(p.setupFeeUsd)} one-time setup. You never need it to use what you already have.</p>
          </div>
        </div>

        <div className="grid gap-4 @4xl:grid-cols-3">
          <div className="rounded-2xl border border-line bg-surface-2 p-5">
            <h3 className="text-[14.5px] font-semibold text-ink">Billing</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{USD(p.monthlyUsd)} a month for {STUDIO_PLAN_NAME}. If a payment doesn’t go through, you keep Automation Studio for {PAYMENT_GRACE_DAYS} days while it’s sorted out, and you’re told the date. Work you ask iAcquire to do beyond the plan’s monthly request allowance is quoted separately, as it is today.</p>
          </div>
          <div className="rounded-2xl border border-line bg-surface-2 p-5">
            <h3 className="text-[14.5px] font-semibold text-ink">Fair-use allowances <span className="font-normal text-muted">(provisional)</span></h3>
            <dl className="mt-3 grid grid-cols-2 gap-2">
              {[
                [NUM(l.monthlyRuns), "automation runs"],
                [NUM(l.monthlySteps), "steps"],
                [NUM(l.monthlyBuilderMessages), "builder messages"],
                [NUM(l.maxActiveWorkflows), "switched on at once"],
              ].map(([n, t]) => (
                <div key={t} className="flex flex-col-reverse rounded-xl border border-line bg-surface px-3 py-2">
                  <dt className="text-[11.5px] leading-snug text-muted">{t}</dt>
                  <dd className="text-[16px] font-semibold leading-tight text-ink tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-[12.5px] leading-relaxed text-muted">Runs, steps and builder messages are per month. You’re warned before you reach a limit and can see your usage at any time. These numbers may be adjusted as we learn what real usage costs.</p>
          </div>
          <div className="rounded-2xl border border-line bg-surface-2 p-5">
            <h3 className="text-[14.5px] font-semibold text-ink">Usage costs stay as they are</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted">The AI builder is included, within the allowance. Texts, WhatsApp messages and emails your automations send are charged from your usage credits at today’s rates; the plan doesn’t change them. A workflow can’t send anything until you’ve approved it.</p>
          </div>
        </div>
      </section>

      {/* The close: one action, the same one as the top. */}
      <section aria-labelledby="up-cta" className="relative overflow-hidden rounded-3xl border border-line bg-surface px-5 py-12 shadow-md sm:px-10 sm:py-16">
        <div aria-hidden className="pointer-events-none absolute inset-0 [background:radial-gradient(60%_100%_at_50%_0%,color-mix(in_srgb,var(--primary)_10%,transparent),transparent_70%)]" />
        <div className="relative mx-auto flex max-w-xl flex-col items-center text-center">
          <h2 id="up-cta" className="text-balance text-[26px] font-semibold leading-tight tracking-tight text-ink sm:text-[32px]">{closing}</h2>
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
