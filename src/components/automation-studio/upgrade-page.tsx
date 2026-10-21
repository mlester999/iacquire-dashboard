import Link from "next/link";
import { ArrowRight, Bot, CheckCircle2, Lock, MessageSquareText, MousePointerClick, ShieldCheck, Sparkles, Wand2, Wrench } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { StaticCanvas } from "@/components/automation-studio/canvas/static-canvas";
import { STARTERS } from "@/lib/automation-studio/starters";
import { STUDIO_DEFAULT_LIMITS, STUDIO_LAPSE_POLICY, STUDIO_PLAN_NAME, PAYMENT_GRACE_DAYS, type StudioEntitlementState } from "@/lib/automation-studio/plan";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";

/** What the upgrade page shows for a plan that isn't active. Nothing here is the person's data: the canvas and the conversation are labelled examples. */
const EXAMPLE: WorkflowDefinition = {
  trigger: { type: "contact.created" },
  steps: [
    { key: "welcome", kind: "create_task", name: "Welcome the lead", config: { title: "Welcome {{contact.full_name}}", priority: "high", assignee: "contact_owner" }, next: "wait" },
    { key: "wait", kind: "wait", name: "Wait 2 days", config: { mode: "duration", amount: 2, unit: "days" }, next: "check" },
    { key: "check", kind: "branch", name: "Did they reply?", config: { subject: "contact", filter: { op: "and", conditions: [] }, reply: "replied" }, next: null, branches: { yes: "done", no: "nudge" } },
    { key: "done", kind: "end", name: "Nothing more to do", config: {}, next: null },
    { key: "nudge", kind: "notify_team", name: "Remind the team", config: { roles: ["owner", "admin"], title: "No reply yet: call {{contact.full_name}}" }, next: null },
  ] as unknown as WorkflowStep[],
};

const USD = (n: number) => `$${n.toLocaleString("en-US")}`;

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

function Cta({ state, canRequest, requestNote, size = "lg" }: Pick<UpgradeProps, "state" | "canRequest" | "requestNote"> & { size?: "md" | "lg" }) {
  const label = state === "pending" ? "View your request" : state === "expired" || state === "cancelled" ? "Reactivate the plan" : "Request Automation Studio";
  return (
    <div>
      <ButtonLink href="/maintenance" variant="brand" size={size}>{label}<ArrowRight className="size-4" aria-hidden /></ButtonLink>
      <p className="mt-2 text-[12.5px] leading-snug text-muted">
        {state === "pending"
          ? "iAcquire activates the plan after you request it. Nothing is charged by this page."
          : canRequest
            ? "You request the plan on the Maintenance page. iAcquire confirms and activates it, and billing starts on the date they confirm. Nothing is charged by this page."
            : requestNote ?? "Only the owner of your workspace can request the plan."}
      </p>
    </div>
  );
}

