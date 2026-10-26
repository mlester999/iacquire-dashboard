import type { Metadata } from "next";
import { CircleAlert, CircleCheck, Hourglass, Link2Off, Mail, MailX, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { Monogram } from "@/app/book/_components/shell";
import { loadUnsubscribePage, type UnsubscribePageView } from "@/server/messaging/unsubscribe";
import type { Channel } from "@/lib/messaging";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false, follow: false }, referrer: "no-referrer" };

const WHAT: Record<Channel, string> = { email: "marketing emails", sms: "marketing text messages", whatsapp: "marketing WhatsApp messages" };

const linkClass =
  "inline-flex h-11 min-w-0 select-none items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-soft transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-10";

type Business = NonNullable<UnsubscribePageView["business"]>;

function Shell({ business, children }: { business: Business | null; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#unsubscribe-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2 focus:text-[14px] focus:text-ink focus:shadow-float">
        Skip to content
      </a>
      {business && (
        <header className="mx-auto w-full max-w-xl px-4 pt-6 sm:px-6 sm:pt-12">
          <div className="flex min-w-0 items-center gap-3">
            <Monogram name={business.name} color={business.brandColor} />
            <p className="min-w-0 truncate text-[16px] font-semibold tracking-[-0.02em] text-ink">{business.name}</p>
          </div>
        </header>
      )}
      <main id="unsubscribe-main" tabIndex={-1} className="mx-auto w-full max-w-xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8">
        {children}
      </main>
      <footer className="mx-auto w-full max-w-xl px-4 pb-8 pt-2 text-center text-[12px] text-muted sm:px-6">Messaging by iAcquire</footer>
    </div>
  );
}

function Notice({ icon: Icon, title, children }: { icon: typeof MailX; title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-6 max-w-md text-center sm:mt-12">
      <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-primary shadow-card">
        <Icon className="size-5" aria-hidden />
      </div>
      <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.03em] text-ink">{title}</h1>
      <div className="mt-2 space-y-3 text-[14px] leading-relaxed text-muted">{children}</div>
    </div>
  );
}

function ContactLinks({ business }: { business: Business }) {
  if (!business.contactEmail && !business.contactPhone) return null;
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      {business.contactEmail && (
        <a href={`mailto:${business.contactEmail}`} className={linkClass}>
          <Mail className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{business.contactEmail}</span>
        </a>
      )}
      {business.contactPhone && (
        <a href={`tel:${business.contactPhone}`} className={linkClass}>
          <Phone className="size-4 shrink-0" aria-hidden />
          {business.contactPhone}
        </a>
      )}
    </div>
  );
}

/**
 * Where a person lands from the unsubscribe link in a marketing message. Opening it changes nothing (link scanners open links too);
 * pressing Unsubscribe posts the signed link back to /api/public/unsubscribe, which records the choice and returns here. Works without
 * JavaScript. Only marketing messages on the link's channel stop: messages the person asked for (an appointment confirmation) still go.
 */
export default async function UnsubscribePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ r?: string | string[] }> }) {
  const { token } = await params;
  const r = (await searchParams).r;
  const result = typeof r === "string" ? r : null;
  const view = await loadUnsubscribePage(token);

  if (view.state === "rate_limited") {
    return (
      <Shell business={null}>
        <Notice icon={Hourglass} title="One moment, please">
          <p>This link has been opened many times in a short while. Wait a few minutes, then open it again.</p>
        </Notice>
      </Shell>
    );
  }
  if (view.state === "invalid") {
    return (
      <Shell business={null}>
        <Notice icon={Link2Off} title="This unsubscribe link isn't valid">
          <p>It may have been cut short when it was copied. Open the unsubscribe link straight from the message, or use the one in a more recent message.</p>
        </Notice>
      </Shell>
    );
  }

  const business = view.business;
  const what = view.channel ? WHAT[view.channel] : "marketing messages";
  if (view.state === "expired") {
    return (
      <Shell business={business}>
        <Notice icon={Link2Off} title="This unsubscribe link has expired">
          <p>Use the unsubscribe link in a more recent message{business ? `, or ask ${business.name} directly to stop sending you ${what}` : ""}.</p>
        </Notice>
        {business && <ContactLinks business={business} />}
      </Shell>
    );
  }
  if (view.state === "not_found" || !business) {
    return (
      <Shell business={business}>
        <Notice icon={Link2Off} title="There's nothing to unsubscribe from here">
          <p>{business ? `${business.name} no longer has the details this link was for` : "The details this link was for are no longer on file"}, so no more {what} will be sent through it.</p>
        </Notice>
        {business && <ContactLinks business={business} />}
      </Shell>
    );
  }

  const where = view.maskedAddress ? (
    <>
      {" "}at <span className="font-medium text-ink">{view.maskedAddress}</span>
    </>
  ) : null;

  if (view.state === "unsubscribed") {
    return (
      <Shell business={business}>
        <Card className="mt-2 p-5 sm:p-7">
          <div role="status" className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-success-soft text-success-ink">
              <CircleCheck className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="text-[20px] font-semibold tracking-[-0.03em] text-ink sm:text-[22px]">{result === "unsubscribed" ? "You're unsubscribed" : "You're already unsubscribed"}</h1>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
                {business.name} won&apos;t send you {what}
                {where} any more. Messages that were already on their way may still arrive.
              </p>
            </div>
          </div>
          <p className="mt-5 border-t border-line pt-4 text-[14px] leading-relaxed text-muted">
            You&apos;ll still get messages about things you&apos;ve asked for, such as appointment confirmations. If you change your mind, ask {business.name} to add you back.
          </p>
        </Card>
        <ContactLinks business={business} />
      </Shell>
    );
  }

  return (
    <Shell business={business}>
      <Card className="mt-2 p-5 sm:p-7">
        <h1 className="text-[20px] font-semibold tracking-[-0.03em] text-ink sm:text-[22px]">Unsubscribe from {what}?</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          {business.name} will stop sending you {what}
          {where}. You&apos;ll still get messages about things you&apos;ve asked for, such as appointment confirmations.
        </p>
        {(result === "error" || result === "rate_limited") && (
          <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-[14px] text-danger-ink">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{result === "rate_limited" ? "Too many attempts in a short while. Wait a few minutes, then try again." : "That didn't go through. Please try again."}</span>
          </p>
        )}
        <form method="post" action={`/api/public/unsubscribe?t=${encodeURIComponent(token)}`} className="mt-5 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <input type="hidden" name="via" value="page" />
          <p className="text-[14px] text-muted">Nothing changes until you press Unsubscribe.</p>
          <Button type="submit" className="w-full sm:w-auto">
            <MailX className="size-4" aria-hidden />
            Unsubscribe
          </Button>
        </form>
      </Card>
    </Shell>
  );
}
