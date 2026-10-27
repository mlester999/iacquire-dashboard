import * as React from "react";
import { Check, ChevronDown, ShieldCheck, X } from "lucide-react";
import { DIY_ROWS, IMPLEMENTATION_SETS, NEXT_STEPS, WHY_BLOCKS, faqs } from "@/lib/demo/showroom/content";
import { SCOPE_NOTE } from "@/lib/demo/showroom/employees";
import { ScrollRegion, SectionHead, dollars } from "@/components/demo/showroom/ui";

// "Why iAcquireOS?": the case, in order, with the objections answered. It has no state, no session and no client code, so it renders the same inside the demo room and on its own public
// page (/demo/why), which stays open after a demo window ends. It states no competitor price, no percentage, no hours saved and no result: where it compares, it compares in words, and says
// that the figures depend on the tools a business would choose. The two prices passed in come from src/lib/billing.ts.

const MANUAL = [
  { task: "The first reply to an enquiry", manual: "Depends on who is free and who saw it first", ai: "Prepared quickly by an AI Employee, then approved by you" },
  { task: "Booking the meeting", manual: "Messages back and forth to find a time", ai: "Times offered from your real calendar, confirmation prepared" },
  { task: "Following up", manual: "Remembered, sometimes", ai: "A prepared nudge for deals that go quiet" },
  { task: "Keeping records right", manual: "Duplicates and gaps build up", ai: "The CRM Manager flags them with a suggested fix" },
  { task: "Knowing what is working", manual: "A spreadsheet when someone finds the time", ai: "A weekly note that says where each figure comes from" },
];

