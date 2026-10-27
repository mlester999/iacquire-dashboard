"use client";

import * as React from "react";
import { ArrowRight, CalendarCheck, CircleCheck, ExternalLink, Lock, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { CTA_COPY, ROOM_COPY } from "@/lib/demo/outcomes";
import { isConsultationUrl } from "@/lib/demo/settings";
import { useShowroom } from "@/components/demo/showroom/context";
import { DemoNotice } from "@/components/demo/shell";
import { Chip, PlanTag } from "@/components/demo/showroom/ui";
import type { ViewId } from "@/lib/demo/showroom/content";

// Every way a visitor can say "I want this", and every honest thing the page says about it. Two things can be recorded, once each: "I'd like to talk to a person" and "I'm ready to get
// started". Pressing either tells the team and nothing else: no appointment is booked, no checkout opens, nothing is charged, and no sentence on the page implies otherwise. Each is a
// real form that posts to the demo's own endpoint, so it works without scripts; with scripts it records in place and the page updates from the record.

const useLink = () => {
  const { consultationUrl } = useShowroom();
  return consultationUrl && isConsultationUrl(consultationUrl) ? consultationUrl : null;
};

function RequestForm({ kind, children, className }: { kind: "consultation" | "buy"; children: React.ReactNode; className?: string }) {
  const { request, requestError } = useShowroom();
  const id = React.useId();
  return (
    <form
      method="post"
      action="/api/public/demo/cta"
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        void request(kind, id);
      }}
    >
      <input type="hidden" name="kind" value={kind} />
      {children}
      {/* A request that did not go through says so right under the button that was pressed. */}
      {requestError?.source === id && <DemoNotice notice={{ tone: "error", text: requestError.text }} />}
    </form>
  );
}

const sizeClass = { md: "h-11 px-5 text-[14px]", lg: "h-12 px-6 text-[15px]" } as const;

/** "Book a free consultation": a button until it is pressed, then the confirmation and, only when a real https scheduling page is set, the way to it. */
export function ConsultCta({ size = "md", className, quiet = false }: { size?: keyof typeof sizeClass; className?: string; quiet?: boolean }) {
  const { consultationRequested, requesting } = useShowroom();
  const link = useLink();
  if (consultationRequested) {
    return (
      <div role="status" className={cn("flex flex-wrap items-center gap-3", className)}>
        <span className="inline-flex items-center gap-2 text-[14px] font-medium text-success-ink">
          <CircleCheck className="size-4" aria-hidden />
          Request received
        </span>
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" className={cn("sx-btn-quiet inline-flex items-center justify-center gap-2 rounded-xl font-medium", sizeClass[size])}>
            <ExternalLink className="size-4" aria-hidden />
            {ROOM_COPY.consultationLink}
          </a>
        ) : null}
      </div>
    );
  }
  return (
    <RequestForm kind="consultation" className={className}>
      <button type="submit" disabled={requesting !== null} className={cn(quiet ? "sx-btn-quiet" : "sx-btn-primary", "inline-flex items-center justify-center gap-2 rounded-xl font-semibold disabled:opacity-60", sizeClass[size])}>
        <CalendarCheck className="size-4" aria-hidden />
        {requesting === "consultation" ? "Sending" : ROOM_COPY.consultationButton}
      </button>
    </RequestForm>
  );
}

/** "I'm ready to get started": says before and after that it only tells the team. */
export function StartCta({ size = "md", className }: { size?: keyof typeof sizeClass; className?: string }) {
  const { purchaseStarted, requesting } = useShowroom();
  if (purchaseStarted) {
    return (
      <p role="status" className={cn("inline-flex items-center gap-2 text-[14px] font-medium text-success-ink", className)}>
        <CircleCheck className="size-4" aria-hidden />
        The team knows you are ready
      </p>
    );
  }
  return (
    <RequestForm kind="buy" className={className}>
      <button type="submit" disabled={requesting !== null} className={cn("sx-btn-quiet inline-flex items-center justify-center gap-2 rounded-xl font-semibold disabled:opacity-60", sizeClass[size])}>
        <Rocket className="size-4" aria-hidden />
        {requesting === "buy" ? "Sending" : ROOM_COPY.buyButton}
      </button>
    </RequestForm>
  );
}

