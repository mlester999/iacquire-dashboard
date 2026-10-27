"use client";

import * as React from "react";
import { ArrowRight, CalendarCheck, CircleCheck, ExternalLink, Lock, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { CTA_COPY, ROOM_COPY } from "@/lib/demo/outcomes";
import { isConsultationUrl } from "@/lib/demo/settings";
import { BUY_CONFIRM, CONSULT_CONFIRM, type ConfirmKind } from "@/lib/demo/showroom/confirm-copy";
import { useShowroom } from "@/components/demo/showroom/context";
import { DemoNotice } from "@/components/demo/shell";
import { Chip, PlanTag, usd } from "@/components/demo/showroom/ui";
import type { ViewId } from "@/lib/demo/showroom/content";

// Every way a visitor can say "I want this", and every honest thing the page says about it. Two things can be recorded, once each: "I'd like to talk to a person" and "I'm ready to get
// started". Both ask first: a button opens a confirmation (a dialog; without scripts, the same confirmation on the page itself, with a real form), and only the confirming press records
// anything. Recording tells the team and nothing else: no appointment is booked, no checkout opens, nothing is charged, and no sentence on the page implies otherwise. A success is shown
// only after the server has confirmed it.

const useLink = () => {
  const { consultationUrl } = useShowroom();
  return consultationUrl && isConsultationUrl(consultationUrl) ? consultationUrl : null;
};

const sizeClass = { md: "h-11 px-5 text-[14px]", lg: "h-12 px-6 text-[15px]" } as const;

/**
 * The button that starts a request. It is a link to the same page with the confirmation open, so it works without scripts; with scripts it opens the dialog instead and the address does
 * not change.
 */
function RequestTrigger({ kind, children, className, quiet = false, icon }: { kind: ConfirmKind; children: React.ReactNode; className?: string; quiet?: boolean; icon: React.ReactNode }) {
  const { openConfirm, view } = useShowroom();
  const href = `/demo/room?view=${view}&confirm=${kind}#confirm`;
  return (
    <a
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        openConfirm(kind);
      }}
      className={cn(quiet ? "sx-btn-quiet" : "sx-btn-primary", "inline-flex items-center justify-center gap-2 rounded-xl font-semibold", className)}
    >
      {icon}
      {children}
    </a>
  );
}

/** "Book a free consultation": a button until it is pressed and confirmed, then the confirmation and, only when a real https scheduling page is set, the way to it. */
export function ConsultCta({ size = "md", className, quiet = false, label }: { size?: keyof typeof sizeClass; className?: string; quiet?: boolean; label?: string }) {
  const { consultationRequested } = useShowroom();
  const link = useLink();
  if (consultationRequested) {
    return (
      <div role="status" className={cn("flex flex-wrap items-center gap-3", className)}>
        <span className="inline-flex items-center gap-2 text-[14px] font-medium text-success-ink">
          <CircleCheck className="size-4" aria-hidden />
          Request received
        </span>
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" className={cn("sx-btn-primary inline-flex items-center justify-center gap-2 rounded-xl font-semibold", sizeClass[size])}>
            <ExternalLink className="size-4" aria-hidden />
            {CONSULT_CONFIRM.schedule}
          </a>
        ) : null}
      </div>
    );
  }
  return (
    <RequestTrigger kind="consultation" quiet={quiet} className={cn(sizeClass[size], className)} icon={<CalendarCheck className="size-4" aria-hidden />}>
      {label ?? ROOM_COPY.consultationButton}
    </RequestTrigger>
  );
}

