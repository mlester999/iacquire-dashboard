import * as React from "react";
import Link from "next/link";
import { ArrowRight, Hourglass, Link2Off, Sparkles } from "lucide-react";
import { Chip } from "@/components/demo/showroom/ui";
import { Benefits, ExploreSection, FormStepper, HandoffPreview, ReturnLink, TeamSection, WhyBand } from "@/components/demo/landing-sections";
import { DemoRequestForm } from "@/components/demo/request-form";
import { DemoMessage, DemoNotice } from "@/components/demo/shell";
import { PUBLIC_COPY } from "@/lib/demo/copy";
import { DEMO_INDUSTRIES } from "@/lib/demo/industries";
import { demoNotice } from "@/lib/demo/notice";
import type { FormField, Notice } from "@/lib/demo/outcomes";
import type { FormView, Refused } from "@/server/demo/public";
import "@/components/demo/showroom/showroom.css";

// The page that asks for a demo. It is only ever built from what the service returned: when the demo is not open (or is stopped) it says so and shows no form; when today's places
// are taken it says that; otherwise it says what a demo is, truthfully for the settings in force (the AI chat is mentioned only when it can answer), and shows the form.
//
// Layout: the first screen is the pitch on the left and the form on the right (the form comes right after the headline on a phone); below it, who the visitor will meet and what they can
// explore. Everything the old page said is still here; nothing is added that the settings do not support.

export function DemoLanding({
  view,
  notice,
  fieldErrors,
  utm,
}: {
  view: { ok: true; form: FormView } | Refused;
  notice: Notice | null;
  fieldErrors: FormField[];
  utm: Record<string, string>;
}) {
  if (!view.ok) {
    const stopped = view.reason === "rate_limited";
    return (
      <DemoMessage icon={stopped ? Hourglass : Link2Off} title={view.reason === "not_available" ? "The demo is not open" : "The demo is not available"}>
        <p>{view.message}</p>
        <DemoNotice notice={notice} />
      </DemoMessage>
    );
  }
  const form = view.form;
  return (
    <div className="space-y-14 sm:space-y-20">
      {form.hasSession && (
        <div className="sx-panel sx-panel-hot flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="text-[14px] font-medium text-ink">You already have a demo open in this browser.</p>
          <Link href="/demo/room" className="sx-btn-primary inline-flex h-11 items-center gap-2 rounded-xl px-5 text-[14px] font-semibold">
            Continue your demo
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-x-14 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)] lg:grid-rows-[auto_1fr]">
        <header className="space-y-6 lg:col-start-1 lg:row-start-1">
          <Chip tone="info">
            <Sparkles className="size-3" aria-hidden />
            Free guided demo
          </Chip>
          <h1 className="text-balance text-[36px] font-semibold leading-[1.06] tracking-[-0.045em] text-ink sm:text-[46px] lg:text-[52px]">
            See your <span className="sx-gradient-text">AI team</span> at work
          </h1>
          <p className="max-w-xl text-[17px] leading-relaxed text-ink-2">
            Tell us a little about your business. We email you a link to a guided demo of the six AI Employees, using sample data only. Nothing is sent to anyone and no workspace is created.
          </p>
        </header>

        <div id="request" className="scroll-mt-6 space-y-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:sticky lg:top-6">
          <DemoNotice notice={notice} />
          {form.full ? (
            <p role="status" className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[14px] leading-relaxed text-warning-ink">
              {PUBLIC_COPY.daily_cap}
            </p>
          ) : (
            <section aria-labelledby="request-heading" className="sx-panel sx-panel-hot relative overflow-hidden p-5 sm:p-7">
              <span aria-hidden className="brand-gradient absolute inset-x-0 top-0 h-1" />
              <div className="mb-6 space-y-4">
                <h2 id="request-heading" className="text-[22px] font-semibold tracking-[-0.025em] text-ink">
                  Ask for your demo
                </h2>
                <FormStepper />
              </div>
              <DemoRequestForm industries={DEMO_INDUSTRIES} notice={demoNotice(form.retentionDays)} utm={utm} initialErrors={fieldErrors} />
            </section>
          )}
          <ReturnLink />
        </div>

        <div className="space-y-8 lg:col-start-1 lg:row-start-2">
          <Benefits form={form} />
          <HandoffPreview />
        </div>
      </div>

      <TeamSection />
      <ExploreSection />
      <WhyBand />
    </div>
  );
}