/** What the page says after a request, from the record, with the honest "nothing is booked or charged" wording. */
export function RequestStatus({ className }: { className?: string }) {
  const { consultationRequested, purchaseStarted } = useShowroom();
  const link = useLink();
  return (
    <div className={cn("space-y-2", className)} aria-live="polite">
      {consultationRequested && (
        <p className="text-[14px] leading-relaxed text-ink-2">
          {CTA_COPY.consultation} {link ? "You can also pick a time yourself on the scheduling page. Nothing is booked until you do." : ROOM_COPY.consultationNoLink}
        </p>
      )}
      {purchaseStarted && <p className="text-[14px] leading-relaxed text-ink-2">{CTA_COPY.buy}</p>}
    </div>
  );
}

/**
 * A call to action that belongs to the thing the visitor is looking at: what it is, whether it comes with the core implementation or the optional plan, and one next step. Quiet on
 * purpose (one per view or section): it is an offer, not a banner.
 */
export function ContextCta({
  title,
  body,
  plan,
  locked = false,
  consultLabel,
  secondary,
}: {
  title: string;
  body: string;
  plan: "core" | "maintenance";
  locked?: boolean;
  consultLabel?: string;
  secondary?: { view: ViewId; label: string };
}) {
  const { go, consultationRequested } = useShowroom();
  return (
    <aside aria-label={title} className={cn("sx-panel flex flex-col gap-4 p-5 @xl:flex-row @xl:items-center @xl:justify-between", locked && "sx-locked")}>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <PlanTag plan={plan} />
          {locked && (
            <Chip tone="violet">
              <Lock className="size-3" aria-hidden />
              Locked in this demo
            </Chip>
          )}
        </div>
        <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>
        <p className="text-[14px] leading-relaxed text-ink-2">{body}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {consultLabel && !consultationRequested ? (
          <RequestForm kind="consultation">
            <ConsultSubmit label={consultLabel} />
          </RequestForm>
        ) : consultationRequested ? (
          <span className="inline-flex items-center gap-2 text-[14px] font-medium text-success-ink" role="status">
            <CircleCheck className="size-4" aria-hidden />
            Request received
          </span>
        ) : null}
        {secondary && (
          <button type="button" onClick={() => go(secondary.view)} className="inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-[14px] font-medium text-primary-ink hover:text-ink">
            {secondary.label}
            <ArrowRight className="size-4" aria-hidden />
          </button>
        )}
      </div>
    </aside>
  );
}

function ConsultSubmit({ label }: { label: string }) {
  const { requesting } = useShowroom();
  return (
    <button type="submit" disabled={requesting !== null} className="sx-btn-primary inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[14px] font-semibold disabled:opacity-60">
      <CalendarCheck className="size-4" aria-hidden />
      {requesting === "consultation" ? "Sending" : label}
    </button>
  );
}

/** The conversion panel: the two requests together, with what pressing each does. It is the target of the forms without scripts (#actions). */
export function ConversionPanel({ title = "Ready to talk about your business?", lead }: { title?: string; lead?: string }) {
  const { consultationRequested, purchaseStarted, ctaNotice: notice } = useShowroom();
  // The confirmation after a button says what the status line below already says: show refusals, not the repeat.
  const shown = notice && notice.tone === "ok" && (notice.text === CTA_COPY.consultation || notice.text === CTA_COPY.buy) ? null : notice;
  return (
    <section id="actions" aria-labelledby="actions-heading" className="sx-panel sx-panel-hot scroll-mt-24 space-y-5 p-6 @xl:p-8">
      <div className="max-w-2xl space-y-2">
        <h2 id="actions-heading" className="sx-display text-[28px] leading-tight text-ink @xl:text-[34px]">
          {title}
        </h2>
        <p className="text-[15px] leading-relaxed text-ink-2">{lead ?? "A free consultation is a conversation about your business. It does not book anything or charge anything."}</p>
      </div>
      <DemoNotice notice={shown} />
      <div className="grid gap-4 @2xl:grid-cols-2">
        <div className="sx-panel-flat space-y-3 p-4">
          <p className="text-[15px] font-semibold text-ink">Talk to a person</p>
          <ConsultCta size="lg" />
          {!consultationRequested && <p className="text-[13px] leading-relaxed text-muted">{ROOM_COPY.consultationNote}</p>}
        </div>
        <div className="sx-panel-flat space-y-3 p-4">
          <p className="text-[15px] font-semibold text-ink">Start your implementation</p>
          <StartCta size="lg" />
          {!purchaseStarted && <p className="text-[13px] leading-relaxed text-muted">{ROOM_COPY.buyNote}</p>}
        </div>
      </div>
      <RequestStatus />
    </section>
  );
}