/** "I'm ready to get started": says before and after that it only tells the team. */
export function StartCta({ size = "md", className }: { size?: keyof typeof sizeClass; className?: string }) {
  const { purchaseStarted } = useShowroom();
  if (purchaseStarted) {
    return (
      <p role="status" className={cn("inline-flex items-center gap-2 text-[14px] font-medium text-success-ink", className)}>
        <CircleCheck className="size-4" aria-hidden />
        The team knows you are ready
      </p>
    );
  }
  return (
    <RequestTrigger kind="buy" quiet className={cn(sizeClass[size], className)} icon={<Rocket className="size-4" aria-hidden />}>
      {ROOM_COPY.buyButton}
    </RequestTrigger>
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
  const { go } = useShowroom();
  return (
    <aside aria-label={title} className={cn("sx-panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between", locked && "sx-locked")}>
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
        {consultLabel && <ConsultCta label={consultLabel} />}
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

/** The conversion panel: the two requests together, with what pressing each does. Its address (#actions) is where the old forms without scripts came back to. */
export function ConversionPanel({ title = "Ready to talk about your business?", lead }: { title?: string; lead?: string }) {
  const { consultationRequested, purchaseStarted, ctaNotice: notice } = useShowroom();
  // The confirmation after a button says what the status line below already says: show refusals, not the repeat.
  const shown = notice && notice.tone === "ok" && (notice.text === CTA_COPY.consultation || notice.text === CTA_COPY.buy) ? null : notice;
  return (
    <section id="actions" aria-labelledby="actions-heading" className="sx-panel sx-panel-hot scroll-mt-24 space-y-5 p-6 sm:p-8">
      <div className="max-w-2xl space-y-2">
        <h2 id="actions-heading" className="sx-display text-[24px] leading-tight text-ink sm:text-[28px]">
          {title}
        </h2>
        <p className="text-[15px] leading-relaxed text-ink-2">{lead ?? "A free consultation is a conversation about your business. It does not book anything or charge anything."}</p>
      </div>
      <DemoNotice notice={shown} />
      <div className="grid gap-4 md:grid-cols-2">
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

// ---------------------------------------------------------------------------
// The confirmation
// ---------------------------------------------------------------------------

function Steps({ heading, items }: { heading: string; items: readonly string[] }) {
  return (
    <section aria-label={heading} className="space-y-2">
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">{heading}</h3>
      <ol className="space-y-2">
        {items.map((t, i) => (
          <li key={t} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary-ink">{i + 1}</span>
            {t}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** What the visitor is asked to confirm. Used inside the dialog and, without scripts, on the page itself. */
function ConfirmBody({ kind }: { kind: ConfirmKind }) {
  const { business, setupFeeUsd, monthlyPlanUsd } = useShowroom();
  const link = useLink();
  if (kind === "consultation") {
    return (
      <div className="space-y-5">
        <section aria-label={CONSULT_CONFIRM.purposeHeading} className="space-y-2">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">{CONSULT_CONFIRM.purposeHeading}</h3>
          <ul className="space-y-2">
            {CONSULT_CONFIRM.purpose.map((t) => (
              <li key={t} className="flex gap-2.5 text-[14px] leading-relaxed text-ink-2">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </section>
        <p className="sx-panel-flat px-4 py-3 text-[14px] leading-relaxed text-ink">
          {business ? <strong className="font-semibold">{business}: </strong> : null}
          {CONSULT_CONFIRM.free}
        </p>
        <Steps heading={CONSULT_CONFIRM.nextHeading} items={CONSULT_CONFIRM.next(link !== null)} />
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <section aria-label={BUY_CONFIRM.summaryHeading} className="space-y-3">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">{BUY_CONFIRM.summaryHeading}</h3>
        <dl className="grid gap-3">
          <div className="sx-panel-flat grid grid-cols-[1fr_auto] gap-x-4 px-4 py-3">
            <dt className="text-[14px] font-semibold text-ink">{BUY_CONFIRM.implementationLabel}</dt>
            <dd className="row-span-2 text-right">
              <span className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Starting at</span>
              <span className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-ink">{usd(setupFeeUsd)}</span>
            </dd>
            <dd className="mt-0.5 text-[13px] leading-snug text-muted">{BUY_CONFIRM.implementationNote}</dd>
          </div>
          <div className="sx-panel-flat grid grid-cols-[1fr_auto] gap-x-4 px-4 py-3">
            <dt className="text-[14px] font-semibold text-ink">{BUY_CONFIRM.maintenanceLabel}</dt>
            <dd className="row-span-2 text-right">
              <span className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Optional</span>
              <span className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-ink">{usd(monthlyPlanUsd)}</span>
              <span className="text-[12px] text-muted">/month</span>
            </dd>
            <dd className="mt-0.5 text-[13px] leading-snug text-muted">{BUY_CONFIRM.maintenanceNote}</dd>
          </div>
          <div className="sx-panel-flat px-4 py-3">
            <dt className="text-[14px] font-semibold text-ink">{BUY_CONFIRM.usageLabel}</dt>
            <dd className="mt-0.5 text-[13px] leading-snug text-muted">{BUY_CONFIRM.usageNote}</dd>
          </div>
        </dl>
        <p className="text-[13px] leading-relaxed text-ink-2">{BUY_CONFIRM.oneTimeVsMonthly}</p>
      </section>
      <Steps heading={BUY_CONFIRM.nextHeading} items={BUY_CONFIRM.next} />
    </div>
  );
}

/** What the visitor sees once the server has confirmed the request. */
function Confirmed({ kind }: { kind: ConfirmKind }) {
  const link = useLink();
  return (
    <div role="status" className="space-y-4">
      <p className="flex items-start gap-2.5 text-[15px] font-semibold text-success-ink">
        <CircleCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
        {kind === "consultation" ? CONSULT_CONFIRM.successTitle : BUY_CONFIRM.successTitle}
      </p>
      <p className="text-[14px] leading-relaxed text-ink-2">{kind === "consultation" ? CONSULT_CONFIRM.success(link !== null) : BUY_CONFIRM.success}</p>
      {kind === "consultation" && link && (
        <a href={link} target="_blank" rel="noopener noreferrer" className="sx-btn-primary inline-flex h-12 items-center justify-center gap-2 rounded-xl px-6 text-[15px] font-semibold">
          <ExternalLink className="size-4" aria-hidden />
          {CONSULT_CONFIRM.schedule}
        </a>
      )}
    </div>
  );
}

const DIALOG_SOURCE = "dialog";

/** The one confirmation dialog for both requests. It opens from any button that asks for one, never records on its own, stays open if the request fails, and says it worked only when the server did. */
export function ConfirmHost() {
  const { confirming, closeConfirm, request, requesting, requestError, business } = useShowroom();
  const [done, setDone] = React.useState<ConfirmKind | null>(null);
  const kind = confirming;
  const copy = kind === "buy" ? BUY_CONFIRM : CONSULT_CONFIRM;
  const finished = kind !== null && done === kind;
  const busy = requesting !== null;

  const onOpenChange = (open: boolean) => {
    // A request in flight cannot be dismissed into an unknown state: the dialog waits for the server's answer.
    if (!open && !busy) {
      closeConfirm();
      setDone(null);
    }
  };
  const confirm = async () => {
    if (!kind || busy) return;
    if (await request(kind, DIALOG_SOURCE)) setDone(kind);
  };

  return (
    <Dialog
      open={kind !== null}
      onOpenChange={onOpenChange}
      size="md"
      title={kind === "buy" ? BUY_CONFIRM.title : CONSULT_CONFIRM.title}
      description={kind === "buy" ? BUY_CONFIRM.description : CONSULT_CONFIRM.description(business)}
      icon={kind === "buy" ? <Rocket className="size-4" aria-hidden /> : <CalendarCheck className="size-4" aria-hidden />}
      ariaLabel="Confirm your request"
      footer={
        finished ? (
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {copy.close}
          </Button>
        ) : (
          <>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {copy.cancel}
            </Button>
            <Button type="button" variant="brand" onClick={confirm} loading={busy}>
              {busy ? copy.sending : copy.confirm}
            </Button>
          </>
        )
      }
    >
      {kind && (
        <div className="space-y-4">
          {requestError?.source === DIALOG_SOURCE && !finished && <DemoNotice notice={{ tone: "error", text: requestError.text }} />}
          {finished ? <Confirmed kind={kind} /> : <ConfirmBody kind={kind} />}
        </div>
      )}
    </Dialog>
  );
}

/**
 * The same confirmation drawn on the page, for a visitor whose scripts have not run (or never will): a real form posts to the demo's own endpoint, and only that press records anything.
 * It is shown only until the page is live; after that the dialog takes over.
 */
export function ConfirmStatic({ kind }: { kind: ConfirmKind }) {
  const copy = kind === "buy" ? BUY_CONFIRM : CONSULT_CONFIRM;
  const { business, view } = useShowroom();
  return (
    <section id="confirm" aria-labelledby="confirm-heading" className="sx-panel sx-panel-hot mb-6 space-y-5 p-6">
      <div className="space-y-1">
        <h2 id="confirm-heading" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">
          {kind === "buy" ? BUY_CONFIRM.title : CONSULT_CONFIRM.title}
        </h2>
        <p className="text-[14px] leading-relaxed text-ink-2">{kind === "buy" ? BUY_CONFIRM.description : CONSULT_CONFIRM.description(business)}</p>
      </div>
      <ConfirmBody kind={kind} />
      <form method="post" action="/api/public/demo/cta" className="flex flex-wrap gap-2">
        <input type="hidden" name="kind" value={kind} />
        <Button type="submit" variant="brand">
          {copy.confirm}
        </Button>
        <a href={`/demo/room?view=${view}`} className="sx-btn-quiet inline-flex h-10 items-center rounded-xl px-4 text-[14px] font-medium">
          {copy.cancel}
        </a>
      </form>
    </section>
  );
}

/**
 * "Book a free consultation" in the navigation rail. It is the same request as everywhere else (it asks first, then records once); in the folded rail it is one icon, with the words kept
 * for assistive technology and fading in as the rail opens.
 */
export function ConsultRail() {
  const { consultationRequested } = useShowroom();
  const link = useLink();
  if (consultationRequested) {
    return (
      <div className="space-y-1.5">
        <p role="status" className="flex h-11 items-center overflow-hidden rounded-xl text-success-ink">
          <span className="grid size-11 shrink-0 place-items-center">
            <CircleCheck className="size-[18px]" aria-hidden />
          </span>
          <span className="sx-rail-label whitespace-nowrap pr-3 text-[14px] font-medium">Request received</span>
        </p>
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer" className="sx-btn-primary flex h-11 w-full items-center overflow-hidden rounded-xl font-semibold">
            <span className="grid size-11 shrink-0 place-items-center">
              <ExternalLink className="size-[18px]" aria-hidden />
            </span>
            <span className="sx-rail-label whitespace-nowrap pr-3 text-[14px]">{CONSULT_CONFIRM.schedule}</span>
          </a>
        )}
      </div>
    );
  }
  return (
    <RequestTrigger kind="consultation" className="h-11 w-full justify-start gap-0 overflow-hidden" icon={<span className="grid size-11 shrink-0 place-items-center"><CalendarCheck className="size-[18px]" aria-hidden /></span>}>
      <span className="sx-rail-label whitespace-nowrap pr-3 text-[14px]">{ROOM_COPY.consultationButton}</span>
    </RequestTrigger>
  );
}
