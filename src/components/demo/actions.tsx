import * as React from "react";
import { CalendarCheck, CircleCheck, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DemoNotice, linkClass } from "@/components/demo/shell";
import { CTA_COPY, ROOM_COPY, type Notice } from "@/lib/demo/outcomes";
import { isConsultationUrl } from "@/lib/demo/settings";

// The two things a prospect can ask for: to talk to a person, or to say they are ready to buy. Both are plain forms that post to the demo API (they work without scripts) and come
// back to this page. Each says what pressing it does BEFORE it is pressed, and what is recorded AFTER: pressing Buy tells the team and nothing else, because online checkout is not
// open, and the page never implies otherwise.

export function DemoActions({
  consultationRequested,
  purchaseStarted,
  consultationUrl,
  notice,
}: {
  consultationRequested: boolean;
  purchaseStarted: boolean;
  consultationUrl: string | null;
  notice: Notice | null;
}) {
  const link = consultationUrl && isConsultationUrl(consultationUrl) ? consultationUrl : null;
  // The confirmation after pressing a button says exactly what the recorded status below already says: showing both read as the sentence twice. Refusals still show.
  const shown = notice && notice.tone === "ok" && (notice.text === CTA_COPY.consultation || notice.text === CTA_COPY.buy) ? null : notice;
  return (
    <section id="actions" aria-labelledby="actions-heading" className="card-surface scroll-mt-4 space-y-4 rounded-2xl p-4 sm:p-5">
      <h2 id="actions-heading" className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
        {ROOM_COPY.consultationHeading}
      </h2>
      <DemoNotice notice={shown} />

      {consultationRequested ? (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-success/25 bg-success-soft p-3 text-success-ink">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-2 text-[14px] leading-relaxed">
            <p>{CTA_COPY.consultation}</p>
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className={linkClass}>
                <ExternalLink className="size-4" aria-hidden />
                {ROOM_COPY.consultationLink}
              </a>
            ) : (
              <p>{ROOM_COPY.consultationNoLink}</p>
            )}
          </div>
        </div>
      ) : (
        <form method="post" action="/api/public/demo/cta" className="space-y-2">
          <input type="hidden" name="kind" value="consultation" />
          <Button type="submit" size="lg" className="w-full sm:w-auto">
            <CalendarCheck className="size-4" aria-hidden />
            {ROOM_COPY.consultationButton}
          </Button>
          <p className="text-[13px] leading-relaxed text-muted">{ROOM_COPY.consultationNote}</p>
        </form>
      )}

      {purchaseStarted ? (
        <p role="status" className="flex items-start gap-3 rounded-xl border border-success/25 bg-success-soft p-3 text-[14px] leading-relaxed text-success-ink">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{CTA_COPY.buy}</span>
        </p>
      ) : (
        <form method="post" action="/api/public/demo/cta" className="space-y-2 border-t border-line pt-4">
          <input type="hidden" name="kind" value="buy" />
          <Button type="submit" variant="secondary" size="lg" className="w-full sm:w-auto">
            {ROOM_COPY.buyButton}
          </Button>
          <p className="text-[13px] leading-relaxed text-muted">{ROOM_COPY.buyNote}</p>
        </form>
      )}
    </section>
  );
}
