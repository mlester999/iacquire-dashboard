import * as React from "react";
import Link from "next/link";
import { Hourglass, Link2Off, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/primitives";
import { DemoRequestForm } from "@/components/demo/request-form";
import { DemoMessage, DemoNotice, linkClass } from "@/components/demo/shell";
import { PUBLIC_COPY } from "@/lib/demo/copy";
import { DEMO_INDUSTRIES } from "@/lib/demo/industries";
import { demoNotice } from "@/lib/demo/notice";
import type { FormField, Notice } from "@/lib/demo/outcomes";
import type { FormView, Refused } from "@/server/demo/public";

// The page that asks for a demo. It is only ever built from what the service returned: when the demo is not open (or is stopped) it says so and shows no form; when today's places
// are taken it says that; otherwise it says what a demo is, truthfully for the settings in force (the AI chat is mentioned only when it can answer), and shows the form.

const hours = (n: number) => `${n} hour${n === 1 ? "" : "s"}`;

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
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.045em] text-ink sm:text-[34px]">See your AI team at work</h1>
        <p className="text-[15px] leading-relaxed text-ink-2">
          Tell us a little about your business. We email you a link to a guided demo of the six AI Employees, using sample data only. Nothing is sent to anyone and no workspace is created.
        </p>
        <ul className="space-y-1.5 text-[14px] leading-relaxed text-ink-2">
          <li>A guided tour of what each AI Employee does.</li>
          {form.aiChat ? (
            <li>
              Up to {form.messageLimit} questions to ask the AI team. It is an AI, it can be wrong, and it only knows what iAcquire has published.
            </li>
          ) : (
            <li>The AI chat is not open right now, so the guided tour is what you will see.</li>
          )}
          <li>The demo opens when you confirm your email address and stays open for {hours(form.windowHours)}.</li>
        </ul>
      </header>

      <DemoNotice notice={notice} />

      {form.hasSession && (
        <div className="card-surface flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4">
          <p className="text-[14px] text-ink-2">You already have a demo open in this browser.</p>
          <Link href="/demo/room" className={linkClass}>
            Continue your demo
          </Link>
        </div>
      )}

      {form.full ? (
        <p role="status" className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[14px] leading-relaxed text-warning-ink">
          {PUBLIC_COPY.daily_cap}
        </p>
      ) : (
        <div className="card-surface rounded-2xl p-4 sm:p-6">
          <h2 className="mb-4 text-[18px] font-semibold tracking-[-0.02em] text-ink">Ask for your demo</h2>
          <DemoRequestForm industries={DEMO_INDUSTRIES} notice={demoNotice(form.retentionDays)} utm={utm} initialErrors={fieldErrors} />
        </div>
      )}

      <details className="card-surface rounded-2xl">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-2xl px-4 py-3 text-[14px] font-medium text-ink [&::-webkit-details-marker]:hidden">
          <Mail className="size-4 text-primary" aria-hidden />
          Already started? Get a new link
        </summary>
        <form method="post" action="/api/public/demo/return-link" className="space-y-3 border-t border-line px-4 pb-4 pt-3">
          <Field label="The email address you used" htmlFor="return-email" hint="If your demo is still open, we email a new link to that address.">
            <Input id="return-email" name="email" type="email" inputMode="email" required maxLength={254} autoComplete="email" />
          </Field>
          <Button type="submit" variant="secondary">
            Email me a new link
          </Button>
        </form>
      </details>
    </div>
  );
}
