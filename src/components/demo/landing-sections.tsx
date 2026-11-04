import * as React from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, Clock, Mail, MailCheck, MessageSquareText, MousePointerClick, Route, Sparkles, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/primitives";
import { DEMO_CAPABILITY_AREAS, VIEWS, type ViewId } from "@/lib/demo/showroom/content";
import { Chip, SectionHead, SimTag, ViewIcon } from "@/components/demo/showroom/ui";
import type { FormView } from "@/server/demo/public";

// The pieces of the request page around the form: what a visitor gets, who they will meet, what they can explore, and the way back for someone who already started. All of it is static
// words or comes from the form's own view (the question allowance and the window), so nothing here can say something the settings in force do not.

const hours = (n: number) => `${n} hour${n === 1 ? "" : "s"}`;

/** What the demo is, in three rows. The AI chat row says what is true now: its allowance when it can answer, and that it is closed when it cannot. */
export function Benefits({ form }: { form: FormView }) {
  const rows = [
    { icon: Route, title: "Explore six capability areas", body: "A guided tour of one AI Growth Partner's coordinated work." },
    form.aiChat
      ? { icon: MessageSquareText, title: "Ask about the AI Growth Partner", body: `Up to ${form.messageLimit} questions. It is an AI, it can be wrong, and it only knows what iAcquire has published.` }
      : { icon: MessageSquareText, title: "AI chat is closed right now", body: "The AI chat is not open right now, so the guided tour is what you will see." },
    { icon: Clock, title: `Open for ${hours(form.windowHours)}`, body: `The demo opens when you confirm your email address and stays open for ${hours(form.windowHours)}.` },
  ];
  return (
    <ul className="space-y-4">
      {rows.map(({ icon: Icon, title, body }) => (
        <li key={title} className="flex gap-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/15">
            <Icon className="size-[18px]" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-semibold leading-snug text-ink">{title}</p>
            <p className="mt-0.5 text-pretty text-[14px] leading-relaxed text-ink-2">{body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

const PARTNER_WORKFLOW = [
  { title: "Checks a prospect against your approved brief", tag: "Evidence linked", tone: "info" },
  { title: "Checks for a matching CRM record", tag: "Duplicate check", tone: "ok" },
  { title: "Prepares a relevant next step", tag: "Review required", tone: "violet" },
] as const;

/** A small, invented example of one Growth Partner coordinating a task across capabilities. Labelled as a sample. */
export function HandoffPreview() {
  return (
    <figure aria-label="A sample workflow coordinated by one AI Growth Partner" className="sx-panel m-0 space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">One partner, one coordinated workflow</p>
        <SimTag>Sample preview</SimTag>
      </div>
      <ol className="relative space-y-3">
        <span aria-hidden className="absolute bottom-6 left-[19px] top-6 w-px border-l border-dashed border-line-strong" />
        {PARTNER_WORKFLOW.map((h, index) => (
          <li key={h.title} className="relative flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-full border border-primary/15 bg-surface text-primary-ink">
              <span className="text-[12px] font-semibold">{index + 1}</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-muted">AI Growth Partner</p>
              <p className="text-[14px] font-medium leading-snug text-ink">{h.title}</p>
            </div>
            <Chip tone={h.tone} className="hidden shrink-0 sm:inline-flex">
              {h.tag}
            </Chip>
          </li>
        ))}
      </ol>
      <figcaption className="text-[12.5px] leading-relaxed text-muted">Illustrative only. No prospect is researched or saved here; a customer-facing action follows the required approval.</figcaption>
    </figure>
  );
}

/** Where the visitor is in getting a demo: details, then the emailed link, then the open demo. Decorative progress, not a form. */
export function FormStepper() {
  const steps = [
    { icon: UserRound, label: "Details", current: true },
    { icon: MailCheck, label: "Confirm email", current: false },
    { icon: MousePointerClick, label: "Demo opens", current: false },
  ];
  return (
    <ol aria-label="How you get your demo" className="flex items-center gap-1.5">
      {steps.map((s, i) => (
        <React.Fragment key={s.label}>
          <li aria-current={s.current ? "step" : undefined} className="flex min-w-0 items-center gap-2">
            <span className={`grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${s.current ? "brand-gradient text-white shadow-glow" : "border border-line-strong bg-surface-2 text-muted"}`}>
              {s.current ? <s.icon className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={`truncate text-[12.5px] font-medium ${s.current ? "text-ink" : "sr-only text-muted sm:not-sr-only"}`}>{s.label}</span>
          </li>
          {i < steps.length - 1 && <span aria-hidden className="h-px min-w-3 flex-1 bg-line-strong" />}
        </React.Fragment>
      ))}
    </ol>
  );
}

/** The six internal capability areas presented as parts of one employee. */
export function TeamSection() {
  return (
    <section aria-label="AI Growth Partner capability areas" className="space-y-6">
      <SectionHead eyebrow="One employee · six capabilities" title="Meet your AI Growth Partner" lead="One identity and shared business context, with six coordinated capability areas. The examples are illustrative and use sample data." />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {DEMO_CAPABILITY_AREAS.map((area) => {
          return (
            <li key={area.key} className="sx-panel flex items-start gap-4 p-5 transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lg">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink"><Sparkles className="size-5" aria-hidden /></span>
              <div className="min-w-0">
                <p className="text-[16px] font-semibold leading-snug tracking-[-0.01em] text-ink">{area.title}</p>
                <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{area.description}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const EXPLORE: ViewId[] = ["crm", "inbox", "automation", "reports", "pricing"];

/** What else is inside the demo, from the same list the demo's own navigation uses. */
export function ExploreSection() {
  const items = EXPLORE.map((id) => VIEWS.find((v) => v.id === id)!);
  return (
    <section aria-label="What you can explore" className="space-y-6">
      <SectionHead eyebrow="Across the system" title="What you can explore" lead="Open any area in any order. It is all sample data, so nothing you do changes anything real." />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {items.map((v) => (
          <li key={v.id} className="sx-panel space-y-2 p-4">
            <span className="grid size-9 place-items-center rounded-xl bg-primary-soft text-primary-ink">
              <ViewIcon name={v.icon} className="size-[18px]" />
            </span>
            <p className="text-[15px] font-semibold leading-snug text-ink">{v.label}</p>
            <p className="text-[13px] leading-snug text-muted">{v.hint}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A way to the public "Why iAcquireOS?" page for someone who wants the short version before asking for a demo. */
export function WhyBand() {
  return (
    <section aria-labelledby="why-band" className="sx-panel flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
      <div className="space-y-1">
        <h2 id="why-band" className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
          Want the short version first?
        </h2>
        <p className="max-w-xl text-[14px] leading-relaxed text-ink-2">See what iAcquireOS is, how it compares with doing it yourself, and what it costs. No details needed.</p>
      </div>
      <Link href="/demo/why" className="sx-btn-quiet inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-5 text-[14px] font-semibold">
        Read why iAcquireOS
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    </section>
  );
}

/** "Already started? Get a new link": the way back for someone whose link was lost. A plain form, the same as before. */
export function ReturnLink() {
  return (
    <details className="sx-panel group">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2.5 rounded-2xl px-4 py-3 text-[14px] font-medium text-ink [&::-webkit-details-marker]:hidden">
        <span className="grid size-8 place-items-center rounded-lg bg-primary-soft text-primary-ink">
          <Mail className="size-4" aria-hidden />
        </span>
        <span className="flex-1">Already started? Get a new link</span>
        <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
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
  );
}