export function UpgradePage(p: UpgradeProps) {
  const l = STUDIO_DEFAULT_LIMITS;
  return (
    <div className="space-y-12">
      <section aria-labelledby="up-h" className="relative overflow-hidden rounded-3xl border border-line bg-surface px-5 py-10 shadow-md sm:px-10 sm:py-14">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(60%_80%_at_20%_0%,color-mix(in_srgb,var(--primary)_16%,transparent),transparent_70%)]" />
        <div className="relative grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 text-[12px] font-semibold uppercase tracking-wider text-muted"><Lock className="size-3.5" aria-hidden />Automation Studio · part of an optional plan</p>
            <h1 id="up-h" className="mt-4 text-balance text-[30px] font-semibold leading-tight tracking-tight text-ink sm:text-[42px]">Describe an automation. Watch it get built.</h1>
            <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-muted">Tell the AI Automation Builder what you want in plain English. It builds a real, editable automation in front of you, and you can keep changing it by chatting or by dragging things around.</p>
            {(p.state === "expired" || p.state === "cancelled") && <p className="mt-4 rounded-xl bg-warning-soft px-3.5 py-2.5 text-[13.5px] text-warning-ink" role="note">{p.reason}</p>}
            {p.state === "pending" && <p className="mt-4 rounded-xl bg-primary-soft px-3.5 py-2.5 text-[13.5px] text-primary-ink" role="note">{p.reason}</p>}
            <div className="mt-7"><Cta state={p.state} canRequest={p.canRequest} requestNote={p.requestNote} /></div>
          </div>
          <div className="rounded-2xl border border-line-strong bg-surface p-6 shadow-lg">
            <p className="text-[12px] font-semibold uppercase tracking-wider text-faint">{STUDIO_PLAN_NAME}</p>
            <p className="mt-2 flex items-baseline gap-1.5"><span className="text-[44px] font-semibold tracking-tight text-ink">{USD(p.monthlyUsd)}</span><span className="text-[15px] text-muted">/ month</span></p>
            <ul className="mt-4 space-y-2 text-[14px] text-ink-2">
              {["The AI Automation Builder and the live canvas", "The full visual editor, with undo and version history", "Testing, debugging and run history for every automation", "Managed maintenance: monitoring, reasonable changes and AI optimisation each month"].map((t) => <li key={t} className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />{t}</li>)}
            </ul>
            <p className="mt-4 border-t border-line pt-3 text-[12.5px] leading-relaxed text-muted">Optional, and separate from your {USD(p.setupFeeUsd)} one-time setup. You never need it to use what you already have.</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="up-how">
        <h2 id="up-how" className="text-[22px] font-semibold text-ink">How it works</h2>
        <ol className="mt-5 grid gap-4 md:grid-cols-3">
          {[
            { icon: MessageSquareText, t: "1. Say what you want", d: "“When a new lead comes in, welcome them, and remind us if they haven’t replied in two days.” That’s the whole brief." },
            { icon: Wand2, t: "2. Watch it appear", d: "Steps are added to a live canvas as the builder makes each change, with the connections drawn between them. What you see is what was really saved." },
            { icon: MousePointerClick, t: "3. Keep going your way", d: "Say “make that three days” or “don’t send on weekends”, or click a step and change it yourself. Both edit the same automation." },
          ].map((s) => (
            <li key={s.t} className="rounded-2xl border border-line bg-surface p-5 shadow-soft">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary-ink"><s.icon className="size-5" aria-hidden /></span>
              <h3 className="mt-3 text-[16px] font-semibold text-ink">{s.t}</h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{s.d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="up-see" className="grid items-start gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <h2 id="up-see" className="text-[22px] font-semibold text-ink">See what it looks like</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-muted">This is an example, not your data. It shows the kind of automation the builder makes and how it reads on the canvas.</p>
          <div className="mt-4 space-y-2.5" aria-label="Example conversation">
            <div className="ml-auto max-w-[90%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-[13.5px] text-primary-on">When a new lead comes in, welcome them, and if they haven’t replied after two days remind my team.</div>
            <div className="flex gap-2.5"><span aria-hidden className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full brand-gradient text-white"><Sparkles className="size-3.5" /></span><div className="max-w-[90%] rounded-2xl rounded-bl-md border border-line bg-surface px-3.5 py-2.5 text-[13.5px] text-ink">Done. Each new lead gets a welcome task. Two days later, if they haven’t replied, your team gets a reminder to call. Nothing goes out until you publish it.</div></div>
            <div className="ml-auto max-w-[90%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-[13.5px] text-primary-on">Actually, make that three days.</div>
          </div>
        </div>
        <StaticCanvas definition={EXAMPLE} label="An example automation: a welcome task, a two-day wait, a check for a reply, and a reminder to the team" />
      </section>

      <section aria-labelledby="up-get">
        <h2 id="up-get" className="text-[22px] font-semibold text-ink">What the plan includes</h2>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { icon: Bot, t: "An AI that edits, not just answers", d: "It changes the automation you already have instead of starting over, remembers the conversation for each automation, and explains what failed and why." },
            { icon: MousePointerClick, t: "A real visual editor", d: "Drag, connect, copy and delete steps. Undo and redo, and go back to an earlier published version whenever you need to." },
            { icon: ShieldCheck, t: "Safe by design", d: "Anything that messages a customer or calls an outside system needs your approval first, and every message still follows consent, opt-out, quiet-hours and sending rules." },
            { icon: Sparkles, t: "Ideas that fit your business", d: `Start from ${STARTERS.length} common requests (welcome, follow-up, reminders, reviews, pipeline updates) and see up front what your workspace still needs for each.` },
            { icon: Wrench, t: "Managed maintenance", d: "iAcquire keeps an eye on your automations and makes reasonable changes and improvements each month, within the plan’s monthly request allowance." },
            { icon: CheckCircle2, t: "Test before it’s live", d: "Run any automation as a dry run for a real contact: it shows what each step would do and sends nothing." },
          ].map((f) => (
            <li key={f.t} className="rounded-2xl border border-line bg-surface p-5 shadow-soft">
              <span className="inline-flex size-9 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><f.icon className="size-[18px]" aria-hidden /></span>
              <h3 className="mt-3 text-[15px] font-semibold text-ink">{f.t}</h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{f.d}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="up-keep" className="rounded-3xl border border-line bg-surface-2 p-6 sm:p-8">
        <h2 id="up-keep" className="text-[20px] font-semibold text-ink">Without the plan, nothing you have stops</h2>
        <ul className="mt-4 grid gap-2.5 text-[14px] text-ink-2 sm:grid-cols-2">
          {[
            "Your iAcquire CRM, including its own workflow builder and every workflow you already run",
            "Your AI employees, their schedules and their jobs",
            "Your n8n, Zapier and Make connections, webhooks and the API",
            "Support, and fixes for anything iAcquire got wrong",
          ].map((t) => <li key={t} className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />{t}</li>)}
        </ul>
        <p className="mt-4 text-[13.5px] leading-relaxed text-muted">{STUDIO_LAPSE_POLICY.kept} If the plan ends, automations built in Automation Studio are paused, not deleted. {STUDIO_LAPSE_POLICY.resume}</p>
      </section>

      <section aria-labelledby="up-cost">
        <h2 id="up-cost" className="text-[22px] font-semibold text-ink">What it costs, in full</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-line bg-surface p-5">
            <h3 className="text-[15px] font-semibold text-ink">The plan</h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{USD(p.monthlyUsd)} a month for {STUDIO_PLAN_NAME}. If a payment doesn’t go through you keep Automation Studio for {PAYMENT_GRACE_DAYS} days while it’s sorted out, and you’re told the date. Building automations yourself in Automation Studio is part of the plan; work you ask iAcquire to do beyond the plan’s monthly request allowance is quoted separately, as it is today.</p>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-5">
            <h3 className="text-[15px] font-semibold text-ink">Fair-use allowances (provisional)</h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">Each month: up to {l.monthlyRuns.toLocaleString("en-US")} automation runs, {l.monthlySteps.toLocaleString("en-US")} steps and {l.monthlyBuilderMessages} builder messages, with {l.maxActiveWorkflows} automations switched on at once. You’re warned before you reach a limit and you can see your usage at any time. These numbers may be adjusted as we learn what real usage costs.</p>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-5 md:col-span-2">
            <h3 className="text-[15px] font-semibold text-ink">Costs that already exist, and stay as they are</h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">The AI builder is included in the plan, within the allowance above. Texts, WhatsApp messages and emails your automations send are charged from your usage credits at the same rates they are today, and the plan doesn’t change them. A workflow can’t send anything until you’ve approved it.</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="up-cta" className="rounded-3xl border border-line bg-surface p-6 text-center shadow-md sm:p-10">
        <h2 id="up-cta" className="text-[24px] font-semibold text-ink">Ready to try it?</h2>
        <p className="mx-auto mt-2 max-w-lg text-[14px] leading-relaxed text-muted">Request the plan and iAcquire will confirm it with you. Until then everything you have keeps working exactly as it does now.</p>
        <div className="mx-auto mt-6 flex max-w-md justify-center text-left"><Cta state={p.state} canRequest={p.canRequest} requestNote={p.requestNote} /></div>
        {p.saved.length > 0 && (
          <div className="mx-auto mt-8 max-w-md border-t border-line pt-5 text-left">
            <p className="text-[13px] font-medium text-ink">Your saved automations (paused)</p>
            <ul className="mt-2 space-y-1">{p.saved.map((w) => <li key={w.id}><Link href={`/automation-studio/${w.id}`} className="text-[13.5px] text-primary hover:underline">{w.name}</Link></li>)}</ul>
          </div>
        )}
      </section>
    </div>
  );
}
