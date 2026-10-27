"use client";

import * as React from "react";
import { FlaskConical, Hand, Lock, Plug, ShieldCheck, Sparkles, Workflow } from "lucide-react";
import { BuilderDemo } from "@/components/automation-studio/demo/builder-demo";
import { STUDIO_INCLUDES } from "@/lib/demo/showroom/content";
import { StepNav } from "@/components/demo/showroom/journey";
import { ContextCta } from "@/components/demo/showroom/cta";
import { Chip, PlanTag, ScrollRegion, SectionHead, SimTag } from "@/components/demo/showroom/ui";

// Step 3: Automation Studio. The existing scripted example plays in full (it calls nothing and saves nothing); around it the page says plainly what the demo does and what a real
// automation does, what Auto and Manual mode are, and that Studio belongs to the OPTIONAL Managed Maintenance plan. The core system never waits on it, and a core client can still connect
// outside automation tools through the API and webhooks. The "build your own" box is a locked preview: it answers, it does not build.

const MODES = [
  { Icon: Sparkles, title: "Auto Mode", body: "Describe what you want in plain words. The builder drafts the steps on a visual canvas and explains each one. You can ask for changes in the chat." },
  { Icon: Hand, title: "Manual Mode", body: "A full editor for people who want to place and adjust every step themselves: triggers, messages, tasks, waits and conditions." },
  { Icon: FlaskConical, title: "Test before anything goes live", body: "Run an automation against sample data first and see what it would do. Nothing reaches a customer during a test." },
  { Icon: ShieldCheck, title: "Approval and safety controls", body: "Steps that contact customers or change records can require your approval, and the builder only uses the tools your business has connected." },
];

const COMPARE = [
  { topic: "Is anything sent to anyone?", demo: "No. It is a scripted example.", real: "Only the steps you turned on, to the people they are for, after you approve." },
  { topic: "Does it use my data?", demo: "No. It uses invented sample data.", real: "Your own CRM records and the channels you connected." },
  { topic: "Can I change it?", demo: "You can replay and step through it.", real: "Ask the builder for changes, or edit every step by hand in Manual Mode." },
  { topic: "What makes it live?", demo: "Nothing. It cannot go live.", real: "You test it, review it and switch it on yourself." },
];

export function AutomationView() {
  const [asked, setAsked] = React.useState(false);
  return (
    <div className="space-y-8">
      <SectionHead
        as="h1"
        eyebrow="Step 3 · Explore automations"
        title="Describe an automation. Watch it get built."
        lead="Automation Studio turns a sentence into a working flow on a canvas. This is a scripted example you can pause, step through and replay."
      />
      <div className="flex flex-wrap items-center gap-2">
        <PlanTag plan="maintenance" />
        <SimTag>Scripted example: nothing runs</SimTag>
      </div>

      <section aria-label="Automation Studio example" className="sx-panel p-3 @xl:p-5">
        <BuilderDemo />
      </section>

      <section aria-labelledby="modes-heading" className="space-y-5">
        <h2 id="modes-heading" className="sx-display text-[22px] leading-tight text-ink @xl:text-[24px]">
          Built to be safe to use
        </h2>
        <ul className="grid gap-4 @2xl:grid-cols-2">
          {MODES.map(({ Icon, title, body }) => (
            <li key={title} className="sx-panel flex gap-4 p-5">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-soft text-violet-ink">
                <Icon className="size-5" aria-hidden />
              </span>
              <div>
                <h3 className="text-[16px] font-semibold text-ink">{title}</h3>
                <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="compare-heading" className="space-y-4">
        <h2 id="compare-heading" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">
          This demo, and the real thing
        </h2>
        <ScrollRegion label="What the demo does compared with a real automation">
          <table className="w-full min-w-[640px] text-left text-[14px]">
            <caption className="sr-only">What the demo does compared with a real automation</caption>
            <thead className="bg-surface-2/70 text-[12px] uppercase tracking-[0.08em] text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">Question</th>
                <th scope="col" className="px-4 py-3 font-semibold">In this demo</th>
                <th scope="col" className="px-4 py-3 font-semibold">In your portal</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((r) => (
                <tr key={r.topic} className="border-t border-line align-top">
                  <th scope="row" className="px-4 py-3.5 font-semibold text-ink">{r.topic}</th>
                  <td className="px-4 py-3.5 text-ink-2">{r.demo}</td>
                  <td className="px-4 py-3.5 text-ink-2">{r.real}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>

      <section aria-labelledby="locked-heading" className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="locked-heading" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">
            Try your own
          </h2>
          <Chip tone="violet">
            <Lock className="size-3" aria-hidden />
            Locked in this demo
          </Chip>
        </div>
        <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="sx-panel sx-locked space-y-4 p-5">
            <label htmlFor="locked-prompt" className="text-[14px] font-semibold text-ink">
              Describe an automation
            </label>
            <textarea
              id="locked-prompt"
              readOnly
              rows={3}
              value="When a new enquiry arrives after hours, reply with our opening times and ask what they need."
              className="w-full resize-none rounded-xl border border-line bg-surface-2/70 px-4 py-3 text-[14px] leading-relaxed text-ink-2"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => setAsked(true)} aria-describedby="locked-note" className="sx-btn-quiet inline-flex h-11 items-center gap-2 rounded-xl px-5 text-[14px] font-semibold">
                <Lock className="size-4" aria-hidden />
                Build it
              </button>
              <p id="locked-note" role="status" className="text-[13px] leading-snug text-muted">
                {asked ? "Building your own automations is part of Managed Maintenance. This demo shows the scripted example above." : "Locked: available with Managed Maintenance."}
              </p>
            </div>
          </div>
          <div className="sx-panel space-y-3 p-5">
            <h3 className="flex items-center gap-2 text-[16px] font-semibold text-ink">
              <Workflow className="size-4 text-violet-ink" aria-hidden />
              What Managed Maintenance adds
            </h3>
            <ul className="space-y-2 text-[14px] leading-relaxed text-ink-2">
              {STUDIO_INCLUDES.map((s) => (
                <li key={s} className="flex gap-2.5">
                  <Lock className="mt-1 size-3.5 shrink-0 text-violet-ink" aria-hidden />
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <aside aria-label="Automation without Studio" className="sx-panel-flat flex gap-4 p-5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-success-soft text-success-ink">
          <Plug className="size-5" aria-hidden />
        </span>
        <div>
          <h3 className="text-[16px] font-semibold text-ink">Not adding Managed Maintenance? Your core system still connects.</h3>
          <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
            The CRM, the AI Employees, the inbox and booking never wait on the monthly plan. If you already use an automation tool such as n8n, Zapier or Make, you can connect it to your system through supported APIs and webhooks.
          </p>
        </div>
      </aside>

      <ContextCta
        plan="maintenance"
        locked
        title="Unlock Automation Studio with Managed Maintenance"
        body="Automation Studio is part of the optional monthly plan, which also covers monitoring and troubleshooting of your integrations. Ask us how it would fit your business."
        consultLabel="Ask about Managed Maintenance"
        secondary={{ view: "pricing", label: "Compare the plans" }}
      />
      <StepNav />
    </div>
  );
}