export function WhyContent({ setupFeeUsd, monthlyPlanUsd, actions, heading = "h1" }: { setupFeeUsd: number; monthlyPlanUsd: number; actions: React.ReactNode; heading?: "h1" | "h2" }) {
  const setup = dollars(setupFeeUsd);
  const monthly = dollars(monthlyPlanUsd);
  return (
    <div className="space-y-14">
      <SectionHead
        as={heading}
        eyebrow="Why iAcquireOS?"
        title="Win the follow-up, without adding to your admin."
        lead="iAcquireOS gives a business a CRM, a team of six AI Employees that prepare the repetitive work, and the people who set it all up. You stay in charge of everything that reaches a customer."
      />

      <ol className="space-y-5">
        {WHY_BLOCKS.map((b, i) => (
          <li key={b.id} className="sx-panel grid gap-5 p-6 @xl:p-8 @4xl:grid-cols-[72px_minmax(0,1fr)_minmax(0,0.9fr)]">
            <span className="sx-display text-[36px] leading-none text-primary-ink/60" aria-hidden>{String(i + 1).padStart(2, "0")}</span>
            <div className="space-y-2">
              <h2 className="text-[21px] font-semibold leading-snug tracking-[-0.01em] text-ink">{b.title}</h2>
              <p className="text-[15px] leading-relaxed text-ink-2">{b.lead}</p>
            </div>
            <ul className="space-y-2.5 self-center">
              {b.points.map((p) => (
                <li key={p} className="flex gap-2.5 text-[14px] leading-relaxed text-ink-2">
                  <Check className="mt-1 size-4 shrink-0 text-success-ink" aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      <section aria-labelledby="manual-heading" className="space-y-5">
        <SectionHead as="h2" eyebrow="AI Employees, not more admin" title="The same work, with and without them" />
        <ScrollRegion label="Table: the same work by hand and with AI Employees">
          <table className="w-full min-w-[640px] text-left text-[14px]">
            <caption id="manual-heading" className="sr-only">Manual administration compared with AI Employees</caption>
            <thead className="bg-surface-2/70 text-[12px] uppercase tracking-[0.08em] text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">The work</th>
                <th scope="col" className="px-4 py-3 font-semibold">By hand</th>
                <th scope="col" className="px-4 py-3 font-semibold text-primary-ink">With AI Employees</th>
              </tr>
            </thead>
            <tbody>
              {MANUAL.map((r) => (
                <tr key={r.task} className="border-t border-line align-top">
                  <th scope="row" className="px-4 py-3.5 font-semibold text-ink">{r.task}</th>
                  <td className="px-4 py-3.5 text-muted">{r.manual}</td>
                  <td className="px-4 py-3.5 text-ink-2">{r.ai}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>

      <section aria-labelledby="diy-heading" className="space-y-5">
        <SectionHead as="h2" eyebrow="Building it yourself" title="Done-for-you, or do-it-yourself?" lead="You could assemble this from separate tools. Here is what that involves, side by side. We do not quote other companies' prices: list the tools you would choose, add up their subscriptions and your own time, and compare." />
        <ScrollRegion label="Building it yourself compared with iAcquireOS">
          <table className="w-full min-w-[680px] text-left text-[14px]">
            <caption id="diy-heading" className="sr-only">Building the pieces yourself compared with iAcquireOS</caption>
            <thead className="bg-surface-2/70 text-[12px] uppercase tracking-[0.08em] text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold"><span className="sr-only">Topic</span></th>
                <th scope="col" className="px-4 py-3 font-semibold">Do it yourself</th>
                <th scope="col" className="px-4 py-3 font-semibold text-primary-ink">iAcquireOS</th>
              </tr>
            </thead>
            <tbody>
              {DIY_ROWS.map((r) => (
                <tr key={r.topic} className="border-t border-line align-top">
                  <th scope="row" className="px-4 py-3.5 font-semibold text-ink">{r.topic}</th>
                  <td className="px-4 py-3.5 text-muted">{r.diy}</td>
                  <td className="px-4 py-3.5 text-ink-2">{r.iacquire}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
        <p className="text-[13px] text-muted">An illustration in words. Real costs depend on the tools you would choose and how much of your own time you value.</p>
      </section>

      <section aria-labelledby="price-why" className="sx-panel sx-panel-hot grid gap-6 p-6 @xl:p-8 @4xl:grid-cols-[minmax(0,1fr)_auto] @4xl:items-center">
        <div className="space-y-2">
          <h2 id="price-why" className="sx-display text-[24px] leading-tight text-ink @xl:text-[28px]">Pricing that is easy to read</h2>
          <p className="max-w-2xl text-[15px] leading-relaxed text-ink-2">
            The implementation starts at {setup}, paid once, and you use your system without a mandatory subscription. Managed Maintenance, at {monthly} a month, is optional: it adds monitoring, troubleshooting and Automation Studio. Usage-based costs are separate and shown in your portal.
          </p>
        </div>
        <dl className="flex gap-8">
          <div>
            <dt className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">From, once</dt>
            <dd className="sx-display text-[36px] leading-none text-ink">{setup}</dd>
          </div>
          <div>
            <dt className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">Optional</dt>
            <dd className="sx-display text-[36px] leading-none text-ink">{monthly}<span className="ml-1 text-[14px] text-muted">/mo</span></dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="setup-heading" className="space-y-6">
        <SectionHead as="h2" eyebrow="What to expect" title="How it goes from here" lead={SCOPE_NOTE} />
        <div className="grid gap-6 @4xl:grid-cols-2">
          <ol className="space-y-4">
            {NEXT_STEPS.map((s, i) => (
              <li key={s.title} className="sx-panel-flat flex gap-4 p-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-soft text-[14px] font-semibold text-primary-ink">{i + 1}</span>
                <div>
                  <h3 className="text-[16px] font-semibold text-ink">{s.title}</h3>
                  <p className="mt-0.5 text-[14px] leading-relaxed text-ink-2">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="sx-panel space-y-3 p-6">
            <h3 id="setup-heading" className="text-[16px] font-semibold text-ink">What the iAcquire team configures for you</h3>
            <ul className="space-y-2.5">
              {IMPLEMENTATION_SETS.map((s) => (
                <li key={s} className="flex gap-2.5 text-[14px] leading-relaxed text-ink-2">
                  <Check className="mt-1 size-4 shrink-0 text-success-ink" aria-hidden />
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section aria-labelledby="control-heading" className="grid gap-5 @2xl:grid-cols-2">
        <div className="sx-panel space-y-3 p-6">
          <h2 id="control-heading" className="flex items-center gap-2 text-[18px] font-semibold text-ink">
            <ShieldCheck className="size-5 text-success-ink" aria-hidden />
            You stay in control
          </h2>
          <ul className="space-y-2 text-[14px] leading-relaxed text-ink-2">
            <li>Anything that reaches a customer or changes a record waits for your approval</li>
            <li>Each AI Employee has one scoped job and only works with your own data</li>
            <li>Every action and approval is recorded: who did what, and when</li>
          </ul>
        </div>
        <div className="sx-panel space-y-3 p-6">
          <h2 className="flex items-center gap-2 text-[18px] font-semibold text-ink">
            <X className="size-5 text-warning-ink" aria-hidden />
            What it is not
          </h2>
          <ul className="space-y-2 text-[14px] leading-relaxed text-ink-2">
            <li>Not a promise of results: it removes admin and gaps, it does not guarantee sales</li>
            <li>Not a replacement for your people, who make the decisions that matter</li>
            <li>Not a closed box: the core system connects to your other tools through supported APIs and webhooks</li>
          </ul>
        </div>
      </section>

      <section aria-labelledby="faq-heading" className="space-y-5">
        <SectionHead as="h2" eyebrow="Questions people ask" title="Straight answers" />
        <h3 id="faq-heading" className="sr-only">Frequently asked questions</h3>
        <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
          {faqs(setup, monthly).map((f) => (
            <details key={f.q} className="group bg-surface/60 px-5 py-4 open:bg-surface-2/70">
              <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
                {f.q}
                <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-ink-2">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {actions}
    </div>
  );
}
